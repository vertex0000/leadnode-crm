-- Nodevers 30 — "Export for editing" products file: Undo also puts back the old values
-- An edit import (Products → Export for editing → fill → Import) only UPDATES products. It keeps the old values of every
-- changed cell in imports.before, so Undo import restores them (and still deletes rows an import created).
-- Safe to run more than once. Needs 29_bulk_imports.sql first.

alter table public.imports add column if not exists before jsonb;

create or replace function public.import_undo(p_ws uuid, p_id text) returns integer
language plpgsql security definer set search_path = public as $$
declare t text; n integer := 0; c integer; imp public.imports%rowtype; e jsonb;
begin
  if not public.can_write(p_ws) then raise exception 'Your access is view only'; end if;
  if not public.has_perm(p_ws, 'delete') then raise exception 'Your access does not include deleting — ask the owner'; end if;
  select * into imp from public.imports where workspace_id = p_ws and id = p_id;
  if imp.id is null then raise exception 'Import not found'; end if;
  if imp.undone_at is not null then raise exception 'This import was already undone'; end if;
  -- 1) rows the import created
  foreach t in array array['orders', 'leads', 'products', 'ad_spend', 'expenses', 'fin_entries', 'payouts', 'cod_remits', 'purchase_bills'] loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from public.%I where workspace_id = $1 and import_id = $2', t) using p_ws, p_id;
      get diagnostics c = row_count; n := n + c;
    end if;
  end loop;
  -- 2) product cells an edit file changed → old values back (only the cells it changed)
  if imp.before is not null and jsonb_typeof(imp.before -> 'products') = 'array' then
    for e in select x from jsonb_array_elements(imp.before -> 'products') x loop
      update public.products p set
        name           = case when e ? 'name' then coalesce(e ->> 'name', '') else p.name end,
        category       = case when e ? 'category' then coalesce(e ->> 'category', '') else p.category end,
        price          = case when e ? 'price' then nullif(e ->> 'price', '')::numeric else p.price end,
        cost           = case when e ? 'cost' then nullif(e ->> 'cost', '')::numeric else p.cost end,
        packaging_cost = case when e ? 'packaging_cost' then nullif(e ->> 'packaging_cost', '')::numeric else p.packaging_cost end,
        gst_pct        = case when e ? 'gst_pct' then nullif(e ->> 'gst_pct', '')::numeric else p.gst_pct end,
        hsn            = case when e ? 'hsn' then coalesce(e ->> 'hsn', '') else p.hsn end,
        reorder_level  = case when e ? 'reorder_level' then coalesce(nullif(e ->> 'reorder_level', '')::numeric::int, 0) else p.reorder_level end,
        moq            = case when e ? 'moq' then nullif(e ->> 'moq', '')::numeric::int else p.moq end,
        barcode        = case when e ? 'barcode' then coalesce(e ->> 'barcode', '') else p.barcode end,
        unit           = case when e ? 'unit' then coalesce(nullif(e ->> 'unit', ''), 'pcs') else p.unit end,
        image_url      = case when e ? 'image_url' then coalesce(e ->> 'image_url', '') else p.image_url end,
        amazon_asin    = case when e ? 'amazon_asin' then coalesce(e ->> 'amazon_asin', '') else p.amazon_asin end,
        website_url    = case when e ? 'website_url' then coalesce(e ->> 'website_url', '') else p.website_url end,
        notes          = case when e ? 'notes' then coalesce(e ->> 'notes', '') else p.notes end
      where p.workspace_id = p_ws and p.sku = e ->> 'sku';
      get diagnostics c = row_count; n := n + c;
    end loop;
  end if;
  update public.imports set undone_at = now(), undone_rows = n where id = p_id;
  return n;
end $$;

create or replace function public.v30_ready() returns boolean language sql stable as $$ select true $$;
revoke execute on function public.import_undo(uuid, text), public.v30_ready() from public, anon;
grant execute on function public.import_undo(uuid, text), public.v30_ready() to authenticated;
