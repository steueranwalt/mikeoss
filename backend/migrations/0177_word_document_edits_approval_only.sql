-- Gate B4 audit finding L2: apply_mode could still be 'direct' (apply
-- without review) at the database layer, even though the backend's own
-- Gate B4 work locked the Word add-in's UI to "approval" and the route
-- handler now rejects "direct" with 400 (see parseEditApplyMode in
-- wordChat.routes.ts). This migration makes the database refuse it too,
-- independent of any future application bug — the same pattern as
-- 0176_require_write_approval_locked.sql.
--
-- Backfill first so the narrower CHECK constraint that follows does not
-- fail on an existing 'direct' row from before this change.
-- Idempotent: safe to re-run.

update public.word_document_edits
  set apply_mode = 'approval'
  where apply_mode is distinct from 'approval';

alter table public.word_document_edits
  drop constraint if exists word_document_edits_apply_mode_check;
alter table public.word_document_edits
  add constraint word_document_edits_apply_mode_check
    check (apply_mode = 'approval');
