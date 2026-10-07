-- Nodevers 27 — exact e-commerce profit + Finance
-- 1) Orders get every money field: shipping charged to the customer, platform / seller discount, refunds, COD charge,
--    GST (output) + GST inside platform fees (input credit), return condition (good / damaged / missing), claims, TCS / TDS.
-- 2) Cost rules per sales channel (Store → Cost rules, settings key costRulesJson) fill fees, shipping, packaging, RTO / return
--    and COD charges the store did not send. Filled numbers are marked as estimates (est_fields) until a report brings the real one;
--    a store sync never wipes a real number.
-- 3) Net profit (orders.net_profit) uses all of it.
-- 4) Products: packaging cost per piece, GST %, HSN. Purchase orders: landed cost (transport share + GST when not GST-registered).
--    Stock moves keep the cost at that moment (samples, write-offs and count losses get a ₹ value).
-- 5) Finance (new section, owner / admin + members with the "Finance" switch): expenses, other charges & income,
--    marketplace payouts, COD remittance, purchase bills. Plan section "finance" (off for Starter by default).
-- Safe to run more than once. Needs 25_inventory.sql and 26_flipkart_meesho.sql first.

-- ---------- 1. new columns ----------
alter table public.orders add column if not exists shipping_income   numeric check (shipping_income is null or shipping_income >= 0);     -- shipping the customer paid
alter table public.orders add column if not exists platform_discount numeric check (platform_discount is null or platform_discount >= 0); -- discount the marketplace pays for
alter table public.orders add column if not exists seller_discount   numeric check (seller_discount is null or seller_discount >= 0);     -- your own discount (already out of the amount)
alter table public.orders add column if not exists refund_amount     numeric check (refund_amount is null or refund_amount >= 0);         -- part refund, item kept
alter table public.orders add column if not exists cod_charge        numeric check (cod_charge is null or cod_charge >= 0);
alter table public.orders add column if not exists gst_pct           numeric check (gst_pct is null or gst_pct between 0 and 40);
alter table public.orders add column if not exists gst_amount        numeric;                                    -- output GST on this order
alter table public.orders add column if not exists gst_incl          boolean not null default true;              -- the amount already includes it
alter table public.orders add column if not exists fee_gst           numeric;                                    -- GST inside the platform fee (claimed back)
alter table public.orders add column if not exists return_condition  text not null default '' check (return_condition in ('', 'good', 'damaged', 'missing'));
alter table public.orders add column if not exists return_received_on date;
alter table public.orders add column if not exists claim_status      text not null default '' check (claim_status in ('', 'filed', 'approved', 'rejected', 'paid'));
alter table public.orders add column if not exists claim_amount      numeric check (claim_amount is null or claim_amount >= 0);
alter table public.orders add column if not exists tcs               numeric check (tcs is null or tcs >= 0);
alter table public.orders add column if not exists tds               numeric check (tds is null or tds >= 0);
alter table public.orders add column if not exists est_fields        text[] not null default '{}';
alter table public.orders add column if not exists delivered_at      timestamptz;
alter table public.orders add column if not exists ret_off           integer not null default 0;                -- units taken out of stock because the return was damaged / missing

alter table public.products add column if not exists packaging_cost numeric check (packaging_cost is null or packaging_cost >= 0);   -- per piece
alter table public.products add column if not exists gst_pct        numeric check (gst_pct is null or gst_pct between 0 and 40);
alter table public.products add column if not exists hsn            text not null default '' check (length(hsn) <= 12);

alter table public.stock_moves add column if not exists unit_cost numeric;
alter table public.grn_lines   add column if not exists landed_cost numeric;
alter table public.grns        add column if not exists damaged_value numeric not null default 0;

create table if not exists public.nv_migrations (key text primary key, at timestamptz not null default now());
revoke all on public.nv_migrations from anon, authenticated;

