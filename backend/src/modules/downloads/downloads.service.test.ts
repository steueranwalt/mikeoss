import { beforeEach, describe, expect, it, vi } from "vitest";
import { signDownload } from "../../lib/downloadTokens";
import { resolveTokenDownload } from "./downloads.service";

const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  downloadFile: vi.fn(),
  loadActiveVersion: vi.fn(),
  stampAiDraftWatermark: vi.fn(),
}));

vi.mock("../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
}));

vi.mock("../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
}));

vi.mock("../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));

vi.mock("../../lib/docxAiDraftWatermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/docxAiDraftWatermark")>()),
  stampAiDraftWatermark: mocks.stampAiDraftWatermark,
}));

// Gate B4 audit finding N4: how many pending document_edits rows the
// confirmation check sees. 0 by default.
let pendingEditsCount = 0;

const database = {
  from: vi.fn((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "is"]) {
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
    query.maybeSingle = vi.fn(async () => ({
      data: {
        id: "version-1",
        document_id: "document-1",
        file_type: "docx",
      },
      error: null,
    }));
    if (table === "document_edits") {
      const rows = Array.from({ length: pendingEditsCount }, (_, i) => ({
        id: `edit-${i + 1}`,
      }));
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve);
    }
    return query;
  }),
};

describe("resolveTokenDownload (Gate B4 audit finding N4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingEditsCount = 0;
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      ai_draft: false,
    });
    mocks.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  const token = signDownload("documents/user-1/document-1/source.docx", "brief.docx");

  it("serves the file unchanged when nothing needs confirmation", async () => {
    const result = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toEqual(Buffer.from([1, 2, 3]));
    }
    expect(mocks.stampAiDraftWatermark).not.toHaveBeenCalled();
  });

  it("refuses a never-expiring token with 409 when the document has an unapproved AI draft", async () => {
    mocks.loadActiveVersion.mockResolvedValue({ id: "version-1", ai_draft: true });

    const result = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "confirmation_required") {
      expect(result.body.code).toBe("unresolved_ai_edits");
      expect(result.body.confirm_token).toMatch(/^[0-9a-f]{64}$/);
    } else {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
    }
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("serves a stamped copy once the caller confirms an AI draft", async () => {
    mocks.loadActiveVersion.mockResolvedValue({ id: "version-1", ai_draft: true });
    mocks.stampAiDraftWatermark.mockResolvedValue(Buffer.from("stamped"));

    const refusal = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
    });
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error("expected the first call to require confirmation");
    }
    const confirmToken = refusal.body.confirm_token;

    const result = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
      confirmToken,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toEqual(Buffer.from("stamped"));
    }
    expect(mocks.stampAiDraftWatermark).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
  });

  it("rejects a confirm_token computed before a new pending edit landed", async () => {
    mocks.loadActiveVersion.mockResolvedValue({ id: "version-1", ai_draft: true });

    const refusal = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
    });
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error("expected the first call to require confirmation");
    }
    const staleToken = refusal.body.confirm_token;
    pendingEditsCount = 1; // a new edit landed after the token was computed

    const result = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
      confirmToken: staleToken,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "confirmation_required") {
      expect(result.body.confirm_token).not.toBe(staleToken);
    } else {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
    }
  });

  it("refuses with 409 rather than serving unstamped when stamping fails", async () => {
    mocks.loadActiveVersion.mockResolvedValue({ id: "version-1", ai_draft: true });
    mocks.stampAiDraftWatermark.mockRejectedValue(new Error("boom"));

    const refusal = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
    });
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error("expected the first call to require confirmation");
    }
    const confirmToken = refusal.body.confirm_token;

    const result = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
      confirmToken,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "stamping_failed") {
      expect(result.detail).toContain("could not be stamped");
    } else {
      throw new Error(`expected stamping_failed, got ${JSON.stringify(result)}`);
    }
  });

  // Gate B4 audit finding N15: this token was minted against the exact
  // storage_path resolved to version-1 above — the confirmation check must
  // look at version-1's own state, not whatever the document's current
  // active version happens to be (a later version could have moved on).
  it("checks the resolved version itself, not the document's current active version", async () => {
    mocks.loadActiveVersion.mockImplementation(async (_documentId: string, _db: unknown, versionId?: string | null) =>
      versionId === "version-1"
        ? { id: "version-1", ai_draft: true } // the token's own version is still an unapproved draft
        : { id: "version-2", ai_draft: false }, // a newer, clean version is meanwhile active
    );

    const result = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "confirmation_required") {
      expect(result.body.version_id).toBe("version-1");
    } else {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(result)}`);
    }
    expect(mocks.loadActiveVersion).toHaveBeenCalledWith("document-1", database, "version-1");
  });

  it("serves an old, clean version's bytes unconfirmed even while the document's current active version is a draft", async () => {
    mocks.loadActiveVersion.mockImplementation(async (_documentId: string, _db: unknown, versionId?: string | null) =>
      versionId === "version-1"
        ? { id: "version-1", ai_draft: false } // the token's own version was never a draft
        : { id: "version-2", ai_draft: true }, // a newer version is meanwhile an unapproved draft
    );

    const result = await resolveTokenDownload(database as never, {
      token,
      userId: "user-1",
      userEmail: "user@example.com",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toEqual(Buffer.from([1, 2, 3]));
    }
    expect(mocks.stampAiDraftWatermark).not.toHaveBeenCalled();
  });
});
