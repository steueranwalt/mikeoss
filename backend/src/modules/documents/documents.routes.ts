// HTTP layer for the documents module. Handlers parse params/query/body,
// call the service functions behind documents.service.ts, and map their typed
// results onto status codes, headers, and response bodies. The one piece of
// logic that stays here is the download-zip streaming loop, because it exists
// to apply `res` backpressure to the object-storage reads.

import { Router } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import { reportError, setOperation } from "../../lib/observability/sentry";
import { buildContentDisposition, createFileReadStream, downloadFile } from "../../lib/storage";
import { stampAiDraftBytes, isStampableAiDraftFileType } from "../../lib/aiDraftWatermark";
import { withAiDraftFilenamePrefix } from "../../lib/documentVersions";
import { sendDocumentDisplay } from "../../lib/documentDisplay";
import { contentTypeForDocumentType } from "../../lib/documentTypes";
import { uniqueArchiveFilename } from "../../lib/zipExport";
import {
    getDocument,
    getDocumentAiStatus,
    deleteDocument,
    getDisplayableVersion,
    resolveZipExportDocuments,
    getDownloadUrl,
    getFileStreamSource,
    getTrackedChangesPreviewSource,
    listVersions,
    createVersionFromDocument,
    renameVersion,
    deleteVersion,
    approveAiDraftVersion,
    resolveEdit,
    aiDraftConfirmationResponseBody,
} from "./documents.service";

export const documentsRouter = Router();

// GET /single-documents/:documentId
// One document, same shape as a list entry — the client polls this while a
// deferred conversion runs instead of refetching the whole collection.
documentsRouter.get("/:documentId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const result = await getDocument(documentId, userId, userEmail, db);
    if (!result.ok) {
        if (result.kind === "error") return void sendInternalError(res, result.error);
        if (result.kind === "forbidden")
            return void res.status(403).json({ detail: "You do not have access to this document." });
        return void res.status(404).json({ detail: "Document not found" });
    }
    res.json(result.doc);
}));

// GET /single-documents/:documentId/ai-status
// Gate B4 audit finding N30/N31: the in-app viewer asks whether this
// version is an unreviewed AI draft or still has pending KI edits, then
// loads /display instead of /file.
documentsRouter.get("/:documentId/ai-status", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const result = await getDocumentAiStatus(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
    );
    if (!result.ok) {
        if (result.kind === "error") return void sendInternalError(res, result.error);
        if (result.kind === "forbidden")
            return void res.status(403).json({ detail: "You do not have access to this document." });
        return void res.status(404).json({ detail: "Document not found" });
    }
    res.json({
        ai_draft: result.ai_draft,
        unresolved_ai: result.unresolved_ai,
    });
}));

// POST /single-documents is intentionally absent: multipart upload was
// replaced by the direct object-storage upload-session protocol, and app.ts
// answers 410 on the former path before any body parser reads file bytes.

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const result = await deleteDocument(documentId, userId, db, userEmail);
    if (!result.ok) {
        if ("kind" in result && result.kind === "forbidden")
            return void res.status(403).json({ detail: result.detail });
        if (result.error) return void sendInternalError(res, result.error);
        return void res.status(404).json({ detail: "Document not found" });
    }
    res.status(204).send();
}));

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
//
// Gate B4 audit finding N17 (Nils, 20.11.2026, 22:40 MEZ, binding): a
// display, not an export — no confirmation. An unapproved AI draft is a
// stamped PDF (or refused). Cache-Control: no-store and X-Mike-Ai-Draft
// tell the viewer not to cache and to show the banner.
documentsRouter.get("/:documentId/display", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const result = await getDisplayableVersion(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
    );
    if (!result.ok) {
        switch (result.kind) {
            case "error":
                return void sendInternalError(res, result.error);
            case "stamping_failed":
                return void res.status(409).json({
                    code: "stamping_failed",
                    detail: result.detail,
                });
            case "not_found":
                return void res.status(404).json({ detail: result.detail });
            default: {
                const exhaustive: never = result;
                return void sendInternalError(res, exhaustive);
            }
        }
    }
    res.setHeader("X-Mike-Ai-Draft", result.isAiDraft ? "1" : "0");
    if (result.isAiDraft) res.setHeader("Cache-Control", "no-store");
    sendDocumentDisplay(res, result.display);
}));

