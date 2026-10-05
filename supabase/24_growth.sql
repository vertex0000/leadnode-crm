-- Nodevers 24 — growth: results report, COD → prepaid + RTO risk, referrals, product views (browse reminder),
-- scheduled campaigns, ratings / feedback, "approve before sending" for auto messages.
-- 1. Orders: pincode, RTO risk score (0–100) + reasons for Cash-on-Delivery orders, COD confirmed time. High risk → a call task (if switched on).
-- 2. Referrals: every customer gets a referral code; a friend who orders with that code (coupon) or through the link (?ref=CODE) is
--    tracked; the referrer can get a reward message. Table referrals.
-- 3. Product views from the tracking code (people the website already knows) → "still thinking about it?" reminder.
-- 4. Scheduled campaigns (once / daily / weekly / monthly at a time, IST) — the audience is worked out again on every run.
-- 5. Ratings (1–5 ⭐ buttons) → table feedback; a low rating makes a task and alerts the team.
-- 6. New auto-message kinds: cod_prepaid, rating, browse, ref_ask, ref_reward, campaign. Messages can wait for approval ("hold").
-- 7. growth_report(): how much money remarketing brought (recovered checkouts, auto messages, campaigns, referrals) + COD numbers.
-- Nothing is deleted. Safe to run more than once. Run after 01–23.

-- ---------- 1. new columns ----------
alter table public.orders add column if not exists pincode text not null default '' check (length(pincode) <= 12);
alter table public.orders add column if not exists rto_risk smallint check (rto_risk is null or rto_risk between 0 and 100);
alter table public.orders add column if not exists rto_reasons text not null default '' check (length(rto_reasons) <= 400);
alter table public.orders add column if not exists cod_confirmed_at timestamptz;
create index if not exists orders_ws_pin_idx on public.orders (workspace_id, pincode) where pincode <> '';

alter table public.leads add column if not exists ref_code text check (ref_code is null or ref_code ~ '^[A-Z0-9]{4,16}$');
alter table public.leads add column if not exists referred_by text;
create unique index if not exists leads_ws_refcode_idx on public.leads (workspace_id, ref_code) where ref_code is not null;

alter table public.remarket_jobs drop constraint if exists remarket_jobs_kind_check;
alter table public.remarket_jobs add constraint remarket_jobs_kind_check check (kind in ('thanks', 'cod', 'abandon1', 'abandon2', 'shipped', 'delivered', 'review', 'reorder', 'winback', 'backstock',
  'cod_prepaid', 'rating', 'browse', 'ref_ask', 'ref_reward', 'campaign'));
create index if not exists remarket_jobs_lead_idx on public.remarket_jobs (workspace_id, lead_id, done_at);
create index if not exists remarket_jobs_hold_idx on public.remarket_jobs (workspace_id) where done_at is null and result like 'hold%';

alter table public.alert_queue drop constraint if exists alert_queue_kind_check;
alter table public.alert_queue add constraint alert_queue_kind_check check (kind in ('new_order', 'cancel', 'low_stock', 'out_stock', 'daily', 'test', 'welcome', 'feedback'));

