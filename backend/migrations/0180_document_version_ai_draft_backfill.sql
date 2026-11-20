-- Gate B4 audit finding N13: migration 0178 added `ai_draft` with
-- `default false`, so every version that existed before that migration
-- shipped — including every generate_docx/generate_excel/generate_ppt and
-- write_project_document output created before the column (and the
-- application code that now sets it at insert time, Gate B4 audit finding
-- N9) existed — silently reads as "not a draft", even though nobody ever
-- called approve-draft on it. This backfills those rows to the state the
-- application would have produced had the column existed all along.
--
-- A version's own source marks it a draft outright when it is one of the
-- two unambiguous AI-creation sources ('generated', 'tool_write' —
-- generate_docx/xlsx/pptx and write_project_document respectively; see
-- documentOps.ts, projectDocumentWrites.ts). replicate_document is
-- deliberately NOT included here (Gate B4 audit finding N14): before
-- migration 0181 gave it its own 'replicated' source, it inserted its
-- version rows with source 'upload' — the exact same value migration
-- 0123's "publish file" RPC (and several other migrations' default for an
-- unspecified source) gives a genuine human upload. There is no way to
-- tell a pre-0181 replicated copy apart from a real upload by source
-- alone, so this backfill leaves every 'upload'-sourced row untouched
-- rather than risk flagging human uploads as unapproved AI drafts; only a
-- replicated copy created after 0181 ships is correctly flagged, via the
-- application code (Gate B4 audit finding N8), not this backfill.
--
-- A tracked-change edit ('assistant_edit') never sets the flag itself (Gate
-- B4 audit finding N10: edit_document goes through its own approval flow,
-- never this column) — it inherits whatever the version right before it
-- resolved to, exactly like documents.trackedEdits.ts does for every new
-- version going forward. Any other source ('upload', 'user_upload',
-- 'user_accept', 'user_reject', 'external_retrieval', 'skill_import') is a
-- human or a different pipeline replacing the content outright, which
-- resets the inherited state to false — there is no historical
-- approve-draft record to consult, so an explicit human-sourced version is
-- the only signal available that the chain starts over.
--
-- Idempotent: only ever flips false -> true, and a second run recomputes
-- the same chain and changes nothing.

with recursive ordered as (
  select
    id,
    document_id,
    source,
    row_number() over (
      partition by document_id
      order by version_number nulls last, created_at, id
    ) as rn
  from public.document_versions
),
chain as (
  select
    o.id,
    o.document_id,
    o.rn,
    (o.source in ('generated', 'tool_write')) as computed_ai_draft
  from ordered o
  where o.rn = 1
  union all
  select
    o.id,
    o.document_id,
    o.rn,
    case
      when o.source in ('generated', 'tool_write') then true
      when o.source = 'assistant_edit' then c.computed_ai_draft
      else false
    end as computed_ai_draft
  from ordered o
  join chain c
    on c.document_id = o.document_id
   and c.rn = o.rn - 1
)
update public.document_versions dv
set ai_draft = true
from chain c
where dv.id = c.id
  and c.computed_ai_draft = true
  and dv.ai_draft = false;
