import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalItem } from "@mike/contracts";

const mocks = vi.hoisted(() => ({
  google: vi.fn(),
  mcp: vi.fn(),
  documentEdit: vi.fn(),
  writeProjectDocument: vi.fn(),
}));
vi.mock("../../../../lib/integrations/googleWorkspace", async (original) => ({
  ...(await original<
    typeof import("../../../../lib/integrations/googleWorkspace")
  >()),
  executeApprovedGoogleWorkspaceCall: mocks.google,
}));
vi.mock("../../../../lib/mcpConnectors", async (original) => ({
  ...(await original<typeof import("../../../../lib/mcpConnectors")>()),
  executeApprovedMcpToolCall: mocks.mcp,
}));
vi.mock("../../../documents/documents.trackedEdits", async (original) => ({
  ...(await original<typeof import("../../../documents/documents.trackedEdits")>()),
  applyTrackedEditsToDocument: mocks.documentEdit,
}));
vi.mock("../tools/projectDocumentWrites", async (original) => ({
  ...(await original<typeof import("../tools/projectDocumentWrites")>()),
  writeProjectDocument: mocks.writeProjectDocument,
}));

import {
  appendAskInputsResponseToAssistantMessage,
  enrichWithPriorEvents,
  parseAskInputsResponsePayload,
} from "../contextBuilders";
import {
  MAX_APPROVAL_RESULT_CHARS,
  runApprovedConnectorActions,
} from "../tools/connectorApprovals";

const gmailItem: ConnectorApprovalItem = {
  id: "approve-gmail",
  kind: "approval",
  connector_name: "Gmail",
  tool_name: "gmail_send",
  title: "Send email",
  arguments: { to: ["a@example.com"], subject: "Hi", body: "Body" },
  account: "me@example.com",
  binding: { type: "google", provider: "gmail", grant_id: "g1" },
};
const slackItem: ConnectorApprovalItem = {
  id: "approve-slack",
  kind: "approval",
  connector_name: "Slack",
  tool_name: "mcp_slack_post",
  title: "Post message",
  arguments: { channel: "general", text: "hi" },
  binding: { type: "mcp", connector_id: "c1", tool_id: "t1" },
};

/** One assistant row whose events the RPCs append to, like chat_messages. */
function messageDb(content: Record<string, unknown>[]) {
  const row = {
    id: "assistant-1",
    chat_id: "chat-1",
    role: "assistant",
    content,
    citations: null,
    author_user_id: "user-1",
    created_at: "2026-01-01T00:00:00Z",
  };
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [row], error: null }).then(resolve),
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "append_chat_ask_inputs_response")
        row.content = [...row.content, args.p_response as never];
      if (name === "append_chat_assistant_events")
        row.content = [...row.content, ...(args.p_events as never[])];
      return { data: "appended", error: null };
    },
  };
  return { db: db as never, row, rpcCalls };
}

const askEvent = {
  type: "ask_inputs",
  event_id: "ask-1",
  items: [gmailItem, slackItem],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approval responses", () => {
  it("carries only the decision from the client", () => {
    expect(
      parseAskInputsResponsePayload({
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [
          {
            id: "approve-gmail",
            kind: "approval",
            decision: "approve",
            arguments: { to: ["attacker@example.com"] },
          },
          { id: "approve-slack", kind: "approval", decision: "maybe" },
        ],
      }),
    ).toEqual({
      assistant_message_id: "assistant-1",
      ask_event_id: "ask-1",
      responses: [{ id: "approve-gmail", kind: "approval", decision: "approve" }],
    });
  });

  it("rejects a decision that does not match a pending approval item", async () => {
    const { db } = messageDb([
      {
        type: "ask_inputs",
        event_id: "ask-1",
        items: [
          { id: "q", kind: "text", question: "Why?" },
          gmailItem,
        ],
      },
    ]);
    expect(
      await appendAskInputsResponseToAssistantMessage(
        db,
        "chat-1",
        {
          assistant_message_id: "assistant-1",
          ask_event_id: "ask-1",
          responses: [
            { id: "q", kind: "approval", decision: "approve" },
            { id: "approve-gmail", kind: "approval", decision: "approve" },
          ],
        },
        "user-1",
      ),
    ).toBe("invalid");
  });
});

