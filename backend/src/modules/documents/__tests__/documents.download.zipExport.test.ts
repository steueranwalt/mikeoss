import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  headFile: vi.fn(),
  loadActiveVersion: vi.fn(),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
}));

vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  headFile: mocks.headFile,
}));

vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));

import { resolveZipExportDocuments } from "../documents.service";

// Gate B4 audit finding N4/N15: how many pending document_edits rows
// aiDraftConfirmationState sees per call. Keyed off version_id (the query
// is scoped to the exact version being checked, not the whole document) so
// a test can give different versions different pending-edit counts.
let pendingEditsCountByVersion: Record<string, number> = {};

function makeDatabase() {
  return {
    from: vi.fn((table: string) => {
      const query: Record<string, unknown> = {};
      let eqVersionId: string | undefined;
      for (const method of ["select", "in", "is"]) {
        query[method] = vi.fn(() => query);
      }
      query.eq = vi.fn((column: string, value: string) => {
        if (column === "version_id") eqVersionId = value;
        return query;
      });
      query.order = vi.fn(() => query);
      if (table === "documents") {
        query.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: [
              {
                id: "doc-1",
                current_version_id: "version-1",
                user_id: "user-1",
                project_id: null,
                org_id: null,
                workflow_id: null,
              },
              {
                id: "doc-2",
                current_version_id: "version-2",
                user_id: "user-1",
                project_id: null,
                org_id: null,
                workflow_id: null,
              },
            ],
            error: null,
          }).then(resolve);
      } else if (table === "document_versions") {
        query.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: [
              {
                id: "version-1",
                storage_path: "documents/user-1/doc-1/source.docx",
                pdf_storage_path: null,
                version_number: 1,
                filename: "one.docx",
                source: "user_upload",
                file_type: "docx",
                size_bytes: 3,
                page_count: null,
                textless_page_count: null,
                content_sha256: null,
                ai_draft: false,
              },
              {
                id: "version-2",
                storage_path: "documents/user-1/doc-2/source.docx",
                pdf_storage_path: null,
                version_number: 1,
                filename: "two.docx",
                source: "user_upload",
                file_type: "docx",
                size_bytes: 3,
                page_count: null,
                textless_page_count: null,
                content_sha256: null,
                ai_draft: false,
              },
            ],
            error: null,
          }).then(resolve);
      } else if (table === "document_edits") {
        query.then = (resolve: (value: unknown) => unknown) => {
          const count = eqVersionId ? (pendingEditsCountByVersion[eqVersionId] ?? 0) : 0;
          const rows = Array.from({ length: count }, (_, i) => ({
            id: `${eqVersionId}-edit-${i + 1}`,
          }));
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        };
      }
      return query;
    }),
  };
}

describe("resolveZipExportDocuments (Gate B4 audit finding N4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingEditsCountByVersion = {};
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.headFile.mockResolvedValue({ size: 3, etag: '"etag"', contentType: "application/octet-stream" });
    mocks.loadActiveVersion.mockImplementation(async (documentId: string) => {
      if (documentId === "doc-1") {
        return { id: "version-1", ai_draft: false, storage_path: "documents/user-1/doc-1/source.docx" };
      }
      return { id: "version-2", ai_draft: false, storage_path: "documents/user-1/doc-2/source.docx" };
    });
  });

  it("bundles every requested document when none need confirmation", async () => {
    const result = await resolveZipExportDocuments(
      { documentIds: ["doc-1", "doc-2"], folderIds: [], userId: "user-1", userEmail: "u@example.com" },
      makeDatabase() as never,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toHaveLength(2);
  });

  it("refuses the whole batch with 409-shaped confirmation_required when one document is an unapproved AI draft", async () => {
    mocks.loadActiveVersion.mockImplementation(async (documentId: string) => {
      if (documentId === "doc-1") {
        return { id: "version-1", ai_draft: true, storage_path: "documents/user-1/doc-1/source.docx" };
      }
      return { id: "version-2", ai_draft: false, storage_path: "documents/user-1/doc-2/source.docx" };
    });

    const result = await resolveZipExportDocuments(
      { documentIds: ["doc-1", "doc-2"], folderIds: [], userId: "user-1", userEmail: "u@example.com" },
      makeDatabase() as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "confirmation_required") {
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].document_id).toBe("doc-1");
      expect(result.documents[0].confirm_token).toMatch(/^[0-9a-f]{64}$/);
    } else {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
    }
    // Fail-closed: headFile (and therefore the archive) never runs once any
    // document in the batch needs confirmation.
    expect(mocks.headFile).not.toHaveBeenCalled();
  });

  it("refuses the whole batch when one document has pending tracked-change edits", async () => {
    pendingEditsCountByVersion["version-2"] = 1;

    const result = await resolveZipExportDocuments(
      { documentIds: ["doc-1", "doc-2"], folderIds: [], userId: "user-1", userEmail: "u@example.com" },
      makeDatabase() as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "confirmation_required") {
      expect(result.documents.map((d) => d.document_id)).toEqual(["doc-2"]);
    } else {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
    }
  });
});
