// Nodevers — wa-connect: save a workspace's WhatsApp number. The token and the App secret are stored server-side only.
// Deploy: Supabase → Edge Functions → Deploy a new function → name "wa-connect" → paste → turn OFF "Verify JWT".
// Two ways to connect (Admin Console → Settings → Connect methods):
//   A "own"  — the client's own Meta app: Phone number ID + WABA ID + permanent token + App secret; its own webhook verify token (SQL 19).
//   B "app"  — "Connect with Facebook" (Meta Embedded Signup through the platform's Meta app — needs Meta Tech Provider). Secrets for B:
//              META_APP_SECRET (already there) and META_APP_ID (or the App ID typed in Admin Console). Off until the admin switches it on.
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRAPH = (Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const APP_SECRET = Deno.env.get('META_APP_SECRET') ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---- which connect methods the admin switched on (platform_settings: names + on/off + public IDs only) ----
const METHOD_DEF: any = { wa: { a: { on: true, name: 'Own Meta app' }, b: { on: false, name: 'Connect with Facebook' } } };
async function methods(k: string) {
  const { data } = await db.from('platform_settings').select('value').eq('key', 'connectModesJson').maybeSingle();
  let c: any = {}; try { c = JSON.parse(data?.value ?? '{}') ?? {}; } catch { /* default */ }
  const d = METHOD_DEF[k] ?? { a: { on: true, name: 'Own app' }, b: { on: false, name: 'One click' } }, x = c?.[k] ?? {};
  return { a: { ...d.a, ...(x.a ?? {}) }, b: { ...d.b, ...(x.b ?? {}) } };
}

async function hmacHex(secret: string, text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))).map(x => x.toString(16).padStart(2, '0')).join('');
}
const newToken = () => 'nv' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

async function userOf(req: Request) {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = await db.auth.getUser(jwt);
  return error || !data.user ? null : data.user;
}
async function roleOf(uid: string, ws: string) {
  const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', uid).maybeSingle();
  return m?.role ?? null;
}
async function platformAdmin(user: any) {
  const { data: role, error } = await db.rpc('platform_role_of', { uid: user.id });
  if (!error) return role === 'super' || role === 'admin';
  if (!user?.email || !user.email_confirmed_at) return false;                     // before SQL 19
  const { data } = await db.from('platform_admins').select('role').eq('email', String(user.email).toLowerCase()).maybeSingle();
  return !!data && ['super', 'admin'].includes(data.role);
}

