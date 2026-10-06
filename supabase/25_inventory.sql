-- Nodevers 25 — Inventory pro
--   1. Suppliers                          5. Purchase orders + goods received (GRN), weighted average cost
--   2. Warehouses / shops (locations)     6. Sets (bundles) and making products from parts (BOM)
--   3. Stock per location + transfers     7. Stock counts, scan-in, damaged / lost
--   4. Barcodes, units, product types     8. Automatic reorder point from sales speed + supplier days
-- Safe to run more than once. Needs 09, 10, 16, 22 and 23 first.
-- Rule kept everywhere: products.stock = units you can sell = sum of the locations + units on the road (transfers).

-- ---------- 0. who may change stock ----------
create or replace function public.inv_guard(p_ws uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p_ws is null or not (public.can_write(p_ws) and public.has_perm(p_ws, 'commerce')) then
    raise exception 'You do not have edit rights for Store & stock in this workspace';
  end if;
  if not public.ws_feature(p_ws, 'store') then raise exception 'Store is not part of your plan. Upgrade in Settings → Plan & billing.'; end if;
end $$;
revoke execute on function public.inv_guard(uuid) from public, anon, authenticated;

-- ---------- 1. suppliers ----------
create table if not exists public.suppliers (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 120),
  contact       text not null default '' check (length(contact) <= 120),
  phone         text not null default '' check (length(phone) <= 20),
  email         text not null default '' check (length(email) <= 160),
  gstin         text not null default '' check (length(gstin) <= 20),
  address       text not null default '' check (length(address) <= 400),
  lead_days     integer not null default 7 check (lead_days between 0 and 365),    -- days from order to delivery
  payment_terms text not null default '' check (length(payment_terms) <= 80),
  notes         text not null default '' check (length(notes) <= 1000),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists suppliers_ws_name on public.suppliers (workspace_id, lower(name));
drop trigger if exists suppliers_touch on public.suppliers;
create trigger suppliers_touch before update on public.suppliers for each row execute function public.touch_updated();
alter table public.suppliers enable row level security;
drop policy if exists sup_select on public.suppliers;
drop policy if exists sup_write on public.suppliers;
create policy sup_select on public.suppliers for select to authenticated using (public.is_member(workspace_id));
create policy sup_write on public.suppliers for all to authenticated
  using (public.can_write(workspace_id) and public.has_perm(workspace_id, 'commerce'))
  with check (public.can_write(workspace_id) and public.has_perm(workspace_id, 'commerce'));
grant select, insert, update, delete on public.suppliers to authenticated;
grant all on public.suppliers to service_role;

-- ---------- 2. product: supplier, lead time, MOQ, barcode, type, unit ----------
alter table public.products add column if not exists supplier_id  bigint references public.suppliers(id) on delete set null;
alter table public.products add column if not exists lead_days    integer check (lead_days is null or lead_days between 0 and 365);     -- empty = supplier's days
alter table public.products add column if not exists moq          integer check (moq is null or moq >= 0);                              -- smallest order the supplier takes
alter table public.products add column if not exists safety_days  integer check (safety_days is null or safety_days between 0 and 365); -- extra days of stock kept as a cushion
alter table public.products add column if not exists barcode      text not null default '' check (length(barcode) <= 64);
alter table public.products add column if not exists kind         text not null default 'simple' check (kind in ('simple', 'bundle', 'made', 'material'));
alter table public.products add column if not exists reorder_auto boolean not null default false;                                      -- reorder level follows sales speed
alter table public.products add column if not exists unit         text not null default 'pcs' check (length(unit) <= 12);
create unique index if not exists products_ws_barcode on public.products (workspace_id, barcode) where barcode <> '';
create index if not exists products_ws_supplier on public.products (workspace_id, supplier_id) where supplier_id is not null;

-- a product can only point to a supplier of its own workspace
create or replace function public.products_supplier_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.supplier_id is not null and not exists (select 1 from public.suppliers s where s.id = new.supplier_id and s.workspace_id = new.workspace_id) then new.supplier_id := null; end if;
  return new;
end $$;
revoke execute on function public.products_supplier_check() from public, anon, authenticated;
drop trigger if exists products_supplier_check on public.products;
create trigger products_supplier_check before insert or update of supplier_id on public.products for each row execute function public.products_supplier_check();

-- ---------- 3. locations (warehouse, shop, factory) and stock per location ----------
create table if not exists public.stock_locations (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 60),
  kind         text not null default 'warehouse' check (kind in ('warehouse', 'shop', 'factory', 'other')),
  address      text not null default '' check (length(address) <= 300),
  is_default   boolean not null default false,       -- the main place: sales, imports and manual changes use it
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index if not exists stock_locations_ws_name on public.stock_locations (workspace_id, lower(name));
create unique index if not exists stock_locations_one_default on public.stock_locations (workspace_id) where is_default;
alter table public.stock_locations enable row level security;
drop policy if exists sl_select on public.stock_locations;
create policy sl_select on public.stock_locations for select to authenticated using (public.is_member(workspace_id));
revoke insert, update, delete on public.stock_locations from anon, authenticated;
grant select on public.stock_locations to authenticated;
grant all on public.stock_locations to service_role;

create table if not exists public.stock_levels (
  workspace_id uuid not null,
  sku          text not null,
  location_id  bigint not null references public.stock_locations(id) on delete cascade,
  qty          integer not null default 0,
  primary key (workspace_id, sku, location_id),
  foreign key (workspace_id, sku) references public.products(workspace_id, sku) on update cascade on delete cascade
);
create index if not exists stock_levels_ws_loc on public.stock_levels (workspace_id, location_id);
alter table public.stock_levels enable row level security;
drop policy if exists slv_select on public.stock_levels;
create policy slv_select on public.stock_levels for select to authenticated using (public.is_member(workspace_id));
revoke insert, update, delete on public.stock_levels from anon, authenticated;
grant select on public.stock_levels to authenticated;
grant all on public.stock_levels to service_role;

create or replace function public.loc_default(p_ws uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select id from public.stock_locations where workspace_id = p_ws and is_default limit 1;
$$;
revoke execute on function public.loc_default(uuid) from public, anon, authenticated;

-- the stock log remembers the place and a short note
alter table public.stock_moves add column if not exists location_id bigint;
alter table public.stock_moves add column if not exists note text not null default '';

-- ---------- 4. sets (bundles) and made products: what goes into one unit ----------
create table if not exists public.product_parts (
  workspace_id uuid not null,
  parent_sku   text not null,
  part_sku     text not null,
  qty          numeric not null check (qty > 0 and qty <= 100000),     -- per one unit of the parent
  primary key (workspace_id, parent_sku, part_sku),
  check (parent_sku <> part_sku),
  foreign key (workspace_id, parent_sku) references public.products(workspace_id, sku) on update cascade on delete cascade,
  foreign key (workspace_id, part_sku) references public.products(workspace_id, sku) on update cascade on delete cascade
);
create index if not exists product_parts_part on public.product_parts (workspace_id, part_sku);
alter table public.product_parts enable row level security;
drop policy if exists pp_select on public.product_parts;
create policy pp_select on public.product_parts for select to authenticated using (public.is_member(workspace_id));
revoke insert, update, delete on public.product_parts from anon, authenticated;
grant select on public.product_parts to authenticated;
grant all on public.product_parts to service_role;

-- ---------- 5. one stock change: product total + its location + the log. A set (bundle) changes its parts instead ----------
create or replace function public.stock_apply_at(p_ws uuid, p_sku text, p_change int, p_reason text, p_channel text, p_order text, p_by text, p_loc bigint, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare k text; after_qty int; loc bigint := p_loc; r record;
begin
  if coalesce(p_change, 0) = 0 then return; end if;
  select kind into k from public.products where workspace_id = p_ws and sku = p_sku;
  if not found then return; end if;
  if k = 'bundle' then
    for r in select part_sku, qty from public.product_parts where workspace_id = p_ws and parent_sku = p_sku loop
      perform public.stock_apply_at(p_ws, r.part_sku, (p_change * ceil(r.qty))::int, p_reason, p_channel, p_order, p_by, p_loc, left('Set ' || p_sku, 200));
    end loop;
    return;
  end if;
  if loc is null then loc := public.loc_default(p_ws); end if;
  perform set_config('nodevers.stockmove', '1', true);
  update public.products set stock = stock + p_change where workspace_id = p_ws and sku = p_sku returning stock into after_qty;
  perform set_config('nodevers.stockmove', '', true);
  if loc is not null then
    insert into public.stock_levels (workspace_id, sku, location_id, qty) values (p_ws, p_sku, loc, p_change)
    on conflict (workspace_id, sku, location_id) do update set qty = public.stock_levels.qty + excluded.qty;
  end if;
  insert into public.stock_moves (workspace_id, sku, change, stock_after, reason, channel, order_id, by_name, location_id, note)
  values (p_ws, p_sku, p_change, after_qty, left(p_reason, 60), left(coalesce(p_channel, ''), 40), left(coalesce(p_order, ''), 80), left(coalesce(p_by, ''), 80), loc, left(coalesce(p_note, ''), 200));
end $$;
revoke execute on function public.stock_apply_at(uuid, text, int, text, text, text, text, bigint, text) from public, anon, authenticated;

-- the older one (used by sales) now goes through the same path
create or replace function public.stock_apply(p_ws uuid, p_sku text, p_change int, p_reason text, p_channel text, p_order text, p_by text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.stock_apply_at(p_ws, p_sku, p_change, p_reason, p_channel, p_order, p_by, null, '');
end $$;
revoke execute on function public.stock_apply(uuid, text, int, text, text, text, text) from public, anon, authenticated;

-- move units between places without changing the total (transfers)
create or replace function public.level_move(p_ws uuid, p_sku text, p_loc bigint, p_change int, p_reason text, p_ref text, p_by text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare tot int;
begin
  if coalesce(p_change, 0) = 0 or p_loc is null then return; end if;
  insert into public.stock_levels (workspace_id, sku, location_id, qty) values (p_ws, p_sku, p_loc, p_change)
  on conflict (workspace_id, sku, location_id) do update set qty = public.stock_levels.qty + excluded.qty;
  select stock into tot from public.products where workspace_id = p_ws and sku = p_sku;
  insert into public.stock_moves (workspace_id, sku, change, stock_after, reason, order_id, by_name, location_id, note)
  values (p_ws, p_sku, p_change, tot, p_reason, left(coalesce(p_ref, ''), 80), left(coalesce(p_by, ''), 80), p_loc, left(coalesce(p_note, ''), 200));
end $$;
revoke execute on function public.level_move(uuid, text, bigint, int, text, text, text, text) from public, anon, authenticated;

-- stock changed by hand, by an import or a store sync → log it and keep the main location in step
create or replace function public.products_stock_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare d int; loc bigint;
begin
  if coalesce(current_setting('nodevers.stockmove', true), '') = '1' then return null; end if;
  d := new.stock - case when tg_op = 'INSERT' then 0 else old.stock end;
  if d = 0 then return null; end if;
  if coalesce(new.kind, 'simple') <> 'bundle' then
    loc := public.loc_default(new.workspace_id);
    if loc is not null then
      insert into public.stock_levels (workspace_id, sku, location_id, qty) values (new.workspace_id, new.sku, loc, d)
      on conflict (workspace_id, sku, location_id) do update set qty = public.stock_levels.qty + excluded.qty;
    end if;
  end if;
  insert into public.stock_moves (workspace_id, sku, change, stock_after, reason, by_name, location_id)
  values (new.workspace_id, new.sku, d, new.stock,
    case when auth.uid() is null then 'Synced from store' when tg_op = 'INSERT' then 'Opening stock' when d > 0 then 'Stock in' else 'Adjusted' end,
    coalesce(auth.jwt() ->> 'email', ''), loc);
  return null;
end $$;
revoke execute on function public.products_stock_log() from public, anon, authenticated;
drop trigger if exists products_stock_log on public.products;
create trigger products_stock_log after insert or update of stock on public.products for each row execute function public.products_stock_log();

-- a set has no stock of its own (it comes from its parts) → no low-stock alert for it
create or replace function public.alert_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not new.active or coalesce(new.kind, 'simple') = 'bundle' then return new; end if;
  if not exists (select 1 from public.settings s where s.workspace_id = new.workspace_id and s.key = 'storeAlertsJson') then return new; end if;
  if new.stock <= 0 and (tg_op = 'INSERT' or old.stock > 0) then
    insert into public.alert_queue (workspace_id, kind, ref, payload) values (new.workspace_id, 'out_stock', new.sku, jsonb_build_object('sku', new.sku, 'name', new.name, 'stock', new.stock)) on conflict do nothing;
  elsif new.stock > 0 and new.stock <= new.reorder_level and (tg_op = 'INSERT' or old.stock > old.reorder_level or old.stock <= 0) then
    insert into public.alert_queue (workspace_id, kind, ref, payload) values (new.workspace_id, 'low_stock', new.sku, jsonb_build_object('sku', new.sku, 'name', new.name, 'stock', new.stock, 'reorder', new.reorder_level)) on conflict do nothing;
  end if;
  return new;
exception when others then return new;
end $$;

-- ---------- 6. orders: ship from a location ----------
alter table public.orders add column if not exists location_id bigint references public.stock_locations(id) on delete set null;   -- ship from (empty = main)
alter table public.orders add column if not exists stock_loc bigint;                                                              -- where the units were taken

create or replace function public.orders_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare want int := 0; wsku text := ''; wloc bigint; old_taken int := 0; old_sku text := ''; old_loc bigint; auto boolean; ref text; who text;
begin
  if tg_op = 'DELETE' then
    if old.stock_taken > 0 and old.stock_sku <> '' then
      perform public.stock_apply_at(old.workspace_id, old.stock_sku, old.stock_taken, 'Order deleted', old.channel, coalesce(nullif(old.ext_id, ''), old.order_id), coalesce(auth.jwt() ->> 'email', ''), old.stock_loc, '');
    end if;
    return old;
  end if;
  auto := coalesce((select value from public.settings where workspace_id = new.workspace_id and key = 'stockAuto'), 'on') <> 'off';
  if auto and not coalesce(new.stock_skip, false) and coalesce(new.sku, '') <> '' and new.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned')
     and exists (select 1 from public.products where workspace_id = new.workspace_id and sku = new.sku) then
    want := greatest(coalesce(new.qty, 1), 0); wsku := new.sku;
  end if;
  if tg_op = 'UPDATE' then old_taken := coalesce(old.stock_taken, 0); old_sku := coalesce(old.stock_sku, ''); old_loc := old.stock_loc; end if;
  if want > 0 then          -- where the units come from: the order's place, else where it took them before, else the main place
    select id into wloc from public.stock_locations where id = new.location_id and workspace_id = new.workspace_id;
    if wloc is null and old_taken > 0 then wloc := old_loc; end if;
    if wloc is null then wloc := public.loc_default(new.workspace_id); end if;
  end if;
  if not auto and tg_op = 'UPDATE' then want := old_taken; wsku := old_sku; wloc := old_loc; end if;   -- switched off: leave what was taken
  if want = 0 and wsku = '' then wsku := old_sku; end if;                                            -- nothing to take now: compare with the same product
  ref := coalesce(nullif(new.ext_id, ''), new.order_id); who := coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(new.source, ''), 'System');
  if old_taken > 0 and want > 0 and (old_sku <> wsku or old_loc is distinct from wloc) then
    perform public.stock_apply_at(new.workspace_id, old_sku, old_taken, 'Order changed', new.channel, ref, who, old_loc, '');
    perform public.stock_apply_at(new.workspace_id, wsku, -want, case when old_sku <> wsku then 'Sold' else 'Order changed' end, new.channel, ref, who, wloc, '');
  elsif want <> old_taken then
    if want = 0 then perform public.stock_apply_at(new.workspace_id, old_sku, old_taken, 'Order cancelled / returned', new.channel, ref, who, old_loc, '');
    elsif old_taken = 0 then perform public.stock_apply_at(new.workspace_id, wsku, -want, 'Sold', new.channel, ref, who, wloc, '');
    else perform public.stock_apply_at(new.workspace_id, wsku, old_taken - want, 'Order changed', new.channel, ref, who, wloc, '');
    end if;
  end if;
  new.stock_taken := want; new.stock_sku := wsku; new.stock_loc := case when want > 0 then wloc end;
  return new;
end $$;
revoke execute on function public.orders_stock() from public, anon, authenticated;
drop trigger if exists orders_stock on public.orders;
create trigger orders_stock before insert or update or delete on public.orders for each row execute function public.orders_stock();

-- ---------- 7. add / edit / remove a location ----------
create or replace function public.loc_save(p_ws uuid, p_id bigint, p_name text, p_kind text, p_address text, p_default boolean, p_active boolean) returns bigint
language plpgsql security definer set search_path = public as $$
declare lid bigint; first boolean;
begin
  perform public.inv_guard(p_ws);
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Give the place a name'; end if;
  if exists (select 1 from public.stock_locations where workspace_id = p_ws and lower(name) = lower(trim(p_name)) and id is distinct from p_id) then raise exception 'You already have a place called %', trim(p_name); end if;
  if p_id is null then
    first := not exists (select 1 from public.stock_locations where workspace_id = p_ws);
    insert into public.stock_locations (workspace_id, name, kind, address, is_default, active)
    values (p_ws, left(trim(p_name), 60), coalesce(nullif(p_kind, ''), 'warehouse'), left(coalesce(p_address, ''), 300), false, true) returning id into lid;
    if first then
      update public.stock_locations set is_default = true where id = lid;
      insert into public.stock_levels (workspace_id, sku, location_id, qty)
      select workspace_id, sku, lid, stock from public.products where workspace_id = p_ws and kind <> 'bundle' and stock <> 0
      on conflict (workspace_id, sku, location_id) do nothing;
      return lid;
    end if;
  else
    select id into lid from public.stock_locations where id = p_id and workspace_id = p_ws;
    if lid is null then raise exception 'Location not found'; end if;
    if not coalesce(p_active, true) and exists (select 1 from public.stock_locations where id = lid and is_default) then raise exception 'The main place can not be switched off — make another place the main one first'; end if;
    update public.stock_locations set name = left(trim(p_name), 60), kind = coalesce(nullif(p_kind, ''), kind), address = left(coalesce(p_address, ''), 300), active = coalesce(p_active, true) where id = lid;
  end if;
  if coalesce(p_default, false) then
    update public.stock_locations set is_default = false where workspace_id = p_ws and is_default and id <> lid;
    update public.stock_locations set is_default = true, active = true where id = lid;
  end if;
  return lid;
end $$;

create or replace function public.loc_delete(p_ws uuid, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.inv_guard(p_ws);
  if not exists (select 1 from public.stock_locations where id = p_id and workspace_id = p_ws) then raise exception 'Location not found'; end if;
  if exists (select 1 from public.stock_locations where id = p_id and is_default) and exists (select 1 from public.stock_locations where workspace_id = p_ws and id <> p_id) then
    raise exception 'This is your main place — make another place the main one first';
  end if;
  if exists (select 1 from public.stock_levels where location_id = p_id and qty <> 0) then raise exception 'This place still has stock — move it to another place first (Move stock)'; end if;
  if exists (select 1 from public.stock_transfers where workspace_id = p_ws and status = 'in_transit' and (from_loc = p_id or to_loc = p_id)) then raise exception 'A transfer to or from this place is still on the way'; end if;
  delete from public.stock_locations where id = p_id;
end $$;

-- ---------- 8. transfers between places ----------
create table if not exists public.stock_transfers (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code         text not null default '',
  from_loc     bigint,
  to_loc       bigint,
  from_name    text not null default '',
  to_name      text not null default '',
  status       text not null default 'in_transit' check (status in ('in_transit', 'received', 'cancelled')),
  note         text not null default '' check (length(note) <= 300),
  by_name      text not null default '',
  units        integer not null default 0,
  sent_at      timestamptz not null default now(),
  received_at  timestamptz,
  unique (workspace_id, code)
);
drop trigger if exists stock_transfers_code on public.stock_transfers;
create trigger stock_transfers_code before insert on public.stock_transfers for each row execute function public.set_code('TR', 'code');
create table if not exists public.stock_transfer_lines (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  transfer_id  bigint not null references public.stock_transfers(id) on delete cascade,
  sku          text not null,
  name         text not null default '',
  qty          integer not null check (qty > 0)
);
create index if not exists stock_transfer_lines_tr on public.stock_transfer_lines (transfer_id);
create index if not exists stock_transfers_ws on public.stock_transfers (workspace_id, sent_at desc);

create or replace function public.transfer_create(p_ws uuid, p_from bigint, p_to bigint, p_lines jsonb, p_note text, p_by text, p_arrived boolean) returns text
language plpgsql security definer set search_path = public as $$
declare f record; t record; tid bigint; c text; r record; have int; n int := 0;
begin
  perform public.inv_guard(p_ws);
  select * into f from public.stock_locations where id = p_from and workspace_id = p_ws;
  select * into t from public.stock_locations where id = p_to and workspace_id = p_ws;
  if f.id is null or t.id is null then raise exception 'Pick both places'; end if;
  if f.id = t.id then raise exception 'From and To must be different places'; end if;
  if not t.active then raise exception '% is switched off', t.name; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one product'; end if;
  for r in select x.sku, sum(x.qty)::int qty from jsonb_to_recordset(p_lines) x(sku text, qty int) where coalesce(x.qty, 0) > 0 group by x.sku loop
    if not exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku and kind <> 'bundle') then raise exception 'Product % not found', r.sku; end if;
    select coalesce(qty, 0) into have from public.stock_levels where workspace_id = p_ws and sku = r.sku and location_id = f.id;
    if coalesce(have, 0) < r.qty then raise exception 'Only % of % at %', coalesce(have, 0), r.sku, f.name; end if;
    n := n + r.qty;
  end loop;
  if n = 0 then raise exception 'Add at least one product'; end if;
  insert into public.stock_transfers (workspace_id, from_loc, to_loc, from_name, to_name, note, by_name, units, status)
  values (p_ws, f.id, t.id, f.name, t.name, left(coalesce(p_note, ''), 300), left(coalesce(p_by, ''), 80), n, 'in_transit') returning id, code into tid, c;
  for r in select x.sku, sum(x.qty)::int qty from jsonb_to_recordset(p_lines) x(sku text, qty int) where coalesce(x.qty, 0) > 0 group by x.sku loop
    insert into public.stock_transfer_lines (workspace_id, transfer_id, sku, name, qty) select p_ws, tid, r.sku, p.name, r.qty from public.products p where p.workspace_id = p_ws and p.sku = r.sku;
    perform public.level_move(p_ws, r.sku, f.id, -r.qty, 'Transfer out', c, p_by, 'To ' || t.name);
  end loop;
  if coalesce(p_arrived, false) then perform public.transfer_receive(p_ws, tid, p_by); end if;
  return c;
end $$;

create or replace function public.transfer_receive(p_ws uuid, p_id bigint, p_by text) returns void
language plpgsql security definer set search_path = public as $$
declare t record; r record;
begin
  perform public.inv_guard(p_ws);
  select * into t from public.stock_transfers where id = p_id and workspace_id = p_ws for update;
  if t.id is null then raise exception 'Transfer not found'; end if;
  if t.status <> 'in_transit' then raise exception 'This transfer is already %', replace(t.status, '_', ' '); end if;
  if not exists (select 1 from public.stock_locations where id = t.to_loc and workspace_id = p_ws) then raise exception 'The place it was going to no longer exists — cancel the transfer'; end if;
  for r in select sku, qty from public.stock_transfer_lines where transfer_id = t.id loop
    if exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku) then
      perform public.level_move(p_ws, r.sku, t.to_loc, r.qty, 'Transfer in', t.code, p_by, 'From ' || t.from_name);
    end if;
  end loop;
  update public.stock_transfers set status = 'received', received_at = now() where id = t.id;
end $$;

create or replace function public.transfer_cancel(p_ws uuid, p_id bigint, p_by text) returns void
language plpgsql security definer set search_path = public as $$
declare t record; r record; back bigint;
begin
  perform public.inv_guard(p_ws);
  select * into t from public.stock_transfers where id = p_id and workspace_id = p_ws for update;
  if t.id is null then raise exception 'Transfer not found'; end if;
  if t.status <> 'in_transit' then raise exception 'Only a transfer that is on the way can be cancelled'; end if;
  back := coalesce((select id from public.stock_locations where id = t.from_loc and workspace_id = p_ws), public.loc_default(p_ws));
  for r in select sku, qty from public.stock_transfer_lines where transfer_id = t.id loop
    if exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku) then
      perform public.level_move(p_ws, r.sku, back, r.qty, 'Transfer cancelled', t.code, p_by, 'Back to ' || t.from_name);
    end if;
  end loop;
  update public.stock_transfers set status = 'cancelled', received_at = now() where id = t.id;
end $$;

-- ---------- 9. purchase orders + goods received (GRN) ----------
create table if not exists public.purchase_orders (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  code          text not null default '',
  supplier_id   bigint references public.suppliers(id) on delete set null,
  supplier_name text not null default '',
  location_id   bigint references public.stock_locations(id) on delete set null,     -- deliver to
  status        text not null default 'draft' check (status in ('draft', 'sent', 'partial', 'received', 'closed', 'cancelled')),
  order_date    date not null default ((now() at time zone 'Asia/Kolkata')::date),
  expected_date date,
  notes         text not null default '' check (length(notes) <= 1000),
  extra_cost    numeric not null default 0 check (extra_cost >= 0),                     -- transport / loading
  tax_pct       numeric not null default 0 check (tax_pct between 0 and 100),           -- GST %
  total         numeric not null default 0,
  created_by    text not null default '',
  sent_at       timestamptz,
  received_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, code)
);
drop trigger if exists purchase_orders_code on public.purchase_orders;
create trigger purchase_orders_code before insert on public.purchase_orders for each row execute function public.set_code('PO', 'code');
drop trigger if exists purchase_orders_touch on public.purchase_orders;
create trigger purchase_orders_touch before update on public.purchase_orders for each row execute function public.touch_updated();
create index if not exists purchase_orders_ws on public.purchase_orders (workspace_id, created_at desc);
create table if not exists public.po_lines (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  po_id        bigint not null references public.purchase_orders(id) on delete cascade,
  sku          text not null,
  name         text not null default '',
  qty          integer not null check (qty > 0),
  qty_received integer not null default 0 check (qty_received >= 0),
  unit_cost    numeric not null default 0 check (unit_cost >= 0)
);
create index if not exists po_lines_po on public.po_lines (po_id);
create index if not exists po_lines_ws_sku on public.po_lines (workspace_id, sku);

create table if not exists public.grns (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  code          text not null default '',
  po_id         bigint references public.purchase_orders(id) on delete set null,
  po_code       text not null default '',
  supplier_id   bigint,
  supplier_name text not null default '',
  location_id   bigint,
  invoice_no    text not null default '' check (length(invoice_no) <= 60),
  note          text not null default '' check (length(note) <= 300),
  by_name       text not null default '',
  units         integer not null default 0,
  damaged       integer not null default 0,
  value         numeric not null default 0,
  at            timestamptz not null default now(),
  unique (workspace_id, code)
);
drop trigger if exists grns_code on public.grns;
create trigger grns_code before insert on public.grns for each row execute function public.set_code('GRN', 'code');
create index if not exists grns_ws on public.grns (workspace_id, at desc);
create table if not exists public.grn_lines (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  grn_id       bigint not null references public.grns(id) on delete cascade,
  sku          text not null,
  name         text not null default '',
  qty          integer not null default 0 check (qty >= 0),       -- good units added to stock
  damaged      integer not null default 0 check (damaged >= 0),   -- broken / rejected, not added
  unit_cost    numeric not null default 0 check (unit_cost >= 0)
);
create index if not exists grn_lines_grn on public.grn_lines (grn_id);

-- save a purchase order (new or a draft / sent one that has not been received yet)
create or replace function public.po_save(p_ws uuid, p_id bigint, p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare po record; sid bigint; sname text := ''; lid bigint; pid bigint; r record; sub numeric := 0; tax numeric; extra numeric; n int := 0;
begin
  perform public.inv_guard(p_ws);
  if p_id is not null then
    select * into po from public.purchase_orders where id = p_id and workspace_id = p_ws for update;
    if po.id is null then raise exception 'Purchase order not found'; end if;
    if po.status not in ('draft', 'sent') or exists (select 1 from public.po_lines where po_id = po.id and qty_received > 0) then raise exception 'This purchase order is already (partly) received — it can not be changed'; end if;
  end if;
  sid := nullif(p ->> 'supplierId', '')::bigint;
  if sid is not null then
    select name into sname from public.suppliers where id = sid and workspace_id = p_ws;
    if sname is null then raise exception 'Supplier not found'; end if;
  end if;
  lid := nullif(p ->> 'locationId', '')::bigint;
  if lid is not null and not exists (select 1 from public.stock_locations where id = lid and workspace_id = p_ws) then raise exception 'Location not found'; end if;
  tax := greatest(0, least(100, coalesce(nullif(p ->> 'taxPct', '')::numeric, 0)));
  extra := greatest(0, coalesce(nullif(p ->> 'extraCost', '')::numeric, 0));
  if jsonb_typeof(p -> 'lines') <> 'array' then raise exception 'Add at least one product'; end if;
  for r in select x.sku, sum(x.qty)::int qty, max(coalesce(x."unitCost", 0)) uc from jsonb_to_recordset(p -> 'lines') x(sku text, qty int, "unitCost" numeric) where coalesce(x.qty, 0) > 0 group by x.sku loop
    if not exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku and kind <> 'bundle') then raise exception 'Product % not found (a set is bought as its parts)', r.sku; end if;
    if r.uc < 0 then raise exception 'Cost can not be below 0'; end if;
    sub := sub + r.qty * r.uc; n := n + 1;
  end loop;
  if n = 0 then raise exception 'Add at least one product with a quantity'; end if;
  if p_id is null then
    insert into public.purchase_orders (workspace_id, supplier_id, supplier_name, location_id, order_date, expected_date, notes, extra_cost, tax_pct, total, created_by)
    values (p_ws, sid, coalesce(sname, ''), lid, coalesce(nullif(p ->> 'orderDate', '')::date, (now() at time zone 'Asia/Kolkata')::date), nullif(p ->> 'expectedDate', '')::date,
            left(coalesce(p ->> 'notes', ''), 1000), extra, tax, round(sub * (1 + tax / 100) + extra, 2), left(coalesce(p ->> 'by', ''), 80)) returning id into pid;
  else
    pid := p_id;
    update public.purchase_orders set supplier_id = sid, supplier_name = coalesce(sname, ''), location_id = lid, order_date = coalesce(nullif(p ->> 'orderDate', '')::date, order_date),
      expected_date = nullif(p ->> 'expectedDate', '')::date, notes = left(coalesce(p ->> 'notes', ''), 1000), extra_cost = extra, tax_pct = tax, total = round(sub * (1 + tax / 100) + extra, 2) where id = pid;
    delete from public.po_lines where po_id = pid;
  end if;
  insert into public.po_lines (workspace_id, po_id, sku, name, qty, unit_cost)
  select p_ws, pid, x.sku, coalesce(pr.name, ''), sum(x.qty)::int, max(coalesce(x."unitCost", 0))
    from jsonb_to_recordset(p -> 'lines') x(sku text, qty int, "unitCost" numeric) join public.products pr on pr.workspace_id = p_ws and pr.sku = x.sku
   where coalesce(x.qty, 0) > 0 group by x.sku, pr.name;
  return pid;
end $$;

create or replace function public.po_status(p_ws uuid, p_id bigint, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare po record; got boolean;
begin
  perform public.inv_guard(p_ws);
  select * into po from public.purchase_orders where id = p_id and workspace_id = p_ws for update;
  if po.id is null then raise exception 'Purchase order not found'; end if;
  got := exists (select 1 from public.po_lines where po_id = po.id and qty_received > 0);
  if p_status = 'sent' and po.status = 'draft' then update public.purchase_orders set status = 'sent', sent_at = now() where id = po.id;
  elsif p_status = 'draft' and po.status in ('sent', 'cancelled') and not got then update public.purchase_orders set status = 'draft' where id = po.id;
  elsif p_status = 'cancelled' and po.status in ('draft', 'sent') and not got then update public.purchase_orders set status = 'cancelled' where id = po.id;
  elsif p_status = 'closed' and po.status in ('sent', 'partial') then update public.purchase_orders set status = case when got then 'closed' else 'cancelled' end, received_at = coalesce(received_at, now()) where id = po.id;
  elsif po.status = p_status then return;
  else raise exception 'A % purchase order can not be marked %', po.status, p_status;
  end if;
end $$;

create or replace function public.po_delete(p_ws uuid, p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.inv_guard(p_ws);
  if not exists (select 1 from public.purchase_orders where id = p_id and workspace_id = p_ws and status in ('draft', 'cancelled')) then raise exception 'Only a draft or cancelled purchase order can be deleted'; end if;
  if exists (select 1 from public.po_lines where po_id = p_id and qty_received > 0) then raise exception 'Part of it was received — it stays for your records'; end if;
  delete from public.purchase_orders where id = p_id;
end $$;

-- goods arrived: add good units to stock at the place, update the cost (weighted average), update the PO
create or replace function public.po_receive(p_ws uuid, p_po bigint, p_loc bigint, p_lines jsonb, p_invoice text, p_note text, p_by text) returns text
language plpgsql security definer set search_path = public as $$
declare po record; loc bigint; gid bigint; c text; r record; pl record; pr record; v_units int := 0; v_dmg int := 0; val numeric := 0; uc numeric;
begin
  perform public.inv_guard(p_ws);
  select * into po from public.purchase_orders where id = p_po and workspace_id = p_ws for update;
  if po.id is null then raise exception 'Purchase order not found'; end if;
  if po.status not in ('draft', 'sent', 'partial') then raise exception 'This purchase order is %', po.status; end if;
  loc := coalesce(p_loc, po.location_id, public.loc_default(p_ws));
  if loc is not null and not exists (select 1 from public.stock_locations where id = loc and workspace_id = p_ws) then raise exception 'Location not found'; end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Nothing to receive'; end if;
  insert into public.grns (workspace_id, po_id, po_code, supplier_id, supplier_name, location_id, invoice_no, note, by_name)
  values (p_ws, po.id, po.code, po.supplier_id, po.supplier_name, loc, left(coalesce(p_invoice, ''), 60), left(coalesce(p_note, ''), 300), left(coalesce(p_by, ''), 80)) returning id, code into gid, c;
  for r in select x.sku, sum(greatest(coalesce(x.qty, 0), 0))::int qty, sum(greatest(coalesce(x.damaged, 0), 0))::int damaged, max(x."unitCost") ucost
             from jsonb_to_recordset(p_lines) x(sku text, qty int, damaged int, "unitCost" numeric) group by x.sku loop
    if r.qty + r.damaged = 0 then continue; end if;
    select * into pl from public.po_lines where po_id = po.id and sku = r.sku limit 1;
    if pl.id is null then raise exception '% is not on this purchase order', r.sku; end if;
    uc := coalesce(r.ucost, pl.unit_cost);
    if uc < 0 then raise exception 'Cost can not be below 0'; end if;
    select * into pr from public.products where workspace_id = p_ws and sku = r.sku for update;
    if pr.sku is null then raise exception 'Product % no longer exists', r.sku; end if;
    if r.qty > 0 and uc > 0 then      -- new cost = old units × old cost + new units × new cost, divided by all units
      update public.products set cost = case when coalesce(pr.cost, 0) = 0 or pr.stock <= 0 then uc
        else round((pr.stock * pr.cost + r.qty * uc) / (pr.stock + r.qty), 2) end where workspace_id = p_ws and sku = r.sku;
    end if;
    if r.qty > 0 then perform public.stock_apply_at(p_ws, r.sku, r.qty, 'Purchase received', '', po.code, p_by, loc, c || coalesce(' · ' || nullif(po.supplier_name, ''), '')); end if;
    update public.po_lines set qty_received = qty_received + r.qty where id = pl.id;
    insert into public.grn_lines (workspace_id, grn_id, sku, name, qty, damaged, unit_cost) values (p_ws, gid, r.sku, pr.name, r.qty, r.damaged, uc);
    v_units := v_units + r.qty; v_dmg := v_dmg + r.damaged; val := val + r.qty * uc;
  end loop;
  if v_units + v_dmg = 0 then raise exception 'Enter how many arrived'; end if;
  update public.grns set units = v_units, damaged = v_dmg, value = round(val, 2) where id = gid;
  update public.purchase_orders set
    status = case when not exists (select 1 from public.po_lines where po_id = po.id and qty_received < qty) then 'received' else 'partial' end,
    received_at = case when not exists (select 1 from public.po_lines where po_id = po.id and qty_received < qty) then now() else received_at end,
    sent_at = coalesce(sent_at, now())
  where id = po.id;
  return c;
end $$;

-- ---------- 10. sets and made products ----------
create or replace function public.parts_save(p_ws uuid, p_sku text, p_kind text, p_parts jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare pr record; r record; n int := 0;
begin
  perform public.inv_guard(p_ws);
  if p_kind not in ('simple', 'bundle', 'made', 'material') then raise exception 'Unknown product type'; end if;
  select * into pr from public.products where workspace_id = p_ws and sku = p_sku for update;
  if pr.sku is null then raise exception 'Product not found'; end if;
  if p_kind = 'bundle' and exists (select 1 from public.product_parts where workspace_id = p_ws and part_sku = p_sku) then
    raise exception 'This product is a part of another set / product, so it can not be a set itself';
  end if;
  delete from public.product_parts where workspace_id = p_ws and parent_sku = p_sku;
  if p_kind in ('bundle', 'made') then
    if jsonb_typeof(p_parts) <> 'array' then raise exception 'Add the parts'; end if;
    for r in select x.sku, sum(x.qty) qty from jsonb_to_recordset(p_parts) x(sku text, qty numeric) where coalesce(x.qty, 0) > 0 and coalesce(x.sku, '') <> '' group by x.sku loop
      if r.sku = p_sku then raise exception 'A product can not be a part of itself'; end if;
      if not exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku) then raise exception 'Part % not found', r.sku; end if;
      if exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku and kind = 'bundle') then raise exception '% is a set — add its parts instead', r.sku; end if;
      if exists (select 1 from public.product_parts where workspace_id = p_ws and parent_sku = r.sku and part_sku = p_sku) then raise exception '% is already made from this product', r.sku; end if;
      if p_kind = 'bundle' and r.qty <> trunc(r.qty) then raise exception 'A set needs whole numbers (1, 2, 3…)'; end if;
      insert into public.product_parts (workspace_id, parent_sku, part_sku, qty) values (p_ws, p_sku, r.sku, r.qty);
      n := n + 1;
    end loop;
    if n = 0 then raise exception 'Add at least one part'; end if;
  end if;
  if p_kind = 'bundle' and pr.kind <> 'bundle' and pr.stock <> 0 then     -- a set's stock comes from its parts: clear its own number
    perform set_config('nodevers.stockmove', '1', true);
    update public.products set stock = 0 where workspace_id = p_ws and sku = p_sku;
    perform set_config('nodevers.stockmove', '', true);
    delete from public.stock_levels where workspace_id = p_ws and sku = p_sku;
    insert into public.stock_moves (workspace_id, sku, change, stock_after, reason, by_name, note) values (p_ws, p_sku, -pr.stock, 0, 'Adjusted', coalesce(auth.jwt() ->> 'email', ''), 'Became a set — stock now comes from its parts');
  end if;
  update public.products set kind = p_kind where workspace_id = p_ws and sku = p_sku and kind <> p_kind;
end $$;

create table if not exists public.production_runs (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code         text not null default '',
  sku          text not null,
  name         text not null default '',
  qty          integer not null check (qty > 0),
  location_id  bigint,
  unit_cost    numeric not null default 0,
  extra_cost   numeric not null default 0,       -- labour / polish / other per unit
  note         text not null default '' check (length(note) <= 300),
  by_name      text not null default '',
  at           timestamptz not null default now(),
  unique (workspace_id, code)
);
drop trigger if exists production_runs_code on public.production_runs;
create trigger production_runs_code before insert on public.production_runs for each row execute function public.set_code('MK', 'code');
create index if not exists production_runs_ws on public.production_runs (workspace_id, at desc);

create or replace function public.produce(p_ws uuid, p_sku text, p_qty int, p_loc bigint, p_extra numeric, p_note text, p_by text) returns text
language plpgsql security definer set search_path = public as $$
declare pr record; loc bigint; r record; need int; have int; short text := ''; mat numeric := 0; uc numeric; rid bigint; c text;
begin
  perform public.inv_guard(p_ws);
  select * into pr from public.products where workspace_id = p_ws and sku = p_sku for update;
  if pr.sku is null then raise exception 'Product not found'; end if;
  if pr.kind <> 'made' then raise exception 'Set this product''s type to "Made by us" and add its parts first'; end if;
  if coalesce(p_qty, 0) < 1 or p_qty > 100000 then raise exception 'How many did you make?'; end if;
  loc := coalesce(p_loc, public.loc_default(p_ws));
  if loc is not null and not exists (select 1 from public.stock_locations where id = loc and workspace_id = p_ws) then raise exception 'Location not found'; end if;
  if not exists (select 1 from public.product_parts where workspace_id = p_ws and parent_sku = p_sku) then raise exception 'Add the parts it is made from first'; end if;
  for r in select pp.part_sku, pp.qty, p.name, p.stock, coalesce(p.cost, 0) cost, p.unit from public.product_parts pp join public.products p on p.workspace_id = pp.workspace_id and p.sku = pp.part_sku
            where pp.workspace_id = p_ws and pp.parent_sku = p_sku loop
    need := ceil(r.qty * p_qty)::int;
    have := case when loc is null then r.stock else coalesce((select qty from public.stock_levels where workspace_id = p_ws and sku = r.part_sku and location_id = loc), 0) end;
    if have < need then short := short || case when short = '' then '' else ', ' end || coalesce(nullif(r.name, ''), r.part_sku) || ' (need ' || need || ', have ' || have || ')'; end if;
    mat := mat + need * r.cost;
  end loop;
  if short <> '' then raise exception 'Not enough: %', short; end if;
  uc := round((mat + greatest(coalesce(p_extra, 0), 0) * p_qty) / p_qty, 2);
  insert into public.production_runs (workspace_id, sku, name, qty, location_id, unit_cost, extra_cost, note, by_name)
  values (p_ws, p_sku, pr.name, p_qty, loc, uc, greatest(coalesce(p_extra, 0), 0), left(coalesce(p_note, ''), 300), left(coalesce(p_by, ''), 80)) returning id, code into rid, c;
  for r in select part_sku, qty from public.product_parts where workspace_id = p_ws and parent_sku = p_sku loop
    perform public.stock_apply_at(p_ws, r.part_sku, -ceil(r.qty * p_qty)::int, 'Used to make', '', c, p_by, loc, left(p_qty || ' × ' || coalesce(nullif(pr.name, ''), p_sku), 200));
  end loop;
  update public.products set cost = case when coalesce(pr.cost, 0) = 0 or pr.stock <= 0 then uc else round((pr.stock * pr.cost + p_qty * uc) / (pr.stock + p_qty), 2) end where workspace_id = p_ws and sku = p_sku;
  perform public.stock_apply_at(p_ws, p_sku, p_qty, 'Made', '', c, p_by, loc, '');
  return c;
end $$;

-- ---------- 11. stock counts, scan-in, damaged / lost ----------
create table if not exists public.stock_counts (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code         text not null default '',
  location_id  bigint,
  location_name text not null default '',
  items        integer not null default 0,
  diff_units   integer not null default 0,
  diff_value   numeric not null default 0,
  lines        jsonb not null default '[]'::jsonb,       -- [{sku, name, expected, counted}]
  note         text not null default '' check (length(note) <= 300),
  by_name      text not null default '',
  at           timestamptz not null default now(),
  unique (workspace_id, code)
);
drop trigger if exists stock_counts_code on public.stock_counts;
create trigger stock_counts_code before insert on public.stock_counts for each row execute function public.set_code('CNT', 'code');
create index if not exists stock_counts_ws on public.stock_counts (workspace_id, at desc);

create or replace function public.count_apply(p_ws uuid, p_loc bigint, p_lines jsonb, p_note text, p_by text) returns text
language plpgsql security definer set search_path = public as $$
declare loc bigint; lname text := ''; cid bigint; c text; r record; v_exp int; v_out jsonb := '[]'::jsonb; n int := 0; du int := 0; dv numeric := 0;
begin
  perform public.inv_guard(p_ws);
  loc := coalesce(p_loc, public.loc_default(p_ws));
  if loc is not null then select name into lname from public.stock_locations where id = loc and workspace_id = p_ws; if lname is null then raise exception 'Location not found'; end if; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Count at least one product'; end if;
  insert into public.stock_counts (workspace_id, location_id, location_name, note, by_name) values (p_ws, loc, coalesce(lname, ''), left(coalesce(p_note, ''), 300), left(coalesce(p_by, ''), 80)) returning id, code into cid, c;
  for r in select x.sku, max(x.counted)::int counted from jsonb_to_recordset(p_lines) x(sku text, counted int) where x.counted is not null and x.counted >= 0 group by x.sku loop
    if not exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku and kind <> 'bundle') then continue; end if;
    v_exp := case when loc is null then (select stock from public.products where workspace_id = p_ws and sku = r.sku)
                else coalesce((select qty from public.stock_levels where workspace_id = p_ws and sku = r.sku and location_id = loc), 0) end;
    if r.counted <> v_exp then perform public.stock_apply_at(p_ws, r.sku, r.counted - v_exp, 'Count adjustment', '', c, p_by, loc, ''); end if;
    v_out := v_out || jsonb_build_object('sku', r.sku, 'name', (select name from public.products where workspace_id = p_ws and sku = r.sku), 'expected', v_exp, 'counted', r.counted);
    n := n + 1; du := du + (r.counted - v_exp); dv := dv + (r.counted - v_exp) * coalesce((select cost from public.products where workspace_id = p_ws and sku = r.sku), 0);
  end loop;
  if n = 0 then raise exception 'Count at least one product'; end if;
  update public.stock_counts set lines = v_out, items = n, diff_units = du, diff_value = round(dv, 2) where id = cid;
  return c;
end $$;

-- several products at once: {sku, change} adds / removes, {sku, set} sets the number at that place
create or replace function public.stock_adjust(p_ws uuid, p_loc bigint, p_lines jsonb, p_reason text, p_note text, p_by text) returns int
language plpgsql security definer set search_path = public as $$
declare loc bigint; r record; cur int; d int; n int := 0; why text;
begin
  perform public.inv_guard(p_ws);
  if p_reason not in ('Stock in', 'Adjusted', 'Damaged / lost', 'Returned to supplier') then raise exception 'Unknown reason'; end if;
  loc := coalesce(p_loc, public.loc_default(p_ws));
  if loc is not null and not exists (select 1 from public.stock_locations where id = loc and workspace_id = p_ws) then raise exception 'Location not found'; end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Nothing to change'; end if;
  for r in select x.sku, x.change, x."set" setq from jsonb_to_recordset(p_lines) x(sku text, change int, "set" int) loop
    if not exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku) then raise exception 'Product % not found', r.sku; end if;
    if exists (select 1 from public.products where workspace_id = p_ws and sku = r.sku and kind = 'bundle') then raise exception '% is a set — change its parts instead', r.sku; end if;
    if r.setq is not null then
      cur := case when loc is null then (select stock from public.products where workspace_id = p_ws and sku = r.sku)
                  else coalesce((select qty from public.stock_levels where workspace_id = p_ws and sku = r.sku and location_id = loc), 0) end;
      d := r.setq - cur;
    else d := coalesce(r.change, 0);
    end if;
    if d = 0 then continue; end if;
    why := case when p_reason = 'Stock in' and d < 0 then 'Adjusted' when p_reason = 'Adjusted' and d > 0 and r.setq is not null then 'Stock in' else p_reason end;
    perform public.stock_apply_at(p_ws, r.sku, d, why, '', '', p_by, loc, p_note);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- 12. automatic reorder point: sales speed × (supplier days + safety days) ----------
