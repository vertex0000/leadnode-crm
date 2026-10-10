-- Nodevers 32 — stock accuracy for every e-com brand
--   1. Returns / RTO: a parcel coming back stays OUT of stock ("return on the way") until it is checked —
--      Good = back on the shelf, Damaged / Missing = written off. (Before: it went back to the shelf at once.)
--   2. Deleting an order also puts back a damaged / missing return it wrote off + a one-time repair for orders already deleted.
--   3. Stock count: "expected" = ON HAND (available + units in orders not shipped yet) — so a reserved piece is never counted twice.
--   4. New stock-out reason "Sent to Amazon FBA" (not a loss — the units now sit at Amazon).
--   5. Low-stock alerts only when stock goes DOWN to the reorder level (receiving goods no longer sends alerts);
--      new products start with reorder level 0 = no low-stock alert until you set one.
--   6. An order a store already counted (stock_skip) is never switched back by a sync — no double stock change.
--   7. Fix: re-importing / re-syncing an order that is already here no longer takes its stock again
--      (Postgres runs BEFORE INSERT triggers even when an upsert turns into an update).
-- Old orders are not changed: returns already back on the shelf stay as they are.
-- Safe to run more than once. Needs 01–31 first.

-- ---------- 1 + 2 + 6. orders → stock ----------
create or replace function public.orders_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare want int := 0; wsku text := ''; wloc bigint; old_taken int := 0; old_sku text := ''; old_loc bigint; auto boolean; ref text; who text;
begin
  if tg_op = 'DELETE' then
    ref := coalesce(nullif(old.ext_id, ''), old.order_id); who := coalesce(auth.jwt() ->> 'email', '');
    if old.stock_taken > 0 and old.stock_sku <> '' then
      perform public.stock_apply_at(old.workspace_id, old.stock_sku, old.stock_taken, 'Order deleted', old.channel, ref, who, old.stock_loc, '');
    end if;
    if coalesce(old.ret_off, 0) > 0 and coalesce(old.sku, '') <> '' then      -- the damaged / missing return it wrote off comes back too
      perform public.stock_apply_at(old.workspace_id, old.sku, old.ret_off, 'Order deleted', old.channel, ref, who, null, 'Damaged / missing return of a deleted order');
    end if;
    return old;
  end if;
  -- Postgres runs BEFORE INSERT triggers even for a row that then becomes an UPDATE (upsert) or is skipped (on conflict do nothing).
  -- So an order that is already here must not take stock on the INSERT step — the UPDATE step (if any) does the stock work.
  if tg_op = 'INSERT' and coalesce(new.ext_id, '') <> '' and exists (select 1 from public.orders x where x.workspace_id = new.workspace_id and x.channel is not distinct from new.channel and x.ext_id = new.ext_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.stock_skip, false) and not coalesce(new.stock_skip, false) and auth.uid() is null then
    new.stock_skip := true;                                    -- a store sync never un-skips an order the store already counted
  end if;
  auto := coalesce((select value from public.settings where workspace_id = new.workspace_id and key = 'stockAuto'), 'on') <> 'off';
  if auto and not coalesce(new.stock_skip, false) and coalesce(new.sku, '') <> '' and new.status not in ('Cart', 'Cancelled', 'Refunded', 'RTO', 'Returned')
     and exists (select 1 from public.products where workspace_id = new.workspace_id and sku = new.sku) then
    want := greatest(coalesce(new.qty, 1), 0); wsku := new.sku;
  end if;
  if tg_op = 'UPDATE' then old_taken := coalesce(old.stock_taken, 0); old_sku := coalesce(old.stock_sku, ''); old_loc := old.stock_loc; end if;
  if want > 0 then
    select id into wloc from public.stock_locations where id = new.location_id and workspace_id = new.workspace_id;
    if wloc is null and old_taken > 0 then wloc := old_loc; end if;
    if wloc is null then wloc := public.loc_default(new.workspace_id); end if;
  end if;
  if not auto and tg_op = 'UPDATE' then want := old_taken; wsku := old_sku; wloc := old_loc; end if;
  -- return / RTO not checked yet → the units stay out of stock (on the way back); Good puts them back, Damaged / Missing writes them off
  if auto and tg_op = 'UPDATE' and old_taken > 0 and new.status in ('RTO', 'Returned') and coalesce(new.return_condition, '') = '' then
    want := old_taken; wsku := old_sku; wloc := old_loc;
  end if;
  if want = 0 and wsku = '' then wsku := old_sku; end if;
  ref := coalesce(nullif(new.ext_id, ''), new.order_id); who := coalesce(nullif(auth.jwt() ->> 'email', ''), nullif(new.source, ''), 'System');
  if old_taken > 0 and want > 0 and (old_sku <> wsku or old_loc is distinct from wloc) then
    perform public.stock_apply_at(new.workspace_id, old_sku, old_taken, 'Order changed', new.channel, ref, who, old_loc, '');
    perform public.stock_apply_at(new.workspace_id, wsku, -want, case when old_sku <> wsku then 'Sold' else 'Order changed' end, new.channel, ref, who, wloc, '');
  elsif want <> old_taken then
    if want = 0 then perform public.stock_apply_at(new.workspace_id, old_sku, old_taken, 'Order cancelled / returned', new.channel, ref, who, old_loc, case when new.status in ('RTO', 'Returned') and new.return_condition = 'good' then 'Return checked — good' else '' end);
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

