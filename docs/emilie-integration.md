# Emilie evaluation

[Emilie](https://github.com/veronica-builds/emilie) (AGPL-3.0, by Veronica
Lopez) is an independent fork of upstream Mike that targets a fully
self-hosted, Switzerland-based deployment: custom JWT/bcrypt authentication
instead of Supabase, a minimal MCP client, routing to a self-hosted
OpenAI-compatible model endpoint (for example Apertus served over vLLM), and
a short list of free Swiss open legal data sources.

This document records which parts of that fork were evaluated for this
Azure/Entra-based deployment, what was adopted, and why the rest was not.
`steueranwalt/mikeoss-emilie` does not exist (confirmed via repository lookup
and a GitHub-wide search); this evaluation uses `veronica-builds/emilie`
directly.

## Why this is documentation-only, not a code merge

Emilie's history is a single large "fork" commit that replaces upstream
Mike's tree with a much smaller, from-scratch backend and frontend (roughly
180 files, vs. upstream's 2,700+). A `git merge` of Emilie into this
deployment's tree would therefore delete most of the current application
rather than add to it. Each Emilie capability was instead compared against
this deployment's existing implementation and either found to already be
present in an equivalent or more hardened form, or rejected as incompatible
with the Entra authentication line. Nothing from Emilie's source tree is
copied into this codebase.

## MCP client

Emilie's `backend/src/lib/mcp.ts` is a single-file client: it reads
`MCP_SERVERS` as a JSON array of `{ name, url, apiKey, transport }`, supports
Streamable HTTP and (as a later commit added) SSE transport, and calls the
configured URL directly with no destination validation.

This deployment's MCP client (`backend/src/lib/mcp/`) already does
substantially more and is more hardened:

- Per-user, per-workspace connectors stored and encrypted at rest (Key
  Vault-backed encryption key, `backend/src/lib/mcp/client.ts`), not a single
  process-wide env var.
- OAuth (Dynamic Client Registration and pre-configured clients), not just
  static bearer tokens.
- An SSRF guard (`validateRemoteMcpUrl`, `guardedFetch` in
  `backend/src/lib/mcp/client.ts`) that resolves the hostname, rejects
  loopback/private/link-local/cloud-metadata addresses, pins the connection
  to the validated address (no DNS-rebinding TOCTOU window), and re-validates
  every redirect hop. Emilie's client has no equivalent check.
- A write-approval gate per connector/tool (`requireWriteApproval`,
  `isMcpWriteTool`/`mcpToolRequiresWriteAccess`), covered further in
  [Write actions and approvals](connectors.md#write-actions-and-approvals)
  (referred to as "Gate B4" in this integration's follow-up PR), with its own
  SSRF test suite (`backend/src/lib/mcp/__tests__/client.ssrf.test.ts`).

**Decision:** keep this deployment's MCP client as-is. Adopting Emilie's
simpler client would be a security regression, not a feature gain.

**Open point for a separate decision:** this deployment's client advertises
only `streamable_http` (`backend/src/lib/mcp/types.ts`); Emilie added a
legacy SSE transport. If an operator needs to reach an SSE-only MCP server,
adding that transport here should go through the same SSRF-guarded fetch path
and its own test coverage — not folded into this branch without dedicated
review, since it touches a security-sensitive, well-tested module.

## Local models (Apertus)

Emilie's `backend/src/lib/llm/localllm.ts` reads `VLLM_BASE_URL` /
`VLLM_API_KEY` and speaks the OpenAI-compatible `/chat/completions` API
directly — intended for a self-hosted Apertus (the Swiss Federal Institutes
of Technology's open LLM) served over vLLM.

This deployment already supports exactly that endpoint shape through its
generic declared-model registry (`backend/src/lib/llm/registry.ts`,
documented in [`docs/configured-models.md`](configured-models.md)):
`MIKE_MODEL_CONFIG_JSON` accepts a `provider: "openai-compatible"` entry with
`location: "local"` and an arbitrary `baseUrl`, including a private-network
address. A `tolerateTextToolCalls` middleware already exists for self-hosted
models (currently documented for Qwen/DeepSeek/GLM) that describe tool calls
as prose instead of structured calls — the same failure mode a smaller model
like Apertus can have.

An example entry for a self-hosted Apertus deployment was added to
`docs/configured-models.md`. No backend code changes were needed.

**Note on the upstream Ollama provider:** `backend/src/lib/llm/models.ts`
carries an explicit comment that upstream Mike's dynamically-discovered
Ollama provider (`ollama/<tag>` ids, `GET /models/ollama`) was deliberately
**not** ported to the Azure line, because an Azure deployment has no local
model runtime by default, and reactivating it was left for a dedicated,
intentional decision (sync-log `fe942475`). This evaluation does not change
that decision. Operators who run a local/self-hosted model, including
Apertus, continue to use the generic `MIKE_MODEL_CONFIG_JSON` route, which
already works today; reintroducing native Ollama auto-discovery is a
separate, larger question (does it bypass the configured-model guard rails,
does it need its own SSRF handling, etc.) and is left open for Nils Obenhaus
to decide.

## Swiss open legal data sources

Emilie's README lists four free, authentication-free Swiss legal data
sources as example MCP connectors: Entscheidsuche, OpenCaseLaw.ch, Online
Kommentar, and Fedlex. These are real, publicly documented Swiss legal data
providers (confirmed reachable at the time of writing). A corresponding
section was added to [`docs/connectors.md`](connectors.md) so an operator can
register them the same way as any other custom MCP connector — through
**Settings → Connectors → + Custom**, which already routes through this
deployment's SSRF-guarded fetch path.

The specific MCP endpoint paths Emilie's README names
(`mcp.entscheidsuche.ch`, `mcp.opencaselaw.ch`, `fedlex-connector.ch`) were
checked only for basic HTTP reachability, not for MCP protocol conformance,
response correctness, or current terms of use. An operator should verify each
source directly — including whether registering it requires the source
owner's permission — before enabling it for a workspace, and especially
before approving any write-capable tool it might expose (none are expected
from read-only legal databases, but the write-approval gate covers that case
regardless). No MCP server belonging to this firm, and no token-bearing MCP
URL, was called while preparing this documentation.

## Authentication — not adopted

Emilie replaces Supabase/Entra entirely with a custom JWT + bcrypt
authentication service. Per the task instructions for this integration,
Entra OIDC/JWKS validation and group-object-ID-based roles
(`backend/src/lib/auth/providers/entra.ts`, `backend/src/middleware/auth.ts`)
remain authoritative. Emilie's auth model is **not** adopted in any form: it
would bypass Entra/Conditional Access entirely, which is exactly what this
integration must not do. No JWT/bcrypt code from Emilie is present in this
branch.

## License and attribution

Mike, mikeOssAzure, and Emilie are all AGPL-3.0, so license terms are
compatible. Since no Emilie source was copied, no additional AGPL obligations
are triggered beyond this deployment's existing ones; Emilie is credited in
[`CREDITS.md`](../CREDITS.md) for the documentation ideas referenced above.
