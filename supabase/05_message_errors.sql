-- Nodevers 05 — remember WHY a WhatsApp message was not delivered (Meta's error code + reason).
alter table public.messages add column if not exists error text not null default '';
