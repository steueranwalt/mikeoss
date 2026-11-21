import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTrackedChangesPreviewSource } from "../documents.download";

const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  loadActiveVersion: vi.fn(),
  headFile: vi.fn(),
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
  headFile: mocks.headFile,
}));

let pendingEditsCount = 0;

function database() {
  return {
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order"]) query[method] = () => query;
      query.single = async () => ({
        data: {
          id: "document-1",
          user_id: "user-1",
          project_id: null,
          org_id: null,
          workflow_id: null,
        },
        error: null,
      });
      if (table === "document_edits") {
        const rows = Array.from({ length: pendingEditsCount }, (_, i) => ({
          id: `edit-${i + 1}`,
        }));
        query.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve);
      }
      return query;
    },
  } as never;
}

describe("getTrackedChangesPreviewSource (N30/N37)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingEditsCount = 1;
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.headFile.mockResolvedValue({ size: 12 });
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.docx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "Clause.docx",
      source: "assistant_edit",
      file_type: "docx",
      ai_draft: false,
    });
  });

  it("serves a docx with pending KI edits without requiring confirmation", async () => {
    const result = await getTrackedChangesPreviewSource(
      "doc-1",
      "user-1",
      "u@example.com",
      "version-1",
      database(),
      "edit-1",
    );
    expect(result).toMatchObject({
      ok: true,
      storagePath: "documents/user-1/doc-1/source.docx",
      filename: "Clause [Edited V1].docx",
    });
  });

  it("ohne offene Edits gibt 404", async () => {
    pendingEditsCount = 0;
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.docx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "Clause.docx",
      source: "user_upload",
      file_type: "docx",
      ai_draft: false,
    });
    const result = await getTrackedChangesPreviewSource(
      "doc-1",
      "user-1",
      "u@example.com",
      "version-1",
      database(),
      "edit-1",
    );
    expect(result).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("ai_draft ohne Änderungen gibt 404", async () => {
    pendingEditsCount = 0;
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.docx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "Clause.docx",
      source: "generated",
      file_type: "docx",
      ai_draft: true,
    });
    const result = await getTrackedChangesPreviewSource(
      "doc-1",
      "user-1",
      "u@example.com",
      "version-1",
      database(),
      "edit-1",
    );
    expect(result).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("refuses a non-Word file even when it is an AI draft", async () => {
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/user-1/doc-1/source.xlsx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "financials.xlsx",
      source: "generated",
      file_type: "xlsx",
      ai_draft: true,
    });
    const result = await getTrackedChangesPreviewSource(
      "doc-1",
      "user-1",
      "u@example.com",
      null,
      database(),
      "edit-1",
    );
    expect(result).toMatchObject({ ok: false, kind: "unsupported" });
  });
});
