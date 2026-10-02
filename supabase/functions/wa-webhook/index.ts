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


// ================= Button actions: a customer taps a quick-reply button on one of our templates =================
const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0';
const GEMINI = Deno.env.get('GEMINI_URL') ?? 'https://generativelanguage.googleapis.com/v1beta';
const BREVO = Deno.env.get('BREVO_URL') ?? 'https://api.brevo.com/v3';
const inr = (n: unknown) => (n === null || n === undefined || n === '') ? '' : '₹' + Number(n).toLocaleString('en-IN');
async function graph(acc: any, payload: unknown) {
  const r = await fetch(`${GRAPH}/${acc.phone_number_id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${acc.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({})); return r.ok ? { ok: true, id: j?.messages?.[0]?.id ?? null } : { ok: false, error: j?.error?.message ?? String(r.status) };
}
async function logOut(ws: string, leadId: string, to: string, type: string, text: string, wamid: string | null, journey: string) {
  const row: any = { workspace_id: ws, lead_id: leadId, phone: to, direction: 'out', type, text, status: 'sent', whatsapp_msg_id: wamid, sent_by: 'Automation' };
  const ins = await db.from('messages').insert(row); if (ins.error) { delete row.sent_by; await db.from('messages').insert(row); }
  await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'WhatsApp Sent', details: journey.slice(0, 300), done_by: 'Automation' });
}
/** Template message with media header, location, catalog thumbnail and our quick-reply payloads (nv|template|index) */
function templatePayloadFor(to: string, t: any, params: string[]) {
  const flow = t.flow ?? {}, comps: any[] = [];
  const kind = String(flow.content ?? 'text');
  if (['image', 'video', 'pdf'].includes(kind) && flow.mediaUrl) {
    const typ = kind === 'pdf' ? 'document' : kind;
    comps.push({ type: 'header', parameters: [{ type: typ, [typ]: { link: String(flow.mediaUrl), ...(typ === 'document' ? { filename: String(flow.fileName || 'document.pdf') } : {}) } }] });
  } else if (kind === 'location' && flow.location?.lat) {
    comps.push({ type: 'header', parameters: [{ type: 'location', location: { latitude: Number(flow.location.lat), longitude: Number(flow.location.lng), name: String(flow.location.name ?? ''), address: String(flow.location.address ?? '') } }] });
  }
  if (params.length) comps.push({ type: 'body', parameters: params.map((x) => ({ type: 'text', text: String(x || '-').slice(0, 1000) })) });
  (Array.isArray(flow.buttons) ? flow.buttons : []).forEach((b: any, i: number) => {
    const idx = Number.isInteger(b.index) ? b.index : i;
    if (b.meta === 'QUICK_REPLY') comps.push({ type: 'button', sub_type: 'quick_reply', index: String(idx), parameters: [{ type: 'payload', payload: `nv|${t.template_name}|${idx}` }] });
    else if (b.meta === 'CATALOG') comps.push({ type: 'button', sub_type: 'CATALOG', index: String(idx), parameters: [{ type: 'action', action: { thumbnail_product_retailer_id: String(flow.productId || '') } }] });
  });
  return { messaging_product: 'whatsapp', to, type: 'template', template: { name: t.template_name, language: { code: t.language || 'en' }, ...(comps.length ? { components: comps } : {}) } };
}
const fillVars = (s: string, ctx: any) => String(s ?? '').replace(/\{\{\s*(first_name|name|business|city|order_id|amount|status|tracking_url|items)\s*\}\}/gi, (_m, k) => {
  k = k.toLowerCase(); const l = ctx.lead ?? {}, o = ctx.order ?? {};
  return k === 'first_name' ? (String(l.name ?? '').split(' ')[0] || 'there') : k === 'name' ? (l.name ?? '') : k === 'business' ? (l.business_name ?? '') : k === 'city' ? (l.city ?? '')
    : k === 'order_id' ? (o.order_id ?? '') : k === 'amount' ? inr(o.amount) : k === 'status' ? (o.status ?? '') : k === 'tracking_url' ? (o.tracking_url ?? '') : (o.items ?? '');
});
async function lastOrder(ws: string, leadId: string) {
  const { data } = await db.from('orders').select('*').eq('workspace_id', ws).eq('lead_id', leadId).neq('status', 'Cancelled').order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data;
}
async function runButton(ws: string, acc: any, leadId: string, phone: string, payload: string, label: string) {
  const [, tplName, idxS] = payload.split('|'); const idx = Number(idxS);
  const { data: t } = await db.from('templates').select('template_name, flow').eq('workspace_id', ws).eq('template_name', tplName).maybeSingle();
  const btn = (t?.flow?.buttons ?? []).find((b: any, i: number) => (Number.isInteger(b.index) ? b.index : i) === idx);
  if (!btn) return;
  const { data: lead } = await db.from('leads').select('*').eq('workspace_id', ws).eq('lead_id', leadId).maybeSingle();
  const ctx: any = { lead, order: await lastOrder(ws, leadId) };
  await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'Button Tapped', details: `${label || btn.label} · ${tplName}`, done_by: 'Customer' });
  const say = async (text: string) => { const body = fillVars(text, ctx).trim(); if (!body) return; const r = await graph(acc, { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: body.slice(0, 4096), preview_url: true } }); if (r.ok) await logOut(ws, leadId, phone, 'text', body, r.id, body); };
  for (const a of (Array.isArray(btn.actions) ? btn.actions : []).slice(0, 8)) {
    try {
      const p = a ?? {};
      switch (p.type) {
        case 'send_template': {
          const { data: nt } = await db.from('templates').select('*').eq('workspace_id', ws).eq('template_name', String(p.template ?? '')).maybeSingle(); if (!nt) break;
          // {{1}}, {{2}}… → the values typed on the action (may use {{first_name}}, {{order_id}}…); otherwise sensible defaults
          const n = (String(nt.body ?? '').match(/\{\{\d+\}\}/g) ?? []).length, first = String(lead?.name ?? '').split(' ')[0] || 'there';
          const given = String(p.params ?? '').trim() ? String(p.params).split(',').map((x: string) => fillVars(x.trim(), ctx)) : [];
          const auto = ctx.order ? [first, ctx.order.order_id, ctx.order.status, inr(ctx.order.amount)] : [first, lead?.business_name || lead?.name || '', lead?.city || ''];
          const r = await graph(acc, templatePayloadFor(phone, nt, Array.from({ length: n }, (_, k) => given[k] || auto[k] || '-')));
          if (r.ok) await logOut(ws, leadId, phone, 'template', `Template: ${nt.template_name}`, r.id, `Flow → ${nt.template_name}`); break;
        }
        case 'send_text': case 'open_link': case 'open_form': case 'open_product': await say([p.text, p.url].filter(Boolean).join('\n')); break;
        case 'send_payment_link': {
          if (ctx.order) await db.from('orders').update({ payment: 'link' }).eq('workspace_id', ws).eq('order_id', ctx.order.order_id);
          await say(p.text || `Here is your payment link${ctx.order?.amount ? ' for {{amount}}' : ''}:\n${p.url ?? ''}`); break;
        }
        case 'create_order': {
          const status = ['Cart', 'New', 'Confirmed', 'COD'].includes(p.status) ? p.status : 'New';
          const { data: o } = await db.from('orders').insert({ workspace_id: ws, lead_id: leadId, items: String(p.items ?? label ?? '').slice(0, 2000), amount: p.amount ? Number(p.amount) : null, status, payment: status === 'COD' ? 'COD' : '', source: `WhatsApp · ${tplName}` }).select().single();
          ctx.order = o; await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'Order', details: `${o?.order_id} created (${status})`, done_by: 'Automation' });
          if (p.text) await say(p.text); break;
        }
        case 'update_order': {
          const status = String(p.status || 'Confirmed');
          if (!ctx.order) { const { data: o } = await db.from('orders').insert({ workspace_id: ws, lead_id: leadId, items: String(label ?? ''), status, payment: status === 'COD' ? 'COD' : '', source: `WhatsApp · ${tplName}` }).select().single(); ctx.order = o; }
          else { const { data: o } = await db.from('orders').update({ status, ...(status === 'COD' ? { payment: 'COD' } : {}) }).eq('workspace_id', ws).eq('order_id', ctx.order.order_id).select().single(); ctx.order = o; }
          await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'Order', details: `${ctx.order?.order_id} → ${status}`, done_by: 'Automation' });
          if (p.text) await say(p.text); break;
        }
        case 'cancel_order': {
          if (ctx.order) { await db.from('orders').update({ status: 'Cancelled' }).eq('workspace_id', ws).eq('order_id', ctx.order.order_id); await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'Order', details: `${ctx.order.order_id} cancelled by customer`, done_by: 'Customer' }); }
          await say(p.text || (ctx.order ? 'Your order {{order_id}} is cancelled.' : 'We could not find an open order for you.')); break;
        }
        case 'track_order': await say(p.text || (ctx.order ? 'Order {{order_id}}: *{{status}}*' + (ctx.order.tracking_url ? '\nTrack it here: {{tracking_url}}' : '') : 'We could not find an open order for you — reply here and our team will help.')); break;
        case 'generate_invoice': await say(ctx.order ? `*Invoice ${ctx.order.order_id}*\n${ctx.order.items || ''}\nAmount: ${inr(ctx.order.amount) || 'to be confirmed'}\nStatus: ${ctx.order.status}\nThank you for your order!` : 'We could not find an order to invoice — our team will contact you.'); break;
        case 'assign_member': if (p.member) await db.from('leads').update({ assigned_to: String(p.member).slice(0, 60) }).eq('workspace_id', ws).eq('lead_id', leadId); break;
        case 'add_tag': if (p.tag) await db.from('leads').update({ tag: String(p.tag).slice(0, 30) }).eq('workspace_id', ws).eq('lead_id', leadId); break;
        case 'change_stage': if (p.stage) { const old = lead?.stage; await db.from('leads').update({ stage: String(p.stage) }).eq('workspace_id', ws).eq('lead_id', leadId); await db.from('activities').insert({ workspace_id: ws, lead_id: leadId, type: 'Stage Changed', details: `${old} → ${p.stage}`, done_by: 'Automation' }); } break;
        case 'create_task': await db.from('tasks').insert({ workspace_id: ws, lead_id: leadId, title: fillVars(String(p.title || `Follow up: ${label}`), ctx).slice(0, 200), due_at: new Date(Date.now() + (Number(p.days) || 0) * 864e5 + 3600e3).toISOString(), priority: ['High', 'Medium', 'Low'].includes(p.priority) ? p.priority : 'High', assigned_to: String(p.member || lead?.assigned_to || ''), source: 'button' }); break;
        case 'send_email': {
          const { data: ea } = await db.from('email_accounts').select('*').eq('workspace_id', ws).maybeSingle();
          if (ea && /@/.test(String(lead?.email ?? ''))) await fetch(`${BREVO}/smtp/email`, { method: 'POST', headers: { 'api-key': ea.api_key, 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sender: { email: ea.from_email, name: ea.from_name || undefined }, to: [{ email: lead.email, name: lead.name || '' }], subject: fillVars(String(p.subject || 'Thank you'), ctx), htmlContent: `<p>${fillVars(String(p.body || ''), ctx).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>` }) });
          break;
        }
        case 'trigger_workflow': case 'custom_api': {
          const u = String(p.url ?? ''); if (!/^https:\/\//i.test(u)) break;
          await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'nodevers', event: 'button', template: tplName, button: label, lead, order: ctx.order ?? null }), signal: AbortSignal.timeout(10000) }).catch(() => null); break;
        }
        case 'run_ai_agent': {
          const key = Deno.env.get('GEMINI_API_KEY'); if (!key) break;
          const { data: hist } = await db.from('messages').select('direction, text').eq('workspace_id', ws).eq('lead_id', leadId).order('time', { ascending: false }).limit(12);
          const chat = (hist ?? []).reverse().map((x: any) => `${x.direction === 'out' ? 'Business' : 'Customer'}: ${String(x.text).slice(0, 400)}`).join('\n');
          const r = await fetch(`${GEMINI}/models/${Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite'}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: `You reply on WhatsApp for a business. ${String(p.prompt ?? '').slice(0, 800)}\nReply in the customer's language, under 60 words, no invented prices or promises.` }] }, contents: [{ role: 'user', parts: [{ text: chat || label }] }], generationConfig: { temperature: 0.6, maxOutputTokens: 1024 } }) });
          const j = await r.json().catch(() => ({})); const text = (j?.candidates?.[0]?.content?.parts ?? []).filter((x: any) => !x.thought).map((x: any) => x.text ?? '').join('').trim();
          if (text) await say(text); break;
        }
      }
    } catch (e) { console.error('action failed', a?.type, e); }
  }
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
      const { data: acc } = await db.from('wa_accounts').select('*').eq('phone_number_id', String(pid)).maybeSingle();
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
          // quick-reply button on one of our templates → run its actions
          const payload = m.type === 'button' ? String(m.button?.payload ?? '') : m.type === 'interactive' ? String(m.interactive?.button_reply?.id ?? '') : '';
          if (payload.startsWith('nv|')) await runButton(ws, acc, lead.id, phone, payload, text);
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
