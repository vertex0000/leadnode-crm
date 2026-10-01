-- =====================================================================
--  Nodevers — database v2: team invites, roles, WhatsApp, live updates
--  Run once in Supabase → SQL Editor → Run  (after 01_nodevers_schema.sql)
--  Safe to run again.
-- =====================================================================

-- ---------- 1. Invites (share a link; the person joins your workspace with a role) ----------
create table if not exists public.invites (
  token        text primary key default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role         text not null default 'member' check (role in ('admin', 'member', 'client')),
  email        text not null default '',
  note         text not null default '' check (length(note) <= 120),
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  used_by      uuid references auth.users(id) on delete set null,
  used_at      timestamptz
);
create index if not exists invites_ws_idx on public.invites (workspace_id);
alter table public.invites enable row level security;
drop policy if exists inv_read on public.invites;
create policy inv_read on public.invites for select to authenticated using (public.is_admin(workspace_id));
drop policy if exists inv_add on public.invites;
create policy inv_add on public.invites for insert to authenticated with check (public.is_admin(workspace_id));
drop policy if exists inv_del on public.invites;
create policy inv_del on public.invites for delete to authenticated using (public.is_admin(workspace_id));
grant select, insert, delete on public.invites to authenticated;

-- Join a workspace from an invite link
create or replace function public.accept_invite(p_token text, p_name text default '')
returns json language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  inv  public.invites%rowtype;
  nm   text := left(coalesce(nullif(trim(p_name), ''), nullif(split_part(mail, '@', 1), ''), 'Member'), 60);
  r    text;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  select * into inv from public.invites where token = p_token for update;
  if inv.token is null or inv.used_at is not null or inv.expires_at < now() then
    raise exception 'This invite link is invalid, already used or expired. Ask for a new one.';
  end if;
  if inv.email <> '' and lower(inv.email) <> mail then
    raise exception 'This invite is for %. Sign in with that email.', inv.email;
  end if;
  insert into public.workspace_members (workspace_id, user_id, role) values (inv.workspace_id, uid, inv.role)
    on conflict (workspace_id, user_id) do nothing;
  select m.role into r from public.workspace_members m where m.workspace_id = inv.workspace_id and m.user_id = uid;
  if not exists (select 1 from public.team t where t.workspace_id = inv.workspace_id and t.user_id = uid) then
    insert into public.team (workspace_id, name, role, email, user_id, active)
    values (inv.workspace_id, nm, case inv.role when 'admin' then 'Admin' when 'client' then 'Client' else 'Sales' end, mail, uid, inv.role <> 'client');
  end if;
  update public.invites set used_by = uid, used_at = now() where token = p_token;
  return json_build_object('workspace_id', inv.workspace_id, 'role', r,
                           'name', (select w.name from public.workspaces w where w.id = inv.workspace_id));
end $$;

-- All workspaces I belong to (for the workspace switcher)
create or replace function public.my_workspaces()
returns table (workspace_id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select m.workspace_id, w.name, m.role from public.workspace_members m
  join public.workspaces w on w.id = m.workspace_id
  where m.user_id = auth.uid() order by m.created_at;
$$;

-- People in a workspace (any member can see the list)
create or replace function public.list_members(p_ws uuid)
returns table (user_id uuid, email text, name text, role text, joined timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  return query
    select m.user_id, u.email::text, coalesce(t.name, split_part(u.email, '@', 1))::text, m.role, m.created_at
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join lateral (select t.name from public.team t where t.workspace_id = m.workspace_id and t.user_id = m.user_id limit 1) t on true
    where m.workspace_id = p_ws order by m.created_at;
end $$;

-- Change someone's role (owner/admin only; the owner cannot be changed)
create or replace function public.set_member_role(p_ws uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(p_ws) then raise exception 'Only the owner or an admin can change roles'; end if;
  if p_role not in ('admin', 'member', 'client') then raise exception 'Unknown role'; end if;
  if exists (select 1 from public.workspace_members where workspace_id = p_ws and user_id = p_user and role = 'owner') then
    raise exception 'The owner''s role cannot be changed';
  end if;
  update public.workspace_members set role = p_role where workspace_id = p_ws and user_id = p_user;
end $$;

-- Remove someone (owner/admin only; never the owner). A member may also leave by removing themselves.
create or replace function public.remove_member(p_ws uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin(p_ws) or p_user = auth.uid()) then raise exception 'Only the owner or an admin can remove people'; end if;
  if exists (select 1 from public.workspace_members where workspace_id = p_ws and user_id = p_user and role = 'owner') then
    raise exception 'The owner cannot be removed';
  end if;
  delete from public.workspace_members where workspace_id = p_ws and user_id = p_user;
  update public.team set active = false where workspace_id = p_ws and user_id = p_user;
end $$;

revoke execute on function public.accept_invite(text, text), public.my_workspaces(), public.list_members(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.accept_invite(text, text), public.my_workspaces(), public.list_members(uuid),
  public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid) to authenticated;

-- ---------- 2. WhatsApp number per workspace (the token never reaches the browser) ----------
create table if not exists public.wa_accounts (
  workspace_id    uuid primary key references public.workspaces(id) on delete cascade,
  phone_number_id text not null unique,
  waba_id         text not null default '',
  display_phone   text not null default '',
  verified_name   text not null default '',
  quality         text not null default '',
  token           text not null,                 -- secret: only Edge Functions (service role) can read it
  updated_at      timestamptz not null default now()
);
alter table public.wa_accounts enable row level security;   -- no policies + no grants = browsers can't read it
revoke all on public.wa_accounts from anon, authenticated;

-- Safe status for the website (no token)
create or replace function public.wa_status(p_ws uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare a public.wa_accounts%rowtype;
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  select * into a from public.wa_accounts where workspace_id = p_ws;
  if a.workspace_id is null then return json_build_object('connected', false); end if;
  return json_build_object('connected', true, 'phone_number_id', a.phone_number_id, 'waba_id', a.waba_id,
    'display_phone', a.display_phone, 'verified_name', a.verified_name, 'quality', a.quality, 'updated_at', a.updated_at);
end $$;
revoke execute on function public.wa_status(uuid) from public, anon;
grant execute on function public.wa_status(uuid) to authenticated;

create index if not exists messages_phone_idx on public.messages (workspace_id, phone, time);

-- ---------- 3. Live updates (team sees changes instantly) ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['leads', 'activities', 'messages'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------- 4. Server functions (Edge Functions use the service role) ----------
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Done ✓  — you should see "Success. No rows returned".
