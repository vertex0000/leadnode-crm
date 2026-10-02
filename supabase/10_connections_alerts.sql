-- Nodevers 10 — Store connections (Shopify / WooCommerce / any website API) + store alerts (email / WhatsApp).
-- Safe to run more than once. Needs 09_commerce.sql first. Run in Supabase → SQL Editor.

-- ---------- 0. Background jobs (Supabase has both extensions; turn them on) ----------
do $$ begin
  begin create extension if not exists pg_net; exception when others then raise notice 'pg_net not available: %', sqlerrm; end;
  begin create extension if not exists pg_cron; exception when others then raise notice 'pg_cron not available: %', sqlerrm; end;
end $$;

-- private config the server functions use (never readable from the browser)
create table if not exists public.app_config (key text primary key, value text not null);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;
grant all on public.app_config to service_role;
insert into public.app_config (key, value) values ('cron_secret', md5(random()::text || clock_timestamp()::text) || md5(random()::text)) on conflict (key) do nothing;

-- ---------- 1. Store connections: the client's own website keys (server only) ----------
create table if not exists public.store_connections (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform     text not null check (platform in ('shopify', 'woocommerce', 'custom')),
  config       jsonb not null default '{}'::jsonb,       -- store link, sync interval, field matching (no secrets)
  secret       jsonb not null default '{}'::jsonb,       -- access token / keys — only the server functions read this
  last_sync_at timestamptz,
  last_status  text not null default '',
  last_error   text not null default '',
  last_count   integer,
  sync_cursor  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, platform)
);
alter table public.store_connections enable row level security;          -- no policies: browsers can not read keys
revoke all on public.store_connections from anon, authenticated;
grant all on public.store_connections to service_role;

-- ---------- 2. Alert queue: orders / stock changes waiting to be sent ----------
create table if not exists public.alert_queue (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind         text not null check (kind in ('new_order', 'cancel', 'low_stock', 'out_stock', 'daily', 'test')),
  ref          text not null default '',
  payload      jsonb not null default '{}'::jsonb,
  day          date not null default ((now() at time zone 'Asia/Kolkata')::date),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  result       text not null default '',
  unique (workspace_id, kind, ref, day)                 -- one alert per order / product per day
);
create index if not exists alert_queue_pending on public.alert_queue (workspace_id) where sent_at is null;
alter table public.alert_queue enable row level security;
revoke all on public.alert_queue from anon, authenticated;
grant all on public.alert_queue to service_role;

-- new / cancelled orders (imported history never alerts)
create or replace function public.alert_orders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.settings s where s.workspace_id = new.workspace_id and s.key = 'storeAlertsJson') then return new; end if;
  if coalesce(new.source, '') like 'Import%' then return new; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'Cart' and coalesce(new.order_date, current_date) >= ((now() at time zone 'Asia/Kolkata')::date - 2) then
      insert into public.alert_queue (workspace_id, kind, ref, payload)
      values (new.workspace_id, 'new_order', new.order_id, jsonb_build_object('order_id', new.order_id, 'ext_id', new.ext_id, 'channel', new.channel, 'items', new.items, 'amount', new.amount,
              'status', new.status, 'customer', new.customer_name, 'state', new.customer_state, 'lead_id', new.lead_id, 'payment', new.payment))
      on conflict do nothing;
    end if;
  elsif new.status is distinct from old.status and new.status in ('Cancelled', 'RTO', 'Returned', 'Refunded') then
    insert into public.alert_queue (workspace_id, kind, ref, payload)
    values (new.workspace_id, 'cancel', new.order_id || ':' || new.status, jsonb_build_object('order_id', new.order_id, 'ext_id', new.ext_id, 'channel', new.channel, 'items', new.items,
            'amount', new.amount, 'status', new.status, 'reason', new.return_reason, 'customer', new.customer_name))
    on conflict do nothing;
  end if;
  return new;
exception when others then return new;     -- an alert must never block an order
end $$;
drop trigger if exists orders_alert on public.orders;
create trigger orders_alert after insert or update of status on public.orders for each row execute function public.alert_orders();

-- stock reaching the reorder level / zero
create or replace function public.alert_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not new.active then return new; end if;
  if not exists (select 1 from public.settings s where s.workspace_id = new.workspace_id and s.key = 'storeAlertsJson') then return new; end if;
  if new.stock <= 0 and (tg_op = 'INSERT' or old.stock > 0) then
    insert into public.alert_queue (workspace_id, kind, ref, payload) values (new.workspace_id, 'out_stock', new.sku, jsonb_build_object('sku', new.sku, 'name', new.name, 'stock', new.stock)) on conflict do nothing;
  elsif new.stock > 0 and new.stock <= new.reorder_level and (tg_op = 'INSERT' or old.stock > old.reorder_level or old.stock <= 0) then
    insert into public.alert_queue (workspace_id, kind, ref, payload) values (new.workspace_id, 'low_stock', new.sku, jsonb_build_object('sku', new.sku, 'name', new.name, 'stock', new.stock, 'reorder', new.reorder_level)) on conflict do nothing;
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists products_alert on public.products;
create trigger products_alert after insert or update of stock, reorder_level, active on public.products for each row execute function public.alert_stock();

-- send right away: one call to the "alerts" function per batch of new alerts
create or replace function public.alert_kick() returns trigger
language plpgsql security definer set search_path = public as $$
declare u text; k text;
begin
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is not null then
    perform net.http_post(url := u || '/alerts', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"flush"}'::jsonb);
  end if;
  return null;
exception when others then return null;
end $$;
drop trigger if exists alert_queue_kick on public.alert_queue;
create trigger alert_queue_kick after insert on public.alert_queue for each statement execute function public.alert_kick();

-- ---------- 3. Every 15 minutes: sync stores + daily summaries ----------
create or replace function public.nodevers_tick() returns void
language plpgsql security definer set search_path = public as $$
declare u text; k text;
begin
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is null then return; end if;
  perform net.http_post(url := u || '/store-sync', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
  perform net.http_post(url := u || '/alerts', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
end $$;
revoke execute on function public.nodevers_tick(), public.alert_kick(), public.alert_orders(), public.alert_stock() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'nodevers-every-15-min';
    perform cron.schedule('nodevers-every-15-min', '*/15 * * * *', 'select public.nodevers_tick();');
  end if;
exception when others then raise notice 'cron not scheduled: %', sqlerrm;
end $$;
