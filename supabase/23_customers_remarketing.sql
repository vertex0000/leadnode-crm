-- Nodevers 23 — Customers & remarketing.
-- 1. Orders keep the buyer's phone / email / order number / coupon. Every order with a phone or email is linked to ONE customer
--    profile (a lead, matched by the last 10 digits of the phone or by the email) — made automatically if it does not exist yet.
-- 2. Customer numbers on each lead: orders, total spent, first / last order, last product (kept up to date by the database).
-- 3. WhatsApp status per number: on (delivered / read / replied) · off (Meta error 131026 "not on WhatsApp") · invalid (bad format) · unknown.
-- 4. Marketing permission: mkt_ok (yes / no / not asked) — set by the opt-in button, the checkout consent line, STOP / START or by hand.
-- 5. Abandoned checkouts (website tracking code, Shopify) + recovery when the same person orders.
-- 6. Auto messages queue (thank you, COD confirm, checkout reminders, shipped, delivered, review, reorder, win-back, back in stock),
--    sent every 2 minutes by the "remarket" function. Settings key "remarketJson" decides what is on.
-- 7. Frequency cap: marketing messages per person in a rolling week (broadcasts + marketing auto messages).
-- Nothing is deleted. Old orders never send messages. Safe to run more than once. Run after 01–22.

-- ---------- 1. new columns ----------
alter table public.orders add column if not exists customer_phone text not null default '' check (length(customer_phone) <= 20);
alter table public.orders add column if not exists customer_email text not null default '' check (length(customer_email) <= 160);
alter table public.orders add column if not exists order_ref text not null default '' check (length(order_ref) <= 80);       -- the store's order number (all lines of one order share it)
alter table public.orders add column if not exists coupon text not null default '' check (length(coupon) <= 60);
create index if not exists orders_ws_ref_idx on public.orders (workspace_id, order_ref) where order_ref <> '';

alter table public.leads add column if not exists wa_status text not null default '' check (wa_status in ('', 'on', 'off', 'invalid'));
alter table public.leads add column if not exists wa_checked_at timestamptz;
alter table public.leads add column if not exists mkt_ok boolean;                                                          -- null = not asked yet
alter table public.leads add column if not exists mkt_src text not null default '' check (length(mkt_src) <= 30);
alter table public.leads add column if not exists mkt_at timestamptz;
alter table public.leads add column if not exists mkt_win_at timestamptz;                                                  -- frequency cap: start of the current 7-day window
alter table public.leads add column if not exists mkt_win_n integer not null default 0;                                    -- …and marketing messages in it
alter table public.leads add column if not exists orders_count integer not null default 0;
alter table public.leads add column if not exists total_spent numeric not null default 0;
alter table public.leads add column if not exists first_order_at timestamptz;
alter table public.leads add column if not exists last_order_at timestamptz;
alter table public.leads add column if not exists last_product text not null default '';
create index if not exists leads_ws_customers_idx on public.leads (workspace_id, last_order_at desc) where orders_count > 0;
create index if not exists leads_ws_phone10_idx on public.leads (workspace_id, right(phone, 10));
create index if not exists leads_ws_email_lower_idx on public.leads (workspace_id, lower(email)) where email <> '';

alter table public.products add column if not exists reorder_days integer check (reorder_days is null or reorder_days between 1 and 365);

-- ---------- 2. phone helpers ----------
create or replace function public.phone_norm(p text) returns text language sql immutable as $$
  select case when length(d) = 10 then '91' || d when length(d) = 11 and d like '0%' then '91' || substr(d, 2) else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') d) x;
$$;
-- a number that can never be on WhatsApp: too short / long, all the same digit, or an Indian landline
create or replace function public.phone_bad(p text) returns boolean language sql immutable as $$
  select d <> '' and (length(d) < 10 or length(d) > 15 or d ~ '^(\d)\1+$' or d ~ '^91[0-5]\d{9}$')
  from (select public.phone_norm(p) d) x;
$$;

