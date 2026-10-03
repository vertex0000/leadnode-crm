-- Nodevers 18 — AI Advisor: daily tips with one-click actions (leads, WhatsApp, email, store, Meta Ads).
-- Adds ad set / ad level Meta numbers (filled by the store-sync function), "Ignore for 7 days" and a new plan section "AI Advisor".
-- Nothing existing is changed or deleted. Safe to run more than once. Needs 15_sections.sql and 16_stock_amazon_meta.sql first.

-- ---------- 1. Meta numbers per ad set and per ad (creative) — written only by the server (store-sync) ----------
create table if not exists public.ad_insights (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  day          date not null,
  level        text not null check (level in ('adset', 'ad')),
  ext_id       text not null check (length(ext_id) <= 40),          -- Meta ad set id / ad id
  name         text not null default '' check (length(name) <= 300),
  campaign     text not null default '' check (length(campaign) <= 300),
  campaign_id  text not null default '' check (length(campaign_id) <= 40),
  adset        text not null default '' check (length(adset) <= 300),
  adset_id     text not null default '' check (length(adset_id) <= 40),
  spend        numeric not null default 0 check (spend >= 0),
  impressions  bigint,
  clicks       bigint,
  leads        integer,
  purchases    integer,
  revenue      numeric,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, day, level, ext_id)
);
create index if not exists ad_insights_ws_day on public.ad_insights (workspace_id, day desc);
alter table public.ad_insights enable row level security;
drop policy if exists ai_select on public.ad_insights;
create policy ai_select on public.ad_insights for select to authenticated using (public.is_member(workspace_id));
revoke insert, update, delete on public.ad_insights from anon, authenticated;
grant select on public.ad_insights to authenticated;
grant all on public.ad_insights to service_role;
alter table public.ad_spend add column if not exists campaign_id text not null default '' check (length(campaign_id) <= 40);

-- ---------- 2. "Ignore this tip for 7 days" ----------
create table if not exists public.advisor_dismiss (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  tip_key      text not null check (length(tip_key) <= 120),
  until        timestamptz not null,
  by_name      text not null default '' check (length(by_name) <= 120),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, tip_key)
);
alter table public.advisor_dismiss enable row level security;
drop policy if exists ad_select on public.advisor_dismiss;
drop policy if exists ad_write on public.advisor_dismiss;
create policy ad_select on public.advisor_dismiss for select to authenticated using (public.is_member(workspace_id));
create policy ad_write on public.advisor_dismiss for all to authenticated using (public.can_write(workspace_id)) with check (public.can_write(workspace_id));
grant select, insert, update, delete on public.advisor_dismiss to authenticated;
grant all on public.advisor_dismiss to service_role;

-- ---------- 3. New plan section: AI Advisor (on by default for every plan) ----------
create or replace function public.feature_keys() returns text[]
language sql immutable as $$ select array['pipeline', 'tasks', 'orders', 'store', 'campaigns', 'automation', 'ads', 'insights', 'advisor'] $$;
create or replace function public.feature_name(k text) returns text
language sql immutable as $$
  select case k when 'pipeline' then 'Pipeline' when 'tasks' then 'Tasks & Calls' when 'orders' then 'Orders' when 'store' then 'Store'
    when 'campaigns' then 'Campaigns' when 'automation' then 'Automation' when 'ads' then 'Ads Manager' when 'insights' then 'Insights' when 'advisor' then 'AI Advisor' else k end $$;
