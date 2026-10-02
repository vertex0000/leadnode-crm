-- Nodevers 07 — Teams & areas, member permissions, calls, tasks, campaign analytics, template library.
-- Safe to run more than once. Run in Supabase → SQL Editor.

-- ---------- 1. Leads get State + District (City already exists) ----------
alter table public.leads add column if not exists state    text not null default '';
alter table public.leads add column if not exists district text not null default '';
create index if not exists leads_area_idx on public.leads (workspace_id, lower(state), lower(district), lower(city));

-- ---------- 2. Each member: team, areas, what they may see and do ----------
alter table public.workspace_members add column if not exists team_name text   not null default '';
alter table public.workspace_members add column if not exists scope     text   not null default 'all';
alter table public.workspace_members add column if not exists areas     text[] not null default '{}';
alter table public.workspace_members add column if not exists perms     jsonb  not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_members_scope_chk') then
    alter table public.workspace_members add constraint workspace_members_scope_chk check (scope in ('all', 'area', 'own'));
  end if;
end $$;

-- Core rule, usable with any user id (Edge Functions pass the caller's id)
create or replace function public.lead_access(ws uuid, uid uuid, p_state text, p_district text, p_city text, p_assigned text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = uid and (
      m.role in ('owner', 'admin') or m.scope = 'all'
      or (coalesce(p_assigned, '') <> '' and exists (select 1 from public.team t where t.workspace_id = ws and t.user_id = uid and lower(t.name) = lower(p_assigned)))
      or (m.scope = 'area' and (lower(trim(coalesce(p_state, ''))) = any(m.areas) or lower(trim(coalesce(p_district, ''))) = any(m.areas) or lower(trim(coalesce(p_city, ''))) = any(m.areas)))
    ));
$$;
create or replace function public.can_see_lead(ws uuid, p_state text, p_district text, p_city text, p_assigned text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.lead_access(ws, (select auth.uid()), p_state, p_district, p_city, p_assigned);
$$;
-- Members see everything unless the owner/admin limited them (scope 'area' / 'own')
create or replace function public.sees_all(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid()) and (m.role in ('owner', 'admin') or m.scope = 'all'));
$$;
-- Permission switch (owner/admin: always yes; member: yes unless switched off; client: no)
create or replace function public.has_perm(ws uuid, p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid())
    and (m.role in ('owner', 'admin') or (m.role = 'member' and coalesce((m.perms ->> p_key)::boolean, true))));
$$;

-- What I am allowed (the website uses this to show / hide buttons)
create or replace function public.my_access(p_ws uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare m public.workspace_members%rowtype; nm text;
begin
  select * into m from public.workspace_members where workspace_id = p_ws and user_id = auth.uid();
  if m.user_id is null then raise exception 'Not a member of this workspace'; end if;
  select t.name into nm from public.team t where t.workspace_id = p_ws and t.user_id = auth.uid() limit 1;
  return json_build_object('role', m.role, 'team', m.team_name, 'scope', m.scope, 'areas', m.areas, 'perms', m.perms,
    'name', coalesce(nm, split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1)));
end $$;

