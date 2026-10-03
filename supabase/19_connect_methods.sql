-- Nodevers 19 — Two ways to connect WhatsApp, Shopify, Amazon and Meta Ads.
--   Option A ("own app"):  the client uses its own Meta / Shopify / Amazon developer app and pastes its keys.
--                          WhatsApp: every client gets its OWN webhook verify token, and its Meta App secret is kept on the server,
--                          so incoming messages from the client's own Meta app are accepted (before only the platform's app worked).
--   Option B ("one click"): the client presses "Connect with Facebook / Shopify / Amazon" and approves — uses the platform's
--                          approved app (Meta Tech Provider, Shopify public app, Amazon public app). Switched OFF until approved.
-- Which option a client sees is chosen in Admin Console → Settings → Connect methods (saved as connectModesJson — names and on/off only, never keys).
-- Nothing existing is changed or deleted. Safe to run more than once. Needs 02_team_whatsapp_realtime.sql and 11_platform_billing.sql first.

-- ---------- 1. WhatsApp webhook keys per client (server only — browsers can never read this table) ----------
create table if not exists public.wa_hooks (
  workspace_id    uuid primary key references public.workspaces(id) on delete cascade,
  verify_token    text not null unique check (length(verify_token) between 20 and 100),
  app_secret      text not null default '',          -- the client's Meta App secret (Option A) — secret
  verified_at     timestamptz,                       -- Meta checked the verify token ("Verify and save")
  last_event_at   timestamptz,                       -- last message / tick accepted from Meta
  last_bad_sig_at timestamptz,                       -- last time Meta's signature did not match the App secret
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.wa_hooks enable row level security;
revoke all on public.wa_hooks from anon, authenticated;
grant all on public.wa_hooks to service_role;

-- how the number was connected: own = client's own Meta app (A), app = Connect with Facebook (B)
alter table public.wa_accounts add column if not exists connect_mode text not null default 'own';
alter table public.wa_accounts drop constraint if exists wa_accounts_connect_mode_check;
alter table public.wa_accounts add constraint wa_accounts_connect_mode_check check (connect_mode in ('own', 'app'));

-- the owner / an admin sees the workspace's webhook verify token (made the first time) — never the App secret
create or replace function public.wa_hook_info(p_ws uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h public.wa_hooks%rowtype; m text;
begin
  if not public.is_admin(p_ws) then raise exception 'Only the owner or an admin can see the webhook settings'; end if;
  select * into h from public.wa_hooks where workspace_id = p_ws;
  if h.workspace_id is null then
    insert into public.wa_hooks (workspace_id, verify_token) values (p_ws, 'nv' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
    on conflict (workspace_id) do nothing;
    select * into h from public.wa_hooks where workspace_id = p_ws;
  end if;
  select connect_mode into m from public.wa_accounts where workspace_id = p_ws;
  return jsonb_build_object('verify_token', h.verify_token, 'has_app_secret', h.app_secret <> '', 'verified_at', h.verified_at,
    'last_event_at', h.last_event_at, 'last_bad_sig_at', h.last_bad_sig_at, 'connect_mode', m);
end $$;

-- make a new verify token (the old one stops working — paste the new one in Meta)
create or replace function public.wa_hook_new_token(p_ws uuid) returns text
language plpgsql security definer set search_path = public as $$
declare t text := 'nv' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not public.is_admin(p_ws) then raise exception 'Only the owner or an admin can change the webhook settings'; end if;
  insert into public.wa_hooks (workspace_id, verify_token) values (p_ws, t)
  on conflict (workspace_id) do update set verify_token = excluded.verify_token, verified_at = null, updated_at = now();
  return t;
end $$;
revoke execute on function public.wa_hook_info(uuid), public.wa_hook_new_token(uuid) from public, anon;
grant execute on function public.wa_hook_info(uuid), public.wa_hook_new_token(uuid) to authenticated;

-- ---------- 2. "Connect with Shopify / Amazon / Facebook" — one-time login codes (server only, 30 minutes) ----------
create table if not exists public.oauth_states (
  state        text primary key check (length(state) between 20 and 100),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null,
  platform     text not null check (length(platform) <= 30),
  redirect_uri text not null default '' check (length(redirect_uri) <= 500),
  extra        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists oauth_states_at on public.oauth_states (created_at);
alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;
grant all on public.oauth_states to service_role;

-- ---------- 3. Platform role of a signed-in user — for the Edge Functions only (Admin Console → "Check Supabase secrets") ----------
create or replace function public.platform_role_of(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select p.role from auth.users u join public.platform_admins p on p.email = lower(u.email)
  where u.id = uid and u.email_confirmed_at is not null limit 1;
$$;
revoke execute on function public.platform_role_of(uuid) from public, anon, authenticated;
grant execute on function public.platform_role_of(uuid) to service_role;
