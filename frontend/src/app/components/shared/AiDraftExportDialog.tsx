"use client";

import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import type {
    UnresolvedAiEditsDetails,
    UnresolvedAiEditsZipDocument,
} from "@/app/lib/aiDraftConfirmation";

/**
 * Gate B4 audit finding N12: export confirmation is bound to the version
 * and pending-edit ids (via their hash, confirm_token) the 409 named, not
 * a blanket "I confirm" flag.
 */
export function AiDraftExportDialog({
    open,
    details,
    zipDocuments = null,
    confirming = false,
    onConfirm,
    onCancel,
}: {
    open: boolean;
    details: UnresolvedAiEditsDetails | null;
    zipDocuments?: UnresolvedAiEditsZipDocument[] | null;
    confirming?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const pendingCount = details?.pendingEditIds.length ?? 0;
    const reasons = [
        details?.aiDraft ? "an unapproved AI draft" : null,
        pendingCount > 0
            ? `${pendingCount} pending AI-proposed edit${pendingCount === 1 ? "" : "s"}`
            : null,
    ].filter((part): part is string => part != null);
    const zipNames = zipDocuments?.map((doc) => doc.filename) ?? [];

    return (
        <ConfirmPopup
            open={open}
            title="Export AI draft?"
            message={
                zipDocuments && zipDocuments.length > 0 ? (
                    <div className="space-y-2">
                        <p>
                            {zipDocuments.length === 1
                                ? "One selected file is an unapproved AI draft or has pending AI-proposed edits."
                                : `${zipDocuments.length} selected files are unapproved AI drafts or have pending AI-proposed edits.`}{" "}
                            Exporting marks those copies as AI drafts. Confirming
                            is bound to each file's confirm_token.
                        </p>
                        <ul className="list-disc space-y-1 pl-4 font-mono text-[11px] text-gray-600">
                            {zipNames.map((name) => (
                                <li key={name} className="break-all">
                                    {name}
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : details ? (
                    <div className="space-y-2">
                        <p>
                            This file has {reasons.join(" and ")}. Exporting
                            it marks the copy as an AI draft. Confirming is
                            bound to this version and the pending edits below
                            — a later change invalidates this confirmation.
                        </p>
                        <dl className="space-y-1 font-mono text-[11px] text-gray-600">
                            <div>
                                <dt className="inline text-gray-500">
                                    version_id:{" "}
                                </dt>
                                <dd className="inline break-all">
                                    {details.versionId}
                                </dd>
                            </div>
                            <div>
                                <dt className="inline text-gray-500">
                                    pending_edit_ids:{" "}
                                </dt>
                                <dd className="inline break-all">
                                    {details.pendingEditIds.length > 0
                                        ? details.pendingEditIds.join(", ")
                                        : "none"}
                                </dd>
                            </div>
                            <div>
                                <dt className="inline text-gray-500">
                                    confirm_token:{" "}
                                </dt>
                                <dd className="inline break-all">
                                    {details.confirmToken}
                                </dd>
                            </div>
                        </dl>
                    </div>
                ) : null
            }
            confirmLabel="Export anyway"
            confirmStatus={confirming ? "loading" : "idle"}
            cancelLabel="Cancel"
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    );
}