-- ---------- 3. the quiet switch: customers made from orders / checkouts get no welcome message, no automation, no auto task ----------
create or replace function public.lead_welcome() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('nodevers.auto', true), '') = '1' then return null; end if;
  if (select count(*) from newrows) > 3 then return null; end if;
  insert into public.alert_queue (workspace_id, kind, ref, payload)
  select n.workspace_id, 'welcome', n.lead_id, jsonb_build_object('lead_id', n.lead_id, 'source', n.source)
  from newrows n join public.settings s on s.workspace_id = n.workspace_id and s.key = 'welcomeJson' and s.value like '%"on":true%'
  where coalesce(n.source, '') not ilike 'import%' and (coalesce(n.phone, '') <> '' or coalesce(n.email, '') <> '')
  on conflict do nothing;
  return null;
exception when others then return null;     -- a welcome must never block adding a lead
end $$;

create or replace function public.auto_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare rules jsonb; r jsonb; raw text;
begin
  if tg_op = 'INSERT' and coalesce(current_setting('nodevers.auto', true), '') = '1' then return new; end if;
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

-- ---------- 4. one customer profile per phone / email ----------
-- finds the lead with this phone (last 10 digits) or email; makes one quietly when there is none. Returns the lead id or null.
create or replace function public.customer_lead(p_ws uuid, p_phone text, p_email text, p_name text, p_city text, p_state text, p_source text, p_stage text, p_day date)
returns text language plpgsql security definer set search_path = public as $$
declare p text := public.phone_norm(p_phone); em text := lower(trim(coalesce(p_email, ''))); lid text; prev text; nm text; stg text := coalesce(nullif(p_stage, ''), 'Won');
begin
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then em := ''; end if;
  if length(p) < 10 then p := ''; end if;
  if p = '' and em = '' then return null; end if;
  if p <> '' then select l.lead_id into lid from public.leads l where l.workspace_id = p_ws and right(l.phone, 10) = right(p, 10) order by l.created_at limit 1; end if;
  if lid is null and em <> '' then select l.lead_id into lid from public.leads l where l.workspace_id = p_ws and lower(l.email) = em order by l.created_at limit 1; end if;
  if lid is not null then      -- fill a missing phone / email on the profile we found
    update public.leads set phone = case when phone = '' and p <> '' then p else phone end, email = case when email = '' and em <> '' then em else email end
      where workspace_id = p_ws and lead_id = lid and ((phone = '' and p <> '') or (email = '' and em <> ''));
    return lid;
  end if;
  if stg = 'first' then
    stg := 'New Lead';
    begin select coalesce(nullif(v ->> 0, ''), 'New Lead') into stg from (select value::jsonb v from public.settings where workspace_id = p_ws and key = 'stagesJson') x where jsonb_typeof(v) = 'array'; exception when others then stg := 'New Lead'; end;
    stg := coalesce(stg, 'New Lead');
  end if;
  nm := coalesce(nullif(trim(p_name), ''), nullif(split_part(em, '@', 1), ''), '+' || p);
  prev := current_setting('nodevers.auto', true);
  begin
    perform set_config('nodevers.auto', '1', true);
    insert into public.leads (workspace_id, name, phone, email, city, state, source, stage, created_on)
    values (p_ws, left(nm, 120), p, em, left(coalesce(p_city, ''), 60), left(coalesce(p_state, ''), 60), left(coalesce(nullif(p_source, ''), 'Website'), 60), stg, coalesce(p_day, current_date))
    returning lead_id into lid;
    perform set_config('nodevers.auto', coalesce(prev, ''), true);
  exception when others then
    perform set_config('nodevers.auto', coalesce(prev, ''), true); lid := null;          -- e.g. plan limit reached: the order is still saved
  end;
  return lid;
end $$;
revoke execute on function public.customer_lead(uuid, text, text, text, text, text, text, text, date) from public, anon, authenticated;
grant execute on function public.customer_lead(uuid, text, text, text, text, text, text, text, date) to service_role;

