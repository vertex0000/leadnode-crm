-- =====================================================================================
-- Nodevers — 26: Flipkart and Meesho store channels
--   * store_connections may now hold a Flipkart Seller Hub connection (self-access app: Application ID + secret,
--     kept server-side in store_connections.secret like every other connection) and, later, a Meesho one.
--   * Orders from Flipkart come in as channel 'Flipkart' (one row per order item), Meesho orders through the
--     Supplier Panel report import as channel 'Meesho' — both already fit the orders table (channel is free text).
-- Re-runnable. Nothing is deleted.
-- =====================================================================================

alter table public.store_connections drop constraint if exists store_connections_platform_check;
alter table public.store_connections add constraint store_connections_platform_check
  check (platform in ('shopify', 'woocommerce', 'custom', 'amazon', 'meta_ads', 'flipkart', 'meesho'));

-- marketplace order item ids are long; keep the lookup used by every sync fast
create index if not exists orders_ws_channel_ext on public.orders (workspace_id, channel, ext_id);

-- the website asks for this to know the update has run
create or replace function public.v26_ready() returns boolean language sql stable as $$ select true $$;
grant execute on function public.v26_ready() to authenticated;
