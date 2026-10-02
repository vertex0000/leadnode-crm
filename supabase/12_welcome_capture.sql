-- Nodevers 12 — Auto welcome for new leads (WhatsApp template / auto-reply / email) + lead capture link (website forms, Meta lead ads via Zapier / Make / n8n).
-- Safe to run more than once. Needs 10_connections_alerts.sql first (alert queue + background jobs). Run in Supabase → SQL Editor.

-- ---------- 1. Welcome messages go through the same queue as store alerts ----------
alter table public.alert_queue drop constraint if exists alert_queue_kind_check;
alter table public.alert_queue add constraint alert_queue_kind_check check (kind in ('new_order', 'cancel', 'low_stock', 'out_stock', 'daily', 'test', 'welcome'));

-- a new lead → one "welcome" job. Bulk inserts (Excel / Sheet imports, more than 3 leads at once) never get one; one per lead.
create or replace function public.lead_welcome() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from newrows) > 3 then return null; end if;
  insert into public.alert_queue (workspace_id, kind, ref, payload)
  select n.workspace_id, 'welcome', n.lead_id, jsonb_build_object('lead_id', n.lead_id, 'source', n.source)
  from newrows n join public.settings s on s.workspace_id = n.workspace_id and s.key = 'welcomeJson' and s.value like '%"on":true%'
  where coalesce(n.source, '') not ilike 'import%' and (coalesce(n.phone, '') <> '' or coalesce(n.email, '') <> '')
  on conflict do nothing;
  return null;
exception when others then return null;     -- a welcome must never block adding a lead
end $$;
drop trigger if exists leads_welcome on public.leads;
create trigger leads_welcome after insert on public.leads referencing new table as newrows for each statement execute function public.lead_welcome();
revoke execute on function public.lead_welcome() from public, anon, authenticated;

-- ---------- 2. Lead capture link: one private key per workspace ----------
create table if not exists public.lead_capture_keys (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  key          text not null unique default replace(gen_random_uuid()::text, '-', '') || left(replace(gen_random_uuid()::text, '-', ''), 8),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  uses         integer not null default 0
);
alter table public.lead_capture_keys enable row level security;          -- no policies: only the functions below and the server read it
revoke all on public.lead_capture_keys from anon, authenticated;
grant all on public.lead_capture_keys to service_role;

-- owner / admin: get (or create) the key; rotate makes old forms stop working
create or replace function public.lead_capture_key(p_ws uuid, p_rotate boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.lead_capture_keys;
begin
  if not exists (select 1 from public.workspace_members where workspace_id = p_ws and user_id = auth.uid() and role in ('owner', 'admin')) then
    raise exception 'Only the owner or an admin can see the lead capture link'; end if;
  if p_rotate then delete from public.lead_capture_keys where workspace_id = p_ws; end if;
  insert into public.lead_capture_keys (workspace_id) values (p_ws) on conflict (workspace_id) do nothing;
  select * into r from public.lead_capture_keys where workspace_id = p_ws;
  return jsonb_build_object('key', r.key, 'uses', r.uses, 'last_used_at', r.last_used_at);
end $$;
revoke execute on function public.lead_capture_key(uuid, boolean) from public, anon;
grant execute on function public.lead_capture_key(uuid, boolean) to authenticated;
