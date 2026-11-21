"use client";

/** Gate B4 audit finding N12: the list/detail marker for an unreviewed AI draft. */
export function AiDraftBadge() {
    return (
        <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
            KI-Entwurf
        </span>
    );
}
