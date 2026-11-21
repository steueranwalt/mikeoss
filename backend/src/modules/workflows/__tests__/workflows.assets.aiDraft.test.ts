import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  resolveWorkflowAccess: vi.fn(),
  ensureDocAccess: vi.fn(),
  findDocumentsOutsideWorkspace: vi.fn(),
  createDocumentVersion: vi.fn(),
  copyDocumentVersionFiles: vi.fn(),
  attachLatestVersionNumbers: vi.fn(),
  attachActiveVersionPaths: vi.fn(),
  pendingEdits: vi.fn(),
}));

vi.mock("../workflows.access", async (original) => ({
  ...(await original<typeof import("../workflows.access")>()),
  resolveWorkflowAccess: mocks.resolveWorkflowAccess,
}));
vi.mock("../../../lib/access", async (original) => ({
  ...(await original<typeof import("../../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
}));
vi.mock("../../../lib/documentWorkspace", async (original) => ({
  ...(await original<typeof import("../../../lib/documentWorkspace")>()),
  findDocumentsOutsideWorkspace: mocks.findDocumentsOutsideWorkspace,
}));
vi.mock("../../../lib/documentVersions", async (original) => ({
  ...(await original<typeof import("../../../lib/documentVersions")>()),
  attachLatestVersionNumbers: mocks.attachLatestVersionNumbers,
  attachActiveVersionPaths: mocks.attachActiveVersionPaths,
  pendingAiEditVersionIds: mocks.pendingEdits,
}));
vi.mock("../../documents/documents.service", async (original) => ({
  ...(await original<typeof import("../../documents/documents.service")>()),
  createDocumentVersion: mocks.createDocumentVersion,
  copyDocumentVersionFiles: mocks.copyDocumentVersionFiles,
}));

import { copyDocumentsToWorkflowAssets } from "../workflows.assets";

describe("copyDocumentsToWorkflowAssets (Gate B4 audit finding N25)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkflowAccess.mockResolvedValue({
      allowEdit: true,
      workflow: { org_id: null, type: "assistant" },
    });
    mocks.ensureDocAccess.mockResolvedValue({ ok: true });
    mocks.findDocumentsOutsideWorkspace.mockResolvedValue([]);
    mocks.copyDocumentVersionFiles.mockResolvedValue({ pdfStoragePath: null });
    mocks.createDocumentVersion.mockResolvedValue({ data: { id: "new-v" }, error: null });
    mocks.attachLatestVersionNumbers.mockResolvedValue(undefined);
    mocks.attachActiveVersionPaths.mockResolvedValue(undefined);
    mocks.pendingEdits.mockResolvedValue(new Set());
  });

  it("inherits ai_draft when saving a document as a workflow asset", async () => {
    const fake = scriptedDb([
      {
        table: "documents",
        data: [
          {
            id: "src",
            user_id: "user-1",
            project_id: null,
            org_id: null,
            workflow_id: null,
            current_version_id: "v1",
          },
        ],
      },
      {
        table: "document_versions",
        data: [
          {
            id: "v1",
            document_id: "src",
            storage_path: "src/key",
            pdf_storage_path: null,
            filename: "Draft.docx",
            file_type: "docx",
            size_bytes: 4,
            page_count: null,
            textless_page_count: null,
            content_sha256: null,
            ai_draft: true,
          },
        ],
      },
      { table: "documents", op: "insert", data: null },
      {
        table: "documents",
        data: [{ id: "copied-asset", status: "ready" }],
      },
    ]);

    const result = await copyDocumentsToWorkflowAssets(fake.db, {
      workflowId: "workflow-1",
      userId: "user-1",
      userEmail: "u@example.com",
      documentIds: ["src"],
    });

    expect(result.ok).toBe(true);
    expect(mocks.createDocumentVersion).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({
        filename: "Draft.docx",
        file_type: "docx",
      }),
      { aiDraft: true },
    );
    fake.done();
  });

  it("marks the copy an AI draft when the source has pending KI edits (N32)", async () => {
    mocks.pendingEdits.mockResolvedValue(new Set(["v1"]));
    const fake = scriptedDb([
      {
        table: "documents",
        data: [
          {
            id: "src",
            user_id: "user-1",
            project_id: null,
            org_id: null,
            workflow_id: null,
            current_version_id: "v1",
          },
        ],
      },
      {
        table: "document_versions",
        data: [
          {
            id: "v1",
            document_id: "src",
            storage_path: "src/key",
            pdf_storage_path: null,
            filename: "Clause.docx",
            file_type: "docx",
            size_bytes: 4,
            page_count: null,
            textless_page_count: null,
            content_sha256: null,
            ai_draft: false,
          },
        ],
      },
      { table: "documents", op: "insert", data: null },
      {
        table: "documents",
        data: [{ id: "copied-asset", status: "ready" }],
      },
    ]);

    const result = await copyDocumentsToWorkflowAssets(fake.db, {
      workflowId: "workflow-1",
      userId: "user-1",
      userEmail: "u@example.com",
      documentIds: ["src"],
    });

    expect(result.ok).toBe(true);
    expect(mocks.createDocumentVersion).toHaveBeenCalledWith(
      fake.db,
      expect.objectContaining({
        filename: "Clause.docx",
        file_type: "docx",
      }),
      { aiDraft: true },
    );
    fake.done();
  });
});