-- ---------- 2. cost rules ----------
create or replace function public.cost_rules(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v text; j jsonb;
begin
  select value into v from public.settings where workspace_id = p_ws and key = 'costRulesJson';
  begin j := coalesce(nullif(v, '')::jsonb, '{}'::jsonb); exception when others then j := '{}'::jsonb; end;
  if jsonb_typeof(j) <> 'object' then j := '{}'::jsonb; end if;
  return j;
end $$;
revoke execute on function public.cost_rules(uuid) from public, anon, authenticated;

create or replace function public.jn(j jsonb, k text) returns numeric
language plpgsql immutable as $$
begin return greatest(0, coalesce((j ->> k)::numeric, 0)); exception when others then return 0; end $$;

-- typed / imported numbers win; empty or estimated numbers follow the rules; a server sync never wipes a real number
create or replace function public.cost_pick(p_ins boolean, p_new numeric, p_old numeric, p_est boolean, p_want numeric, p_server boolean, out val numeric, out est boolean)
language plpgsql immutable as $$
begin
  if p_ins then
    if p_new is not null then val := p_new; est := false; else val := p_want; est := p_want is not null; end if;
    return;
  end if;
  if p_new is not null and p_new is distinct from p_old then val := p_new; est := false; return; end if;
  if p_new is null and p_old is not null and not p_est and p_server then val := p_old; est := false; return; end if;
  if p_new is not null and not p_est then val := p_new; est := false; return; end if;
  val := p_want; est := p_want is not null;
end $$;

create or replace function public.orders_zcost() returns trigger
language plpgsql security definer set search_path = public as $$
declare j jsonb; r jsonb; g jsonb; ch text; st text := new.status; cod boolean; shipped boolean; amt numeric := coalesce(new.amount, 0); q int := greatest(coalesce(new.qty, 1), 1);
  pr record; ins boolean := tg_op = 'INSERT'; srv boolean; est text[] := '{}'; oe text[] := '{}'; p record; pct numeric;
  w_fee numeric; w_ship numeric; w_pack numeric; w_rto numeric; w_cod numeric; gst_on boolean; incl boolean; gp numeric; base numeric;
  want_off int := 0; auto boolean; ref text;
begin
  srv := auth.uid() is null and coalesce(current_setting('nodevers.costmig', true), '') <> '1';
  if not ins then oe := coalesce(old.est_fields, '{}'); end if;
  if new.status = 'Delivered' and new.delivered_at is null then new.delivered_at := now(); end if;
  begin
    j := public.cost_rules(new.workspace_id);
    ch := case when coalesce(new.channel, '') = '' then 'WhatsApp' when new.channel in ('Amazon', 'Flipkart', 'Meesho', 'Website', 'WhatsApp', 'Direct') then new.channel else 'Other' end;
    r := coalesce(j -> 'ch' -> ch, '{}'::jsonb); if jsonb_typeof(r) <> 'object' then r := '{}'::jsonb; end if;
    g := coalesce(j -> 'gst', '{}'::jsonb); if jsonb_typeof(g) <> 'object' then g := '{}'::jsonb; end if;
    select packaging_cost, gst_pct into pr from public.products where workspace_id = new.workspace_id and sku = coalesce(new.sku, '') and coalesce(new.sku, '') <> '';
    cod := st = 'COD' or coalesce(new.payment, '') ~* '(^|\W)(cod|cash)';
    shipped := st not in ('Cart', 'Cancelled');
    pct := public.jn(r, 'feePct');
    if pct = 0 and ch = 'Flipkart' then
      begin select greatest(0, least(60, coalesce((config ->> 'fee_pct')::numeric, 0))) into pct from public.store_connections where workspace_id = new.workspace_id and platform = 'flipkart' limit 1;
      exception when others then pct := 0; end;
      pct := coalesce(pct, 0);
    end if;
    w_fee := case when not shipped then null
      when st in ('RTO', 'Returned', 'Refunded') then nullif(public.jn(r, 'feeFix'), 0)
      when coalesce((r ->> 'prepaidOnly')::boolean, false) and cod then nullif(public.jn(r, 'feeFix'), 0)
      else nullif(round(amt * pct / 100 + public.jn(r, 'feeFix'), 2), 0) end;
    w_ship := case when shipped then nullif(public.jn(r, 'ship'), 0) end;
    w_pack := case when shipped then nullif(coalesce(case when pr.packaging_cost is not null then pr.packaging_cost * q end, public.jn(r, 'pack')), 0) end;
    w_rto := case st when 'RTO' then nullif(public.jn(r, 'rto'), 0) when 'Returned' then nullif(public.jn(r, 'ret'), 0) when 'Exchange' then nullif(public.jn(r, 'ret') + public.jn(r, 'ship'), 0) end;
    w_cod := case when cod and st not in ('Cart', 'Cancelled', 'RTO', 'Returned', 'Refunded') then nullif(round(public.jn(r, 'codFee') + amt * public.jn(r, 'codPct') / 100, 2), 0) end;

    p := public.cost_pick(ins, new.marketplace_fee, case when ins then null else old.marketplace_fee end, 'marketplace_fee' = any(oe), w_fee, srv); new.marketplace_fee := p.val; if p.est then est := est || 'marketplace_fee'::text; end if;
    p := public.cost_pick(ins, new.shipping_fee, case when ins then null else old.shipping_fee end, 'shipping_fee' = any(oe), w_ship, srv); new.shipping_fee := p.val; if p.est then est := est || 'shipping_fee'::text; end if;
    p := public.cost_pick(ins, new.packaging_cost, case when ins then null else old.packaging_cost end, 'packaging_cost' = any(oe), w_pack, srv); new.packaging_cost := p.val; if p.est then est := est || 'packaging_cost'::text; end if;
    p := public.cost_pick(ins, new.rto_charges, case when ins then null else old.rto_charges end, 'rto_charges' = any(oe), w_rto, srv); new.rto_charges := p.val; if p.est then est := est || 'rto_charges'::text; end if;
    p := public.cost_pick(ins, new.cod_charge, case when ins then null else old.cod_charge end, 'cod_charge' = any(oe), w_cod, srv); new.cod_charge := p.val; if p.est then est := est || 'cod_charge'::text; end if;
    new.est_fields := est;

    -- GST: output GST on the sale, GST inside the platform fee (claimed back)
    gst_on := coalesce((g ->> 'on')::boolean, false); incl := coalesce((g ->> 'incl')::boolean, true);
    if new.gst_pct is null and pr.gst_pct is not null then new.gst_pct := pr.gst_pct; end if;
    if gst_on then
      gp := coalesce(new.gst_pct, nullif(public.jn(g, 'rate'), 0), 18);
      base := amt + coalesce(new.shipping_income, 0) + coalesce(new.platform_discount, 0) - coalesce(new.refund_amount, 0);
      new.gst_amount := case when st in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') then 0 else round(case when incl then base * gp / (100 + gp) else base * gp / 100 end, 2) end;
      new.gst_incl := incl;
      new.fee_gst := case when coalesce((g ->> 'feesGst')::boolean, true) then round(coalesce(new.marketplace_fee, 0) * 18 / 118, 2) else 0 end;
    else new.gst_amount := 0; new.gst_incl := true; new.fee_gst := 0;
    end if;
  exception when others then null;     -- an estimate must never stop an order from saving
  end;

  -- return came back damaged / missing → those units do not go back to the shelf
  auto := coalesce((select value from public.settings where workspace_id = new.workspace_id and key = 'stockAuto'), 'on') <> 'off';
  if auto and coalesce(new.sku, '') <> '' and st in ('RTO', 'Returned', 'Refunded') and new.return_condition in ('damaged', 'missing') and coalesce(new.stock_taken, 0) = 0 and not coalesce(new.stock_skip, false) then
    want_off := q;
  end if;
  if want_off <> coalesce(new.ret_off, 0) and exists (select 1 from public.products where workspace_id = new.workspace_id and sku = new.sku) then
    ref := coalesce(nullif(new.ext_id, ''), new.order_id);
    perform public.stock_apply_at(new.workspace_id, new.sku, coalesce(new.ret_off, 0) - want_off,
      case when want_off = 0 then 'Return condition changed' when new.return_condition = 'missing' then 'Return missing' else 'Return damaged' end,
      new.channel, ref, coalesce(nullif(auth.jwt() ->> 'email', ''), 'System'), null, '');
    new.ret_off := want_off;
  elsif want_off <> coalesce(new.ret_off, 0) then new.ret_off := want_off;
  end if;
  return new;
end $$;
revoke execute on function public.orders_zcost() from public, anon, authenticated;
drop trigger if exists orders_zcost on public.orders;
create trigger orders_zcost before insert or update on public.orders for each row execute function public.orders_zcost();   -- runs after orders_fill (name order)

-- ---------- 3. net profit with every cost and income ----------
do $$
declare cur text;
begin
  select pg_get_expr(d.adbin, d.adrelid) into cur from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.orders'::regclass and a.attname = 'net_profit';
  if cur is null or cur not like '%claim_amount%' then
    alter table public.orders drop column if exists net_profit;
    alter table public.orders add column net_profit numeric generated always as (
      (case when status in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned') then 0
        else coalesce(amount, 0) + coalesce(shipping_income, 0) + coalesce(platform_discount, 0) - coalesce(refund_amount, 0) - coalesce(product_cost, 0)
             - case when gst_incl then coalesce(gst_amount, 0) else 0 end end)
      - (coalesce(marketplace_fee, 0) - coalesce(fee_gst, 0)) - coalesce(shipping_fee, 0) - coalesce(packaging_cost, 0) - coalesce(rto_charges, 0)
      - coalesce(cod_charge, 0) - coalesce(ad_spend, 0) - coalesce(other_cost, 0)
      - case when status in ('RTO', 'Returned', 'Refunded', 'Exchange') and return_condition in ('damaged', 'missing') then coalesce(product_cost, 0) else 0 end
      + case when claim_status in ('approved', 'paid') then coalesce(claim_amount, 0) else 0 end) stored;
  end if;
end $$;

-- re-apply the rules to recent orders (after the rules change) — estimates only, real numbers stay
create or replace function public.cost_rules_apply(p_ws uuid, p_days int default 120) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.can_write(p_ws) and public.has_perm(p_ws, 'commerce')) then raise exception 'You do not have edit rights for Store in this workspace'; end if;
  update public.orders set est_fields = est_fields
   where workspace_id = p_ws and coalesce(order_date, (created_at at time zone 'Asia/Kolkata')::date) >= (now() at time zone 'Asia/Kolkata')::date - greatest(1, least(coalesce(p_days, 120), 730));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.cost_rules_apply(uuid, int) from public, anon;
