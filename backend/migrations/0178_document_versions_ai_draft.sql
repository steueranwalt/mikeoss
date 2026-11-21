-- Gate B4 audit finding L4: a new document a model created on its own
-- (generate_docx/generate_excel/generate_ppt, write_project_document) is
-- visibly marked "AI draft" until a human clears it — a field the
-- application sets, plus a visible UI indicator (frontend). edit_document
-- and any overwrite of an existing document instead go through the
-- approval flow in connectorApprovals.ts and never touch this column.
--
-- Idempotent: safe to re-run.

alter table public.document_versions
  add column if not exists ai_draft boolean not null default false;

create index if not exists document_versions_ai_draft_idx
  on public.document_versions(document_id)
  where ai_draft;
