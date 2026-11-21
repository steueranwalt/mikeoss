import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
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

describe("GET /single-documents/:documentId/tracked-changes-preview (N30/N37)", () => {
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

  it("serves unresolved Word bytes with the KI banner headers, never as a download", async () => {
    const response = await request(app)
      .get(
        "/single-documents/document-1/tracked-changes-preview?version_id=version-1&edit_id=edit-1",
      )
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-mike-ai-draft"]).toBe("1");
    expect(response.headers["content-disposition"]).toBeUndefined();
    expect(response.text).toBe("docx-bytes");
    expect(mocks.preview).toHaveBeenCalledWith(
      "document-1",
      "user-1",
      "user@example.com",
      "version-1",
      expect.anything(),
      "edit-1",
    );
  });

  it("Cookie ohne Bearer wird abgelehnt", async () => {
    const response = await request(app)
      .get(
        "/single-documents/document-1/tracked-changes-preview?edit_id=edit-1",
      )
      .set("Cookie", "mike_session=abc");

    expect(response.status).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("ohne offene Edits gibt 404", async () => {
    mocks.preview.mockResolvedValue({
      ok: false,
      kind: "not_found",
      detail: "No file available",
    });
    const response = await request(app)
      .get("/single-documents/document-1/tracked-changes-preview?edit_id=edit-1")
      .set("Authorization", "Bearer test");
    expect(response.status).toBe(404);
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
});