describe("runApprovedConnectorActions", () => {
  it("runs only approved items, from the persisted event, and appends bounded results", async () => {
    const { db, row, rpcCalls } = messageDb([askEvent]);
    expect(
      await appendAskInputsResponseToAssistantMessage(
        db,
        "chat-1",
        {
          assistant_message_id: "assistant-1",
          ask_event_id: "ask-1",
          responses: [
            { id: "approve-gmail", kind: "approval", decision: "approve" },
            { id: "approve-slack", kind: "approval", decision: "reject" },
          ],
        },
        "user-1",
      ),
    ).toBe("appended");
    mocks.google.mockResolvedValue({
      content: "x".repeat(MAX_APPROVAL_RESULT_CHARS + 50),
      event: {
        type: "mcp_tool_call",
        connector_id: "gmail-native",
        connector_name: "Gmail",
        tool_name: "gmail_send",
        openai_tool_name: "gmail_send",
        status: "ok",
        approval_id: "approve-gmail",
      },
    });

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.google).toHaveBeenCalledOnce();
    expect(mocks.google).toHaveBeenCalledWith(
      { userId: "user-1", orgId: null },
      gmailItem,
      db,
    );
    expect(mocks.mcp).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      approval_id: "approve-gmail",
      status: "ok",
    });
    expect(events[0].result).toHaveLength(MAX_APPROVAL_RESULT_CHARS);
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "append_chat_ask_inputs_response",
      "append_chat_assistant_events",
    ]);
    expect(row.content.at(-1)).toMatchObject({ approval_id: "approve-gmail" });
  });

  it("runs an approval in an organization on that workspace's connections", async () => {
    const { db } = messageDb([askEvent]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [
          { id: "approve-gmail", kind: "approval", decision: "reject" },
          { id: "approve-slack", kind: "approval", decision: "approve" },
        ],
      },
      "user-1",
    );
    mocks.mcp.mockResolvedValue({
      content: "{}",
      event: {
        type: "mcp_tool_call",
        connector_id: "c1",
        connector_name: "Slack",
        tool_name: "post",
        openai_tool_name: "mcp_slack_post",
        status: "ok",
      },
    });

    await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
      orgId: "firm",
    });

    expect(mocks.mcp).toHaveBeenCalledWith(
      { userId: "user-1", orgId: "firm" },
      slackItem,
      db,
    );
  });

  it("stores and returns a fixed message in place of a connector's raw error", async () => {
    const { db, row } = messageDb([askEvent]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [
          { id: "approve-gmail", kind: "approval", decision: "reject" },
          { id: "approve-slack", kind: "approval", decision: "approve" },
        ],
      },
      "user-1",
    );
    mocks.mcp.mockResolvedValue({
      content: "upstream said: token xoxb-secret rejected",
      event: {
        type: "mcp_tool_call",
        connector_id: "c1",
        connector_name: "Slack",
        tool_name: "post",
        openai_tool_name: "mcp_slack_post",
        status: "error",
        error: "upstream said: token xoxb-secret rejected",
      },
    });

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(events[0].error).toBe("This tool could not complete its request.");
    expect(row.content.at(-1)).toMatchObject({
      status: "error",
      error: "This tool could not complete its request.",
    });
  });

  it("runs nothing when there is no recorded decision", async () => {
    const { db } = messageDb([askEvent]);
    expect(
      await runApprovedConnectorActions({
        db,
        chatId: "chat-1",
        messageId: "assistant-1",
        askEventId: "ask-1",
        userId: "user-1",
      }),
    ).toEqual([]);
    expect(mocks.google).not.toHaveBeenCalled();
    expect(mocks.mcp).not.toHaveBeenCalled();
  });
});

