-- Nodevers 08 — Platform admin console (you see every client), template flows (buttons → actions), orders.
-- Safe to run more than once. Run in Supabase → SQL Editor.

-- ---------- 1. Platform admins (the Nodevers owner — sees every client workspace, read-only) ----------
create table if not exists public.platform_admins (email text primary key check (email = lower(email)));
alter table public.platform_admins enable row level security;            -- no policies: nobody reads it from the browser
revoke all on public.platform_admins from anon, authenticated;
insert into public.platform_admins (email) values ('shivamwaghmare4747@gmail.com') on conflict do nothing;

create or replace function public.is_platform_admin_uid(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u join public.platform_admins p on p.email = lower(u.email)
                 where u.id = uid and u.email_confirmed_at is not null);
$$;
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.is_platform_admin_uid((select auth.uid())); $$;

-- Read access everywhere for the platform admin (writes still need a real membership)
create or replace function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid()))
      or public.is_platform_admin();
$$;
create or replace function public.lead_access(ws uuid, uid uuid, p_state text, p_district text, p_city text, p_assigned text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_platform_admin_uid(uid) or exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = uid and (
      m.role in ('owner', 'admin') or m.scope = 'all'
      or (coalesce(p_assigned, '') <> '' and exists (select 1 from public.team t where t.workspace_id = ws and t.user_id = uid and lower(t.name) = lower(p_assigned)))
      or (m.scope = 'area' and (lower(trim(coalesce(p_state, ''))) = any(m.areas) or lower(trim(coalesce(p_district, ''))) = any(m.areas) or lower(trim(coalesce(p_city, ''))) = any(m.areas)))
    ));
$$;
create or replace function public.sees_all(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid()) and (m.role in ('owner', 'admin') or m.scope = 'all'));
$$;
create or replace function public.my_access(p_ws uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare m public.workspace_members%rowtype; nm text;
begin
  select * into m from public.workspace_members where workspace_id = p_ws and user_id = auth.uid();
  if m.user_id is null then
    if public.is_platform_admin() then
      return json_build_object('role', 'platform', 'team', '', 'scope', 'all', 'areas', '{}'::text[], 'perms', '{}'::jsonb, 'platform', true,
        'name', split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1));
    end if;
    raise exception 'Not a member of this workspace';
  end if;
  select t.name into nm from public.team t where t.workspace_id = p_ws and t.user_id = auth.uid() limit 1;
  return json_build_object('role', m.role, 'team', m.team_name, 'scope', m.scope, 'areas', m.areas, 'perms', m.perms, 'platform', public.is_platform_admin(),
    'name', coalesce(nm, split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1)));
end $$;

-- Workspace switcher: the platform admin also gets every client workspace (role "platform" = read-only view)
create or replace function public.my_workspaces()
returns table (workspace_id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select x.workspace_id, x.name, x.role from (
    select m.workspace_id, w.name, m.role, 0 as o, m.created_at as t from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id where m.user_id = auth.uid()
    union all
    select w.id, w.name, 'platform', 1, w.created_at from public.workspaces w
    where public.is_platform_admin() and not exists (select 1 from public.workspace_members m where m.workspace_id = w.id and m.user_id = auth.uid())
  ) x order by x.o, x.t;
$$;

-- Admin console: one row per client workspace
create or replace function public.admin_overview()
returns table (workspace_id uuid, name text, owner_email text, plan text, created_at timestamptz, members int, leads int, leads_30d int, won int,
               messages_30d int, calls_30d int, wa_phone text, email_from text, n8n boolean, last_active timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admins only'; end if;
  return query
  select w.id, w.name, u.email::text, w.plan, w.created_at,
    (select count(*)::int from public.workspace_members m where m.workspace_id = w.id),
    (select count(*)::int from public.leads l where l.workspace_id = w.id),
    (select count(*)::int from public.leads l where l.workspace_id = w.id and l.created_at > now() - interval '30 days'),
    (select count(*)::int from public.leads l where l.workspace_id = w.id and l.stage = 'Won'),
    (select count(*)::int from public.messages x where x.workspace_id = w.id and x.time > now() - interval '30 days'),
    (select count(*)::int from public.calls c where c.workspace_id = w.id and c.called_at > now() - interval '30 days'),
    coalesce((select a.display_phone from public.wa_accounts a where a.workspace_id = w.id), ''),
    coalesce((select e.from_email from public.email_accounts e where e.workspace_id = w.id), ''),
    exists (select 1 from public.n8n_accounts n where n.workspace_id = w.id),
    greatest((select max(l.updated_at) from public.leads l where l.workspace_id = w.id), (select max(a.date_time) from public.activities a where a.workspace_id = w.id), w.created_at)
  from public.workspaces w left join auth.users u on u.id = w.owner_id
  order by 15 desc nulls last;
end $$;
revoke execute on function public.admin_overview(), public.is_platform_admin(), public.is_platform_admin_uid(uuid) from public, anon;
grant execute on function public.admin_overview(), public.is_platform_admin() to authenticated;
