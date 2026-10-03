// Nodevers — wa-signup: one-click "Connect with Facebook" (WhatsApp Embedded Signup v4, Tech Provider).
// The client logs in with Facebook, picks/creates their WhatsApp number, and this function finishes the setup:
// code → business token, subscribe our app to their WABA (so the shared wa-webhook gets their messages), register the number.
// Deploy: Supabase → Edge Functions → Deploy a new function → name "wa-signup" → paste → turn OFF "Verify JWT".
// Secrets (Edge Functions → Secrets):
//   META_APP_ID        — Meta app → App settings → Basic → App ID
//   META_APP_SECRET    — same page → App secret (wa-webhook already uses this one)
//   META_ES_CONFIG_ID  — Facebook Login for Business → Configurations → your "WhatsApp Embedded Signup" config ID
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v25.0';
const APP_ID = Deno.env.get('META_APP_ID') ?? '';
const APP_SECRET = Deno.env.get('META_APP_SECRET') ?? '';
const CONFIG_ID = Deno.env.get('META_ES_CONFIG_ID') ?? '';
const SDK_VERSION = (GRAPH.match(/v\d+\.\d+/) ?? ['v25.0'])[0];
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const metaErr = (j: any, fallback: unknown) => j?.error?.error_user_msg || j?.error?.message || String(fallback);

async function roleOf(req: Request, ws: string) {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return null;
  const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', data.user.id).maybeSingle();
  return m?.role ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();

    // Public: the website asks whether one-click connect is switched on (App ID + config ID are not secrets).
    if (b.config) return json(APP_ID && APP_SECRET && CONFIG_ID ? { enabled: true, app_id: APP_ID, config_id: CONFIG_ID, version: SDK_VERSION } : { enabled: false });
    if (!APP_ID || !APP_SECRET || !CONFIG_ID) return json({ error: 'One-click connect is not set up yet (META_APP_ID, META_APP_SECRET, META_ES_CONFIG_ID secrets).' }, 400);

    const ws = String(b.workspace_id ?? '');
    const role = await roleOf(req, ws);
    if (!role) return json({ error: 'Please sign in again.' }, 401);
    if (role !== 'owner' && role !== 'admin') return json({ error: 'Only the owner or an admin can connect WhatsApp.' }, 403);

    const code = String(b.code ?? '').trim(), pid = String(b.phone_number_id ?? '').trim(), waba = String(b.waba_id ?? '').trim();
    const event = String(b.event ?? 'FINISH');
    if (!code) return json({ error: 'Facebook did not return a login code. Please try again.' }, 400);
    if (!/^\d{6,20}$/.test(waba)) return json({ error: 'No WhatsApp Business Account came back from Facebook. Please finish all steps in the popup.' }, 400);
    if (!/^\d{6,20}$/.test(pid)) return json({ error: 'No phone number was added in the popup. Run Connect again and add your business number.' }, 400);

    const taken = await db.from('wa_accounts').select('workspace_id').eq('phone_number_id', pid).neq('workspace_id', ws).maybeSingle();
    if (taken.data) return json({ error: 'This WhatsApp number is already connected to another workspace.' }, 409);

    // 1. Code → business token (the code lives only ~30 seconds)
    const t = await fetch(`${GRAPH}/oauth/access_token?` + new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, code }));
    const tj = await t.json().catch(() => ({}));
    if (!t.ok || !tj.access_token) return json({ error: 'Facebook login expired or was rejected: ' + metaErr(tj, t.status) + ' — please click Connect again.' }, 400);
    const token = String(tj.access_token);
    const auth = { Authorization: `Bearer ${token}` };

    // 2. Subscribe our app to their WABA → their messages reach the shared wa-webhook
    const s = await fetch(`${GRAPH}/${waba}/subscribed_apps`, { method: 'POST', headers: auth });
    const subscribed = s.ok;
    if (!subscribed) console.error('subscribe failed', waba, await s.text().catch(() => ''));

    // 3. Register the number for Cloud API (not needed for numbers that stay on the WhatsApp Business app — coexistence)
    let registered = event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', registerError = '', pin = '';
    if (!registered) {
      pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const r = await fetch(`${GRAPH}/${pid}/register`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', pin }) });
      const rj = await r.json().catch(() => ({}));
      registered = r.ok;
      if (!r.ok) { registerError = metaErr(rj, r.status); console.error('register failed', pid, registerError); }
    }

    // 4. Number details for the inbox header
    const i = await fetch(`${GRAPH}/${pid}?fields=display_phone_number,verified_name,quality_rating`, { headers: auth });
    const info = await i.json().catch(() => ({}));
    if (!i.ok) return json({ error: 'Connected to Facebook, but Meta did not return the number: ' + metaErr(info, i.status) }, 400);

    const row: Record<string, unknown> = { workspace_id: ws, phone_number_id: pid, waba_id: waba, token, display_phone: info.display_phone_number ?? '', verified_name: info.verified_name ?? '', quality: info.quality_rating ?? '', updated_at: new Date().toISOString(), pin, onboarded_via: 'embedded_signup' };
    let up = await db.from('wa_accounts').upsert(row, { onConflict: 'workspace_id' });
    if (up.error && /pin|onboarded_via/.test(up.error.message)) { delete row.pin; delete row.onboarded_via; up = await db.from('wa_accounts').upsert(row, { onConflict: 'workspace_id' }); }   // before 19_embedded_signup.sql
    if (up.error) return json({ error: up.error.message }, 500);

    return json({ connected: true, display_phone: row.display_phone, verified_name: row.verified_name, quality: row.quality, subscribed, registered, register_error: registerError });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
