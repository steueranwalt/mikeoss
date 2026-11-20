import { useCallback, useEffect, useState } from "react";

import type { WordChatStorageMode } from "./wordChatTypes";

// Re-exported so existing consumers keep their import path. The definition
// lives in wordChatTypes.ts (Office-free) so pure helpers can be typechecked
// from the web app's test program, which has no Office runtime types.
export type { WordChatStorageMode };

/**
 * How model-proposed edits reach the document.
 *
 * - `approval`: validate and preview each edit before the user applies it.
 * - `direct`: apply each streamed edit immediately as a pending tracked
 *   change. Applied edits remain available for acceptance or rejection.
 *
 * Gate B4: `direct` is retained only as a type — `useWordEditApplyMode`
 * below never returns it and ignores any attempt to set it. Every Word edit
 * is reviewed before it reaches the document, and this is not a user
 * setting. See EditApplyModeMenu.tsx, which no longer offers `direct` as a
 * choice.
 */
export type WordEditApplyMode = "approval" | "direct";

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
