-- =====================================================================
--  Nodevers — database v4: WhatsApp template details (footer, Meta id, quality)
--  Run once in Supabase → SQL Editor → Run (after 01–03). Safe to run again.
-- =====================================================================
alter table public.templates add column if not exists footer text not null default '';
alter table public.templates add column if not exists meta_id text not null default '';
alter table public.templates add column if not exists quality text not null default '';
alter table public.templates add column if not exists reject_reason text not null default '';
alter table public.templates add column if not exists updated_at timestamptz not null default now();
alter table public.templates drop constraint if exists templates_body_check;
alter table public.templates add constraint templates_body_check check (length(body) <= 1100);
grant all on all tables in schema public to service_role;
-- Done ✓  — you should see "Success. No rows returned".
