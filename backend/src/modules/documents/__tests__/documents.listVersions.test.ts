import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { listVersions } from "../documents.versions";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  pendingEdits: vi.fn(),
}));

vi.mock("../documents.access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents.access")>()),
  ensureDocumentAccess: mocks.access,
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
  pendingAiEditVersionIds: mocks.pendingEdits,
}));

describe("listVersions unresolved_ai (Gate B4 audit finding N31)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({
      ok: true,
      doc: { id: "doc-1", current_version_id: "v2" },
    });
    mocks.pendingEdits.mockResolvedValue(new Set(["v2"]));
  });

  it("attaches unresolved_ai from pending edits and ai_draft", async () => {
    const fake = scriptedDb([
      {
        table: "document_versions",
        data: [
          {
            id: "v1",
            version_number: 1,
            source: "user_upload",
            created_at: "2026-01-01T00:00:00Z",
            filename: "Clause.docx",
            file_type: "docx",
            ai_draft: false,
          },
          {
            id: "v2",
            version_number: 2,
            source: "assistant_edit",
            created_at: "2026-01-02T00:00:00Z",
            filename: "Clause.docx",
            file_type: "docx",
            ai_draft: false,
          },
          {
            id: "v3",
            version_number: 3,
            source: "generated",
            created_at: "2026-01-03T00:00:00Z",
            filename: "Draft.docx",
            file_type: "docx",
            ai_draft: true,
          },
        ],
      },
    ]);

    const result = await listVersions("doc-1", "user", undefined, fake.db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "v1", unresolved_ai: false }),
        expect.objectContaining({ id: "v2", unresolved_ai: true }),
        expect.objectContaining({ id: "v3", unresolved_ai: true, ai_draft: true }),
      ]),
    );
    fake.done();
  });
});
