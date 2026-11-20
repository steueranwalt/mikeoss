// Gate B4 audit finding L5c: migrations 0176 and 0177 lock
// require_write_approval / apply_mode with a database CHECK constraint, but
// nothing had ever replayed the real migration files against a real
// PostgreSQL server to prove the constraint actually rejects the forbidden
// value — application-level unit tests only ever exercised the mocked
// Supabase client, never the database itself.
//
// Same dual-mode pattern as orgLifecycle.postgres.test.ts: a disposable
// docker/postgres container (MIKE_TEST_POSTGRES_CONTAINER) in CI, or an
// optional local PGlite module (MIKE_TEST_PGLITE_MODULE) for a developer —
// never the application's own database. The schema below is a minimal,
// self-contained stand-in for the real pre-0176/pre-0177 tables (just the
// columns those two migrations touch), but the migration files themselves
// are read from disk and applied verbatim: what is being checked is their
// real SQL, not a paraphrase of it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const pgliteModule = process.env.MIKE_TEST_PGLITE_MODULE;
const database = `mike_test_gate_b4_${process.pid}_${Date.now()}`;

let embedded:
    | {
          exec: (s: string) => Promise<unknown>;
          query: (s: string) => Promise<{ rows: Record<string, unknown>[] }>;
          close: () => Promise<void>;
      }
    | undefined;

