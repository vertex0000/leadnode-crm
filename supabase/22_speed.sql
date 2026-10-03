-- Nodevers 22 — speed for big workspaces (50,000 – 1,00,000+ leads).
-- 1. Security rules (RLS) are checked once per query instead of once per row  → lists load ~100× faster.
-- 2. Indexes for the lists the website reads (newest leads, timeline, orders, tasks, calls, messages).
-- 3. New IDs (L1234, A5678…) come from a small counter instead of scanning the whole table on every insert
--    → imports of thousands of leads stay fast.
-- 4. Plan limit is checked once per import instead of once per row.
-- 5. lead_stats(): counts and ₹ totals per stage / tag / source / owner computed on the server, so the website
--    no longer has to download every lead to show the pipeline and dashboard numbers.
-- Who-can-see-what does not change. Nothing is deleted. Safe to run more than once. Run after 01–21.

-- ---------- 1. one-time access lists (evaluated once per query) ----------
create or replace function public.my_ws() returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid())
  union
  select w.id from public.workspaces w where public.is_platform_admin();
$$;
create or replace function public.my_full_ws() returns setof uuid   -- workspaces where I see every lead (owner, admin, "all leads", platform team)
language sql stable security definer set search_path = public as $$
  select m.workspace_id from public.workspace_members m where m.user_id = (select auth.uid()) and (m.role in ('owner', 'admin') or m.scope = 'all')
  union
  select w.id from public.workspaces w where public.is_platform_admin();
$$;
revoke execute on function public.my_ws() from public, anon;
revoke execute on function public.my_full_ws() from public, anon;
grant execute on function public.my_ws() to authenticated;
grant execute on function public.my_full_ws() to authenticated;

-- leads: full-access workspaces skip the per-lead area check
drop policy if exists ws_select on public.leads;
create policy ws_select on public.leads for select to authenticated using (
  workspace_id in (select public.my_full_ws())
  or (workspace_id in (select public.my_ws()) and public.can_see_lead(workspace_id, state, district, city, assigned_to)));

drop policy if exists ws_select on public.activities;
create policy ws_select on public.activities for select to authenticated using (
  workspace_id in (select public.my_full_ws())
  or (workspace_id in (select public.my_ws()) and exists (select 1 from public.leads l where l.workspace_id = activities.workspace_id and l.lead_id = activities.lead_id)));

drop policy if exists ws_select on public.messages;
create policy ws_select on public.messages for select to authenticated using (
  workspace_id in (select public.my_full_ws())
  or (workspace_id in (select public.my_ws()) and lead_id is not null and exists (select 1 from public.leads l where l.workspace_id = messages.workspace_id and l.lead_id = messages.lead_id)));

do $$ begin
  if to_regclass('public.orders') is not null then
    drop policy if exists o_select on public.orders;
    create policy o_select on public.orders for select to authenticated using (
      workspace_id in (select public.my_full_ws())
      or (workspace_id in (select public.my_ws()) and (lead_id is null or exists (select 1 from public.leads l where l.workspace_id = orders.workspace_id and l.lead_id = orders.lead_id))));
  end if;
  if to_regclass('public.tasks') is not null then
    drop policy if exists k_select on public.tasks;
    create policy k_select on public.tasks for select to authenticated using (
      workspace_id in (select public.my_full_ws())
      or (workspace_id in (select public.my_ws()) and (lead_id is null or exists (select 1 from public.leads l where l.workspace_id = tasks.workspace_id and l.lead_id = tasks.lead_id))));
  end if;
  if to_regclass('public.calls') is not null then
    drop policy if exists c_select on public.calls;
    create policy c_select on public.calls for select to authenticated using (
      workspace_id in (select public.my_full_ws())
      or (workspace_id in (select public.my_ws()) and (user_id = (select auth.uid()) or exists (select 1 from public.leads l where l.workspace_id = calls.workspace_id and l.lead_id = calls.lead_id))));
  end if;
end $$;

-- tables that were readable by every member: same rule, checked once per query
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
           where schemaname = 'public' and cmd = 'SELECT' and regexp_replace(qual, '\s', '', 'g') = 'is_member(workspace_id)'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format('create policy %I on public.%I for select to authenticated using (workspace_id in (select public.my_ws()))', r.policyname, r.tablename);
  end loop;
end $$;

-- write rules made "for all" also run on every read: split them into insert / update / delete (same conditions)
do $$
declare r record;
begin
  for r in select tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' and cmd = 'ALL'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format('drop policy if exists %I on public.%I', r.policyname || '_ins', r.tablename);
    execute format('drop policy if exists %I on public.%I', r.policyname || '_upd', r.tablename);
    execute format('drop policy if exists %I on public.%I', r.policyname || '_del', r.tablename);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', r.policyname || '_ins', r.tablename, coalesce(r.with_check, r.qual));
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', r.policyname || '_upd', r.tablename, coalesce(r.qual, 'true'), coalesce(r.with_check, r.qual, 'true'));
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', r.policyname || '_del', r.tablename, coalesce(r.qual, 'true'));
  end loop;
end $$;

