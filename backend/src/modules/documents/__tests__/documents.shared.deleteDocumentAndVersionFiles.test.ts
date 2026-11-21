import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureInlineDocumentCleanup: vi.fn(),
  completeInlineDocumentCleanup: vi.fn(),
  listFiles: vi.fn(),
  deleteFilesBestEffort: vi.fn(),
}));

vi.mock("../documents.cleanupJobs", () => ({
  captureInlineDocumentCleanup: mocks.captureInlineDocumentCleanup,
  completeInlineDocumentCleanup: mocks.completeInlineDocumentCleanup,
}));

vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  listFiles: mocks.listFiles,
  deleteFilesBestEffort: mocks.deleteFilesBestEffort,
}));

import { deleteDocumentAndVersionFiles } from "../documents.shared";

function fakeDb(deleteError: unknown = null) {
  return {
    from: (_table: string) => ({
      delete: () => ({
        eq: async () => ({ error: deleteError }),
      }),
    }),
  } as never;
}

describe("deleteDocumentAndVersionFiles (Gate B4 audit finding N22)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureInlineDocumentCleanup.mockResolvedValue([]);
    mocks.completeInlineDocumentCleanup.mockResolvedValue(undefined);
  });

  it("sweeps the document's exports/ai-draft-stamped/ prefix once the row is deleted", async () => {
    mocks.listFiles.mockResolvedValue([
      "exports/ai-draft-stamped/doc-1/abc.docx",
      "exports/ai-draft-stamped/doc-1/def.pdf",
    ]);

    await deleteDocumentAndVersionFiles(fakeDb(), "doc-1");

    expect(mocks.listFiles).toHaveBeenCalledWith("exports/ai-draft-stamped/doc-1/");
    expect(mocks.deleteFilesBestEffort).toHaveBeenCalledWith(
      ["exports/ai-draft-stamped/doc-1/abc.docx", "exports/ai-draft-stamped/doc-1/def.pdf"],
      expect.any(String),
    );
  });

  it("does not sweep when the document never had any stamped copies", async () => {
    mocks.listFiles.mockResolvedValue([]);

    await deleteDocumentAndVersionFiles(fakeDb(), "doc-1");

    expect(mocks.deleteFilesBestEffort).not.toHaveBeenCalled();
  });

  it("does not sweep stamped copies when the document delete itself fails", async () => {
    await deleteDocumentAndVersionFiles(fakeDb({ message: "delete failed" }), "doc-1");

    expect(mocks.listFiles).not.toHaveBeenCalled();
    expect(mocks.completeInlineDocumentCleanup).not.toHaveBeenCalled();
  });

  it("does not let a storage listing failure break the delete's own result", async () => {
    mocks.listFiles.mockRejectedValue(new Error("storage unavailable"));

    const result = await deleteDocumentAndVersionFiles(fakeDb(), "doc-1");

    expect(result.error).toBeNull();
  });
});
