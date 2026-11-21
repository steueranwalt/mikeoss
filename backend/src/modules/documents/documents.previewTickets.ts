import { createHash, randomBytes } from "node:crypto";
import { createServerSupabase, type Db } from "../../lib/supabase";

/** Browser preview fetches this header; never put the ticket in the URL. */
export const PREVIEW_TICKET_HEADER = "x-mike-preview-ticket";
export const PREVIEW_TICKET_TTL_MS = 60_000;
export const PREVIEW_TICKET_CLEANUP_INTERVAL_MS = 30_000;

export type PreviewTicketClaim = {
    userId: string;
    documentId: string;
    versionId: string;
    editId: string;
    expiresAt: number;
};

type PreviewTicketRow = {
    ticket_hash: string;
    user_id: string;
    document_id: string;
    version_id: string;
    edit_id: string;
    expires_at: string;
};

type ConsumedPreviewTicketRow = {
    user_id: string;
    document_id: string;
    version_id: string;
    edit_id: string;
};

function hashTicket(ticket: string): string {
    return createHash("sha256").update(ticket, "utf8").digest("hex");
}

async function purgeExpiredPreviewTickets(db: Db, nowIso: string): Promise<void> {
    const { error } = await db
        .from("document_preview_tickets")
        .delete()
        .lt("expires_at", nowIso);
    if (error) {
        throw new Error(error.message || "Unable to purge expired preview tickets");
    }
}

let lastPurgeAt = 0;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let cleanupDb: Db | null = null;

function ensurePreviewTicketCleanup(db: Db): void {
    cleanupDb = db;
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const handle = cleanupDb ?? createServerSupabase();
        void purgeExpiredPreviewTickets(
            handle,
            new Date().toISOString(),
        ).catch(() => {
            // Next mint or interval retries. Do not crash the process.
        });
    }, PREVIEW_TICKET_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
}

export async function mintPreviewTicket(
    claim: Omit<PreviewTicketClaim, "expiresAt">,
    db: Db = createServerSupabase(),
    now = Date.now(),
): Promise<string> {
    ensurePreviewTicketCleanup(db);
    if (now - lastPurgeAt >= 5_000) {
        lastPurgeAt = now;
        await purgeExpiredPreviewTickets(db, new Date(now).toISOString());
    }
    const ticket = randomBytes(32).toString("base64url");
    const row: PreviewTicketRow = {
        ticket_hash: hashTicket(ticket),
        user_id: claim.userId,
        document_id: claim.documentId,
        version_id: claim.versionId,
        edit_id: claim.editId,
        expires_at: new Date(now + PREVIEW_TICKET_TTL_MS).toISOString(),
    };
    const { error } = await db.from("document_preview_tickets").insert(row);
    if (error) {
        throw new Error(error.message || "Unable to mint preview ticket");
    }
    return ticket;
}

/** Consume once. Expired, unknown, and already-used tickets all return null. */
export async function consumePreviewTicket(
    ticket: string,
    db: Db = createServerSupabase(),
): Promise<PreviewTicketClaim | null> {
    const { data, error } = await db.rpc("consume_document_preview_ticket", {
        p_ticket_hash: hashTicket(ticket),
    });
    if (error) {
        throw new Error(error.message || "Unable to consume preview ticket");
    }
    const row = (Array.isArray(data) ? data[0] : data) as
        | ConsumedPreviewTicketRow
        | undefined;
    if (!row) return null;
    return {
        userId: row.user_id,
        documentId: row.document_id,
        versionId: row.version_id,
        editId: row.edit_id,
        expiresAt: 0,
    };
}

export async function expirePreviewTicketForTests(
    ticket: string,
    db: Db = createServerSupabase(),
): Promise<void> {
    await db
        .from("document_preview_tickets")
        .update({ expires_at: new Date(0).toISOString() })
        .eq("ticket_hash", hashTicket(ticket));
}

export async function resetPreviewTicketsForTests(
    db: Db = createServerSupabase(),
): Promise<void> {
    lastPurgeAt = 0;
    cleanupDb = null;
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
    await db
        .from("document_preview_tickets")
        .delete()
        .neq("ticket_hash", "");
}
