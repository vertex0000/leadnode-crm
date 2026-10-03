-- Nodevers 17 — Home page layout: the platform team can reset one client's Home (or every client's) to the default layout.
-- The default layout itself is saved in platform_settings (key homeLayoutJson) from Admin Console → Home page.
-- A client's own layout is saved in its workspace settings (key homeLayoutJson) by its owner / admins.
-- Safe to run more than once. Needs 11_platform_billing.sql first.

create or replace function public.admin_home_reset(p_ws uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Only a super admin or an admin can reset a client''s Home'; end if;
  delete from public.settings where workspace_id = p_ws and key = 'homeLayoutJson';
  perform public.paudit('home.reset', p_ws::text, '{}'::jsonb);
end $$;

create or replace function public.admin_home_reset_all() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Only a super admin or an admin can reset every client''s Home'; end if;
  delete from public.settings where key = 'homeLayoutJson';
  get diagnostics n = row_count;
  perform public.paudit('home.reset_all', 'all', jsonb_build_object('clients', n));
  return n;
end $$;

revoke execute on function public.admin_home_reset(uuid), public.admin_home_reset_all() from public, anon;
grant execute on function public.admin_home_reset(uuid), public.admin_home_reset_all() to authenticated;
