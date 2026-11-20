import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "user-1";
    res.locals.userEmail = "user@example.com";
    next();
  },
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => ({})),
}));

vi.mock("../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/storage")>()),
  createFileReadStream: () => Readable.from([Buffer.from("docx-bytes")]),
}));

vi.mock("../../modules/documents/documents.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../modules/documents/documents.service")>()),
  getTrackedChangesPreviewSource: mocks.preview,
}));

import { documentsRouter } from "../../modules/documents/documents.routes";

const app = express();
app.use("/single-documents", documentsRouter);

describe("GET /single-documents/:documentId/tracked-changes-preview (N30 preliminary)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preview.mockResolvedValue({
      ok: true,
      storagePath: "documents/user-1/document-1/source.docx",
      fileType: "docx",
      size: 10,
      filename: "Clause.docx",
    });
  });

  it("serves unresolved Word bytes inline with the KI banner headers, never as a download", async () => {
    const response = await request(app)
      .get("/single-documents/document-1/tracked-changes-preview?version_id=version-1")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-mike-ai-draft"]).toBe("1");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["content-disposition"]).not.toContain("attachment");
    expect(response.text).toBe("docx-bytes");
  });

  it("refuses download and confirm_token query parameters", async () => {
    const downloaded = await request(app)
      .get("/single-documents/document-1/tracked-changes-preview?download=1")
      .set("Authorization", "Bearer test");
    expect(downloaded.status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();

    const confirmed = await request(app)
      .get("/single-documents/document-1/tracked-changes-preview?confirm_token=abc")
      .set("Authorization", "Bearer test");
    expect(confirmed.status).toBe(400);
  });

  it("hides a clean version — this exception is only for unresolved KI markup", async () => {
    mocks.preview.mockResolvedValue({
      ok: false,
      kind: "not_found",
      detail: "No file available",
    });
    const response = await request(app)
      .get("/single-documents/document-1/tracked-changes-preview")
      .set("Authorization", "Bearer test");
    expect(response.status).toBe(404);
  });
});
