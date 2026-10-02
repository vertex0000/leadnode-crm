-- Nodevers 14 — Choose the AI for the whole website (Admin Console → Settings → AI).
-- Free by default (Google Gemini). The platform team can add keys for Groq, OpenRouter, Mistral, OpenAI, Claude, DeepSeek
-- or any OpenAI-compatible service and pick which one Nodevers uses. Keys are stored on the server only — never sent back to a browser.
-- Safe to run more than once. Needs 11_platform_billing.sql first.

create table if not exists public.ai_keys (
  provider   text primary key check (provider in ('gemini', 'groq', 'openrouter', 'mistral', 'openai', 'anthropic', 'deepseek', 'custom')),
  api_key    text not null default '',
  model      text not null default '' check (length(model) <= 120),
  base_url   text not null default '' check (length(base_url) <= 300),
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
alter table public.ai_keys enable row level security;               -- no policies: browsers can never read keys
revoke all on public.ai_keys from anon, authenticated;
grant all on public.ai_keys to service_role;
grant select on public.platform_admins to service_role;   -- the ai-write function checks who may test AI keys

-- which AI the website uses (public on purpose — only the name, never a key)
insert into public.platform_settings (key, value) values ('aiProvider', 'gemini') on conflict (key) do nothing;

-- status for Admin Console: which providers have a key (last 4 characters only)
create or replace function public.admin_ai_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Only a super admin or an admin can see AI settings'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'has_key', api_key <> '', 'hint', case when length(api_key) > 8 then '…' || right(api_key, 4) else '' end,
    'model', model, 'base_url', base_url, 'updated_at', updated_at, 'updated_by', updated_by)) from public.ai_keys), '[]'::jsonb);
end $$;

-- save a key / model. p_key = null keeps the saved key; p_clear = true removes it.
create or replace function public.admin_ai_save(p_provider text, p_key text, p_model text, p_base text, p_clear boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_platform_role(array['super', 'admin']) then raise exception 'Only a super admin or an admin can change AI settings'; end if;
  if p_provider not in ('gemini', 'groq', 'openrouter', 'mistral', 'openai', 'anthropic', 'deepseek', 'custom') then raise exception 'Unknown AI provider'; end if;
  if p_base is not null and p_base <> '' and p_base !~ '^https://' then raise exception 'The base URL must start with https://'; end if;
  insert into public.ai_keys (provider, api_key, model, base_url, updated_at, updated_by)
  values (p_provider, case when p_clear then '' else coalesce(nullif(trim(p_key), ''), '') end, coalesce(trim(p_model), ''), coalesce(trim(p_base), ''), now(), coalesce(auth.jwt() ->> 'email', ''))
  on conflict (provider) do update set
    api_key = case when p_clear then '' when nullif(trim(p_key), '') is null then public.ai_keys.api_key else trim(p_key) end,
    model = coalesce(trim(p_model), public.ai_keys.model), base_url = coalesce(trim(p_base), public.ai_keys.base_url), updated_at = now(), updated_by = excluded.updated_by;
  perform public.paudit('ai.save', p_provider, jsonb_build_object('model', p_model, 'key_changed', p_clear or nullif(trim(p_key), '') is not null));
end $$;
revoke execute on function public.admin_ai_status(), public.admin_ai_save(text, text, text, text, boolean) from public, anon;
grant execute on function public.admin_ai_status(), public.admin_ai_save(text, text, text, text, boolean) to authenticated;
