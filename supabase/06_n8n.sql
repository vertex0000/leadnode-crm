-- Nodevers 06 — connect each workspace to its own n8n (n8n Cloud or self-hosted / Docker).
-- The API key is a secret: only Edge Functions (service role) can read it.
create table if not exists public.n8n_accounts (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  url          text not null,
  api_key      text not null,
  workflows    int  not null default 0,
  updated_at   timestamptz not null default now()
);
alter table public.n8n_accounts enable row level security;   -- no policies + no grants = browsers can't read it
revoke all on public.n8n_accounts from anon, authenticated;
grant all on public.n8n_accounts to service_role;

create or replace function public.n8n_status(p_ws uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare a public.n8n_accounts%rowtype;
begin
  if not public.is_member(p_ws) then raise exception 'Not a member of this workspace'; end if;
  select * into a from public.n8n_accounts where workspace_id = p_ws;
  if a.workspace_id is null then return json_build_object('connected', false); end if;
  return json_build_object('connected', true, 'url', a.url, 'workflows', a.workflows, 'updated_at', a.updated_at);
end $$;
revoke execute on function public.n8n_status(uuid) from public, anon;
grant execute on function public.n8n_status(uuid) to authenticated;
