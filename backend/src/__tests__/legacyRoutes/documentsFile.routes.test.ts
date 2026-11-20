import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFileReadStream: vi.fn(),
  downloadFile: vi.fn(),
  ensureDocAccess: vi.fn(),
  headFile: vi.fn(),
  loadActiveVersion: vi.fn(),
}));

// Gate B4 audit finding N5: how many pending document_edits rows
// aiDraftConfirmationState sees. 0 by default (every pre-existing test in
// this file expects the unconfirmed-download path to be unaffected).
let pendingEditsCount = 0;

const database = {
  from: vi.fn((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) {
      query[method] = vi.fn(() => query);
    }
    query.single = vi.fn(async () => ({
      data: {
        id: "document-1",
        user_id: "user-1",
        project_id: null,
        org_id: null,
        workflow_id: null,
      },
      error: null,
    }));
    if (table === "document_edits") {
      // aiDraftConfirmationState never calls .single(); it awaits the
      // select/eq/order chain itself and reads the pending edit id rows
      // off { data }.
      const rows = Array.from({ length: pendingEditsCount }, (_, i) => ({
        id: `edit-${i + 1}`,
      }));
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve);
    }
    return query;
  }),
};

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
  createServerSupabase: vi.fn(() => database),
}));

vi.mock("../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
}));

vi.mock("../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));

vi.mock("../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/storage")>()),
  createFileReadStream: mocks.createFileReadStream,
  downloadFile: mocks.downloadFile,
  headFile: mocks.headFile,
}));

import { documentsRouter } from "../../modules/documents/documents.routes";

const app = express();
app.use("/single-documents", documentsRouter);

