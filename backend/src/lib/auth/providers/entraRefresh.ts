import { getConfig } from "../../config";
import { CLIENT_ASSERTION_TYPE, federatedClientAssertion } from "./entraClientAssertion";

/** Refresh a server-held Entra credential. Never expose the refresh token to JS. */
export async function renewEntraCredential(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}> {
  const [tenantId, clientId, clientSecret, backendId] = await Promise.all([
    getConfig("entra-tenant-id"),
    getConfig("entra-client-id"),
    // See entraConfiguration() in auth.routes.ts: optional once a federated
    // credential is configured.
    getConfig("entra-client-secret").catch(() => ""),
    getConfig("entra-backend-client-id"),
  ]);
  const scope = process.env.ENTRA_AUTH_SCOPES || `openid profile email offline_access api://${backendId}/access_as_user`;
  // Same federated-credential-first, client-secret-fallback precedence as
  // the authorization_code exchange in auth.routes.ts — see
  // entraClientAssertion.ts for why this never needs a feature flag.
  const assertion = await federatedClientAssertion();
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope,
  });
  if (assertion) {
    form.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    form.set("client_assertion", assertion);
  } else if (clientSecret) {
    form.set("client_secret", clientSecret);
  }
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token || !Number.isFinite(body.expires_in)) {
    throw new Error("Entra session refresh failed");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(1, body.expires_in!) * 1000),
  };
}
