// Settings shared by the native Google connectors (Drive, Gmail, Calendar).
// Each stores them on its own grant row; the column names and the
// disabled-tool list behave the same way for all three.

export type NativeConnectorSettings = {
    enabled?: boolean;
    // Gate B4: write approval is mandatory and not user-configurable — see
    // the comment on connectorSettingsPatch below. The field stays in this
    // type only so a caller that still sends it does not hit a type error;
    // the patch builder silently ignores it.
    requireWriteApproval?: boolean;
    readOnly?: boolean;
};

/**
 * The grant-row columns to update; empty when nothing valid was sent.
 *
 * Gate B4: `requireWriteApproval` is deliberately not settable here. Every
 * write-capable action on a native connector must be approved by the user
 * before it runs; this is no longer a per-connector choice. The database
 * column still exists (checked `true` by migration 0176) so no other code
 * needs to change, but nothing in this application may ever write `false`
 * to it again. A caller that still sends `requireWriteApproval` (old
 * frontend build, direct API call) has that field quietly dropped rather
 * than rejected, so turning the gate on everywhere does not turn a stale
 * client's settings save into an error.
 */
export function connectorSettingsPatch(
    settings: NativeConnectorSettings,
): Record<string, boolean> {
    const patch: Record<string, boolean> = {};
    if (typeof settings.enabled === "boolean") patch.enabled = settings.enabled;
    if (typeof settings.readOnly === "boolean")
        patch.read_only = settings.readOnly;
    return patch;
}

/** The disabled-tool list after switching one tool on or off. */
export function toggleDisabledTool(
    current: readonly string[],
    toolName: string,
    enabled: boolean,
): string[] {
    return enabled
        ? current.filter((name) => name !== toolName)
        : [...new Set([...current, toolName])];
}