-- Owner / admin sets a member's team, areas and switches
create or replace function public.set_member_access(p_ws uuid, p_user uuid, p_team text, p_scope text, p_areas text[], p_perms jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(p_ws) then raise exception 'Only the owner or an admin can change access'; end if;
  if exists (select 1 from public.workspace_members where workspace_id = p_ws and user_id = p_user and role = 'owner') then raise exception 'The owner always has full access'; end if;
  if p_scope not in ('all', 'area', 'own') then raise exception 'Unknown access level'; end if;
  update public.workspace_members set
    team_name = left(trim(coalesce(p_team, '')), 60),
    scope = p_scope,
    areas = coalesce((select array_agg(distinct lower(trim(a))) from unnest(coalesce(p_areas, '{}')) a where trim(a) <> ''), '{}'),
    perms = coalesce(p_perms, '{}'::jsonb)
  where workspace_id = p_ws and user_id = p_user;
end $$;

-- People list now also shows team, areas and switches
drop function if exists public.list_members(uuid);
create or replace function public.list_members(p_ws uuid)
returns table (user_id uuid, email text, name text, role text, joined timestamptz, team_name text, scope text, areas text[], perms jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  return query
    select m.user_id, u.email::text, coalesce(t.name, split_part(u.email, '@', 1))::text, m.role, m.created_at, m.team_name, m.scope, m.areas, m.perms
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join lateral (select t.name from public.team t where t.workspace_id = m.workspace_id and t.user_id = m.user_id limit 1) t on true
    where m.workspace_id = p_ws order by m.created_at;
end $$;

-- For Edge Functions (service role only)
create or replace function public.member_access(p_ws uuid, p_uid uuid) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('role', m.role, 'scope', m.scope, 'areas', m.areas, 'perms', m.perms,
    'name', coalesce((select t.name from public.team t where t.workspace_id = p_ws and t.user_id = p_uid limit 1), ''))
  from public.workspace_members m where m.workspace_id = p_ws and m.user_id = p_uid;
$$;
create or replace function public.visible_lead_ids(p_ws uuid, p_uid uuid, p_ids text[]) returns setof text
language sql stable security definer set search_path = public as $$
  select l.lead_id from public.leads l
  where l.workspace_id = p_ws and l.lead_id = any(p_ids) and public.lead_access(p_ws, p_uid, l.state, l.district, l.city, l.assigned_to);
$$;

-- Leads: you only see / change the leads of your area (or assigned to you), and only what your switches allow
drop policy if exists ws_select on public.leads;
drop policy if exists ws_insert on public.leads;
drop policy if exists ws_update on public.leads;
drop policy if exists ws_delete on public.leads;
create policy ws_select on public.leads for select to authenticated using (public.is_member(workspace_id) and public.can_see_lead(workspace_id, state, district, city, assigned_to));
create policy ws_insert on public.leads for insert to authenticated with check (public.can_write(workspace_id) and public.has_perm(workspace_id, 'add'));
create policy ws_update on public.leads for update to authenticated using (public.can_write(workspace_id) and public.has_perm(workspace_id, 'edit') and public.can_see_lead(workspace_id, state, district, city, assigned_to)) with check (public.can_write(workspace_id));
create policy ws_delete on public.leads for delete to authenticated using (public.can_write(workspace_id) and public.has_perm(workspace_id, 'delete') and public.can_see_lead(workspace_id, state, district, city, assigned_to));

-- Journey + chats follow the lead (the inner query on leads is itself limited by the rule above)
drop policy if exists ws_select on public.activities;
create policy ws_select on public.activities for select to authenticated using (public.is_member(workspace_id) and (public.sees_all(workspace_id) or exists (select 1 from public.leads l where l.workspace_id = activities.workspace_id and l.lead_id = activities.lead_id)));
drop policy if exists ws_select on public.messages;
create policy ws_select on public.messages for select to authenticated using (public.is_member(workspace_id) and (public.sees_all(workspace_id) or (lead_id is not null and exists (select 1 from public.leads l where l.workspace_id = messages.workspace_id and l.lead_id = messages.lead_id))));

-- Who sent a message (for team analytics)
alter table public.messages add column if not exists sent_by text not null default '';

-- ---------- 3. Calls ----------
create table if not exists public.calls (
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  call_id      text not null,
  lead_id      text,
  user_id      uuid default auth.uid(),
  member       text not null default '' check (length(member) <= 60),
  phone        text not null default '',
  direction    text not null default 'out' check (direction in ('out', 'in')),
  outcome      text not null default '' check (length(outcome) <= 40),
  duration_sec int  not null default 0 check (duration_sec >= 0),
  notes        text not null default '' check (length(notes) <= 2000),
  called_at    timestamptz not null default now(),
  primary key (workspace_id, call_id),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, lead_id) on delete set null (lead_id)
);
create index if not exists calls_time_idx on public.calls (workspace_id, called_at);
drop trigger if exists calls_code on public.calls;
create trigger calls_code before insert on public.calls for each row execute function public.set_code('C', 'call_id');
alter table public.calls enable row level security;
drop policy if exists c_select on public.calls;
drop policy if exists c_insert on public.calls;
drop policy if exists c_update on public.calls;
drop policy if exists c_delete on public.calls;
create policy c_select on public.calls for select to authenticated using (public.is_member(workspace_id) and (public.sees_all(workspace_id) or user_id = (select auth.uid()) or exists (select 1 from public.leads l where l.workspace_id = calls.workspace_id and l.lead_id = calls.lead_id)));
create policy c_insert on public.calls for insert to authenticated with check (public.can_write(workspace_id) and public.has_perm(workspace_id, 'calls'));
create policy c_update on public.calls for update to authenticated using (public.is_admin(workspace_id) or user_id = (select auth.uid())) with check (public.can_write(workspace_id));
create policy c_delete on public.calls for delete to authenticated using (public.is_admin(workspace_id) or user_id = (select auth.uid()));
grant select, insert, update, delete on public.calls to authenticated;

-- ---------- 4. Tasks (auto follow-ups when a lead reaches an important stage) ----------
create table if not exists public.tasks (
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  task_id      text not null,
  lead_id      text,
  title        text not null check (length(title) <= 200),
  notes        text not null default '' check (length(notes) <= 2000),
  due_at       timestamptz not null default (now() + interval '1 day'),
  priority     text not null default 'Medium' check (priority in ('High', 'Medium', 'Low')),
  assigned_to  text not null default '',
  status       text not null default 'Open' check (status in ('Open', 'Done', 'Closed')),
  source       text not null default 'manual',
  stage        text not null default '',
  remind       boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  done_at      timestamptz,
  done_by      text not null default '',
  primary key (workspace_id, task_id),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, lead_id) on delete cascade
);
create index if not exists tasks_due_idx on public.tasks (workspace_id, status, due_at);
drop trigger if exists tasks_code on public.tasks;
create trigger tasks_code before insert on public.tasks for each row execute function public.set_code('K', 'task_id');
alter table public.tasks enable row level security;
drop policy if exists k_select on public.tasks;
drop policy if exists k_write on public.tasks;
create policy k_select on public.tasks for select to authenticated using (public.is_member(workspace_id) and (public.sees_all(workspace_id) or lead_id is null or exists (select 1 from public.leads l where l.workspace_id = tasks.workspace_id and l.lead_id = tasks.lead_id)));
create policy k_write on public.tasks for all to authenticated using (public.can_write(workspace_id) and (public.sees_all(workspace_id) or lead_id is null or exists (select 1 from public.leads l where l.workspace_id = tasks.workspace_id and l.lead_id = tasks.lead_id))) with check (public.can_write(workspace_id));
grant select, insert, update, delete on public.tasks to authenticated;