-- ---------- 2. indexes for the lists the website reads ----------
create index if not exists leads_ws_created_idx on public.leads (workspace_id, created_at desc);
create index if not exists leads_ws_stage_idx on public.leads (workspace_id, stage);
create index if not exists leads_ws_followup_idx on public.leads (workspace_id, follow_up_date);
create index if not exists activities_ws_time_idx on public.activities (workspace_id, date_time desc);
create index if not exists messages_ws_time_idx on public.messages (workspace_id, time desc);
create index if not exists messages_ws_lead_idx on public.messages (workspace_id, lead_id);
do $$ begin
  if to_regclass('public.orders') is not null then create index if not exists orders_ws_created_idx on public.orders (workspace_id, created_at desc); end if;
  if to_regclass('public.tasks') is not null then create index if not exists tasks_ws_due_idx on public.tasks (workspace_id, due_at); create index if not exists tasks_ws_lead_idx on public.tasks (workspace_id, lead_id); end if;
  if to_regclass('public.calls') is not null then create index if not exists calls_ws_time_idx on public.calls (workspace_id, called_at desc); end if;
end $$;

-- ---------- 3. new IDs from a counter (no full-table scan per insert) ----------
create table if not exists public.id_counters (
  workspace_id uuid not null,
  tbl text not null,
  n bigint not null default 0,
  primary key (workspace_id, tbl)
);
alter table public.id_counters enable row level security;   -- server only
revoke all on public.id_counters from anon, authenticated;

create or replace function public.set_code() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p   text := tg_argv[0];      -- prefix, e.g. 'L'
  col text := tg_argv[1];      -- id column, e.g. 'lead_id'
  cur text := to_jsonb(new) ->> col;
  vn  bigint; code text; taken boolean;
begin
  if cur is null or cur = '' then
    perform pg_advisory_xact_lock(hashtext(tg_table_name || new.workspace_id::text));
    select c.n into vn from public.id_counters c where c.workspace_id = new.workspace_id and c.tbl = tg_table_name;
    if vn is null then   -- first time for this table: start after the highest existing number (one scan, then never again)
      execute format('select coalesce(max((substring(%I from %L))::bigint), 0) from public.%I where workspace_id = $1',
                     col, '^' || p || '([0-9]{1,15})$', tg_table_name) into vn using new.workspace_id;
      insert into public.id_counters (workspace_id, tbl, n) values (new.workspace_id, tg_table_name, vn)
        on conflict (workspace_id, tbl) do update set n = greatest(public.id_counters.n, excluded.n);
    end if;
    loop   -- skip numbers already used (e.g. rows imported with their own IDs)
      vn := vn + 1;
      code := p || case when vn < 1000 then lpad(vn::text, 3, '0') else vn::text end;
      execute format('select exists (select 1 from public.%I where workspace_id = $1 and %I = $2)', tg_table_name, col) into taken using new.workspace_id, code;
      exit when not taken;
    end loop;
    update public.id_counters set n = vn where workspace_id = new.workspace_id and tbl = tg_table_name;
    new := jsonb_populate_record(new, jsonb_build_object(col, code));
  end if;
  return new;
end $$;

-- ---------- 4. plan limit: once per insert statement ----------
create or replace function public.enforce_lead_limit_stmt() returns trigger
language plpgsql security definer set search_path = public as $$
declare w uuid; lim int; n int;
begin
  for w in select distinct workspace_id from newrows loop
    lim := public.plan_limit(w, 'leads');
    if lim is not null then
      select count(*) into n from public.leads where workspace_id = w;
      if n > lim then raise exception 'Plan limit reached: % leads. Upgrade in Settings → Plan & billing.', lim; end if;
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists leads_limit on public.leads;
drop trigger if exists leads_limit_stmt on public.leads;
create trigger leads_limit_stmt after insert on public.leads referencing new table as newrows
  for each statement execute function public.enforce_lead_limit_stmt();

-- ---------- 5. numbers for the pipeline / dashboard without downloading every lead ----------
-- runs as the signed-in person, so the usual rules decide which leads are counted
create or replace function public.lead_stats(p_ws uuid, p_owner text default null)
returns jsonb language sql stable security invoker set search_path = public as $$
  with l as (
    select stage, tag, source, assigned_to, coalesce(budget, 0) as budget, follow_up_date, created_on
    from public.leads where workspace_id = p_ws and (p_owner is null or lower(assigned_to) = lower(p_owner))
  )
  select jsonb_build_object(
    'total', (select count(*) from l),
    'stages', coalesce((select jsonb_object_agg(stage, jsonb_build_object('n', n, 'sum', s)) from (select stage, count(*) n, sum(budget) s from l group by stage) x), '{}'),
    'tags', coalesce((select jsonb_object_agg(tag, n) from (select coalesce(tag, '') tag, count(*) n from l group by 1) x), '{}'),
    'sources', coalesce((select jsonb_object_agg(source, n) from (select coalesce(source, '') source, count(*) n from l group by 1) x), '{}'),
    'owners', coalesce((select jsonb_object_agg(assigned_to, n) from (select coalesce(assigned_to, '') assigned_to, count(*) n from l group by 1) x), '{}'),
    'followDue', (select count(*) from l where follow_up_date <= current_date and stage not in ('Won', 'Lost')),
    'followToday', (select count(*) from l where follow_up_date = current_date and stage not in ('Won', 'Lost')),
    'hotOpen', (select count(*) from l where tag = 'Hot' and stage not in ('Won', 'Lost')),
    'new7', (select count(*) from l where created_on >= current_date - 6),
    'new30', (select count(*) from l where created_on >= current_date - 29),
    'days', coalesce((select jsonb_object_agg(d, n) from (select created_on::text d, count(*) n from l where created_on >= current_date - 400 group by 1) x), '{}')
  );
$$;
revoke execute on function public.lead_stats(uuid, text) from public, anon;
grant execute on function public.lead_stats(uuid, text) to authenticated;

analyze public.leads; analyze public.activities; analyze public.messages;
