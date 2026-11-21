export type MemoryPreviewTicketRow = {
    ticket_hash: string;
    user_id: string;
    document_id: string;
    version_id: string;
    edit_id: string;
    expires_at: string;
};

/** In-memory stand-in for PostgREST insert / DELETE RETURNING consume. */
export function createMemoryPreviewTicketDb() {
    const rows = new Map<string, MemoryPreviewTicketRow>();
    return {
        from(table: string) {
            if (table !== "document_preview_tickets") {
                throw new Error(`unexpected table ${table}`);
            }
            return {
                insert: async (row: MemoryPreviewTicketRow) => {
                    rows.set(row.ticket_hash, { ...row });
                    return { error: null };
                },
                delete: () => ({
                    lt: async (column: string, value: string) => {
                        for (const [hash, row] of rows) {
                            if (column === "expires_at" && row.expires_at < value) {
                                rows.delete(hash);
                            }
                        }
                        return { error: null };
                    },
                    neq: async (column: string, value: string) => {
                        for (const [hash, row] of [...rows]) {
                            const current =
                                column === "ticket_hash" ? row.ticket_hash : "";
                            if (current !== value) rows.delete(hash);
                        }
                        return { error: null };
                    },
                }),
                update: (patch: Partial<MemoryPreviewTicketRow>) => ({
                    eq: async (column: string, value: string) => {
                        if (column !== "ticket_hash") return { error: null };
                        const row = rows.get(value);
                        if (row) Object.assign(row, patch);
                        return { error: null };
                    },
                }),
            };
        },
        rpc: async (
            name: string,
            args: { p_ticket_hash: string },
        ) => {
            if (name !== "consume_document_preview_ticket") {
                return {
                    data: null,
                    error: { message: `unexpected rpc ${name}` },
                };
            }
            const row = rows.get(args.p_ticket_hash);
            if (!row || Date.parse(row.expires_at) <= Date.now()) {
                return { data: [], error: null };
            }
            rows.delete(args.p_ticket_hash);
            return {
                data: [
                    {
                        user_id: row.user_id,
                        document_id: row.document_id,
                        version_id: row.version_id,
                        edit_id: row.edit_id,
                    },
                ],
                error: null,
            };
        },
        rows,
    };
}
