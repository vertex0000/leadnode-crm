# Nodevers — Meta Tech Provider + "Connect with Facebook" setup

Goal: client sirf **Connect with Facebook** dabaye → Facebook login → business + WhatsApp number select → done.
Client ko na token, na webhook, na Supabase kuch karna padega.

Code pehle se repo me hai:
- `supabase/functions/wa-signup/index.ts` — naya function (login code → token, webhook subscribe, number register)
- `supabase/19_embedded_signup.sql` — 2 naye columns
- `index.html` — Inbox → WhatsApp connection me "Connect with Facebook" button (secrets set hote hi apne aap dikhega; tab tak purana form hi chalega)

---

## Step 1 — Meta Business verification (sirf ek baar, tumhare business ka)
Meta Business Suite → Settings → Business info → **Start verification**.
Chahiye: registered business ka naam + address + phone, aur ek document jaise **GST certificate / Udyam / Shop Act licence** (naam same hona chahiye), aur business email/website.
Verification me 1–5 din lagte hain.

## Step 2 — Meta app settings (developers.facebook.com → tumhara app)
1. **App settings → Basic**
   - App domains: `vertex0000.github.io`
   - Privacy policy URL: `https://vertex0000.github.io/leadnode-crm/privacy.html`
   - Terms URL: `https://vertex0000.github.io/leadnode-crm/terms.html`
   - User data deletion URL: `https://vertex0000.github.io/leadnode-crm/data-deletion.html`
   - App icon (1024×1024) + category = Business. Save.
   - Yahin se **App ID** aur **App secret** note karo.
2. App ko verified business portfolio se link karo (Basic page → "Business portfolio").
3. **Add product → Facebook Login for Business → Settings**: ye sab ON:
   Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Use Strict Mode, **Login with the JavaScript SDK**.
   - Valid OAuth Redirect URIs: `https://vertex0000.github.io/leadnode-crm/`
   - Allowed Domains for the JavaScript SDK: `https://vertex0000.github.io/`
4. **Facebook Login for Business → Configurations → Create from template** → "WhatsApp Embedded Signup Configuration" template.
   - Login variation: **WhatsApp Embedded Signup**
   - Assets: **WhatsApp accounts**
   - Permissions: sirf `whatsapp_business_management` + `whatsapp_business_messaging`
   - Token expiration: default (60 days) theek hai — ye login ka hai; jo business token hum save karte hain wo alag hota hai.
   - Save → **Configuration ID** note karo.
5. **WhatsApp → Configuration → Webhook** (ye sirf TUMHE ek baar karna hai, clients ko kabhi nahi):
   Callback URL = Nodevers me jo dikhta hai (`…supabase.co/functions/v1/wa-webhook`), Verify token = tumhara `WA_VERIFY_TOKEN` → Verify and save → **messages** subscribe.

## Step 3 — Supabase (project "nodeos")
1. **SQL Editor** → `supabase/19_embedded_signup.sql` paste → Run.
2. **Edge Functions → Deploy a new function** → name `wa-signup` → `supabase/functions/wa-signup/index.ts` paste → **Verify JWT OFF** → Deploy.
3. **Edge Functions → Secrets** → add:
   - `META_APP_ID` = App ID
   - `META_APP_SECRET` = App secret (agar pehle se hai to wahi rehne do)
   - `META_ES_CONFIG_ID` = Configuration ID
   - `WA_GRAPH_URL` = `https://graph.facebook.com/v25.0`  ← sab WhatsApp functions ek saath naye API version pe aa jayenge (purana v21 jaldi band hone wala hai)
4. Nodevers refresh karo → Inbox → WhatsApp connection me **Connect with Facebook** button dikhega.

## Step 4 — Become a Tech Provider (App Review)
App Dashboard → WhatsApp → **Tech Provider onboarding** → steps follow karo. App Review me Advanced access maangna hai:
- `whatsapp_business_messaging` — screen recording: Nodevers Inbox se ek message bhejo aur WhatsApp app pe receive hota dikhao.
- `whatsapp_business_management` — screen recording: Nodevers me template banake/sync karke dikhao.
Har permission ke saath 2–3 line likho ki Nodevers isko kyun use karta hai (clients ke leads ko WhatsApp pe reply, templates manage).
Review me ~1–2 hafte lag sakte hain. Approval se pehle bhi tum apne khud ke business accounts se button test kar sakte ho.

## Client ke liye (approval ke baad)
1. Nodevers login → Inbox → **Connect with Facebook**
2. Facebook login → business choose/create → WhatsApp number add + OTP
3. Done. Messages Inbox me aane lagenge.
Client ko apne WhatsApp Business account me **payment method** add karna hoga (message charges Meta client se leta hai).

## Agar kuch galat ho
- Button nahi dikh raha → 3 secrets me se koi missing hai, ya `wa-signup` deploy nahi hua.
- Popup khulte hi error → Allowed Domains / "Login with the JavaScript SDK" check karo.
- "Connected — but incoming messages could not be switched on" → client **Reconnect with Facebook** dabaye.
- Purana manual (token paste) tarika abhi bhi "Advanced" ke andar hai.
