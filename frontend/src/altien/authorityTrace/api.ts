import { bounceIfUnauthorized } from "@/app/lib/auth-token";
import {
  API_BASE,
  MikeApiError,
  apiRequest,
  getAuthHeader,
} from "@/app/lib/mikeApi";

export type AuthorityTraceVerdict =
  | "verified"
  | "needs_attention"
  | "rejected";

export type AuthorityTraceSegment = {
  text: string;
  highlights: string[];
};

export type AuthorityTraceReview = {
  id: string;
  run_id: string;
  citation_id: string;
  binds_to: string;
  verdict: AuthorityTraceVerdict;
  note: string | null;
  reviewer_user_id: string;
  reviewer_email: string | null;
  created_at: string;
  stale: boolean;
};

export type AuthorityTraceCitation = {
  id: string;
  source_candidates: string[];
  cite_text: string;
  proposition: string;
  support_type: "quotation" | "paraphrase";
  status: "anchored" | "no_quote_claimed" | "anchor_failed";
  failure_reason?: string;
  binds_to: string;
  warnings: string[];
  memo_anchor: {
    start: number;
    end: number;
    quote: string;
    match: "exact" | "normalized" | "hyphenless";
    warnings: string[];
  } | null;
  anchors: Array<{
    source: string;
    quote: string;
    start: number;
    end: number;
    match: "exact" | "normalized" | "hyphenless";
    warnings: string[];
  }>;
};

export type AuthorityTraceWorkspace = {
  id: string;
  project_id: string;
  created_at: string;
  verified_record: {
    citations: AuthorityTraceCitation[];
  };
  report: {
    outcome: "success" | "completed_with_failures";
    total: number;
    anchored: number;
    failed: number;
    no_quote_claimed: number;
    exact: number;
    formatting_different: number;
  };
  memo: {
    document_id: string;
    version_id: string;
    filename: string;
    available: boolean;
    integrity: "ok" | "changed" | "missing";
    segments: AuthorityTraceSegment[];
  };
  sources: Record<
    string,
    {
      document_id: string;
      version_id: string;
      filename: string;
      title: string;
      kind: string;
      available: boolean;
      integrity: "ok" | "changed" | "missing";
      segments: AuthorityTraceSegment[];
    }
  >;
  reviews: AuthorityTraceReview[];
  current_reviews: Record<string, AuthorityTraceReview>;
  integrity: {
    ok: boolean;
    warnings: Array<{
      scope: "memo" | "source";
      source?: string;
      status: "changed" | "missing";
      message: string;
    }>;
  };
  /** Gate B4 N40: Authority Trace is always an unreviewed AI draft. */
  ai_draft: boolean;
};

export async function getAuthorityTraceRun(
  runId: string,
): Promise<AuthorityTraceWorkspace> {
  return apiRequest<AuthorityTraceWorkspace>(
    `/authority-trace/runs/${encodeURIComponent(runId)}`,
  );
}

export async function saveAuthorityTraceReview(
  runId: string,
  payload: {
    citation_id: string;
    binds_to: string;
    verdict: AuthorityTraceVerdict;
    note?: string | null;
  },
): Promise<AuthorityTraceReview> {
  return apiRequest<AuthorityTraceReview>(
    `/authority-trace/runs/${encodeURIComponent(runId)}/reviews`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function downloadAuthorityTraceExport(
  runId: string,
  kind: "review" | "audit",
  options: { forceDegraded?: boolean; confirmToken?: string } = {},
): Promise<void> {
  const authHeaders = await getAuthHeader();
  const params = new URLSearchParams();
  // Gate B4 N38: panel export is a download, same confirmation path as chat.
  params.set("download", "1");
  if (options.forceDegraded) params.set("force_degraded", "true");
  if (options.confirmToken) params.set("confirm_token", options.confirmToken);
  const response = await fetch(
    `${API_BASE}/authority-trace/runs/${encodeURIComponent(runId)}/${kind}.html?${params}`,
    { headers: authHeaders, credentials: "include" },
  );
  bounceIfUnauthorized(response);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    throw new MikeApiError({
      message:
        typeof payload?.detail === "string"
          ? payload.detail
          : `Export failed: ${response.status}`,
      status: response.status,
      code: typeof payload?.code === "string" ? payload.code : null,
      details: payload,
    });
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const named = /filename="([^"]+)"/i.exec(disposition)?.[1];
  const fallback = `authority-trace-${runId}-${kind}.html`;
  const filename =
    named?.startsWith("[KI-ENTWURF] ")
      ? named
      : `[KI-ENTWURF] ${named ?? fallback}`;
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
