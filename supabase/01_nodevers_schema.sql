-- =====================================================================
--  Nodevers — database v1  (run once in Supabase → SQL Editor → Run)
--  Safe to run again: it only adds what is missing.
--
--  Every row belongs to a workspace (one business). Row Level Security
--  makes sure a signed-in user only ever sees rows of workspaces they
--  are a member of — one client can never see another client's data.
-- =====================================================================

-- ---------- 1. Workspaces and who belongs to them ----------
create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'My business' check (length(name) <= 80),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  plan        text not null default 'free',
  created_at  timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'admin', 'member', 'client')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

-- Helper checks (security definer = they can read the members table without looping through RLS)
create or replace function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = ws and m.user_id = (select auth.uid()));
$$;

create or replace function public.can_write(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = ws and m.user_id = (select auth.uid())
                   and m.role in ('owner', 'admin', 'member'));
$$;

create or replace function public.is_admin(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m
                 where m.workspace_id = ws and m.user_id = (select auth.uid())
                   and m.role in ('owner', 'admin'));
$$;

-- The signed-in user's first workspace (used as the default on every insert)
create or replace function public.my_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select m.workspace_id from public.workspace_members m
  where m.user_id = (select auth.uid()) order by m.created_at limit 1;
$$;

-- ---------- 2. CRM tables (same columns as the Google Sheet) ----------
create table if not exists public.leads (
  workspace_id   uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  lead_id        text not null,
  created_on     date not null default current_date,
  name           text not null check (length(name) <= 120),
  phone          text not null default '',
  business_name  text not null default '',
  business_type  text not null default '',
  city           text not null default '',
  source         text not null default '',
  budget         numeric check (budget is null or budget >= 0),
  stage          text not null default 'New Lead',
  tag            text not null default '',
  assigned_to    text not null default '',
  follow_up_date date,
  last_contact   date,
  notes          text not null default '' check (length(notes) <= 5000),
  business_photo text not null default '',
  client_photo   text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, lead_id)
);
create index if not exists leads_phone_idx on public.leads (workspace_id, phone);

create table if not exists public.activities (
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  activity_id  text not null,
  lead_id      text not null,
  date_time    timestamptz not null default now(),
  type         text not null default 'Note',
  details      text not null default '' check (length(details) <= 5000),
  done_by      text not null default '',
  primary key (workspace_id, activity_id),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, lead_id) on delete cascade on update cascade
);
create index if not exists activities_lead_idx on public.activities (workspace_id, lead_id);

create table if not exists public.messages (
  message_id      uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  lead_id         text,
  phone           text not null default '',
  direction       text not null default 'out' check (direction in ('in', 'out')),
  type            text not null default 'text',
  text            text not null default '',
  status          text not null default '',
  time            timestamptz not null default now(),
  whatsapp_msg_id text unique,
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, lead_id) on delete set null (lead_id)
);
create index if not exists messages_lead_idx on public.messages (workspace_id, lead_id, time);

create table if not exists public.templates (
  workspace_id  uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  template_name text not null check (template_name ~ '^[a-z0-9_]+$' and length(template_name) <= 512),
  category      text not null default 'MARKETING',
  language      text not null default 'en',
  header        text not null default '',
  body          text not null default '' check (length(body) <= 1024),
  buttons       text not null default '',
  meta_status   text not null default 'Draft',
  primary key (workspace_id, template_name)
);

create table if not exists public.broadcasts (
  workspace_id    uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  broadcast_id    text not null,
  name            text not null default '',
  template        text not null default '',
  audience_filter text not null default '',
  contacts        int not null default 0,
  sent            int not null default 0,
  delivered       int not null default 0,
  read            int not null default 0,
  replies         int not null default 0,
  scheduled_for   timestamptz,
  status          text not null default 'Draft',
  primary key (workspace_id, broadcast_id)
);

create table if not exists public.flows (
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  flow_id      text not null,
  flow_name    text not null default '',
  trigger      text not null default '',
  status       text not null default 'Draft',
  flow_json    text not null default '{}' check (length(flow_json) <= 500000),
  updated_on   timestamptz not null default now(),
  primary key (workspace_id, flow_id)
);

create table if not exists public.team (
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  member_id    text not null,
  name         text not null check (length(name) <= 60),
  role         text not null default 'Sales',
  phone        text not null default '',
  email        text not null default '',
  active       boolean not null default true,
  user_id      uuid references auth.users(id) on delete set null,
  primary key (workspace_id, member_id)
);

create table if not exists public.settings (
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  key          text not null check (key ~ '^[A-Za-z0-9_]{1,40}$'),
  value        text not null default '' check (length(value) <= 20000),
  primary key (workspace_id, key)
);