-- ---------- 2. RTO risk for Cash-on-Delivery orders ----------
-- score 0–100 (under 30 low · 30–59 medium · 60+ high) with the reasons, from what the CRM knows about the buyer, the order and the pincode
create or replace function public.order_rto(p_ws uuid, p_lead text, p_order text, p_ref text, p_amount numeric, p_pin text, p_status text, p_confirmed timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s int := 10; why text[] := '{}'; ph text := ''; wa text := ''; rto int := 0; canc int := 0; deliv int := 0; pin_n int := 0; pin_r int := 0; hv numeric := 3000; v text;
begin
  select value into v from public.settings where workspace_id = p_ws and key = 'remarketJson';
  begin hv := coalesce(nullif(v::jsonb #>> '{rto,value}', '')::numeric, 3000); exception when others then hv := 3000; end;
  if p_lead is not null then select coalesce(phone, ''), coalesce(wa_status, '') into ph, wa from public.leads where workspace_id = p_ws and lead_id = p_lead; end if;
  if ph = '' or public.phone_bad(ph) then s := s + 25; why := why || 'No valid phone number'::text;
  elsif wa = 'off' then s := s + 20; why := why || 'Not on WhatsApp'::text; end if;
  if p_lead is not null then
    select count(*) filter (where status in ('RTO', 'Returned')), count(*) filter (where status = 'Cancelled'), count(*) filter (where status = 'Delivered')
      into rto, canc, deliv from public.orders
      where workspace_id = p_ws and lead_id = p_lead and order_id <> coalesce(p_order, '') and coalesce(nullif(order_ref, ''), order_id) <> coalesce(p_ref, '');
  end if;
  if rto > 0 then s := s + 35; why := why || ('Earlier RTO / return (' || rto || ')'); end if;
  if canc >= 2 then s := s + 10; why := why || ('Cancelled before (' || canc || ')'); end if;
  if deliv = 0 then s := s + 10; why := why || 'First order'::text; elsif deliv >= 2 then s := s - 20; why := why || ('Trusted buyer — ' || deliv || ' delivered'); end if;
  if coalesce(p_amount, 0) >= hv then s := s + 15; why := why || ('High-value COD (₹' || to_char(round(p_amount), 'FM999,999,999,990') || ')'); end if;
  if coalesce(p_pin, '') <> '' then
    select count(*), count(*) filter (where status in ('RTO', 'Returned')) into pin_n, pin_r from public.orders
      where workspace_id = p_ws and pincode = p_pin and created_at > now() - interval '180 days' and status in ('Delivered', 'RTO', 'Returned');
    if pin_n >= 3 and pin_r::numeric / pin_n >= 0.3 then s := s + 20; why := why || ('Many RTOs to pincode ' || p_pin); end if;
  end if;
  if p_confirmed is not null or p_status = 'Confirmed' then s := s - 40; why := why || 'Confirmed on WhatsApp'::text;
  elsif exists (select 1 from public.remarket_jobs j where j.workspace_id = p_ws and j.kind = 'cod' and j.ref = coalesce(p_ref, p_order) and j.result like 'sent%' and j.done_at < now() - interval '12 hours') then
    s := s + 10; why := why || 'No reply to the COD confirmation'::text; end if;
  return jsonb_build_object('score', greatest(0, least(100, s)), 'reasons', left(array_to_string(why, ' · '), 400));
end $$;
revoke execute on function public.order_rto(uuid, text, text, text, numeric, text, text, timestamptz) from public, anon, authenticated;

create or replace function public.order_rto_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb; day0 date := (now() at time zone 'Asia/Kolkata')::date;
begin
  new.pincode := left(regexp_replace(coalesce(new.pincode, ''), '\s', '', 'g'), 12);
  if tg_op = 'UPDATE' and new.status = 'Confirmed' and old.status in ('COD', 'New', 'Processing') and new.cod_confirmed_at is null then new.cod_confirmed_at := now(); end if;
  if not (new.status = 'COD' or new.payment ~* '(^|\W)(cod|cash)') then return new; end if;
  if new.status not in ('COD', 'New', 'Processing', 'Confirmed') or coalesce(new.order_date, day0) < day0 - 30 then return new; end if;   -- shipped / old: keep the last score
  if tg_op = 'UPDATE' and new.rto_risk is not null and new.status is not distinct from old.status and new.payment is not distinct from old.payment and new.amount is not distinct from old.amount
     and new.pincode is not distinct from old.pincode and new.lead_id is not distinct from old.lead_id and new.cod_confirmed_at is not distinct from old.cod_confirmed_at then return new; end if;
  r := public.order_rto(new.workspace_id, new.lead_id, new.order_id, coalesce(nullif(new.order_ref, ''), new.order_id), new.amount, new.pincode, new.status, new.cod_confirmed_at);
  new.rto_risk := (r ->> 'score')::int; new.rto_reasons := r ->> 'reasons';
  return new;
exception when others then return new;
end $$;
drop trigger if exists orders_rto on public.orders;
create trigger orders_rto before insert or update on public.orders for each row execute function public.order_rto_trg();

-- high risk → one "call before shipping" task per order (Auto messages → Cash on Delivery → "Call task for high-risk orders")
create or replace function public.order_rto_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare v text; ref text := coalesce(nullif(new.order_ref, ''), new.order_id); who text;
begin
  if coalesce(new.rto_risk, 0) < 60 or (tg_op = 'UPDATE' and coalesce(old.rto_risk, 0) >= 60) or new.lead_id is null then return null; end if;
  if coalesce(new.source, '') ilike 'import%' then return null; end if;
  select value into v from public.settings where workspace_id = new.workspace_id and key = 'remarketJson';
  begin if coalesce(v::jsonb #>> '{rto,task}', 'false') <> 'true' then return null; end if; exception when others then return null; end;
  if exists (select 1 from public.tasks t where t.workspace_id = new.workspace_id and t.source = 'rto' and t.lead_id = new.lead_id and t.title like '%' || ref || '%') then return null; end if;
  select assigned_to into who from public.leads where workspace_id = new.workspace_id and lead_id = new.lead_id;
  insert into public.tasks (workspace_id, lead_id, title, notes, due_at, priority, assigned_to, source)
  values (new.workspace_id, new.lead_id, left('Call before shipping — COD ' || ref || ' is high RTO risk (' || new.rto_risk || ')', 200), left(new.rto_reasons, 2000), now() + interval '2 hours', 'High', coalesce(who, ''), 'rto');
  return null;
exception when others then return null;
end $$;
drop trigger if exists orders_rto_task on public.orders;
create trigger orders_rto_task after insert or update of rto_risk on public.orders for each row execute function public.order_rto_task();

-- ---------- 3. referrals ----------
create or replace function public.make_ref_code(p_ws uuid, p_name text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare base text := left(upper(regexp_replace(split_part(coalesce(p_name, ''), ' ', 1), '[^A-Za-z]', '', 'g')), 6); c text; i int;
begin
  if length(base) < 2 then base := 'FRIEND'; end if;
  for i in 1..30 loop
    c := base || (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 3));
    if not exists (select 1 from public.leads where workspace_id = p_ws and ref_code = c) then return c; end if;
  end loop;
  return 'R' || upper(substr(md5(random()::text), 1, 9));
end $$;
revoke execute on function public.make_ref_code(uuid, text) from public, anon, authenticated;
-- a customer (first order) gets a code
create or replace function public.lead_refcode() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ref_code is null and coalesce(new.orders_count, 0) > 0 then new.ref_code := public.make_ref_code(new.workspace_id, new.name); end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists leads_refcode on public.leads;
create trigger leads_refcode before update of orders_count on public.leads for each row execute function public.lead_refcode();

create table if not exists public.referrals (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  friend_id    text not null,                    -- the new customer
  referrer_id  text not null,                    -- the customer who shared the code / link
  code         text not null default '',
  via          text not null default 'link' check (via in ('link', 'coupon', 'manual')),
  status       text not null default 'joined' check (status in ('joined', 'ordered', 'rewarded')),
  order_ref    text not null default '',
  created_at   timestamptz not null default now(),
  ordered_at   timestamptz,
  rewarded_at  timestamptz,
  primary key (workspace_id, friend_id)
);
create index if not exists referrals_ws_referrer_idx on public.referrals (workspace_id, referrer_id);
alter table public.referrals enable row level security;
drop policy if exists rf_select on public.referrals;
create policy rf_select on public.referrals for select to authenticated using (workspace_id in (select public.my_ws()));
drop policy if exists rf_upd on public.referrals;
create policy rf_upd on public.referrals for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
revoke all on public.referrals from anon, authenticated;
grant select, update (status, rewarded_at) on public.referrals to authenticated;
grant all on public.referrals to service_role;

-- a friend joined through a link (tracking code) — only people who have not ordered yet count
create or replace function public.referral_join(p_ws uuid, p_friend text, p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
declare rid text;
begin
  if p_friend is null or coalesce(p_code, '') = '' then return false; end if;
  select lead_id into rid from public.leads where workspace_id = p_ws and ref_code = upper(p_code);
  if rid is null or rid = p_friend then return false; end if;
  if exists (select 1 from public.leads where workspace_id = p_ws and lead_id = p_friend and orders_count > 0) then return false; end if;
  insert into public.referrals (workspace_id, friend_id, referrer_id, code, via) values (p_ws, p_friend, rid, upper(p_code), 'link') on conflict do nothing;
  update public.leads set referred_by = rid where workspace_id = p_ws and lead_id = p_friend and referred_by is null;
  return true;
end $$;
revoke execute on function public.referral_join(uuid, text, text) from public, anon, authenticated;
grant execute on function public.referral_join(uuid, text, text) to service_role;

-- an order: a joined friend → ordered; or the coupon is someone's referral code → ordered. Then the reward message (if switched on).
create or replace function public.order_referral() returns trigger
language plpgsql security definer set search_path = public as $$
declare rid text; ref text := coalesce(nullif(new.order_ref, ''), new.order_id); r jsonb;
begin
  if new.lead_id is null or new.status in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') or coalesce(new.source, '') ilike 'import%' then return null; end if;
  update public.referrals set status = 'ordered', order_ref = ref, ordered_at = now() where workspace_id = new.workspace_id and friend_id = new.lead_id and status = 'joined' returning referrer_id into rid;
  if rid is null and coalesce(new.coupon, '') <> '' and not exists (select 1 from public.referrals where workspace_id = new.workspace_id and friend_id = new.lead_id) then
    select lead_id into rid from public.leads where workspace_id = new.workspace_id and ref_code = upper(new.coupon) and lead_id <> new.lead_id;
    if rid is not null and not exists (select 1 from public.orders o where o.workspace_id = new.workspace_id and o.lead_id = new.lead_id and coalesce(nullif(o.order_ref, ''), o.order_id) <> ref
                                       and o.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') and o.created_at < new.created_at) then
      insert into public.referrals (workspace_id, friend_id, referrer_id, code, via, status, order_ref, ordered_at) values (new.workspace_id, new.lead_id, rid, upper(new.coupon), 'coupon', 'ordered', ref, now()) on conflict do nothing;
      update public.leads set referred_by = rid where workspace_id = new.workspace_id and lead_id = new.lead_id and referred_by is null;
    else rid := null; end if;
  end if;
  if rid is not null then
    r := public.remarket_rule(new.workspace_id, 'ref_reward');
    if r is not null then insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, rid, 'ref_reward', 'rw:' || new.lead_id, now() + interval '1 minute', jsonb_build_object('friend_id', new.lead_id, 'order_ref', ref)) on conflict do nothing; end if;
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists orders_referral on public.orders;
create trigger orders_referral after insert on public.orders for each row execute function public.order_referral();

-- ---------- 4. product views → "still thinking about it?" ----------
create table if not exists public.product_views (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id      text not null,
  pkey         text not null,                    -- the SKU, or the product name in lower case
  sku          text not null default '',
  name         text not null default '' check (length(name) <= 200),
  url          text not null default '' check (length(url) <= 1000),
  price        numeric,
  views        integer not null default 1,
  first_at     timestamptz not null default now(),
  last_at      timestamptz not null default now(),
  primary key (workspace_id, lead_id, pkey),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, lead_id) on delete cascade
);
create index if not exists product_views_ws_time_idx on public.product_views (workspace_id, last_at desc);
alter table public.product_views enable row level security;
drop policy if exists pv_select on public.product_views;
create policy pv_select on public.product_views for select to authenticated using (workspace_id in (select public.my_ws()));
revoke all on public.product_views from anon, authenticated;
grant select on public.product_views to authenticated;
grant all on public.product_views to service_role;

-- the profile for a phone / email, without making a new one (product views only count for people the CRM already knows)
create or replace function public.lead_find(p_ws uuid, p_phone text, p_email text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select l.lead_id from public.leads l where l.workspace_id = p_ws and length(public.phone_norm(p_phone)) >= 10 and right(l.phone, 10) = right(public.phone_norm(p_phone), 10) order by l.created_at limit 1),
    (select l.lead_id from public.leads l where l.workspace_id = p_ws and lower(trim(coalesce(p_email, ''))) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and lower(l.email) = lower(trim(p_email)) order by l.created_at limit 1));
$$;
revoke execute on function public.lead_find(uuid, text, text) from public, anon, authenticated;
grant execute on function public.lead_find(uuid, text, text) to service_role;

create or replace function public.product_view(p_ws uuid, p_lead text, p_sku text, p_name text, p_url text, p_price numeric) returns boolean
language plpgsql security definer set search_path = public as $$
declare k text := coalesce(nullif(left(trim(coalesce(p_sku, '')), 80), ''), lower(left(trim(coalesce(p_name, '')), 200))); r jsonb;
begin
  if p_lead is null or coalesce(k, '') = '' then return false; end if;
  insert into public.product_views (workspace_id, lead_id, pkey, sku, name, url, price) values (p_ws, p_lead, k, left(coalesce(p_sku, ''), 80), left(coalesce(p_name, ''), 200), left(coalesce(p_url, ''), 1000), p_price)
  on conflict (workspace_id, lead_id, pkey) do update set views = public.product_views.views + 1, last_at = now(), name = coalesce(nullif(excluded.name, ''), public.product_views.name), url = coalesce(nullif(excluded.url, ''), public.product_views.url), price = coalesce(excluded.price, public.product_views.price);
  r := public.remarket_rule(p_ws, 'browse');
  if r is not null then      -- one per person per day; a newer view replaces the product while the message waits
    insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload)
    values (p_ws, p_lead, 'browse', p_lead || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYYMMDD'), now() + make_interval(hours => public.rm_int(r, 'hours', 3, 1, 72)),
            jsonb_build_object('sku', p_sku, 'product', p_name, 'url', p_url, 'price', p_price, 'viewed_at', now()))
    on conflict (workspace_id, kind, ref) do update set payload = excluded.payload where public.remarket_jobs.done_at is null;
  end if;
  return true;
end $$;
revoke execute on function public.product_view(uuid, text, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.product_view(uuid, text, text, text, text, numeric) to service_role;

-- ---------- 5. ratings / feedback ----------
create table if not exists public.feedback (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id      text,
  order_ref    text not null default '',
  rating       smallint not null check (rating between 1 and 5),
  comment      text not null default '' check (length(comment) <= 1000),
  source       text not null default 'whatsapp' check (length(source) <= 30),
  handled      boolean not null default false,
  created_at   timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, lead_id) on delete set null (lead_id)
);
create index if not exists feedback_ws_time_idx on public.feedback (workspace_id, created_at desc);
alter table public.feedback enable row level security;
drop policy if exists fb_select on public.feedback;
create policy fb_select on public.feedback for select to authenticated using (workspace_id in (select public.my_ws()));
drop policy if exists fb_upd on public.feedback;
create policy fb_upd on public.feedback for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
revoke all on public.feedback from anon, authenticated;
grant select, update (handled, comment) on public.feedback to authenticated;
grant all on public.feedback to service_role;

-- ---------- 6. scheduled campaigns ----------
create table if not exists public.campaign_schedules (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null default '' check (length(name) <= 120),
  active       boolean not null default true,
  channel      text not null default 'whatsapp' check (channel in ('whatsapp', 'email')),
  audience     jsonb not null default '{}'::jsonb,
  tpl          text not null default '',
  lang         text not null default 'en',
  vars         jsonb not null default '[]'::jsonb,           -- [{src: first|name|business|city|coupon|custom, text}]
  subject      text not null default '' check (length(subject) <= 200),
  body         text not null default '' check (length(body) <= 5000),
  coupon       text not null default '' check (length(coupon) <= 40),
  repeat       text not null default 'weekly' check (repeat in ('once', 'daily', 'weekly', 'monthly')),
  days         integer[] not null default '{1}',              -- weekly: 0 = Sunday … 6 = Saturday
  day_of_month integer not null default 1 check (day_of_month between 1 and 31),
  at_time      time not null default '10:00',                 -- India time
  run_once_at  timestamptz,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  last_count   integer not null default 0,
  runs         integer not null default 0,
  created_by   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists campaign_schedules_due on public.campaign_schedules (next_run_at) where active;
alter table public.campaign_schedules enable row level security;
drop policy if exists sc_select on public.campaign_schedules;
create policy sc_select on public.campaign_schedules for select to authenticated using (workspace_id in (select public.my_ws()));
drop policy if exists sc_ins on public.campaign_schedules;
create policy sc_ins on public.campaign_schedules for insert to authenticated with check (public.can_write(workspace_id));
drop policy if exists sc_upd on public.campaign_schedules;
create policy sc_upd on public.campaign_schedules for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
drop policy if exists sc_del on public.campaign_schedules;
create policy sc_del on public.campaign_schedules for delete to authenticated using (public.can_write(workspace_id));
grant select, insert, update, delete on public.campaign_schedules to authenticated;
grant all on public.campaign_schedules to service_role;

-- the next time a schedule runs, after p_after (India time)
create or replace function public.schedule_next(p_repeat text, p_days integer[], p_dom integer, p_time time, p_once timestamptz, p_after timestamptz)
returns timestamptz language plpgsql immutable as $$
declare base timestamp := p_after at time zone 'Asia/Kolkata'; cand timestamp; i int; last_day int;
begin
  if p_repeat = 'once' then return case when p_once > p_after then p_once end; end if;
  for i in 0..62 loop
    cand := (base::date + i) + coalesce(p_time, time '10:00');
    if cand <= base then continue; end if;
    last_day := extract(day from (date_trunc('month', cand) + interval '1 month - 1 day'))::int;
    if p_repeat = 'daily'
       or (p_repeat = 'weekly' and extract(dow from cand)::int = any (coalesce(nullif(p_days, '{}'), '{1}')))
       or (p_repeat = 'monthly' and extract(day from cand)::int = least(coalesce(p_dom, 1), last_day)) then
      return cand at time zone 'Asia/Kolkata';
    end if;
  end loop;
  return null;
end $$;
create or replace function public.schedule_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if new.repeat = 'once' and new.last_run_at is not null and (tg_op = 'INSERT' or old.last_run_at is distinct from new.last_run_at) then new.active := false; end if;
  if not new.active then new.next_run_at := null;
  elsif tg_op = 'INSERT' or old.next_run_at is null or not old.active or new.repeat is distinct from old.repeat or new.days is distinct from old.days or new.day_of_month is distinct from old.day_of_month
        or new.at_time is distinct from old.at_time or new.run_once_at is distinct from old.run_once_at or new.last_run_at is distinct from old.last_run_at then
    new.next_run_at := public.schedule_next(new.repeat, new.days, new.day_of_month, new.at_time, new.run_once_at, greatest(now(), coalesce(new.last_run_at, now())));
  else new.next_run_at := old.next_run_at;      -- renaming / changing the message keeps a run that is due right now
  end if;
  if new.active and new.next_run_at is null and new.repeat = 'once' then new.active := false; end if;
  return new;
end $$;
drop trigger if exists campaign_schedules_next on public.campaign_schedules;
create trigger campaign_schedules_next before insert or update on public.campaign_schedules for each row execute function public.schedule_trg();

-- customer group of a lead (same rules as the Customers screen)
create or replace function public.cust_seg(n integer, last_at timestamptz) returns text language sql stable as $$
  select case when coalesce(n, 0) = 0 or last_at is null then null
    when n >= 3 and last_at >= now() - interval '30 days' then 'champions'
    when n >= 2 and last_at >= now() - interval '90 days' then 'loyal'
    when n = 1 and last_at >= now() - interval '30 days' then 'new'
    when n = 1 and last_at >= now() - interval '90 days' then 'onetime'
    when last_at >= now() - interval '180 days' then 'risk' else 'lost' end;
$$;
-- who gets a scheduled campaign now (worked out again on every run)
create or replace function public.campaign_audience(p_ws uuid, a jsonb) returns setof text
language sql stable security definer set search_path = public as $$
  select l.lead_id from public.leads l
  where l.workspace_id = p_ws
    and (case when coalesce(a ->> 'src', 'filters') = 'ids' then l.lead_id in (select jsonb_array_elements_text(coalesce(a -> 'ids', '[]'::jsonb)))
         else (jsonb_array_length(coalesce(a -> 'stages', '[]'::jsonb)) = 0 or l.stage in (select jsonb_array_elements_text(a -> 'stages')))
          and (coalesce(a ->> 'tag', '') = '' or l.tag = a ->> 'tag')
          and (coalesce(a ->> 'source', '') = '' or l.source = a ->> 'source')
          and (coalesce(a ->> 'city', '') = '' or lower(l.city) = lower(a ->> 'city'))
          and (coalesce(a ->> 'assigned', '') = '' or l.assigned_to = a ->> 'assigned')
          and (coalesce(a ->> 'cseg', '') = '' or (a ->> 'cseg' = 'any' and l.orders_count > 0) or (a ->> 'cseg' = 'none' and l.orders_count = 0) or public.cust_seg(l.orders_count, l.last_order_at) = a ->> 'cseg') end)
    and not (l.lead_id in (select jsonb_array_elements_text(coalesce(a -> 'excluded', '[]'::jsonb))))
  order by l.created_at desc limit 20000;
$$;
revoke execute on function public.campaign_audience(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.campaign_audience(uuid, jsonb) to service_role;

-- ---------- 7. auto messages: new kinds on orders ----------
create or replace function public.order_remarket() returns trigger
language plpgsql security definer set search_path = public as $$
declare ref text := left(coalesce(nullif(new.order_ref, ''), new.order_id), 80); r jsonb; d int; day0 date := (now() at time zone 'Asia/Kolkata')::date;
        pay jsonb := jsonb_build_object('order_ref', coalesce(nullif(new.order_ref, ''), new.order_id), 'order_id', new.order_id); cod boolean := new.status = 'COD' or new.payment ~* '(^|\W)(cod|cash)';
begin
  if new.lead_id is null or coalesce(new.source, '') ilike 'import%' or new.status in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') then return null; end if;
  if tg_op = 'INSERT' then
    if coalesce(new.order_date, day0) < day0 - 2 then return null; end if;                         -- history from a sync / import: never
    if coalesce(new.source, '') ilike 'whatsapp%' then null;                                     -- made inside a WhatsApp chat flow: the flow already replied
    elsif cod and public.remarket_rule(new.workspace_id, 'cod') is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'cod', ref, now() + interval '1 minute', pay) on conflict do nothing;
    elsif public.remarket_rule(new.workspace_id, 'thanks') is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'thanks', ref, now() + interval '1 minute', pay) on conflict do nothing;
    end if;
    if cod and coalesce(new.source, '') not ilike 'whatsapp%' then                                -- COD → pay online (with a small discount)
      r := public.remarket_rule(new.workspace_id, 'cod_prepaid');
      if r is not null then insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'cod_prepaid', ref, now() + make_interval(mins => public.rm_int(r, 'mins', 30, 5, 1440)), pay) on conflict do nothing; end if;
    end if;
  else
    if new.status is not distinct from old.status or coalesce(new.order_date, day0) < day0 - 45 then return null; end if;
  end if;
  if new.status = 'Shipped' and tg_op = 'UPDATE' and public.remarket_rule(new.workspace_id, 'shipped') is not null then
    insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'shipped', ref, now() + interval '1 minute', pay) on conflict do nothing;
  end if;
  if new.status = 'Delivered' then
    if tg_op = 'UPDATE' and public.remarket_rule(new.workspace_id, 'delivered') is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'delivered', ref, now() + interval '1 minute', pay) on conflict do nothing;
    end if;
    r := public.remarket_rule(new.workspace_id, 'review');
    if r is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'review', ref, now() + make_interval(days => public.rm_int(r, 'days', 3, 0, 60)), pay) on conflict do nothing;
    end if;
    r := public.remarket_rule(new.workspace_id, 'rating');
    if r is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'rating', ref, now() + make_interval(days => public.rm_int(r, 'days', 2, 0, 60)), pay) on conflict do nothing;
    end if;
    r := public.remarket_rule(new.workspace_id, 'ref_ask');
    if r is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'ref_ask', new.lead_id, now() + make_interval(days => public.rm_int(r, 'days', 7, 0, 90)), pay) on conflict do nothing;   -- once per customer
    end if;
    r := public.remarket_rule(new.workspace_id, 'reorder');
    if r is not null then
      select p.reorder_days into d from public.products p where p.workspace_id = new.workspace_id and p.sku = new.sku and new.sku <> '';
      d := coalesce(d, nullif(public.rm_int(r, 'days', 0, 0, 365), 0));
      if d is not null then
        insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'reorder', ref, now() + make_interval(days => d), pay || jsonb_build_object('sku', new.sku, 'product', coalesce(nullif(new.product_name, ''), new.items))) on conflict do nothing;
      end if;
    end if;
  end if;
  return null;
