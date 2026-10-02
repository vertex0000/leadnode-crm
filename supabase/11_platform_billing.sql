-- Nodevers 11 — Platform owner tools: platform team (roles), platform-wide brand, plans, client subscriptions, payments, limits, audit log.
-- The platform team edits everything from Admin Console; clients only see their own plan. Safe to run more than once. Needs 08 + 10 first.

-- ---------- 1. Platform team with roles ----------
alter table public.platform_admins add column if not exists role text not null default 'admin';
alter table public.platform_admins drop constraint if exists platform_admins_role_check;
alter table public.platform_admins add constraint platform_admins_role_check check (role in ('super', 'admin', 'support', 'finance'));
alter table public.platform_admins add column if not exists added_by text not null default '';
alter table public.platform_admins add column if not exists created_at timestamptz not null default now();
update public.platform_admins set role = 'super' where email = 'shivamwaghmare4747@gmail.com';

create or replace function public.platform_role() returns text
language sql stable security definer set search_path = public as $$
  select p.role from auth.users u join public.platform_admins p on p.email = lower(u.email)
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null limit 1;
$$;
create or replace function public.has_platform_role(roles text[]) returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(public.platform_role() = any(roles), false); $$;
grant execute on function public.platform_role(), public.has_platform_role(text[]) to authenticated;

create table if not exists public.platform_audit (
  id bigint generated always as identity primary key, at timestamptz not null default now(),
  actor text not null default '', action text not null, target text not null default '', details jsonb not null default '{}'::jsonb);
alter table public.platform_audit enable row level security;
revoke all on public.platform_audit from anon, authenticated;
grant all on public.platform_audit to service_role;
create or replace function public.paudit(p_action text, p_target text, p_details jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.platform_audit (actor, action, target, details) values (coalesce(auth.jwt() ->> 'email', 'system'), p_action, coalesce(p_target, ''), coalesce(p_details, '{}'::jsonb));
$$;
revoke execute on function public.paudit(text, text, jsonb) from public, anon, authenticated;

-- ---------- 2. Platform-wide settings: brand, white label, trial days, support contact ----------
create table if not exists public.platform_settings (
  key text primary key check (key ~ '^[A-Za-z0-9_]{1,40}$'), value text not null default '' check (length(value) <= 20000), updated_at timestamptz not null default now());
alter table public.platform_settings enable row level security;
drop policy if exists ps_read on public.platform_settings;
create policy ps_read on public.platform_settings for select to anon, authenticated using (true);      -- the login page needs the brand too; never store secrets here
grant select on public.platform_settings to anon, authenticated;
grant all on public.platform_settings to service_role;
insert into public.platform_settings (key, value) values ('trialDays', '14'), ('graceDays', '3'), ('currency', 'INR'), ('defaultPlan', 'starter') on conflict (key) do nothing;
-- first run: copy the website name, logo and white label from the super admin's own workspace (clients can no longer change these)
insert into public.platform_settings (key, value)
select distinct on (s.key) s.key, s.value from public.settings s
  join public.workspace_members m on m.workspace_id = s.workspace_id and m.role = 'owner'
  join auth.users u on u.id = m.user_id join public.platform_admins p on p.email = lower(u.email) and p.role = 'super'
where s.key in ('brandName', 'logoUrl', 'accentColor', 'buttonColor', 'loginHeadline', 'loginSub', 'hidePowered', 'subdomain', 'customDomain') and s.value <> ''
order by s.key, m.created_at
on conflict (key) do nothing;

-- ---------- 3. Plans (fully editable by the platform team) ----------
create table if not exists public.plans (
  id          text primary key check (id ~ '^[a-z0-9_-]{2,40}$'),
  name        text not null check (length(name) between 1 and 60),
  description text not null default '' check (length(description) <= 500),
  price       numeric not null default 0 check (price >= 0),
  currency    text not null default 'INR' check (length(currency) <= 8),
  period      text not null default 'month' check (period in ('month', 'year', 'one_time')),
  limits      jsonb not null default '{}'::jsonb,         -- {"members":5,"leads":10000,"wa_messages":5000,"store_connections":2}  (0 / missing = unlimited)
  features    text[] not null default '{}',
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now());
alter table public.plans enable row level security;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to authenticated using (true);
grant select on public.plans to authenticated;
grant all on public.plans to service_role;
insert into public.plans (id, name, description, price, period, limits, features, sort) values
  ('starter', 'Starter', 'For a small business getting started', 999, 'month', '{"members":2,"leads":1000,"wa_messages":1000,"store_connections":1}', '{"CRM + pipeline","WhatsApp inbox","Broadcasts","Store"}', 1),
  ('growth', 'Growth', 'For a growing team', 2499, 'month', '{"members":5,"leads":10000,"wa_messages":5000,"store_connections":2}', '{"Everything in Starter","Automation + n8n","Store alerts","Insights"}', 2),
  ('pro', 'Pro', 'For bigger teams and agencies', 4999, 'month', '{"members":20,"leads":100000,"wa_messages":25000,"store_connections":3}', '{"Everything in Growth","White label","Priority support"}', 3)
on conflict (id) do nothing;

-- ---------- 4. One subscription per client workspace ----------
create table if not exists public.workspace_subscriptions (
  workspace_id       uuid primary key references public.workspaces(id) on delete cascade,
  plan_id            text references public.plans(id) on delete set null,
  status             text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'suspended', 'cancelled', 'free')),
  trial_ends_at      timestamptz,
  current_period_end timestamptz,
  price              numeric check (price is null or price >= 0),        -- custom price for this client (empty = plan price)
  billing_email      text not null default '' check (length(billing_email) <= 200),
  notes              text not null default '' check (length(notes) <= 2000),
  updated_at         timestamptz not null default now());