-- orders: clean phone / email / order number and link the customer before the row is saved
create or replace function public.order_customer() returns trigger
language plpgsql security definer set search_path = public as $$
declare src text;
begin
  if tg_op = 'UPDATE' then
    if pg_trigger_depth() > 1 then return new; end if;                                                -- e.g. the lead was deleted: leave it unlinked
    if new.lead_id is null and old.lead_id is not null then new.lead_id := old.lead_id; end if;        -- a store sync never unlinks a customer
    -- the buyer confirmed / cancelled a COD order on WhatsApp: the next store sync (still "COD" / "New" there) does not undo it
    if old.status in ('Confirmed', 'Cancelled') and new.status in ('COD', 'New', 'Processing') and new.source in ('Shopify', 'WooCommerce', 'Website API')
       and old.updated_at > now() - interval '14 days' then new.status := old.status; end if;
  end if;
  new.customer_phone := left(public.phone_norm(new.customer_phone), 20);
  new.customer_email := left(lower(trim(coalesce(new.customer_email, ''))), 160);
  if coalesce(new.order_ref, '') = '' then new.order_ref := left(coalesce(regexp_replace(nullif(new.ext_id, ''), '-\d{1,3}$', ''), ''), 80); end if;
  if new.lead_id is null and new.status <> 'Cart' and (length(new.customer_phone) >= 10 or new.customer_email <> '')
     and (tg_op = 'INSERT' or new.customer_phone is distinct from old.customer_phone or new.customer_email is distinct from old.customer_email) then   -- new buyer details only
    src := case when new.source ilike 'shopify%' then 'Shopify' when new.source ilike 'woo%' then 'WooCommerce' when new.source ilike '%tracking%' then 'Website' else coalesce(nullif(new.channel, ''), 'Website') end;
    new.lead_id := public.customer_lead(new.workspace_id, new.customer_phone, new.customer_email, new.customer_name, new.customer_city, new.customer_state, src, 'Won', new.order_date);
  end if;
  return new;
end $$;
drop trigger if exists orders_customer on public.orders;
create trigger orders_customer before insert or update on public.orders for each row execute function public.order_customer();