// GET /single-documents/:documentId/file
// Streams the active version's source bytes, or a specific version selected
// with ?version_id=. Unlike /display, this never substitutes a generated PDF
// rendition. Proxying through the API also lets browser viewers and editors
// fetch the file without depending on cross-origin access to signed R2 URLs.
// The service locates and sizes the object; the stream is opened here so
// `res` is what applies backpressure to the object-storage read.
//
// Gate B4 audit findings L3/N4/N5/N6: a document with unresolved AI-proposed
// tracked changes or an unapproved AI draft version refuses an *export*
// download with 409 unless the caller's ?confirm_token matches the
// document's current pending-edits/draft state exactly (not a blanket
// ?confirm_ai_draft=1 — a stale token from before the document changed is
// rejected the same as no token at all). A confirmed .docx export is then
// served with a visible "AI draft, not approved" banner stamped in, so the
// file itself carries the warning wherever it ends up — not just this
// response. A docx that cannot be stamped is refused with 409 rather than
// served unstamped (fail-closed). Without anything to confirm, the download
// is unchanged.
//
// Gate B4 audit finding N23: ?purpose=display is not an exemption for AI
// drafts. Viewers of drafts load /display. /file always runs the same
// confirmation check, whether or not purpose=display was sent.
documentsRouter.get("/:documentId/file", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const confirmToken =
        typeof req.query.confirm_token === "string" ? req.query.confirm_token : undefined;
    const purpose = req.query.purpose === "display" ? "display" : "export";
    const db = createServerSupabase();

    const result = await getFileStreamSource(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
        confirmToken,
        purpose,
    );
    if (!result.ok)
        return void res.status(404).json({ detail: result.detail });

    if (!result.confirmation.ok) {
        return void res.status(409).json(aiDraftConfirmationResponseBody(result.confirmation.state));
    }

    if (result.confirmation.state && isStampableAiDraftFileType(result.fileType)) {
        // Watermarking needs the whole file to parse and rewrite it, so this
        // path cannot stream: it reads the object fully, stamps it, and
        // sends the result. Headers for the file response are set only once
        // stamping actually succeeds — set any earlier and a failed
        // `res.json()` below would inherit this Content-Type instead of
        // "application/json".
        let stamped: Buffer;
        try {
            const bytes = await downloadFile(result.storagePath);
            if (!bytes) throw new Error("source bytes unavailable");
            stamped = await stampAiDraftBytes(result.fileType, Buffer.from(bytes));
        } catch (error) {
            reportError(error, { tags: { component: "documents", operation: "documents.ai_draft_stamp" } });
            // Gate B4 audit finding N6/N16: fail-closed — never fall through
            // to the unstamped stream below.
            return void res.status(409).json({
                code: "stamping_failed",
                detail: "This document could not be stamped as an AI draft and will not be served unstamped.",
            });
        }
        res.setHeader("Content-Type", contentTypeForDocumentType(result.fileType));
        res.setHeader(
            "Content-Disposition",
            buildContentDisposition("inline", result.filename),
        );
        res.setHeader("Content-Length", stamped.byteLength);
        return void res.send(stamped);
    }

    // Gate B4 audit finding N16: a confirmed draft in a format with no
    // stamping capability (xlsx, pptx, csv, ...) at least carries the
    // warning in its filename, since nothing can be injected into the bytes.
    const filename = result.confirmation.state
        ? withAiDraftFilenamePrefix(result.filename)
        : result.filename;
    res.setHeader("Content-Type", contentTypeForDocumentType(result.fileType));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("inline", filename),
    );
    res.setHeader("Content-Length", result.size);
    const source = createFileReadStream(result.storagePath);
    try {
        await pipeline(source, res);
    } catch (error) {
        source.destroy();
        if (!res.headersSent && !res.destroyed) {
            return void sendInternalError(res, error);
        }
    }
}));