exception when others then return null;      -- never block an order
end $$;

-- remarket summary: + messages waiting for approval
create or replace function public.remarket_summary(p_ws uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_object_agg(kind, jsonb_build_object('sent', sent, 'skipped', skipped, 'failed', failed, 'waiting', waiting, 'held', held)), '{}'::jsonb) from (
    select kind, count(*) filter (where result like 'sent%') sent, count(*) filter (where result like 'skipped%') skipped,
           count(*) filter (where result like 'failed%') failed, count(*) filter (where done_at is null and result not like 'hold%') waiting, count(*) filter (where done_at is null and result like 'hold%') held
    from public.remarket_jobs where workspace_id = p_ws and (created_at > now() - interval '30 days' or (done_at is null and result like 'hold%')) group by kind) x;
$$;

-- win-back scan (15 min) also refreshes the RTO score of open COD orders (WhatsApp status / no reply change over time)
create or replace function public.remarket_scan() returns integer
language plpgsql security definer set search_path = public as $$
declare s record; r jsonb; d int; n int := 0; k int;
begin
  for s in select workspace_id from public.settings where key = 'remarketJson' and value like '%"winback"%' loop
    r := public.remarket_rule(s.workspace_id, 'winback'); if r is null then continue; end if;
    d := public.rm_int(r, 'days', 60, 14, 365);
    insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload)
    select l.workspace_id, l.lead_id, 'winback', l.lead_id || ':' || to_char(l.last_order_at, 'YYYYMMDD'), now(), jsonb_build_object('last', l.last_order_at)
    from public.leads l
    where l.workspace_id = s.workspace_id and l.orders_count > 0 and l.last_order_at < now() - make_interval(days => d) and l.last_order_at >= now() - make_interval(days => d + 3)
    on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end loop;
  -- messages nobody approved in 7 days are dropped (they would be out of date)
  update public.remarket_jobs set done_at = now(), result = 'skipped · nobody approved it in 7 days'
  where done_at is null and result like 'hold%' and coalesce((payload ->> 'held_at')::timestamptz, created_at) < now() - interval '7 days';
  update public.orders o set rto_risk = (x.r ->> 'score')::int, rto_reasons = x.r ->> 'reasons'
  from (select oo.workspace_id, oo.order_id, public.order_rto(oo.workspace_id, oo.lead_id, oo.order_id, coalesce(nullif(oo.order_ref, ''), oo.order_id), oo.amount, oo.pincode, oo.status, oo.cod_confirmed_at) r
        from public.orders oo where oo.rto_risk is not null and oo.status in ('COD', 'New', 'Processing') and oo.created_at > now() - interval '7 days' limit 2000) x
  where o.workspace_id = x.workspace_id and o.order_id = x.order_id and o.rto_risk is distinct from (x.r ->> 'score')::int;
  return n;