alter table public.workspace_subscriptions enable row level security;
drop policy if exists sub_read on public.workspace_subscriptions;
create policy sub_read on public.workspace_subscriptions for select to authenticated using (public.is_member(workspace_id));
grant select on public.workspace_subscriptions to authenticated;
grant all on public.workspace_subscriptions to service_role;
-- existing workspaces keep working (free, no expiry) until the platform team sets a plan
insert into public.workspace_subscriptions (workspace_id, status) select w.id, 'free' from public.workspaces w on conflict (workspace_id) do nothing;

-- new sign-ups start a free trial on the default plan
create or replace function public.start_trial() returns trigger
language plpgsql security definer set search_path = public as $$
declare d int; p text;
begin
  select coalesce(nullif(value, '')::int, 14) into d from public.platform_settings where key = 'trialDays';
  select nullif(value, '') into p from public.platform_settings where key = 'defaultPlan';
  if p is not null and not exists (select 1 from public.plans where id = p) then p := null; end if;
  insert into public.workspace_subscriptions (workspace_id, plan_id, status, trial_ends_at) values (new.id, p, 'trial', now() + make_interval(days => coalesce(d, 14))) on conflict do nothing;
  return new;
exception when others then return new;
end $$;
drop trigger if exists workspaces_trial on public.workspaces;
create trigger workspaces_trial after insert on public.workspaces for each row execute function public.start_trial();

-- ---------- 5. Payments (recorded by the platform team; Razorpay later) ----------
create table if not exists public.platform_payments (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  amount       numeric not null check (amount >= 0),
  currency     text not null default 'INR',
  method       text not null default '' check (length(method) <= 40),
  reference    text not null default '' check (length(reference) <= 120),
  months       integer not null default 1 check (months between 0 and 36),
  paid_at      timestamptz not null default now(),
  period_end   timestamptz,
  recorded_by  text not null default '',
  notes        text not null default '' check (length(notes) <= 500));
create index if not exists platform_payments_ws on public.platform_payments (workspace_id, paid_at desc);
alter table public.platform_payments enable row level security;
drop policy if exists pay_read on public.platform_payments;
create policy pay_read on public.platform_payments for select to authenticated using (public.is_member(workspace_id));
grant select on public.platform_payments to authenticated;
grant all on public.platform_payments to service_role;

