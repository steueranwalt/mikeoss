import { DefaultAzureCredential } from "@azure/identity";

// Entra app registrations can trust this backend's own Azure managed
// identity as a federated credential issuer instead of (or alongside) a
// client secret. When a Federated Identity Credential (FIC) is configured on
// the app registration — subject = this managed identity's object ID, issuer
// = https://login.microsoftonline.com/<MI-tenant>/v2.0, audience =
// api://AzureADTokenExchange — a token minted for that reserved audience is a
// valid `client_assertion` (RFC 7523 JWT bearer) for the authorization_code
// and refresh_token grants normally sent with a `client_secret`. This lets a
// deployment authenticate its own OAuth client to Entra without ever holding
// (or rotating, or leaking) a client secret.
//
// See: https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity
const AZURE_AD_TOKEN_EXCHANGE_SCOPE = "api://AzureADTokenExchange/.default";
export const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

let credential: DefaultAzureCredential | undefined;
function sharedCredential(): DefaultAzureCredential {
  // Same construction as lib/config.ts's Key Vault client: DefaultAzureCredential
  // picks the Container App's user-assigned managed identity from AZURE_CLIENT_ID.
  if (!credential) credential = new DefaultAzureCredential();
  return credential;
}

/** Test seam. */
export function resetEntraClientAssertionCredential(): void {
  credential = undefined;
}

type CachedAssertion = { token: string; expiresOnMs: number };
let cached: CachedAssertion | undefined;

// Refresh well before expiry so a slow token exchange never races a token
// that is still "valid" by a few seconds when Entra receives it.
const EXPIRY_SKEW_MS = 2 * 60_000;

/**
 * Resolve a fresh client-assertion JWT for the backend's own managed
 * identity, or `null` when no managed identity is available (local
 * development, a deployment that has not opted into workload identity
 * federation, or a transient credential failure). Callers must fall back to
 * `client_secret` when this returns `null` — it is not an error path, it is
 * the expected shape for any non-federated deployment.
 */
export async function federatedClientAssertion(): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresOnMs - EXPIRY_SKEW_MS > now) return cached.token;
  try {
    const result = await sharedCredential().getToken(AZURE_AD_TOKEN_EXCHANGE_SCOPE);
    if (!result?.token) return null;
    cached = { token: result.token, expiresOnMs: result.expiresOnTimestamp };
    return result.token;
  } catch {
    // No managed identity bound to this process (e.g. local dev, or a
    // deployment that only uses a client secret). Never throw: the caller
    // falls back to client_secret.
    return null;
  }
}