grant execute on function public.cost_rules_apply(uuid, int) to authenticated;

-- ---------- 4. stock: cost at the moment of every move, more write-off reasons, landed cost ----------
create or replace function public.stock_moves_cost() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.unit_cost is null then select cost into new.unit_cost from public.products where workspace_id = new.workspace_id and sku = new.sku; end if;
  return new;
end $$;
revoke execute on function public.stock_moves_cost() from public, anon, authenticated;
drop trigger if exists stock_moves_cost on public.stock_moves;
create trigger stock_moves_cost before insert on public.stock_moves for each row execute function public.stock_moves_cost();

create or replace function public.stock_adjust(p_ws uuid, p_loc bigint, p_lines jsonb, p_reason text, p_note text, p_by text) returns int
language plpgsql security definer set search_path = public as $$
declare loc bigint; r record; cur int; d int; n int := 0; why text;
begin
  perform public.inv_guard(p_ws);
  if p_reason not in ('Stock in', 'Adjusted', 'Damaged / lost', 'Returned to supplier', 'Sample / gift', 'Expired / written off') then raise exception 'Unknown reason'; end if;
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

create or replace function public.po_receive(p_ws uuid, p_po bigint, p_loc bigint, p_lines jsonb, p_invoice text, p_note text, p_by text) returns text
language plpgsql security definer set search_path = public as $$
declare po record; loc bigint; gid bigint; c text; r record; pl record; pr record; v_units int := 0; v_dmg int := 0; val numeric := 0; uc numeric;
  sub numeric; lc numeric; dval numeric := 0; gst_on boolean;