-- ---------- 5. customer numbers on the lead ----------
create or replace function public.customer_stats_refresh(p_ws uuid, p_ids text[]) returns void
language sql security definer set search_path = public as $$
  update public.leads l set orders_count = coalesce(s.n, 0), total_spent = coalesce(s.spent, 0), first_order_at = s.first_at, last_order_at = s.last_at, last_product = left(coalesce(s.prod, ''), 200)
  from (
    select x.id, a.n, a.spent, a.first_at, a.last_at, a.prod
    from unnest(p_ids) as x(id)
    left join lateral (
      select count(distinct coalesce(nullif(o.order_ref, ''), o.order_id)) n, sum(coalesce(o.amount, 0)) spent, min(o.t) first_at, max(o.t) last_at,
             (array_agg(coalesce(nullif(o.product_name, ''), o.items) order by o.t desc))[1] prod
      from (select oo.*, case when oo.order_date is null or oo.order_date = (oo.created_at at time zone 'Asia/Kolkata')::date then oo.created_at
                              else (oo.order_date + time '12:00') at time zone 'Asia/Kolkata' end t
            from public.orders oo where oo.workspace_id = p_ws and oo.lead_id = x.id and oo.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned')) o
    ) a on true
  ) s
  where l.workspace_id = p_ws and l.lead_id = s.id
    and (l.orders_count, l.total_spent, l.first_order_at, l.last_order_at, l.last_product) is distinct from (coalesce(s.n, 0), coalesce(s.spent, 0)::numeric, s.first_at, s.last_at, left(coalesce(s.prod, ''), 200));
$$;
revoke execute on function public.customer_stats_refresh(uuid, text[]) from public, anon, authenticated;

create or replace function public.order_stats_ins() returns trigger
language plpgsql security definer set search_path = public as $$
declare w uuid;
begin
  for w in select distinct workspace_id from newrows where lead_id is not null loop
    perform public.customer_stats_refresh(w, array(select distinct lead_id from newrows where workspace_id = w and lead_id is not null));
  end loop;
  -- the same person ordered → their open checkout is recovered
  update public.checkouts c set status = 'recovered', order_ref = left(coalesce(nullif(n.order_ref, ''), n.order_id), 80), updated_at = now()
  from newrows n
  where c.workspace_id = n.workspace_id and c.lead_id = n.lead_id and n.lead_id is not null and c.status = 'open'
    and n.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') and c.created_at > now() - interval '7 days'
    and coalesce(n.order_date, current_date) >= ((now() at time zone 'Asia/Kolkata')::date - 2);
  return null;
exception when others then return null;
end $$;
create or replace function public.order_stats_upd() returns trigger
language plpgsql security definer set search_path = public as $$
declare w uuid;
begin
  for w in select distinct workspace_id from (select workspace_id, lead_id from newrows union all select workspace_id, lead_id from oldrows) x where lead_id is not null loop
    perform public.customer_stats_refresh(w, array(select distinct lead_id from (select workspace_id, lead_id from newrows union select workspace_id, lead_id from oldrows) y where workspace_id = w and lead_id is not null));
  end loop;
  return null;
exception when others then return null;
end $$;
create or replace function public.order_stats_del() returns trigger
language plpgsql security definer set search_path = public as $$
declare w uuid;
begin
  for w in select distinct workspace_id from oldrows where lead_id is not null loop
    perform public.customer_stats_refresh(w, array(select distinct lead_id from oldrows where workspace_id = w and lead_id is not null));
  end loop;
  return null;
exception when others then return null;
end $$;
revoke execute on function public.order_stats_ins(), public.order_stats_upd(), public.order_stats_del() from public, anon, authenticated;

-- ---------- 6. abandoned checkouts ----------
create table if not exists public.checkouts (
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  checkout_id      text not null check (length(checkout_id) between 1 and 120),
  lead_id          text,
  name             text not null default '' check (length(name) <= 120),
  phone            text not null default '' check (length(phone) <= 20),
  email            text not null default '' check (length(email) <= 160),
  items            text not null default '' check (length(items) <= 2000),
  skus             text[] not null default '{}',
  amount           numeric check (amount is null or amount >= 0),
  url              text not null default '' check (length(url) <= 1000),
  channel          text not null default 'Website' check (length(channel) <= 40),
  source           text not null default '' check (length(source) <= 80),
  status           text not null default 'open' check (status in ('open', 'recovered', 'lost')),
  consent          boolean,
  reminders        integer not null default 0,
  last_reminded_at timestamptz,
  order_ref        text not null default '' check (length(order_ref) <= 80),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (workspace_id, checkout_id),
  foreign key (workspace_id, lead_id) references public.leads(workspace_id, lead_id) on delete set null (lead_id)
);
create index if not exists checkouts_ws_time_idx on public.checkouts (workspace_id, created_at desc);
create index if not exists checkouts_ws_lead_idx on public.checkouts (workspace_id, lead_id) where status = 'open';
drop trigger if exists checkouts_touch on public.checkouts;
create trigger checkouts_touch before update on public.checkouts for each row execute function public.touch_updated();

create or replace function public.checkout_customer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.phone := left(public.phone_norm(new.phone), 20);
  new.email := left(lower(trim(coalesce(new.email, ''))), 160);
  if new.lead_id is null and (length(new.phone) >= 10 or new.email <> '') then
    new.lead_id := public.customer_lead(new.workspace_id, new.phone, new.email, new.name, '', '', 'Website checkout', 'first', current_date);
  end if;
  if new.lead_id is not null and new.consent is true and (tg_op = 'INSERT' or old.consent is distinct from true) then     -- ticked "send me offers" at checkout
    update public.leads set mkt_ok = true, mkt_src = 'checkout', mkt_at = now() where workspace_id = new.workspace_id and lead_id = new.lead_id and mkt_ok is null;
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists checkouts_customer on public.checkouts;
create trigger checkouts_customer before insert or update of phone, email, consent on public.checkouts for each row execute function public.checkout_customer();

alter table public.checkouts enable row level security;
drop policy if exists ck_select on public.checkouts;
create policy ck_select on public.checkouts for select to authenticated using (
  workspace_id in (select public.my_full_ws())
  or (workspace_id in (select public.my_ws()) and (lead_id is null or exists (select 1 from public.leads l where l.workspace_id = checkouts.workspace_id and l.lead_id = checkouts.lead_id))));
drop policy if exists ck_upd on public.checkouts;
create policy ck_upd on public.checkouts for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
drop policy if exists ck_del on public.checkouts;
create policy ck_del on public.checkouts for delete to authenticated using (public.can_write(workspace_id));
grant select, update (status), delete on public.checkouts to authenticated;
grant all on public.checkouts to service_role;

-- ---------- 7. WhatsApp status + marketing permission + frequency cap ----------
create or replace function public.lead_wa_fmt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and public.phone_norm(new.phone) = public.phone_norm(old.phone) then return new; end if;
  if public.phone_bad(new.phone) then new.wa_status := 'invalid'; new.wa_checked_at := now();
  elsif tg_op = 'UPDATE' or new.wa_status = 'invalid' then new.wa_status := ''; new.wa_checked_at := null; end if;     -- a new number is unknown again
  return new;
end $$;
drop trigger if exists leads_wa_fmt on public.leads;
create trigger leads_wa_fmt before insert or update of phone on public.leads for each row execute function public.lead_wa_fmt();

create or replace function public.lead_mkt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.wa_opt_out and not coalesce(old.wa_opt_out, false) then new.mkt_ok := false; new.mkt_src := 'stop'; new.mkt_at := now();          -- said STOP
  elsif not new.wa_opt_out and coalesce(old.wa_opt_out, false) then                                                                   -- back in (START / by hand): not asked again
    if new.mkt_ok is not distinct from old.mkt_ok then new.mkt_ok := null; new.mkt_src := ''; end if; new.mkt_at := now();
  elsif new.mkt_ok is distinct from old.mkt_ok and new.mkt_at is not distinct from old.mkt_at then new.mkt_at := now(); end if;
  return new;
end $$;
drop trigger if exists leads_mkt on public.leads;
create trigger leads_mkt before update of wa_opt_out, mkt_ok on public.leads for each row execute function public.lead_mkt();

create or replace function public.msg_wa_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lead_id is null then return null; end if;
  if tg_op = 'INSERT' then
    if new.direction = 'in' then
      update public.leads set wa_status = 'on', wa_checked_at = now() where workspace_id = new.workspace_id and lead_id = new.lead_id and wa_status <> 'on';
    elsif new.broadcast_id is not null or new.sent_by = 'Remarketing' then      -- a marketing message: count it for the weekly cap
      update public.leads set
        mkt_win_n = case when mkt_win_at is null or mkt_win_at < now() - interval '7 days' then 1 else mkt_win_n + 1 end,
        mkt_win_at = case when mkt_win_at is null or mkt_win_at < now() - interval '7 days' then now() else mkt_win_at end
      where workspace_id = new.workspace_id and lead_id = new.lead_id;
    end if;
  elsif new.status is distinct from old.status then
    if new.status in ('delivered', 'read') then
      update public.leads set wa_status = 'on', wa_checked_at = now() where workspace_id = new.workspace_id and lead_id = new.lead_id and wa_status <> 'on';
    elsif new.status = 'failed' and coalesce(new.error, '') like '131026%' then
      update public.leads set wa_status = 'off', wa_checked_at = now() where workspace_id = new.workspace_id and lead_id = new.lead_id and wa_status not in ('off', 'on');
    end if;
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists messages_wa_status on public.messages;
create trigger messages_wa_status after insert or update of status on public.messages for each row execute function public.msg_wa_status();

-- ---------- 8. auto messages queue ----------
create table if not exists public.remarket_jobs (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lead_id      text,
  kind         text not null check (kind in ('thanks', 'cod', 'abandon1', 'abandon2', 'shipped', 'delivered', 'review', 'reorder', 'winback', 'backstock')),
  ref          text not null default '',
  run_at       timestamptz not null default now(),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  done_at      timestamptz,
  channel      text not null default '',
  result       text not null default '',
  unique (workspace_id, kind, ref)
);
create index if not exists remarket_jobs_due on public.remarket_jobs (run_at) where done_at is null;
create index if not exists remarket_jobs_ws on public.remarket_jobs (workspace_id, created_at desc);
alter table public.remarket_jobs enable row level security;
drop policy if exists rj_select on public.remarket_jobs;
create policy rj_select on public.remarket_jobs for select to authenticated using (workspace_id in (select public.my_ws()));
revoke all on public.remarket_jobs from anon, authenticated;
grant select on public.remarket_jobs to authenticated;
grant all on public.remarket_jobs to service_role;

-- the rule for one kind when it is switched on (settings "remarketJson" → auto.<kind>), else null
create or replace function public.remarket_rule(p_ws uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v text; r jsonb;
begin
  select value into v from public.settings where workspace_id = p_ws and key = 'remarketJson';
  if v is null then return null; end if;
  begin r := v::jsonb -> 'auto' -> p_kind; exception when others then return null; end;
  if r is null or jsonb_typeof(r) <> 'object' or coalesce(r ->> 'on', 'false') <> 'true' then return null; end if;
  return r;
end $$;
revoke execute on function public.remarket_rule(uuid, text) from public, anon, authenticated;
create or replace function public.rm_int(r jsonb, k text, def int, lo int, hi int) returns int language sql immutable as $$
  select greatest(lo, least(hi, coalesce(case when (r ->> k) ~ '^\d{1,6}$' then (r ->> k)::int end, def)));
$$;

-- orders → thank you / COD confirm (new orders only), shipped, delivered, review, reorder
create or replace function public.order_remarket() returns trigger
language plpgsql security definer set search_path = public as $$
declare ref text := left(coalesce(nullif(new.order_ref, ''), new.order_id), 80); r jsonb; d int; day0 date := (now() at time zone 'Asia/Kolkata')::date;
        pay jsonb := jsonb_build_object('order_ref', coalesce(nullif(new.order_ref, ''), new.order_id), 'order_id', new.order_id);
begin
  if new.lead_id is null or coalesce(new.source, '') ilike 'import%' or new.status in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') then return null; end if;
  if tg_op = 'INSERT' then
    if coalesce(new.order_date, day0) < day0 - 2 then return null; end if;                         -- history from a sync / import: never
    if coalesce(new.source, '') ilike 'whatsapp%' then null;                                     -- made inside a WhatsApp chat flow: the flow already replied
    elsif (new.status = 'COD' or new.payment ~* '(^|\W)(cod|cash)') and public.remarket_rule(new.workspace_id, 'cod') is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'cod', ref, now() + interval '1 minute', pay) on conflict do nothing;
    elsif public.remarket_rule(new.workspace_id, 'thanks') is not null then
      insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'thanks', ref, now() + interval '1 minute', pay) on conflict do nothing;
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
drop trigger if exists orders_remarket on public.orders;
create trigger orders_remarket after insert or update of status on public.orders for each row execute function public.order_remarket();

