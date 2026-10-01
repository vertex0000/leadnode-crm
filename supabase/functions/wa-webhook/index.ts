// Nodevers — wa-webhook: Meta sends incoming WhatsApp messages + delivery ticks here.
// Deploy: Supabase → Edge Functions → wa-webhook → Code → replace all → Deploy. "Enforce JWT verification" stays OFF.
// Secrets (Edge Functions → Secrets): WA_VERIFY_TOKEN (any long random text, same as in Meta), META_APP_SECRET (Meta app → Basic → App secret).
import { createClient } from 'npm:@supabase/supabase-js@2';

const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const VERIFY = Deno.env.get('WA_VERIFY_TOKEN') ?? '';
const APP_SECRET = Deno.env.get('META_APP_SECRET') ?? '';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

async function validSignature(raw: string, header: string | null) {
  if (!APP_SECRET) return true;                       // not set yet → accept (set it before going live)
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = Array.from(sig).map(x => x.toString(16).padStart(2, '0')).join('');
  const a = hex, b = header.slice(7); if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}

function textOf(m: any): string {
  switch (m.type) {
    case 'text': return m.text?.body ?? '';
    case 'button': return m.button?.text ?? '';
    case 'interactive': return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '[reply]';
    case 'image': case 'video': case 'document': return m[m.type]?.caption || `[${m.type}]`;
    case 'audio': return '[voice note]';
    case 'sticker': return '[sticker]';
    case 'location': return `[location] ${m.location?.latitude ?? ''},${m.location?.longitude ?? ''}`;
    case 'reaction': return `[reaction ${m.reaction?.emoji ?? ''}]`;
    default: return `[${m.type}]`;
  }
}

async function findOrCreateLead(ws: string, phone: string, name: string) {
  const last10 = phone.slice(-10);
  let { data: l } = await db.from('leads').select('lead_id').eq('workspace_id', ws).eq('phone', phone).limit(1).maybeSingle();
  if (!l) ({ data: l } = await db.from('leads').select('lead_id').eq('workspace_id', ws).like('phone', `%${last10}`).limit(1).maybeSingle());
  if (l) return { id: l.lead_id as string, created: false };
  let stage = 'New Lead';
  const { data: st } = await db.from('settings').select('value').eq('workspace_id', ws).eq('key', 'stagesJson').maybeSingle();
  try { const s = JSON.parse(st?.value ?? 'null'); if (Array.isArray(s) && s[0]) stage = String(s[0]); } catch { /* default */ }
  const { data: n, error } = await db.from('leads').insert({ workspace_id: ws, name: (name || '+' + phone).slice(0, 120), phone, source: 'WhatsApp', stage, follow_up_date: today() }).select('lead_id').single();
  if (error) throw error;
  await db.from('activities').insert({ workspace_id: ws, lead_id: n.lead_id, type: 'Lead Added', details: 'First WhatsApp message', done_by: 'WhatsApp' });
  return { id: n.lead_id as string, created: true };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && VERIFY && url.searchParams.get('hub.verify_token') === VERIFY;
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('Forbidden', { status: 403 });
  }
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('X-Hub-Signature-256')))) return new Response('Bad signature', { status: 401 });
  try {
    const body = JSON.parse(raw || '{}');
    for (const entry of body.entry ?? []) for (const ch of entry.changes ?? []) {
      if (ch.field !== 'messages') continue;
      const v = ch.value ?? {}, pid = v.metadata?.phone_number_id;
      const { data: acc } = await db.from('wa_accounts').select('workspace_id').eq('phone_number_id', String(pid)).maybeSingle();
      if (!acc) continue;
      const ws = acc.workspace_id, names: Record<string, string> = {};
      for (const c of v.contacts ?? []) names[c.wa_id] = c.profile?.name ?? '';
      for (const m of v.messages ?? []) {
        const phone = String(m.from ?? '').replace(/\D/g, ''); if (!phone) continue;
        const text = textOf(m), lead = await findOrCreateLead(ws, phone, names[m.from] ?? '');
        const ins = await db.from('messages').upsert({ workspace_id: ws, lead_id: lead.id, phone, direction: 'in', type: m.type ?? 'text', text, status: 'received', time: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000).toISOString(), whatsapp_msg_id: m.id }, { onConflict: 'whatsapp_msg_id', ignoreDuplicates: true }).select('message_id');
        if (ins.data?.length) {
          await db.from('activities').insert({ workspace_id: ws, lead_id: lead.id, type: 'WhatsApp Received', details: text.slice(0, 300), done_by: names[m.from] || 'Customer' });
          await db.from('leads').update({ last_contact: today() }).eq('workspace_id', ws).eq('lead_id', lead.id);
          // "STOP" → no more broadcasts to this number; "START" → back in
          if (/^\s*(stop|unsubscribe|stop all|band karo)\s*[.!]?\s*$/i.test(text)) await db.from('leads').update({ wa_opt_out: true }).eq('workspace_id', ws).eq('lead_id', lead.id);
          else if (/^\s*start\s*$/i.test(text)) await db.from('leads').update({ wa_opt_out: false }).eq('workspace_id', ws).eq('lead_id', lead.id);
        }
      }
      for (const s of v.statuses ?? []) {
        const er = (s.errors ?? [])[0];
        const reason = er ? `${er.code ?? ''} · ${er.error_data?.details || er.message || er.title || 'Unknown error'}`.slice(0, 300) : '';
        if (er) console.log('message failed', s.id, reason);
        const up = await db.from('messages').update(reason ? { status: s.status, error: reason } : { status: s.status }).eq('workspace_id', ws).eq('whatsapp_msg_id', s.id);
        if (up.error && reason) await db.from('messages').update({ status: s.status }).eq('workspace_id', ws).eq('whatsapp_msg_id', s.id);   // before 05_message_errors.sql
      }
    }
  } catch (e) {
    console.error('webhook error', e);           // still answer 200 so Meta does not retry forever
  }
  return new Response('ok', { status: 200 });
});
