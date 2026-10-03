// Nodevers — ai-write: Gemini (free tier) helps write WhatsApp replies in the Inbox.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "ai-write" → paste → Deploy → turn OFF "Enforce JWT verification".
// Secret needed (Edge Functions → Secrets): GEMINI_API_KEY = your key from Google AI Studio (aistudio.google.com → Get API key). Optional: GEMINI_MODEL.
// The AI can be changed in Admin Console → Settings → AI (Groq, OpenRouter, Mistral, OpenAI, Claude, DeepSeek, any OpenAI-compatible) — needs 14_ai_providers.sql. Gemini stays the free backup.
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const cut = (s: unknown, n: number) => String(s ?? '').slice(0, n);

const TASK: Record<string, string> = {
  reply: 'Write the best next reply from the business to the customer, based on the chat.',
  improve: 'Rewrite the draft so it is clear, friendly and professional. Fix spelling and grammar. Keep the meaning.',
  shorter: 'Rewrite the draft much shorter — one or two lines. Keep the meaning.',
  polite: 'Rewrite the draft to sound warmer and more polite, still natural for WhatsApp.',
  english: 'Translate the draft into simple, natural English.',
  hindi: 'Translate the draft into simple Hindi (Devanagari script).',
  hinglish: 'Rewrite the draft in Hinglish (Hindi in Roman letters mixed with English), casual and natural.',
};

