// Read/serve paths for documents: inline display bytes, zip bundling, signed
// download URLs, and the raw source bytes of a version.

import { randomUUID } from "node:crypto";
import { downloadFile, getSignedUrl, headFile, uploadFile } from "../../lib/storage";
import {
    attachActiveVersionPaths,
    loadActiveVersion,
    withAiDraftFilenamePrefix,
} from "../../lib/documentVersions";
import { checkProjectAccess, ensureDocAccess } from "../../lib/access";
import { mapWithConcurrency } from "../../lib/concurrency";
import { zipExportLimitDetail } from "../../lib/zipExport";
import {
    loadDocumentDisplay,
    type DocumentDisplayPayload,
} from "../../lib/documentDisplay";
import { downloadFilenameForVersion, type Db } from "./documents.shared";
import { ensureDocumentAccess } from "./documents.access";
import {
    aiDraftConfirmationState,
    checkAiDraftConfirmation,
    type AiDraftConfirmationState,
} from "./documents.edits";
import { stampAiDraftBytes, isStampableAiDraftFileType } from "../../lib/aiDraftWatermark";
import { stampAiDraftDisplayBytes } from "../../lib/aiDraftDisplayStamp";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { reportError } from "../../lib/observability/sentry";

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Resolve the payload to serve inline for a document's display view. The
 * rendition logic (stored PDF, LibreOffice fallback, raw bytes) lives in
 * lib/documentDisplay so every preview surface renders identically; the route
 * hands the returned payload to `sendDocumentDisplay`.
 *
 * A conversion failure throws out of `loadDocumentDisplay`, so it is reported
 * separately from the 404 paths: the route maps it to an internal error.
 *
 * Gate B4 audit finding N17 (Nils, 20.11.2026, 22:40 MEZ, binding): /display
 * is a display, not an export — it never asks for confirmation. An unapproved
 * AI draft / unresolved-edit version is shown as a stamped PDF (xlsx, csv,
 * html, images are converted first) or refused. Stamping is fail-closed: a
 * failure does not fall back to the unstamped original. `isAiDraft` tells
 * the route to answer with Cache-Control: no-store and X-Mike-Ai-Draft.
 */
export async function getDisplayableVersion(
    documentId: string,
    userId: string,
    userEmail: string,
    versionIdParam: string | null,
    db: Db,
): Promise<
    | { ok: true; display: DocumentDisplayPayload; isAiDraft: boolean }
    | { ok: false; kind: "not_found"; detail: string }
    | { ok: false; kind: "stamping_failed"; detail: string }
    | { ok: false; kind: "error"; error: unknown }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, kind: "not_found", detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
        return { ok: false, kind: "not_found", detail: "No file available" };

    const displayFilename = downloadFilenameForVersion(
        active.filename,
        active.version_number,
        active.source === "assistant_edit",
    );

    try {
        const display = await loadDocumentDisplay({
            filename: displayFilename,
            fileType: active.file_type,
            storagePath: active.storage_path,
            pdfStoragePath: active.pdf_storage_path,
        });
        if (!display)
            return {
                ok: false,
                kind: "not_found",
                detail: "Document not found in storage",
            };

        const draftState = await aiDraftConfirmationState(documentId, db, active.id);
        if (draftState) {
            try {
                const stamped = await stampAiDraftDisplayBytes(
                    display.bytes,
                    active.file_type,
                    display.contentType,
                );
                display.bytes = stamped;
                display.contentType = "application/pdf";
                display.filename = display.filename.toLowerCase().endsWith(".pdf")
                    ? display.filename
                    : `${display.filename.replace(/\.[^.]+$/, "") || display.filename}.pdf`;
            } catch (error) {
                reportError(error, { tags: { component: "documents", operation: "documents.ai_draft_display_stamp" } });
                return {
                    ok: false,
                    kind: "stamping_failed",
                    detail: "This document could not be stamped as an AI draft and will not be shown unstamped.",
                };
            }
        }
        return { ok: true, display, isAiDraft: draftState !== null };
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
}

// ---------------------------------------------------------------------------
// Download zip
// ---------------------------------------------------------------------------

/**
 * Expand a set of selected folders into every folder id beneath them.
 * `allFolders` is the caller's full folder set for the relevant scope, so the
 * walk is a fixpoint over an in-memory list rather than one query per level.
 */