-- the stats triggers (statement level, once per sync batch)
drop trigger if exists orders_stats_ins on public.orders;
drop trigger if exists orders_stats_upd on public.orders;
drop trigger if exists orders_stats_del on public.orders;
create trigger orders_stats_ins after insert on public.orders referencing new table as newrows for each statement execute function public.order_stats_ins();
create trigger orders_stats_upd after update on public.orders referencing old table as oldrows new table as newrows for each statement execute function public.order_stats_upd();
create trigger orders_stats_del after delete on public.orders referencing old table as oldrows for each statement execute function public.order_stats_del();

-- checkouts → reminder 1 (after N minutes) and reminder 2 (after N hours)
create or replace function public.checkout_remarket() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if new.lead_id is null or new.status <> 'open' then return null; end if;
  r := public.remarket_rule(new.workspace_id, 'abandon1');
  if r is not null then insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'abandon1', new.checkout_id, new.created_at + make_interval(mins => public.rm_int(r, 'mins', 30, 10, 1440)), jsonb_build_object('checkout_id', new.checkout_id)) on conflict do nothing; end if;
  r := public.remarket_rule(new.workspace_id, 'abandon2');
  if r is not null then insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload) values (new.workspace_id, new.lead_id, 'abandon2', new.checkout_id, new.created_at + make_interval(hours => public.rm_int(r, 'hours', 24, 2, 168)), jsonb_build_object('checkout_id', new.checkout_id)) on conflict do nothing; end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists checkouts_remarket on public.checkouts;
