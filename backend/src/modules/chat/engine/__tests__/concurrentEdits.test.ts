// Dev drift: the shared document lock is in options after the three Dev-specific dispatcher slots.
import { expect, it, vi } from "vitest";
import type { Db } from "../../../../lib/supabase";

const { runEditDocument } = vi.hoisted(() => ({ runEditDocument: vi.fn() }));
vi.mock("../tools/documentOps", async (original) => ({
  ...(await original<typeof import("../tools/documentOps")>()),
  runEditDocument,
}));

// Gate B4 audit finding N13: the approval binding now pins the active
// version at request time, so edit_document's approval path reads it even
// though it never applies anything inline. A loose, order-independent fake
// (not scriptedDb's strict one) because two concurrent edit_document calls
// each read it once, in an order this test does not control.
function fakeActiveVersionDb(): Db {
  return {
    from: (table: string) => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        single: async () =>
          table === "documents"
            ? { data: { current_version_id: "v1" }, error: null }
            : { data: { id: "v1", document_id: "d1", storage_path: "doc-0-v1" }, error: null },
      };
      return builder;
    },
  } as never;
}

import { scriptedDb } from "../../../../__tests__/helpers/scriptedDb";
import { createKeyedLock } from "../tools/documentLocks";
import { getTurnReadIdentity } from "../tools/documentOps";
import { runToolCalls } from "../tools/toolDispatcher";

// Gate B4 audit finding L4: edit_document now always pauses for the user's
// approval (see connectorApprovals.ts's executeApprovedDocumentEdit) instead
// of running inline, so two concurrent edit_document calls in one turn no
// longer race to land on top of each other via documentLocks/turnEditState's
// in-turn version reuse — neither one runs at all within the turn. This test
// now covers that: both become their own pending approval item, and
// runEditDocument (the pre-L4 inline path) is never reached.
it("queues two concurrent edit_document calls as separate approvals instead of running either inline", async () => {
  const docStore = new Map([["doc-0", { filename: "Lease.docx", file_type: "docx" }]]) as never;
  const docIndex = { "doc-0": { document_id: "d1", version_id: "v1", version_number: 1 } } as never;
  const turnEditState = new Map();
  const documentLocks = createKeyedLock();
  const edit = (id: string) =>
    runToolCalls(
      [
        {
          id,
          function: {
            name: "edit_document",
            arguments: JSON.stringify({ doc_id: "doc-0", edits: [{ find: id, replace: "x" }] }),
          },
        },
      ],
      docStore,
      "u1",
      fakeActiveVersionDb(),
      vi.fn(),
      undefined,
      undefined,
      docIndex,
      turnEditState,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { documentLocks, connectorApprovals: true },
    );

  const [firstResult, secondResult] = await Promise.all([
    edit("first"),
    edit("second"),
  ]);

  expect(runEditDocument).not.toHaveBeenCalled();
  const approvalItemOf = (result: Awaited<ReturnType<typeof edit>>) => {
    const event = result.askInputsEvents[0];
    expect(event?.items).toHaveLength(1);
    return event.items[0] as { id: string; kind: string; binding?: unknown };
  };
  const firstItem = approvalItemOf(firstResult);
  const secondItem = approvalItemOf(secondResult);
  expect(firstItem.kind).toBe("approval");
  expect(firstItem.binding).toMatchObject({
    type: "document_edit",
    document_id: "d1",
    version_id: "v1",
    storage_path: "doc-0-v1",
  });
  expect(firstItem.id).not.toBe(secondItem.id);
});

it("reads a document again once another edit moves its reused version to a new file", async () => {
  const activeVersion = (storage_path: string) => [
    { table: "documents", data: { current_version_id: "v2" } },
    { table: "document_versions", data: { id: "v2", document_id: "d1", version_number: 2, storage_path } },
  ];
  const { db } = scriptedDb([...activeVersion("edit-1"), ...activeVersion("edit-2")]);
  const readKey = async () =>
    (await getTurnReadIdentity({
      docLabel: "doc-0",
      docStore: new Map([["doc-0", { filename: "Lease.docx", file_type: "docx", storage_path: "edit-1" }]]),
      docIndex: { "doc-0": { document_id: "d1", version_id: "v2", version_number: 2 } } as never,
      db,
    }))?.key;

  expect(await readKey()).not.toBe(await readKey());
});