-- ---------- 1b. return damaged / missing → out of stock: same upsert guard (rest unchanged from 27) ----------
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
  if ins and coalesce(new.ext_id, '') <> '' and exists (select 1 from public.orders x where x.workspace_id = new.workspace_id and x.channel is not distinct from new.channel and x.ext_id = new.ext_id) then
    return new;                                                 -- an upsert of an order that is already here: the UPDATE part does the stock work (SQL 32)
  end if;
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

-- one-time repair: damaged / missing returns written off for orders that were deleted before this update
do $$
declare r record;
begin
  if exists (select 1 from public.nv_migrations where key = 'v32_retoff_repair') then return; end if;
  for r in
    select m.workspace_id, m.sku, m.order_id, -sum(m.change)::int back
      from public.stock_moves m
     where m.reason in ('Return damaged', 'Return missing', 'Return condition changed') and m.order_id <> ''
       and not exists (select 1 from public.orders o where o.workspace_id = m.workspace_id and (o.ext_id = m.order_id or o.order_id = m.order_id))
       and exists (select 1 from public.products p where p.workspace_id = m.workspace_id and p.sku = m.sku)
     group by m.workspace_id, m.sku, m.order_id
    having sum(m.change) < 0
  loop
    perform public.stock_apply_at(r.workspace_id, r.sku, r.back, 'Order deleted', '', r.order_id, 'System', null, 'Repair: damaged / missing return of a deleted order');
  end loop;
  insert into public.nv_migrations (key) values ('v32_retoff_repair') on conflict do nothing;
end $$;

-- ---------- 3. stock count: expected = on hand ----------
-- units in orders that took stock but are not shipped yet (sets count their parts), at one place or everywhere
create or replace function public.stock_reserved(p_ws uuid, p_sku text, p_loc bigint) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(o.stock_taken * coalesce(ceil(pp.qty), 1)), 0)::int
    from public.orders o
    left join public.product_parts pp on pp.workspace_id = o.workspace_id and pp.parent_sku = o.stock_sku and pp.part_sku = p_sku
   where o.workspace_id = p_ws and o.stock_taken > 0 and o.status in ('New', 'Processing', 'Confirmed', 'Paid', 'COD')
     and (o.stock_sku = p_sku or pp.part_sku is not null)
     and (p_loc is null or o.stock_loc = p_loc);
$$;
revoke execute on function public.stock_reserved(uuid, text, bigint) from public, anon, authenticated;