begin
  perform public.inv_guard(p_ws);
  select * into po from public.purchase_orders where id = p_po and workspace_id = p_ws for update;
  if po.id is null then raise exception 'Purchase order not found'; end if;
  if po.status not in ('draft', 'sent', 'partial') then raise exception 'This purchase order is %', po.status; end if;
  loc := coalesce(p_loc, po.location_id, public.loc_default(p_ws));
  if loc is not null and not exists (select 1 from public.stock_locations where id = loc and workspace_id = p_ws) then raise exception 'Location not found'; end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Nothing to receive'; end if;
  select sum(qty * unit_cost) into sub from public.po_lines where po_id = po.id;
  gst_on := coalesce((public.cost_rules(p_ws) -> 'gst' ->> 'on')::boolean, false);
  insert into public.grns (workspace_id, po_id, po_code, supplier_id, supplier_name, location_id, invoice_no, note, by_name)
  values (p_ws, po.id, po.code, po.supplier_id, po.supplier_name, loc, left(coalesce(p_invoice, ''), 60), left(coalesce(p_note, ''), 300), left(coalesce(p_by, ''), 80)) returning id, code into gid, c;
  for r in select x.sku, sum(greatest(coalesce(x.qty, 0), 0))::int qty, sum(greatest(coalesce(x.damaged, 0), 0))::int damaged, max(x."unitCost") ucost
             from jsonb_to_recordset(p_lines) x(sku text, qty int, damaged int, "unitCost" numeric) group by x.sku loop
    if r.qty + r.damaged = 0 then continue; end if;
    select * into pl from public.po_lines where po_id = po.id and sku = r.sku limit 1;
    if pl.id is null then raise exception '% is not on this purchase order', r.sku; end if;
    uc := coalesce(r.ucost, pl.unit_cost);
    if uc < 0 then raise exception 'Cost can not be below 0'; end if;
    -- landed cost = price (+ GST when you can not claim it back) + this unit's share of transport / loading (by value)
    lc := uc * (1 + case when gst_on then 0 else coalesce(po.tax_pct, 0) / 100 end)
          + case when coalesce(sub, 0) > 0 then coalesce(po.extra_cost, 0) * coalesce(pl.unit_cost, uc) / sub else 0 end;
    lc := round(lc, 2);
    select * into pr from public.products where workspace_id = p_ws and sku = r.sku for update;
    if pr.sku is null then raise exception 'Product % no longer exists', r.sku; end if;
    if r.qty > 0 and lc > 0 then
      update public.products set cost = case when coalesce(pr.cost, 0) = 0 or pr.stock <= 0 then lc
        else round((pr.stock * pr.cost + r.qty * lc) / (pr.stock + r.qty), 2) end where workspace_id = p_ws and sku = r.sku;
    end if;
    if r.qty > 0 then perform public.stock_apply_at(p_ws, r.sku, r.qty, 'Purchase received', '', po.code, p_by, loc, c || coalesce(' · ' || nullif(po.supplier_name, ''), '')); end if;
    update public.po_lines set qty_received = qty_received + r.qty where id = pl.id;
    insert into public.grn_lines (workspace_id, grn_id, sku, name, qty, damaged, unit_cost, landed_cost) values (p_ws, gid, r.sku, pr.name, r.qty, r.damaged, uc, lc);
    v_units := v_units + r.qty; v_dmg := v_dmg + r.damaged; val := val + r.qty * uc; dval := dval + r.damaged * lc;
  end loop;
  if v_units + v_dmg = 0 then raise exception 'Enter how many arrived'; end if;
  update public.grns set units = v_units, damaged = v_dmg, value = round(val, 2), damaged_value = round(dval, 2) where id = gid;
  update public.purchase_orders set
    status = case when not exists (select 1 from public.po_lines where po_id = po.id and qty_received < qty) then 'received' else 'partial' end,
    received_at = case when not exists (select 1 from public.po_lines where po_id = po.id and qty_received < qty) then now() else received_at end,
    sent_at = coalesce(sent_at, now())
  where id = po.id;
  return c;
