-- Nodevers 29 — undo an import
-- Every Excel / CSV / Google Sheet import gets an id. Rows it CREATES carry that id (import_id); a later update never changes it,
-- so "Undo import" removes exactly the rows that import added — rows that already existed and were only updated stay.
-- History tables (stock movements, goods received, messages, payments, audit) are never touched.
-- Safe to run more than once. Needs 01–28 first.

create table if not exists public.imports (
  id           text primary key check (id ~ '^IM[A-Za-z0-9]{6,40}$'),
  workspace_id uuid not null default public.my_workspace() references public.workspaces(id) on delete cascade,
  kind         text not null default '' check (length(kind) <= 40),       -- leads, store, expenses, payouts …
  label        text not null default '' check (length(label) <= 200),     -- file name / batch name
  rows_added   integer not null default 0,
  by_name      text not null default '' check (length(by_name) <= 120),
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  undone_at    timestamptz,
  undone_rows  integer
);
create index if not exists imports_ws_idx on public.imports (workspace_id, created_at desc);
alter table public.imports enable row level security;
drop policy if exists imports_read on public.imports;
create policy imports_read on public.imports for select to authenticated using (workspace_id in (select public.my_ws()));
drop policy if exists imports_add on public.imports;
create policy imports_add on public.imports for insert to authenticated with check (public.can_write(workspace_id));
drop policy if exists imports_upd on public.imports;
create policy imports_upd on public.imports for update to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));

-- an update never moves a row to another import (the row belongs to the import that created it)
create or replace function public.keep_import_id() returns trigger language plpgsql as $$
begin new.import_id := old.import_id; return new; end $$;

do $$ declare t text; begin
  foreach t in array array['leads', 'orders', 'products', 'ad_spend', 'expenses', 'fin_entries', 'payouts', 'cod_remits', 'purchase_bills'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I add column if not exists import_id text', t);
      execute format('create index if not exists %I on public.%I (workspace_id, import_id) where import_id is not null', t || '_import_idx', t);
      execute format('drop trigger if exists keep_import_id on public.%I', t);
      execute format('create trigger keep_import_id before update on public.%I for each row execute function public.keep_import_id()', t);
    end if;
  end loop;
end $$;

-- remove everything one import added; returns how many rows went
create or replace function public.import_undo(p_ws uuid, p_id text) returns integer
language plpgsql security definer set search_path = public as $$
declare t text; n integer := 0; c integer; imp public.imports%rowtype;
begin
  if not public.can_write(p_ws) then raise exception 'Your access is view only'; end if;
  if not public.has_perm(p_ws, 'delete') then raise exception 'Your access does not include deleting — ask the owner'; end if;
  select * into imp from public.imports where workspace_id = p_ws and id = p_id;
  if imp.id is null then raise exception 'Import not found'; end if;
  if imp.undone_at is not null then raise exception 'This import was already undone'; end if;
  foreach t in array array['orders', 'leads', 'products', 'ad_spend', 'expenses', 'fin_entries', 'payouts', 'cod_remits', 'purchase_bills'] loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from public.%I where workspace_id = $1 and import_id = $2', t) using p_ws, p_id;
      get diagnostics c = row_count; n := n + c;
    end if;
  end loop;
  update public.imports set undone_at = now(), undone_rows = n where id = p_id;
  return n;
end $$;

create or replace function public.v29_ready() returns boolean language sql stable as $$ select true $$;
revoke execute on function public.import_undo(uuid, text), public.v29_ready() from public, anon;
grant execute on function public.import_undo(uuid, text), public.v29_ready() to authenticated;
grant select, insert, update on public.imports to authenticated;
