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

async function n8n(url: string, key: string, path: string, method = 'GET') {
  let r: Response;
  try {
    r = await fetch(url + '/api/v1' + path, { method, headers: { 'X-N8N-API-KEY': key, Accept: 'application/json', 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    throw new Error(/timed? ?out|abort/i.test(String(e)) ? 'n8n did not answer in time — is your PC on, Docker running and ngrok open?' : 'Could not reach n8n at this address — is it running and is the link correct?');
  }
  const text = await r.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status === 401 || r.status === 403) throw new Error('n8n rejected the API key — create a new one in n8n → Settings → n8n API.');
  if (r.status === 404 && !j) throw new Error('This address is not an n8n API — check the link (use the main n8n address, not a workflow link).');
  if (/ERR_NGROK|ngrok/i.test(text) && !j) throw new Error('ngrok says the tunnel is offline — start ngrok again on your PC.');
  if (!r.ok) throw new Error('n8n: ' + (j?.message ?? `error ${r.status}`));
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
    return { id: String(w.id), name: String(w.name ?? ''), active: !!w.active, updatedAt: w.updatedAt ?? '', nodes: nodes.length, trigger: trig.length > 0, triggers: trig.map((n: any) => String(n.name ?? '')).slice(0, 3), tags: (w.tags ?? []).map((t: any) => t.name).filter(Boolean) };
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
