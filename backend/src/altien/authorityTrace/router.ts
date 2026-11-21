import { createHash } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { checkProjectAccess } from "../../lib/access";
import {
  getCitationVerificationRun,
} from "./core/service";
import {
  createCitationVerificationReview,
  getAuthorityTraceWorkspace,
  ReviewBindingChangedError,
} from "./core/reviewService";
import {
  AUTHORITY_TRACE_HTML_CSP,
  buildAuditHtml,
  buildReviewHtml,
} from "./core/htmlExports";
import { createServerSupabase } from "../../lib/supabase";
import { withAiDraftFilenamePrefix } from "../../lib/documentVersions";
import { ZodError } from "zod";

function authorityTraceMemoContentHash(memo: {
  document_id?: string;
  filename?: string;
  segments?: Array<{ text?: string }>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        document_id: memo.document_id ?? null,
        filename: memo.filename ?? null,
        segments: (memo.segments ?? []).map((segment) => segment.text ?? ""),
      }),
    )
    .digest("hex");
}

function authorityTraceHtmlConfirmToken(
  runId: string,
  kind: "review" | "audit",
  versionId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        run_id: runId,
        kind,
        ai_draft: true,
        version_id: versionId,
      }),
    )
    .digest("hex");
}

function markAuthorityTraceAiDraft(res: {
  setHeader: (name: string, value: string) => void;
}): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Mike-Ai-Draft", "1");
}

export const authorityTraceRouter = Router();

authorityTraceRouter.use(requireAuth);

authorityTraceRouter.get("/runs/:runId", async (req, res) => {
  try {
    const db = createServerSupabase();
    const run = await getCitationVerificationRun(req.params.runId, db);
    if (!run) {
      return res.status(404).json({ detail: "Verification run not found" });
    }

    const access = await checkProjectAccess(
      run.project_id,
      String(res.locals.userId ?? ""),
      res.locals.userEmail as string | undefined,
      db,
    );
    if (!access.ok) {
      return res.status(404).json({ detail: "Verification run not found" });
    }

    const workspace = await getAuthorityTraceWorkspace(run.id, db);
    if (!workspace) {
      return res.status(404).json({ detail: "Verification run not found" });
    }
    // Gate B4 N40 (Nils, 21.11.2026, 01:05 MEZ): Authority Trace is always
    // an AI draft — JSON, headers, and the panel banner all say so.
    markAuthorityTraceAiDraft(res);
    return res.json({ ...workspace, ai_draft: true });
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "Failed to load verification run";
    return res.status(500).json({ detail });
  }
});

for (const exportType of ["review", "audit"] as const) {
  authorityTraceRouter.get(
    `/runs/:runId/${exportType}.html`,
    async (req, res) => {
      try {
        const db = createServerSupabase();
        const run = await getCitationVerificationRun(req.params.runId, db);
        if (!run) {
          return res
            .status(404)
            .json({ detail: "Verification run not found" });
        }
        const access = await checkProjectAccess(
          run.project_id,
          String(res.locals.userId ?? ""),
          res.locals.userEmail as string | undefined,
          db,
        );
        if (!access.ok) {
          return res
            .status(404)
            .json({ detail: "Verification run not found" });
        }
        const workspace = await getAuthorityTraceWorkspace(run.id, db);
        if (!workspace) {
          return res
            .status(404)
            .json({ detail: "Verification run not found" });
        }
        const forced =
          req.query.force_degraded === "true" ||
          req.query.force_degraded === "1";
        if (!workspace.integrity.ok && !forced) {
          return res.status(409).json({
            detail:
              "Export blocked because memo or source integrity checks failed",
            integrity: workspace.integrity,
          });
        }
        const originalsRequested =
          req.query.include_originals === "true" ||
          req.query.include_originals === "1";
        const html =
          exportType === "review"
            ? buildReviewHtml(workspace, { originalsRequested })
            : buildAuditHtml(workspace, { originalsRequested });
        const filename = `authority-trace-${run.id}-${exportType}.html`;
        const memoVersionId =
          typeof workspace.memo.version_id === "string" &&
          workspace.memo.version_id
            ? workspace.memo.version_id
            : null;
        // A memo without version_id must not mint a token bound only to
        // run_id/kind. Bind the confirmation to the memo's content hash.
        const versionId =
          memoVersionId ?? authorityTraceMemoContentHash(workspace.memo);
        const expectedToken = authorityTraceHtmlConfirmToken(
          run.id,
          exportType,
          versionId,
        );
        const downloadRequested =
          req.query.download === "1" || req.query.download === "true";
        const confirmToken =
          typeof req.query.confirm_token === "string"
            ? req.query.confirm_token
            : undefined;
        // Gate B4 N35 (Nils, 21.11.2026, 01:05 MEZ): treat like the chat
        // export. Display is inline with the KI-Entwurf banner and
        // Cache-Control: no-store. Download/export needs confirmation and
        // the KI-Entwurf filename marking. Token is bound to the memo version.
        if (downloadRequested && confirmToken !== expectedToken) {
          return res.status(409).json({
            code: "unresolved_ai_edits",
            detail:
              "This Authority Trace HTML is an unreviewed AI draft. Confirm the download with the current confirm_token to get it marked as an AI draft.",
            confirm_token: expectedToken,
            version_id: versionId,
            ai_draft: true,
            pending_edit_ids: [],
          });
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        markAuthorityTraceAiDraft(res);
        res.setHeader("Content-Security-Policy", AUTHORITY_TRACE_HTML_CSP);
        res.setHeader(
          "Content-Disposition",
          downloadRequested
            ? `attachment; filename="${withAiDraftFilenamePrefix(filename)}"`
            : `inline; filename="${filename}"`,
        );
        return res.send(html);
      } catch (err) {
        const detail =
          err instanceof Error
            ? err.message
            : `Failed to build ${exportType} export`;
        return res.status(500).json({ detail });
      }
    },
  );
}

authorityTraceRouter.post("/runs/:runId/reviews", async (req, res) => {
  try {
    const db = createServerSupabase();
    const run = await getCitationVerificationRun(req.params.runId, db);
    if (!run) {
      return res.status(404).json({ detail: "Verification run not found" });
    }
    const access = await checkProjectAccess(
      run.project_id,
      String(res.locals.userId ?? ""),
      res.locals.userEmail as string | undefined,
      db,
    );
    if (!access.ok) {
      return res.status(404).json({ detail: "Verification run not found" });
    }

    const review = await createCitationVerificationReview(
      {
        runId: run.id,
        body: req.body,
        reviewerUserId: String(res.locals.userId ?? ""),
        reviewerEmail: (res.locals.userEmail as string | undefined) ?? null,
      },
      db,
    );
    return res.status(201).json(review);
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({
        detail: "Invalid review",
        issues: err.issues,
      });
    }
    if (err instanceof ReviewBindingChangedError) {
      return res.status(409).json({ detail: err.message });
    }
    const detail =
      err instanceof Error ? err.message : "Failed to save citation review";
    return res.status(500).json({ detail });
  }
});
