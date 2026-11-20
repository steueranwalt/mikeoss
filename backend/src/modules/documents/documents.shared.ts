import { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "./documents.cleanupJobs";
// Shared types and helpers for the documents module's service files.
// Everything public here is re-exported through documents.service.ts,
// which remains the module's stable facade.

import type { Db } from "../../lib/supabase";
import { listFiles, deleteFilesBestEffort } from "../../lib/storage";
import { reportError } from "../../lib/observability/sentry";
export type { Db };

/**
 * Gate B4 audit finding N22: a confirmed .docx/.pdf download of an AI draft
 * signs a throwaway stamped copy under this prefix (documents.download.ts's
 * getDownloadUrl) rather than the original object. Each copy also schedules
 * its own delayed cleanup job, but that is a best-effort schedule, not a
 * guarantee — deleting the document itself must not leave orphans behind
 * waiting on a job that a since-deleted document can no longer be the
 * subject of. No document_versions row references these keys (they are
 * stamped copies, not versions), so the per-version cleanup below never
 * reaches them; only this prefix sweep does.
 */
async function deleteStampedAiDraftCopies(documentId: string): Promise<void> {
    try {
        const keys = await listFiles(`exports/ai-draft-stamped/${documentId}/`);
        if (keys.length) await deleteFilesBestEffort(keys, "document-delete-ai-draft-stamped-copies");
    } catch (error) {
        // Best-effort: the document itself is already deleted by the time
        // this runs, and each copy's own delayed cleanup job (Gate B4 audit
        // finding N22) is still scheduled regardless of this sweep's outcome.
        reportError(error, { tags: { component: "documents", operation: "documents.ai_draft_stamp_cleanup_on_delete" } });
    }
}

/** Trusted internal delete: callers must establish document access first.
 * Cascading version triggers capture all cleanup keys before rows disappear. */
export async function deleteDocumentAndVersionFiles(db: Db, documentId: string) {
    const keys = await captureInlineDocumentCleanup(db, { documentIds: [documentId] });
    const result = await db.from("documents").delete().eq("id", documentId);
    if (!result.error) {
        await completeInlineDocumentCleanup(db, keys);
        await deleteStampedAiDraftCopies(documentId);
    }
    return result;
}

// Produce the filename a download should present to the user. The helper now
// lives in lib/documentVersions (the "documents-zip" export job names its zip
// entries with it too); re-exported here so this module's importers keep the
// same surface.
export { downloadFilenameForVersion } from "../../lib/documentVersions";
