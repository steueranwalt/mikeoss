/** Top-level notice on data exports and traces that contain AI drafts. */
export const AI_DRAFT_NOTICE = "Enthält KI-Entwürfe, nicht freigegeben";

export function withAiDraftFlag<T extends Record<string, unknown>>(
    row: T,
    draft = true,
): T & { ai_draft: boolean } {
    return { ...row, ai_draft: draft || row.ai_draft === true };
}

export function withAiDraftFlags(
    rows: Record<string, unknown>[],
    draft = true,
): Record<string, unknown>[] {
    return rows.map((row) => withAiDraftFlag(row, draft));
}