// GET /single-documents/:documentId/tracked-changes-preview
// Gate B4 N30 (Nils, 21.11.2026, 01:05 MEZ) + N37: display-only exception
// so the EditCard can render Tracked Changes. Banner + no-store. Not a
// download: no Content-Disposition/filename, download/confirm query
// parameters are refused, Bearer only (not the cookie session), and only
// when there are open document_edits plus a matching edit_id.
documentsRouter.get("/:documentId/tracked-changes-preview", requireAuth, asyncRoute(async (req, res) => {
    if (
        req.query.download === "1" ||
        req.query.download === "true" ||
        typeof req.query.confirm_token === "string"
    ) {
        return void res.status(400).json({
            detail: "Tracked-changes preview is display-only and cannot be downloaded.",
        });
    }
    if (res.locals.authSource !== "bearer") {
        return void res.status(401).json({
            detail: "Tracked-changes preview requires a Bearer token.",
        });
    }
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const editId =
        typeof req.query.edit_id === "string" ? req.query.edit_id : null;
    const db = createServerSupabase();

    const result = await getTrackedChangesPreviewSource(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
        editId,
    );
    if (!result.ok) {
        switch (result.kind) {
            case "unsupported":
                return void res.status(409).json({ detail: result.detail });
            case "not_found":
                return void res.status(404).json({ detail: result.detail });
            default: {
                const exhaustive: never = result;
                return void sendInternalError(res, exhaustive);
            }
        }
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Mike-Ai-Draft", "1");
    res.setHeader("Content-Type", contentTypeForDocumentType(result.fileType));
    res.setHeader("Content-Length", result.size);
    const source = createFileReadStream(result.storagePath);
    try {
        await pipeline(source, res);
    } catch (error) {
        source.destroy();
        if (!res.headersSent && !res.destroyed) {
            return void sendInternalError(res, error);
        }
    }
}));

// POST /single-documents/download-zip
// Accepts `document_ids` and/or `folder_ids`; folders expand to every
// document beneath them. Synchronous zip, kept for small selections (instant
// download, no polling). Large selections go through the durable
// "documents-zip" export job instead.
documentsRouter.post("/download-zip", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { document_ids, folder_ids, confirm_tokens } = req.body as {
        document_ids?: string[];
        folder_ids?: string[];
        confirm_tokens?: Record<string, string>;
    };
    const documentIds = Array.isArray(document_ids)
        ? [...new Set(document_ids.filter((id) => typeof id === "string"))]
        : [];
    const folderIds = Array.isArray(folder_ids)
        ? [...new Set(folder_ids.filter((id) => typeof id === "string"))]
        : [];

    if (documentIds.length === 0 && folderIds.length === 0)
        return void res
            .status(400)
            .json({ detail: "document_ids or folder_ids is required" });

    const db = createServerSupabase();
    const confirmTokens =
        confirm_tokens && typeof confirm_tokens === "object" && !Array.isArray(confirm_tokens)
            ? Object.fromEntries(
                  Object.entries(confirm_tokens).filter(
                      (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
              )
            : undefined;
    const result = await resolveZipExportDocuments(
        { documentIds, folderIds, userId, userEmail, confirmTokens },
        db,
    );
    if (!result.ok) {
        if (result.kind === "internal")
            return void sendInternalError(res, result.error);
        if (result.kind === "confirmation_required")
            return void res.status(409).json({
                code: "unresolved_ai_edits",
                detail:
                    "One or more selected documents have AI-proposed changes or an unapproved " +
                    "AI draft that has not been confirmed yet. Confirm the export to include " +
                    "them, marked as AI drafts.",
                documents: result.documents,
            });
        if (result.kind === "stamping_failed")
            return void res.status(409).json({
                code: "stamping_failed",
                detail: result.detail,
            });
        const status = result.kind === "limit" ? 413 : 404;
        return void res.status(status).json({ detail: result.detail });
    }

    // Streaming lives here rather than in the service: each entry is read
    // lazily from object storage and the archive is piped straight into `res`,
    // so the response object is what applies backpressure. Nothing is
    // buffered, and STORE (no deflate) keeps already-compressed office files
    // from being recompressed.
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const usedNames = new Set<string>();
    const fileStreams = result.entries.flatMap((entry) => {
        const name = uniqueArchiveFilename(entry.filename, usedNames);
        if (entry.bytes) {
            zip.file(name, entry.bytes, { compression: "STORE" });
            return [];
        }
        const stream = createFileReadStream(entry.storagePath);
        zip.file(name, stream, { compression: "STORE" });
        return [stream];
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
    const archiveStream = zip.generateNodeStream({
        type: "nodebuffer",
        streamFiles: true,
        compression: "STORE",
    }) as Readable;
    try {
        await pipeline(archiveStream, res);
    } catch (error) {
        // Destroy the per-file readers so a failed archive does not leave
        // object-storage GETs open. Once bytes are on the wire the status is
        // already sent, so only a pre-headers failure can be reported.
        for (const stream of fileStreams) stream.destroy();
        if (!res.headersSent && !res.destroyed) {
            return void sendInternalError(res, error);
        }
    }
}));

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
//
// Gate B4 audit findings L3/N5/N6: same confirm_token gate as /file. Unlike
// /file this route hands back a signed URL rather than bytes it controls
// directly — so, fail-closed rather than fail-open, a confirmed .docx is
// stamped into a throwaway copy FIRST and only that copy is ever signed; the
// original object is never the target of a signed URL once confirmation was
// required. A docx that cannot be stamped is refused with 409, never served
// unstamped. A confirmed non-docx (no stamping capability at all) signs the
// original, same as an unconfirmed download needs no stamping either.
documentsRouter.get("/:documentId/url", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
        typeof req.query.version_id === "string" ? req.query.version_id : null;
    const confirmToken =
        typeof req.query.confirm_token === "string" ? req.query.confirm_token : undefined;
    const db = createServerSupabase();

    const result = await getDownloadUrl(
        documentId,
        userId,
        userEmail,
        versionIdParam,
        db,
        confirmToken,
    );
    if (!result.ok) {
        if (result.kind === "confirmation_required") {
            return void res.status(409).json(aiDraftConfirmationResponseBody(result.state));
        }
        if (result.kind === "stamping_failed") {
            return void res.status(409).json({ code: "stamping_failed", detail: result.detail });
        }
        const status = result.kind === "storage" ? 503 : 404;
        return void res.status(status).json({ detail: result.detail });
    }
    res.json(result.payload);
}));

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, asyncRoute(async (req, res) => {
    setOperation("documents.version");
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const result = await listVersions(documentId, userId, userEmail, db);
    if (!result.ok)
        return void res.status(404).json({ detail: result.detail });

    res.json({
        current_version_id: result.current_version_id,
        versions: result.versions,
    });
}));

