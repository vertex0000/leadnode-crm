-- Nodevers 09 — Commerce: products & inventory, channel orders (Amazon / Website / WhatsApp…) with costs and profit, ad spend.
-- Every workspace (client) gets its own store data. Safe to run more than once. Needs 08_platform_flows.sql first.

-- ---------- 1. Products & inventory ----------
create table if not exists public.products (
  workspace_id  uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  sku           text not null check (length(trim(sku)) between 1 and 80),
  name          text not null default '' check (length(name) <= 200),
  category      text not null default '' check (length(category) <= 80),
  price         numeric check (price is null or price >= 0),          -- selling price (MRP / list)
  cost          numeric check (cost is null or cost >= 0),            -- cost per unit
  stock         integer not null default 0,
  reorder_level integer not null default 5 check (reorder_level >= 0),
  image_url     text not null default '' check (length(image_url) <= 500),
  amazon_asin   text not null default '' check (length(amazon_asin) <= 40),
  website_url   text not null default '' check (length(website_url) <= 500),
  notes         text not null default '' check (length(notes) <= 2000),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, sku)
);
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products for each row execute function public.touch_updated();
alter table public.products enable row level security;
drop policy if exists p_select on public.products;
drop policy if exists p_write on public.products;
create policy p_select on public.products for select to authenticated using (public.is_member(workspace_id));
create policy p_write on public.products for all to authenticated
  using (public.can_write(workspace_id) and public.has_perm(workspace_id, 'commerce'))
  with check (public.can_write(workspace_id) and public.has_perm(workspace_id, 'commerce'));
grant select, insert, update, delete on public.products to authenticated;
grant all on public.products to service_role;

-- ---------- 2. Orders from every channel: who, what, where, and every cost → net profit ----------
alter table public.orders add column if not exists channel text not null default 'WhatsApp' check (length(channel) <= 40);
update public.orders set channel = 'Direct' where source = 'Team' and channel = 'WhatsApp';
alter table public.orders add column if not exists ext_id text check (ext_id is null or length(ext_id) <= 80);      -- Amazon / website order number
alter table public.orders add column if not exists order_date date;
update public.orders set order_date = (created_at at time zone 'Asia/Kolkata')::date where order_date is null;
alter table public.orders alter column order_date set default ((now() at time zone 'Asia/Kolkata')::date);
alter table public.orders add column if not exists sku            text not null default '' check (length(sku) <= 80);
alter table public.orders add column if not exists product_name   text not null default '' check (length(product_name) <= 200);
alter table public.orders add column if not exists qty            integer not null default 1 check (qty >= 0);
alter table public.orders add column if not exists unit_price     numeric check (unit_price is null or unit_price >= 0);
alter table public.orders add column if not exists product_cost   numeric check (product_cost is null or product_cost >= 0);   -- total for the line
alter table public.orders add column if not exists marketplace_fee numeric check (marketplace_fee is null or marketplace_fee >= 0);
alter table public.orders add column if not exists shipping_fee   numeric check (shipping_fee is null or shipping_fee >= 0);
alter table public.orders add column if not exists packaging_cost numeric check (packaging_cost is null or packaging_cost >= 0);
alter table public.orders add column if not exists rto_charges    numeric check (rto_charges is null or rto_charges >= 0);
alter table public.orders add column if not exists ad_spend       numeric check (ad_spend is null or ad_spend >= 0);
alter table public.orders add column if not exists other_cost     numeric check (other_cost is null or other_cost >= 0);
alter table public.orders add column if not exists customer_name  text not null default '' check (length(customer_name) <= 120);
alter table public.orders add column if not exists customer_state text not null default '' check (length(customer_state) <= 60);
alter table public.orders add column if not exists customer_city  text not null default '' check (length(customer_city) <= 60);
alter table public.orders add column if not exists courier        text not null default '' check (length(courier) <= 60);
alter table public.orders add column if not exists return_reason  text not null default '' check (length(return_reason) <= 300);

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (status in
  ('Cart', 'New', 'Processing', 'Confirmed', 'Paid', 'COD', 'Shipped', 'Delivered', 'Cancelled', 'Refunded', 'RTO', 'Returned', 'Exchange'));

