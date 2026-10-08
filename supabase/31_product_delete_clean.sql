-- Nodevers 31 — deleting a product also clears its stock history
-- Stock per place (stock_levels) and set / recipe parts (product_parts) already go with the product (on delete cascade).
-- The stock movement log (stock_moves) had no link, so a deleted product kept showing in Inventory → "Where your stock went".
-- Now: delete a product → its movements go too. Rename a SKU → its movements follow the new SKU.
-- Orders, purchase orders, goods received and stock counts are documents — they are NOT touched.
-- Also cleans, once, the movements of products that were already deleted.
-- Safe to run more than once. Needs 01–30 first.

create or replace function public.product_gone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    delete from public.stock_moves where workspace_id = old.workspace_id and sku = old.sku;
    return old;
  end if;
  if new.sku is distinct from old.sku then
    update public.stock_moves set sku = new.sku where workspace_id = old.workspace_id and sku = old.sku;
  end if;
  return new;
end $$;

drop trigger if exists product_gone on public.products;
create trigger product_gone after delete on public.products for each row execute function public.product_gone();
drop trigger if exists product_sku_moves on public.products;
create trigger product_sku_moves after update of sku on public.products for each row execute function public.product_gone();

-- one-time clean: movements of products that no longer exist
delete from public.stock_moves m
 where not exists (select 1 from public.products p where p.workspace_id = m.workspace_id and p.sku = m.sku);

create or replace function public.v31_ready() returns boolean language sql stable as $$ select true $$;
revoke execute on function public.product_gone(), public.v31_ready() from public, anon;
grant execute on function public.v31_ready() to authenticated;