// Gate B4 audit finding L4: edit_document pauses for approval the same way
// connector writes do (toolDispatcher.ts). These tests cover the other half:
// what actually happens to the document before and after that approval.
describe("edit_document approval (Gate B4 audit finding L4)", () => {
  const editItem: ConnectorApprovalItem = {
    id: "approve-edit",
    kind: "approval",
    connector_name: "Lease.docx",
    tool_name: "edit_document",
    title: 'Edit "Lease.docx"',
    arguments: {
      doc_id: "doc-0",
      edits: [
        {
          find: "ten days",
          replace: "five days",
          context_before: "within ",
          context_after: ".",
        },
      ],
    },
    binding: {
      type: "document_edit",
      document_id: "d1",
      client_doc_id: "doc-0",
      version_id: "v1",
      storage_path: "documents/u1/d1/source.docx",
    },
  };

  it("is not applied without approval: a rejected edit never reaches applyTrackedEditsToDocument", async () => {
    const { db } = messageDb([
      { type: "ask_inputs", event_id: "ask-1", items: [editItem] },
    ]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "approve-edit", kind: "approval", decision: "reject" }],
      },
      "user-1",
    );

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.documentEdit).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("is not applied while unanswered: no decision means applyTrackedEditsToDocument never runs", async () => {
    const { db } = messageDb([
      { type: "ask_inputs", event_id: "ask-1", items: [editItem] },
    ]);

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.documentEdit).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("applies the exact reviewed edits once approved", async () => {
    const { db } = messageDb([
      { type: "ask_inputs", event_id: "ask-1", items: [editItem] },
    ]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "approve-edit", kind: "approval", decision: "approve" }],
      },
      "user-1",
    );
    mocks.documentEdit.mockResolvedValue({
      ok: true,
      version_id: "v2",
      version_number: 2,
      storage_path: "documents/u1/d1/edits/v2.docx",
      download_url: "https://example.test/download/abc",
      annotations: [{ kind: "edit" }],
      errors: [],
    });

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.documentEdit).toHaveBeenCalledExactlyOnceWith({
      documentId: "d1",
      userId: "user-1",
      userEmail: null,
      edits: [
        {
          find: "ten days",
          replace: "five days",
          context_before: "within ",
          context_after: ".",
          reason: undefined,
        },
      ],
      db,
      // Gate B4 audit finding N13: pins the version the binding recorded at
      // request time, not whatever is current now.
      expectedVersion: { id: "v1", storagePath: "documents/u1/d1/source.docx" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ approval_id: "approve-edit", status: "ok" });
  });

  // Gate B4 audit finding N13.
  it("refuses a legacy approval that predates the version_id binding instead of guessing at the current version", async () => {
    const legacyEditItem: ConnectorApprovalItem = {
      ...editItem,
      binding: { type: "document_edit", document_id: "d1", client_doc_id: "doc-0" },
    };
    const { db } = messageDb([
      { type: "ask_inputs", event_id: "ask-1", items: [legacyEditItem] },
    ]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "approve-edit", kind: "approval", decision: "approve" }],
      },
      "user-1",
    );

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.documentEdit).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ approval_id: "approve-edit", status: "error" });
  });

  it("stores and returns a document-write failure instead of throwing", async () => {
    const { db } = messageDb([
      { type: "ask_inputs", event_id: "ask-1", items: [editItem] },
    ]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "approve-edit", kind: "approval", decision: "approve" }],
      },
      "user-1",
    );
    mocks.documentEdit.mockResolvedValue({
      ok: false,
      error: "This document changed. Run the review again before applying its suggestions.",
    });

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("error");
  });
});