end $$;

-- ---------- 5. Finance ----------
create or replace function public.fin_ok(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid())
    and (m.role in ('owner', 'admin') or (m.role = 'member' and coalesce((m.perms ->> 'finance')::boolean, false))));
$$;
create or replace function public.fin_w(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_write(ws) and public.ws_feature(ws, 'finance') and exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = (select auth.uid())
    and (m.role in ('owner', 'admin') or (m.role = 'member' and coalesce((m.perms ->> 'finance')::boolean, false))));
$$;
revoke execute on function public.fin_ok(uuid) from public, anon; grant execute on function public.fin_ok(uuid) to authenticated;
revoke execute on function public.fin_w(uuid) from public, anon; grant execute on function public.fin_w(uuid) to authenticated;

create table if not exists public.expenses (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  day          date not null default ((now() at time zone 'Asia/Kolkata')::date),
  category     text not null default 'Other' check (length(category) between 1 and 60),
  description  text not null default '' check (length(description) <= 200),
  amount       numeric not null check (amount >= 0),
  gst          numeric not null default 0 check (gst >= 0),
  paid_from    text not null default '' check (length(paid_from) <= 60),
  repeat       text not null default 'once' check (repeat in ('once', 'monthly')),
  until        date,                                                  -- monthly: last month it counts (empty = still running)
  channel      text not null default '' check (length(channel) <= 40),
  notes        text not null default '' check (length(notes) <= 500),
  ext_id       text not null default md5(random()::text || clock_timestamp()::text) check (length(ext_id) <= 200),   -- import key (same row imported again = updated)
  created_by   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table if not exists public.fin_entries (                     -- other charges & income that are not one order
  id           bigint generated always as identity primary key,
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  day          date not null default ((now() at time zone 'Asia/Kolkata')::date),
  channel      text not null default '' check (length(channel) <= 40),
  kind         text not null check (kind in ('storage', 'penalty', 'weight', 'subscription', 'removal', 'other_charge', 'claim', 'incentive', 'cashback', 'interest', 'other_income')),
  order_ref    text not null default '' check (length(order_ref) <= 80),
  amount       numeric not null check (amount >= 0),
  gst          numeric not null default 0 check (gst >= 0),
  notes        text not null default '' check (length(notes) <= 500),
  source       text not null default 'Team' check (length(source) <= 40),
  ext_id       text not null default md5(random()::text || clock_timestamp()::text) check (length(ext_id) <= 200),   -- import key (same row imported again = updated)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table if not exists public.payouts (                         -- money the marketplace really sent (or kept)
  id           bigint generated always as identity primary key,
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  payout_date  date not null default ((now() at time zone 'Asia/Kolkata')::date),
  channel      text not null default '' check (length(channel) <= 40),
  payout_ref   text not null default '' check (length(payout_ref) <= 80),     -- settlement id / UTR
  order_ref    text not null default '' check (length(order_ref) <= 80),
  kind         text not null default 'order' check (kind in ('order', 'refund', 'fee', 'shipping', 'ads', 'storage', 'penalty', 'claim', 'reserve', 'reserve_release', 'tcs', 'tds', 'other')),
  amount       numeric not null,                                               -- + money in, − money kept by the platform
  notes        text not null default '' check (length(notes) <= 300),
  ext_id       text not null default md5(random()::text || clock_timestamp()::text) check (length(ext_id) <= 200),   -- import key (same row imported again = updated)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table if not exists public.cod_remits (                      -- COD cash the courier paid you
  id           bigint generated always as identity primary key,
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  courier      text not null default '' check (length(courier) <= 60),
  awb          text not null default '' check (length(awb) <= 60),
  order_ref    text not null default '' check (length(order_ref) <= 80),
  cod_amount   numeric not null default 0 check (cod_amount >= 0),
  remitted_on  date,
  utr          text not null default '' check (length(utr) <= 80),
  deduction    numeric not null default 0 check (deduction >= 0),
  notes        text not null default '' check (length(notes) <= 300),
  ext_id       text not null default md5(random()::text || clock_timestamp()::text) check (length(ext_id) <= 200),   -- import key (same row imported again = updated)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table if not exists public.purchase_bills (                  -- supplier bills (GST input credit, landed cost)
  id           bigint generated always as identity primary key,
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  bill_date    date not null default ((now() at time zone 'Asia/Kolkata')::date),
  bill_no      text not null default '' check (length(bill_no) <= 60),
  supplier     text not null default '' check (length(supplier) <= 120),
  sku          text not null default '' check (length(sku) <= 80),
  name         text not null default '' check (length(name) <= 200),
  qty          numeric not null default 1 check (qty >= 0),
  unit_cost    numeric not null default 0 check (unit_cost >= 0),
  transport    numeric not null default 0 check (transport >= 0),
  gst_pct      numeric not null default 0 check (gst_pct between 0 and 40),
  notes        text not null default '' check (length(notes) <= 300),
  ext_id       text not null default md5(random()::text || clock_timestamp()::text) check (length(ext_id) <= 200),   -- import key (same row imported again = updated)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists expenses_ws_day on public.expenses (workspace_id, day);
create index if not exists fin_entries_ws_day on public.fin_entries (workspace_id, day);
create index if not exists payouts_ws_date on public.payouts (workspace_id, payout_date);
create index if not exists payouts_ws_order on public.payouts (workspace_id, order_ref);
create index if not exists cod_remits_ws on public.cod_remits (workspace_id, remitted_on);
create index if not exists purchase_bills_ws on public.purchase_bills (workspace_id, bill_date);
drop index if exists public.expenses_ext;
create unique index if not exists expenses_ext_key on public.expenses (workspace_id, ext_id);
drop index if exists public.fin_entries_ext;
create unique index if not exists fin_entries_ext_key on public.fin_entries (workspace_id, ext_id);
drop index if exists public.payouts_ext;
create unique index if not exists payouts_ext_key on public.payouts (workspace_id, ext_id);
drop index if exists public.cod_remits_ext;
create unique index if not exists cod_remits_ext_key on public.cod_remits (workspace_id, ext_id);
drop index if exists public.purchase_bills_ext;
create unique index if not exists purchase_bills_ext_key on public.purchase_bills (workspace_id, ext_id);

do $$
declare t text;
begin
  foreach t in array array['expenses', 'fin_entries', 'payouts', 'cod_remits', 'purchase_bills'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format('drop policy if exists %I on public.%I', t || '_wr', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.fin_ok(workspace_id))', t || '_sel', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.fin_w(workspace_id)) with check (public.fin_w(workspace_id))', t || '_wr', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.touch_updated()', t || '_touch', t);
  end loop;
end $$;

-- ---------- 6. plan section "Finance" (10th switch; Starter off by default) ----------
create or replace function public.feature_keys() returns text[]
language sql immutable as $$ select array['pipeline', 'tasks', 'orders', 'store', 'campaigns', 'automation', 'ads', 'insights', 'advisor', 'finance'] $$;
create or replace function public.feature_name(k text) returns text
language sql immutable as $$
  select case k when 'pipeline' then 'Pipeline' when 'tasks' then 'Tasks & Calls' when 'orders' then 'Orders' when 'store' then 'Store'
    when 'campaigns' then 'Campaigns' when 'automation' then 'Automation' when 'ads' then 'Ads Manager' when 'insights' then 'Insights' when 'advisor' then 'AI Advisor'
    when 'finance' then 'Finance' else k end $$;
update public.plans set sections = coalesce(sections, '{}'::jsonb) || '{"finance": false}'::jsonb where id = 'starter' and not (coalesce(sections, '{}'::jsonb) ? 'finance');

-- ---------- 7. one-time fixes for orders synced before this update ----------
do $$
begin
  if not exists (select 1 from public.nv_migrations where key = 'v27_shipping') then
    perform set_config('nodevers.costmig', '1', true);
    -- Shopify / WooCommerce sent the shipping the CUSTOMER paid as a cost — it is income
    update public.orders set shipping_income = shipping_fee, shipping_fee = null
     where source in ('Shopify', 'WooCommerce') and shipping_income is null and shipping_fee is not null;
    -- Flipkart's shipping charge is already inside the order total — the courier cost comes from the rules / settlement report
    update public.orders set shipping_fee = null where source = 'Flipkart API' and shipping_fee is not null;
    -- the Flipkart fee % from the connection becomes the Flipkart cost rule
    insert into public.settings (workspace_id, key, value)
    select c.workspace_id, 'costRulesJson', jsonb_build_object('ch', jsonb_build_object('Flipkart', jsonb_build_object('feePct', (c.config ->> 'fee_pct')::numeric)))::text
      from public.store_connections c where c.platform = 'flipkart' and coalesce((c.config ->> 'fee_pct')::numeric, 0) > 0
    on conflict (workspace_id, key) do nothing;
    perform set_config('nodevers.costmig', '', true);
    insert into public.nv_migrations (key) values ('v27_shipping');
  end if;
end $$;

create or replace function public.v27_ready() returns boolean language sql stable as $$ select true $$;
grant execute on function public.v27_ready() to authenticated;
