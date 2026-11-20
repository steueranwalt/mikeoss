/**
 * Gate B4 audit findings N5/N12: the body of a 409 `unresolved_ai_edits`
 * response for a single-document export. The confirm_token is sha256 of
 * `{version_id, pending_edit_ids, ai_draft}` — a stale token from before
 * the document changed cannot be replayed.
 */
export type UnresolvedAiEditsDetails = {
    confirmToken: string;
    versionId: string;
    pendingEditIds: string[];
    aiDraft: boolean;
};

function asString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const ids = value.filter((entry): entry is string => typeof entry === "string");
    return ids.length === value.length ? ids : null;
}

/** Pull the export-confirmation payload out of a 409, or null if this is some other error. */
export function unresolvedAiEditsFromError(
    error: unknown,
): UnresolvedAiEditsDetails | null {
    if (!error || typeof error !== "object") return null;
    const candidate = error as {
        status?: unknown;
        code?: unknown;
        details?: unknown;
    };
    if (candidate.status !== 409 || candidate.code !== "unresolved_ai_edits") {
        return null;
    }
    const details =
        candidate.details && typeof candidate.details === "object"
            ? (candidate.details as Record<string, unknown>)
            : null;
    if (!details) return null;
    const confirmToken = asString(details.confirm_token);
    const versionId = asString(details.version_id);
    const pendingEditIds = asStringArray(details.pending_edit_ids);
    if (!confirmToken || !versionId || !pendingEditIds) return null;
    return {
        confirmToken,
        versionId,
        pendingEditIds,
        aiDraft: details.ai_draft === true,
    };
}