const dockerSql = (s: string) =>
    execFileSync(
        "docker",
        ["exec", "-i", container!, "psql", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", "-XqAt"],
        { input: s, encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

/** Runs DDL/DML; throws (sync for docker, rejected promise for PGlite) on error. */
const execute = async (s: string): Promise<void> => {
    if (embedded) await embedded.exec(s);
    else dockerSql(s);
};

/** One scalar column, one row — e.g. a single boolean/text value to assert on. */
const scalar = async (s: string): Promise<string> =>
    embedded
        ? String(Object.values((await embedded.query(s)).rows[0])[0])
        : dockerSql(s);

/** One column across every row, in insertion order, joined with a comma. */
const column = async (table: string, col: string): Promise<string> =>
    scalar(`select string_agg(${col}::text, ',' order by ctid) from public.${table};`);

const SYNTHETIC_PRE_0176_SCHEMA = `
  create extension if not exists pgcrypto;
  create table public.user_mcp_connectors (
    id uuid primary key default gen_random_uuid(),
    require_write_approval boolean not null default true
  );
  create table public.user_google_drive_tokens (
    id uuid primary key default gen_random_uuid(),
    require_write_approval boolean not null default true
  );
  create table public.user_google_workspace_tokens (
    id uuid primary key default gen_random_uuid(),
    require_write_approval boolean not null default true
  );
`;

// 0058_word_document_edits.sql's only foreign key, reduced to its id column.
const SYNTHETIC_WORD_CHAT_MESSAGES = `
  create extension if not exists pgcrypto;
  create table public.word_chat_messages (
    id uuid primary key default gen_random_uuid()
  );
`;

const MESSAGE_ID = "00000000-0000-4000-8000-000000000001";

describe.skipIf(!container && !pgliteModule)(
    "Gate B4 audit finding L5c: require_write_approval and apply_mode CHECK constraints in PostgreSQL",
    () => {
        let created = false;

        beforeAll(async () => {
            if (pgliteModule) {
                const { PGlite } = await import(pgliteModule);
                const { pgcrypto } = await import(
                    new URL("./contrib/pgcrypto.js", pgliteModule).href
                );
                embedded = new PGlite({ extensions: { pgcrypto } });
            } else {
                execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
                created = true;
            }
            // 0058_word_document_edits.sql revokes/grants against these
            // PostgREST-style roles; a disposable plain postgres:16-alpine
            // container does not have them yet.
            await execute(`do $$ begin
              if not exists(select 1 from pg_roles where rolname='web_anon') then create role web_anon; end if;
              if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
              if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
            end $$;`);
        }, 60_000);

        afterAll(async () => {
            if (embedded) await embedded.close();
            if (created) {
                execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
            }
        });

        // Every test gets a clean schema: each migration under test is
        // applied exactly once (or twice, for the idempotency test) per
        // test, the same way it would run on a real deployment.
        beforeEach(async () => {
            await execute("drop schema public cascade; create schema public;");
        });

        it.each([
            "user_mcp_connectors",
            "user_google_drive_tokens",
            "user_google_workspace_tokens",
        ])(
            "backfills an existing false row to true, then rejects false on insert and update: %s (migration 0176)",
            async (table) => {
                await execute(SYNTHETIC_PRE_0176_SCHEMA);
                // A row from before the migration, with the opt-out the
                // application no longer offers — must survive as `true`.
                await execute(
                    `insert into public.${table}(require_write_approval) values (false);`,
                );
                await execute(
                    readFileSync(
                        resolve("migrations/0176_require_write_approval_locked.sql"),
                        "utf8",
                    ),
                );

                expect(await column(table, "require_write_approval")).toBe("true");

                await expect(
                    execute(`insert into public.${table}(require_write_approval) values (false);`),
                ).rejects.toThrow();
                await expect(
                    execute(
                        `update public.${table} set require_write_approval = false where require_write_approval = true;`,
                    ),
                ).rejects.toThrow();
                await expect(
                    execute(`insert into public.${table}(require_write_approval) values (true);`),
                ).resolves.not.toThrow();
            },
            60_000,
        );

        it(
            "backfills an existing 'direct' row to 'approval', then rejects 'direct' on insert and update (migration 0177)",
            async () => {
                await execute(SYNTHETIC_WORD_CHAT_MESSAGES);
                await execute(
                    readFileSync(resolve("migrations/0058_word_document_edits.sql"), "utf8"),
                );
                await execute(`
          insert into public.word_chat_messages(id) values ('${MESSAGE_ID}');
          insert into public.word_document_edits
            (word_chat_message_id, block_index, original_text, apply_mode)
            values ('${MESSAGE_ID}', 0, 'ten days', 'direct');
        `);
                await execute(
                    readFileSync(
                        resolve("migrations/0177_word_document_edits_approval_only.sql"),
                        "utf8",
                    ),
                );

                expect(await column("word_document_edits", "apply_mode")).toBe("approval");

                await expect(
                    execute(`
            insert into public.word_document_edits
              (word_chat_message_id, block_index, original_text, apply_mode)
              values ('${MESSAGE_ID}', 1, 'five days', 'direct');
          `),
                ).rejects.toThrow();
                await expect(
                    execute(
                        "update public.word_document_edits set apply_mode = 'direct' where block_index = 0;",
                    ),
                ).rejects.toThrow();
                await expect(
                    execute(`
            insert into public.word_document_edits
              (word_chat_message_id, block_index, original_text, apply_mode)
              values ('${MESSAGE_ID}', 2, 'five days', 'approval');
          `),
                ).resolves.not.toThrow();
            },
            60_000,
        );

        it(
            "both migrations are idempotent: running each a second time does not fail",
            async () => {
                await execute(SYNTHETIC_PRE_0176_SCHEMA);
                await execute(SYNTHETIC_WORD_CHAT_MESSAGES);
                const migration0176 = readFileSync(
                    resolve("migrations/0176_require_write_approval_locked.sql"),
                    "utf8",
                );
                const migration0058 = readFileSync(
                    resolve("migrations/0058_word_document_edits.sql"),
                    "utf8",
                );
                const migration0177 = readFileSync(
                    resolve("migrations/0177_word_document_edits_approval_only.sql"),
                    "utf8",
                );
                await execute(migration0176);
                await expect(execute(migration0176)).resolves.not.toThrow();
                await execute(migration0058);
                await execute(migration0177);
                await expect(execute(migration0177)).resolves.not.toThrow();
            },
            60_000,
        );
    },
);
