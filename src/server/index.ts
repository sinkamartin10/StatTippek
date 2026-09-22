/**
 * TIPPMIX AI – szerver belépési pont.
 * Fejlesztésben a Vite dev szerver proxyzza ide az /api hívásokat; production módban a dist/ mappát is kiszolgálja.
 */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { buildContainer } from './container';
import { AnalysisService } from './services/analysisService';
import { apiRouter } from './routes/api';
import { billingRouter, stripeConfigured, stripeWebhook } from './billing/stripeRoutes';
import { attachPlan, requireAdmin, requirePro } from './billing/entitlement';
import { supabaseConfigured } from './billing/supabaseAdmin';

const container = buildContainer();
const service = new AnalysisService(container);
const app = express();
app.disable('x-powered-by');

// Alap biztonsági fejlécek (a Vite dev-szerver elé is kerülnek a proxyzott válaszok)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/**
 * CORS – csak akkor aktív, ha a frontend KÜLÖN hoszton van (ALLOWED_ORIGINS beállítva).
 * Szigorú allow-lista: nincs '*', és nincs credentials (a hitelesítés Bearer tokennel megy, nem sütivel).
 * Üres ALLOWED_ORIGINS esetén nem küldünk CORS fejlécet → csak azonos eredetű kérés megy át.
 */
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
);
if (allowedOrigins.size) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin.replace(/\/+$/, ''))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(origin && allowedOrigins.has(origin.replace(/\/+$/, '')) ? 204 : 403); return; }
    next();
  });
}

// Egyszerű, memóriában tartott kérés-korlát IP-nként (visszaélés / külső források túlterhelése ellen)
const hits = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT = 240; // kérés / perc
app.use('/api', (req, res, next) => {
  const ip = req.ip ?? 'ismeretlen';
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) { hits.set(ip, { count: 1, reset: now + 60_000 }); next(); return; }
  if (++h.count > RATE_LIMIT) { res.status(429).json({ error: 'Túl sok kérés – próbáld újra egy perc múlva.' }); return; }
  next();
});
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60_000).unref();

// A Stripe webhooknak NYERS body kell az aláírás-ellenőrzéshez – ezért a JSON-parser ELŐTT regisztráljuk
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => void stripeWebhook(container.db, req, res));
app.use(express.json({ limit: '100kb' }));
app.use('/api/billing', billingRouter(container.db));

// Csomag meghatározása minden /api kéréshez (token → profiles); a nyilvános végpontok ebből takarnak ki
app.use('/api', attachPlan);
// PRO-csak végpontok: szelvényépítő, előzmények, tipp mentése
app.use(['/api/slips', '/api/history'], requirePro);
app.post('/api/matches/:id/predictions', requirePro);
// Globális állapotot módosító végpontok: csak admin (ADMIN_EMAILS)
app.post('/api/settings', requireAdmin);
app.post('/api/matches/:id/odds', requireAdmin);
app.delete('/api/matches/:id/odds', requireAdmin);
app.use('/api', apiRouter(container, service));

// Ismeretlen /api útvonal
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ismeretlen API végpont.' }));

/**
 * Központi hibakezelő az /api alatt: a részleteket (stack trace, SQL üzenet) NEM adjuk ki a kliensnek,
 * csak naplózzuk. Enélkül az Express alapértelmezett HTML hibaoldala kiszivárogtatná a belső felépítést.
 */
app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] kezeletlen hiba:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Szerverhiba történt. Próbáld újra később.' });
});

if (process.env.NODE_ENV === 'production') {
  const dist = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    console.warn('Nincs dist/ mappa – futtasd előbb: npm run build');
  }
}

const port = parseInt(process.env.PORT ?? '3001', 10);
app.listen(port, async () => {
  const st = container.status();
  console.log(`TIPPMIX AI API fut: http://localhost:${port}  | adatmód: ${st.dataMode.toUpperCase()} | meccsadat: ${st.matchProvider} | kutatás: ${st.researchProvider}`);
  for (const w of st.warnings) console.warn('FIGYELEM:', w);
  console.log(`Számlázás: Supabase admin ${supabaseConfigured ? 'OK' : 'nincs (SUPABASE_SERVICE_ROLE_KEY)'} | Stripe ${stripeConfigured ? 'OK' : 'nincs (STRIPE_SECRET_KEY / STRIPE_PRICE_ID_PRO)'}`);
  console.log(`Adatbázis: tartós adat → ${container.db.storeKind === 'postgres' ? 'Supabase PostgreSQL' : 'helyi SQLite (tartalék)'} | cache → helyi SQLite`);
  console.log(`CORS: ${allowedOrigins.size ? [...allowedOrigins].join(', ') : 'kikapcsolva (csak azonos eredet)'}`);
  try {
    if (container.db.storeKind === 'postgres') {
      const missing = await container.db.healthCheck();
      if (missing.length) {
        console.error('!!! HIÁNYZÓ ADATBÁZIS-TÁBLÁK a Supabase-ben:', missing.join(', '));
        console.error('!!! Futtasd le a Supabase SQL Editorban: supabase/migrations/0003_app_data.sql');
      } else {
        console.log('Supabase séma ellenőrzés: minden tábla elérhető ✓');
      }
    }
    const pruned = container.db.pruneCache();
    if (pruned) console.log(`Lejárt cache-sorok törölve: ${pruned}`);
    // A demó-előzmény feltöltése csak helyi, egyfelhasználós módban fut (nincs valódi felhasználó, akihez kötni lehetne)
    if (container.db.storeKind === 'sqlite') {
      const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';
      const seeded = await service.seedDemoHistory(LOCAL_USER_ID);
      if (seeded) console.log(`DEMO előzmények feltöltve: ${seeded} tipp`);
      const settled = await service.settlePending(LOCAL_USER_ID);
      if (settled) console.log(`Lezárt függő tippek: ${settled}`);
    }
  } catch (e) {
    console.error('Indítási feladat hiba:', e);
  }
});
