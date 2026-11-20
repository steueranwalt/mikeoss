import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  loadActiveVersion: vi.fn(),
  downloadFile: vi.fn(),
  downloadFileIfAvailable: vi.fn(),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
}));

vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));

vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
  downloadFileIfAvailable: mocks.downloadFileIfAvailable,
}));

import { getDisplayableVersion } from "../documents.download";

// Gate B4 audit finding N17: how many pending document_edits rows exist for
// the version being displayed.
let pendingEditsCount = 0;

function database() {
  return {
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order"]) query[method] = () => query;
      query.single = async () => ({
        data: { id: "document-1", user_id: "user-1", project_id: null, org_id: null, workflow_id: null },
        error: null,
      });
      if (table === "document_edits") {
        const rows = Array.from({ length: pendingEditsCount }, (_, i) => ({ id: `edit-${i + 1}` }));
        query.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve);
      }
      return query;
    },
  } as never;
}

async function makePdfBytes(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return Buffer.from(await pdf.save());
}

describe("getDisplayableVersion (Gate B4 audit finding N17)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingEditsCount = 0;
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.downloadFileIfAvailable.mockResolvedValue(null);
  });

  it("never requires confirmation for a draft — it just marks isAiDraft", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.xlsx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "financials.xlsx",
      source: "generated",
      file_type: "xlsx", // not converted to PDF, so no LibreOffice dependency here
      ai_draft: true,
    });
    mocks.downloadFile.mockResolvedValue(Buffer.from("fake xlsx bytes"));

    const result = await getDisplayableVersion("doc-1", "user-1", "u@example.com", null, database());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isAiDraft).toBe(true);
  });

  it("stamps the PDF rendition of an unapproved AI draft with the banner", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.pdf",
      pdf_storage_path: null,
      version_number: 1,
      filename: "brief.pdf",
      source: "generated",
      file_type: "pdf",
      ai_draft: true,
    });
    const original = await makePdfBytes();
    mocks.downloadFile.mockResolvedValue(original);

    const result = await getDisplayableVersion("doc-1", "user-1", "u@example.com", null, database());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isAiDraft).toBe(true);
      expect(result.display.contentType).toBe("application/pdf");
      expect(result.display.bytes.byteLength).toBeGreaterThan(original.byteLength);
      const stamped = await PDFDocument.load(result.display.bytes);
      expect(stamped.getPageCount()).toBe(1);
    }
  });

  it("falls back to the unstamped PDF (best-effort, not fail-closed) when stamping fails", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.pdf",
      pdf_storage_path: "renditions/doc-1/v1.pdf",
      version_number: 1,
      filename: "brief.pdf",
      source: "generated",
      file_type: "docx", // converted to PDF via the stored rendition below
      ai_draft: true,
    });
    mocks.downloadFileIfAvailable.mockResolvedValue(Buffer.from("not a real pdf"));

    const result = await getDisplayableVersion("doc-1", "user-1", "u@example.com", null, database());

    // The preview still works — a stamping failure never breaks /display.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isAiDraft).toBe(true);
      expect(result.display.bytes.toString()).toBe("not a real pdf");
    }
  });

  it("does not touch a non-draft, non-pending-edit document's rendition", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.pdf",
      pdf_storage_path: null,
      version_number: 1,
      filename: "brief.pdf",
      source: "user_upload",
      file_type: "pdf",
      ai_draft: false,
    });
    const original = await makePdfBytes();
    mocks.downloadFile.mockResolvedValue(original);

    const result = await getDisplayableVersion("doc-1", "user-1", "u@example.com", null, database());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isAiDraft).toBe(false);
      expect(result.display.bytes).toEqual(original);
    }
  });

  it("leaves a displayed spreadsheet (no stamping capability) unchanged but still marks isAiDraft", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.xlsx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "financials.xlsx",
      source: "tool_write",
      file_type: "xlsx",
      ai_draft: true,
    });
    const original = Buffer.from("fake xlsx bytes");
    mocks.downloadFile.mockResolvedValue(original);

    const result = await getDisplayableVersion("doc-1", "user-1", "u@example.com", null, database());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isAiDraft).toBe(true);
      expect(result.display.bytes).toEqual(original);
    }
  });
});
