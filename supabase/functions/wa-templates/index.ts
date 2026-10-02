// Nodevers — wa-templates: sync WhatsApp templates from Meta, submit new ones for approval, delete.
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name "wa-templates" → paste → Deploy → turn OFF "Enforce JWT verification".
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRAPH = Deno.env.get('WA_GRAPH_URL') ?? 'https://graph.facebook.com/v21.0';
const firstKey = (json?: string) => { try { return Object.values(JSON.parse(json ?? '{}'))[0] as string | undefined; } catch { return undefined; } };
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || firstKey(Deno.env.get('SUPABASE_SECRET_KEYS')) || '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const STATUS: Record<string, string> = { APPROVED: 'Approved', PENDING: 'Pending', IN_APPEAL: 'Pending', REJECTED: 'Rejected', PAUSED: 'Paused', DISABLED: 'Disabled', PENDING_DELETION: 'Deleting' };
const title = (s: string) => String(s || '').toLowerCase().replace(/(^|_)(\w)/g, (_m, a, b) => (a ? ' ' : '') + b.toUpperCase());

/** Meta needs a sample file for image / video / PDF headers: upload it with the Resumable Upload API → handle */
async function uploadSample(acc: any, url: string) {
  if (!/^https:\/\//i.test(url)) throw new Error('Add a public https link to the sample image / video / PDF.');
  const f = await fetch(url).catch(() => null); if (!f || !f.ok) throw new Error('Could not download the sample file — use a public https link that opens in a browser.');
  if (Number(f.headers.get('content-length') ?? 0) > 100 * 1024 * 1024) throw new Error('The sample file is too big.');
  const buf = new Uint8Array(await f.arrayBuffer()), type = (f.headers.get('content-type') ?? 'image/jpeg').split(';')[0].trim();
  if (buf.length > 100 * 1024 * 1024) throw new Error('The sample file is too big.');
  let appId = Deno.env.get('META_APP_ID') ?? '';
  if (!appId) { const a = await (await fetch(`${GRAPH}/app?access_token=${encodeURIComponent(acc.token)}`)).json().catch(() => ({})); appId = a?.id ?? ''; }
  if (!appId) throw new Error('Add the secret META_APP_ID (your Meta app ID) in Supabase → Edge Functions → Secrets.');
  const s1 = await fetch(`${GRAPH}/${appId}/uploads?file_length=${buf.length}&file_type=${encodeURIComponent(type)}&access_token=${encodeURIComponent(acc.token)}`, { method: 'POST' });
  const j1 = await s1.json().catch(() => ({})); if (!j1?.id) throw new Error('Meta upload: ' + (j1?.error?.message ?? s1.status));
  const s2 = await fetch(`${GRAPH}/${j1.id}`, { method: 'POST', headers: { Authorization: `OAuth ${acc.token}`, file_offset: '0' }, body: buf });
  const j2 = await s2.json().catch(() => ({})); if (!j2?.h) throw new Error('Meta upload: ' + (j2?.error?.message ?? s2.status));
  return String(j2.h);
}
function fromMeta(t: any) {
  const c = (type: string) => (t.components ?? []).find((x: any) => x.type === type) ?? {};
  const h = c('HEADER');
  const header = h.format === 'TEXT' ? (h.text ?? '') : h.format ? `[${String(h.format).toLowerCase()}]` : '';
  const buttons = (c('BUTTONS').buttons ?? []).map((b: any) => b.type === 'URL' ? `🔗 ${b.text}` : b.type === 'PHONE_NUMBER' ? `📞 ${b.text}` : b.text).join(' | ');
  return { template_name: t.name, category: title(t.category), language: t.language, header, body: String(c('BODY').text ?? '').slice(0, 1100), footer: c('FOOTER').text ?? '', buttons,
    meta_status: STATUS[t.status] ?? title(t.status), meta_id: String(t.id ?? ''), quality: t.quality_score?.score ?? '', reject_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? title(t.rejected_reason) : '', updated_at: new Date().toISOString() };
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
    if (!m || m.role === 'client') return json({ error: 'You do not have permission here.' }, 403);
    const { data: acc } = await db.from('wa_accounts').select('*').eq('workspace_id', ws).maybeSingle();
    if (!acc) return json({ error: 'Connect your WhatsApp number first (WhatsApp → Inbox → Connect WhatsApp).' }, 400);
    if (!acc.waba_id) return json({ error: 'Add your WhatsApp Business Account ID in WhatsApp → Inbox → Manage.' }, 400);
    const auth = { Authorization: `Bearer ${acc.token}` };

    if (b.action === 'sync') {
      let url = `${GRAPH}/${acc.waba_id}/message_templates?fields=id,name,status,category,language,components,quality_score,rejected_reason&limit=100`;
      const seen = new Set<string>(), rows: any[] = [];
      for (let page = 0; url && page < 10; page++) {
        const r = await fetch(url, { headers: auth }); const j = await r.json();
        if (!r.ok) return json({ error: 'Meta: ' + (j?.error?.message ?? r.status) }, 400);
        for (const t of j.data ?? []) {
          if (seen.has(t.name)) continue;                  // one row per template name (first language Meta returns)
          seen.add(t.name); rows.push({ workspace_id: ws, ...fromMeta(t) });
        }
        url = j.paging?.next ?? '';
      }
      if (rows.length) {
        const up = await db.from('templates').upsert(rows, { onConflict: 'workspace_id,template_name' });
        if (up.error) return json({ error: /footer|meta_id|quality|reject/.test(up.error.message) ? 'Run the database update 04_templates.sql first.' : up.error.message }, 500);
      }
      return json({ ok: true, count: rows.length, approved: rows.filter((r) => r.meta_status === 'Approved').length });
    }

    if (b.action === 'create') {
      const name = String(b.name ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 512);
      const body = String(b.body ?? '').trim();
      if (!name) return json({ error: 'Give the template a name.' }, 400);
      if (!body) return json({ error: 'Write the message body.' }, 400);
      const n = (body.match(/\{\{\d+\}\}/g) ?? []).length;
      const ex = Array.from({ length: n }, (_, i) => String((b.examples ?? [])[i] || ['Aarav', 'Diwali Sale', '20%', 'Mumbai', 'today'][i] || 'sample'));
      const components: any[] = [], content = String(b.content ?? 'text');
      if (['image', 'video', 'pdf'].includes(content)) components.push({ type: 'HEADER', format: content === 'pdf' ? 'DOCUMENT' : content.toUpperCase(), example: { header_handle: [await uploadSample(acc, String(b.media_url ?? ''))] } });
      else if (content === 'location') components.push({ type: 'HEADER', format: 'LOCATION' });
      else if (String(b.header ?? '').trim()) components.push({ type: 'HEADER', format: 'TEXT', text: String(b.header).trim().slice(0, 60) });
      components.push({ type: 'BODY', text: body, ...(n ? { example: { body_text: [ex] } } : {}) });
      if (String(b.footer ?? '').trim()) components.push({ type: 'FOOTER', text: String(b.footer).trim().slice(0, 60) });
      const btns = (Array.isArray(b.buttons) ? b.buttons : []).filter((x: any) => String(x.text ?? '').trim() || x.type === 'CATALOG').slice(0, 10).map((x: any) =>
        x.type === 'CATALOG' ? { type: 'CATALOG', text: String(x.text || 'View catalog').slice(0, 25) }
        : x.type === 'URL' ? { type: 'URL', text: String(x.text).slice(0, 25), url: String(x.url ?? '') }
          : x.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: String(x.text).slice(0, 25), phone_number: String(x.phone ?? '').replace(/[^\d+]/g, '') }
            : { type: 'QUICK_REPLY', text: String(x.text).slice(0, 25) });
      if (btns.length) components.push({ type: 'BUTTONS', buttons: btns });
      const category = String(b.category ?? 'MARKETING').toUpperCase() === 'UTILITY' ? 'UTILITY' : 'MARKETING';
      const r = await fetch(`${GRAPH}/${acc.waba_id}/message_templates`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, language: String(b.language || 'en'), category, components }) });
      const j = await r.json();
      if (!r.ok) return json({ error: 'Meta did not accept this template: ' + (j?.error?.error_user_msg || j?.error?.message || r.status) }, 400);
      const row: any = { workspace_id: ws, ...fromMeta({ id: j.id, name, status: j.status ?? 'PENDING', category: j.category ?? category, language: String(b.language || 'en'), components }) };
      if (b.flow && typeof b.flow === 'object') row.flow = b.flow;
      const up = await db.from('templates').upsert(row, { onConflict: 'workspace_id,template_name' });
      if (up.error && row.flow) { delete row.flow; const up2 = await db.from('templates').upsert(row, { onConflict: 'workspace_id,template_name' }); if (up2.error) return json({ error: up2.error.message }, 500); }
      else if (up.error) return json({ error: up.error.message }, 500);
      return json({ ok: true, status: row.meta_status, name });
    }

    if (b.action === 'delete') {
      const name = String(b.name ?? '');
      if (!name) return json({ error: 'Which template?' }, 400);
      if (b.meta !== false) {
        const r = await fetch(`${GRAPH}/${acc.waba_id}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: auth });
        if (!r.ok) { const j = await r.json().catch(() => ({})); if (!/does not exist|not found/i.test(j?.error?.message ?? '')) return json({ error: 'Meta: ' + (j?.error?.message ?? r.status) }, 400); }
      }
      await db.from('templates').delete().eq('workspace_id', ws).eq('template_name', name);
      return json({ ok: true });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
