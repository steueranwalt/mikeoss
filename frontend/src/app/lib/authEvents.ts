export const AUTH_SESSION_INVALIDATED_EVENT = "mike:auth-session-invalidated";
let authEpoch = 0;
const epochListeners = new Set<() => void>();
export function currentAuthEpoch(): number { return authEpoch; }
export function advanceAuthEpoch(): void {
    authEpoch += 1;
    for (const listener of [...epochListeners]) listener();
}
export function subscribeAuthEpoch(listener: () => void): () => void {
    epochListeners.add(listener);
    return () => { epochListeners.delete(listener); };
}

/**
 * Fetch an authenticated application resource and immediately invalidate the
 * browser's in-memory auth state when the backend rejects the session.
 */
function requestHref(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

/**
 * Gate B4 N41: a 401/404 on the tracked-changes preview is a missing or
 * spent ticket, not a dead session. Signing out here made the Prüfansicht
 * unload the whole workspace.
 */
function isTrackedChangesPreviewGet(
    input: RequestInfo | URL,
    init?: RequestInit,
): boolean {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") return false;
    const href = requestHref(input);
    return (
        href.includes("/tracked-changes-preview") &&
        !href.includes("/tracked-changes-preview/ticket")
    );
}

export async function authenticatedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const response = await globalThis.fetch(input, {
        ...init,
        credentials: "include",
    });

    if (
        response.status === 401 &&
        typeof window !== "undefined" &&
        !isTrackedChangesPreviewGet(input, init)
    ) {
        window.dispatchEvent(new Event(AUTH_SESSION_INVALIDATED_EVENT));
    }

    return response;
}