create or replace function public.count_apply(p_ws uuid, p_loc bigint, p_lines jsonb, p_note text, p_by text) returns text
language plpgsql security definer set search_path = public as $$
declare loc bigint; lname text := ''; cid bigint; c text; r record; v_exp int; v_res int; v_out jsonb := '[]'::jsonb; n int := 0; du int := 0; dv numeric := 0;
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
    v_res := public.stock_reserved(p_ws, r.sku, loc);           -- packed for orders but still on the shelf → part of what you count
    v_exp := v_exp + v_res;
    if r.counted <> v_exp then perform public.stock_apply_at(p_ws, r.sku, r.counted - v_exp, 'Count adjustment', '', c, p_by, loc, ''); end if;
    v_out := v_out || jsonb_build_object('sku', r.sku, 'name', (select name from public.products where workspace_id = p_ws and sku = r.sku), 'expected', v_exp, 'reserved', v_res, 'counted', r.counted);
    n := n + 1; du := du + (r.counted - v_exp); dv := dv + (r.counted - v_exp) * coalesce((select cost from public.products where workspace_id = p_ws and sku = r.sku), 0);
  end loop;
  if n = 0 then raise exception 'Count at least one product'; end if;
  update public.stock_counts set lines = v_out, items = n, diff_units = du, diff_value = round(dv, 2) where id = cid;
  return c;
end $$;

-- ---------- 4. stock out: "Sent to Amazon FBA" ----------
create or replace function public.stock_adjust(p_ws uuid, p_loc bigint, p_lines jsonb, p_reason text, p_note text, p_by text) returns int
language plpgsql security definer set search_path = public as $$
declare loc bigint; r record; cur int; d int; n int := 0; why text;
begin
  perform public.inv_guard(p_ws);
  if p_reason not in ('Stock in', 'Adjusted', 'Damaged / lost', 'Returned to supplier', 'Sample / gift', 'Expired / written off', 'Sent to Amazon FBA') then raise exception 'Unknown reason'; end if;
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
    if p_reason = 'Sent to Amazon FBA' and d > 0 then raise exception 'Sent to Amazon FBA takes units out — use a positive number of pieces sent'; end if;
    why := case when p_reason = 'Stock in' and d < 0 then 'Adjusted' when p_reason = 'Adjusted' and d > 0 and r.setq is not null then 'Stock in' else p_reason end;
    perform public.stock_apply_at(p_ws, r.sku, d, why, '', '', p_by, loc, p_note);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- 5. reorder level + low-stock alerts ----------
alter table public.products alter column reorder_level set default 0;

create or replace function public.alert_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'UPDATE' then return new; end if;                                   -- a new product never sends an alert
  if not new.active or coalesce(new.kind, 'simple') = 'bundle' then return new; end if;
  if new.stock >= old.stock then return new; end if;                              -- only when stock goes DOWN (sales, write-offs) — never on receiving goods
  if not exists (select 1 from public.settings s where s.workspace_id = new.workspace_id and s.key = 'storeAlertsJson') then return new; end if;
  if new.stock <= 0 and old.stock > 0 then
    insert into public.alert_queue (workspace_id, kind, ref, payload) values (new.workspace_id, 'out_stock', new.sku, jsonb_build_object('sku', new.sku, 'name', new.name, 'stock', new.stock)) on conflict do nothing;
  elsif new.reorder_level > 0 and new.stock > 0 and new.stock <= new.reorder_level and old.stock > new.reorder_level then
    insert into public.alert_queue (workspace_id, kind, ref, payload) values (new.workspace_id, 'low_stock', new.sku, jsonb_build_object('sku', new.sku, 'name', new.name, 'stock', new.stock, 'reorder', new.reorder_level)) on conflict do nothing;
  end if;
  return new;
exception when others then return new;
end $$;

create or replace function public.v32_ready() returns boolean language sql stable as $$ select true $$;
revoke execute on function public.alert_stock(), public.v32_ready() from public, anon;
grant execute on function public.v32_ready() to authenticated;
