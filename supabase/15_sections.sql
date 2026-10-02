-- Nodevers 15 — Which sections each client can use (Admin Console).
-- 1) Every plan has default sections (Admin Console → Plans & pricing → Edit → "Sections in this plan").
-- 2) Any single client can be changed (Admin Console → Clients → Manage → "Sections") — always on / always off / follow the plan.
-- 3) The client's owner can hide more for their own team (Settings → Modules), never switch on what the plan does not include.
-- Always on for everyone: Home, Leads (list + cards), Inbox, Connections, Team, Settings.
-- The database and the Edge Functions check this too — hiding is not only in the menu. Nothing is deleted when a section is off.
-- Safe to run more than once. Needs 11_platform_billing.sql and 13_automation_engine.sql first.

alter table public.plans add column if not exists sections jsonb not null default '{}'::jsonb;                    -- {"ads": false, ...}  missing = on
alter table public.workspace_subscriptions add column if not exists sections jsonb not null default '{}'::jsonb;  -- per-client override  missing = follow the plan

create or replace function public.feature_keys() returns text[]
language sql immutable as $$ select array['pipeline', 'tasks', 'orders', 'store', 'campaigns', 'automation', 'ads', 'insights'] $$;

create or replace function public.feature_name(k text) returns text
language sql immutable as $$
  select case k when 'pipeline' then 'Pipeline' when 'tasks' then 'Tasks & Calls' when 'orders' then 'Orders' when 'store' then 'Store'
    when 'campaigns' then 'Campaigns' when 'automation' then 'Automation' when 'ads' then 'Ads Manager' when 'insights' then 'Insights' else k end $$;

-- is this section on for the workspace?  client override → plan (not for "free") → on
create or replace function public.ws_feature(ws uuid, k text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    case when jsonb_typeof(s.sections -> k) = 'boolean' then (s.sections ->> k)::boolean end,
    case when coalesce(s.status, 'free') <> 'free' and jsonb_typeof(p.sections -> k) = 'boolean' then (p.sections ->> k)::boolean end,
    true)
  from (select ws as w) x left join public.workspace_subscriptions s on s.workspace_id = x.w left join public.plans p on p.id = s.plan_id;
$$;
revoke execute on function public.ws_feature(uuid, text) from public, anon;
grant execute on function public.ws_feature(uuid, text) to authenticated, service_role;

-- what the signed-in client may use (the website hides / locks the rest)
create or replace function public.my_sections(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  return (select jsonb_object_agg(k, public.ws_feature(p_ws, k)) from unnest(public.feature_keys()) k);
end $$;
revoke execute on function public.my_sections(uuid) from public, anon;
grant execute on function public.my_sections(uuid) to authenticated;

-- ---------- Admin Console ----------
create or replace function public.clean_sections(p jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k, p -> k), '{}'::jsonb) from unnest(public.feature_keys()) k where jsonb_typeof(coalesce(p, '{}'::jsonb) -> k) = 'boolean';
$$;

create or replace function public.admin_plan_sections(p_id text, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Only a super admin or an admin can change plans'; end if;
  update public.plans set sections = public.clean_sections(p), updated_at = now() where id = p_id;
  if not found then raise exception 'Plan not found'; end if;
  perform public.paudit('plan.sections', p_id, public.clean_sections(p));
end $$;

create or replace function public.admin_ws_sections(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.workspace_subscriptions%rowtype; p public.plans%rowtype;
begin
  if not public.has_platform_role(array['super', 'admin', 'support', 'finance']) then raise exception 'Platform team only'; end if;
  select * into s from public.workspace_subscriptions where workspace_id = p_ws;
  if s.plan_id is not null then select * into p from public.plans where id = s.plan_id; end if;
  return jsonb_build_object('plan_id', s.plan_id, 'plan_name', p.name, 'status', coalesce(s.status, 'free'),
    'plan_sections', case when coalesce(s.status, 'free') = 'free' then '{}'::jsonb else coalesce(p.sections, '{}'::jsonb) end,
    'override', coalesce(s.sections, '{}'::jsonb),
    'effective', (select jsonb_object_agg(k, public.ws_feature(p_ws, k)) from unnest(public.feature_keys()) k));
end $$;

create or replace function public.admin_ws_sections_save(p_ws uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Only a super admin or an admin can change sections'; end if;
  if not exists (select 1 from public.workspaces where id = p_ws) then raise exception 'Client not found'; end if;
  insert into public.workspace_subscriptions (workspace_id, status) values (p_ws, 'free') on conflict do nothing;   -- no row = free (same as before)
  update public.workspace_subscriptions set sections = public.clean_sections(p), updated_at = now() where workspace_id = p_ws;
  perform public.paudit('client.sections', p_ws::text, public.clean_sections(p));
end $$;

revoke execute on function public.admin_plan_sections(text, jsonb), public.admin_ws_sections(uuid), public.admin_ws_sections_save(uuid, jsonb) from public, anon;
grant execute on function public.admin_plan_sections(text, jsonb), public.admin_ws_sections(uuid), public.admin_ws_sections_save(uuid, jsonb) to authenticated;

-- ---------- The database blocks new rows for switched-off sections ----------
-- A person adding a row gets a clear message. Automatic rows (auto-tasks, WhatsApp button orders, store sync) are skipped quietly.
create or replace function public.feature_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text := tg_argv[0];
begin
  if public.ws_feature(new.workspace_id, k) then return new; end if;
  if pg_trigger_depth() > 1 or auth.uid() is null then return null; end if;
  raise exception '% is not part of your plan. Upgrade in Settings → Plan & billing.', public.feature_name(k);
end $$;
revoke execute on function public.feature_guard() from public, anon, authenticated;

do $$
declare r record;
begin
  for r in select * from (values ('tasks', 'tasks'), ('calls', 'tasks'), ('orders', 'orders'), ('products', 'store'), ('store_connections', 'store'), ('broadcasts', 'campaigns'), ('n8n_accounts', 'automation')) v(t, k) loop
    if to_regclass('public.' || r.t) is not null then
      execute format('drop trigger if exists %I on public.%I', r.t || '_feature', r.t);
      execute format('create trigger %I before insert on public.%I for each row execute function public.feature_guard(%L)', r.t || '_feature', r.t, r.k);
    end if;
  end loop;
end $$;

-- Automation only runs when the section is on
create or replace function public.automation_live(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.flows where workspace_id = ws and flow_id = 'AUTOMATION' and flow_json like '%"live":true%')
     and public.ws_feature(ws, 'automation');
$$;
create or replace function public.automation_test(p_ws uuid, p_lead text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_write(p_ws) then raise exception 'Not allowed'; end if;
  if not public.ws_feature(p_ws, 'automation') then raise exception 'Automation is not part of your plan. Upgrade in Settings → Plan & billing.'; end if;
  if not exists (select 1 from public.leads where workspace_id = p_ws and lead_id = p_lead) then raise exception 'Lead not found'; end if;
  insert into public.automation_events (workspace_id, kind, lead_id, data) values (p_ws, 'test', p_lead, '{}'::jsonb);
end $$;
revoke execute on function public.automation_test(uuid, text) from public, anon;
grant execute on function public.automation_test(uuid, text) to authenticated;
grant execute on function public.automation_live(uuid) to authenticated, service_role;
