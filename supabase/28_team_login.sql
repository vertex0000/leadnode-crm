-- Nodevers 28 — team logins: pause / resume a person, last login, people list in one call
-- Pause = the person's membership is moved aside (paused_members) so every rule in the database and every
-- Edge Function treats them as "not in this workspace" right away. Resume puts it back exactly as it was
-- (role, team, area, switches). The plan's team-member limit is checked again on resume.
-- Safe to run more than once. Needs 01–27 first.

create table if not exists public.paused_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  data         jsonb not null,                    -- the whole workspace_members row as it was
  paused_at    timestamptz not null default now(),
  paused_by    uuid references auth.users(id) on delete set null,
  primary key (workspace_id, user_id)
);
alter table public.paused_members enable row level security;   -- no direct access; only through the functions below
revoke all on public.paused_members from anon, authenticated;

create or replace function public.member_pause(p_ws uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.workspace_members%rowtype; me text;
begin
  select role into me from public.workspace_members where workspace_id = p_ws and user_id = auth.uid();
  if me is null or me not in ('owner', 'admin') then raise exception 'Only the owner or an admin can pause people'; end if;
  if p_user = auth.uid() then raise exception 'You can not pause yourself'; end if;
  select * into m from public.workspace_members where workspace_id = p_ws and user_id = p_user;
  if m.user_id is null then raise exception 'This person is not in the workspace'; end if;
  if m.role = 'owner' then raise exception 'The owner can not be paused'; end if;
  if m.role = 'admin' and me <> 'owner' then raise exception 'Only the owner can pause an admin'; end if;
  insert into public.paused_members (workspace_id, user_id, data, paused_by) values (p_ws, p_user, to_jsonb(m), auth.uid())
    on conflict (workspace_id, user_id) do update set data = excluded.data, paused_at = now(), paused_by = excluded.paused_by;
  delete from public.workspace_members where workspace_id = p_ws and user_id = p_user;
end $$;

create or replace function public.member_resume(p_ws uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if not public.is_admin(p_ws) then raise exception 'Only the owner or an admin can do this'; end if;
  select data into d from public.paused_members where workspace_id = p_ws and user_id = p_user;
  if d is null then raise exception 'This person is not paused'; end if;
  insert into public.workspace_members select * from jsonb_populate_record(null::public.workspace_members, d)
    on conflict (workspace_id, user_id) do nothing;          -- the member limit trigger still checks the plan
  delete from public.paused_members where workspace_id = p_ws and user_id = p_user;
end $$;

-- a paused person who is removed for good
create or replace function public.member_forget(p_ws uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(p_ws) then raise exception 'Only the owner or an admin can do this'; end if;
  delete from public.paused_members where workspace_id = p_ws and user_id = p_user;
  update public.team set active = false where workspace_id = p_ws and user_id = p_user;
end $$;

-- everyone with a login + last sign-in + paused people (owner / admin see paused ones)
create or replace function public.list_people(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a jsonb; p jsonb := '[]'::jsonb;
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'name', coalesce(t.name, split_part(u.email, '@', 1)), 'role', m.role,
      'joined', m.created_at, 'team_name', m.team_name, 'scope', m.scope, 'areas', m.areas, 'perms', m.perms, 'last_login', u.last_sign_in_at, 'paused', false) order by m.created_at), '[]'::jsonb)
    into a
    from public.workspace_members m join auth.users u on u.id = m.user_id
    left join lateral (select t.name from public.team t where t.workspace_id = m.workspace_id and t.user_id = m.user_id limit 1) t on true
    where m.workspace_id = p_ws;
  if public.is_admin(p_ws) then
    select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'email', u.email, 'name', coalesce(t.name, split_part(u.email, '@', 1)), 'role', x.data ->> 'role',
        'joined', x.data ->> 'created_at', 'team_name', x.data ->> 'team_name', 'scope', x.data ->> 'scope', 'areas', x.data -> 'areas', 'perms', x.data -> 'perms',
        'last_login', u.last_sign_in_at, 'paused', true, 'paused_at', x.paused_at) order by x.paused_at), '[]'::jsonb)
      into p
      from public.paused_members x join auth.users u on u.id = x.user_id
      left join lateral (select t.name from public.team t where t.workspace_id = x.workspace_id and t.user_id = x.user_id limit 1) t on true
      where x.workspace_id = p_ws;
  end if;
  return a || p;
end $$;

-- a paused person who signs in must not get a new empty workspace
create or replace function public.ensure_workspace(p_business text default '', p_name text default '')
returns json language plpgsql security definer set search_path = public as $$
declare
  uid   uuid := auth.uid();
  mail  text := coalesce(auth.jwt() ->> 'email', '');
  ws    uuid;
  r     text;
  nm    text := left(coalesce(nullif(trim(p_name), ''), nullif(split_part(mail, '@', 1), ''), 'Owner'), 60);
  biz   text := left(coalesce(nullif(trim(p_business), ''), nm || '''s business'), 80);
begin
  if uid is null then raise exception 'Not signed in'; end if;
  select m.workspace_id, m.role into ws, r from public.workspace_members m
    where m.user_id = uid order by m.created_at limit 1;
  if ws is null then
    perform pg_advisory_xact_lock(hashtext(uid::text));
    select m.workspace_id, m.role into ws, r from public.workspace_members m where m.user_id = uid limit 1;
  end if;
  if ws is null and exists (select 1 from public.paused_members p where p.user_id = uid) then
    raise exception 'Your access is paused — ask the workspace owner to resume it.';
  end if;
  if ws is null then
    insert into public.workspaces (name, owner_id) values (biz, uid) returning id into ws;
    insert into public.workspace_members (workspace_id, user_id, role) values (ws, uid, 'owner');
    insert into public.team (workspace_id, name, role, email, user_id) values (ws, nm, 'Admin', mail, uid);
    insert into public.settings (workspace_id, key, value) values (ws, 'userName', nm);
    r := 'owner';
  end if;
  return json_build_object('workspace_id', ws, 'role', r,
                           'name', (select w.name from public.workspaces w where w.id = ws));
end $$;

-- an invite the owner / admin may email (used by the email function; service role only)
create or replace function public.invite_for_email(p_ws uuid, p_token text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('token', i.token, 'role', i.role, 'email', i.email, 'workspace', w.name)
  from public.invites i join public.workspaces w on w.id = i.workspace_id
  where i.workspace_id = p_ws and i.token = p_token and i.used_at is null and i.expires_at > now();
$$;

create or replace function public.v28_ready() returns boolean language sql stable as $$ select true $$;

revoke execute on function public.member_pause(uuid, uuid), public.member_resume(uuid, uuid), public.member_forget(uuid, uuid), public.list_people(uuid), public.v28_ready() from public, anon;
grant execute on function public.member_pause(uuid, uuid), public.member_resume(uuid, uuid), public.member_forget(uuid, uuid), public.list_people(uuid), public.v28_ready() to authenticated;
revoke execute on function public.invite_for_email(uuid, text) from public, anon, authenticated;
grant execute on function public.invite_for_email(uuid, text) to service_role;
