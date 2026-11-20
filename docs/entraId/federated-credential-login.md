# Entra login without a client secret (federated credential)

By default this deployment's Entra OAuth flows (end-user sign-in, Word
add-in sign-in, session refresh, and the `/install` admin bootstrap) exchange
an authorization code or refresh token for an access token using the Web
Login app registration's `client_id` and `client_secret`. A client secret is
a long-lived shared value that someone has to generate, store, rotate, and
eventually leak.

An Azure deployment that already runs as a user-assigned managed identity
(the same identity used for Key Vault reads, see `AZURE_CLIENT_ID` in
`docs/azure-prereqs.md`) can instead let Entra trust that identity directly,
using a [Federated Identity Credential](https://learn.microsoft.com/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity)
(FIC) on the Web Login app registration. No secret is generated, stored, or
rotated for this flow at all.

## How it works

1. On every token exchange, the backend asks its own managed identity
   (`backend/src/lib/auth/providers/entraClientAssertion.ts`, via
   `DefaultAzureCredential`) for a token scoped to the reserved audience
   `api://AzureADTokenExchange`.
2. If the FIC below is configured, Entra issues that token and the backend
   sends it as `client_assertion` (`client_assertion_type:
   urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, RFC 7523)
   instead of `client_secret`.
3. If no managed identity is available (local development, or a deployment
   that has not set up a FIC), the credential call fails and the backend
   **falls back to `ENTRA_CLIENT_SECRET` / the Key Vault `entra-client-secret`
   secret automatically** — no feature flag, no code change, no restart
   needed once a FIC is added later.

This applies uniformly to the authorization-code exchange, the refresh-token
exchange, and the `/install` admin OIDC sign-in, since all three use the same
Web Login app registration.

## Configuring the Federated Identity Credential

This is a one-time, per-deployment setup step performed by whoever manages
the Entra app registrations (the existing `create-entra-apps.ps1` flow does
not do this automatically). All values below are placeholders.

1. In the Microsoft Entra admin center, open the **Web Login** app
   registration (the one whose `ENTRA_CLIENT_ID` this deployment uses) →
   **Certificates & secrets** → **Federated credentials** → **Add
   credential**.
2. Choose **Other issuer** (or the "Managed identity" template if your tenant
   offers it) and set:
   - **Issuer**: `https://login.microsoftonline.com/<managed-identity-tenant-id>/v2.0`
   - **Subject identifier**: the managed identity's **object ID** (not its
     client ID) — found on the identity's **Overview** page in the portal.
   - **Audience**: `api://AzureADTokenExchange`
3. Give it a descriptive name (for example `container-app-managed-identity`)
   and save.
4. No application configuration changes are needed on this side: the backend
   already tries the federated path first (step 1 above) and only needs
   `AZURE_CLIENT_ID` set, which every deployment using Key Vault already has.
5. `ENTRA_CLIENT_SECRET` can be left unset once the FIC above is confirmed
   working. Keep it configured during the cutover — a bad or not-yet-propagated
   FIC falls back to it automatically, so there is no outage window.

## Verifying it worked

Sign in once after adding the FIC and confirm the deployment's logs show no
`client_secret`-related errors from the token endpoint. There is no separate
status flag: a successful sign-in with `ENTRA_CLIENT_SECRET` unset is the
confirmation.

`/admin/diagnostics` stops flagging `ENTRA_CLIENT_SECRET` as missing once
`AZURE_CLIENT_ID` is set, since it is then plausible — but not certain — that
a FIC covers it; the diagnostics page cannot itself query Entra for the FIC's
existence.

## Limitations

- This only replaces the client secret used by *this backend's own* OAuth
  client (the Web Login app registration). It does not change how Entra
  authenticates end users, and it does not touch the Backend API app
  registration's JWKS-based access-token validation
  (`backend/src/lib/auth/providers/entra.ts`), which never used a secret.
- Requires the managed identity feature to be reachable from wherever the
  backend runs (Azure Container Apps, App Service, AKS with workload
  identity, etc.). It is a no-op — not an error — anywhere else, including
  local development.