create trigger checkouts_remarket after insert or update of lead_id on public.checkouts for each row execute function public.checkout_remarket();

-- back in stock → people whose checkout had that product in the last 30 days
create or replace function public.product_backstock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(old.stock, 0) > 0 or coalesce(new.stock, 0) <= 0 or public.remarket_rule(new.workspace_id, 'backstock') is null then return null; end if;
  insert into public.remarket_jobs (workspace_id, lead_id, kind, ref, run_at, payload)
  select distinct on (c.lead_id) c.workspace_id, c.lead_id, 'backstock', c.lead_id || ':' || new.sku || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYYMMDD'), now() + interval '2 minutes',
         jsonb_build_object('sku', new.sku, 'product', new.name, 'url', coalesce(new.website_url, ''))
  from public.checkouts c where c.workspace_id = new.workspace_id and c.lead_id is not null and new.sku = any (c.skus) and c.created_at > now() - interval '30 days' and c.status <> 'recovered'
  on conflict do nothing;
  return null;
exception when others then return null;
end $$;
drop trigger if exists products_backstock on public.products;
create trigger products_backstock after update of stock on public.products for each row execute function public.product_backstock();

-- win-back: customers who just crossed "no order for N days" (people who crossed it long ago are not messaged all at once)
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
  return n;
