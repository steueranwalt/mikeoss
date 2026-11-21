"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PdfView } from "./views/PdfView";
import { DocxView } from "./views/DocxView";
import type { DocxCloseGuard, DocxSaveState } from "./views/DocxRenderer.types";
import { SpreadsheetView } from "./views/SpreadsheetView";
import {
    CitationQuotesSection,
    documentQuoteId,
} from "../assistant/CitationQuotesSection";
import { EditCard } from "../assistant/EditCard";
import { expandDocumentQuoteEntry } from "./types";
import type { Citation, EditAnnotation, PanelDocument } from "./types";
import { quoteVerificationState } from "../assistant/message/citationVerification";
import { CaseView } from "../assistant/CaseView";
import { useResolvedPanelDocument } from "../assistant/useResolvedPanelDocument";
import {
    approveAiDraftVersion,
    getDocumentAiStatus,
    getTrackedChangesPreviewUrl,
    type DocumentVersion,
} from "@/app/lib/mikeApi";
import { DocumentTitleRow } from "./DocumentTitleRow";
import { DocumentAnnotationLayer } from "./DocumentAnnotationLayer";
import { AiDraftBanner } from "./AiDraftBanner";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";

/**
 * Discriminated-union describing which header annotation the viewer is showing.
 *   - "document":  title row + viewer.
 *   - "citation":  title row + relevant quote + viewer.
 *   - "edit":      title row + tracked change + viewer.
 */
export type DocumentContentMode =
    | { kind: "document" }
    | { kind: "citation"; citation: Citation }
    | {
          kind: "edit";
          edit: EditAnnotation;
          changeNumber?: number;
          /**
           * True while an accept/reject request for this exact edit is in
           * flight. Scoped per-edit (not per-document) so sibling edits on
           * the same doc stay clickable.
           */
          isEditReloading?: boolean;
          onResolveStart?: (args: {
              editId: string;
              documentId: string;
              verb: "accept" | "reject";
          }) => void;
          onResolved?: (args: {
              editId: string;
              documentId: string;
              status: "accepted" | "rejected";
              versionId: string | null;
              downloadUrl: string | null;
          }) => void;
          onError?: (args: {
              editId: string;
              documentId: string;
              versionId: string | null;
              message: string;
          }) => void;
      };

export interface DocumentContentProps {
    document: PanelDocument;
    mode: DocumentContentMode;
    isReloading?: boolean;
    compactActions?: boolean;
    /** Assistant default: start with editing locked and the DOCX toolbar hidden. */
    showToolbarToggle?: boolean;
    /**
     * Whether the viewer may edit the document. Fails closed: without it a
     * DOCX stays read-only and offers no Edit toggle, so a reader never types
     * into a file whose every autosave the server would refuse.
     */
    canEdit?: boolean;
    active?: boolean;
    warning?: string | null;
    onWarningDismiss?: () => void;
    /**
     * Dismisses the citation quote / tracked change shown in the header,
     * leaving the document itself open. The host owns this because the mode
     * comes from the tab: hiding the section locally would strand the user if
     * they reopened the same citation, which produces no prop change.
     */
    onCloseAnnotation?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
    /** Host controls file freshness and whether bytes outlive an open tab. */
    refetchKey?: number | string;
    cacheBytes?: boolean;
    onVersionChange?: (version: DocumentVersion) => void;
    onCloseGuardReady?: (guard: DocxCloseGuard | null) => void;
    onDownloadReady?: (download: (() => Promise<void>) | null) => void;
}