export function collectFolderDescendantIds(
    roots: Array<{ id: unknown }>,
    allFolders: Array<{ id: unknown; parent_folder_id: unknown }>,
) {
    const selected = new Set(roots.map((folder) => String(folder.id)));
    let changed = true;
    while (changed) {
        changed = false;
        for (const folder of allFolders) {
            const id = String(folder.id);
            const parentId = folder.parent_folder_id
                ? String(folder.parent_folder_id)
                : null;
            if (!parentId || !selected.has(parentId) || selected.has(id))
                continue;
            selected.add(id);
            changed = true;
        }
    }
    return [...selected];
}

// A `type` (not an interface) so it keeps the implicit index signature that
// attachActiveVersionPaths's row constraint requires.
type DownloadDocumentRow = {
    id: string;
    current_version_id?: string | null;
    user_id: string | null;
    project_id: string | null;
    org_id?: string | null;
    workflow_id?: string | null;
    storage_path?: string | null;
    filename?: string | null;
    file_type?: string | null;
    source?: string | null;
    active_version_number?: number | null;
};

/** One file to place in the archive, already named and sized. */
export type ZipExportEntry = {
    storagePath: string;
    filename: string;
    size: number;
    /** Stamped AI-draft bytes, when confirmation was supplied for this entry. */
    bytes?: Buffer;
};

/**
 * Resolve the exportable files behind a zip request: the requested documents
 * plus everything inside the requested project / library folders, filtered to
 * what the caller may read, restricted to versions that still have bytes, and
 * bounded by the document-count and total-size limits.
 *
 * Returns entries only — the route streams the archive, because that loop is
 * an HTTP concern (it applies backpressure onto `res`).
 */
/** One document the batch refused because it needed confirmation first (Gate B4 audit finding N4). */
export type ZipExportConfirmationNeeded = {
    document_id: string;
    filename: string;
    confirm_token: string;
};

export async function resolveZipExportDocuments(
    params: {
        documentIds: string[];
        folderIds: string[];
        userId: string;
        userEmail: string | undefined;
        /** Per-document confirm_token from a previous 409, keyed by document id. */
        confirmTokens?: Record<string, string>;
    },
    db: Db,
): Promise<
    | { ok: true; entries: ZipExportEntry[] }
    | { ok: false; kind: "limit"; detail: string }
    | { ok: false; kind: "not_found"; detail: string }
    // Gate B4 audit finding N4/N26: at least one requested document has
    // unresolved tracked changes or an unapproved AI draft. A subsequent
    // request may retry with per-document confirm_tokens from this body's
    // `documents` list. Fail-closed: the rest of the batch is refused too,
    // rather than silently shipping a zip with gaps.
    | { ok: false; kind: "confirmation_required"; documents: ZipExportConfirmationNeeded[] }
    | { ok: false; kind: "stamping_failed"; detail: string }
    // Database and object-storage failures are opaque to the client: the
    // route hands the raw error to sendInternalError.
    | { ok: false; kind: "internal"; error: unknown }