-- ---------- 6. Expired / suspended workspaces become view-only ----------
create or replace function public.ws_state(ws uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when s.workspace_id is null or s.status = 'free' then 'ok'
    when s.status in ('suspended', 'cancelled') then 'locked'
    when s.status = 'trial' and s.trial_ends_at is not null and s.trial_ends_at < now() then 'locked'
    when s.status in ('active', 'past_due') and s.current_period_end is not null
         and s.current_period_end + make_interval(days => coalesce((select nullif(value, '')::int from public.platform_settings where key = 'graceDays'), 3)) < now() then 'locked'
    else 'ok' end
  from (select ws as w) x left join public.workspace_subscriptions s on s.workspace_id = x.w;
$$;
grant execute on function public.ws_state(uuid) to authenticated, service_role;
create or replace function public.can_write(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin', 'member'))
     and public.ws_state(ws) <> 'locked';
$$;

-- plan limits for leads and team members (0 / missing = unlimited)
create or replace function public.plan_limit(ws uuid, k text) returns integer
language sql stable security definer set search_path = public as $$
  select nullif((p.limits ->> k)::int, 0) from public.workspace_subscriptions s join public.plans p on p.id = s.plan_id where s.workspace_id = ws and s.status <> 'free';
$$;
create or replace function public.enforce_lead_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim int; n int;
begin
  lim := public.plan_limit(new.workspace_id, 'leads'); if lim is null then return new; end if;
  select count(*) into n from public.leads where workspace_id = new.workspace_id;
  if n >= lim then raise exception 'Plan limit reached: % leads. Upgrade in Settings → Plan & billing.', lim; end if;
  return new;
end $$;
drop trigger if exists leads_limit on public.leads;
create trigger leads_limit before insert on public.leads for each row execute function public.enforce_lead_limit();
create or replace function public.enforce_member_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim int; n int;
begin
  lim := public.plan_limit(new.workspace_id, 'members'); if lim is null then return new; end if;
  select count(*) into n from public.workspace_members where workspace_id = new.workspace_id and role <> 'client';
  if new.role <> 'client' and n >= lim then raise exception 'Plan limit reached: % team members. Upgrade in Settings → Plan & billing.', lim; end if;
  return new;
end $$;
drop trigger if exists members_limit on public.workspace_members;
create trigger members_limit before insert on public.workspace_members for each row execute function public.enforce_member_limit();

-- ---------- 7. What a client sees: my plan ----------
create or replace function public.my_subscription(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.workspace_subscriptions%rowtype; p public.plans%rowtype; ends timestamptz;
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  select * into s from public.workspace_subscriptions where workspace_id = p_ws;
  if s.plan_id is not null then select * into p from public.plans where id = s.plan_id; end if;
  ends := case when s.status = 'trial' then s.trial_ends_at else s.current_period_end end;
  return jsonb_build_object('status', coalesce(s.status, 'free'), 'state', public.ws_state(p_ws), 'plan_id', s.plan_id, 'plan_name', coalesce(p.name, case when coalesce(s.status, 'free') = 'free' then 'Free' else '' end),
    'price', coalesce(s.price, p.price), 'currency', coalesce(p.currency, 'INR'), 'period', p.period, 'limits', coalesce(p.limits, '{}'::jsonb), 'features', to_jsonb(coalesce(p.features, '{}'::text[])),
    'ends_at', ends, 'days_left', case when ends is null then null else ceil(extract(epoch from (ends - now())) / 86400)::int end,
    'usage', jsonb_build_object('members', (select count(*) from public.workspace_members where workspace_id = p_ws and role <> 'client'), 'leads', (select count(*) from public.leads where workspace_id = p_ws),
      'wa_messages', (select count(*) from public.messages where workspace_id = p_ws and direction = 'out' and time > date_trunc('month', now())),
      'store_connections', (select count(*) from public.store_connections where workspace_id = p_ws)),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'currency', currency, 'method', method, 'reference', reference, 'months', months, 'paid_at', paid_at, 'period_end', period_end) order by paid_at desc) from (select * from public.platform_payments where workspace_id = p_ws order by paid_at desc limit 12) q), '[]'::jsonb),
    'support', (select jsonb_object_agg(key, value) from public.platform_settings where key in ('supportEmail', 'supportPhone', 'renewLink')));
end $$;
grant execute on function public.my_subscription(uuid) to authenticated;

