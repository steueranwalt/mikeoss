-- Gate B4: require_write_approval can no longer be false anywhere it is
-- used to gate a connector's write actions (MCP connectors, Google Drive,
-- Gmail/Calendar). 0099_connector_write_access.sql changed the default to
-- true but still let an owner opt out per connector; the application no
-- longer offers that opt-out (see connectorSettings.ts, mcp/servers.ts,
-- googleDrive.ts, googleWorkspace.ts), and this migration makes the
-- database refuse it too, independent of any future application bug.
--
-- Backfill first so the CHECK constraint that follows does not fail on an
-- existing row an owner had switched off.
-- Idempotent: safe to re-run.

update public.user_mcp_connectors
  set require_write_approval = true
  where require_write_approval is distinct from true;
alter table public.user_mcp_connectors
  drop constraint if exists user_mcp_connectors_require_write_approval_locked;
alter table public.user_mcp_connectors
  add constraint user_mcp_connectors_require_write_approval_locked
  check (require_write_approval);

update public.user_google_drive_tokens
  set require_write_approval = true
  where require_write_approval is distinct from true;
alter table public.user_google_drive_tokens
  drop constraint if exists user_google_drive_tokens_require_write_approval_locked;
alter table public.user_google_drive_tokens
  add constraint user_google_drive_tokens_require_write_approval_locked
  check (require_write_approval);

update public.user_google_workspace_tokens
  set require_write_approval = true
  where require_write_approval is distinct from true;
alter table public.user_google_workspace_tokens
  drop constraint if exists user_google_workspace_tokens_require_write_approval_locked;
alter table public.user_google_workspace_tokens
  add constraint user_google_workspace_tokens_require_write_approval_locked
  check (require_write_approval);
