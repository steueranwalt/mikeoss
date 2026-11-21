import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const mocks = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("../documents.access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents.access")>()),
  ensureDocumentAccess: mocks.access,
}));

import { approveAiDraftVersion } from "../documents.versions";

// Gate B4 audit finding L4: human approval clears the AI-draft flag
// generate_docx/excel/ppt and write_project_document set — nothing else does.
describe("approveAiDraftVersion", () => {
  it("clears ai_draft on the version a member with edit access names", async () => {
    mocks.access.mockResolvedValue({
      ok: true,
      isCreator: true,
      projectRole: "owner",
      doc: { id: "doc-1", user_id: "actor" },
    });
    const update = vi.fn(() => chain);
    const eqCalls: [string, unknown][] = [];
    const chain: Record<string, unknown> = {
      update,
      eq: vi.fn((column: string, value: unknown) => {
        eqCalls.push([column, value]);
        return chain;
      }),
      is: vi.fn(() => chain),
      select: vi.fn(() => chain),
      single: vi.fn(async () => ({
        data: { id: "version-1", ai_draft: false },
        error: null,
      })),
    };
    const db = { from: vi.fn(() => chain) } as unknown as Db;

    const result = await approveAiDraftVersion(
      {
        documentId: "doc-1",
        versionId: "version-1",
        userId: "actor",
        userEmail: undefined,
      },
      db,
    );

    expect(result).toEqual({
      ok: true,
      version: { id: "version-1", ai_draft: false },
    });
    expect(update).toHaveBeenCalledWith({ ai_draft: false });
    expect(eqCalls).toContainEqual(["id", "version-1"]);
    expect(eqCalls).toContainEqual(["document_id", "doc-1"]);
  });

  it("refuses a caller without edit permission", async () => {
    mocks.access.mockResolvedValue({
      ok: true,
      isCreator: false,
      projectRole: "viewer",
      doc: { id: "doc-1", user_id: "someone-else" },
    });
    const db = { from: vi.fn() } as unknown as Db;

    const result = await approveAiDraftVersion(
      {
        documentId: "doc-1",
        versionId: "version-1",
        userId: "actor",
        userEmail: undefined,
      },
      db,
    );

    expect(result.ok).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("reports not found rather than leaking a document the caller cannot access", async () => {
    mocks.access.mockResolvedValue({ ok: false });
    const db = { from: vi.fn() } as unknown as Db;

    const result = await approveAiDraftVersion(
      {
        documentId: "doc-1",
        versionId: "version-1",
        userId: "actor",
        userEmail: undefined,
      },
      db,
    );

    expect(result).toEqual({ ok: false, detail: "Document not found" });
  });
});
