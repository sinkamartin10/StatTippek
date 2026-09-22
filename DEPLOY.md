# Telepítés (deployment)

## Fontos: ez NEM statikus oldal

Az alkalmazás **két részből** áll:

| Rész | Mi ez | Hol futhat |
|---|---|---|
| Frontend | Vite + React SPA → statikus fájlok (`dist/`) | **Cloudflare Pages** ✅ |
| Backend (`src/server`) | Express 5 + `node:sqlite`, ESPN/RSS/Stripe hívások, Stripe webhook | **NEM fut Cloudflare Pages-en** ❌ – Node-futtató kell (Render, Railway, Fly.io, VPS) |

Miért nem: a Cloudflare Pages Functions a Workers futtatókörnyezetet használja, ahol nincs `node:sqlite`, nincs hosszan futó Express szerver és nincs helyi fájlrendszer. A szerver ezekre épül (SQLite adatbázis az előzményekhez/szelvényekhez/cache-hez, `tsx` futtatás, `express.raw` a Stripe webhookhoz).

**Következmény:** ha csak a Pages-re teszed ki, a felület betölt, de minden `/api/...` hívás 404-et ad → nincs meccs, elemzés, tipp, Stripe. A Supabase bejelentkezés/regisztráció viszont működik (az közvetlenül a Supabase-szel beszél).

## Ajánlott felállás

```
Cloudflare Pages (frontend, dist/)  ──/api/*──►  Node hoszt (Express szerver)
         │                                               │
         └── Supabase Auth (közvetlenül) ◄───────────────┘ (service_role, Stripe webhook)
```

### 1) Frontend – Cloudflare Pages

- **Framework preset:** None / Vite
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Node version:** 22 (Pages → Settings → Environment variables: `NODE_VERSION = 22`)
- **Környezeti változók (Production és Preview is):**
  - `VITE_SUPABASE_URL` = `https://<projekt>.supabase.co`
  - `VITE_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`
  - `VITE_API_URL` = a backend címe (pl. `https://tippmix-api.onrender.com`)
  - (ezek nyilvános értékek – a bundle-be kerülnek; titkot ide soha)
- SPA útvonalak: a `public/_redirects` gondoskodik róla, hogy a `/pro`, `/dashboard` stb. az `index.html`-t kapja.

### 2) Backend – Node hoszt (pl. Render)

- **Build command:** `npm ci && npm run build`
- **Start command:** `npm start`
- **Node:** 22+
- **Környezeti változók:** a `.env.example` szerverre vonatkozó része (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `ADMIN_EMAILS`, opcionális adat-API kulcsok). **Ezek titkok – csak a hoszt felületén, soha a repóban.**
- **Tárolás:** a SQLite fájl (`DATABASE_PATH`) írható lemezt igényel (Render: Persistent Disk). Enélkül újraindításkor elvész az előzmény/szelvény/cache.

### 3) Összekötés (kész)

A frontend a `VITE_API_URL` környezeti változóból veszi az API alapcímét:

- **üresen hagyva** → relatív `/api/...` hívás (helyi fejlesztés Vite proxyval, vagy ha a frontend és az API azonos hoszton van – pl. `npm start`),
- **beállítva** (pl. `https://tippmix-api.onrender.com`) → a frontend közvetlenül az API-hosztot hívja.

Külön hoszt esetén a backenden be kell állítani a **CORS allow-listát**: `ALLOWED_ORIGINS=https://tippmix-ai.pages.dev` (vesszővel több is). Csak a felsorolt eredetek kapnak `Access-Control-Allow-Origin` fejlécet, a preflight (OPTIONS) idegen eredetre 403-at ad; a hitelesítés Bearer tokennel megy, sütik nélkül.

Alternatíva `VITE_API_URL` nélkül: a `public/_redirects`-ben egy proxy sor a Pages-ről az API-hosztra:
```
/api/*  https://AZ-API-DOMAINED/api/:splat  200
```

## Telepítés utáni kötelező beállítások

1. **Supabase → Authentication → URL Configuration**
   - Site URL: a Pages domain (pl. `https://tippmix-ai.pages.dev`)
   - Redirect URLs: `https://<domain>/bejelentkezes`, `https://<domain>/uj-jelszo` (a preview domainek is, ha kell)
2. **Stripe**
   - `APP_URL` = a Pages domain (a Checkout ide tér vissza)
   - Dashboard → Developers → **Webhooks** → új endpoint: `https://<api-domain>/api/billing/webhook`, események: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` → az új **Signing secret** kerüljön a szerver `STRIPE_WEBHOOK_SECRET` változójába (a `stripe listen` whsec-je csak helyi).
   - Éles üzemhez élő kulcsok (`sk_live_…`) és élő Price ID.
3. **Supabase SQL** – ha még nem futott: `supabase/migrations/0001_profiles.sql`, majd `0002_security.sql`.
4. **Időzóna:** a szerver hosztján `TZ=Europe/Budapest` (a FREE napi kvóta és a „mai meccsek” a szerver napját használja).

## Mi kerül a repóba és mi nem

**Kell** (forrás + konfiguráció): `src/`, `index.html`, `public/`, `supabase/migrations/`, `tests/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `README.md`, `DEPLOY.md`, `.env.example`, `.gitignore`.

**Nem kell** (a `.gitignore` kizárja): `node_modules/` (a hoszt telepíti), `dist/` (a hoszt buildeli), `.env` (titkok), `data/*.db*` (helyi adatbázis), `*.log`, `.claude/` (helyi szerkesztő-konfiguráció), `*.bak`, `scratch/`, OS-fájlok.
