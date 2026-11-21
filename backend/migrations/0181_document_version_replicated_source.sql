-- Gate B4 audit finding N14: replicate_document used to insert its new
-- version rows with source 'upload' — the same value migration 0123's
-- "publish file" RPC (and several other migrations' default for an
-- unspecified source) gives a genuine human upload. The 0180 backfill could
-- not tell those apart, so it had to leave 'upload' out of its
-- draft-indicating sources entirely; this migration gives replicate_document
-- its own unambiguous value going forward.

alter table public.document_versions
  drop constraint if exists document_versions_source_check;

alter table public.document_versions
  add constraint document_versions_source_check
    check (source = any (array[
      'upload'::text,
      'user_upload'::text,
      'assistant_edit'::text,
      'user_accept'::text,
      'user_reject'::text,
      'generated'::text,
      'external_retrieval'::text,
      'skill_import'::text,
      'tool_write'::text,
      'replicated'::text
    ]));
