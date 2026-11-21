import { describe, expect, it } from "vitest";
import {
    consumePreviewTicket,
    expirePreviewTicketForTests,
    mintPreviewTicket,
    resetPreviewTicketsForTests,
} from "../documents.previewTickets";

describe("preview tickets (N41)", () => {
    it("is single-use, bound, and expired tickets do not return a claim", () => {
        resetPreviewTicketsForTests();
        const ticket = mintPreviewTicket({
            userId: "user-1",
            documentId: "document-1",
            versionId: "version-1",
            editId: "edit-1",
        });
        const claim = consumePreviewTicket(ticket);
        expect(claim).toMatchObject({
            userId: "user-1",
            documentId: "document-1",
            versionId: "version-1",
            editId: "edit-1",
        });
        expect(consumePreviewTicket(ticket)).toBeNull();

        const expired = mintPreviewTicket({
            userId: "user-1",
            documentId: "document-1",
            versionId: "version-1",
            editId: "edit-1",
        });
        expirePreviewTicketForTests(expired);
        expect(consumePreviewTicket(expired)).toBeNull();
    });
});
