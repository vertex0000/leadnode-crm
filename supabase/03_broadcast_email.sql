-- =====================================================================
--  Nodevers — database v3: lead email, opt-outs, WhatsApp + email broadcasts
--  Run once in Supabase → SQL Editor → Run  (after 01 and 02). Safe to run again.
-- =====================================================================

-- Leads: email + opt-outs (people who said STOP / clicked unsubscribe are skipped by broadcasts)
alter table public.leads add column if not exists email text not null default '';
alter table public.leads add column if not exists email_opt_out boolean not null default false;
alter table public.leads add column if not exists wa_opt_out boolean not null default false;
create index if not exists leads_email_idx on public.leads (workspace_id, email);

-- Broadcasts: one row per campaign (WhatsApp or email)
alter table public.broadcasts add column if not exists channel text not null default 'whatsapp';
alter table public.broadcasts add column if not exists subject text not null default '';
alter table public.broadcasts add column if not exists body text not null default '';
alter table public.broadcasts add column if not exists failed int not null default 0;
alter table public.broadcasts add column if not exists sent_at timestamptz;

-- Messages sent by a broadcast remember it (for delivered / read / replies counts)
alter table public.messages add column if not exists broadcast_id text;
create index if not exists messages_broadcast_idx on public.messages (workspace_id, broadcast_id);

-- Email sending account per workspace (Brevo). The API key never reaches the browser.
create table if not exists public.email_accounts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  provider     text not null default 'brevo',
  api_key      text not null,
  from_email   text not null,
  from_name    text not null default '',
  updated_at   timestamptz not null default now()
);
alter table public.email_accounts enable row level security;
revoke all on public.email_accounts from anon, authenticated;

create or replace function public.email_status(p_ws uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare a public.email_accounts%rowtype;
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  select * into a from public.email_accounts where workspace_id = p_ws;
  if a.workspace_id is null then return json_build_object('connected', false); end if;
  return json_build_object('connected', true, 'provider', a.provider, 'from_email', a.from_email, 'from_name', a.from_name, 'updated_at', a.updated_at);
end $$;
revoke execute on function public.email_status(uuid) from public, anon;
grant execute on function public.email_status(uuid) to authenticated;

grant all on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Done ✓  — you should see "Success. No rows returned".
