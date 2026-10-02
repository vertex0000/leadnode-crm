-- Nodevers 13 — Automation engine: the Automation canvas runs for real once you switch it Live.
-- Events (new lead, stage / tag changed, WhatsApp message in) → queue → "automation" function runs the flow steps,
-- waits ("Wait 2 days", "Wait for reply") are resumed every 2 minutes. Safe to run more than once. Needs 10 + 12 first.

-- ---------- 1. Event queue (server only) ----------
create table if not exists public.automation_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind         text not null check (kind in ('newlead', 'stage', 'tag', 'wamsg', 'test')),
  lead_id      text,
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  done_at      timestamptz
);
create index if not exists automation_events_todo on public.automation_events (id) where done_at is null;
alter table public.automation_events enable row level security;
revoke all on public.automation_events from anon, authenticated;
grant all on public.automation_events to service_role;

-- ---------- 2. Runs: one per lead per trigger — the team can read them (Automation → Runs) ----------
create table if not exists public.automation_runs (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  flow_id      text not null default 'AUTOMATION',
  trigger_node text not null default '',
  trigger_name text not null default '',
  lead_id      text,
  status       text not null default 'running' check (status in ('running', 'waiting', 'waiting_reply', 'done', 'failed', 'stopped')),
  pending      jsonb not null default '[]'::jsonb,          -- node ids still to run
  wait_node    text,
  next_at      timestamptz,
  since        timestamptz,
  steps        integer not null default 0,
  log          jsonb not null default '[]'::jsonb,          -- [{at, node, name, ok, msg}]
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists automation_runs_due on public.automation_runs (next_at) where status in ('waiting', 'waiting_reply');
create index if not exists automation_runs_ws on public.automation_runs (workspace_id, created_at desc);
create index if not exists automation_runs_lead on public.automation_runs (workspace_id, lead_id) where status = 'waiting_reply';
alter table public.automation_runs enable row level security;
drop policy if exists ar_select on public.automation_runs;
create policy ar_select on public.automation_runs for select to authenticated using (public.is_member(workspace_id));
drop policy if exists ar_stop on public.automation_runs;
create policy ar_stop on public.automation_runs for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
grant select, update (status, updated_at) on public.automation_runs to authenticated;
grant all on public.automation_runs to service_role;

-- is the Automation canvas switched Live for this workspace?
create or replace function public.automation_live(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.flows where workspace_id = ws and flow_id = 'AUTOMATION' and flow_json like '%"live":true%');
$$;

-- ---------- 3. Events from the CRM (changes made by the engine itself never start new runs) ----------
create or replace function public.auto_ev_leads_new() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('nodevers.auto', true), '') = '1' then return null; end if;
  if (select count(*) from newrows) > 3 then return null; end if;                 -- imports never start flows
  insert into public.automation_events (workspace_id, kind, lead_id, data)
  select n.workspace_id, 'newlead', n.lead_id, jsonb_build_object('source', n.source) from newrows n
  where public.automation_live(n.workspace_id) and coalesce(n.source, '') not ilike 'import%';
  return null;
exception when others then return null;
end $$;
drop trigger if exists leads_auto_new on public.leads;
create trigger leads_auto_new after insert on public.leads referencing new table as newrows for each statement execute function public.auto_ev_leads_new();

create or replace function public.auto_ev_leads_upd() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('nodevers.auto', true), '') = '1' then return new; end if;
  if not public.automation_live(new.workspace_id) then return new; end if;
  if new.stage is distinct from old.stage then
    insert into public.automation_events (workspace_id, kind, lead_id, data) values (new.workspace_id, 'stage', new.lead_id, jsonb_build_object('stage', new.stage, 'old', old.stage));
  end if;
  if new.tag is distinct from old.tag and coalesce(new.tag, '') <> '' then
    insert into public.automation_events (workspace_id, kind, lead_id, data) values (new.workspace_id, 'tag', new.lead_id, jsonb_build_object('tag', new.tag));
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists leads_auto_upd on public.leads;
create trigger leads_auto_upd after update of stage, tag on public.leads for each row execute function public.auto_ev_leads_upd();

create or replace function public.auto_ev_msg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction <> 'in' or new.lead_id is null then return new; end if;
  if not public.automation_live(new.workspace_id) then return new; end if;
  insert into public.automation_events (workspace_id, kind, lead_id, data) values (new.workspace_id, 'wamsg', new.lead_id, jsonb_build_object('text', left(coalesce(new.text, ''), 1000)));
  return new;
exception when others then return new;
end $$;
drop trigger if exists messages_auto on public.messages;
create trigger messages_auto after insert on public.messages for each row execute function public.auto_ev_msg();

-- run right away: one call to the "automation" function per batch of new events
create or replace function public.auto_kick() returns trigger
language plpgsql security definer set search_path = public as $$
declare u text; k text;
begin
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is not null then
    perform net.http_post(url := u || '/automation', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"run"}'::jsonb);
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists automation_events_kick on public.automation_events;
create trigger automation_events_kick after insert on public.automation_events for each statement execute function public.auto_kick();

-- ---------- 4. The engine changes leads through this (so its own changes don't trigger flows again) ----------
create or replace function public.auto_apply(p_ws uuid, p_lead text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('nodevers.auto', '1', true);
  update public.leads set
    stage          = coalesce(p ->> 'stage', stage),
    tag            = coalesce(p ->> 'tag', tag),
    assigned_to    = coalesce(p ->> 'assigned_to', assigned_to),
    follow_up_date = coalesce((p ->> 'follow_up_date')::date, follow_up_date)
  where workspace_id = p_ws and lead_id = p_lead;
  perform set_config('nodevers.auto', '', true);
end $$;

-- "Test with a lead" button (members who can write)
create or replace function public.automation_test(p_ws uuid, p_lead text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_write(p_ws) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from public.leads where workspace_id = p_ws and lead_id = p_lead) then raise exception 'Lead not found'; end if;
  insert into public.automation_events (workspace_id, kind, lead_id, data) values (p_ws, 'test', p_lead, '{}'::jsonb);
end $$;
revoke execute on function public.auto_apply(uuid, text, jsonb), public.auto_kick(), public.auto_ev_msg(), public.auto_ev_leads_upd(), public.auto_ev_leads_new() from public, anon, authenticated;
revoke execute on function public.automation_test(uuid, text) from public, anon;
grant execute on function public.automation_test(uuid, text) to authenticated;
grant execute on function public.automation_live(uuid) to authenticated, service_role;
grant execute on function public.auto_apply(uuid, text, jsonb) to service_role;

-- ---------- 5. Every 2 minutes: resume waits and schedules ----------
create or replace function public.nodevers_auto_tick() returns void
language plpgsql security definer set search_path = public as $$
declare u text; k text;
begin
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is null then return; end if;
  perform net.http_post(url := u || '/automation', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
end $$;
revoke execute on function public.nodevers_auto_tick() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'nodevers-automation';
    perform cron.schedule('nodevers-automation', '*/2 * * * *', 'select public.nodevers_auto_tick();');
  end if;
exception when others then raise notice 'cron not scheduled: %', sqlerrm;
end $$;

-- ---------- 6. More email providers (Brevo, Resend, SendGrid, Mailgun, Postmark, Zoho ZeptoMail, Mailjet) ----------
alter table public.email_accounts add column if not exists extra jsonb not null default '{}'::jsonb;   -- domain / region / second key — server only
