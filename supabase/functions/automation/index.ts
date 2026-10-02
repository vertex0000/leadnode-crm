// Nodevers — automation: runs the Automation canvas for real once it is switched Live.
//   run  (called by the database when new events arrive) · cron (every 2 minutes: waits, wait-for-reply timeouts, schedules)
//   Both need the header x-cron-secret. Messages go out through wa-send / email ("system" calls), so the same rules apply:
//   STOP / unsubscribed are skipped, view-only workspaces send nothing, everything is logged on the lead's timeline.
// AI nodes use the AI picked in Admin Console → Settings → AI (free Google Gemini by default, secret GEMINI_API_KEY).
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "automation" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0';
const ALLOW_HTTP = Deno.env.get('AUTO_ALLOW_HTTP') === '1';
const MAX_STEPS = 40;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const istDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const istHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
const istDay = () => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(new Date());
const addDays = (n: number) => istDate(new Date(Date.now() + n * 864e5));

type Node = { id: string; type: string; p?: Record<string, any>; title?: string };
type Flow = { nodes: Node[]; links: [string, number, string][]; live?: boolean };
type Item = { n: string; at?: string };
const NAMES: Record<string, string> = { 'trg.newlead': 'New lead', 'trg.stage': 'Stage changed', 'trg.tag': 'Tag set', 'trg.wamsg': 'WhatsApp message', 'trg.form': 'Meta lead form', 'trg.schedule': 'Schedule',
  'lead.move': 'Move to stage', 'lead.tag': 'Set tag', 'lead.assign': 'Assign', 'lead.followup': 'Set follow-up', 'lead.note': 'Add note', 'lead.create': 'Create lead', 'lead.notify': 'Notify team',
  'wa.template': 'Send template', 'wa.text': 'Send message', 'wa.wait': 'Wait for reply', 'mail.send': 'Send email', 'logic.if': 'If / Router', 'logic.wait': 'Wait', 'logic.split': 'A/B split',
  'ai.reply': 'AI reply', 'ai.score': 'AI lead score', 'ai.intent': 'Detect intent', 'n8n.send': 'Send to n8n', 'n8n.http': 'HTTP request' };
const nameOf = (n: Node) => n.title || NAMES[n.type] || n.type;

let SECRET = '';
async function fnBase() { const { data } = await db.from('app_config').select('value').eq('key', 'functions_url').maybeSingle(); return (data?.value || `${SB_URL.replace(/\/+$/, '')}/functions/v1`).replace(/\/+$/, ''); }
async function callFn(fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${await fnBase()}/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': SECRET }, body: JSON.stringify({ action: 'system', ...body }) }).catch(() => null);
  const j: any = r ? await r.json().catch(() => ({})) : {};
  return { ok: !!j.ok, msg: j.ok ? 'sent' : j.skipped ? `skipped — ${j.error}` : `failed — ${j.error ?? 'no answer'}`, skipped: !!j.skipped };
}
function safeUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && !(ALLOW_HTTP && u.protocol === 'http:')) throw new Error('link must start with https://');
  const h = u.hostname.toLowerCase();
  if (!ALLOW_HTTP && (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^\[/.test(h))) throw new Error('private addresses are not allowed');
  return u;
}
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

async function ai(system: string, user: string) { const r = await aiAsk(system, user, 0.4, 800); if (!r.ok) throw new Error(r.error); return r.text; }
const fill = (s: string, l: any) => String(s ?? '').replace(/\{\{\s*(first_name|name|business|city|phone|stage|source)\s*\}\}/g, (_m, k) => !l ? '' : k === 'first_name' ? (String(l.name ?? '').split(' ')[0] || 'there') : k === 'business' ? String(l.business_name ?? '') : String(l[k] ?? ''));

async function loadFlow(ws: string): Promise<Flow | null> {
  const { data: on } = await db.rpc('ws_feature', { ws, k: 'automation' }); if (on === false) return null;   // section switched off in Admin Console
  const { data } = await db.from('flows').select('flow_json').eq('workspace_id', ws).eq('flow_id', 'AUTOMATION').maybeSingle();
  try { const f = JSON.parse(data?.flow_json ?? 'null'); if (f && f.live && Array.isArray(f.nodes)) { f.links = Array.isArray(f.links) ? f.links : []; return f; } } catch { /* ignore */ }
  return null;
}
const nextOf = (f: Flow, id: string, out?: number) => f.links.filter((l) => l[0] === id && (out === undefined || l[1] === out)).map((l) => l[2]);
const getLead = async (ws: string, id: string | null) => { if (!id) return null; const { data } = await db.from('leads').select('*').eq('workspace_id', ws).eq('lead_id', id).maybeSingle(); return data; };

