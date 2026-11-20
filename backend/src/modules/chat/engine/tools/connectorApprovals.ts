import { teamOrgIdOf } from "../../../../lib/personalOrgs";
// Connector write approvals inside the assistant turn.
//
// A connector whose "Ask for permission for write actions" setting is on does
// not run a write tool when the model calls it. The dispatcher turns the call
// into an `approval` item on an ask_inputs event and the turn pauses, exactly
// like a question. The user's decision arrives as an ask_inputs_response; the
// same one-step append that makes answers single-use records it, and only
// after that append succeeds does `runApprovedConnectorActions` run the
// approved items — from the persisted event, never from the client — and
// append their results to the same assistant message.
import type {
  AskInputsEvent,
  AskInputResponseItem,
  ConnectorApprovalItem,
  McpToolEvent,
} from "@mike/contracts";
import type { Db } from "../../../../lib/supabase";
import type { ConnectorOwner } from "../../../../lib/connectorOwner";
import type { ConnectorCallPlan } from "../../../../lib/mcp/types";
import {
  planGoogleDriveCall,
  executeApprovedGoogleDriveCall,
} from "../../../../lib/integrations/googleDrive";
import {
  executeApprovedMcpToolCall,
  planMcpToolCall,
} from "../../../../lib/mcpConnectors";
import {
  executeApprovedGoogleWorkspaceCall,
  isGoogleWorkspaceTool,
  planGoogleWorkspaceCall,
} from "../../../../lib/integrations/googleWorkspace";
import {
  appendSettledAssistantEvents,
  loadAssistantMessage,
} from "../contextBuilders";
import { TOOL_ERROR_MESSAGE } from "../types";
import { applyTrackedEditsToDocument } from "../../../documents/documents.service";
import type { EditInput } from "../../../../lib/docxTrackedChanges";

/** Tool output replayed to the model after an approved call, per call. */
export const MAX_APPROVAL_RESULT_CHARS = 4_000;

/** All writable connectors share the same assistant approval flow. */
export async function planConnectorToolCall(
  owner: ConnectorOwner,
  name: string,
  args: Record<string, unknown>,
  db: Db,
): Promise<ConnectorCallPlan> {
  if (name.startsWith("google_drive_"))
    return planGoogleDriveCall(owner, name, args, db);
  if (isGoogleWorkspaceTool(name))
    return planGoogleWorkspaceCall(owner, name, args, db);
  if (name.startsWith("mcp_")) return planMcpToolCall(owner, name, args, db);
  return { type: "run" };
}

export const APPROVAL_UNAVAILABLE_MESSAGE =
  'This connector asks for permission before write actions, and approvals are only available in the Mike assistant. Tell the user to run this from the Mike assistant, or to turn off "Ask for permission for write actions" for this connector in Settings → Connectors.';

function isApprovalItem(
  item: AskInputsEvent["items"][number],
): item is ConnectorApprovalItem {
  return item.kind === "approval";
}

/**
 * Gate B4 audit finding L4: runs an approved edit_document call, replaying
 * the exact edits the user reviewed (item.arguments.edits) — never a fresh
 * read of whatever the model might ask for now. This is the only place an
 * approved document edit actually touches the document; until this runs,
 * nothing proposed by edit_document has changed anything.
 *
 * Unlike the live-turn edit_document path, this runs after the original
 * streaming turn has ended, so there is no turnEditState/docIndex to update
 * and no in-turn version reuse: multiple edits to the same document
 * approved together each produce their own version, not one collapsed
 * version. The result is reported as a generic connector-style event
 * (writeApprovedConnectorFrames), not the richer live "doc_edited" card.
 */
async function executeApprovedDocumentEdit(
  item: ConnectorApprovalItem & {
    binding: Extract<ConnectorApprovalItem["binding"], { type: "document_edit" }>;
  },
  userId: string,
  db: Db,
): Promise<{ content: string; event: McpToolEvent }> {
  const baseEvent = {
    type: "mcp_tool_call" as const,
    connector_id: "",
    connector_name: item.connector_name,
    tool_name: item.tool_name,
    openai_tool_name: item.tool_name,
  };
  const rawEdits = Array.isArray((item.arguments as { edits?: unknown }).edits)
    ? ((item.arguments as { edits: unknown[] }).edits as Record<string, unknown>[])
    : [];
  const edits: EditInput[] = rawEdits.map((e) => ({
    find: String(e.find ?? ""),
    replace: String(e.replace ?? ""),
    context_before: String(e.context_before ?? ""),
    context_after: String(e.context_after ?? ""),
    reason: e.reason ? String(e.reason) : undefined,
  }));
  if (!edits.length) {
    return {
      content: JSON.stringify({ ok: false, error: "No edits to apply." }),
      event: { ...baseEvent, status: "error", error: "No edits to apply." },
    };
  }
  const result = await applyTrackedEditsToDocument({
    documentId: item.binding.document_id,
    userId,
    // See module comment on runApprovedConnectorActions: no caller passes an
    // email through this path, so only creator/organization document access
    // applies here, not an email-direct grant.
    userEmail: null,
    edits,
    db,
  });
  if (!result.ok) {
    return {
      content: JSON.stringify({ ok: false, error: result.error }),
      event: { ...baseEvent, status: "error", error: result.error },
    };
  }
  return {
    content: JSON.stringify({
      ok: true,
      document_id: item.binding.document_id,
      version_id: result.version_id,
      version_number: result.version_number,
      download_url: result.download_url,
      applied: result.annotations.length,
      errors: result.errors,
    }),
    event: { ...baseEvent, status: "ok" },
  };
}

