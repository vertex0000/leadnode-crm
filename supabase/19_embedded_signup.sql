-- Nodevers — 19: one-click WhatsApp connect (Embedded Signup).
-- Run once in Supabase → SQL Editor. Safe to run again.
alter table public.wa_accounts add column if not exists pin text not null default '';                    -- two-step verification PIN we set when registering the number
alter table public.wa_accounts add column if not exists onboarded_via text not null default 'manual';    -- 'manual' (pasted token) or 'embedded_signup' (Connect with Facebook)