> {
    const { documentIds, folderIds, userId, userEmail, confirmTokens } = params;

    // Bound the *requested* count before any query runs, so an oversized
    // selection cannot cost a database round-trip.
    const requestedCountLimit = zipExportLimitDetail(documentIds.length, 0);
    if (requestedCountLimit)
        return { ok: false, kind: "limit", detail: requestedCountLimit };

    const rawDocsById = new Map<string, DownloadDocumentRow>();

    if (documentIds.length > 0) {
        const { data, error } = await db
            .from("documents")
            .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
            .in("id", documentIds);
        if (error) return { ok: false, kind: "internal", error };
        for (const doc of data ?? [])
            rawDocsById.set(doc.id as string, doc as DownloadDocumentRow);
    }

    if (folderIds.length > 0) {
        const [projectRootsResult, libraryRootsResult] = await Promise.all([
            db
                .from("project_subfolders")
                .select("id, project_id, parent_folder_id")
                .in("id", folderIds),
            db
                .from("library_folders")
                .select("id, user_id, library_kind, parent_folder_id")
                .in("id", folderIds)
                .eq("user_id", userId),
        ]);
        if (projectRootsResult.error)
            return {
                ok: false,
                kind: "internal",
                error: projectRootsResult.error,
            };
        if (libraryRootsResult.error)
            return {
                ok: false,
                kind: "internal",
                error: libraryRootsResult.error,
            };

        const projectRoots = projectRootsResult.data ?? [];
        const projectIds = [
            ...new Set(
                projectRoots.map((folder) => folder.project_id as string),
            ),
        ];
        const accessibleProjectIds = (
            await Promise.all(
                projectIds.map(async (projectId) => ({
                    projectId,
                    access: await checkProjectAccess(
                        projectId,
                        userId,
                        userEmail,
                        db,
                    ),
                })),
            )
        )
            .filter((result) => result.access.ok)
            .map((result) => result.projectId);

        const accessibleProjectRoots = projectRoots.filter((folder) =>
            accessibleProjectIds.includes(folder.project_id as string),
        );
        const libraryRoots = libraryRootsResult.data ?? [];
        const libraryKinds = [
            ...new Set(
                libraryRoots.map((folder) => folder.library_kind as string),
            ),
        ];

        const [projectFoldersResult, libraryFoldersResult] = await Promise.all([
            accessibleProjectIds.length > 0
                ? db
                      .from("project_subfolders")
                      .select("id, project_id, parent_folder_id")
                      .in("project_id", accessibleProjectIds)
                : Promise.resolve({ data: [], error: null }),
            libraryKinds.length > 0
                ? db
                      .from("library_folders")
                      .select("id, user_id, library_kind, parent_folder_id")
                      .eq("user_id", userId)
                      .in("library_kind", libraryKinds)
                : Promise.resolve({ data: [], error: null }),
        ]);
        if (projectFoldersResult.error)
            return {
                ok: false,
                kind: "internal",
                error: projectFoldersResult.error,
            };
        if (libraryFoldersResult.error)
            return {
                ok: false,
                kind: "internal",
                error: libraryFoldersResult.error,
            };

        const projectFolderIds = collectFolderDescendantIds(
            accessibleProjectRoots,
            projectFoldersResult.data ?? [],
        );
        const libraryFolderIds = collectFolderDescendantIds(
            libraryRoots,
            libraryFoldersResult.data ?? [],
        );

        const folderDocumentResults = await Promise.all([
            projectFolderIds.length > 0
                ? db
                      .from("documents")
                      .select(
                          "id, current_version_id, user_id, project_id, org_id, workflow_id",
                      )
                      .in("folder_id", projectFolderIds)
                : Promise.resolve({ data: [], error: null }),
            libraryFolderIds.length > 0
                ? db
                      .from("documents")
                      .select(
                          "id, current_version_id, user_id, project_id, org_id, workflow_id",
                      )
                      .in("library_folder_id", libraryFolderIds)
                : Promise.resolve({ data: [], error: null }),
        ]);
        for (const result of folderDocumentResults) {
            if (result.error)
                return { ok: false, kind: "internal", error: result.error };
            for (const doc of result.data ?? [])
                rawDocsById.set(doc.id as string, doc as DownloadDocumentRow);
        }
    }

    // Folder expansion can multiply the selection well past the requested
    // count, so re-check the bound on what actually resolved.
    const resolvedCountLimit = zipExportLimitDetail(rawDocsById.size, 0);
    if (resolvedCountLimit)
        return { ok: false, kind: "limit", detail: resolvedCountLimit };

    // Filter to docs the user actually has access to (own + shared-project).
    const accessChecks = await Promise.all(
        [...rawDocsById.values()].map(async (d) => ({
            doc: d,
            access: await ensureDocAccess(d, userId, userEmail, db),
        })),
    );
    const docs = accessChecks.filter((x) => x.access.ok).map((x) => x.doc);
    if (docs.length === 0)
        return { ok: false, kind: "not_found", detail: "No documents found" };

    await attachActiveVersionPaths(db, docs);
    const activeDocs = docs.filter(
        (
            doc,
        ): doc is DownloadDocumentRow & {
            storage_path: string;
        } => typeof doc.storage_path === "string" && doc.storage_path.length > 0,
    );
    if (activeDocs.length === 0)
        return { ok: false, kind: "not_found", detail: "No files available" };

    // Gate B4 audit finding N4: every output path checks this, including a
    // batch export — a draft or edited document does not get a pass just
    // because it arrived bundled with others.
    const confirmationStates = await mapWithConcurrency(
        activeDocs,
        5,
        async (doc) => ({ doc, state: await aiDraftConfirmationState(doc.id, db) }),
    );
    const confirmedById = new Map<string, AiDraftConfirmationState>();
    const needsConfirmation = confirmationStates.filter(
        (entry): entry is { doc: (typeof activeDocs)[number]; state: AiDraftConfirmationState } => {
            if (!entry.state) return false;
            if (confirmTokens?.[entry.doc.id] === entry.state.confirmToken) {
                confirmedById.set(entry.doc.id, entry.state);
                return false;
            }
            return true;
        },
    );
    if (needsConfirmation.length > 0) {
        return {
            ok: false,
            kind: "confirmation_required",
            documents: needsConfirmation.map(({ doc, state }) => ({
                document_id: doc.id,
                filename: doc.filename ?? doc.storage_path,
                confirm_token: state.confirmToken,
            })),
        };
    }

    // HEAD every object to learn the archive's total size before committing to
    // it; bounded concurrency keeps a large selection from opening one request
    // per document at once.
    let sized: Array<{ doc: (typeof activeDocs)[number]; size: number }>;
    try {
        sized = (
            await mapWithConcurrency(activeDocs, 5, async (doc) => ({
                doc,
                metadata: await headFile(doc.storage_path),
            }))
        )
            .filter(
                (
                    entry,
                ): entry is {
                    doc: (typeof activeDocs)[number];
                    metadata: NonNullable<Awaited<ReturnType<typeof headFile>>>;
                } => entry.metadata != null,
            )
            .map(({ doc, metadata }) => ({ doc, size: metadata.size }));
    } catch (error) {
        return { ok: false, kind: "internal", error };
    }
    if (sized.length === 0)
        return { ok: false, kind: "not_found", detail: "No files available" };

    const sizeLimit = zipExportLimitDetail(
        sized.length,
        sized.reduce((total, entry) => total + entry.size, 0),
    );
    if (sizeLimit) return { ok: false, kind: "limit", detail: sizeLimit };

    const entries: ZipExportEntry[] = [];
    for (const { doc, size } of sized) {
        let filename = downloadFilenameForVersion(
            doc.filename,
            doc.active_version_number ?? null,
            doc.source === "assistant_edit",
        );
        const confirmed = confirmedById.get(doc.id);
        if (!confirmed) {
            entries.push({ storagePath: doc.storage_path, filename, size });
            continue;
        }
        if (isStampableAiDraftFileType(doc.file_type)) {
            try {
                const original = await downloadFile(doc.storage_path);
                if (!original) throw new Error("source bytes unavailable");
                const stamped = await stampAiDraftBytes(doc.file_type, Buffer.from(original));
                entries.push({
                    storagePath: doc.storage_path,
                    filename,
                    size: stamped.byteLength,
                    bytes: stamped,
                });
            } catch (error) {
                reportError(error, { tags: { component: "documents", operation: "documents.ai_draft_zip_stamp" } });
                return {
                    ok: false,
                    kind: "stamping_failed",
                    detail: "This document could not be stamped as an AI draft and will not be served unstamped.",
                };
            }
            continue;
        }
        entries.push({
            storagePath: doc.storage_path,
            filename: withAiDraftFilenamePrefix(filename),
            size,
        });
    }

    return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// Signed download URL
// ---------------------------------------------------------------------------

// Gate B4 audit finding N6: a signed URL that needed confirmation points at
// a throwaway stamped copy, never the original stored object — the
// original never carries the banner, and nobody holding this URL ever sees
// it without one.
const STAMPED_COPY_TTL_SECONDS = 600;

// Gate B4 audit finding N22: comfortably past STAMPED_COPY_TTL_SECONDS — the
// signed URL itself stops working well before this runs, so there is no
// client left to race.
const STAMPED_COPY_CLEANUP_DELAY_SECONDS = 3600;

async function enqueueStampedCopyCleanup(db: Db, storagePath: string): Promise<void> {
    try {
        await enqueueDbJob(db, {
            kind: "storage.cleanup",
            payload: { keys: [storagePath] },
            maxAttempts: 100,
            runAt: new Date(Date.now() + STAMPED_COPY_CLEANUP_DELAY_SECONDS * 1000).toISOString(),
        });
    } catch (error) {
        // Best-effort: deleteDocumentAndVersionFiles's whole-prefix sweep on
        // document deletion, and the throwaway copy's own short signed-URL
        // TTL, are both still in effect even if scheduling this job fails.
        reportError(error, { tags: { component: "documents", operation: "documents.ai_draft_stamp_cleanup" } });
    }
}

export async function getDownloadUrl(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    versionIdParam: string | null,
    db: Db,
    /** Gate B4 audit finding N5: the caller's confirm_token, if it sent one. */
    confirmToken?: string,
): Promise<
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; kind: "not_found"; detail: string }
    | { ok: false; kind: "storage"; detail: string }
    | { ok: false; kind: "confirmation_required"; state: AiDraftConfirmationState }
    | { ok: false; kind: "stamping_failed"; detail: string }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, kind: "not_found", detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
        return { ok: false, kind: "not_found", detail: "No file available" };

    let downloadFilename = downloadFilenameForVersion(
        active.filename,
        active.version_number,
        active.source === "assistant_edit",
    );

    // One read decides both: whether confirmation is required at all, and
    // (if the caller is confirmed) whether there is anything left to stamp.
    // Gate B4 audit finding N15: checked against `active.id` — the version
    // this response actually hands out, which is `versionIdParam` when the
    // caller asked for one, not always the document's current version.
    const draftState = await aiDraftConfirmationState(documentId, db, active.id);
    if (draftState && confirmToken !== draftState.confirmToken) {
        return { ok: false, kind: "confirmation_required", state: draftState };
    }

    let signedStoragePath = active.storage_path;
    if (draftState && isStampableAiDraftFileType(active.file_type)) {
        // Gate B4 audit finding N6/N16: fail-closed, not fail-open — a docx
        // or pdf that needed confirmation and cannot be stamped is refused
        // outright (stamping_failed) rather than silently handed out as the
        // original, unstamped object. A file that did not need confirmation
        // (draftState null: no pending edits, not an AI draft) is untouched.
        try {
            const original = await downloadFile(active.storage_path);
            if (!original) throw new Error("source bytes unavailable");
            const stamped = await stampAiDraftBytes(active.file_type, Buffer.from(original));
            const extension = active.file_type === "pdf" ? "pdf" : "docx";
            signedStoragePath = `exports/ai-draft-stamped/${documentId}/${randomUUID()}.${extension}`;
            await uploadFile(
                signedStoragePath,
                stamped.buffer.slice(stamped.byteOffset, stamped.byteOffset + stamped.byteLength) as ArrayBuffer,
                active.file_type === "pdf"
                    ? "application/pdf"
                    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            );
            // Gate B4 audit finding N22: the signed URL only works for
            // STAMPED_COPY_TTL_SECONDS anyway — this throwaway copy has no
            // other owner and no other reason to exist past that, so its
            // cleanup is scheduled right here rather than left to accumulate
            // until the document itself is deleted (deleteDocumentAndVersionFiles
            // also sweeps this document's whole exports/ai-draft-stamped/
            // prefix, for the copy a client never actually fetched in time).
            await enqueueStampedCopyCleanup(db, signedStoragePath);
        } catch (error) {
            reportError(error, { tags: { component: "documents", operation: "documents.ai_draft_stamp" } });
            return {
                ok: false,
                kind: "stamping_failed",
                detail: "This document could not be stamped as an AI draft and will not be served unstamped.",
            };
        }
    } else if (draftState) {
        // Gate B4 audit finding N16: no stamping capability for this format
        // (xlsx, pptx, csv, ...) — the filename is the only place left to
        // carry the warning.
        downloadFilename = withAiDraftFilenamePrefix(downloadFilename);
    }

    const ttl = signedStoragePath === active.storage_path ? 3600 : STAMPED_COPY_TTL_SECONDS;
    const url = await getSignedUrl(signedStoragePath, ttl, downloadFilename);
    if (!url)
        return { ok: false, kind: "storage", detail: "Storage not configured" };

    return {
        ok: true,
        payload: {
            url,
            document_id: documentId,
            filename: downloadFilename,
            version_id: active.id,
            // Lets the frontend decide between DocView (PDF.js) and DocxView
            // (docx-preview) without a follow-up round-trip.
            has_pdf_rendition: !!active.pdf_storage_path,
        },
    };
}