/** Shared viewer content; hosts own tab state, sizing and annotation lifecycle. */
export function DocumentContent({
    document,
    mode,
    isReloading = false,
    compactActions,
    showToolbarToggle = false,
    canEdit = false,
    active = true,
    warning,
    onWarningDismiss,
    onCloseAnnotation,
    initialScrollTop,
    onScrollChange,
    onDownloadReady,
    onCloseGuardReady,
    refetchKey,
    cacheBytes = true,
    onVersionChange,
}: DocumentContentProps) {
    const contentRef = useRef<HTMLDivElement>(null);
    const [narrow, setNarrow] = useState(false);
    const [toolbarVisible, setToolbarVisible] = useState(!showToolbarToggle);
    useEffect(() => {
        const element = contentRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width > 0)
                setNarrow(entry.contentRect.width < 600);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const [saveState, setSaveState] = useState<DocxSaveState | null>(null);
    const [approvedDraftKey, setApprovedDraftKey] = useState<string | null>(
        null,
    );
    const onSaveStateChange = useCallback(
        (_documentId: string, state: DocxSaveState | null) =>
            setSaveState(state),
        [],
    );
    const localDownload = useRef<(() => Promise<void>) | null>(null);
    const handleDownloadReady = useCallback(
        (download: (() => Promise<void>) | null) => {
            localDownload.current = download;
            onDownloadReady?.(download);
        },
        [onDownloadReady],
    );
    const {
        document: resolvedDocument,
        isLoading: isDocumentLoading,
        error: documentError,
        retry: retryDocument,
    } = useResolvedPanelDocument(document);

    const documentId = resolvedDocument.document_id;
    const versionId =
        resolvedDocument.version_id ??
        (mode.kind === "edit" ? mode.edit.version_id : null) ??
        null;
    const draftKey = `${documentId}:${versionId ?? ""}`;
    const [serverAiDraft, setServerAiDraft] = useState(false);
    const [fetchedAiStatus, setFetchedAiStatus] = useState<{
        ai_draft: boolean;
        unresolved_ai: boolean;
    } | null>(null);
    const [aiStatusFailed, setAiStatusFailed] = useState(false);
    useEffect(() => {
        if (!documentId || documentId.startsWith("case:") || !versionId) {
            setFetchedAiStatus(null);
            setAiStatusFailed(false);
            return;
        }
        let cancelled = false;
        void getDocumentAiStatus(documentId, versionId)
            .then((status) => {
                if (!cancelled) {
                    setFetchedAiStatus(status);
                    setAiStatusFailed(false);
                }
            })
            .catch(() => {
                // Gate B4 N39: a failed /ai-status must not fall through to
                // DocxView's /file (409). Fail closed to stamped /display.
                if (!cancelled) {
                    setFetchedAiStatus(null);
                    setAiStatusFailed(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [documentId, versionId]);
    // Gate B4 N17/N27/N30: banner and stamped PDF from the version's AI
    // status, open edits, or /display's X-Mike-Ai-Draft. The viewer queries
    // the server rather than trusting flags the panel document happened to
    // carry (chat tabs often omit them).
    const isUnresolvedAi =
        aiStatusFailed ||
        resolvedDocument.ai_draft === true ||
        resolvedDocument.unresolved_ai === true ||
        fetchedAiStatus?.ai_draft === true ||
        fetchedAiStatus?.unresolved_ai === true ||
        serverAiDraft;
    const showAiDraft =
        (isUnresolvedAi || mode.kind === "edit") &&
        approvedDraftKey !== draftKey &&
        !!versionId;
    const isCase = resolvedDocument.type === "case";
    const viewType = resolveDocumentViewType({
        filename: resolvedDocument.title,
        fileType: resolvedDocument.type,
    });
    // Gate B4 N30 (Nils, 21.11.2026, 01:05 MEZ): EditCard inline Tracked
    // Changes is a narrow display-only exception. Dedicated preview route;
    // no download/export; editor is read-only (N36).
    const useTrackedChangesPreview =
        !aiStatusFailed &&
        isUnresolvedAi &&
        mode.kind === "edit" &&
        viewType === "docx" &&
        approvedDraftKey !== draftKey &&
        !!versionId;
    const useStampedPdfViewer =
        isUnresolvedAi &&
        !useTrackedChangesPreview &&
        approvedDraftKey !== draftKey &&
        !!versionId;
    const trackedChangesPreviewUrl = useTrackedChangesPreview
        ? getTrackedChangesPreviewUrl(
              documentId,
              versionId,
              mode.kind === "edit" ? mode.edit.edit_id : null,
          )
        : null;
    const citation = mode.kind === "citation" ? mode.citation : null;
    const firstSelectableQuoteIndex =
        mode.kind === "citation"
            ? resolvedDocument.quotes.findIndex(
                  (quote) => quoteVerificationState(quote) !== "unverified",
              )
            : -1;
    const citationQuoteId =
        firstSelectableQuoteIndex >= 0
            ? documentQuoteId(documentId, firstSelectableQuoteIndex)
            : null;
    const [activeCitationQuoteId, setActiveCitationQuoteId] = useState<
        string | null
    >(citationQuoteId);
    const [quoteFocusKey, setQuoteFocusKey] = useState(0);
    const [editFocusKey, setEditFocusKey] = useState(0);

    const activeQuoteIndex = activeCitationQuoteId
        ? Number(activeCitationQuoteId.split(":quote:").at(-1))
        : Number.NaN;
    const activeDocumentQuote = Number.isFinite(activeQuoteIndex)
        ? resolvedDocument.quotes[activeQuoteIndex]
        : undefined;

    const { activeViewerQuotes, activeHighlightCells } = useMemo(() => {
        if (mode.kind !== "citation" || isCase) {
            return {
                activeViewerQuotes: undefined,
                activeHighlightCells: undefined,
            };
        }
        if (!activeDocumentQuote) {
            return {
                activeViewerQuotes: [],
                activeHighlightCells: [],
            };
        }

        return {
            activeViewerQuotes: expandDocumentQuoteEntry({
                page: activeDocumentQuote.target.page,
                quote: activeDocumentQuote.quote,
            }),
            activeHighlightCells:
                activeDocumentQuote.target.cell ||
                activeDocumentQuote.target.sheet
                    ? [
                          {
                              sheet: activeDocumentQuote.target.sheet,
                              cell: activeDocumentQuote.target.cell,
                          },
                      ]
                    : [],
        };
    }, [activeDocumentQuote, isCase, mode.kind]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset quote selection for a newly opened citation without remounting the editor
        setActiveCitationQuoteId(citationQuoteId);
    }, [citationQuoteId, citation]);

    const handleCitationQuoteSelect = useCallback(
        (quoteId: string) => {
            const shouldSelect = activeCitationQuoteId !== quoteId;
            setActiveCitationQuoteId(shouldSelect ? quoteId : null);
            if (shouldSelect) setQuoteFocusKey((current) => current + 1);
        },
        [activeCitationQuoteId],
    );

    const highlightEdit = useMemo(() => {
        if (mode.kind !== "edit") return null;
        return {
            key: `${mode.edit.edit_id}:${editFocusKey}`,
            inserted_text: mode.edit.inserted_text,
            deleted_text: mode.edit.deleted_text,
            ins_w_id: mode.edit.ins_w_id ?? null,
            del_w_id: mode.edit.del_w_id ?? null,
        };
    }, [editFocusKey, mode]);

    return (
        <div ref={contentRef} className="flex h-full min-h-0 flex-col">
            <DocumentAnnotationLayer
                title={
                    <DocumentTitleRow
                        document={resolvedDocument}
                        isReloading={isReloading}
                        compactActions={compactActions ?? narrow}
                        saveState={saveState}
                        onVersionChange={onVersionChange}
                        onDownload={
                            showAiDraft
                                ? undefined
                                : () => localDownload.current?.()
                        }
                        toolbarVisible={toolbarVisible}
                        onToggleToolbar={
                            viewType === "docx" &&
                            canEdit &&
                            !useStampedPdfViewer &&
                            !useTrackedChangesPreview
                                ? () => setToolbarVisible((visible) => !visible)
                                : undefined
                        }
                        showAiDraft={showAiDraft}
                        onApproveDraft={
                            showAiDraft && canEdit && versionId
                                ? async () => {
                                      await approveAiDraftVersion(
                                          documentId,
                                          versionId,
                                      );
                                      setApprovedDraftKey(draftKey);
                                  }
                                : undefined
                        }
                    />
                }
                annotation={
                    mode.kind === "citation" ||
                    (mode.kind === "edit" && !isCase) ? (
                        <>
                            {mode.kind === "citation" && (
                                <CitationQuotesSection
                                    document={resolvedDocument}
                                    activeQuoteId={activeCitationQuoteId}
                                    citationRef={mode.citation.ref}
                                    onSelect={(quote) => {
                                        if (
                                            quote.verificationState !==
                                            "unverified"
                                        ) {
                                            handleCitationQuoteSelect(quote.id);
                                        }
                                    }}
                                    onIndexChange={(index) => {
                                        handleCitationQuoteSelect(
                                            documentQuoteId(documentId, index),
                                        );
                                    }}
                                    onClose={onCloseAnnotation}
                                />
                            )}

                            {mode.kind === "edit" && !isCase && (
                                <div className="px-2 pb-2">
                                    <EditCard
                                        annotation={mode.edit}
                                        changeNumber={mode.changeNumber}
                                        isReloading={mode.isEditReloading}
                                        onResolveStart={mode.onResolveStart}
                                        onResolved={mode.onResolved}
                                        onError={mode.onError}
                                        onViewClick={() =>
                                            setEditFocusKey(
                                                (current) => current + 1,
                                            )
                                        }
                                        onClose={onCloseAnnotation}
                                    />
                                </div>
                            )}
                        </>
                    ) : undefined
                }
            >
                {showAiDraft && <AiDraftBanner />}
                {isCase ? (
                    <CaseView
                        document={resolvedDocument}
                        activeQuote={active ? activeDocumentQuote : undefined}
                        quoteFocusKey={quoteFocusKey}
                        isLoading={isDocumentLoading}
                        error={documentError}
                        onRetry={retryDocument}
                        onClearQuote={() => setActiveCitationQuoteId(null)}
                    />
                ) : useStampedPdfViewer || viewType === "pdf" ? (
                    <PdfView
                        refetchKey={refetchKey}
                        doc={{
                            document_id: documentId,
                            version_id: versionId,
                        }}
                        rounded={false}
                        quotes={active ? activeViewerQuotes : undefined}
                        quoteFocusKey={quoteFocusKey}
                        onAiDraftStatus={setServerAiDraft}
                    />
                ) : viewType === "docx" ? (
                    <DocxView
                        onDownloadReady={
                            useTrackedChangesPreview
                                ? undefined
                                : handleDownloadReady
                        }
                        onSaveStateChange={onSaveStateChange}
                        cacheBytes={
                            useTrackedChangesPreview ? false : cacheBytes
                        }
                        displayUrl={trackedChangesPreviewUrl}
                        refetchKey={refetchKey}
                        onCloseGuardReady={onCloseGuardReady}
                        defaultMode={useTrackedChangesPreview ? "view" : "edit"}
                        canEdit={useTrackedChangesPreview ? false : canEdit}
                        // Read-only while hidden; a permission that resolves
                        // after mount can still enable editing. Preview is
                        // locked (N36): no toolbar, no save, no exportDocx.
                        toolbarVisible={
                            !useTrackedChangesPreview && canEdit && toolbarVisible
                        }
                        filename={resolvedDocument.title}
                        documentId={documentId}
                        versionId={versionId ?? undefined}
                        rounded={false}
                        quotes={active ? activeViewerQuotes : undefined}
                        quoteFocusKey={quoteFocusKey}
                        highlightEdit={active ? highlightEdit : null}
                        warning={warning ?? null}
                        onWarningDismiss={onWarningDismiss}
                        initialScrollTop={initialScrollTop ?? null}
                        onScrollChange={onScrollChange}
                    />
                ) : viewType === "spreadsheet" ? (
                    <SpreadsheetView
                        active={active}
                        documentId={documentId}
                        versionId={versionId}
                        rounded={false}
                        refetchKey={refetchKey}
                        highlightCells={
                            active ? activeHighlightCells : undefined
                        }
                    />
                ) : (
                    <PdfView
                        refetchKey={refetchKey}
                        doc={{
                            document_id: documentId,
                            version_id: versionId,
                        }}
                        rounded={false}
                        quotes={active ? activeViewerQuotes : undefined}
                        quoteFocusKey={quoteFocusKey}
                        onAiDraftStatus={setServerAiDraft}
                    />
                )}
            </DocumentAnnotationLayer>
        </div>
    );
}
