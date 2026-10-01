// Nodevers — n8n: connect a workspace to its own n8n (n8n Cloud or self-hosted / Docker) and read workflows + runs.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "n8n" → paste → Deploy → turn OFF "Enforce JWT verification".
// Needs 06_n8n.sql. The n8n API key is stored server-side only (table n8n_accounts) and never sent back to the browser.
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const ALLOW_HTTP = Deno.env.get('N8N_ALLOW_HTTP') === '1';   // local testing only

function cleanUrl(raw: string): string {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('Enter the full n8n address, e.g. https://yourname.ngrok-free.app'); }
  if (u.protocol !== 'https:' && !(ALLOW_HTTP && u.protocol === 'http:')) throw new Error('The address must start with https:// — for n8n on your PC, use the ngrok link.');
  const h = u.hostname.toLowerCase();
  if (!ALLOW_HTTP && (h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === '[::1]'))
    throw new Error('localhost / home-network addresses cannot be reached from the internet. Start ngrok (or a Cloudflare tunnel) and paste that https link.');
  return u.origin;
}

// ---------- what does each node need from the client? ----------
const NODE_CRED: [RegExp, string][] = [
  [/telegram/i, 'telegramApi'], [/googleSheets/i, 'googleSheetsOAuth2Api'], [/gmail/i, 'gmailOAuth2'], [/googleDrive/i, 'googleDriveOAuth2Api'],
  [/googleCalendar/i, 'googleCalendarOAuth2Api'], [/lmChatGoogleGemini|googleGemini|embeddingsGoogleGemini/i, 'googlePalmApi'], [/lmChatOpenAi|openAi|embeddingsOpenAi/i, 'openAiApi'],
  [/lmChatAnthropic|anthropic/i, 'anthropicApi'], [/whatsAppTrigger/i, 'whatsAppTriggerApi'], [/whatsApp/i, 'whatsAppApi'], [/facebookLeadAds/i, 'facebookLeadAdsOAuth2Api'],
  [/facebookGraphApi/i, 'facebookGraphApi'], [/slack/i, 'slackApi'], [/airtable/i, 'airtableTokenApi'], [/notion/i, 'notionApi'], [/emailSend/i, 'smtp'],
  [/supabase/i, 'supabaseApi'], [/hubspot/i, 'hubspotAppToken'], [/lmChatGroq|groq/i, 'groqApi'], [/discord/i, 'discordBotApi'],
];
const SECRETISH = /key|token|secret|password|pass\b|auth/i;
const PLACEHOLDER = /^\s*$|^(your|enter|paste|change|add|put|insert)[\s_-]|^x{3,}|^<.*>$|^todo\b|^\[.*\]$|_here$/i;
const isSettingsNode = (n: any) => /\.set$/i.test(String(n.type ?? '')) && /setting|config|client|variable|env|input/i.test(String(n.name ?? ''));
function setFields(n: any): { name: string; value: string; kind: string; path: string }[] {
  const p = n.parameters ?? {}, out: any[] = [];
  (p.assignments?.assignments ?? []).forEach((a: any, i: number) => out.push({ name: String(a.name ?? ''), value: String(a.value ?? ''), kind: String(a.type ?? 'string'), path: `a:${i}` }));
  for (const t of ['string', 'number', 'boolean']) (p.values?.[t] ?? []).forEach((v: any, i: number) => out.push({ name: String(v.name ?? ''), value: String(v.value ?? ''), kind: t, path: `v:${t}:${i}` }));
  return out.filter((f) => f.name);
}
function analyze(n: any) {
  const type = String(n.type ?? ''), creds = n.credentials ?? {}, have = Object.keys(creds), p = n.parameters ?? {};
  let need = '';
  if (!have.length && !n.disabled) {
    if (/httpRequest/i.test(type)) { if (p.authentication === 'predefinedCredentialType' && p.nodeCredentialType) need = String(p.nodeCredentialType); else if (p.authentication === 'genericCredentialType' && p.genericAuthType) need = String(p.genericAuthType); }
    else { const m = NODE_CRED.find(([re]) => re.test(type)); if (m) need = m[1]; }
  }
  const cred = need ? { type: need, ok: false } : have.length ? { type: have[0], ok: true, name: String(creds[have[0]]?.name ?? '') } : null;
  let fields: any[] | null = null, miss = 0;
  if (isSettingsNode(n)) { fields = setFields(n).map((f) => { const empty = PLACEHOLDER.test(f.value); if (empty) miss++; const secret = SECRETISH.test(f.name); return { name: f.name, kind: f.kind, path: f.path, secret, filled: !empty, value: secret ? '' : (empty ? '' : f.value) }; }); }
  const todo = (cred && !cred.ok ? 1 : 0) + (miss ? 1 : 0);
  return { cred, fields, miss, todo };
}
const SETTINGS_OK = ['saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder', 'callerPolicy', 'callerIds'];
async function putWorkflow(url: string, key: string, w: any) {
  const settings: any = {}; for (const k of SETTINGS_OK) if (w.settings?.[k] !== undefined) settings[k] = w.settings[k];
  const body = (st: any) => JSON.stringify({ name: w.name, nodes: w.nodes, connections: w.connections ?? {}, settings: st, ...(w.staticData ? { staticData: w.staticData } : {}) });
  const go = (st: any) => fetch(url + '/api/v1/workflows/' + encodeURIComponent(w.id), { method: 'PUT', headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json', Accept: 'application/json', 'ngrok-skip-browser-warning': '1' }, body: body(st), signal: AbortSignal.timeout(15000) });
  let r = await go(settings);
  if (r.status === 400) { const t = await r.text(); if (/settings/i.test(t)) r = await go({ executionOrder: settings.executionOrder ?? 'v1' }); else throw new Error('n8n did not accept the change: ' + t.slice(0, 200)); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('n8n did not accept the change: ' + (j?.message ?? r.status)); }
}

async function n8n(url: string, key: string, path: string, method = 'GET', payload?: unknown) {
  let r: Response;
  try {
    r = await fetch(url + '/api/v1' + path, { method, headers: { 'X-N8N-API-KEY': key, Accept: 'application/json', 'ngrok-skip-browser-warning': '1', ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(/timed? ?out|abort/i.test(String(e)) ? 'n8n did not answer in time — is your PC on, Docker running and ngrok open?' : 'Could not reach n8n at this address — is it running and is the link correct?');
  }
  const text = await r.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status === 401 || r.status === 403) throw new Error('n8n rejected the API key — create a new one in n8n → Settings → n8n API.');
  if (r.status === 404 && !j) throw new Error('This address is not an n8n API — check the link (use the main n8n address, not a workflow link).');
  if (/ERR_NGROK|ngrok/i.test(text) && !j) throw new Error('ngrok says the tunnel is offline — start ngrok again on your PC.');
  if (!r.ok) throw new Error('n8n: ' + (j?.message ?? `error ${r.status}`) + (j?.description ? ' — ' + j.description : ''));
  if (!j) throw new Error('This address did not answer like n8n — check the link.');
  return j;
}

async function allWorkflows(url: string, key: string) {
  const out: any[] = []; let cursor = '';
  for (let i = 0; i < 4; i++) {
    const j = await n8n(url, key, `/workflows?limit=250${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    out.push(...(j.data ?? [])); cursor = j.nextCursor ?? ''; if (!cursor) break;
  }
  // n8n can only switch on workflows that start with a real trigger (schedule, webhook, app trigger…), not "Manual"/"Execute workflow"/"Error" triggers
  const isTrigger = (t: string) => /(trigger|webhook|cron|interval)$/i.test(t) && !/(manualTrigger|executeWorkflowTrigger|errorTrigger)$/i.test(t);
  return out.map((w) => {
    const nodes = Array.isArray(w.nodes) ? w.nodes : [];
    const trig = nodes.filter((n: any) => isTrigger(String(n.type ?? '')));
    const todo = nodes.reduce((t: number, n: any) => t + analyze(n).todo, 0);
    return { id: String(w.id), name: String(w.name ?? ''), active: !!w.active, updatedAt: w.updatedAt ?? '', nodes: nodes.length, todo, trigger: trig.length > 0, triggers: trig.map((n: any) => String(n.name ?? '')).slice(0, 3), tags: (w.tags ?? []).map((t: any) => t.name).filter(Boolean) };
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();
    const ws = String(b.workspace_id ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m) return json({ error: 'You do not have permission here.' }, 403);
    const admin = m.role === 'owner' || m.role === 'admin';
    const act = String(b.action ?? '');

    if (act === 'connect') {
      if (!admin) return json({ error: 'Only the owner or an admin can connect n8n.' }, 403);
      const url = cleanUrl(b.url);
      const old = await db.from('n8n_accounts').select('api_key').eq('workspace_id', ws).maybeSingle();
      if (old.error) return json({ error: /n8n_accounts/.test(old.error.message) ? 'Run the database update 06_n8n.sql first.' : old.error.message }, 500);
      const key = String(b.api_key ?? '').trim() || old.data?.api_key || '';
      if (!key) return json({ error: 'Paste the n8n API key.' }, 400);
      const wfs = await allWorkflows(url, key);
      const up = await db.from('n8n_accounts').upsert({ workspace_id: ws, url, api_key: key, workflows: wfs.length, updated_at: new Date().toISOString() });
      if (up.error) return json({ error: up.error.message }, 500);
      return json({ ok: true, url, workflows: wfs });
    }

    const { data: acc, error: accErr } = await db.from('n8n_accounts').select('*').eq('workspace_id', ws).maybeSingle();
    if (accErr) return json({ error: /n8n_accounts/.test(accErr.message) ? 'Run the database update 06_n8n.sql first.' : accErr.message }, 500);
    if (act === 'status') return json(acc ? { connected: true, url: acc.url, workflows: acc.workflows, updated_at: acc.updated_at } : { connected: false });
    if (!acc) return json({ error: 'Connect n8n first (n8n Services → Connect n8n).' }, 400);

    if (act === 'disconnect') {
      if (!admin) return json({ error: 'Only the owner or an admin can disconnect n8n.' }, 403);
      await db.from('n8n_accounts').delete().eq('workspace_id', ws);
      return json({ ok: true });
    }
    if (act === 'workflows') {
      const wfs = await allWorkflows(acc.url, acc.api_key);
      await db.from('n8n_accounts').update({ workflows: wfs.length }).eq('workspace_id', ws);
      return json({ ok: true, url: acc.url, workflows: wfs });
    }
    if (act === 'executions') {
      const wf = b.workflow_id ? `&workflowId=${encodeURIComponent(String(b.workflow_id))}` : '';
      const j = await n8n(acc.url, acc.api_key, `/executions?limit=${Math.min(50, Number(b.limit) || 20)}${wf}`);
      const runs = (j.data ?? []).map((e: any) => ({ id: String(e.id), workflowId: String(e.workflowId ?? ''), status: e.status ?? (e.finished ? 'success' : 'error'), mode: e.mode ?? '', startedAt: e.startedAt ?? '', stoppedAt: e.stoppedAt ?? '' }));
      return json({ ok: true, runs });
    }
    if (act === 'workflow') {
      const w = await n8n(acc.url, acc.api_key, `/workflows/${encodeURIComponent(String(b.id ?? ''))}`);
      const nodes = (w.nodes ?? []).map((n: any) => ({ name: String(n.name), type: String(n.type ?? ''), position: Array.isArray(n.position) ? n.position : [0, 0], disabled: !!n.disabled, ...analyze(n) }));
      return json({ ok: true, wf: { id: String(w.id), name: w.name, active: !!w.active, nodes, connections: w.connections ?? {} } });
    }
    if (act === 'cred_schema') {
      const type = String(b.type ?? '').replace(/[^\w]/g, '');
      if (/oauth/i.test(type)) return json({ ok: true, oauth: true, fields: [] });
      const j = await n8n(acc.url, acc.api_key, `/credentials/schema/${type}`);
      const req = new Set(j.required ?? []);
      const fields = Object.entries(j.properties ?? {}).filter(([k]) => !/oauthTokenData|notice/i.test(k)).map(([k, v]: any) => ({ name: k, type: v.type ?? 'string', required: req.has(k), options: Array.isArray(v.enum) ? v.enum : null, secret: SECRETISH.test(k) }));
      return json({ ok: true, oauth: false, fields });
    }
    if (act === 'add_cred' || act === 'set_fields') {
      if (m.role === 'client') return json({ error: 'View-only access.' }, 403);
      const id = String(b.id ?? ''), nodeName = String(b.node ?? '');
      const w = await n8n(acc.url, acc.api_key, `/workflows/${encodeURIComponent(id)}`);
      const node = (w.nodes ?? []).find((n: any) => n.name === nodeName);
      if (!node) return json({ error: 'That step was not found — refresh and try again.' }, 400);
      if (act === 'add_cred') {
        const type = String(b.type ?? '').replace(/[^\w]/g, ''), data = b.data && typeof b.data === 'object' ? b.data : {};
        if (!type) return json({ error: 'Which connection?' }, 400);
        const c = await n8n(acc.url, acc.api_key, '/credentials', 'POST', { name: `${String(b.label || nodeName).slice(0, 60)} (Nodevers)`, type, data });
        node.credentials = { ...(node.credentials ?? {}), [type]: { id: String(c.id), name: String(c.name) } };
        await putWorkflow(acc.url, acc.api_key, w);
        return json({ ok: true, credential: c.name });
      }
      const vals = b.values && typeof b.values === 'object' ? b.values : {};
      const p = node.parameters ?? {}; let changed = 0;
      for (const f of setFields(node)) {
        if (!(f.name in vals)) continue;
        const v = String(vals[f.name] ?? ''); if (SECRETISH.test(f.name) && !v) continue;       // empty secret = keep the old one
        const val = f.kind === 'number' ? (v === '' ? '' : Number(v)) : f.kind === 'boolean' ? /^(true|1|yes)$/i.test(v) : v;
        if (f.path.startsWith('a:')) p.assignments.assignments[Number(f.path.slice(2))].value = val;
        else { const [, t, i] = f.path.split(':'); p.values[t][Number(i)].value = val; }
        changed++;
      }
      if (!changed) return json({ error: 'Nothing to save.' }, 400);
      node.parameters = p;
      await putWorkflow(acc.url, acc.api_key, w);
      return json({ ok: true, changed });
    }
    if (act === 'toggle') {
      if (m.role === 'client') return json({ error: 'View-only access.' }, 403);
      const id = String(b.id ?? ''); if (!id) return json({ error: 'Which workflow?' }, 400);
      const j = await n8n(acc.url, acc.api_key, `/workflows/${encodeURIComponent(id)}/${b.active ? 'activate' : 'deactivate'}`, 'POST');
      return json({ ok: true, active: !!j.active });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 400);
  }
});
