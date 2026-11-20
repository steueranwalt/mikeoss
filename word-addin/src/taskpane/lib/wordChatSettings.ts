import { useCallback, useEffect, useState } from "react";

import type { WordChatStorageMode } from "./wordChatTypes";

// Re-exported so existing consumers keep their import path. The definition
// lives in wordChatTypes.ts (Office-free) so pure helpers can be typechecked
// from the web app's test program, which has no Office runtime types.
export type { WordChatStorageMode };

/**
 * How model-proposed edits reach the document. Always `"approval"`:
 * validate and preview each edit before the user applies it.
 *
 * Gate B4 audit finding N13: `"direct"` (apply each streamed edit
 * immediately as a pending tracked change, skipping review) used to be
 * retained as a type value even though nothing could construct it anymore
 * (`useWordEditApplyMode` below never returns it, and `scheduleDirectEdit` —
 * the function that used to build on it — was removed). A type that still
 * names a capability the application no longer has is itself a liability:
 * it is one incautious change away from becoming constructible again
 * without the type system raising an error anywhere. This type is a single
 * literal rather than a union for the same reason connectorSettingsPatch
 * silently drops requireWriteApproval instead of validating it — the value
 * cannot exist, not merely "is validated to be approval".
 */
export type WordEditApplyMode = "approval";

const STORAGE_KEY = "mike_word_chat_storage_mode";

function storageKey(ownerId: string): string {
  return `${STORAGE_KEY}:${ownerId}`;
}

export function useWordChatStoragePreference(ownerId: string | null): {
  mode: WordChatStorageMode;
  loading: boolean;
  setMode: (mode: WordChatStorageMode) => Promise<void>;
} {
  const [mode, setModeState] = useState<WordChatStorageMode>("cloud");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ownerId) {
      setModeState("cloud");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void OfficeRuntime.storage
      .getItem(storageKey(ownerId))
      .then((stored) => {
        if (!cancelled && stored === "local") setModeState("local");
      })
      .catch(() => {
        // Fail closed. A failed read cannot tell an unset preference from a
        // stored "local" (never persist server-side), and only one of those
        // mistakes is recoverable: staying local keeps this chat on the
        // device, while defaulting to cloud would silently upload the chats of
        // a user who explicitly opted out.
        if (!cancelled) setModeState("local");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId]);

  const setMode = useCallback(
    async (next: WordChatStorageMode) => {
      if (!ownerId) throw new Error("Sign in before changing chat storage.");
      await OfficeRuntime.storage.setItem(storageKey(ownerId), next);
      setModeState(next);
    },
    [ownerId],
  );

  return { mode, loading, setMode };
}

/**
 * Gate B4: always "approval", and `setMode` is a no-op. This was previously
 * a per-device preference backed by OfficeRuntime.storage (key
 * "mike_word_edit_apply_mode"); that storage key is no longer read or
 * written, so a device with "direct" saved from before this change is
 * unaffected — it simply stops being read. `setMode` stays in the returned
 * shape (rather than being removed) so callers do not need their own change;
 * see EditApplyModeMenu.tsx for the UI side of this.
 */
export function useWordEditApplyMode(): {
  mode: WordEditApplyMode;
  setMode: (mode: WordEditApplyMode) => void;
} {
  return { mode: "approval", setMode: () => {} };
}