-- Net profit is always calculated the same way (cancelled / returned orders earn nothing but still carry their fees)
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'net_profit') then
    alter table public.orders add column net_profit numeric generated always as (
      (case when status in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') then 0 else coalesce(amount, 0) - coalesce(product_cost, 0) end)
      - coalesce(marketplace_fee, 0) - coalesce(shipping_fee, 0) - coalesce(packaging_cost, 0) - coalesce(rto_charges, 0) - coalesce(ad_spend, 0) - coalesce(other_cost, 0)) stored;
  end if;
end $$;

-- Re-importing the same Amazon / website file updates orders instead of duplicating them
create unique index if not exists orders_ext_uidx on public.orders (workspace_id, channel, ext_id);
create index if not exists orders_date_idx on public.orders (workspace_id, order_date);

-- Fill the gaps from the product list: name, price, amount (qty × price), product cost (qty × cost), items text
create or replace function public.orders_fill() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.products%rowtype;
begin
  if coalesce(new.sku, '') <> '' then select * into p from public.products where workspace_id = new.workspace_id and sku = new.sku; end if;
  if p.sku is not null then
    if coalesce(new.product_name, '') = '' then new.product_name := p.name; end if;
    if new.unit_price is null then new.unit_price := p.price; end if;
    if new.product_cost is null and p.cost is not null then new.product_cost := p.cost * coalesce(new.qty, 1); end if;
  end if;
  if new.amount is null and new.unit_price is not null then new.amount := new.unit_price * coalesce(new.qty, 1); end if;
  if coalesce(new.items, '') = '' and coalesce(new.product_name, new.sku, '') <> '' then
    new.items := left(coalesce(new.qty, 1) || ' × ' || coalesce(nullif(new.product_name, ''), new.sku), 2000);
  end if;
  if new.order_date is null then new.order_date := (now() at time zone 'Asia/Kolkata')::date; end if;
  return new;
end $$;
drop trigger if exists orders_fill on public.orders;
create trigger orders_fill before insert or update on public.orders for each row execute function public.orders_fill();

-- ---------- 3. Ad spend per day / campaign (Meta, Google, Amazon Ads…) → profit after ads, ROAS ----------
create table if not exists public.ad_spend (
  id           bigint generated always as identity,
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  day          date not null default ((now() at time zone 'Asia/Kolkata')::date),
  platform     text not null default 'Meta' check (length(platform) <= 40),
  campaign     text not null default '' check (length(campaign) <= 200),
  impressions  bigint check (impressions is null or impressions >= 0),
  clicks       bigint check (clicks is null or clicks >= 0),
  spend        numeric not null default 0 check (spend >= 0),
  purchases    integer check (purchases is null or purchases >= 0),
  revenue      numeric check (revenue is null or revenue >= 0),
  created_at   timestamptz not null default now(),
  primary key (id),
  unique (workspace_id, day, platform, campaign)
);
alter table public.ad_spend enable row level security;
drop policy if exists s_select on public.ad_spend;
drop policy if exists s_write on public.ad_spend;
create policy s_select on public.ad_spend for select to authenticated using (public.is_member(workspace_id));
create policy s_write on public.ad_spend for all to authenticated
  using (public.can_write(workspace_id) and public.has_perm(workspace_id, 'commerce'))
  with check (public.can_write(workspace_id) and public.has_perm(workspace_id, 'commerce'));
grant select, insert, update, delete on public.ad_spend to authenticated;
grant all on public.ad_spend to service_role;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products') then
    alter publication supabase_realtime add table public.products;
  end if;
end $$;