describe("GET /single-documents/:documentId/file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingEditsCount = 0;
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-2",
      storage_path: "documents/user-1/document-1/source.xlsx",
      pdf_storage_path: "converted-pdfs/user-1/document-1/version-2.pdf",
      version_number: 2,
      filename: "financials.xlsx",
      source: "user_upload",
      file_type: "xlsx",
      size_bytes: 3,
      page_count: null,
    });
    mocks.headFile.mockResolvedValue({
      size: 3,
      etag: '"etag"',
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([Buffer.from([0x50, 0x4b, 0x03])]),
    );
  });

  it("streams the requested version's source bytes with its actual file type", async () => {
    const response = await request(app)
      .get("/single-documents/document-1/file?version_id=version-2")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["content-disposition"]).toContain(
      "financials.xlsx",
    );
    expect(response.headers["content-length"]).toBe("3");
    expect(mocks.loadActiveVersion).toHaveBeenCalledWith(
      "document-1",
      database,
      "version-2",
    );
    expect(mocks.headFile).toHaveBeenCalledWith(
      "documents/user-1/document-1/source.xlsx",
    );
    expect(mocks.createFileReadStream).toHaveBeenCalledWith(
      "documents/user-1/document-1/source.xlsx",
    );
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("does not read storage when the caller cannot access the document", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: false });

    const response = await request(app)
      .get("/single-documents/document-1/file")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Document not found" });
    expect(mocks.loadActiveVersion).not.toHaveBeenCalled();
    expect(mocks.headFile).not.toHaveBeenCalled();
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("returns 404 without opening a stream when the source object is missing", async () => {
    mocks.headFile.mockResolvedValue(null);

    const response = await request(app)
      .get("/single-documents/document-1/file")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Document bytes not available" });
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("does not retain the old format-specific route", async () => {
    const response = await request(app)
      .get("/single-documents/document-1/docx")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(mocks.loadActiveVersion).not.toHaveBeenCalled();
  });

  // Gate B4 audit finding L3.
  describe("documents with unresolved AI-proposed changes", () => {
    beforeEach(() => {
      pendingEditsCount = 1;
      mocks.loadActiveVersion.mockResolvedValue({
        id: "version-2",
        storage_path: "documents/user-1/document-1/source.docx",
        pdf_storage_path: null,
        version_number: 2,
        filename: "brief.docx",
        source: "assistant_edit",
        file_type: "docx",
        size_bytes: 3,
        page_count: null,
      });
      mocks.headFile.mockResolvedValue({
        size: 3,
        etag: '"etag"',
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    });

    it("refuses the download with 409 without explicit confirmation", async () => {
      const response = await request(app)
        .get("/single-documents/document-1/file")
        .set("Authorization", "Bearer test");

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("unresolved_ai_edits");
      expect(mocks.createFileReadStream).not.toHaveBeenCalled();
      expect(mocks.downloadFile).not.toHaveBeenCalled();
    });

    it("serves a watermarked file once the caller confirms the AI draft", async () => {
      const w_ns =
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document ${w_ns}><w:body><w:p><w:r><w:t>Original.</w:t></w:r></w:p></w:body></w:document>`,
      );
      const original = await zip.generateAsync({ type: "arraybuffer" });
      mocks.downloadFile.mockResolvedValue(original);

      // Gate B4 audit finding N5: the confirm_token comes from the 409
      // itself — it is not a value the client can guess or hardcode.
      const refusal = await request(app)
        .get("/single-documents/document-1/file")
        .set("Authorization", "Bearer test");
      expect(refusal.status).toBe(409);
      const confirmToken = refusal.body.confirm_token as string;
      expect(confirmToken).toMatch(/^[0-9a-f]{64}$/);

      const response = await request(app)
        .get(`/single-documents/document-1/file?confirm_token=${confirmToken}`)
        .set("Authorization", "Bearer test")
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        });

      expect(response.status).toBe(200);
      expect(mocks.downloadFile).toHaveBeenCalledWith(
        "documents/user-1/document-1/source.docx",
      );
      expect(mocks.createFileReadStream).not.toHaveBeenCalled();
      const stampedZip = await JSZip.loadAsync(response.body as Buffer);
      const xml = await stampedZip.file("word/document.xml")!.async("string");
      expect(xml).toContain("KI-ENTWURF");
      expect(xml).toContain("Original.");
    });

    // Gate B4 audit finding N5: a stale token must not be replayable once
    // the document's pending-edit set changes.
    it("rejects a confirm_token computed before a new pending edit landed", async () => {
      const before = await request(app)
        .get("/single-documents/document-1/file")
        .set("Authorization", "Bearer test");
      const staleToken = before.body.confirm_token as string;

      pendingEditsCount = 2; // a second edit landed

      const response = await request(app)
        .get(`/single-documents/document-1/file?confirm_token=${staleToken}`)
        .set("Authorization", "Bearer test");

      expect(response.status).toBe(409);
      expect(response.body.confirm_token).not.toBe(staleToken);
    });

    // Gate B4 audit finding N6: fail-closed, not fail-open.
    it("refuses with 409 rather than serving unstamped when stamping fails", async () => {
      mocks.downloadFile.mockResolvedValue(null); // stampAiDraftWatermark never gets bytes

      const refusal = await request(app)
        .get("/single-documents/document-1/file")
        .set("Authorization", "Bearer test");
      const confirmToken = refusal.body.confirm_token as string;

      const response = await request(app)
        .get(`/single-documents/document-1/file?confirm_token=${confirmToken}`)
        .set("Authorization", "Bearer test");

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("stamping_failed");
      expect(mocks.createFileReadStream).not.toHaveBeenCalled();
    });

    it("downloads unchanged once no changes are pending", async () => {
      pendingEditsCount = 0;

      const response = await request(app)
        .get("/single-documents/document-1/file")
        .set("Authorization", "Bearer test");

      expect(response.status).toBe(200);
      expect(mocks.createFileReadStream).toHaveBeenCalledWith(
        "documents/user-1/document-1/source.docx",
      );
      expect(mocks.downloadFile).not.toHaveBeenCalled();
    });
  });
});