end $$;
revoke execute on function public.remarket_scan(), public.order_remarket(), public.checkout_remarket(), public.product_backstock(), public.order_customer(), public.checkout_customer(),
  public.lead_wa_fmt(), public.lead_mkt(), public.msg_wa_status() from public, anon, authenticated;

-- ---------- 9. timers: every 2 minutes the due auto messages go out; every 15 minutes the win-back scan ----------
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
  if exists (select 1 from public.remarket_jobs where done_at is null and run_at <= now() limit 1) then
    perform net.http_post(url := u || '/remarket', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"run"}'::jsonb);
  end if;
end $$;
revoke execute on function public.nodevers_auto_tick() from public, anon, authenticated;

create or replace function public.nodevers_tick() returns void
language plpgsql security definer set search_path = public as $$
declare u text; k text;
begin
  begin perform public.remarket_scan(); exception when others then raise notice 'remarket scan: %', sqlerrm; end;
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is null then return; end if;
  perform net.http_post(url := u || '/store-sync', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
  perform net.http_post(url := u || '/alerts', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
end $$;
revoke execute on function public.nodevers_tick() from public, anon, authenticated;

-- ---------- 10. website tracking: a small per-workspace speed limit (stops a fake-checkout flood) ----------
create table if not exists public.track_hits (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  bucket       text not null,
  hour         timestamptz not null,
  n            integer not null default 0,
  primary key (workspace_id, bucket, hour)
);
alter table public.track_hits enable row level security;             -- server only
revoke all on public.track_hits from anon, authenticated;
grant all on public.track_hits to service_role;
create or replace function public.track_hit(p_ws uuid, p_bucket text, p_max int) returns boolean
language plpgsql security definer set search_path = public as $$
declare h timestamptz := date_trunc('hour', now()); v int;
begin
  insert into public.track_hits (workspace_id, bucket, hour, n) values (p_ws, left(p_bucket, 80), h, 1)
  on conflict (workspace_id, bucket, hour) do update set n = public.track_hits.n + 1 returning n into v;
  if random() < 0.01 then delete from public.track_hits where hour < now() - interval '2 days'; end if;
  return v <= p_max;
end $$;
revoke execute on function public.track_hit(uuid, text, int) from public, anon, authenticated;
grant execute on function public.track_hit(uuid, text, int) to service_role;

-- ---------- 11. numbers for the Customers screen (runs as the signed-in person: the usual rules decide what is counted) ----------
-- groups: champions (3+ orders, last ≤ 30 days) · loyal (2+ orders, ≤ 90 days) · new (1 order, ≤ 30 days) · one-time (1 order, 31–90 days)
--         at risk (last order 91–180 days ago) · lost (more than 180 days)
create or replace function public.customer_stats(p_ws uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  with c as (
    select orders_count n, total_spent s, extract(epoch from (now() - last_order_at)) / 86400 r, wa_status w, mkt_ok m, wa_opt_out o, email e
    from public.leads where workspace_id = p_ws and orders_count > 0
  )
  select jsonb_build_object(
    'total', count(*), 'repeat', count(*) filter (where n >= 2), 'orders', coalesce(sum(n), 0), 'spent', coalesce(sum(s), 0),
    'on', count(*) filter (where w = 'on'), 'off', count(*) filter (where w in ('off', 'invalid')), 'unknown', count(*) filter (where w = ''),
    'mkt', count(*) filter (where m), 'mktNo', count(*) filter (where m = false or o), 'email', count(*) filter (where e <> ''),
    'champions', count(*) filter (where n >= 3 and r <= 30), 'loyal', count(*) filter (where n >= 2 and r <= 90 and not (n >= 3 and r <= 30)),
    'new', count(*) filter (where n = 1 and r <= 30), 'onetime', count(*) filter (where n = 1 and r > 30 and r <= 90),
    'risk', count(*) filter (where r > 90 and r <= 180), 'lost', count(*) filter (where r > 180))
  from c;
$$;
revoke execute on function public.customer_stats(uuid) from public, anon;
grant execute on function public.customer_stats(uuid) to authenticated;

-- "bought this, not that" (product SKU or name) → lead ids
create or replace function public.customers_bought(p_ws uuid, p_yes text, p_no text default '') returns setof text
language sql stable security invoker set search_path = public as $$
  select distinct o.lead_id from public.orders o
  where o.workspace_id = p_ws and o.lead_id is not null and o.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned')
    and (coalesce(p_yes, '') = '' or o.sku = p_yes or o.product_name ilike '%' || p_yes || '%')
    and (coalesce(p_no, '') = '' or not exists (select 1 from public.orders x where x.workspace_id = p_ws and x.lead_id = o.lead_id
         and x.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') and (x.sku = p_no or x.product_name ilike '%' || p_no || '%')))
  limit 20000;
$$;
revoke execute on function public.customers_bought(uuid, text, text) from public, anon;
grant execute on function public.customers_bought(uuid, text, text) to authenticated;

-- auto messages of the last 30 days, per kind
create or replace function public.remarket_summary(p_ws uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_object_agg(kind, jsonb_build_object('sent', sent, 'skipped', skipped, 'failed', failed, 'waiting', waiting)), '{}'::jsonb) from (
    select kind, count(*) filter (where result like 'sent%') sent, count(*) filter (where result like 'skipped%') skipped,
           count(*) filter (where result like 'failed%') failed, count(*) filter (where done_at is null) waiting
    from public.remarket_jobs where workspace_id = p_ws and created_at > now() - interval '30 days' group by kind) x;
$$;
revoke execute on function public.remarket_summary(uuid) from public, anon;
grant execute on function public.remarket_summary(uuid) to authenticated;

-- ---------- 12. first fill ----------
update public.leads set wa_status = 'invalid', wa_checked_at = now() where wa_status = '' and public.phone_bad(phone);
update public.leads l set wa_status = 'on', wa_checked_at = now()
  where l.wa_status = '' and exists (select 1 from public.messages m where m.workspace_id = l.workspace_id and m.lead_id = l.lead_id and (m.direction = 'in' or m.status in ('delivered', 'read')));
update public.leads l set wa_status = 'off', wa_checked_at = now()
  where l.wa_status = '' and exists (select 1 from public.messages m where m.workspace_id = l.workspace_id and m.lead_id = l.lead_id and m.status = 'failed' and coalesce(m.error, '') like '131026%');
update public.leads set mkt_ok = false, mkt_src = 'stop', mkt_at = now() where wa_opt_out and mkt_ok is null;
update public.orders set order_ref = left(regexp_replace(ext_id, '-\d{1,3}$', ''), 80) where order_ref = '' and coalesce(ext_id, '') <> '';
do $$ declare w record; begin
  for w in select workspace_id, array_agg(distinct lead_id) ids from public.orders where lead_id is not null group by workspace_id loop
    perform public.customer_stats_refresh(w.workspace_id, w.ids);
  end loop;
end $$;

analyze public.leads; analyze public.orders;
