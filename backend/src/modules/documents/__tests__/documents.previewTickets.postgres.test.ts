import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import express from "express";
import { Readable } from "node:stream";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMigrationCommand, runMigrationCommand } from "../../../scripts/migrationLedger";
import type { Db } from "../../../lib/supabase";

const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const password = process.env.POSTGRES_PASSWORD ?? "postgres";
const database = `mike_test_preview_tickets_${process.pid}_${Date.now()}`;
const log = { info: () => {}, warn: () => {}, error: () => {} };

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  replicaDb: { current: null as unknown as AsyncLocalStorage<Db> },
}));
mocks.replicaDb.current = new AsyncLocalStorage<Db>();

vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => {
    const db = mocks.replicaDb.current.getStore();
    if (!db) throw new Error("preview ticket test is missing a replica db");
    return db;
  },
}));

vi.mock("../../../middleware/auth", () => ({
  requireAuth: (
    req: { headers: { authorization?: string } },
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    const auth = req.headers.authorization ?? "";
    res.locals.userId = "user-1";
    res.locals.userEmail = "user@example.com";
    res.locals.authSource =
      auth.startsWith("Bearer ") && auth.slice(7).trim() ? "bearer" : "cookie";
    next();
  },
}));

vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  createFileReadStream: () => Readable.from([Buffer.from("docx-bytes")]),
}));

vi.mock("../documents.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents.service")>()),
  getTrackedChangesPreviewSource: mocks.preview,
}));

import {
  consumePreviewTicket,
  mintPreviewTicket,
  PREVIEW_TICKET_HEADER,
} from "../documents.previewTickets";
import { documentsRouter } from "../documents.routes";

type PreviewTicketRow = {
  ticket_hash: string;
  user_id: string;
  document_id: string;
  version_id: string;
  edit_id: string;
  expires_at: string;
};

function pgPreviewTicketDb(client: Client): Db {
  return {
    from(table: string) {
      if (table !== "document_preview_tickets") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        insert: async (row: PreviewTicketRow) => {
          try {
            await client.query(
              `insert into public.document_preview_tickets
                 (ticket_hash, user_id, document_id, version_id, edit_id, expires_at)
               values ($1, $2, $3, $4, $5, $6)`,
              [
                row.ticket_hash,
                row.user_id,
                row.document_id,
                row.version_id,
                row.edit_id,
                row.expires_at,
              ],
            );
            return { error: null };
          } catch (error) {
            return { error: { message: (error as Error).message } };
          }
        },
        delete: () => ({
          lt: async (column: string, value: string) => {
            if (column !== "expires_at") {
              throw new Error(`unexpected delete filter ${column}`);
            }
            await client.query(
              `delete from public.document_preview_tickets where expires_at < $1`,
              [value],
            );
            return { error: null };
          },
          neq: async (column: string, value: string) => {
            if (column !== "ticket_hash") {
              throw new Error(`unexpected delete filter ${column}`);
            }
            await client.query(
              `delete from public.document_preview_tickets where ticket_hash <> $1`,
              [value],
            );
            return { error: null };
          },
        }),
        update: (patch: { expires_at: string }) => ({
          eq: async (column: string, value: string) => {
            if (column !== "ticket_hash") {
              throw new Error(`unexpected update filter ${column}`);
            }
            await client.query(
              `update public.document_preview_tickets set expires_at = $1 where ticket_hash = $2`,
              [patch.expires_at, value],
            );
            return { error: null };
          },
        }),
      };
    },
    rpc: async (name: string, args: { p_ticket_hash: string }) => {
      if (name !== "consume_document_preview_ticket") {
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      }
      const result = await client.query(
        `select * from public.consume_document_preview_ticket($1)`,
        [args.p_ticket_hash],
      );
      return { data: result.rows, error: null };
    },
  } as unknown as Db;
}

function replicaApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    mocks.replicaDb.current.run(db, next);
  });
  app.use("/single-documents", documentsRouter);
  return app;
}

describe.skipIf(!container)(
  "preview tickets in PostgreSQL across two app instances (N45)",
  () => {
    let created = false;
    let clientA: Client;
    let clientB: Client;
    let storeA: Db;
    let storeB: Db;

    beforeAll(async () => {
      execFileSync("docker", [
        "exec",
        container!,
        "createdb",
        "-U",
        "postgres",
        database,
      ]);
      created = true;
      const portLine = execFileSync(
        "docker",
        ["port", container!, "5432/tcp"],
        { encoding: "utf8" },
      ).trim();
      const port = portLine.split(":").pop();
      const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?sslmode=disable`;
      clientA = new Client({ connectionString });
      clientB = new Client({ connectionString });
      await clientA.connect();
      await clientB.connect();
      const failures = await runMigrationCommand(
        clientA,
        parseMigrationCommand(["up"]),
        "migrations",
        log,
      );
      if (failures !== 0) {
        throw new Error(
          `${failures} migration(s) failed while priming the preview ticket test database`,
        );
      }
      storeA = pgPreviewTicketDb(clientA);
      storeB = pgPreviewTicketDb(clientB);
    }, 120_000);

    afterAll(async () => {
      await clientA?.end();
      await clientB?.end();
      if (created) {
        execFileSync("docker", [
          "exec",
          container!,
          "dropdb",
          "-U",
          "postgres",
          "--force",
          database,
        ]);
      }
    });

    beforeEach(async () => {
      mocks.preview.mockReset();
      mocks.preview.mockResolvedValue({
        ok: true,
        storagePath: "documents/user-1/document-1/source.docx",
        fileType: "docx",
        size: 10,
        filename: "Clause.docx",
        versionId: "version-1",
      });
      await clientA.query("delete from public.document_preview_tickets");
    });

    it("stores only the hash and consumes atomically on another replica", async () => {
      const ticket = await mintPreviewTicket(
        {
          userId: "user-1",
          documentId: "document-1",
          versionId: "version-1",
          editId: "edit-1",
        },
        storeA,
      );
      const stored = await clientB.query(
        "select ticket_hash, user_id, document_id, version_id, edit_id from public.document_preview_tickets",
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].ticket_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(stored.rows[0])).not.toContain(ticket);

      const claim = await consumePreviewTicket(ticket, storeB);
      expect(claim).toMatchObject({
        userId: "user-1",
        documentId: "document-1",
        versionId: "version-1",
        editId: "edit-1",
      });
      expect(await consumePreviewTicket(ticket, storeA)).toBeNull();
    });

    it("mints on app A, redeems on app B, and rejects replay with 401", async () => {
      const appA = replicaApp(storeA);
      const appB = replicaApp(storeB);

      const minted = await request(appA)
        .post("/single-documents/document-1/tracked-changes-preview/ticket")
        .set("Cookie", "mike_session=abc")
        .send({ edit_id: "edit-1" });
      expect(minted.status).toBe(200);
      expect(typeof minted.body.ticket).toBe("string");

      const redeemed = await request(appB)
        .get("/single-documents/document-1/tracked-changes-preview?edit_id=edit-1")
        .set("Cookie", "mike_session=abc")
        .set(PREVIEW_TICKET_HEADER, minted.body.ticket);
      expect(redeemed.status).toBe(200);
      expect(redeemed.text).toBe("docx-bytes");

      const replay = await request(appA)
        .get("/single-documents/document-1/tracked-changes-preview?edit_id=edit-1")
        .set("Cookie", "mike_session=abc")
        .set(PREVIEW_TICKET_HEADER, minted.body.ticket);
      expect(replay.status).toBe(401);
    });
  },
);
