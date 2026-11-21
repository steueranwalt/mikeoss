"use client";

import { useCallback, useRef, useState } from "react";
import { AiDraftExportDialog } from "@/app/components/shared/AiDraftExportDialog";
import {
    unresolvedAiEditsFromError,
    unresolvedAiEditsZipFromError,
    type UnresolvedAiEditsDetails,
    type UnresolvedAiEditsZipDocument,
} from "@/app/lib/aiDraftConfirmation";

export class AiDraftExportCancelled extends Error {
    constructor() {
        super("AI draft export confirmation was cancelled");
        this.name = "AiDraftExportCancelled";
    }
}

/**
 * Gate B4 audit finding N12/N26: run an export; if the server answers 409
 * `unresolved_ai_edits`, show a dialog bound to that response, then retry
 * with the token (single file) or per-document tokens (zip).
 */
export function useAiDraftExport() {
    const [pending, setPending] = useState<UnresolvedAiEditsDetails | null>(
        null,
    );
    const [zipPending, setZipPending] = useState<
        UnresolvedAiEditsZipDocument[] | null
    >(null);
    const [confirming, setConfirming] = useState(false);
    const waiter = useRef<{
        resolve: (accepted: boolean) => void;
    } | null>(null);

    const ask = useCallback(async (): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            waiter.current = { resolve };
        });
    }, []);

    const confirmExport = useCallback(
        async <T,>(
            action: (confirmToken?: string) => Promise<T>,
        ): Promise<T> => {
            try {
                return await action();
            } catch (error) {
                const details = unresolvedAiEditsFromError(error);
                if (!details) throw error;
                setPending(details);
                const accepted = await ask();
                if (!accepted) throw new AiDraftExportCancelled();
                setConfirming(true);
                try {
                    return await action(details.confirmToken);
                } finally {
                    setConfirming(false);
                }
            }
        },
        [ask],
    );

    const confirmZipExport = useCallback(
        async <T,>(
            action: (confirmTokens?: Record<string, string>) => Promise<T>,
        ): Promise<T> => {
            try {
                return await action();
            } catch (error) {
                const documents = unresolvedAiEditsZipFromError(error);
                if (!documents) throw error;
                setZipPending(documents);
                const accepted = await ask();
                if (!accepted) throw new AiDraftExportCancelled();
                setConfirming(true);
                try {
                    return await action(
                        Object.fromEntries(
                            documents.map((doc) => [doc.documentId, doc.confirmToken]),
                        ),
                    );
                } finally {
                    setConfirming(false);
                }
            }
        },
        [ask],
    );

    const finish = useCallback((accepted: boolean) => {
        waiter.current?.resolve(accepted);
        waiter.current = null;
        setPending(null);
        setZipPending(null);
    }, []);

    const dialog = (
        <AiDraftExportDialog
            open={!!pending || !!zipPending}
            details={pending}
            zipDocuments={zipPending}
            confirming={confirming}
            onConfirm={() => finish(true)}
            onCancel={() => finish(false)}
        />
    );

    return { confirmExport, confirmZipExport, dialog };
}