/**
 * One pause carries every pending decision: approvals join the model's own
 * questions when it asked any in the same step.
 */
export function addApprovalItems(
  askInputsEvents: AskInputsEvent[],
  items: ConnectorApprovalItem[],
): void {
  if (items.length === 0) return;
  if (askInputsEvents.length > 0) {
    askInputsEvents[0] = {
      ...askInputsEvents[0],
      items: [...askInputsEvents[0].items, ...items],
    };
  } else {
    askInputsEvents.push({
      type: "ask_inputs",
      event_id: crypto.randomUUID(),
      items,
    });
  }
}

/**
 * Runs the items the user approved in a just-appended ask_inputs_response and
 * appends their results. Call only after the append reported "appended": that
 * append is what guarantees each approval runs at most once.
 */
export async function runApprovedConnectorActions(args: {
  db: Db;
  chatId: string;
  messageId: string;
  askEventId: string;
  userId: string;
  orgId?: string | null;
}): Promise<McpToolEvent[]> {
  const { db, chatId, messageId, askEventId, userId } = args;
  const row = await loadAssistantMessage(db, chatId, messageId);
  const content = Array.isArray(row?.content)
    ? (row.content as Record<string, unknown>[])
    : [];
  const ask = content.find(
    (event) => event?.type === "ask_inputs" && event.event_id === askEventId,
  ) as AskInputsEvent | undefined;
  const response = content.find(
    (event) =>
      event?.type === "ask_inputs_response" &&
      event.ask_event_id === askEventId,
  ) as { responses?: AskInputResponseItem[] } | undefined;
  if (!ask || !response?.responses) return [];

  const approved = new Set(
    response.responses
      .filter((item) => item.kind === "approval" && item.decision === "approve")
      .map((item) => item.id),
  );
  // An approval runs on the connections of the conversation's workspace,
  // as the call it reviews would have; its binding pins the exact connector
  // and grant, so one replaced or removed since is refused.
  const owner: ConnectorOwner = {
    userId,
    orgId: await teamOrgIdOf(db, args.orgId),
  };
  const events: McpToolEvent[] = [];
  for (const item of ask.items.filter(isApprovalItem)) {
    if (!approved.has(item.id)) continue;
    const { content: result, event } =
      item.binding.type === "document_edit"
        ? await executeApprovedDocumentEdit(
            item as ConnectorApprovalItem & {
              binding: Extract<ConnectorApprovalItem["binding"], { type: "document_edit" }>;
            },
            userId,
            db,
          )
        : item.binding.type === "google"
        ? item.binding.provider === "google-drive"
          ? await executeApprovedGoogleDriveCall(owner, item, db)
          : await executeApprovedGoogleWorkspaceCall(owner, item, db)
        : await executeApprovedMcpToolCall(owner, item, db);
    // These events are stored and streamed outside runLLMStream, so apply its
    // rule here: the user never sees a connector's raw error text.
    events.push({
      ...event,
      ...(event.error ? { error: TOOL_ERROR_MESSAGE } : {}),
      approval_id: item.id,
      result: result.slice(0, MAX_APPROVAL_RESULT_CHARS),
    });
  }
  if (events.length) {
    // Dev (sync-log: 2ec7cfc1): no stream-run fence exists yet here; see
    // appendSettledAssistantEvents.
    await appendSettledAssistantEvents(db, chatId, messageId, userId, events);
  }
  return events;
}

/** Streams approved-action results the same way live connector calls stream. */
export function writeApprovedConnectorFrames(
  write: (chunk: string) => void,
  events: McpToolEvent[],
) {
  for (const event of events) {
    write(
      `data: ${JSON.stringify({ type: "mcp_tool_start", name: event.openai_tool_name })}\n\n`,
    );
    write(
      `data: ${JSON.stringify({
        type: "mcp_tool_result",
        name: event.openai_tool_name,
        connector_name: event.connector_name,
        tool_name: event.tool_name,
        tool_title: event.tool_title,
        status: event.status,
        error: event.error,
        approval_id: event.approval_id,
      })}\n\n`,
    );
  }
}