end $$;
revoke execute on function public.remarket_scan(), public.order_rto_trg(), public.order_rto_task(), public.lead_refcode(), public.order_referral(), public.schedule_trg() from public, anon, authenticated;

-- the 2-minute timer: + scheduled campaigns that are due
create or replace function public.nodevers_auto_tick() returns void
language plpgsql security definer set search_path = public as $$
declare u text; k text;
begin
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is null then return; end if;
  perform net.http_post(url := u || '/automation', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
  if exists (select 1 from public.bot_waits where done_at is null and run_at <= now() limit 1) then
    perform net.http_post(url := u || '/wa-webhook', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"bot_tick"}'::jsonb);
  end if;
  if exists (select 1 from public.remarket_jobs where done_at is null and run_at <= now() limit 1) or exists (select 1 from public.campaign_schedules where active and next_run_at <= now() limit 1) then
    perform net.http_post(url := u || '/remarket', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"run"}'::jsonb);
  end if;
end $$;
revoke execute on function public.nodevers_auto_tick() from public, anon, authenticated;

-- ---------- 8. results: how much money remarketing brought ----------
-- each store order in the period is counted once: recovered checkout → referral → auto message (7 days before) → campaign (7 days before)
create or replace function public.growth_report(p_ws uuid, p_days integer default 30) returns jsonb
language sql stable security invoker set search_path = public as $$
with prm as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 400))) as since),
ord as (
  select coalesce(nullif(o.order_ref, ''), o.order_id) ref, o.lead_id, sum(coalesce(o.amount, 0)) amt, min(o.created_at) t
  from public.orders o, prm where o.workspace_id = p_ws and o.lead_id is not null and o.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') and o.created_at >= prm.since
  group by 1, 2),