// ---------------------------------------------------------------------------
// Raw file bytes
// ---------------------------------------------------------------------------

/**
 * Locate the active version's source object (or a specific version selected
 * with `versionIdParam`) so the route can stream it. Unlike the display path
 * this never substitutes a generated PDF rendition. Only the object's
 * metadata is read here: the route opens the read stream itself so `res`
 * applies backpressure to the object-storage read.
 */
export async function getFileStreamSource(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    versionIdParam: string | null,
    db: Db,
    /** Gate B4 audit finding N5: the caller's confirm_token, if it sent one. */
    confirmToken?: string,
    /**
         * Gate B4 audit finding N23: "export" (default) is a download.
     * "display" used to skip confirmation so the in-app viewer could read
     * raw draft bytes. Viewers of AI drafts now load /display instead;
     * /file no longer makes an exception for purpose=display.
     */
    _purpose: "display" | "export" = "export",
): Promise<
    | {
          ok: true;
          storagePath: string;
          fileType: string | null;
          size: number;
          filename: string;
          /** Gate B4 audit finding N4/N5: see checkAiDraftConfirmation. */
          confirmation: Awaited<ReturnType<typeof checkAiDraftConfirmation>>;
      }
    | { ok: false; detail: string }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok) return { ok: false, detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active) return { ok: false, detail: "No file available" };
    const metadata = await headFile(active.storage_path);
    if (!metadata) return { ok: false, detail: "Document bytes not available" };

    return {
        ok: true,
        storagePath: active.storage_path,
        fileType: active.file_type,
        size: metadata.size,
        filename: downloadFilenameForVersion(
            active.filename,
            active.version_number,
            active.source === "assistant_edit",
        ),
        confirmation:
            // Gate B4 audit finding N23: purpose=display is not an exemption
            // for AI drafts. Gate B4 audit finding N15: checked against
            // `active.id` — the version actually streamed below.
            await checkAiDraftConfirmation(documentId, confirmToken, db, active.id),
    };
}