/** save the number + make sure the workspace has its webhook verify token */
async function saveAccount(ws: string, row: any, appSecret?: string) {
  let up = await db.from('wa_accounts').upsert(row, { onConflict: 'workspace_id' });
  if (up.error && /connect_mode/.test(up.error.message)) { const { connect_mode: _m, ...old } = row; up = await db.from('wa_accounts').upsert(old, { onConflict: 'workspace_id' }); }   // before SQL 19
  if (up.error) throw new Error(up.error.message);
  const { data: h } = await db.from('wa_hooks').select('workspace_id').eq('workspace_id', ws).maybeSingle();
  if (!h) await db.from('wa_hooks').insert({ workspace_id: ws, verify_token: newToken(), app_secret: appSecret ?? '' });
  else if (appSecret !== undefined) await db.from('wa_hooks').update({ app_secret: appSecret, last_bad_sig_at: null, updated_at: new Date().toISOString() }).eq('workspace_id', ws);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const user = await userOf(req);
    if (!user) return json({ error: 'Please sign in again.' }, 401);

    // ---- Admin Console: which server secrets are set (yes / no only — never the values) ----
    if (b.action === 'methods_env') {
      if (!(await platformAdmin(user))) return json({ error: 'Platform admins only.' }, 403);
      const has = (k: string) => !!(Deno.env.get(k) ?? '').trim();
      return json({ ok: true, env: { META_APP_SECRET: has('META_APP_SECRET'), META_APP_ID: has('META_APP_ID'), WA_VERIFY_TOKEN: has('WA_VERIFY_TOKEN'),
        AMAZON_LWA_CLIENT_ID: has('AMAZON_LWA_CLIENT_ID'), AMAZON_LWA_CLIENT_SECRET: has('AMAZON_LWA_CLIENT_SECRET'), AMAZON_APP_ID: has('AMAZON_APP_ID'),
        SHOPIFY_CLIENT_ID: has('SHOPIFY_CLIENT_ID'), SHOPIFY_CLIENT_SECRET: has('SHOPIFY_CLIENT_SECRET') } });
    }

    const ws = String(b.workspace_id ?? '');
    const role = await roleOf(user.id, ws);
    if (!role) return json({ error: 'Please sign in again.' }, 401);
    if (role !== 'owner' && role !== 'admin') return json({ error: 'Only the owner or an admin can connect WhatsApp.' }, 403);

    if (b.disconnect) { await db.from('wa_accounts').delete().eq('workspace_id', ws); return json({ connected: false }); }
    const M = await methods('wa');
    const { data: cur } = await db.from('wa_accounts').select('connect_mode, phone_number_id').eq('workspace_id', ws).maybeSingle();

    // ================= Option B: Connect with Facebook (Embedded Signup) =================
    if (b.action === 'embedded') {
      if (!M.b.on) return json({ error: `“${M.b.name}” is switched off. Use “${M.a.name}” instead.` }, 403);
      const appId = (Deno.env.get('META_APP_ID') || String(M.b.appId ?? '')).trim();
      if (!appId || !APP_SECRET) return json({ error: 'Connect with Facebook is not set up on the server yet (META_APP_ID / META_APP_SECRET). Please tell the Nodevers team.' }, 500);
      const code = String(b.code ?? '').trim(), pin = String(b.pin ?? '').trim();
      if (code.length < 10) return json({ error: 'Facebook did not send a login code — please try again.' }, 400);
      if (pin && !/^\d{6}$/.test(pin)) return json({ error: 'The two-step PIN must be 6 digits.' }, 400);
      const ex = await fetch(`${GRAPH}/oauth/access_token?` + new URLSearchParams({ client_id: appId, client_secret: APP_SECRET, code }));
      const ej = await ex.json().catch(() => ({}));
      if (!ex.ok || !ej.access_token) return json({ error: 'Facebook did not accept the login: ' + (ej?.error?.message ?? ex.status) }, 400);
      const token = String(ej.access_token);
      let pid = String(b.phone_number_id ?? '').trim(), waba = String(b.waba_id ?? '').trim();
      if (!/^\d{6,20}$/.test(waba)) {          // the popup did not tell us → ask Meta which WhatsApp account was shared
        const dt = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${appId}|${APP_SECRET}` } }).then(r => r.json()).catch(() => ({}));
        waba = String((dt?.data?.granular_scopes ?? []).find((g: any) => g.scope === 'whatsapp_business_management')?.target_ids?.[0] ?? '');
      }
      if (!/^\d{6,20}$/.test(waba)) return json({ error: 'No WhatsApp Business account was shared. Press Connect with Facebook again and pick your WhatsApp account.' }, 400);
      if (!/^\d{6,20}$/.test(pid)) {
        const pn = await fetch(`${GRAPH}/${waba}/phone_numbers?fields=id,display_phone_number`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({}));
        pid = String(pn?.data?.[0]?.id ?? '');
      }
      if (!/^\d{6,20}$/.test(pid)) return json({ error: 'No phone number found in that WhatsApp account. Add a number in Facebook, then try again.' }, 400);
      const taken = await db.from('wa_accounts').select('workspace_id').eq('phone_number_id', pid).neq('workspace_id', ws).maybeSingle();
      if (taken.data) return json({ error: 'This WhatsApp number is already connected to another workspace.' }, 409);
      const warn: string[] = [];
      if (pin) { const rg = await fetch(`${GRAPH}/${pid}/register`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', pin }) }); if (!rg.ok) { const rj = await rg.json().catch(() => ({})); warn.push('Number registration: ' + (rj?.error?.message ?? rg.status)); } }
      const s = await fetch(`${GRAPH}/${waba}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!s.ok) warn.push('Webhook subscription failed — press Connect again.');
      const r = await fetch(`${GRAPH}/${pid}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${token}` } });
      const info = await r.json().catch(() => ({}));
      const row = { workspace_id: ws, phone_number_id: pid, waba_id: waba, token, connect_mode: 'app', display_phone: info.display_phone_number ?? '', verified_name: info.verified_name ?? '', quality: info.quality_rating ?? '', updated_at: new Date().toISOString() };
      await saveAccount(ws, row);
      return json({ connected: true, mode: 'app', display_phone: row.display_phone, verified_name: row.verified_name, quality: row.quality, subscribed: s.ok, warning: warn.join(' · ') });
    }

    // ================= Option A: own Meta app (manual) =================
    if (!M.a.on && cur?.connect_mode !== 'own') return json({ error: `“${M.a.name}” is switched off. Use “${M.b.name}” instead.` }, 403);
    const pid = String(b.phone_number_id ?? '').trim(), waba = String(b.waba_id ?? '').trim(), token = String(b.token ?? '').trim();
    const appSecret = String(b.app_secret ?? '').trim().toLowerCase();
    if (!/^\d{6,20}$/.test(pid)) return json({ error: 'Phone number ID should be only digits (WhatsApp Manager → API Setup).' }, 400);
    if (waba && !/^\d{6,20}$/.test(waba)) return json({ error: 'WhatsApp Business Account ID should be only digits.' }, 400);
    if (token.length < 20) return json({ error: 'Paste the permanent access token (starts with EAA…).' }, 400);
    if (appSecret && !/^[a-f0-9]{32}$/.test(appSecret)) return json({ error: 'The App secret is 32 letters and numbers (Meta app → App settings → Basic → App secret → Show).' }, 400);
    const { data: hook } = await db.from('wa_hooks').select('app_secret').eq('workspace_id', ws).maybeSingle();
    if (!appSecret && !hook?.app_secret) return json({ error: 'Paste your Meta App secret (Meta app → App settings → Basic → App secret). Without it, Meta’s incoming messages can not be checked.' }, 400);

    // the App secret is checked with Meta: appsecret_proof only works when the secret belongs to the token's app
    const proof = await hmacHex(appSecret || hook!.app_secret, token);
    const r = await fetch(`${GRAPH}/${pid}?fields=display_phone_number,verified_name,quality_rating&appsecret_proof=${proof}`, { headers: { Authorization: `Bearer ${token}` } });
    const info = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = String(info?.error?.message ?? r.status);
      if (/appsecret_proof/i.test(msg)) return json({ error: 'The App secret does not belong to the app of this token. Copy the App secret from the same Meta app you made the token in.' }, 400);
      return json({ error: 'Meta did not accept these details: ' + msg }, 400);
    }

    const taken = await db.from('wa_accounts').select('workspace_id').eq('phone_number_id', pid).neq('workspace_id', ws).maybeSingle();
    if (taken.data) return json({ error: 'This WhatsApp number is already connected to another workspace.' }, 409);

    let subscribed = false;
    if (waba) { const s = await fetch(`${GRAPH}/${waba}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); subscribed = s.ok; }

    const row = { workspace_id: ws, phone_number_id: pid, waba_id: waba, token, connect_mode: 'own', display_phone: info.display_phone_number ?? '', verified_name: info.verified_name ?? '', quality: info.quality_rating ?? '', updated_at: new Date().toISOString() };
    await saveAccount(ws, row, appSecret || undefined);
    return json({ connected: true, mode: 'own', display_phone: row.display_phone, verified_name: row.verified_name, quality: row.quality, subscribed });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
