// Nodevers — wa-send: send a WhatsApp text or template from the CRM, log it in the lead's journey.
// Deploy: Supabase → Edge Functions → Deploy a new function → name "wa-send" → paste → turn OFF "Verify JWT".
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0';
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());   // YYYY-MM-DD
const cleanPhone = (p: unknown) => { let d = String(p ?? '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; };
const FRIENDLY: Record<string, string> = {
  '131047': 'More than 24 hours have passed since this customer last messaged you. Send an approved template instead.',
  '131026': 'This number is not on WhatsApp or cannot receive messages.',
  '132001': 'This template does not exist or is not approved yet.',
  '190': 'The WhatsApp access token has expired. Reconnect WhatsApp in the Inbox.',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();
    const ws = String(b.workspace_id ?? '');
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401);
    const { data: m } = await db.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', u.user.id).maybeSingle();
    if (!m || m.role === 'client') return json({ error: 'You do not have permission to send messages here.' }, 403);

    const { data: acc } = await db.from('wa_accounts').select('*').eq('workspace_id', ws).maybeSingle();
    if (!acc) return json({ error: 'Connect your WhatsApp number first (WhatsApp → Inbox → Connect WhatsApp).' }, 400);

    let leadId: string | null = b.lead_id ? String(b.lead_id) : null, to = cleanPhone(b.phone);
    if (leadId) { const { data: l } = await db.from('leads').select('phone').eq('workspace_id', ws).eq('lead_id', leadId).maybeSingle(); if (!l) return json({ error: 'Lead not found' }, 404); to = cleanPhone(l.phone); }
    if (!/^\d{8,15}$/.test(to)) return json({ error: 'This lead has no valid phone number.' }, 400);

    let payload: Record<string, unknown>, logText: string, type: string;
    if (b.template) {
      const params = Array.isArray(b.params) ? b.params.map((t: unknown) => ({ type: 'text', text: String(t).slice(0, 1000) })) : [];
      payload = { messaging_product: 'whatsapp', to, type: 'template', template: { name: String(b.template), language: { code: String(b.language || 'en') }, ...(params.length ? { components: [{ type: 'body', parameters: params }] } : {}) } };
      logText = String(b.preview || `Template: ${b.template}`); type = 'template';
    } else {
      const text = String(b.text ?? '').trim(); if (!text) return json({ error: 'Type a message' }, 400);
      payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096), preview_url: true } };
      logText = text; type = 'text';
    }
    const r = await fetch(`${GRAPH}/${acc.phone_number_id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const out = await r.json();
    if (!r.ok) { const code = String(out?.error?.code ?? ''); return json({ error: FRIENDLY[code] ?? ('WhatsApp error: ' + (out?.error?.message ?? r.status)), code }, 400); }
    const wamid = out?.messages?.[0]?.id ?? null;

    if (!leadId) { const { data: l } = await db.from('leads').select('lead_id').eq('workspace_id', ws).eq('phone', to).limit(1).maybeSingle(); leadId = l?.lead_id ?? null; }
    await db.from('messages').insert({ workspace_id: ws, lead_id: leadId, phone: to, direction: 'out', type, text: logText, status: 'sent', whatsapp_msg_id: wamid });
    if (leadId) {
      await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'WhatsApp Sent', details: logText.slice(0, 300), done_by: String(b.by ?? '') });
      await db.from('leads').update({ last_contact: today() }).eq('workspace_id', ws).eq('lead_id', leadId);
    }
    return json({ ok: true, id: wamid, lead_id: leadId });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