/**
 * Gate B4 N30 (Nils, 21.11.2026, 01:05 MEZ) + N37: display-only exception
 * so the EditCard can show Tracked Changes inline. Not an export: callers
 * must not offer download from these bytes. Limited to docx with open
 * `document_edits` and an edit_id that matches one of them. A pure
 * `ai_draft` with no pending edits is not a preview.
 */
export async function getTrackedChangesPreviewSource(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    versionIdParam: string | null,
    db: Db,
    editId: string | null,
): Promise<
    | {
          ok: true;
          storagePath: string;
          fileType: string | null;
          size: number;
          filename: string;
          versionId: string;
      }
    | { ok: false; kind: "not_found"; detail: string }
    | { ok: false; kind: "unsupported"; detail: string }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok) return { ok: false, kind: "not_found", detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active) return { ok: false, kind: "not_found", detail: "No file available" };

    const state = await aiDraftConfirmationState(documentId, db, active.id);
    if (
        !state ||
        state.pendingEditIds.length === 0 ||
        !editId ||
        !state.pendingEditIds.includes(editId)
    ) {
        return { ok: false, kind: "not_found", detail: "No file available" };
    }

    const fileType = (active.file_type ?? "").trim().toLowerCase();
    const filename = (active.filename ?? "").trim().toLowerCase();
    const isDocx =
        fileType === "docx" ||
        fileType === "doc" ||
        filename.endsWith(".docx") ||
        filename.endsWith(".doc");
    if (!isDocx) {
        return {
            ok: false,
            kind: "unsupported",
            detail: "Tracked-changes preview is limited to Word documents.",
        };
    }

    const metadata = await headFile(active.storage_path);
    if (!metadata) return { ok: false, kind: "not_found", detail: "Document bytes not available" };

    return {
        ok: true,
        storagePath: active.storage_path,
        fileType: active.file_type,
        size: metadata.size,
        filename: downloadFilenameForVersion(
            active.filename,
            active.version_number,
            active.source === "assistant_edit",
        ),
        versionId: active.id,
    };
}