/* ---------- AI for the whole website: picked in Admin Console → Settings → AI (free Google Gemini by default) ---------- */
const GEMINI_URL = Deno.env.get('GEMINI_URL') ?? 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODELS = [...new Set([Deno.env.get('GEMINI_MODEL'), 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean) as string[])];
const AI_TEST_BASE = Deno.env.get('AI_TEST_BASE') ?? '';          // local tests only
const AI_DEF: Record<string, { kind: 'gemini' | 'openai' | 'anthropic'; url: string; model: string; name: string }> = {
  gemini: { kind: 'gemini', url: GEMINI_URL, model: '', name: 'Google Gemini' },
  groq: { kind: 'openai', url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', name: 'Groq' },
  openrouter: { kind: 'openai', url: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', name: 'OpenRouter' },
  mistral: { kind: 'openai', url: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', name: 'Mistral' },
  openai: { kind: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', name: 'OpenAI' },
  deepseek: { kind: 'openai', url: 'https://api.deepseek.com', model: 'deepseek-chat', name: 'DeepSeek' },
  anthropic: { kind: 'anthropic', url: 'https://api.anthropic.com/v1', model: 'claude-haiku-4-5-20251001', name: 'Claude' },
  custom: { kind: 'openai', url: '', model: '', name: 'Custom (OpenAI-compatible)' },
};
type AiOut = { ok: true; text: string; model: string; provider: string } | { ok: false; error: string; provider: string };
async function aiRow(prov: string) { const { data } = await db.from('ai_keys').select('*').eq('provider', prov).maybeSingle(); return data as any; }
async function aiCallOne(prov: string, row: any, system: string, user: string, temperature: number, maxTokens: number): Promise<AiOut> {
  const d = AI_DEF[prov] ?? AI_DEF.gemini, key = String(row?.api_key || (prov === 'gemini' ? Deno.env.get('GEMINI_API_KEY') ?? '' : '')).trim();
  if (!key) return { ok: false, error: `${d.name}: no API key saved`, provider: prov };
  const model = String(row?.model || d.model || '').trim(), base = (AI_TEST_BASE && d.kind !== 'gemini' ? AI_TEST_BASE : String(row?.base_url || d.url)).replace(/\/+$/, '');
  const go = (url: string, init: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(45000) }).catch(() => null);
  if (d.kind === 'gemini') {
    let last = '';
    for (const m of model ? [model] : GEMINI_MODELS) {
      const r = await go(`${base}/models/${m}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } }) });
      const j: any = r ? await r.json().catch(() => ({})) : {};
      const t = (j?.candidates?.[0]?.content?.parts ?? []).filter((x: any) => !x.thought).map((x: any) => x.text ?? '').join('').trim();
      if (r?.ok && t) return { ok: true, text: t, model: m, provider: prov };
      last = r ? (j?.error?.message ?? String(r.status)) : 'no answer';
      if (r && (r.status === 400 && /API key/i.test(last) || r.status === 403)) return { ok: false, error: 'Gemini did not accept the API key', provider: prov };
      if (r && r.status !== 404 && r.status !== 429 && r.status !== 503 && !/no longer available|not found|not supported|deprecated/i.test(last)) break;
    }
    return { ok: false, error: /quota|exhausted|429/i.test(last) ? 'Free Gemini limit reached for now — try again in a minute' : 'Gemini: ' + last, provider: prov };
  }
  if (!base || !model) return { ok: false, error: `${d.name}: add the ${!base ? 'base URL' : 'model name'}`, provider: prov };
  if (d.kind === 'anthropic') {
    const r = await go(`${base}/messages`, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: 'user', content: user }] }) });
    const j: any = r ? await r.json().catch(() => ({})) : {}; const t = (j?.content ?? []).map((c: any) => c.text ?? '').join('').trim();
    return r?.ok && t ? { ok: true, text: t, model, provider: prov } : { ok: false, error: `Claude: ${j?.error?.message ?? (r ? r.status : 'no answer')}`, provider: prov };
  }
  const r = await go(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prov === 'openrouter' ? { 'HTTP-Referer': 'https://nodevers.app', 'X-Title': 'Nodevers' } : {}) },
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  const j: any = r ? await r.json().catch(() => ({})) : {}; const t = String(j?.choices?.[0]?.message?.content ?? '').trim();
  return r?.ok && t ? { ok: true, text: t, model, provider: prov } : { ok: false, error: `${d.name}: ${j?.error?.message ?? j?.message ?? (r ? r.status : 'no answer')}`, provider: prov };
}
/** Ask the AI chosen by the platform admin; if it fails, fall back to free Gemini */
async function aiAsk(system: string, user: string, temperature = 0.4, maxTokens = 2048, force?: string): Promise<AiOut> {
  let prov = force;
  if (!prov) { const { data } = await db.from('platform_settings').select('value').eq('key', 'aiProvider').maybeSingle(); prov = AI_DEF[data?.value ?? ''] ? data!.value : 'gemini'; }
  const first = await aiCallOne(prov!, await aiRow(prov!).catch(() => null), system, user, temperature, maxTokens);
  if (first.ok || force || prov === 'gemini') return first;
  const backup = await aiCallOne('gemini', await aiRow('gemini').catch(() => null), system, user, temperature, maxTokens);
  return backup.ok ? backup : first;
}

async function ask(_key: string, system: string, user: string, temperature: number, strip = true) {
  const r = await aiAsk(system, user, temperature, 4096);
  if (!r.ok) return json({ error: /limit/i.test(r.error) ? r.error : 'AI: ' + r.error }, 400);
  const text = strip ? r.text.replace(/^["“]|["”]$/g, '') : r.text;
  return json({ ok: true, text, model: r.model, provider: r.provider });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();
    const ws = String(b.workspace_id ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const key = '';
    // ---- Admin Console → Settings → AI: test a provider (platform super admin / admin only) ----
    if (b.mode === 'aitest') {
      const { data: pa } = await db.from('platform_admins').select('role').eq('email', String(u.user.email ?? '').toLowerCase()).maybeSingle();
      if (!pa || !['super', 'admin'].includes(pa.role)) return json({ error: 'Only the platform team can test AI keys.' }, 403);
      const r = await aiAsk('You are a connection test. Reply with exactly the word OK.', 'Say OK', 0, 20, String(b.provider || 'gemini'));
      return r.ok ? json({ ok: true, text: r.text.slice(0, 80), model: r.model, provider: r.provider }) : json({ error: r.error }, 400);
    }

    // ---- Nodevers Guide: answers "how do I…" questions about the website (any signed-in user) ----
    if (b.mode === 'help') {
      const q = cut(b.question, 600).trim(); if (!q) return json({ error: 'Type your question.' }, 400);
      const hist = (Array.isArray(b.history) ? b.history : []).slice(-6).map((x: any) => `${x.role === 'me' ? 'User' : 'Guide'}: ${cut(x.text, 600)}`).join('\n');
      const system = [
        'You are "Nodevers Guide", the friendly in-app helper of Nodevers — a CRM + WhatsApp + email + calls + tasks + automation website for small businesses in India.',
        'Answer ONLY questions about using Nodevers, using the GUIDE below as the source of truth. Use the exact English button and screen names from the guide, in **bold**.',
        'Give numbered steps and one tip if useful. No long intros. Markdown: **bold**, numbered lists, short paragraphs only.',
        'When the user asks how to connect / set up something or where to find an API key / token: give the COMPLETE process from the matching SETUP PLAYBOOK — every step from opening the other website (Meta, Brevo, Shopify, Zapier…) to pasting into Nodevers and testing. Do not shorten it to "go to settings and paste the key".',
        'If they use a tool not in the playbooks (e.g. Hostinger email, Wix forms), explain the closest working way with the tools Nodevers supports (Lead capture link, Zapier / Make / n8n, the listed email providers).',
        'Reply in the language the user writes in: English, Hindi or Hinglish (Roman Hindi). Default to simple Hinglish if the user mixes.',
        'If the guide does not cover it, say you are not sure and suggest asking the business owner / Nodevers support — never invent features, prices or settings.',
        'Never ask for or repeat passwords, API keys, tokens or OTPs; tell the user to paste keys only into the right box on the website.',
        'Off-topic questions (not about Nodevers or running their sales with it): politely say you can only help with Nodevers.',
      ].join('\n');
      const user = `Current screen: ${cut(b.page, 40) || 'unknown'} · User role: ${cut(b.role, 20) || 'member'}\n\nGUIDE:\n${cut(b.guide, 40000)}\n\n${hist ? 'Conversation so far:\n' + hist + '\n\n' : ''}User question: ${q}`;
      return await ask(key, system, user, 0.3, false);
    }

    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || m.role === 'client') return json({ error: 'You do not have permission here.' }, 403);

    // ---- AI Advisor: turn the day's tips (already calculated from the client's own numbers) into a short summary ----
    if (b.mode === 'advisor') {
      const tips = (Array.isArray(b.tips) ? b.tips : []).slice(0, 12).map((t: any, i: number) => `${i + 1}. [${cut(t.area, 12)}] ${cut(t.title, 160)} — ${cut(t.why, 300)}`).join('\n');
      if (!tips) return json({ error: 'Nothing to summarise yet.' }, 400);
      const system = [
        'You are the AI Advisor inside Nodevers, a CRM + WhatsApp + store + ads tool for small businesses in India.',
        'Write a short daily briefing for the business owner from the TIPS below: 3 to 5 bullet points, most important first, each one line with the action to take.',
        'Use ONLY the numbers and names in the tips. Never invent numbers, campaigns, products or results. Do not promise outcomes.',
        `Language: ${b.lang === 'en' ? 'simple English' : 'simple Hinglish (Roman Hindi mixed with English words)'}. No greeting, no sign-off. Markdown bullets only.`,
      ].join('\n');
      return await ask(key, system, `Business: ${cut(b.business, 80)}\nTIPS:\n${tips}`, 0.3, false);
    }

    const mode = TASK[b.mode] ? String(b.mode) : 'reply';
    const draft = cut(b.draft, 1500).trim();
    if (mode !== 'reply' && !draft) return json({ error: 'Type something first, then ask AI to improve it.' }, 400);
    const { data: w } = await db.from('workspaces').select('name').eq('id', ws).maybeSingle();
    const lead = b.lead ?? {};
    const chat = (Array.isArray(b.messages) ? b.messages : []).slice(-14)
      .map((x: any) => `${x.direction === 'out' ? 'Business' : 'Customer'}: ${cut(x.text, 600)}`).join('\n');

    const system = [
      `You write WhatsApp messages for the business "${cut(w?.name || 'our business', 80)}", talking to a customer.`,
      'Output ONLY the message text — no quotes, no labels, no options, no explanations.',
      'Keep it short (under 60 words), friendly and human. WhatsApp formatting (*bold*) is fine; at most one emoji.',
      'Reply in the same language the customer uses (English, Hindi or Hinglish) unless the task says otherwise.',
      'Never invent prices, stock, dates, links or promises that are not in the chat. If a detail is needed, write a placeholder like [price].',
    ].join('\n');
    const user = [
      `Task: ${TASK[mode]}`,
      b.note ? `Extra instruction: ${cut(b.note, 200)}` : '',
      `Customer: ${cut(lead.name, 60) || 'unknown'}${lead.business ? ` (${cut(lead.business, 60)})` : ''}${lead.city ? `, ${cut(lead.city, 40)}` : ''}${lead.stage ? ` · stage: ${cut(lead.stage, 30)}` : ''}`,
      chat ? `Chat so far (oldest first):\n${chat}` : mode === 'reply' ? 'No messages yet — write a friendly opening message.' : '',
      draft ? `Draft:\n${draft}` : '',
    ].filter(Boolean).join('\n\n');

    return await ask(key, system, user, 0.7);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
