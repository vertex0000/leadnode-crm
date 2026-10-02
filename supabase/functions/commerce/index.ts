// Nodevers — commerce: store helpers for every client workspace.
//   action "sheet": downloads a Google Sheet (shared "Anyone with the link") as an Excel file so the website can import all its tabs.
//   Later: Amazon SP-API, Shopify, WooCommerce, Flipkart sync (the Channels tab is ready for them).
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "commerce" → paste → Deploy → turn OFF "Enforce JWT verification".
// No secrets needed.
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const SHEETS = Deno.env.get('SHEETS_URL') ?? 'https://docs.google.com';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const MAX = 15 * 1024 * 1024;

function b64(buf: Uint8Array) {
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const ws = String(b.workspace_id ?? '');
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || !['owner', 'admin', 'member'].includes(m.role)) return json({ error: 'Only team members of this workspace can import.' }, 403);

    if (b.action === 'sheet') {
      const id = String(b.url ?? '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,100})/)?.[1] ?? (/^[a-zA-Z0-9_-]{20,100}$/.test(String(b.url ?? '')) ? String(b.url) : '');
      if (!id) return json({ error: 'Paste the full Google Sheet link (https://docs.google.com/spreadsheets/d/…).' }, 400);
      const r = await fetch(`${SHEETS}/spreadsheets/d/${id}/export?format=xlsx`, { redirect: 'follow', signal: AbortSignal.timeout(25000) }).catch(() => null);
      if (!r) return json({ error: 'Google did not answer — try again in a minute.' }, 502);
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || /text\/html/i.test(type)) return json({ error: 'This Sheet is private. In Google Sheets press Share → General access → "Anyone with the link" (Viewer), then try again.' }, 400);
      if (Number(r.headers.get('content-length') ?? 0) > MAX) return json({ error: 'The Sheet is too big (max 15 MB) — download it as Excel and import parts of it.' }, 400);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > MAX) return json({ error: 'The Sheet is too big (max 15 MB) — download it as Excel and import parts of it.' }, 400);
      return json({ ok: true, file: b64(buf), name: 'Google Sheet.xlsx' });
    }

    if (b.action === 'channels') return json({ ok: true, amazon: 'soon', shopify: 'soon', woocommerce: 'soon', flipkart: 'soon', meesho: 'soon' });
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