create or replace function public.reorder_refresh(p_ws uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; safety int := 7; boost numeric := 0; n int;
begin
  if auth.uid() is not null then perform public.inv_guard(p_ws); end if;
  begin
    select value::jsonb into cfg from public.settings where workspace_id = p_ws and key = 'invJson';
    safety := greatest(0, least(365, coalesce((cfg ->> 'safety')::int, 7)));
    boost := greatest(0, least(300, coalesce((cfg ->> 'boost')::numeric, 0)));
  exception when others then safety := 7; boost := 0;
  end;
  with sales as (
    select coalesce(pp.part_sku, o.sku) sku, o.order_date d, greatest(coalesce(o.qty, 1), 0) * coalesce(pp.qty, 1) u
      from public.orders o
      left join public.products b on b.workspace_id = o.workspace_id and b.sku = o.sku and b.kind = 'bundle'
      left join public.product_parts pp on pp.workspace_id = o.workspace_id and pp.parent_sku = b.sku
     where o.workspace_id = p_ws and coalesce(o.sku, '') <> '' and o.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned')
       and o.order_date >= (now() at time zone 'Asia/Kolkata')::date - 89
    union all
    select m.sku, (m.at at time zone 'Asia/Kolkata')::date, -m.change from public.stock_moves m
     where m.workspace_id = p_ws and m.reason = 'Used to make' and m.at >= now() - interval '90 days'
  ), vel as (
    select sku, coalesce(sum(u) filter (where d >= (now() at time zone 'Asia/Kolkata')::date - 29), 0) / 30.0 v30, sum(u) / 90.0 v90 from sales group by sku
  ), calc as (
    select p.sku, ceil((0.7 * v.v30 + 0.3 * v.v90) * (1 + boost / 100) * (coalesce(p.lead_days, s.lead_days, 7) + coalesce(p.safety_days, safety)))::int pt
      from public.products p join vel v on v.sku = p.sku left join public.suppliers s on s.id = p.supplier_id
     where p.workspace_id = p_ws and p.reorder_auto and p.kind <> 'bundle' and (v.v30 + v.v90) > 0
  )
  update public.products p set reorder_level = c.pt from calc c where p.workspace_id = p_ws and p.sku = c.sku and p.reorder_level <> c.pt;
  get diagnostics n = row_count;
  return n;
end $$;

-- once a day for every workspace that uses it (from the 15-minute tick)
create or replace function public.nodevers_tick() returns void
language plpgsql security definer set search_path = public as $$
declare u text; k text; today text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'); w uuid;
begin
  begin perform public.remarket_scan(); exception when others then raise notice 'remarket scan: %', sqlerrm; end;
  begin
    if coalesce((select value from public.app_config where key = 'reorder_day'), '') <> today then
      insert into public.app_config (key, value) values ('reorder_day', today) on conflict (key) do update set value = excluded.value;
      for w in select distinct workspace_id from public.products where reorder_auto loop
        begin perform public.reorder_refresh(w); exception when others then raise notice 'reorder %: %', w, sqlerrm; end;
      end loop;
    end if;
  exception when others then raise notice 'reorder: %', sqlerrm; end;
  select value into u from public.app_config where key = 'functions_url';
  select value into k from public.app_config where key = 'cron_secret';
  if u is null then return; end if;
  perform net.http_post(url := u || '/store-sync', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
  perform net.http_post(url := u || '/alerts', headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', k), body := '{"action":"cron"}'::jsonb);
end $$;
revoke execute on function public.nodevers_tick() from public, anon, authenticated;

-- ---------- 13. read access + who may call what ----------
do $$
declare t text;
begin
  foreach t in array array['stock_transfers', 'stock_transfer_lines', 'purchase_orders', 'po_lines', 'grns', 'grn_lines', 'production_runs', 'stock_counts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_member(workspace_id))', t || '_select', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

do $$
declare f text;
begin
  foreach f in array array['loc_save(uuid, bigint, text, text, text, boolean, boolean)', 'loc_delete(uuid, bigint)', 'transfer_create(uuid, bigint, bigint, jsonb, text, text, boolean)',
    'transfer_receive(uuid, bigint, text)', 'transfer_cancel(uuid, bigint, text)', 'po_save(uuid, bigint, jsonb)', 'po_status(uuid, bigint, text)', 'po_delete(uuid, bigint)',
    'po_receive(uuid, bigint, bigint, jsonb, text, text, text)', 'parts_save(uuid, text, text, jsonb)', 'produce(uuid, text, int, bigint, numeric, text, text)',
    'count_apply(uuid, bigint, jsonb, text, text)', 'stock_adjust(uuid, bigint, jsonb, text, text, text)', 'reorder_refresh(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