/** triggers that match an event */
function matches(n: Node, ev: any, lead: any): boolean {
  const p = n.p ?? {}, d = ev.data ?? {}, low = (s: unknown) => String(s ?? '').trim().toLowerCase();
  switch (n.type) {
    case 'trg.newlead': return ev.kind === 'test' || (ev.kind === 'newlead' && (!p.source || p.source === 'Any' || low(p.source) === low(d.source)));
    case 'trg.form': return ev.kind === 'newlead' && /lead ?ads|facebook|instagram|meta/i.test(String(d.source ?? '')) && (!p.form || low(lead?.notes).includes(low(p.form)));
    case 'trg.stage': return ev.kind === 'stage' && (!p.stage || low(p.stage) === low(d.stage));
    case 'trg.tag': return ev.kind === 'tag' && (!p.tag || low(p.tag) === low(d.tag));
    case 'trg.wamsg': return ev.kind === 'wamsg' && (!p.kw || low(d.text).includes(low(p.kw)));
  }
  return false;
}

/** one step; returns which outputs continue, or a wait */
async function step(ws: string, f: Flow, n: Node, run: any): Promise<{ ok: boolean; msg: string; outs?: number[]; waitMs?: number; waitReplyMs?: number }> {
  const p = n.p ?? {}, lead = await getLead(ws, run.lead_id), needLead = () => ({ ok: false, msg: 'skipped — this step needs a lead (schedule runs have none)', outs: [0] });
  const patch = async (x: Record<string, unknown>) => { const { error } = await db.rpc('auto_apply', { p_ws: ws, p_lead: run.lead_id, p: x }); if (error) throw new Error(error.message); };
  switch (n.type) {
    case 'lead.move': if (!lead) return needLead(); if (!p.stage) return { ok: false, msg: 'pick a stage', outs: [0] }; await patch({ stage: p.stage }); return { ok: true, msg: `→ ${p.stage}`, outs: [0] };
    case 'lead.tag': if (!lead) return needLead(); await patch({ tag: p.tag || 'Hot' }); return { ok: true, msg: `tag ${p.tag || 'Hot'}`, outs: [0] };
    case 'lead.followup': { if (!lead) return needLead(); const d = addDays(Math.max(0, +p.days || 1)); await patch({ follow_up_date: d }); return { ok: true, msg: `follow-up ${d}`, outs: [0] }; }
    case 'lead.assign': {
      if (!lead) return needLead(); let who = String(p.member || 'Round-robin');
      if (who === 'Round-robin') {
        const { data: t } = await db.from('team').select('name, active').eq('workspace_id', ws); const names = (t ?? []).filter((x: any) => x.active !== false && x.active !== 'false' && x.name).map((x: any) => String(x.name)).sort();
        if (!names.length) return { ok: false, msg: 'no active team members', outs: [0] };
        const { data: s } = await db.from('settings').select('value').eq('workspace_id', ws).eq('key', 'autoRoundRobin').maybeSingle(); const i = (Number(s?.value) || 0) % names.length; who = names[i];
        await db.from('settings').upsert({ workspace_id: ws, key: 'autoRoundRobin', value: String(i + 1) }, { onConflict: 'workspace_id,key' });
      }
      await patch({ assigned_to: who }); return { ok: true, msg: `assigned to ${who}`, outs: [0] };
    }
    case 'lead.note': if (!lead) return needLead(); await db.from('activities').insert({ workspace_id: ws, lead_id: run.lead_id, type: 'Note', details: fill(p.text || 'Automation note', lead).slice(0, 300), done_by: 'Automation' }); return { ok: true, msg: 'note added', outs: [0] };
    case 'lead.create': return { ok: true, msg: 'skipped — the lead already exists', outs: [0] };
    case 'lead.notify': {
      const text = fill(p.text || 'New update on {{name}} ({{phone}}) — stage {{stage}}', lead).slice(0, 900), out: string[] = [];
      if (p.email) out.push('email ' + (await callFn('email', { workspace_id: ws, to_email: p.email, subject: `🔔 ${text.slice(0, 80)}`, body: text })).msg);
      if (p.phone) {
        const { data: acc } = await db.from('wa_accounts').select('*').eq('workspace_id', ws).maybeSingle(); const { data: w } = await db.from('workspaces').select('name').eq('id', ws).maybeSingle();
        if (!acc) out.push('WhatsApp not connected'); else {
          const r = await fetch(`${GRAPH}/${acc.phone_number_id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to: String(p.phone).replace(/\D/g, ''), type: 'template', template: { name: 'nodevers_alert', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: String(w?.name || 'Nodevers') }, { type: 'text', text: text.replace(/\s*\n+\s*/g, ' · ') }] }] } }) }).catch(() => null);
          out.push(r?.ok ? 'WhatsApp sent' : 'WhatsApp failed (is the nodevers_alert template approved?)'); }
      }
      return { ok: out.length > 0 && !out.some((x) => /fail|not connected/.test(x)), msg: out.join(' · ') || 'add an email or WhatsApp number', outs: [0] };
    }
    case 'wa.template': { if (!lead) return needLead(); if (!p.template) return { ok: false, msg: 'pick a template', outs: [0] };
      const params = String(p.params ?? '').split('|').map((x) => x.trim()).filter((x) => x !== ''); const r = await callFn('wa-send', { workspace_id: ws, lead_id: run.lead_id, template: p.template, language: p.lang || 'en', params, preview: `Template: ${p.template}` });
      return { ok: r.ok, msg: `${p.template} ${r.msg}`, outs: [0] }; }
    case 'wa.text': { if (!lead) return needLead(); const r = await callFn('wa-send', { workspace_id: ws, lead_id: run.lead_id, text: p.text || 'Hi {{first_name}}!' }); return { ok: r.ok, msg: r.msg + (r.ok ? '' : ' (free text only works within 24 h of their last message — use a template)'), outs: [0] }; }
    case 'mail.send': { if (!lead) return needLead(); const r = await callFn('email', { workspace_id: ws, lead_id: run.lead_id, subject: p.subject || 'Hi {{first_name}}', body: p.body || '' }); return { ok: r.ok, msg: `email ${r.msg}`, outs: [0] }; }
    case 'wa.wait': if (!lead) return needLead(); return { ok: true, msg: `waiting up to ${+p.hours || 24} h for a reply`, waitReplyMs: (+p.hours || 24) * 36e5 };
    case 'logic.wait': { const ms = Math.max(1, +p.amount || 1) * ({ minutes: 6e4, hours: 36e5, days: 864e5 } as Record<string, number>)[p.unit || 'days']; return { ok: true, msg: `waiting ${+p.amount || 1} ${p.unit || 'days'}`, waitMs: ms || 864e5 }; }
    case 'logic.split': { const a = Math.random() * 100 < (+p.pct || 50); return { ok: true, msg: a ? 'A' : 'B', outs: [a ? 0 : 1] }; }
    case 'logic.if': {
      if (!lead) return needLead();
      const map: Record<string, string> = { Budget: 'budget', Source: 'source', City: 'city', Tag: 'tag', Stage: 'stage', 'Business type': 'business_type' };
      const raw = lead[map[p.field || 'Budget'] ?? 'budget'], v = String(p.value ?? ''), a = String(raw ?? '').toLowerCase(), b = v.toLowerCase(), na = Number(raw), nb = Number(v.replace(/[^\d.]/g, ''));
      const yes = ({ is: a === b, 'is not': a !== b, above: na > nb, below: na < nb, contains: a.includes(b) } as Record<string, boolean>)[p.op || 'is'] ?? false;
      return { ok: true, msg: `${p.field || 'Budget'} ${p.op || 'is'} ${v} → ${yes ? 'yes' : 'no'}`, outs: [yes ? 0 : 1] };
    }
    case 'ai.reply': case 'ai.score': case 'ai.intent': {
      if (!lead) return needLead();
      const { data: m } = await db.from('messages').select('direction, text, time').eq('workspace_id', ws).eq('lead_id', run.lead_id).order('time', { ascending: false }).limit(8);
      const chat = (m ?? []).reverse().map((x: any) => `${x.direction === 'in' ? 'Customer' : 'Business'}: ${String(x.text ?? '').slice(0, 300)}`).join('\n') || '(no messages yet)';
      const info = `Lead: ${lead.name} · city ${lead.city || '-'} · source ${lead.source || '-'} · budget ${lead.budget ?? '-'} · stage ${lead.stage} · tag ${lead.tag || '-'}\nChat:\n${chat}`;
      try {
        if (n.type === 'ai.reply') { const txt = (await ai(`You reply on WhatsApp for a business. ${p.prompt || 'Reply politely and briefly.'} Reply with the message text only, max 600 characters.`, info)).slice(0, 900); const r = await callFn('wa-send', { workspace_id: ws, lead_id: run.lead_id, text: txt }); return { ok: r.ok, msg: `AI reply ${r.msg}`, outs: [0] }; }
        if (n.type === 'ai.score') { const t = (await ai(`Score this sales lead as exactly one word: hot, warm or cold. ${p.criteria ? 'Hot means: ' + p.criteria : ''}`, info)).toLowerCase(); const k = /hot/.test(t) ? 0 : /warm/.test(t) ? 1 : 2; return { ok: true, msg: ['hot', 'warm', 'cold'][k], outs: [k] }; }
        const t = (await ai(`Classify the customer's last message as exactly one word: buying, question or other. ${p.hint || ''}`, info)).toLowerCase(); const k = /buy/.test(t) ? 0 : /question/.test(t) ? 1 : 2; return { ok: true, msg: ['buying', 'question', 'other'][k], outs: [k] };
      } catch (e) { return { ok: false, msg: (e as Error).message, outs: [n.type === 'ai.reply' ? 0 : 2] }; }
    }
    case 'n8n.send': case 'n8n.http': {
      if (!p.url || p.url === 'https://') return { ok: false, msg: 'add the webhook link', outs: [0] };
      let u: URL; try { u = safeUrl(p.url); } catch (e) { return { ok: false, msg: (e as Error).message, outs: [0] }; }
      const method = n.type === 'n8n.http' ? (p.method || 'POST') : 'POST';
      const { data: last } = run.lead_id ? await db.from('messages').select('text, direction, time').eq('workspace_id', ws).eq('lead_id', run.lead_id).order('time', { ascending: false }).limit(1).maybeSingle() : { data: null };
      const body = { event: run.trigger_name, workspace_id: ws, lead: lead ? { id: lead.lead_id, name: lead.name, phone: lead.phone, email: lead.email, city: lead.city, state: lead.state, source: lead.source, stage: lead.stage, tag: lead.tag, budget: lead.budget, assigned_to: lead.assigned_to } : null, ...(p.data === 'Lead + last message' && last ? { last_message: last } : {}), at: new Date().toISOString() };
      const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Nodevers-Automation/1.0' }, ...(method === 'GET' ? {} : { body: JSON.stringify(p.data === 'Event only' ? { event: body.event, at: body.at } : body) }), signal: AbortSignal.timeout(15000) }).catch(() => null);
      return { ok: !!r?.ok, msg: r ? `${method} → ${r.status}` : 'could not reach the link', outs: [0] };
    }
  }
  if (n.type.startsWith('trg.')) return { ok: true, msg: 'trigger', outs: [0] };
  return { ok: true, msg: n.type.startsWith('meta.') || n.type === 'n8n.in' ? 'skipped — not live yet' : 'skipped', outs: [0] };
}

/** run items that are due; pause at waits */
async function advance(ws: string, f: Flow, run: any) {
  const now = Date.now(); let pending: Item[] = Array.isArray(run.pending) ? run.pending : [];
  const log: any[] = Array.isArray(run.log) ? run.log : [];
  let steps = run.steps || 0, waitReply: { node: string; until: number } | null = null;
  if (run.wait_node && run.since) { const wn = f.nodes.find((x) => x.id === run.wait_node); if (wn) waitReply = { node: wn.id, until: new Date(run.since).getTime() + (+(wn.p?.hours) || 24) * 36e5 }; }
  const later: Item[] = [];
  while (pending.length) {
    const it = pending.shift()!;
    if (it.at && new Date(it.at).getTime() > now) { later.push(it); continue; }
    const n = f.nodes.find((x) => x.id === it.n); if (!n) continue;
    if (++steps > MAX_STEPS) { log.push({ at: new Date().toISOString(), node: n.id, name: 'Stopped', ok: false, msg: `more than ${MAX_STEPS} steps — loop?` }); pending = []; break; }
    let r; try { r = await step(ws, f, n, run); } catch (e) { r = { ok: false, msg: (e as Error).message, outs: [0] }; }
    log.push({ at: new Date().toISOString(), node: n.id, name: nameOf(n), ok: r.ok, msg: String(r.msg).slice(0, 200) });
    if (r.waitMs) nextOf(f, n.id).forEach((id) => later.push({ n: id, at: new Date(now + r.waitMs!).toISOString() }));
    else if (r.waitReplyMs) waitReply = { node: n.id, until: now + r.waitReplyMs };
    else (r.outs ?? [0]).forEach((o) => nextOf(f, n.id, o).forEach((id) => pending.push({ n: id })));
  }
  const nextAt = later.length ? Math.min(...later.map((x) => new Date(x.at!).getTime())) : null;
  const upd: any = { pending: later, log: log.slice(-80), steps, updated_at: new Date().toISOString() };
  if (waitReply) Object.assign(upd, { status: 'waiting_reply', wait_node: waitReply.node, since: run.wait_node === waitReply.node && run.since ? run.since : new Date().toISOString(), next_at: new Date(nextAt ? Math.min(nextAt, waitReply.until) : waitReply.until).toISOString() });
  else if (later.length) Object.assign(upd, { status: 'waiting', wait_node: null, since: null, next_at: new Date(nextAt!).toISOString() });
  else Object.assign(upd, { status: 'done', wait_node: null, since: null, next_at: null });
  await db.from('automation_runs').update(upd).eq('id', run.id);
  return upd.status;
}

async function startRuns(ws: string, f: Flow, ev: any) {
  const lead = await getLead(ws, ev.lead_id); let n = 0;
  const trigs = f.nodes.filter((x) => x.type.startsWith('trg.') && matches(x, ev, lead));
  for (const t of trigs) {
    if (ev.kind !== 'test') { const { count } = await db.from('automation_runs').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('trigger_node', t.id).eq('lead_id', ev.lead_id).gte('created_at', new Date(Date.now() - 120000).toISOString()); if (count) continue; }
    const { data: run } = await db.from('automation_runs').insert({ workspace_id: ws, trigger_node: t.id, trigger_name: (ev.kind === 'test' ? 'Test · ' : '') + nameOf(t), lead_id: ev.lead_id, status: 'running', pending: nextOf(f, t.id).map((id) => ({ n: id })), log: [{ at: new Date().toISOString(), node: t.id, name: nameOf(t), ok: true, msg: ev.kind === 'wamsg' ? `“${String(ev.data?.text ?? '').slice(0, 80)}”` : ev.kind === 'stage' ? `→ ${ev.data?.stage}` : ev.kind === 'tag' ? `tag ${ev.data?.tag}` : 'started' }] }).select('*').single();
    if (run) { await advance(ws, f, run); n++; }
  }
  // a reply resumes "Wait for reply" runs of this lead
  if (ev.kind === 'wamsg' && ev.lead_id) {
    const { data: w } = await db.from('automation_runs').update({ status: 'running' }).eq('workspace_id', ws).eq('lead_id', ev.lead_id).eq('status', 'waiting_reply').select('*');
    for (const run of w ?? []) { run.pending = (run.pending ?? []).concat(nextOf(f, run.wait_node, 0).map((id) => ({ n: id }))); run.log = (run.log ?? []).concat([{ at: new Date().toISOString(), node: run.wait_node, name: 'Wait for reply', ok: true, msg: 'replied' }]); run.wait_node = null; run.since = null; await advance(ws, f, run); n++; }
  }
  return n;
}

async function processEvents() {
  const { data: evs } = await db.from('automation_events').select('*').is('done_at', null).order('id').limit(100);
  if (!evs?.length) return 0;
  const { data: claimed } = await db.from('automation_events').update({ done_at: new Date().toISOString() }).in('id', evs.map((e: any) => e.id)).is('done_at', null).select('id');
  const mine = new Set((claimed ?? []).map((x: any) => x.id)), flows = new Map<string, Flow | null>(); let n = 0;
  for (const ev of evs.filter((e: any) => mine.has(e.id))) {
    if (!flows.has(ev.workspace_id)) flows.set(ev.workspace_id, await loadFlow(ev.workspace_id));
    const f = flows.get(ev.workspace_id); if (!f) continue;
    const { data: st } = await db.rpc('ws_state', { ws: ev.workspace_id }); if (st === 'locked') continue;
    n += await startRuns(ev.workspace_id, f, ev);
  }
  return n;
}
async function processDue() {
  const now = new Date().toISOString();
  const { data: due } = await db.from('automation_runs').select('id').in('status', ['waiting', 'waiting_reply']).lte('next_at', now).order('next_at').limit(100);
  let n = 0;
  for (const d of due ?? []) {
    const { data: rows } = await db.from('automation_runs').update({ status: 'running' }).eq('id', d.id).in('status', ['waiting', 'waiting_reply']).select('*'); const run = rows?.[0]; if (!run) continue;
    const f = await loadFlow(run.workspace_id); if (!f) { await db.from('automation_runs').update({ status: 'stopped', next_at: null, log: (run.log ?? []).concat([{ at: now, name: 'Stopped', ok: false, msg: 'automation switched off' }]) }).eq('id', run.id); continue; }
    if (run.wait_node && run.since) {
      const wn = f.nodes.find((x) => x.id === run.wait_node), hours = +(wn?.p?.hours) || 24;
      if (Date.now() - new Date(run.since).getTime() >= hours * 36e5 - 60000) { run.pending = (run.pending ?? []).concat(nextOf(f, run.wait_node, 1).map((id) => ({ n: id }))); run.log = (run.log ?? []).concat([{ at: now, node: run.wait_node, name: 'Wait for reply', ok: true, msg: 'no reply' }]); run.wait_node = null; run.since = null; }
    }
    await advance(run.workspace_id, f, run); n++;
  }
  return n;
}
async function processSchedules() {
  const { data: rows } = await db.from('flows').select('workspace_id, flow_json').eq('flow_id', 'AUTOMATION').like('flow_json', '%"live":true%').limit(500);
  const hm = istHM(), day = istDate(), wd = istDay(), dom = day.slice(8); let n = 0;
  for (const r of rows ?? []) {
    let f: Flow; try { f = JSON.parse(r.flow_json); } catch { continue; } if (!f.live) continue; f.links = f.links ?? [];
    { const { data: on } = await db.rpc('ws_feature', { ws: r.workspace_id, k: 'automation' }); if (on === false) continue; }
    for (const t of f.nodes.filter((x) => x.type === 'trg.schedule')) {
      const p = t.p ?? {}, time = /^\d{1,2}:\d{2}$/.test(p.time || '') ? String(p.time).padStart(5, '0') : '09:00', every = p.every || 'Day';
      if (hm < time || (every === 'Week' && wd !== 'Mon') || (every === 'Month' && dom !== '01')) continue;
      const { count } = await db.from('automation_runs').select('id', { count: 'exact', head: true }).eq('workspace_id', r.workspace_id).eq('trigger_node', t.id).gte('created_at', `${day}T00:00:00+05:30`); if (count) continue;
      const { data: run } = await db.from('automation_runs').insert({ workspace_id: r.workspace_id, trigger_node: t.id, trigger_name: nameOf(t), lead_id: null, status: 'running', pending: nextOf(f, t.id).map((id) => ({ n: id })), log: [{ at: new Date().toISOString(), node: t.id, name: 'Schedule', ok: true, msg: `${every} at ${time}` }] }).select('*').single();
      if (run) { await advance(r.workspace_id, f, run); n++; }
    }
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const { data: sec } = await db.from('app_config').select('value').eq('key', 'cron_secret').maybeSingle();
    if (!sec?.value || req.headers.get('x-cron-secret') !== sec.value) return json({ error: 'Forbidden' }, 403);
    SECRET = sec.value;
    if (b.action === 'run' || b.action === 'cron') {
      const started = await processEvents(), resumed = await processDue(), scheduled = b.action === 'cron' ? await processSchedules() : 0;
      return json({ ok: true, started, resumed, scheduled });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
