/* Nodevers website tracking — paste once before </body> on every page of your shop:
   <script async src="https://vertex0000.github.io/leadnode-crm/t.js" data-key="YOUR_KEY" data-api="https://YOUR-PROJECT.supabase.co/functions/v1/track"></script>
   What it does: when a shopper types a phone number or email on the cart / checkout page, the cart is saved as an "abandoned checkout"
   in Nodevers (so a reminder can go out if they leave); when the order is placed, the checkout is marked recovered.
   Reads the usual shop events (Google Analytics 4 dataLayer: view_item / add_to_cart / begin_checkout / purchase, WooCommerce thank-you page).
   Product pages: when the shopper is already known (typed a phone / email before), the product they look at is noted for a gentle
   "still thinking about it?" reminder. A friend's link (?ref=CODE) is remembered for 30 days so the referral counts.
   Any site can also call:  nodevers.checkout({ phone, email, name, items: [{ sku, name, qty, price }], value })
                            nodevers.purchase({ id: 'ORDER-123', phone, email, items, value, payment: 'COD', pincode: '400001' })
                            nodevers.view({ sku, name, price })
   It never reads card details or passwords, and sends nothing until a phone number or email is typed. */
(function () {
  'use strict';
  var me = document.currentScript || document.querySelector('script[data-key][src*="t.js"]');
  if (!me || window.__nodevers) return; window.__nodevers = 1;
  var KEY = me.getAttribute('data-key'), API = me.getAttribute('data-api');
  if (!KEY || !API) return;
  var LS = {}; try { LS = window.localStorage || {}; } catch (e) { }
  var get = function (k) { try { return LS.getItem ? LS.getItem(k) : null; } catch (e) { return null; } }, set = function (k, v) { try { if (LS.setItem) LS.setItem(k, v); } catch (e) { } };
  var rid = function () { var s = ''; for (var i = 0; i < 20; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36)); return s; };
  var cid = get('nv_cid'); if (!cid) { cid = rid(); set('nv_cid', cid); }
  var st = { phone: get('nv_ph') || '', email: get('nv_em') || '', name: get('nv_nm') || '', items: [], value: null, consent: undefined, sent: '' };
  try { var cart = JSON.parse(get('nv_cart') || 'null'); if (cart) { st.items = cart.items || []; st.value = cart.value; } } catch (e) { }
  st.pin = get('nv_pin') || '';
  // a friend's referral link (?ref=CODE) — kept 30 days
  var REF = ''; try { var rq = (location.search.match(/[?&]ref=([A-Za-z0-9]{4,16})(&|$)/) || [])[1]; if (rq) set('nv_ref', JSON.stringify({ c: rq.toUpperCase(), t: Date.now() }));
    var rs = JSON.parse(get('nv_ref') || 'null'); if (rs && rs.c && Date.now() - rs.t < 30 * 864e5) REF = rs.c; } catch (e) { }

  function send(e, extra) {
    var body = { k: KEY, e: e, id: cid, phone: st.phone, email: st.email, name: st.name, items: st.items, value: st.value, url: location.protocol === 'https:' ? location.href.split('#')[0] : '' };
    if (st.consent !== undefined) body.consent = st.consent;
    if (REF) body.ref = REF;
    for (var x in extra || {}) body[x] = extra[x];
    var data = JSON.stringify(body);
    try { if (navigator.sendBeacon && navigator.sendBeacon(API, new Blob([data], { type: 'text/plain' }))) return; } catch (er) { }
    try { fetch(API, { method: 'POST', body: data, keepalive: true, headers: { 'Content-Type': 'text/plain' } }); } catch (er) { }
  }
  var isCheckout = function () { if (/cart|checkout|basket|payment|order|buy/i.test(location.pathname + location.search)) return true; try { return !!document.querySelector('[autocomplete*="street-address"],[autocomplete*="address-line1"],[name*="address"],[name*="Address"]'); } catch (e) { return false; } };
  var timer = null;
  function saveCheckout() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (!st.phone && !st.email) return;
      var sig = [st.phone, st.email, st.name, st.value, st.items.length, st.consent].join('|'); if (sig === st.sent) return; st.sent = sig;
      send('checkout');
    }, 900);
  }
  function digits(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d.length >= 11 && d.length <= 15 ? d : ''; }
  function fieldKind(el) {
    if (!el || !el.tagName || el.tagName !== 'INPUT') return '';
    var t = (el.type || '').toLowerCase(); if (t === 'password' || t === 'hidden' || t === 'checkbox' || t === 'radio') return '';
    var h = [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label')].join(' ').toLowerCase();
    if (/card|cvv|cvc|otp|password|coupon|promo/.test(h)) return '';
    if (/zip|postal|pin.?code|post.?code/.test(h)) return 'pin';
    if (/(^|[^a-z])pin([^a-z]|$)/.test(h)) return '';
    if (t === 'email' || /e-?mail/.test(h)) return 'email';
    if (t === 'tel' || /phone|mobile|whatsapp|contact.?n/.test(h)) return 'phone';
    if (/given-name|first.?name|full.?name|(^|\s)name(\s|$)|billing_first|shipping_first/.test(h)) return 'name';
    return '';
  }
  function onField(e) {
    var el = e.target, k = fieldKind(el); if (!k) return;
    var v = String(el.value || '').trim();
    if (k === 'phone') { var d = digits(v); if (!d) return; st.phone = d; set('nv_ph', d); addConsent(el); }
    else if (k === 'email') { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return; st.email = v.toLowerCase(); set('nv_em', st.email); }
    else if (k === 'pin') { var pc = v.replace(/[^A-Za-z0-9-]/g, '').slice(0, 12); if (pc.length >= 4) { st.pin = pc; set('nv_pin', pc); } return; }
    else { if (v.length < 2) return; st.name = v.slice(0, 120); set('nv_nm', st.name); }
    if (isCheckout()) saveCheckout();
  }
  document.addEventListener('change', onField, true);
  document.addEventListener('blur', onField, true);

  // optional consent line under the phone box (switched on in Nodevers → Connections → Website tracking)
  var CFG = null, cfgAsked = false;
  function addConsent(el) {
    if (!cfgAsked) { cfgAsked = true; try { fetch(API + (API.indexOf('?') > -1 ? '&' : '?') + 'k=' + encodeURIComponent(KEY) + '&cfg=1').then(function (r) { return r.json(); }).then(function (c) { CFG = c; addConsent(el); }).catch(function () { }); } catch (er) { } return; }
    if (!CFG || !CFG.consent || !CFG.consent.on || document.getElementById('nv-consent') || !isCheckout()) return;
    var lab = document.createElement('label'); lab.id = 'nv-consent';
    lab.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin:8px 0;font-size:13px;line-height:1.35;cursor:pointer;color:inherit';
    var box = document.createElement('input'); box.type = 'checkbox'; box.style.cssText = 'margin-top:2px;width:16px;height:16px;flex:none';
    var tx = document.createElement('span'); tx.textContent = CFG.consent.text || 'Send me order updates and offers on WhatsApp';
    lab.appendChild(box); lab.appendChild(tx);
    box.addEventListener('change', function () { st.consent = box.checked; saveCheckout(); });
    var host = el.closest ? (el.closest('.form-row,.field,.form-group,p,div') || el) : el;
    if (host.parentNode) host.parentNode.insertBefore(lab, host.nextSibling);
  }

  // shop events from Google Analytics 4 (dataLayer) — most themes and plugins push these
  function money(v) { var n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, '')); return isFinite(n) && n > 0 ? n : null; }
  function gaItems(ec) { return ((ec && ec.items) || []).slice(0, 30).map(function (i) { return { sku: String(i.item_id || i.id || i.sku || ''), name: String(i.item_name || i.name || ''), qty: +(i.quantity || 1) || 1, price: money(i.price) }; }); }
  function onEvent(o) {
    if (!o || typeof o !== 'object') return;
    var ev = o.event, ec = o.ecommerce; if (!ev || !ec) return;
    if (ev === 'add_to_cart' || ev === 'view_cart' || ev === 'begin_checkout' || ev === 'add_shipping_info' || ev === 'add_payment_info') {
      var it = gaItems(ec); if (it.length) { st.items = it; st.value = money(ec.value) || st.value; set('nv_cart', JSON.stringify({ items: it, value: st.value })); }
      if (ev !== 'add_to_cart') saveCheckout();
    } else if (ev === 'purchase') done({ id: ec.transaction_id || ec.id, value: ec.value, items: gaItems(ec) });
    else if (ev === 'view_item') { var vi = gaItems(ec)[0]; if (vi) view(vi); }
  }
  var dl = window.dataLayer = window.dataLayer || [];
  for (var i = 0; i < dl.length; i++) try { onEvent(dl[i]); } catch (er) { }
  var push = dl.push; dl.push = function () { for (var j = 0; j < arguments.length; j++) try { onEvent(arguments[j]); } catch (er) { } return push.apply(dl, arguments); };

  var doneIds = {};
  function done(o) {
    o = o || {}; var id = String(o.id || ''); if (!id || doneIds[id]) return; doneIds[id] = 1;
    if (o.phone) st.phone = digits(o.phone) || st.phone; if (o.email) st.email = String(o.email).toLowerCase(); if (o.name) st.name = o.name;
    if (o.items && o.items.length) st.items = o.items; if (o.value) st.value = money(o.value);
    if (o.pincode) st.pin = String(o.pincode).replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
    send('purchase', { order: { id: id, payment: o.payment || '', status: o.status || '', pincode: st.pin || '' }, coupon: o.coupon || '' });
    cid = rid(); set('nv_cid', cid); set('nv_cart', ''); st.sent = '';                         // next cart is a new checkout
  }
  // WooCommerce thank-you page
  function wooThanks() {
    if (!/order-received/.test(location.href)) return;
    var n = document.querySelector('.woocommerce-order-overview__order strong, .order-number strong, .woocommerce-order-overview .order strong');
    var m = location.href.match(/order-received\/(\d+)/), id = (n && n.textContent.trim()) || (m && m[1]);
    var pay = document.querySelector('.woocommerce-order-overview__payment-method strong');
    if (id) done({ id: id, payment: pay ? pay.textContent.trim() : '' });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wooThanks); else wooThanks();

  // product pages → "viewed, not bought" (only for shoppers we already know; once per product per hour)
  function view(p) {
    p = p || {}; var sku = String(p.sku || p.id || '').slice(0, 80), name = String(p.name || '').slice(0, 200); if (!sku && !name) return;
    if (!st.phone && !st.email) return;
    var seen = {}; try { seen = JSON.parse(get('nv_pv') || '{}') || {}; } catch (e) { }
    var key = (sku || name).toLowerCase(), now = Date.now(); if (seen[key] && now - seen[key] < 3600e3) return;
    seen[key] = now; var ks = Object.keys(seen); if (ks.length > 40) delete seen[ks[0]]; set('nv_pv', JSON.stringify(seen));
    send('view', { product: { sku: sku, name: name, price: money(p.price) }, items: [], value: null });
  }
  function findProduct() {
    try {                                                              // Shopify themes
      var sm = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
      if (sm && sm.product) { var v = (sm.product.variants || [])[0] || {}; return { sku: v.sku || String(sm.product.id || ''), name: (v.name || '').replace(/ - [^-]*$/, '') || document.title.split(/[|–-]/)[0].trim(), price: v.price ? v.price / 100 : null }; }
    } catch (e) { }
    try {                                                              // schema.org Product (most shops and SEO plugins)
      var ld = document.querySelectorAll('script[type="application/ld+json"]');
      for (var a = 0; a < ld.length; a++) {
        var d = JSON.parse(ld[a].textContent || 'null'), list = [].concat(d && d['@graph'] ? d['@graph'] : d);
        for (var b = 0; b < list.length; b++) { var x = list[b]; if (!x || !/Product/.test([].concat(x['@type']).join(' '))) continue;
          var of = [].concat(x.offers || [])[0] || {}; return { sku: x.sku || x.mpn || '', name: x.name || '', price: of.price || of.lowPrice || null }; }
      }
    } catch (e) { }
    try {                                                              // WooCommerce product page
      if (document.body && /single-product/.test(document.body.className)) {
        var t = document.querySelector('.product_title'), sk = document.querySelector('.sku'), pr = document.querySelector('.summary .price ins .amount, .summary .price .amount');
        if (t) return { sku: sk ? sk.textContent.trim() : '', name: t.textContent.trim(), price: pr ? pr.textContent : null };
      }
    } catch (e) { }
    return null;
  }
  function pageView() { if (isCheckout()) return; var p = findProduct(); if (p) view(p); }
  if (document.readyState === 'complete') setTimeout(pageView, 1200); else window.addEventListener('load', function () { setTimeout(pageView, 1200); });

  window.nodevers = {
    view: function (d) { view(d); },
    checkout: function (d) { d = d || {}; if (d.phone) st.phone = digits(d.phone); if (d.email) st.email = String(d.email).toLowerCase(); if (d.name) st.name = d.name; if (d.items) st.items = d.items; if (d.value) st.value = money(d.value); if (d.consent !== undefined) st.consent = !!d.consent; st.sent = ''; saveCheckout(); },
    purchase: function (d) { done(d); },
    identify: function (d) { d = d || {}; if (d.ref && /^[A-Za-z0-9]{4,16}$/.test(d.ref)) { REF = String(d.ref).toUpperCase(); set('nv_ref', JSON.stringify({ c: REF, t: Date.now() })); } if (d.phone) { st.phone = digits(d.phone); set('nv_ph', st.phone); } if (d.email) { st.email = String(d.email).toLowerCase(); set('nv_em', st.email); } if (d.name) st.name = d.name; if (d.consent !== undefined) st.consent = !!d.consent; }
  };
})();
