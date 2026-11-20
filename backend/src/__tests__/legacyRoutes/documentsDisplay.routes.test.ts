import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

// Gate B4 audit finding N17: /display never requires confirmation (a
// display, not an export). An unapproved AI draft is a stamped PDF (or
// refused). Cache-Control: no-store and X-Mike-Ai-Draft tell the viewer
// not to cache and to show the banner.
const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  loadActiveVersion: vi.fn(),
  downloadFile: vi.fn(),
  downloadFileIfAvailable: vi.fn(),
  officeBytesToPdf: vi.fn(),
}));

let pendingEditsCount = 0;

const database = {
  from: vi.fn((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) query[method] = vi.fn(() => query);
    query.single = vi.fn(async () => ({
      data: { id: "document-1", user_id: "user-1", project_id: null, org_id: null, workflow_id: null },
      error: null,
    }));
    if (table === "document_edits") {
      const rows = Array.from({ length: pendingEditsCount }, (_, i) => ({ id: `edit-${i + 1}` }));
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve);
    }
    return query;
  }),
};

vi.mock("../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
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
  downloadFile: mocks.downloadFile,
  downloadFileIfAvailable: mocks.downloadFileIfAvailable,
}));

vi.mock("../../lib/convert", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/convert")>()),
  officeBytesToPdf: mocks.officeBytesToPdf,
}));

import { documentsRouter } from "../../modules/documents/documents.routes";

const app = express();
app.use("/single-documents", documentsRouter);

describe("GET /single-documents/:documentId/display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingEditsCount = 0;
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.downloadFileIfAvailable.mockResolvedValue(null);
  });

  it("serves a clean document without Cache-Control: no-store", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/document-1/source.xlsx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "financials.xlsx",
      source: "user_upload",
      file_type: "xlsx",
      ai_draft: false,
    });
    mocks.downloadFile.mockResolvedValue(Buffer.from("fake xlsx bytes"));

    const response = await request(app)
      .get("/single-documents/document-1/display")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("serves an unapproved AI draft PDF with Cache-Control: no-store, unconfirmed", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    pendingEditsCount = 1;
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/document-1/source.pdf",
      pdf_storage_path: null,
      version_number: 1,
      filename: "brief.pdf",
      source: "tool_write",
      file_type: "pdf",
      ai_draft: true,
    });
    mocks.downloadFile.mockResolvedValue(Buffer.from(await pdf.save()));

    const response = await request(app)
      .get("/single-documents/document-1/display")
      .set("Authorization", "Bearer test");

    // No confirm_token was sent, and the response is served anyway (200, not 409).
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-mike-ai-draft"]).toBe("1");
  });

  it("stamps an xlsx draft when the converter returns a PDF (N17/N33)", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/document-1/source.xlsx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "financials.xlsx",
      source: "tool_write",
      file_type: "xlsx",
      ai_draft: true,
    });
    mocks.downloadFile.mockResolvedValue(Buffer.from("fake xlsx bytes"));
    mocks.officeBytesToPdf.mockResolvedValue(Buffer.from(await pdf.save()));

    const response = await request(app)
      .get("/single-documents/document-1/display")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-mike-ai-draft"]).toBe("1");
    expect(response.headers["content-type"]).toContain("application/pdf");
  });

  it("refuses an xlsx draft when the converter is missing or fails (N17/N33)", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/document-1/source.xlsx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "financials.xlsx",
      source: "tool_write",
      file_type: "xlsx",
      ai_draft: true,
    });
    mocks.downloadFile.mockResolvedValue(Buffer.from("fake xlsx bytes"));
    mocks.officeBytesToPdf.mockRejectedValue(new Error("soffice not installed"));

    const response = await request(app)
      .get("/single-documents/document-1/display")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("stamping_failed");
  });
});