-- ---------- 8. Admin Console actions (all logged) ----------
create or replace function public.admin_overview2() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin', 'support', 'finance']) then raise exception 'Platform team only'; end if;
  return coalesce((select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
    select w.id as workspace_id, w.name, u.email::text as owner_email, w.created_at,
      s.plan_id, p.name as plan_name, coalesce(s.status, 'free') as status, s.trial_ends_at, s.current_period_end, coalesce(s.price, p.price) as price, p.period, s.notes, s.billing_email,
      public.ws_state(w.id) as state,
      case when s.status = 'trial' then s.trial_ends_at else s.current_period_end end as ends_at,
      (select count(*) from public.workspace_members m where m.workspace_id = w.id and m.role <> 'client')::int as members,
      (select count(*) from public.leads l where l.workspace_id = w.id)::int as leads,
      (select count(*) from public.leads l where l.workspace_id = w.id and l.created_at > now() - interval '30 days')::int as leads_30d,
      (select count(*) from public.messages x where x.workspace_id = w.id and x.direction = 'out' and x.time > date_trunc('month', now()))::int as wa_month,
      (select count(*) from public.orders o where o.workspace_id = w.id and o.created_at > now() - interval '30 days')::int as orders_30d,
      (select count(*) from public.store_connections c where c.workspace_id = w.id)::int as stores,
      coalesce((select a.display_phone from public.wa_accounts a where a.workspace_id = w.id), '') as wa_phone,
      exists (select 1 from public.email_accounts e where e.workspace_id = w.id) as email_on,
      (select coalesce(sum(amount), 0) from public.platform_payments pp where pp.workspace_id = w.id) as paid_total,
      (select max(paid_at) from public.platform_payments pp where pp.workspace_id = w.id) as last_payment,
      greatest((select max(l.updated_at) from public.leads l where l.workspace_id = w.id), (select max(a.date_time) from public.activities a where a.workspace_id = w.id), w.created_at) as last_active
    from public.workspaces w left join auth.users u on u.id = w.owner_id
    left join public.workspace_subscriptions s on s.workspace_id = w.id left join public.plans p on p.id = s.plan_id) x), '[]'::jsonb);
end $$;

create or replace function public.admin_sub_save(p_ws uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin', 'finance']) then raise exception 'Not allowed for your platform role'; end if;
  insert into public.workspace_subscriptions (workspace_id) values (p_ws) on conflict do nothing;
  update public.workspace_subscriptions set
    plan_id = case when p ? 'plan_id' then nullif(p ->> 'plan_id', '') else plan_id end,
    status = coalesce(nullif(p ->> 'status', ''), status),
    trial_ends_at = case when p ? 'trial_ends_at' then nullif(p ->> 'trial_ends_at', '')::timestamptz else trial_ends_at end,
    current_period_end = case when p ? 'current_period_end' then nullif(p ->> 'current_period_end', '')::timestamptz else current_period_end end,
    price = case when p ? 'price' then nullif(p ->> 'price', '')::numeric else price end,
    billing_email = case when p ? 'billing_email' then left(p ->> 'billing_email', 200) else billing_email end,
    notes = case when p ? 'notes' then left(p ->> 'notes', 2000) else notes end,
    updated_at = now()
  where workspace_id = p_ws;
  perform public.paudit('subscription.update', p_ws::text, p);
end $$;

create or replace function public.admin_payment_add(p_ws uuid, p jsonb) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare m int := coalesce((p ->> 'months')::int, 1); cur timestamptz; nend timestamptz;
begin
  if not public.has_platform_role(array['super', 'admin', 'finance']) then raise exception 'Not allowed for your platform role'; end if;
  insert into public.workspace_subscriptions (workspace_id, status) values (p_ws, 'active') on conflict do nothing;
  select current_period_end into cur from public.workspace_subscriptions where workspace_id = p_ws;
  nend := case when m > 0 then greatest(now(), coalesce(cur, now())) + make_interval(months => m) else cur end;
  insert into public.platform_payments (workspace_id, amount, currency, method, reference, months, paid_at, period_end, recorded_by, notes)
  values (p_ws, coalesce((p ->> 'amount')::numeric, 0), coalesce(nullif(p ->> 'currency', ''), 'INR'), left(coalesce(p ->> 'method', ''), 40), left(coalesce(p ->> 'reference', ''), 120), m,
          coalesce(nullif(p ->> 'paid_at', '')::timestamptz, now()), nend, coalesce(auth.jwt() ->> 'email', ''), left(coalesce(p ->> 'notes', ''), 500));
  if m > 0 then update public.workspace_subscriptions set status = 'active', current_period_end = nend, updated_at = now() where workspace_id = p_ws; end if;
  perform public.paudit('payment.add', p_ws::text, p || jsonb_build_object('period_end', nend));
  return nend;
end $$;

create or replace function public.admin_payments() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin', 'finance']) then raise exception 'Not allowed for your platform role'; end if;
  return coalesce((select jsonb_agg(row_to_json(x) order by x.paid_at desc) from (select pp.*, w.name as workspace_name from public.platform_payments pp join public.workspaces w on w.id = pp.workspace_id order by pp.paid_at desc limit 500) x), '[]'::jsonb);
end $$;

create or replace function public.admin_plan_save(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Not allowed for your platform role'; end if;
  insert into public.plans (id, name, description, price, currency, period, limits, features, active, sort, updated_at)
  values (lower(p ->> 'id'), p ->> 'name', coalesce(p ->> 'description', ''), coalesce((p ->> 'price')::numeric, 0), coalesce(nullif(p ->> 'currency', ''), 'INR'), coalesce(nullif(p ->> 'period', ''), 'month'),
          coalesce(p -> 'limits', '{}'::jsonb), coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'features', '[]'::jsonb)) x), '{}'), coalesce((p ->> 'active')::boolean, true), coalesce((p ->> 'sort')::int, 0), now())
  on conflict (id) do update set name = excluded.name, description = excluded.description, price = excluded.price, currency = excluded.currency, period = excluded.period,
    limits = excluded.limits, features = excluded.features, active = excluded.active, sort = excluded.sort, updated_at = now();
  perform public.paudit('plan.save', p ->> 'id', p);