// Gate B4 audit finding N11: write_project_document overwriting an existing
// document pauses for approval the same way edit_document does.
describe("write_project_document overwrite approval (Gate B4 audit finding N11)", () => {
  const overwriteItem: ConnectorApprovalItem = {
    id: "approve-overwrite",
    kind: "approval",
    connector_name: "cites.json",
    tool_name: "write_project_document",
    title: 'Overwrite "cites.json"',
    arguments: {
      filename: "cites.json",
      content: '{"cites": [1]}',
      project_id: "project-1",
    },
    binding: { type: "document_overwrite", document_id: "doc-existing" },
  };

  it("is not applied without approval: a rejected overwrite never reaches writeProjectDocument", async () => {
    const { db } = messageDb([
      { type: "ask_inputs", event_id: "ask-1", items: [overwriteItem] },
    ]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "approve-overwrite", kind: "approval", decision: "reject" }],
      },
      "user-1",
    );

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.writeProjectDocument).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("replays the exact reviewed filename/content once approved", async () => {
    const { db } = messageDb([
      { type: "ask_inputs", event_id: "ask-1", items: [overwriteItem] },
    ]);
    await appendAskInputsResponseToAssistantMessage(
      db,
      "chat-1",
      {
        assistant_message_id: "assistant-1",
        ask_event_id: "ask-1",
        responses: [{ id: "approve-overwrite", kind: "approval", decision: "approve" }],
      },
      "user-1",
    );
    mocks.writeProjectDocument.mockResolvedValue({
      ok: true,
      document_id: "doc-existing",
      version_id: "v2",
      filename: "cites.json",
      bytes: 13,
      created: "version",
      download_url: "/download/abc.cites.json",
      version_number: 3,
      storage_path: "documents/u1/doc-existing/versions/v2/cites.json",
    });

    const events = await runApprovedConnectorActions({
      db,
      chatId: "chat-1",
      messageId: "assistant-1",
      askEventId: "ask-1",
      userId: "user-1",
    });

    expect(mocks.writeProjectDocument).toHaveBeenCalledExactlyOnceWith(
      {
        filename: "cites.json",
        content: '{"cites": [1]}',
        userId: "user-1",
        projectId: "project-1",
        approved: true,
      },
      db,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ approval_id: "approve-overwrite", status: "ok" });
  });
});

describe("approval context replay", () => {
  it("tells the model what was approved, what ran, what was rejected, and what has no outcome", async () => {
    const calendarItem = {
      ...gmailItem,
      id: "approve-calendar",
      connector_name: "Google Calendar",
      tool_name: "google_calendar_create_event",
    };
    const { db } = messageDb([
      { ...askEvent, items: [gmailItem, slackItem, calendarItem] },
      {
        type: "ask_inputs_response",
        ask_event_id: "ask-1",
        responses: [
          { id: "approve-gmail", kind: "approval", decision: "approve" },
          { id: "approve-slack", kind: "approval", decision: "reject" },
          { id: "approve-calendar", kind: "approval", decision: "approve" },
        ],
      },
      {
        type: "mcp_tool_call",
        connector_id: "gmail-native",
        connector_name: "Gmail",
        tool_name: "gmail_send",
        openai_tool_name: "gmail_send",
        status: "ok",
        approval_id: "approve-gmail",
        result: '{"ok":true,"data":{"id":"sent-1"}}',
      },
    ]);

    const [assistant] = await enrichWithPriorEvents(
      [
        { role: "assistant", content: "I'll send that." },
        { role: "user", content: "Approved." },
      ],
      "chat-1",
      db,
      {},
      "nonce1234",
    );
    const text = assistant.content ?? "";
    expect(text).not.toContain("asked user for");
    expect(text).toMatch(/user approved .*gmail_send/s);
    expect(text).toMatch(/approved .*gmail_send.* completed; result: .*sent-1/s);
    expect(text).toMatch(/user rejected .*mcp_slack_post.*did not run/s);
    expect(text).toMatch(
      /approved .*google_calendar_create_event.* has no recorded outcome/s,
    );
    expect(text).toContain("do not retry a rejected action");
    // Connector-supplied text stays fenced as data.
    expect(text).toContain('<untrusted-content nonce="nonce1234">');
  });
});