att as (
  select ord.*, case
    when exists (select 1 from public.checkouts c where c.workspace_id = p_ws and c.status = 'recovered' and c.lead_id = ord.lead_id and (c.order_ref = ord.ref or c.updated_at between ord.t - interval '1 day' and ord.t + interval '1 day')) then 'recovered'
    when exists (select 1 from public.referrals r where r.workspace_id = p_ws and r.friend_id = ord.lead_id and r.order_ref = ord.ref) then 'referral'
    when j.kind is not null then 'auto'
    when b.bid is not null then 'campaign' end bucket, j.kind, b.bid
  from ord
  left join lateral (select rj.kind from public.remarket_jobs rj where rj.workspace_id = p_ws and rj.lead_id = ord.lead_id and rj.result like 'sent%'
                     and rj.kind in ('abandon1', 'abandon2', 'browse', 'reorder', 'winback', 'backstock', 'ref_ask', 'cod_prepaid') and rj.done_at between ord.t - interval '7 days' and ord.t order by rj.done_at desc limit 1) j on true
  left join lateral (select m.broadcast_id bid from public.messages m where m.workspace_id = p_ws and m.lead_id = ord.lead_id and m.broadcast_id is not null and m.direction = 'out'
                     and m.time between ord.t - interval '7 days' and ord.t order by m.time desc limit 1) b on true),