end $$;
create or replace function public.admin_plan_delete(p_id text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Not allowed for your platform role'; end if;
  if exists (select 1 from public.workspace_subscriptions where plan_id = p_id) then
    update public.plans set active = false, updated_at = now() where id = p_id; perform public.paudit('plan.hide', p_id, '{}'); return 'hidden';
  end if;
  delete from public.plans where id = p_id; perform public.paudit('plan.delete', p_id, '{}'); return 'deleted';
end $$;

create or replace function public.admin_team() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Not allowed for your platform role'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('email', p.email, 'role', p.role, 'added_by', p.added_by, 'created_at', p.created_at,
    'has_account', exists (select 1 from auth.users u where lower(u.email) = p.email and u.email_confirmed_at is not null)) order by p.created_at) from public.platform_admins p), '[]'::jsonb);
end $$;
create or replace function public.admin_team_save(p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email));
begin
  if not public.has_platform_role(array['super']) then raise exception 'Only a super admin can manage the platform team'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email'; end if;
  if p_role not in ('super', 'admin', 'support', 'finance') then raise exception 'Unknown role'; end if;
  if e = lower(auth.jwt() ->> 'email') and p_role <> 'super' and (select count(*) from public.platform_admins where role = 'super') <= 1 then raise exception 'You are the only super admin — add another super admin first'; end if;
  insert into public.platform_admins (email, role, added_by) values (e, p_role, coalesce(auth.jwt() ->> 'email', '')) on conflict (email) do update set role = excluded.role;
  perform public.paudit('team.save', e, jsonb_build_object('role', p_role));
end $$;
create or replace function public.admin_team_remove(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_email));
begin
  if not public.has_platform_role(array['super']) then raise exception 'Only a super admin can manage the platform team'; end if;
  if e = lower(auth.jwt() ->> 'email') then raise exception 'You can not remove yourself'; end if;
  delete from public.platform_admins where email = e; perform public.paudit('team.remove', e, '{}');
end $$;

create or replace function public.admin_setting_save(p_key text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Not allowed for your platform role'; end if;
  if p_key !~ '^[A-Za-z0-9_]{1,40}$' then raise exception 'Bad key'; end if;
  insert into public.platform_settings (key, value, updated_at) values (p_key, left(coalesce(p_value, ''), 20000), now()) on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public.paudit('setting.save', p_key, jsonb_build_object('value', left(coalesce(p_value, ''), 200)));
end $$;

create or replace function public.admin_audit(p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Not allowed for your platform role'; end if;
  return coalesce((select jsonb_agg(row_to_json(a) order by a.id desc) from (select * from public.platform_audit order by id desc limit least(greatest(p_limit, 1), 1000)) a), '[]'::jsonb);
end $$;

revoke execute on function public.admin_overview2(), public.admin_sub_save(uuid, jsonb), public.admin_payment_add(uuid, jsonb), public.admin_payments(), public.admin_plan_save(jsonb), public.admin_plan_delete(text),
  public.admin_team(), public.admin_team_save(text, text), public.admin_team_remove(text), public.admin_setting_save(text, text), public.admin_audit(int) from public, anon;
grant execute on function public.admin_overview2(), public.admin_sub_save(uuid, jsonb), public.admin_payment_add(uuid, jsonb), public.admin_payments(), public.admin_plan_save(jsonb), public.admin_plan_delete(text),
  public.admin_team(), public.admin_team_save(text, text), public.admin_team_remove(text), public.admin_setting_save(text, text), public.admin_audit(int) to authenticated;
