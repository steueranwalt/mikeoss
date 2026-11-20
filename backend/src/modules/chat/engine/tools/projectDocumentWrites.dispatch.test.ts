import { beforeEach, describe, expect, it, vi } from "vitest";
// Dev drift: #295 moved this file into modules/chat/engine/tools; paths re-rooted.
import { makeFakeDb, type DbCall } from "../../../../test/helpers/fakeDb";

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
}));

vi.mock("../../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/storage")>()),
  uploadFile: uploadFileMock,
}));

import { runToolCalls } from "./toolDispatcher";
import type { DocIndex, DocStore } from "../types";

function emptyProject() {
  // Dev drift: since #295 versions are created by the create_document_version
  // RPC, which assigns the version number.
  return makeFakeDb((call: DbCall) =>
    call.op === "rpc" && call.table === "create_document_version"
      ? { data: { version_number: 1 } }
      : { data: [] },
  );
}

// A project with one existing write_project_document-authored document, so
// a second write to the same filename hits the N11/N18 approval path.
function projectWithExistingDocument() {
  return makeFakeDb((call: DbCall) => {
    if (call.table === "documents" && call.op === "select") {
      return { data: [{ id: "doc-existing", current_version_id: "version-existing" }] };
    }
    if (call.table === "document_versions" && call.op === "select") {
      return {
        data: [
          {
            id: "version-existing",
            document_id: "doc-existing",
            filename: "cites.json",
            source: "tool_write",
            version_number: 1,
          },
        ],
      };
    }
    return { data: [] };
  });
}

function call(filename: string, content: string) {
  return {
    id: "write-1",
    function: {
      name: "write_project_document",
      arguments: JSON.stringify({ filename, content }),
    },
  };
}

async function dispatch(
  toolCall: ReturnType<typeof call>,
  options?: { projectId?: string | null },
) {
  const { db, calls } = emptyProject();
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};
  const events: string[] = [];
  const result = await runToolCalls(
    [toolCall],
    docStore,
    "user-1",
    db as never,
    (chunk) => events.push(chunk),
    undefined,
    undefined,
    docIndex,
    undefined,
    undefined,
    options && "projectId" in options ? options.projectId : "project-1",
  );
  const payload = JSON.parse(
    String((result.toolResults[0] as { content: string }).content),
  );
  return { payload, events, docStore, docIndex, result, calls };
}

// Gate B4 audit finding N18: runs write_project_document against a database
// seeded with an existing same-named document, with connectorApprovals on,
// so the overwrite takes the approval path instead of refusing outright.
async function dispatchOverwrite(toolCall: ReturnType<typeof call>) {
  const { db } = projectWithExistingDocument();
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};
  const result = await runToolCalls(
    [toolCall],
    docStore,
    "user-1",
    db as never,
    () => {},
    undefined,
    undefined,
    docIndex,
    undefined,
    undefined,
    "project-1",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { connectorApprovals: true },
  );
  return result;
}

beforeEach(() => {
  uploadFileMock.mockReset().mockResolvedValue(undefined);
});

describe("write_project_document dispatch", () => {
  it("registers the written document so the assistant can read it back", async () => {
    const { payload, events, docStore, docIndex, result } = await dispatch(
      call("cites.json", '{"cites": []}'),
    );

    expect(payload).toMatchObject({
      ok: true,
      created: "new",
      filename: "cites.json",
      bytes: 13,
      doc_id: "doc-0",
      download_url: expect.stringMatching(/^\/download\//),
    });
    // The model gets a download link but never the storage key behind it.
    expect(payload).not.toHaveProperty("storage_path");
    expect(docIndex["doc-0"]).toMatchObject({
      document_id: payload.document_id,
      filename: "cites.json",
    });
    expect(docStore.get("doc-0")).toMatchObject({ file_type: "json" });
    expect(events.join("")).toContain('"doc_created_start"');
    expect(result.docsCreated).toEqual([
      expect.objectContaining({ filename: "cites.json", version_number: 1 }),
    ]);
  });

  it("reports a refusal to the model without announcing a document", async () => {
    const { payload, events, docIndex } = await dispatch(
      call("cites.json", "{}"),
      { projectId: null },
    );

    expect(payload).toMatchObject({ ok: false, error: "no_active_project" });
    expect(events).toEqual([]);
    expect(docIndex).toEqual({});
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  // Gate B4 audit finding N18: the approval binding pins the active version
  // the overwrite request saw, the same stale-review guard edit_document's
  // binding uses (Gate B4 audit finding N13).
  it("pins the active version_id in the overwrite approval binding", async () => {
    const result = await dispatchOverwrite(call("cites.json", '{"cites": [1]}'));

    expect(result.askInputsEvents).toHaveLength(1);
    const item = result.askInputsEvents[0].items[0] as {
      binding?: { type: string; document_id: string; version_id: string };
    };
    expect(item.binding).toMatchObject({
      type: "document_overwrite",
      document_id: "doc-existing",
      version_id: "version-existing",
    });
  });
});
