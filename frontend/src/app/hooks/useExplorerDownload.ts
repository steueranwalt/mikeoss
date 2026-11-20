"use client";

import { useRef, useState } from "react";
import { downloadDocumentsZip, getDocumentUrl } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Document, Folder } from "@/app/components/shared/types";
import {
    AiDraftExportCancelled,
    useAiDraftExport,
} from "@/app/hooks/useAiDraftExport";

export function useExplorerDownload() {
    const busyRef = useRef(false);
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { confirmExport, dialog } = useAiDraftExport();

    async function download(target: {
        kind: "document" | "folder";
        id: string;
        filename: string;
        versionId?: string | null;
    }) {
        if (busyRef.current) return;
        busyRef.current = true;
        setDownloading(true);
        setError(null);
        let objectUrl: string | null = null;
        try {
            let url: string;
            let filename = target.filename;
            if (target.kind === "document") {
                const file = await confirmExport((confirmToken) =>
                    target.versionId
                        ? getDocumentUrl(target.id, target.versionId, confirmToken)
                        : getDocumentUrl(target.id, undefined, confirmToken),
                );
                url = file.url;
                filename = file.filename || filename;
            } else {
                const archive = await downloadDocumentsZip([], [target.id]);
                objectUrl = URL.createObjectURL(archive);
                url = objectUrl;
            }
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
        } catch (cause) {
            if (cause instanceof AiDraftExportCancelled) return;
            setError(
                userFacingApiError(
                    cause,
                    "The file or folder could not be downloaded. Please try again.",
                ),
            );
        } finally {
            if (objectUrl) {
                const completedUrl = objectUrl;
                window.setTimeout(() => URL.revokeObjectURL(completedUrl), 1000);
            }
            busyRef.current = false;
            setDownloading(false);
        }
    }

    return {
        downloading,
        error,
        confirmation: dialog,
        clearError: () => setError(null),
        downloadDocument: (document: Document, versionId?: string | null) =>
            download({
                kind: "document",
                id: document.id,
                filename: document.filename,
                versionId,
            }),
        downloadFolder: (folder: Folder) =>
            download({
                kind: "folder",
                id: folder.id,
                filename: `${folder.name}.zip`,
            }),
    };
}
