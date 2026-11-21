import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  loadActiveVersion: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  getSignedUrl: vi.fn(),
  headFile: vi.fn(),
  enqueueDbJob: vi.fn(),
}));

vi.mock("../../../lib/dbq/enqueue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/dbq/enqueue")>()),
  enqueueDbJob: mocks.enqueueDbJob,
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
  uploadFile: mocks.uploadFile,
  getSignedUrl: mocks.getSignedUrl,
  headFile: mocks.headFile,
}));

import { getDownloadUrl } from "../documents.download";

// Gate B4 audit finding N4/N15: one pending-edit row, keyed by version_id.
let pendingEditsCount = 0;

function database() {
  return {
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "in"]) query[method] = () => query;
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

describe("getDownloadUrl (Gate B4 audit finding N16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingEditsCount = 1;
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.getSignedUrl.mockResolvedValue("https://example.test/signed");
    mocks.uploadFile.mockResolvedValue(undefined);
    mocks.enqueueDbJob.mockResolvedValue({ id: "job-1", deduped: false });
  });

  it("signs a stamped throwaway copy for a confirmed PDF, never the original object", async () => {
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
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const original = Buffer.from(await pdf.save());
    mocks.downloadFile.mockResolvedValue(original);

    const refusal = await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database());
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(refusal)}`);
    }
    const confirmToken = refusal.state.confirmToken;

    const result = await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database(), confirmToken);

    expect(result.ok).toBe(true);
    const [signedPath] = mocks.uploadFile.mock.calls[0];
    expect(signedPath).toMatch(/^exports\/ai-draft-stamped\/doc-1\/.*\.pdf$/);
    expect(mocks.getSignedUrl).toHaveBeenCalledWith(signedPath, 600, expect.anything());
  });

  // Gate B4 audit finding N22.
  it("schedules a delayed cleanup job for the stamped throwaway copy", async () => {
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
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    mocks.downloadFile.mockResolvedValue(Buffer.from(await pdf.save()));

    const refusal = await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database());
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(refusal)}`);
    }

    const before = Date.now();
    await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database(), refusal.state.confirmToken);

    expect(mocks.enqueueDbJob).toHaveBeenCalledOnce();
    const [, enqueueArgs] = mocks.enqueueDbJob.mock.calls[0];
    expect(enqueueArgs).toMatchObject({
      kind: "storage.cleanup",
      payload: { keys: [mocks.uploadFile.mock.calls[0][0]] },
    });
    const runAtMs = new Date(enqueueArgs.runAt as string).getTime();
    expect(runAtMs).toBeGreaterThan(before + 3500 * 1000); // ~1 hour out, comfortably past the signed-URL TTL
  });

  it("does not let a cleanup-scheduling failure break the download itself", async () => {
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
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    mocks.downloadFile.mockResolvedValue(Buffer.from(await pdf.save()));
    mocks.enqueueDbJob.mockRejectedValue(new Error("db unavailable"));

    const refusal = await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database());
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(refusal)}`);
    }

    const result = await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database(), refusal.state.confirmToken);

    expect(result.ok).toBe(true);
  });

  it("refuses with stamping_failed rather than signing the original when PDF stamping fails", async () => {
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
    mocks.downloadFile.mockResolvedValue(Buffer.from("not a real pdf"));

    const refusal = await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database());
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(refusal)}`);
    }

    const result = await getDownloadUrl(
      "doc-1",
      "user-1",
      "u@example.com",
      null,
      database(),
      refusal.state.confirmToken,
    );

    expect(result).toMatchObject({ ok: false, kind: "stamping_failed" });
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  it("signs the original object unchanged, with a [KI-ENTWURF]-prefixed filename, for a confirmed xlsx", async () => {
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

    const refusal = await getDownloadUrl("doc-1", "user-1", "u@example.com", null, database());
    if (refusal.ok || refusal.kind !== "confirmation_required") {
      throw new Error(`expected confirmation_required, got ${JSON.stringify(refusal)}`);
    }

    const result = await getDownloadUrl(
      "doc-1",
      "user-1",
      "u@example.com",
      null,
      database(),
      refusal.state.confirmToken,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.filename).toBe("[KI-ENTWURF] financials.xlsx");
    }
    expect(mocks.uploadFile).not.toHaveBeenCalled(); // original object signed, not a stamped copy
    expect(mocks.getSignedUrl).toHaveBeenCalledWith(
      "documents/user-1/doc-1/source.xlsx",
      3600,
      "[KI-ENTWURF] financials.xlsx",
    );
  });
});
