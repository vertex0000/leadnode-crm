// Nodevers — wa-connect: save a workspace's WhatsApp number. The token is stored server-side only.
// Deploy: Supabase → Edge Functions → Deploy a new function → name "wa-connect" → paste → turn OFF "Verify JWT".
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0';
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

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
    const ws = String(b.workspace_id ?? '');
    const role = await roleOf(req, ws);
    if (!role) return json({ error: 'Please sign in again.' }, 401);
    if (role !== 'owner' && role !== 'admin') return json({ error: 'Only the owner or an admin can connect WhatsApp.' }, 403);

    if (b.disconnect) { await db.from('wa_accounts').delete().eq('workspace_id', ws); return json({ connected: false }); }

    const pid = String(b.phone_number_id ?? '').trim(), waba = String(b.waba_id ?? '').trim(), token = String(b.token ?? '').trim();
    if (!/^\d{6,20}$/.test(pid)) return json({ error: 'Phone number ID should be only digits (WhatsApp Manager → API Setup).' }, 400);
    if (waba && !/^\d{6,20}$/.test(waba)) return json({ error: 'WhatsApp Business Account ID should be only digits.' }, 400);
    if (token.length < 20) return json({ error: 'Paste the permanent access token (starts with EAA…).' }, 400);

    const r = await fetch(`${GRAPH}/${pid}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${token}` } });
    const info = await r.json();
    if (!r.ok) return json({ error: 'Meta did not accept these details: ' + (info?.error?.message ?? r.status) }, 400);

    const taken = await db.from('wa_accounts').select('workspace_id').eq('phone_number_id', pid).neq('workspace_id', ws).maybeSingle();
    if (taken.data) return json({ error: 'This WhatsApp number is already connected to another workspace.' }, 409);

    let subscribed = false;
    if (waba) { const s = await fetch(`${GRAPH}/${waba}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); subscribed = s.ok; }

    const row = { workspace_id: ws, phone_number_id: pid, waba_id: waba, token, display_phone: info.display_phone_number ?? '', verified_name: info.verified_name ?? '', quality: info.quality_rating ?? '', updated_at: new Date().toISOString() };
    const up = await db.from('wa_accounts').upsert(row, { onConflict: 'workspace_id' });
    if (up.error) return json({ error: up.error.message }, 500);
    return json({ connected: true, display_phone: row.display_phone, verified_name: row.verified_name, quality: row.quality, subscribed });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