// POST /single-documents/:documentId/versions/from-document
// Create a new version of documentId from another existing document's active
// bytes. This keeps signed storage URLs out of the browser fetch path.
documentsRouter.post(
    "/:documentId/versions/from-document",
    requireAuth,
    asyncRoute(async (req, res) => {
        setOperation("documents.version");
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId } = req.params;
        const sourceDocumentId =
            typeof req.body?.source_document_id === "string"
                ? req.body.source_document_id
                : "";
        const db = createServerSupabase();

        if (!sourceDocumentId) {
            return void res
                .status(400)
                .json({ detail: "source_document_id is required" });
        }
        if (sourceDocumentId === documentId) {
            return void res
                .status(400)
                .json({ detail: "Source and target documents must be different." });
        }

        const result = await createVersionFromDocument(
            {
                documentId,
                sourceDocumentId,
                requestedFilename:
                    typeof req.body?.filename === "string"
                        ? req.body.filename
                        : null,
                userId,
                userEmail,
            },
            db,
        );
        if (!result.ok) {
            // The 500s carry their cause: one report, with the kind and the
            // failing dependency's code, instead of a bare detail string.
            if ("error" in result)
                return void sendInternalError(res, result.error);
            const status =
                result.kind === "source_not_owner" ||
                result.kind === "target_forbidden"
                    ? 403
                    : 404;
            return void res.status(status).json({ detail: result.detail });
        }
        res.status(201).json(result.version);
    }),
);

