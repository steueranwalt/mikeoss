"use client";

import { useCallback, useRef, useState } from "react";
import { AiDraftExportDialog } from "@/app/components/shared/AiDraftExportDialog";
import {
    unresolvedAiEditsFromError,
    type UnresolvedAiEditsDetails,
} from "@/app/lib/aiDraftConfirmation";

export class AiDraftExportCancelled extends Error {
    constructor() {
        super("AI draft export confirmation was cancelled");
        this.name = "AiDraftExportCancelled";
    }
}

/**
 * Gate B4 audit finding N12: run an export; if the server answers 409
 * `unresolved_ai_edits`, show a dialog bound to that response's version_id,
 * pending_edit_ids and confirm_token, then retry with the token.
 */
export function useAiDraftExport() {
    const [pending, setPending] = useState<UnresolvedAiEditsDetails | null>(
        null,
    );
    const [confirming, setConfirming] = useState(false);
    const waiter = useRef<{
        resolve: (accepted: boolean) => void;
    } | null>(null);

    const confirmExport = useCallback(
        async <T,>(
            action: (confirmToken?: string) => Promise<T>,
        ): Promise<T> => {
            try {
                return await action();
            } catch (error) {
                const details = unresolvedAiEditsFromError(error);
                if (!details) throw error;
                const accepted = await new Promise<boolean>((resolve) => {
                    waiter.current = { resolve };
                    setPending(details);
                });
                if (!accepted) throw new AiDraftExportCancelled();
                setConfirming(true);
                try {
                    return await action(details.confirmToken);
                } finally {
                    setConfirming(false);
                }
            }
        },
        [],
    );

    const finish = useCallback((accepted: boolean) => {
        waiter.current?.resolve(accepted);
        waiter.current = null;
        setPending(null);
    }, []);

    const dialog = (
        <AiDraftExportDialog
            open={!!pending}
            details={pending}
            confirming={confirming}
            onConfirm={() => finish(true)}
            onCancel={() => finish(false)}
        />
    );

    return { confirmExport, dialog };
}