-- Rules live in settings key "taskRulesJson": [{"stage":"Interested","title":"…","days":1,"priority":"High","off":false}]
create or replace function public.auto_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare rules jsonb; r jsonb; raw text;
begin
  if tg_op = 'UPDATE' and new.stage is not distinct from old.stage then return new; end if;
  if tg_op = 'UPDATE' then          -- the lead moved on: close the old stage's open auto tasks
    update public.tasks set status = 'Closed', done_at = now(), done_by = 'Moved to ' || new.stage
      where workspace_id = new.workspace_id and lead_id = new.lead_id and source = 'auto' and status = 'Open' and stage = old.stage;
  end if;
  select value into raw from public.settings where workspace_id = new.workspace_id and key = 'taskRulesJson';
  begin rules := nullif(raw, '')::jsonb; exception when others then rules := null; end;
  if rules is null or jsonb_typeof(rules) <> 'array' then
    rules := '[{"stage":"Interested","title":"Call back and share catalogue / prices","days":1,"priority":"High"},
               {"stage":"Quotation Sent","title":"Follow up on the quotation","days":2,"priority":"High"},
               {"stage":"Negotiation","title":"Close the deal — agree the final price","days":1,"priority":"High"}]';
  end if;
  for r in select * from jsonb_array_elements(rules) loop
    if lower(coalesce(r ->> 'stage', '')) = lower(new.stage) and not coalesce((r ->> 'off')::boolean, false)
       and not exists (select 1 from public.tasks t where t.workspace_id = new.workspace_id and t.lead_id = new.lead_id and t.stage = new.stage and t.status = 'Open') then
      insert into public.tasks (workspace_id, lead_id, title, due_at, priority, assigned_to, source, stage, created_by)
      values (new.workspace_id, new.lead_id, left(coalesce(nullif(r ->> 'title', ''), 'Follow up'), 200),
              now() + make_interval(days => greatest(0, least(60, coalesce((r ->> 'days')::int, 1)))),
              case when r ->> 'priority' in ('High', 'Medium', 'Low') then r ->> 'priority' else 'Medium' end,
              new.assigned_to, 'auto', new.stage, auth.uid());
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists leads_auto_task on public.leads;
create trigger leads_auto_task after insert or update of stage on public.leads for each row execute function public.auto_task();

