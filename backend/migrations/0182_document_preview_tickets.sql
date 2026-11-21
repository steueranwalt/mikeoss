-- Gate B4 audit finding N45: replica-safe one-time preview tickets.
-- ca-mike can run several replicas; an in-process Map meant mint-on-A /
-- redeem-on-B returned 401. Store only the SHA-256 of the ticket. Consume
-- is a single DELETE … WHERE hash=$1 AND expires_at > now() RETURNING.

create table if not exists public.document_preview_tickets (
  ticket_hash text primary key,
  user_id text not null,
  document_id text not null,
  version_id text not null,
  edit_id text not null,
  expires_at timestamptz not null
);

create index if not exists document_preview_tickets_expires_at_idx
  on public.document_preview_tickets (expires_at);

create or replace function public.consume_document_preview_ticket(p_ticket_hash text)
returns table (
  user_id text,
  document_id text,
  version_id text,
  edit_id text
)
language sql
as $$
  delete from public.document_preview_tickets
  where ticket_hash = p_ticket_hash
    and expires_at > now()
  returning
    document_preview_tickets.user_id,
    document_preview_tickets.document_id,
    document_preview_tickets.version_id,
    document_preview_tickets.edit_id;
$$;

revoke all on public.document_preview_tickets from public, web_anon, authenticated;
grant select, insert, delete, update on public.document_preview_tickets to service_role;

revoke all on function public.consume_document_preview_ticket(text) from public, web_anon, authenticated;
grant execute on function public.consume_document_preview_ticket(text) to service_role;

notify pgrst, 'reload schema';
