-- Nodevers 16 — Stock goes down by itself when something sells, a log of where every unit went,
-- Amazon Seller Central (SP-API) and Meta Ads (ad spend) connections.
-- Safe to run more than once. Needs 09_commerce.sql, 10_connections_alerts.sql and 15_sections.sql first.

-- ---------- 1. New connection types: Amazon + Meta Ads (keys stay on the server, like Shopify) ----------
alter table public.store_connections drop constraint if exists store_connections_platform_check;
alter table public.store_connections add constraint store_connections_platform_check check (platform in ('shopify', 'woocommerce', 'custom', 'amazon', 'meta_ads'));

-- Meta Ads belongs to the Ads Manager section, the rest to the Store section
create or replace function public.store_conn_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text := case when new.platform = 'meta_ads' then 'ads' else 'store' end;
begin
  if public.ws_feature(new.workspace_id, k) then return new; end if;
  if pg_trigger_depth() > 1 or auth.uid() is null then return null; end if;
  raise exception '% is not part of your plan. Upgrade in Settings → Plan & billing.', public.feature_name(k);
end $$;
revoke execute on function public.store_conn_guard() from public, anon, authenticated;
drop trigger if exists store_connections_feature on public.store_connections;
create trigger store_connections_feature before insert on public.store_connections for each row execute function public.store_conn_guard();

-- ---------- 2. Extra columns ----------
alter table public.products add column if not exists fba_stock integer;                                     -- units at Amazon (FBA), synced from Amazon
alter table public.ad_spend add column if not exists leads integer check (leads is null or leads >= 0);     -- leads from the ads (Meta lead forms / messages)
alter table public.ad_spend add column if not exists source text not null default '' check (length(source) <= 40);   -- Meta API · Import · Manual
alter table public.orders add column if not exists stock_skip boolean not null default false;   -- stock comes from the store itself (Shopify / WooCommerce / Amazon FBA)
alter table public.orders add column if not exists stock_taken integer not null default 0;      -- units this order has taken out of stock
alter table public.orders add column if not exists stock_sku text not null default '';          -- …from this product

-- ---------- 3. Where every unit went ----------
create table if not exists public.stock_moves (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  sku          text not null,
  change       integer not null,                 -- −2 sold, +2 came back, +50 stock in
  stock_after  integer,
  reason       text not null default '',         -- Sold · Order cancelled / returned · Order changed · Stock in · Adjusted · Opening stock · Synced from store
  channel      text not null default '',
  order_id     text not null default '',
  by_name      text not null default '',
  at           timestamptz not null default now()
);
create index if not exists stock_moves_ws_at on public.stock_moves (workspace_id, at desc);
create index if not exists stock_moves_ws_sku on public.stock_moves (workspace_id, sku, at desc);
alter table public.stock_moves enable row level security;
drop policy if exists sm_select on public.stock_moves;
create policy sm_select on public.stock_moves for select to authenticated using (public.is_member(workspace_id));
revoke insert, update, delete on public.stock_moves from anon, authenticated;            -- written only by the database itself
grant select on public.stock_moves to authenticated;
grant all on public.stock_moves to service_role;

-- change one product's stock and write it in the log
create or replace function public.stock_apply(p_ws uuid, p_sku text, p_change int, p_reason text, p_channel text, p_order text, p_by text) returns void
language plpgsql security definer set search_path = public as $$
declare after_qty int;
begin
  if p_change = 0 then return; end if;
  perform set_config('nodevers.stockmove', '1', true);
  update public.products set stock = stock + p_change where workspace_id = p_ws and sku = p_sku returning stock into after_qty;
  perform set_config('nodevers.stockmove', '', true);
  if not found then return; end if;
  insert into public.stock_moves (workspace_id, sku, change, stock_after, reason, channel, order_id, by_name)
  values (p_ws, p_sku, p_change, after_qty, left(p_reason, 60), left(coalesce(p_channel, ''), 40), left(coalesce(p_order, ''), 80), left(coalesce(p_by, ''), 80));
end $$;
revoke execute on function public.stock_apply(uuid, text, int, text, text, text, text) from public, anon, authenticated;

