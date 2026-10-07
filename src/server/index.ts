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
import { adminCompetitionRouter, competitionRouter } from './routes/competition';
import { CompetitionService } from './competition/service';
import { profileRouter } from './routes/profile';
import { progressionRouter } from './routes/progression';
import { missionsRouter } from './routes/missions';
import { battlesRouter } from './routes/battles';
import { MissionService } from './missions/service';
import { BattleService } from './battles/service';
import { ProgressionService } from './progression/service';
import { getProfile, profileIsPro, proUserIds } from './billing/supabaseAdmin';
import { billingRouter, stripeConfigured, stripeWebhook } from './billing/stripeRoutes';
import { attachPlan, requireAdmin, requirePro } from './billing/entitlement';
import { supabaseConfigured } from './billing/supabaseAdmin';

const container = buildContainer();
const service = new AnalysisService(container);
// A PRO-állapot KIZÁRÓLAG szerveroldalról, a meglévő profiles/Stripe adatból jön
const progressionService = new ProgressionService(
  container.progression,
  async (userId) => profileIsPro(await getProfile(userId)),
  // Kötegelt PRO-ellenőrzés a ranglistához: N felhasználó → EGY lekérdezés
  (userIds) => proUserIds(userIds),
);
const missionService = new MissionService(container.progression, async (userId) => profileIsPro(await getProfile(userId)));
const competitionService = new CompetitionService(
  container.competitions, container.data, container.displayNames, progressionService,
  // Jutalom-jogosultság: a Tippverseny PRO jutalmaira CSAK PRO résztvevő jogosult.
  // A pontozást, a sorrendet és a nyilvános ranglistát ez NEM befolyásolja.
  // Supabase nélküli helyi módban nincs csomag-fogalom → nincs szűrés.
  supabaseConfigured ? (userIds) => proUserIds(userIds) : undefined,
);
/**
 * 1v1 Tipp Battle. Saját táblák; a Tippverseny tárolójából KIZÁRÓLAG OLVAS
 * (mérkőzésadat és a ranglista résztvevői köre). A user_predictions-hez nem nyúl,
 * ezért a battle nem jelenik meg a Tippverseny ranglistán, nem fogyaszt FREE napi
 * kvótát, nem számít küldetés-haladásba, és nem ad XP-t vagy helyezést.
 */
const battleService = new BattleService(
  container.battles,
  container.competitions,
  container.displayNames,
  async (userId) => profileIsPro(await getProfile(userId)),
  (userIds) => proUserIds(userIds),
  (userIds) => progressionService.publicProfiles(userIds),
);

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
      // PUT: profil megjelenítési név · PATCH: jutalom-státusz (admin) – enélkül a böngésző blokkolja a preflightot
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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
// Tippverseny: a nyilvános rész olvasható (a tippbeküldés a routeren belül requirePro),
// az admin rész teljes egészében a meglévő ADMIN_EMAILS alapú ellenőrzés mögött van
app.use('/api/admin/competition', requireAdmin, adminCompetitionRouter(competitionService));
app.use('/api/competition', competitionRouter(competitionService));
// Profil: megjelenítési név (a meglévő profiles táblán) – minden írás a hitelesített userhez kötve
app.use('/api/profile', profileRouter(container.displayNames));
// Progression: saját XP/achievement állapot olvasása és a testreszabás mentése (PRO)
app.use('/api/progression', progressionRouter(progressionService));
// Küldetések: a haladás számított, a jutalom idempotens és a meglévő XP-rendszerbe kerül
app.use('/api/missions', missionsRouter(missionService));
// 1v1 Tipp Battle: saját tipptábla; a Tippverseny adatait nem módosítja
app.use('/api/battles', battlesRouter(battleService));
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
      const missingCompetition = await container.competitions.healthCheck();
      if (missingCompetition.length) {
        console.warn('Tippverseny táblák hiányoznak:', missingCompetition.join(', '));
        console.warn('Futtasd le a Supabase SQL Editorban: supabase/migrations/0004_prediction_league.sql');
      }
      const missingProgression = await container.progression.healthCheck();
      if (missingProgression.length) {
        console.warn('Progression táblák hiányoznak:', missingProgression.join(', '));
        console.warn('Futtasd le a Supabase SQL Editorban: supabase/migrations/0006_progression.sql, 0007_missions.sql, 0008_free_daily_quota.sql és 0009_battles.sql');
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
