import React from "react";
import { Eye } from "lucide-react";
import type { WordEditApplyMode } from "../../lib/wordChatSettings";

/**
 * Gate B4: edits always go through review — there is no longer a second
 * mode to choose, so this renders a static, non-interactive indicator
 * instead of the dropdown it used to be. `mode`/`onModeChange` stay in the
 * props so the composer that places this control does not need its own
 * change; `onModeChange` is accepted but never called.
 */
export function EditApplyModeMenu({
    mode: _mode,
    onModeChange: _onModeChange,
}: {
    mode: WordEditApplyMode;
    onModeChange: (mode: WordEditApplyMode) => void;
}): React.ReactElement {
    return (
        <span
            aria-label="Edits are reviewed before they reach the document"
            title="Edits are reviewed before they reach the document. This cannot be turned off."
            data-testid="edit-apply-toggle"
            className="flex h-8 shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 text-sm text-gray-400"
        >
            <Eye className="h-3.5 w-3.5 shrink-0" />
            <span>Review</span>
        </span>
    );
}
