import type { PanelDocument } from "../shared/types";
import {
    getDocumentAiStatus,
    listDocumentVersions,
    MikeApiError,
    type DocumentVersion,
} from "@/app/lib/mikeApi";

type VersionList = {
    current_version_id: string | null;
    versions: DocumentVersion[];
};

/**
 * Why this has three answers instead of two.
 *
 * A chat can be shared without its documents: the recipient of a shared
 * STANDALONE chat holds no grant on the single-documents behind it, so
 * GET /single-documents/:id/versions answers 403/404 for them. Collapsing
 * that into the same `null` as "the version list came back empty" is what
 * made citation pills dead controls — the click resolved nothing and the
 * caller returned, with no tab, no error and nothing said.
 *
 * "denied" is that case and only that case; "unavailable" is every other
 * failure (network, 5xx, a document with no versions at all), which is not
 * something to tell the reader about their access.
 *
 * "denied" is a status, not a sentence. 404 is also what the chat's own OWNER
 * gets once the document they cited has been deleted, and only the caller
 * knows which of the two readers it is holding — so the caller decides the
 * wording from the role it already has, and this module stays out of it.
 */
export type PanelDocumentResolution =
    | { status: "resolved"; document: PanelDocument }
    | { status: "denied" }
    | { status: "unavailable" };

function isAccessRefusal(error: unknown): boolean {
    return (
        error instanceof MikeApiError &&
        (error.status === 403 || error.status === 404)
    );
}

function withAiStatus(
    document: PanelDocument,
    status: { ai_draft?: boolean; unresolved_ai?: boolean },
): PanelDocument {
    return {
        ...document,
        ai_draft: status.ai_draft === true,
        unresolved_ai:
            status.unresolved_ai === true || status.ai_draft === true,
    };
}

export async function resolvePanelDocumentVersionResult(
    document: PanelDocument,
    loadVersions: (documentId: string) => Promise<VersionList> =
        listDocumentVersions,
    loadAiStatus: (
        documentId: string,
        versionId?: string | null,
    ) => Promise<{ ai_draft: boolean; unresolved_ai: boolean }> =
        getDocumentAiStatus,
): Promise<PanelDocumentResolution> {
    if (document.type === "case") return { status: "resolved", document };

    if (document.version_id) {
        try {
            const status = await loadAiStatus(
                document.document_id,
                document.version_id,
            );
            return {
                status: "resolved",
                document: withAiStatus(document, status),
            };
        } catch {
            // Gate B4 N31: still open the tab; DocumentContent queries again.
            return { status: "resolved", document };
        }
    }

    let result: VersionList;
    try {
        result = await loadVersions(document.document_id);
    } catch (error) {
        return isAccessRefusal(error)
            ? { status: "denied" }
            : { status: "unavailable" };
    }

    // Historical links must never silently open today's bytes, and deleted
    // versions remain in the history API solely for the history UI.
    const versions = result.versions.filter((candidate) => candidate.deleted_at == null);
    const version = document.version_number != null
        ? versions.find((candidate) => candidate.version_number === document.version_number)
        : versions.find((candidate) => candidate.id === result.current_version_id);
    if (!version) return { status: "unavailable" };
    return {
        status: "resolved",
        document: withAiStatus(
            {
                ...document,
                version_id: version.id,
                version_number: version.version_number,
            },
            version,
        ),
    };
}

// There used to be a `resolvePanelDocumentVersion` wrapper here that threw
// the reason away and returned `PanelDocument | null`. Its last caller was
// the download-card click, and "null" is precisely why that click did nothing
// visible when a document was missing. Every caller now has a reason to give,
// so the lossy wrapper is gone rather than left as the easier option.
