import { createHash, randomBytes } from "node:crypto";

/** Browser preview fetches this header; never put the ticket in the URL. */
export const PREVIEW_TICKET_HEADER = "x-mike-preview-ticket";
export const PREVIEW_TICKET_TTL_MS = 60_000;

export type PreviewTicketClaim = {
    userId: string;
    documentId: string;
    versionId: string;
    editId: string;
    expiresAt: number;
};

const tickets = new Map<string, PreviewTicketClaim>();

function hashTicket(ticket: string): string {
    return createHash("sha256").update(ticket, "utf8").digest("hex");
}

export function mintPreviewTicket(
    claim: Omit<PreviewTicketClaim, "expiresAt">,
    now = Date.now(),
): string {
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(hashTicket(ticket), {
        ...claim,
        expiresAt: now + PREVIEW_TICKET_TTL_MS,
    });
    return ticket;
}

/** Consume once. Expired, unknown, and already-used tickets all return null. */
export function consumePreviewTicket(
    ticket: string,
    now = Date.now(),
): PreviewTicketClaim | null {
    const key = hashTicket(ticket);
    const record = tickets.get(key);
    if (!record) return null;
    tickets.delete(key);
    if (record.expiresAt <= now) return null;
    return record;
}

export function expirePreviewTicketForTests(ticket: string): void {
    const record = tickets.get(hashTicket(ticket));
    if (record) record.expiresAt = 0;
}

export function resetPreviewTicketsForTests(): void {
    tickets.clear();
}
