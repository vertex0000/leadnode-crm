// Nodevers — lead-in: the workspace's lead capture link. Website forms, Google Forms (via Apps Script), Zapier / Make / n8n
// (for example Facebook / Instagram Lead Ads) send new leads here and they appear in the CRM — and get the auto welcome.
//   POST https://<project>.supabase.co/functions/v1/lead-in?k=<capture key>   (JSON, form-urlencoded or multipart)
// Fields (any of these names): name / full_name / first_name + last_name · phone / mobile / whatsapp / phone_number · email · city · state
// · business / company · source · message / notes · budget · campaign / form_name / ad_name. Hidden field "_hp" must stay empty (spam trap).
// Optional "redirect" (https link) — a normal HTML form is sent there after saving.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "lead-in" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-lead-key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const cleanPhone = (p: unknown) => { let d = String(p ?? '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1); return d; };
const pick = (o: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) { const v = o[k] ?? o[k.toLowerCase()]; if (v !== undefined && v !== null && String(v).trim()) return String(v).trim(); } return ''; };

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) { const j = await req.json().catch(() => ({})); return (j && typeof j === 'object' ? j : {}) as Record<string, unknown>; }
  if (ct.includes('form')) { const f = await req.formData().catch(() => null); const o: Record<string, unknown> = {}; f?.forEach((v, k) => { o[k] = typeof v === 'string' ? v : ''; }); return o; }
  const t = await req.text().catch(() => ''); try { return JSON.parse(t); } catch { return Object.fromEntries(new URLSearchParams(t)); }
}
const thanks = (redirect: string, isForm: boolean, o: unknown, status = 200) => {
  if (isForm && status < 300 && /^https:\/\//i.test(redirect)) return new Response(null, { status: 303, headers: { ...cors, Location: redirect } });
  if (isForm) return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial,sans-serif;display:grid;place-items:center;min-height:90vh;color:#111"><div style="text-align:center"><h2>${status < 300 ? 'Thank you!' : 'Sorry'}</h2><p>${status < 300 ? 'We got your details and will contact you soon.' : String((o as any)?.error ?? 'Something went wrong')}</p></div></body>`, { status, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' } });
  return json(o, status);
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Send leads with POST.' }, 405);
  const url = new URL(req.url), isForm = (req.headers.get('content-type') ?? '').includes('form');
  try {
    const b = await readBody(req), redirect = pick(b, 'redirect', '_redirect');
    if (pick(b, '_hp')) return thanks(redirect, isForm, { ok: true });                      // spam trap: bots fill every field
    const key = url.searchParams.get('k') || req.headers.get('x-lead-key') || pick(b, 'key', '_key');
    if (!/^[a-f0-9]{20,80}$/i.test(key)) return thanks(redirect, isForm, { error: 'Missing or wrong lead capture key.' }, 401);
    const { data: k } = await db.from('lead_capture_keys').select('workspace_id, uses').eq('key', key).maybeSingle();
    if (!k) return thanks(redirect, isForm, { error: 'This lead capture link is not valid any more — copy the new one from Nodevers → Connections.' }, 401);
    const ws = k.workspace_id as string;
    const { data: wst } = await db.rpc('ws_state', { ws }); if (wst === 'locked') return thanks(redirect, isForm, { error: 'This workspace is paused.' }, 402);

    const name = (pick(b, 'name', 'full_name', 'fullName', 'Full Name', 'Name') || [pick(b, 'first_name', 'firstName'), pick(b, 'last_name', 'lastName')].filter(Boolean).join(' ')).slice(0, 120);
    const phone = cleanPhone(pick(b, 'phone', 'phone_number', 'mobile', 'whatsapp', 'Phone', 'contact', 'tel'));
    const email = pick(b, 'email', 'Email', 'email_address').toLowerCase().slice(0, 200);
    if (!name && !phone && !email) return thanks(redirect, isForm, { error: 'Send at least a name with a phone number or email.' }, 400);
    if (phone && !/^\d{8,15}$/.test(phone)) return thanks(redirect, isForm, { error: 'The phone number does not look right.' }, 400);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return thanks(redirect, isForm, { error: 'The email does not look right.' }, 400);
    if (!phone && !email) return thanks(redirect, isForm, { error: 'Add a phone number or an email.' }, 400);
    const source = (pick(b, 'source', 'utm_source', 'platform') || 'Website form').slice(0, 60);
    const extra = [['Message', pick(b, 'message', 'notes', 'comments', 'Message', 'enquiry', 'requirement')], ['Campaign', pick(b, 'campaign', 'campaign_name', 'utm_campaign')], ['Ad', pick(b, 'ad_name', 'ad')], ['Form', pick(b, 'form_name', 'form')]].filter(([, v]) => v).map(([l, v]) => `${l}: ${v}`).join(' · ').slice(0, 1500);

    // already in the CRM? → note it on that lead instead of making a duplicate
    let dup: any = null;
    if (phone) ({ data: dup } = await db.from('leads').select('lead_id').eq('workspace_id', ws).like('phone', `%${phone.slice(-10)}`).limit(1).maybeSingle());
    if (!dup && email) ({ data: dup } = await db.from('leads').select('lead_id').eq('workspace_id', ws).ilike('email', email).limit(1).maybeSingle());
    if (dup) {
      await db.from('activities').insert({ workspace_id: ws, lead_id: dup.lead_id, type: 'Form Submitted', details: `${source}${extra ? ' · ' + extra : ''}`.slice(0, 300), done_by: source });
      await db.from('lead_capture_keys').update({ uses: (k.uses ?? 0) + 1, last_used_at: new Date().toISOString() }).eq('workspace_id', ws);
      return thanks(redirect, isForm, { ok: true, lead_id: dup.lead_id, duplicate: true });
    }
    let stage = 'New Lead';
    const { data: st } = await db.from('settings').select('value').eq('workspace_id', ws).eq('key', 'stagesJson').maybeSingle();
    try { const s = JSON.parse(st?.value ?? 'null'); if (Array.isArray(s) && s[0]) stage = String(s[0]); } catch { /* default */ }
    const budget = Number(String(pick(b, 'budget')).replace(/[^\d.]/g, '')) || null;
    const { data: n, error } = await db.from('leads').insert({ workspace_id: ws, name: name || (phone ? '+' + phone : email), phone: phone || '', email: email || '', city: pick(b, 'city', 'City').slice(0, 80), state: pick(b, 'state', 'State').slice(0, 80),
      business_name: pick(b, 'business', 'company', 'business_name', 'company_name').slice(0, 120), source, notes: extra, budget, stage, follow_up_date: today() }).select('lead_id').single();
    if (error) console.error('lead-in insert', error.message);
    if (error) return thanks(redirect, isForm, { error: /limit/i.test(error.message) ? 'This workspace has reached its lead limit.' : 'Could not save the lead.' }, /limit/i.test(error.message) ? 402 : 500);
    await db.from('activities').insert({ workspace_id: ws, lead_id: n.lead_id, type: 'Lead Added', details: `From ${source}${extra ? ' · ' + extra : ''}`.slice(0, 300), done_by: source });
    await db.from('lead_capture_keys').update({ uses: (k.uses ?? 0) + 1, last_used_at: new Date().toISOString() }).eq('workspace_id', ws);
    return thanks(redirect, isForm, { ok: true, lead_id: n.lead_id });
  } catch (e) {
    return thanks('', isForm, { error: String((e as Error)?.message ?? e) }, 500);
  }
});
