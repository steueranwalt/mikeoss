import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryPreviewTicketDb } from "./previewTicketMemoryDb";

const { memoryDb } = vi.hoisted(() => ({
    memoryDb: {
        current: null as unknown as ReturnType<
            typeof createMemoryPreviewTicketDb
        >,
    },
}));

vi.mock("../../../lib/supabase", () => ({
    createServerSupabase: () => memoryDb.current,
}));

import {
    consumePreviewTicket,
    expirePreviewTicketForTests,
    mintPreviewTicket,
    resetPreviewTicketsForTests,
} from "../documents.previewTickets";

describe("preview tickets (N41/N45)", () => {
    beforeEach(async () => {
        memoryDb.current = createMemoryPreviewTicketDb();
        await resetPreviewTicketsForTests(memoryDb.current as never);
    });

    it("is single-use, bound, and expired tickets do not return a claim", async () => {
        const ticket = await mintPreviewTicket({
            userId: "user-1",
            documentId: "document-1",
            versionId: "version-1",
            editId: "edit-1",
        });
        expect(
            JSON.stringify([...memoryDb.current.rows.values()]),
        ).not.toContain(ticket);
        const claim = await consumePreviewTicket(ticket);
        expect(claim).toMatchObject({
            userId: "user-1",
            documentId: "document-1",
            versionId: "version-1",
            editId: "edit-1",
        });
        expect(await consumePreviewTicket(ticket)).toBeNull();

        const expired = await mintPreviewTicket({
            userId: "user-1",
            documentId: "document-1",
            versionId: "version-1",
            editId: "edit-1",
        });
        await expirePreviewTicketForTests(expired);
        expect(await consumePreviewTicket(expired)).toBeNull();
    });
});
