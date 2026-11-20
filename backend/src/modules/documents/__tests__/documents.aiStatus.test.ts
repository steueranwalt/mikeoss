import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { ensureDocAccess } from "../../../lib/access";
import { loadActiveVersion, pendingAiEditVersionIds } from "../../../lib/documentVersions";
import { getDocumentAiStatus } from "../documents.access";

vi.mock("../../../lib/access", async (load) => ({
  ...(await load<object>()),
  ensureDocAccess: vi.fn(),
}));
vi.mock("../../../lib/documentVersions", () => ({
  attachActiveVersionPaths: vi.fn(),
  attachLatestVersionNumbers: vi.fn(),
  loadActiveVersion: vi.fn(),
  pendingAiEditVersionIds: vi.fn(),
}));

describe("getDocumentAiStatus (Gate B4 audit finding N30/N31)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureDocAccess).mockResolvedValue({
      ok: true,
      projectRole: "owner",
      isCreator: true,
      orgRole: null,
    } as never);
    vi.mocked(loadActiveVersion).mockResolvedValue({
      id: "version-1",
      ai_draft: false,
      storage_path: "src",
      pdf_storage_path: null,
      version_number: 1,
      filename: "Clause.docx",
      source: "assistant_edit",
      file_type: "docx",
      size_bytes: 4,
      page_count: null,
      textless_page_count: null,
    });
    vi.mocked(pendingAiEditVersionIds).mockResolvedValue(new Set());
  });

  it("reports a clean version as neither draft nor unresolved", async () => {
    const fake = scriptedDb([
      {
        table: "documents",
        data: { id: "doc-1", user_id: "user", project_id: "project" },
      },
    ]);
    expect(
      await getDocumentAiStatus("doc-1", "user", undefined, "version-1", fake.db),
    ).toEqual({ ok: true, ai_draft: false, unresolved_ai: false });
    fake.done();
  });

  it("reports pending KI edits as unresolved_ai without ai_draft", async () => {
    vi.mocked(pendingAiEditVersionIds).mockResolvedValue(new Set(["version-1"]));
    const fake = scriptedDb([
      {
        table: "documents",
        data: { id: "doc-1", user_id: "user", project_id: "project" },
      },
    ]);
    expect(
      await getDocumentAiStatus("doc-1", "user", undefined, "version-1", fake.db),
    ).toEqual({ ok: true, ai_draft: false, unresolved_ai: true });
    fake.done();
  });

  it("reports an AI draft as both flags", async () => {
    vi.mocked(loadActiveVersion).mockResolvedValue({
      id: "version-1",
      ai_draft: true,
      storage_path: "src",
      pdf_storage_path: null,
      version_number: 1,
      filename: "Draft.docx",
      source: "generated",
      file_type: "docx",
      size_bytes: 4,
      page_count: null,
      textless_page_count: null,
    });
    const fake = scriptedDb([
      {
        table: "documents",
        data: { id: "doc-1", user_id: "user", project_id: "project" },
      },
    ]);
    expect(
      await getDocumentAiStatus("doc-1", "user", undefined, null, fake.db),
    ).toEqual({ ok: true, ai_draft: true, unresolved_ai: true });
    fake.done();
  });
});
