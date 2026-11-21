"use client";

/**
 * Gate B4 audit findings N12/N17/N20: the in-app viewer is a display, not an
 * export, so it is not gated on confirmation — but an unreviewed AI draft
 * must still be labelled as one while it is on screen.
 */
export function AiDraftBanner() {
    return (
        <div
            role="status"
            className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-950"
        >
            KI-Entwurf, nicht freigegeben
        </div>
    );
}