-- ---------- 5. Campaign analytics (one row per broadcast, refreshed after every run) ----------
create table if not exists public.campaign_stats (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  broadcast_id text not null,
  name         text not null default '',
  channel      text not null default 'whatsapp',
  template     text not null default '',
  contacts     int  not null default 0,
  sent         int  not null default 0,
  delivered    int  not null default 0,
  read         int  not null default 0,
  replied      int  not null default 0,
  failed       int  not null default 0,
  sent_at      timestamptz,
  send_hour    int,
  weekday      int,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, broadcast_id)
);
alter table public.campaign_stats enable row level security;
drop policy if exists cs_select on public.campaign_stats;
create policy cs_select on public.campaign_stats for select to authenticated using (public.is_member(workspace_id));
grant select on public.campaign_stats to authenticated;

create or replace function public.refresh_campaign_stats(p_ws uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  insert into public.campaign_stats as c (workspace_id, broadcast_id, name, channel, template, contacts, sent, delivered, read, replied, failed, sent_at, send_hour, weekday, updated_at)
  select b.workspace_id, b.broadcast_id, b.name, coalesce(nullif(b.channel, ''), 'whatsapp'), coalesce(nullif(b.template, ''), b.subject, ''), b.contacts,
         greatest(coalesce(x.sent, 0), b.sent), coalesce(x.delivered, 0), coalesce(x.read, 0), coalesce(y.replied, 0), greatest(coalesce(x.failed, 0), b.failed),
         b.sent_at, extract(hour from b.sent_at at time zone 'Asia/Kolkata')::int, extract(isodow from b.sent_at at time zone 'Asia/Kolkata')::int, now()
  from public.broadcasts b
  left join lateral (
    select count(*) filter (where m.direction = 'out') as sent,
           count(*) filter (where m.direction = 'out' and m.status in ('delivered', 'read')) as delivered,
           count(*) filter (where m.direction = 'out' and m.status = 'read') as read,
           count(*) filter (where m.direction = 'out' and m.status = 'failed') as failed
    from public.messages m where m.workspace_id = b.workspace_id and m.broadcast_id = b.broadcast_id) x on true
  left join lateral (
    select count(distinct o.lead_id) as replied from public.messages o
    where o.workspace_id = b.workspace_id and o.broadcast_id = b.broadcast_id and o.direction = 'out' and o.lead_id is not null
      and exists (select 1 from public.messages i where i.workspace_id = o.workspace_id and i.lead_id = o.lead_id and i.direction = 'in' and i.time > o.time and i.time < o.time + interval '3 days')) y on true
  where b.workspace_id = p_ws
  on conflict (workspace_id, broadcast_id) do update set name = excluded.name, channel = excluded.channel, template = excluded.template, contacts = excluded.contacts,
    sent = excluded.sent, delivered = excluded.delivered, read = excluded.read, replied = excluded.replied, failed = excluded.failed,
    sent_at = excluded.sent_at, send_hour = excluded.send_hour, weekday = excluded.weekday, updated_at = now();
  get diagnostics n = row_count;
  update public.broadcasts b set delivered = c.delivered, read = c.read, replies = c.replied
    from public.campaign_stats c where c.workspace_id = b.workspace_id and c.broadcast_id = b.broadcast_id and b.workspace_id = p_ws;
  return n;
end $$;

-- ---------- 6. Template library: use-case, tags, notes ----------
alter table public.templates add column if not exists use_case text not null default '';
alter table public.templates add column if not exists tags     text not null default '';
alter table public.templates add column if not exists notes    text not null default '';

-- ---------- 7. Live updates + access ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['calls', 'tasks'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

revoke execute on function public.member_access(uuid, uuid), public.visible_lead_ids(uuid, uuid, text[]), public.lead_access(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.my_access(uuid), public.set_member_access(uuid, uuid, text, text, text[], jsonb), public.list_members(uuid), public.refresh_campaign_stats(uuid) from public, anon;
grant execute on function public.my_access(uuid), public.set_member_access(uuid, uuid, text, text, text[], jsonb), public.list_members(uuid), public.refresh_campaign_stats(uuid),
  public.can_see_lead(uuid, text, text, text, text), public.sees_all(uuid), public.has_perm(uuid, text) to authenticated;
grant all on public.calls, public.tasks, public.campaign_stats to service_role;
grant execute on all functions in schema public to service_role;
