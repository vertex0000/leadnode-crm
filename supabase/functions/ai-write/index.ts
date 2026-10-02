// Nodevers — ai-write: Gemini (free tier) helps write WhatsApp replies in the Inbox.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "ai-write" → paste → Deploy → turn OFF "Enforce JWT verification".
// Secret needed (Edge Functions → Secrets): GEMINI_API_KEY = your key from Google AI Studio (aistudio.google.com → Get API key). Optional: GEMINI_MODEL.
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const GEMINI = Deno.env.get('GEMINI_URL') ?? 'https://generativelanguage.googleapis.com/v1beta';
const MODELS = [...new Set([Deno.env.get('GEMINI_MODEL'), 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean) as string[])];
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

async function ask(key: string, system: string, user: string, temperature: number, strip = true) {
  let last = '';
  for (const model of MODELS) {
    const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature, maxOutputTokens: 4096 } }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      let text = (j?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('').trim();
      if (strip) text = text.replace(/^["“]|["”]$/g, '');
      if (text) return json({ ok: true, text, model });
      last = 'AI returned an empty answer — try again.';
      continue;
    }
    last = j?.error?.message ?? String(r.status);
    if (r.status === 400 && /API key/i.test(last)) return json({ error: 'The Gemini API key is not valid — check the GEMINI_API_KEY secret.' }, 400);
    if (r.status === 403) return json({ error: 'Gemini refused the key (403) — make sure the key is from Google AI Studio and the API is enabled.' }, 400);
    if (r.status !== 404 && r.status !== 429 && r.status !== 503 && !/no longer available|not found|not supported|deprecated/i.test(last)) break;     // try the next model only for missing/retired/busy models
  }
  return json({ error: /quota|exhausted|429/i.test(last) ? 'Free AI limit reached for now — try again in a minute.' : 'AI: ' + last }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();
    const ws = String(b.workspace_id ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) return json({ error: 'AI is not switched on yet — add the GEMINI_API_KEY secret in Supabase → Edge Functions → Secrets.' }, 400);

    // ---- Nodevers Guide: answers "how do I…" questions about the website (any signed-in user) ----
    if (b.mode === 'help') {
      const q = cut(b.question, 600).trim(); if (!q) return json({ error: 'Type your question.' }, 400);
      const hist = (Array.isArray(b.history) ? b.history : []).slice(-6).map((x: any) => `${x.role === 'me' ? 'User' : 'Guide'}: ${cut(x.text, 600)}`).join('\n');
      const system = [
        'You are "Nodevers Guide", the friendly in-app helper of Nodevers — a CRM + WhatsApp + email + calls + tasks + automation website for small businesses in India.',
        'Answer ONLY questions about using Nodevers, using the GUIDE below as the source of truth. Use the exact English button and screen names from the guide, in **bold**.',
        'Give short numbered steps (max 7) and one tip if useful. No long intros. Markdown: **bold**, numbered lists, short paragraphs only.',
        'Reply in the language the user writes in: English, Hindi or Hinglish (Roman Hindi). Default to simple Hinglish if the user mixes.',
        'If the guide does not cover it, say you are not sure and suggest asking the business owner / Nodevers support — never invent features, prices or settings.',
        'Never ask for or repeat passwords, API keys, tokens or OTPs; tell the user to paste keys only into the right box on the website.',
        'Off-topic questions (not about Nodevers or running their sales with it): politely say you can only help with Nodevers.',
      ].join('\n');
      const user = `Current screen: ${cut(b.page, 40) || 'unknown'} · User role: ${cut(b.role, 20) || 'member'}\n\nGUIDE:\n${cut(b.guide, 16000)}\n\n${hist ? 'Conversation so far:\n' + hist + '\n\n' : ''}User question: ${q}`;
      return await ask(key, system, user, 0.3, false);
    }

    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || m.role === 'client') return json({ error: 'You do not have permission here.' }, 403);

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
