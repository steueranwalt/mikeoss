import { beforeEach, describe, expect, it, vi } from "vitest";

// Gate B4 audit finding N15: aiDraftConfirmationState must check the exact
// version a caller resolved (active or a specific ?version_id), never
// hardcode "the document's current active version" regardless of what is
// actually being delivered.
const mocks = vi.hoisted(() => ({
  loadActiveVersion: vi.fn(),
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));

import { aiDraftConfirmationState } from "../documents.edits";

// How many pending document_edits rows exist per version_id — the query is
// scoped to version_id, not document_id (a historical version never
// contains edits proposed against a later one).
let pendingEditIdsByVersion: Record<string, string[]> = {};

function fakeDb() {
  return {
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      let versionId: string | undefined;
      query.select = () => query;
      query.eq = (column: string, value: string) => {
        if (table === "document_edits" && column === "version_id") versionId = value;
        return query;
      };
      query.order = () => query;
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: (pendingEditIdsByVersion[versionId ?? ""] ?? []).map((id) => ({ id })),
          error: null,
        }).then(resolve);
      return query;
    },
  } as never;
}

/** Resolves versionId (or "active" as a stand-in for "no version_id given") to a version row. */
function mockVersions(versions: Record<string, { id: string; ai_draft: boolean } | null>) {
  mocks.loadActiveVersion.mockImplementation(
    async (_documentId: string, _db: unknown, versionId?: string | null) =>
      versions[versionId ?? "active"] ?? null,
  );
}

beforeEach(() => {
  pendingEditIdsByVersion = {};
  mocks.loadActiveVersion.mockReset();
});

describe("aiDraftConfirmationState (Gate B4 audit finding N15)", () => {
  it("checks the document's active version when no version_id is given", async () => {
    mockVersions({ active: { id: "version-active", ai_draft: false } });

    expect(await aiDraftConfirmationState("doc-1", fakeDb())).toBeNull();
  });

  it("checks the specific version_id requested, not the (clean) active version", async () => {
    // The active version is clean, but the caller explicitly asked for an
    // older version that is still an unapproved AI draft — that draft state
    // must not be hidden just because *some other* version is fine.
    mockVersions({
      active: { id: "version-active", ai_draft: false },
      "version-old-draft": { id: "version-old-draft", ai_draft: true },
    });

    const state = await aiDraftConfirmationState("doc-1", fakeDb(), "version-old-draft");
    expect(state).not.toBeNull();
    expect(state?.versionId).toBe("version-old-draft");
    expect(state?.aiDraft).toBe(true);
  });

  it("does not require confirmation for a clean, specifically-requested old version, even if the active version is a draft", async () => {
    mockVersions({
      active: { id: "version-active", ai_draft: true },
      "version-clean-old": { id: "version-clean-old", ai_draft: false },
    });

    expect(await aiDraftConfirmationState("doc-1", fakeDb(), "version-clean-old")).toBeNull();
  });

  it("scopes pending-edit lookup to the requested version's own id, not the whole document", async () => {
    mockVersions({
      active: { id: "version-active", ai_draft: false },
      "version-old-draft": { id: "version-old-draft", ai_draft: true },
    });
    pendingEditIdsByVersion["version-active"] = ["edit-1"];
    pendingEditIdsByVersion["version-old-draft"] = []; // no pending edits against this one

    const activeState = await aiDraftConfirmationState("doc-1", fakeDb());
    expect(activeState?.pendingEditIds).toEqual(["edit-1"]);

    // A later edit pending against the *active* version does not apply to
    // an older version a caller explicitly asked for — it is a different
    // version's bytes, which never contained that proposed change.
    const oldDraftState = await aiDraftConfirmationState("doc-1", fakeDb(), "version-old-draft");
    expect(oldDraftState?.pendingEditIds).toEqual([]);
    expect(oldDraftState?.aiDraft).toBe(true); // still required via its own ai_draft flag
  });

  it("produces a confirm_token scoped to the requested version, not reused across versions of the same document", async () => {
    mockVersions({
      "version-a": { id: "version-a", ai_draft: true },
      "version-b": { id: "version-b", ai_draft: true },
    });

    const stateA = await aiDraftConfirmationState("doc-1", fakeDb(), "version-a");
    const stateB = await aiDraftConfirmationState("doc-1", fakeDb(), "version-b");

    expect(stateA?.confirmToken).toBeDefined();
    expect(stateB?.confirmToken).toBeDefined();
    expect(stateA?.confirmToken).not.toBe(stateB?.confirmToken);
  });

  it("returns null when the requested version does not exist or does not belong to this document", async () => {
    mockVersions({ active: { id: "version-active", ai_draft: false } }); // "missing" resolves to null via the ?? null fallback

    expect(await aiDraftConfirmationState("doc-1", fakeDb(), "missing")).toBeNull();
  });

  it("refuses when the pending-edits query fails instead of treating that as none (N28)", async () => {
    mockVersions({ active: { id: "version-active", ai_draft: false } });
    const db = {
      from: (table: string) => {
        const query: Record<string, unknown> = {};
        query.select = () => query;
        query.eq = () => query;
        query.order = () => query;
        query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          table === "document_edits"
            ? Promise.resolve({
                data: null,
                error: new Error("document_edits unavailable"),
              }).then(resolve, reject)
            : Promise.resolve({ data: [], error: null }).then(resolve, reject);
        return query;
      },
    } as never;

    await expect(aiDraftConfirmationState("doc-1", db)).rejects.toThrow(
      "document_edits unavailable",
    );
  });
});
