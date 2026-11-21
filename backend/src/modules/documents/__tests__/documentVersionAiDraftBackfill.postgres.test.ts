import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMigrationCommand, runMigrationCommand } from "../../../scripts/migrationLedger";

const BACKFILL_MIGRATION_SQL = readFileSync(
  resolve(__dirname, "../../../../migrations/0180_document_version_ai_draft_backfill.sql"),
  "utf8",
);

// Gate B4 audit finding N13: migration 0178 added `ai_draft` with
// `default false`, so a real-Postgres replay is the only way to prove the
// 0180 backfill actually recovers the chain a pre-0178 document went
// through — a mocked `db.from()` cannot exercise the recursive CTE itself.
//
// Real PostgreSQL semantics in a disposable database, same disposable-
// container convention as scripts/test-migration-ledger-db.sh: a container
// name in MIKE_TEST_POSTGRES_CONTAINER, reached over the port Docker mapped
// for it, migrated by the actual runner (migrationLedger.ts) rather than a
// hand-picked file slice — this is the same path production deploys take,
// which is what proves the backfill behaves correctly once every earlier
// migration (including the ones that assume the runner's own
// `pgmigrations` history table already exists, e.g. 0109) has really run.
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const password = process.env.POSTGRES_PASSWORD ?? "postgres";
const database = `mike_test_ai_draft_backfill_${process.pid}_${Date.now()}`;
const log = { info: () => {}, warn: () => {}, error: () => {} };

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!container)("document_versions.ai_draft backfill in PostgreSQL (Gate B4 audit findings N13/N14)", () => {
  let created = false;
  let client: Client;

  beforeAll(async () => {
    execFileSync("docker", ["exec", container!, "createdb", "-U", "postgres", database]);
    created = true;
    const portLine = execFileSync("docker", ["port", container!, "5432/tcp"], { encoding: "utf8" }).trim();
    const port = portLine.split(":").pop();
    client = new Client({
      connectionString: `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?sslmode=disable`,
    });
    await client.connect();
    const failures = await runMigrationCommand(client, parseMigrationCommand(["up"]), "migrations", log);
    if (failures !== 0) throw new Error(`${failures} migration(s) failed while priming the backfill test database`);
    await client.query(
      `insert into public.user_profiles (id, user_id, display_name) values ($1, $1, 'Test User')`,
      [uid(1)],
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (created) execFileSync("docker", ["exec", container!, "dropdb", "-U", "postgres", "--force", database]);
  });

  async function seedChain(documentId: string, versions: Array<{ id: string; versionNumber: number; source: string }>) {
    await client.query(
      `insert into public.documents (id, user_id, status) values ($1, $2, 'ready')`,
      [documentId, uid(1)],
    );
    for (const v of versions) {
      await client.query(
        `insert into public.document_versions (id, document_id, storage_path, source, version_number, filename, file_type, ai_draft) ` +
          `values ($1, $2, $3, $4, $5, 'b.docx', 'docx', false)`,
        [v.id, documentId, `docs/${documentId}/v${v.versionNumber}.docx`, v.source, v.versionNumber],
      );
    }
  }

  async function aiDraftValues(documentId: string): Promise<boolean[]> {
    const { rows } = await client.query(
      `select ai_draft from public.document_versions where document_id = $1 order by version_number`,
      [documentId],
    );
    return rows.map((row) => row.ai_draft as boolean);
  }

  // Re-executes 0180's SQL body directly, bypassing the once-only ledger —
  // the ledger's "a file only ever runs once" guarantee is already covered
  // by migrationLedger.db.test.ts; this test needs the SQL's own
  // idempotency, which only running it again can prove.
  async function replayBackfill() {
    await client.query(BACKFILL_MIGRATION_SQL);
  }

  // 0180 already ran once in beforeAll, against the empty table its own
  // migration replay found — every test here simulates a row that existed
  // *before* that replay by seeding it and then re-running the backfill's
  // SQL directly (the same statement the ledger ran, see replayBackfill).

  // Gate B4 audit finding N19: 0178 is the column add; the backfill tests
  // below would fail if it were missing, but this names the column itself
  // so a CI replay of 0178–0180 has an explicit 0178 assertion.
  it("adds document_versions.ai_draft as a non-nullable boolean (migration 0178)", async () => {
    const { rows } = await client.query(
      `select data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'document_versions' and column_name = 'ai_draft'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("boolean");
    expect(rows[0].is_nullable).toBe("NO");
  });

  it("flags a generate_docx-sourced version left over from before the column existed", async () => {
    const documentId = uid(201);
    await seedChain(documentId, [{ id: uid(2011), versionNumber: 1, source: "generated" }]);
    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([true]);
  });

  it("flags a write_project_document-sourced version the same way", async () => {
    const documentId = uid(202);
    await seedChain(documentId, [{ id: uid(2021), versionNumber: 1, source: "tool_write" }]);
    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([true]);
  });

  // Gate B4 audit finding N14: before migration 0181 gave replicate_document
  // its own 'replicated' source, it shared 'upload' with migration 0123's
  // "publish file" RPC (a genuine human upload) and several migrations'
  // default for an unspecified source. The backfill cannot tell a pre-0181
  // replicated copy apart from a real upload by source alone, so it must
  // leave every 'upload'-sourced row alone rather than risk marking real
  // human uploads as unapproved AI drafts.
  it("leaves a genuine human upload alone, even though replicate_document used to share its source value", async () => {
    const documentId = uid(203);
    await seedChain(documentId, [{ id: uid(2031), versionNumber: 1, source: "upload" }]);
    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([false]);
  });

  it("carries the draft flag through a tracked-change follow-up, and clears it once a human re-uploads", async () => {
    const documentId = uid(204);
    await seedChain(documentId, [
      { id: uid(2041), versionNumber: 1, source: "generated" },
      { id: uid(2042), versionNumber: 2, source: "assistant_edit" },
      { id: uid(2043), versionNumber: 3, source: "user_upload" },
      { id: uid(2044), versionNumber: 4, source: "assistant_edit" },
    ]);
    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([true, true, false, false]);
  });

  it("leaves a document with no AI-sourced version alone", async () => {
    const documentId = uid(205);
    await seedChain(documentId, [
      { id: uid(2051), versionNumber: 1, source: "user_upload" },
      { id: uid(2052), versionNumber: 2, source: "assistant_edit" },
    ]);
    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([false, false]);
  });

  it("is idempotent: replaying the migration's SQL a second time changes nothing further", async () => {
    const documentId = uid(206);
    await seedChain(documentId, [
      { id: uid(2061), versionNumber: 1, source: "generated" },
      { id: uid(2062), versionNumber: 2, source: "assistant_edit" },
    ]);
    await replayBackfill();
    expect(await aiDraftValues(documentId)).toEqual([true, true]);

    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([true, true]);
  });

  // Documents a real limitation rather than a bug: the migration ledger runs
  // 0180 exactly once, so this ordering never happens in practice, but the
  // backfill recomputes purely from `source` with no historical approval
  // log to consult — it cannot tell an approved draft apart from a
  // never-reviewed one. That is why it must ship once, before any
  // application traffic reaches approve-draft, not be safe to replay later.
  it("recomputes purely from source, so it would re-draft a version a human already approved", async () => {
    const documentId = uid(207);
    await seedChain(documentId, [{ id: uid(2071), versionNumber: 1, source: "generated" }]);
    await client.query(`update public.document_versions set ai_draft = false where id = $1`, [uid(2071)]); // approve-draft, hypothetically before the backfill ran

    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([true]);
  });

  // Gate B4 audit finding N14: migration 0181 accepts the new source value
  // before any code ships that inserts it; the backfill leaves it alone
  // (ai_draft is set by the application at insert time, not here).
  it("accepts the new 'replicated' source (migration 0181) and never touches its ai_draft itself", async () => {
    const documentId = uid(208);
    await seedChain(documentId, [{ id: uid(2081), versionNumber: 1, source: "replicated" }]);
    await client.query(`update public.document_versions set ai_draft = true where id = $1`, [uid(2081)]); // set by application code, same as generate_docx/write_project_document

    await replayBackfill();

    expect(await aiDraftValues(documentId)).toEqual([true]);
  });
});