-- ---------- 3. Short IDs like L001, A001, T001, F001 (per workspace) ----------
create or replace function public.set_code() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p   text := tg_argv[0];      -- prefix, e.g. 'L'
  col text := tg_argv[1];      -- id column, e.g. 'lead_id'
  cur text := to_jsonb(new) ->> col;
  n   bigint;
begin
  if cur is null or cur = '' then
    perform pg_advisory_xact_lock(hashtext(tg_table_name || new.workspace_id::text));
    execute format('select coalesce(max((substring(%I from %L))::bigint), 0) + 1 from public.%I where workspace_id = $1',
                   col, '^' || p || '([0-9]{1,15})$', tg_table_name)
      into n using new.workspace_id;
    new := jsonb_populate_record(new, jsonb_build_object(col, p || case when n < 1000 then lpad(n::text, 3, '0') else n::text end));
  end if;
  return new;
end $$;

drop trigger if exists leads_code on public.leads;
create trigger leads_code before insert on public.leads for each row execute function public.set_code('L', 'lead_id');
drop trigger if exists activities_code on public.activities;
create trigger activities_code before insert on public.activities for each row execute function public.set_code('A', 'activity_id');
drop trigger if exists team_code on public.team;
create trigger team_code before insert on public.team for each row execute function public.set_code('T', 'member_id');
drop trigger if exists flows_code on public.flows;
create trigger flows_code before insert on public.flows for each row execute function public.set_code('F', 'flow_id');
drop trigger if exists broadcasts_code on public.broadcasts;
create trigger broadcasts_code before insert on public.broadcasts for each row execute function public.set_code('B', 'broadcast_id');

create or replace function public.touch_updated() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads for each row execute function public.touch_updated();

-- ---------- 4. Row Level Security: only your own workspace ----------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

drop policy if exists ws_read on public.workspaces;
create policy ws_read on public.workspaces for select to authenticated using (public.is_member(id));
drop policy if exists ws_rename on public.workspaces;
create policy ws_rename on public.workspaces for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));

drop policy if exists wm_read on public.workspace_members;
create policy wm_read on public.workspace_members for select to authenticated using (public.is_member(workspace_id));

do $$
declare t text;
begin
  foreach t in array array['leads', 'activities', 'messages', 'templates', 'broadcasts', 'flows', 'team', 'settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists ws_select on public.%I', t);
    execute format('drop policy if exists ws_insert on public.%I', t);
    execute format('drop policy if exists ws_update on public.%I', t);
    execute format('drop policy if exists ws_delete on public.%I', t);
    execute format('create policy ws_select on public.%I for select to authenticated using (public.is_member(workspace_id))', t);
    execute format('create policy ws_insert on public.%I for insert to authenticated with check (public.can_write(workspace_id))', t);
    execute format('create policy ws_update on public.%I for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id))', t);
    execute format('create policy ws_delete on public.%I for delete to authenticated using (public.can_write(workspace_id))', t);
  end loop;
end $$;

-- ---------- 5. Access for signed-in users only (nothing for anonymous visitors) ----------
revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.leads, public.activities, public.messages, public.templates,
  public.broadcasts, public.flows, public.team, public.settings to authenticated;
grant select on public.workspaces, public.workspace_members to authenticated;
grant update (name) on public.workspaces to authenticated;

-- ---------- 6. First login: create the user's workspace (runs from the website) ----------
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

revoke execute on function public.ensure_workspace(text, text) from public, anon;
grant execute on function public.ensure_workspace(text, text) to authenticated;
revoke execute on function public.set_code() from public, anon, authenticated;
grant execute on function public.is_member(uuid), public.can_write(uuid), public.is_admin(uuid), public.my_workspace() to authenticated;

-- ---------- 7. Photos & logos (Storage bucket "media", one folder per workspace) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 2097152, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists media_select on storage.objects;
create policy media_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] in
    (select m.workspace_id::text from public.workspace_members m where m.user_id = (select auth.uid())));
drop policy if exists media_insert on storage.objects;
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] in
    (select m.workspace_id::text from public.workspace_members m where m.user_id = (select auth.uid()) and m.role <> 'client'));
drop policy if exists media_update on storage.objects;
create policy media_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] in
    (select m.workspace_id::text from public.workspace_members m where m.user_id = (select auth.uid()) and m.role <> 'client'));
drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] in
    (select m.workspace_id::text from public.workspace_members m where m.user_id = (select auth.uid()) and m.role <> 'client'));

-- Done ✓  — you should see "Success. No rows returned".