-- mark orders that are already in the CRM as "taken" once, so running this file never changes today's stock
do $$ begin
  if not exists (select 1 from public.app_config where key = 'stock_init_16') then
    update public.orders o set stock_sku = o.sku, stock_taken = greatest(coalesce(o.qty, 1), 0)
     where coalesce(o.sku, '') <> '' and o.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned')
       and coalesce(o.source, '') not in ('Shopify', 'WooCommerce', 'Website API')
       and exists (select 1 from public.products p where p.workspace_id = o.workspace_id and p.sku = o.sku);
    update public.orders set stock_skip = true where coalesce(source, '') in ('Shopify', 'WooCommerce', 'Website API');
    insert into public.app_config (key, value) values ('stock_init_16', now()::text);
  end if;
end $$;

-- every order: take units out when it counts as a sale, put them back when it is cancelled / returned / deleted
create or replace function public.orders_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare want int := 0; wsku text := ''; old_taken int := 0; old_sku text := ''; auto boolean; ref text; who text;
begin
  if tg_op = 'DELETE' then
    if old.stock_taken > 0 and old.stock_sku <> '' then
      perform public.stock_apply(old.workspace_id, old.stock_sku, old.stock_taken, 'Order deleted', old.channel, coalesce(nullif(old.ext_id, ''), old.order_id), coalesce(auth.jwt() ->> 'email', ''));
    end if;
    return old;
  end if;
  auto := coalesce((select value from public.settings where workspace_id = new.workspace_id and key = 'stockAuto'), 'on') <> 'off';
  if auto and not coalesce(new.stock_skip, false) and coalesce(new.sku, '') <> '' and new.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned')
     and exists (select 1 from public.products where workspace_id = new.workspace_id and sku = new.sku) then
    want := greatest(coalesce(new.qty, 1), 0); wsku := new.sku;
  end if;
  if tg_op = 'UPDATE' then old_taken := coalesce(old.stock_taken, 0); old_sku := coalesce(old.stock_sku, ''); end if;
  if not auto and tg_op = 'UPDATE' then want := old_taken; wsku := old_sku; end if;      -- switched off: leave what was taken
  if want = 0 and wsku = '' then wsku := old_sku; end if;                                 -- nothing to take now: compare with the same product
  ref := coalesce(nullif(new.ext_id, ''), new.order_id); who := coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(new.source, ''), 'System');
  if old_sku = wsku then
    if want <> old_taken then
      perform public.stock_apply(new.workspace_id, wsku, old_taken - want,
        case when want > old_taken and old_taken = 0 then 'Sold' when want = 0 then 'Order cancelled / returned' else 'Order changed' end, new.channel, ref, who);
    end if;
  else
    if old_taken > 0 and old_sku <> '' then perform public.stock_apply(new.workspace_id, old_sku, old_taken, 'Order changed', new.channel, ref, who); end if;
    if want > 0 then perform public.stock_apply(new.workspace_id, wsku, -want, 'Sold', new.channel, ref, who); end if;
  end if;
  new.stock_taken := want; new.stock_sku := wsku;
  return new;
end $$;
revoke execute on function public.orders_stock() from public, anon, authenticated;
drop trigger if exists orders_stock on public.orders;
create trigger orders_stock before insert or update or delete on public.orders for each row execute function public.orders_stock();

-- stock changed by hand, by an import or by a store sync → also in the log
create or replace function public.products_stock_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare d int;
begin
  if coalesce(current_setting('nodevers.stockmove', true), '') = '1' then return null; end if;
  d := new.stock - case when tg_op = 'INSERT' then 0 else old.stock end;
  if d = 0 then return null; end if;
  insert into public.stock_moves (workspace_id, sku, change, stock_after, reason, by_name)
  values (new.workspace_id, new.sku, d, new.stock,
    case when auth.uid() is null then 'Synced from store' when tg_op = 'INSERT' then 'Opening stock' when d > 0 then 'Stock in' else 'Adjusted' end,
    coalesce(auth.jwt() ->> 'email', ''));
  return null;
end $$;
revoke execute on function public.products_stock_log() from public, anon, authenticated;
drop trigger if exists products_stock_log on public.products;
create trigger products_stock_log after insert or update of stock on public.products for each row execute function public.products_stock_log();
