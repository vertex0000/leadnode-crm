-- Nodevers 21 — WhatsApp chatbot steps: "Wait" and "Ask a question" remember where each customer is in a flow.
-- wa-webhook writes a row when a flow waits (continue later) or asks a question (the customer's next message is the answer).
-- Every 2 minutes the existing automation timer also calls wa-webhook, which continues the waits that are due.
-- Nothing existing is changed or deleted. Safe to run more than once. Needs 13_automation_engine.sql first.

create table if not exists public.bot_waits (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id      text not null,
  phone        text not null default '',
  kind         text not null check (kind in ('wait', 'ask')),
  template     text not null default '',          -- the template whose button started the flow
  button       integer not null default 0,        -- …and which button
  path         text not null default '' check (length(path) <= 200),   -- which step inside that button's flow
  field        text not null default '',          -- ask: where the answer is saved (City, Email, Budget…)
  run_at       timestamptz not null,              -- wait: when to continue · ask: when the question expires (24 h)
  done_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists bot_waits_due on public.bot_waits (run_at) where done_at is null;
create index if not exists bot_waits_lead on public.bot_waits (workspace_id, lead_id) where done_at is null;
alter table public.bot_waits enable row level security;          -- server only: browsers can not read or write it
revoke all on public.bot_waits from anon, authenticated;
grant all on public.bot_waits to service_role;

-- the 2-minute timer: automation (as before) + chatbot waits
create or replace function public.nodevers_auto_tick() returns void
language plpgsql security definer set search_path = public as $$
declare u text; k text;
begin
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is null then return; end if;
  perform net.http_post(url := u || '/automation', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
  if exists (select 1 from public.bot_waits where done_at is null and run_at <= now() limit 1) then
    perform net.http_post(url := u || '/wa-webhook', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"bot_tick"}'::jsonb);
  end if;
end $$;
revoke execute on function public.nodevers_auto_tick() from public, anon, authenticated;