// POST /single-documents/:documentId/versions and
// PUT /single-documents/:documentId/versions/:versionId/file are intentionally
// absent for the same reason as POST /single-documents: multipart version
// upload and replacement moved to the upload-session protocol, and app.ts
// answers 410 on both former paths.

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's filename. Pass `{ "filename": "…" }`.
documentsRouter.patch(
    "/:documentId/versions/:versionId",
    requireAuth,
    asyncRoute(async (req, res) => {
        setOperation("documents.version");
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId, versionId } = req.params;
        const db = createServerSupabase();

        const result = await renameVersion(
            {
                documentId,
                versionId,
                rawFilename: req.body?.filename,
                userId,
                userEmail,
            },
            db,
        );
        if (!result.ok)
            return void res
                .status(result.status ?? 404)
                .json({ detail: result.detail });
        res.json(result.version);
    }),
);

// POST /single-documents/:documentId/versions/:versionId/approve-draft
// Gate B4 audit finding L4: clears the "AI draft" flag generate_docx /
// generate_excel / generate_ppt / write_project_document set on their own
// output. Only a human calling this route — never the assistant tools
// themselves — can do that.
documentsRouter.post(
    "/:documentId/versions/:versionId/approve-draft",
    requireAuth,
    asyncRoute(async (req, res) => {
        setOperation("documents.version");
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId, versionId } = req.params;
        const db = createServerSupabase();

        const result = await approveAiDraftVersion(
            { documentId, versionId, userId, userEmail },
            db,
        );
        if (!result.ok)
            return void res
                .status(result.status ?? 404)
                .json({ detail: result.detail });
        res.json(result.version);
    }),
);

// DELETE /single-documents/:documentId/versions/:versionId
// Delete one version. The last remaining version cannot be deleted; if the
// deleted version is current, the newest remaining version becomes current.
documentsRouter.delete(
    "/:documentId/versions/:versionId",
    requireAuth,
    asyncRoute(async (req, res) => {
        setOperation("documents.version");
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { documentId, versionId } = req.params;
        const db = createServerSupabase();

        const result = await deleteVersion(
            documentId,
            versionId,
            userId,
            userEmail,
            db,
        );
        if (!result.ok) {
            if (result.kind === "db")
                return void sendInternalError(res, result.error);
            const status =
                result.kind === "doc_not_found" ||
                result.kind === "version_not_found"
                    ? 404
                    : result.kind === "version_forbidden"
                      ? 403
                      : 400;
            return void res.status(status).json({ detail: result.detail });
        }
        res.json(result.payload);
    }),
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
    req: import("express").Request<ParamsDictionary>,
    res: import("express").Response,
    mode: "accept" | "reject",
) {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, editId } = req.params;
    const db = createServerSupabase();

    const result = await resolveEdit(
        mode,
        documentId,
        editId,
        userId,
        userEmail,
        db,
    );
    if (!result.ok) {
        if (result.error) return void sendInternalError(res, result.error);
        return void res
            .status(result.status ?? 404)
            .json({ detail: result.detail });
    }
    res.json(result.body);
}

documentsRouter.post(
    "/:documentId/edits/:editId/accept",
    requireAuth,
    asyncRoute(async (req, res) => handleEditResolution(req, res, "accept")),
);

documentsRouter.post(
    "/:documentId/edits/:editId/reject",
    requireAuth,
    asyncRoute(async (req, res) => handleEditResolution(req, res, "reject")),
);

documentsRouter.use(routerErrorHandler("[documents]"));