codo as (select coalesce(nullif(o.order_ref, ''), o.order_id) ref, max(o.rto_risk) risk, bool_or(o.status in ('RTO', 'Returned')) rto, bool_or(o.cod_confirmed_at is not null) conf, sum(coalesce(o.amount, 0)) amt
         from public.orders o, prm where o.workspace_id = p_ws and o.rto_risk is not null and o.created_at >= prm.since group by 1),
pre as (select j.ref, bool_or(o.status = 'Paid' or (o.payment <> '' and o.payment !~* '(^|\W)(cod|cash)')) paid, sum(coalesce(o.amount, 0)) amt
        from public.remarket_jobs j, prm, public.orders o where j.workspace_id = p_ws and j.kind = 'cod_prepaid' and j.result like 'sent%' and j.done_at >= prm.since
          and o.workspace_id = p_ws and o.lead_id = j.lead_id and coalesce(nullif(o.order_ref, ''), o.order_id) = j.ref group by j.ref)
select jsonb_build_object(
  'days', p_days,
  'total', coalesce((select sum(amt) from att where bucket is not null), 0),
  'orders', (select count(*) from att where bucket is not null),
  'allRevenue', coalesce((select sum(amt) from att), 0), 'allOrders', (select count(*) from att),
  'buckets', coalesce((select jsonb_object_agg(bucket, jsonb_build_object('orders', n, 'revenue', r)) from (select bucket, count(*) n, sum(amt) r from att where bucket is not null group by bucket) x), '{}'::jsonb),
  'kinds', coalesce((select jsonb_object_agg(kind, jsonb_build_object('orders', n, 'revenue', r)) from (select kind, count(*) n, sum(amt) r from att where bucket = 'auto' group by kind) x), '{}'::jsonb),
  'campaigns', coalesce((select jsonb_agg(x order by x.revenue desc) from (select a.bid id, max(bb.name) as name, count(*) orders, sum(a.amt) revenue from att a left join public.broadcasts bb on bb.workspace_id = p_ws and bb.broadcast_id = a.bid where a.bucket = 'campaign' group by a.bid order by sum(a.amt) desc limit 8) x), '[]'::jsonb),
  'weeks', coalesce((select jsonb_agg(x order by x.wk) from (select to_char(date_trunc('week', t at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') wk, coalesce(sum(amt) filter (where bucket = 'recovered'), 0) rec, coalesce(sum(amt) filter (where bucket = 'auto'), 0) auto,
                coalesce(sum(amt) filter (where bucket = 'campaign'), 0) camp, coalesce(sum(amt) filter (where bucket = 'referral'), 0) ref from att where bucket is not null group by 1) x), '[]'::jsonb),
  'kindSent', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) n from public.remarket_jobs, prm where workspace_id = p_ws and result like 'sent%' and done_at >= prm.since group by kind) x), '{}'::jsonb),
  'bcSent', (select count(*) from public.messages m, prm where m.workspace_id = p_ws and m.broadcast_id is not null and m.direction = 'out' and m.time >= prm.since),
  'checkouts', (select jsonb_build_object('total', count(*), 'open', count(*) filter (where status = 'open'), 'recovered', count(*) filter (where status = 'recovered')) from public.checkouts c, prm where c.workspace_id = p_ws and c.created_at >= prm.since),
  'referrals', (select jsonb_build_object('joined', count(*), 'ordered', count(*) filter (where status in ('ordered', 'rewarded')), 'rewarded', count(*) filter (where status = 'rewarded')) from public.referrals r, prm where r.workspace_id = p_ws and r.created_at >= prm.since),
  'cod', jsonb_build_object('orders', (select count(*) from codo), 'high', (select count(*) from codo where risk >= 60), 'medium', (select count(*) from codo where risk >= 30 and risk < 60), 'low', (select count(*) from codo where risk < 30),
    'confirmed', (select count(*) from codo where conf), 'rtoHigh', (select count(*) from codo where risk >= 60 and rto), 'rtoLow', (select count(*) from codo where risk < 60 and rto),
    'prepaidSent', (select count(*) from pre), 'prepaid', (select count(*) from pre where paid), 'prepaidAmt', coalesce((select sum(amt) from pre where paid), 0)),
  'feedback', (select jsonb_build_object('n', count(*), 'avg', round(avg(rating)::numeric, 2), 'low', count(*) filter (where rating <= 3)) from public.feedback f, prm where f.workspace_id = p_ws and f.created_at >= prm.since)
);
$$;
revoke execute on function public.growth_report(uuid, integer) from public, anon;
grant execute on function public.growth_report(uuid, integer) to authenticated;

-- ---------- 9. first fill ----------
update public.leads set ref_code = public.make_ref_code(workspace_id, name) where ref_code is null and orders_count > 0;
update public.orders o set rto_risk = (x.r ->> 'score')::int, rto_reasons = x.r ->> 'reasons'
from (select oo.workspace_id, oo.order_id, public.order_rto(oo.workspace_id, oo.lead_id, oo.order_id, coalesce(nullif(oo.order_ref, ''), oo.order_id), oo.amount, oo.pincode, oo.status, oo.cod_confirmed_at) r
      from public.orders oo where (oo.status = 'COD' or oo.payment ~* '(^|\W)(cod|cash)') and oo.status in ('COD', 'New', 'Processing', 'Confirmed') and oo.created_at > now() - interval '30 days' limit 20000) x
where o.workspace_id = x.workspace_id and o.order_id = x.order_id;
analyze public.orders; analyze public.leads;
