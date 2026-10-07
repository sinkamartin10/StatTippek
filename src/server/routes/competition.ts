/**
 * Tippverseny API.
 *
 *   /api/competition/*        – nyilvános olvasás + PRO tippbeküldés
 *   /api/admin/competition/*  – admin műveletek (a mountolásnál requireAdmin védi)
 *
 * Biztonsági elvek (a meglévő rendszerrel azonosak):
 *  - a felhasználót KIZÁRÓLAG a hitelesített Supabase token azonosítja (res.locals.plan.user.id);
 *    a kérés törzsében küldött user_id / userId mezőt SOHA nem olvassuk ki,
 *  - a points / rank / total_points / result / status mezőket a kérésből figyelmen kívül hagyjuk,
 *    ezeket kizárólag a szerver számolja és írja,
 *  - a FREE felhasználó is tippelhet, de naponta legfeljebb FREE_DAILY_PREDICTION_LIMIT
 *    ÚJ tippet adhat le (user-szintű, versenyfüggetlen kvóta); a limit kikényszerítése
 *    a szerveren, atomikusan történik – a kliens által küldött plan / quota mezőt
 *    sosem olvassuk ki,
 *  - az admin jogot a meglévő ADMIN_EMAILS alapú requireAdmin dönti el, nem a kliens.
 */
import { Router, type Response } from 'express';
import { planOf, requireAuthenticated } from '../billing/entitlement';
import { FREE_DAILY_PREDICTION_LIMIT } from '../../shared/freeQuota';
import { CompetitionError, type CompetitionService } from '../competition/service';
import { SCORING_RULES, TIE_BREAK_RULES, type RewardStatus } from '../../shared/competition';

const UUID = /^[0-9a-fA-F-]{36}$/;
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';
const REWARD_STATUSES: RewardStatus[] = ['pending', 'granted', 'used', 'cancelled'];

/** A művelet tulajdonosa: kizárólag a hitelesített tokenből. Helyi (auth nélküli) módban rögzített azonosító. */
function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });
const badId = (res: Response) => res.status(400).json({ error: 'Érvénytelen azonosító.' });

/**
 * A kérésre érvényes napi ÚJ tipp limit: PRO-nak nincs (null), FREE-nek a rögzített keret.
 * A csomagot KIZÁRÓLAG a szerveroldali entitlement adja (profiles + cache);
 * a kérés törzséből / query-jéből érkező plan, subscription, dailyCount, remaining
 * értékeket soha nem olvassuk ki.
 */
function dailyLimitFor(res: Response): number | null {
  return planOf(res).pro ? null : FREE_DAILY_PREDICTION_LIMIT;
}

function handle(res: Response, e: unknown): void {
  if (e instanceof CompetitionError) {
    res.status(e.status).json({ error: e.message, code: e.code, ...(e.details ?? {}) });
    return;
  }
  console.error('[competition]', e);
  res.status(500).json({ error: 'Szerverhiba a tippverseny feldolgozásakor.' });
}

/** Egész szám kiolvasása a kérés törzséből (string és number is elfogadott). */
function intOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d{1,2}$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

// ============================================================================
// Nyilvános útvonalak
// ============================================================================

export function competitionRouter(svc: CompetitionService): Router {
  const r = Router();

  /** Aktív és releváns versenyek (piszkozat nélkül). */
  r.get('/', async (_req, res) => {
    try { res.json(await svc.listPublic()); } catch (e) { handle(res, e); }
  });

  /** Egy verseny részletei + a pontozás és a holtverseny szabályai. */
  r.get('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try {
      const competition = await svc.getPublic(req.params.id);
      res.json({ competition, scoring: SCORING_RULES, tieBreak: TIE_BREAK_RULES });
    } catch (e) { handle(res, e); }
  });

  /** Meccsek – bejelentkezve a saját tippel és a szerver által számolt zárolás-állapottal. */
  r.get('/:id/matches', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try {
      const competition = await svc.getPublic(req.params.id);
      res.json(await svc.matchesWithPredictions(competition, ownerId(res)));
    } catch (e) { handle(res, e); }
  });

  /** Ranglista – szerveroldalon számolva, e-mail és user_id nélkül. */
  r.get('/:id/leaderboard', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try {
      await svc.getPublic(req.params.id);
      res.json(await svc.leaderboard(req.params.id, ownerId(res)));
    } catch (e) { handle(res, e); }
  });

  /** Saját tippek – más felhasználó tippjei ezen az úton nem érhetők el. */
  r.get('/:id/my-predictions', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try {
      await svc.getPublic(req.params.id);
      res.json(await svc.myPredictions(req.params.id, userId));
    } catch (e) { handle(res, e); }
  });

  /** Saját statisztika az adott versenyben. */
  r.get('/:id/me', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try {
      await svc.getPublic(req.params.id);
      res.json(await svc.myStats(req.params.id, userId, dailyLimitFor(res)));
    } catch (e) { handle(res, e); }
  });

  /**
   * Tipp leadása / módosítása.
   *
   * Bejelentkezés kötelező (requireAuthenticated → 401). A csomag nem zár ki:
   *  - PRO  : nincs napi korlát (a korábbi működés változatlan),
   *  - FREE : naponta legfeljebb 3 ÚJ tipp; a limit elérése után 403
   *           FREE_DAILY_LIMIT_REACHED, a válaszban limit / used / remaining / resetAt.
   * Meglévő tipp módosítása nem fogyaszt kvótát. A részvétel további feltételei
   * (megjelenítési név, verseny állapota, kickoff-zárolás) változatlanok.
   *
   * A törzsből KIZÁRÓLAG a competitionMatchId és a két gólszám olvasódik ki.
   */
  r.post('/:id/predictions', requireAuthenticated, async (req, res) => {
    const competitionId = typeof req.params.id === 'string' ? req.params.id : '';
    if (!UUID.test(competitionId)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);

    const matchId = typeof req.body?.competitionMatchId === 'string' ? req.body.competitionMatchId : '';
    if (!UUID.test(matchId)) return badId(res);
    const home = intOf(req.body?.predictedHomeScore);
    const away = intOf(req.body?.predictedAwayScore);
    if (home == null || away == null) return res.status(400).json({ error: 'Add meg mindkét csapat tippelt gólszámát (0–99 egész szám).' });

    try {
      // Helyi, Supabase nélküli módban nincs profil, ezért ott nem követelünk megjelenítési nevet
      const saved = await svc.submitPrediction(
        competitionId, userId, matchId, home, away, new Date(), planOf(res).enforced, dailyLimitFor(res),
      );
      res.json(saved);
    } catch (e) { handle(res, e); }
  });

  return r;
}

// ============================================================================
// Admin útvonalak (a mount helyén requireAdmin védi mindet)
// ============================================================================

export function adminCompetitionRouter(svc: CompetitionService): Router {
  const r = Router();

  /** A szolgáltatóból ténylegesen elérhető ligák – csak ezekből indítható verseny. */
  r.get('/leagues', async (_req, res) => {
    try { res.json(await svc.availableLeagues()); } catch (e) { handle(res, e); }
  });

  /** Minden verseny, a piszkozatokkal együtt. */
  r.get('/', async (_req, res) => {
    try { res.json(await svc.listAll()); } catch (e) { handle(res, e); }
  });

  /** Új verseny. A status mindig 'draft' – a kérésből érkező status mezőt figyelmen kívül hagyjuk. */
  r.post('/', async (req, res) => {
    try {
      const created = await svc.create({
        name: String(req.body?.name ?? ''),
        leagueKey: String(req.body?.leagueKey ?? ''),
        startsAt: String(req.body?.startsAt ?? ''),
        endsAt: String(req.body?.endsAt ?? ''),
      });
      res.json(created);
    } catch (e) { handle(res, e); }
  });

  r.get('/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try {
      const competition = await svc.get(req.params.id);
      res.json({ competition, matches: await svc.listMatches(req.params.id), rewards: await svc.rewards(req.params.id) });
    } catch (e) { handle(res, e); }
  });

  r.post('/:id/activate', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try { res.json(await svc.activate(req.params.id)); } catch (e) { handle(res, e); }
  });

  r.post('/:id/schedule', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try { res.json(await svc.schedule(req.params.id)); } catch (e) { handle(res, e); }
  });

  r.post('/:id/cancel', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try { res.json(await svc.cancel(req.params.id)); } catch (e) { handle(res, e); }
  });

  /** Meccsek szinkronizálása – idempotens, a meglévő tippeket nem érinti. */
  r.post('/:id/sync', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try { res.json(await svc.syncMatches(req.params.id)); } catch (e) { handle(res, e); }
  });

  /** Lezárás: pontozás + végleges ranglista + jutalom-nyilvántartás (idempotens). */
  r.post('/:id/finish', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try { res.json(await svc.finish(req.params.id)); } catch (e) { handle(res, e); }
  });

  r.get('/:id/leaderboard', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try {
      await svc.get(req.params.id);
      res.json(await svc.adminLeaderboard(req.params.id));
    } catch (e) { handle(res, e); }
  });

  r.get('/:id/rewards', async (req, res) => {
    if (!UUID.test(req.params.id)) return badId(res);
    try {
      await svc.get(req.params.id);
      res.json(await svc.rewards(req.params.id));
    } catch (e) { handle(res, e); }
  });

  /**
   * Jutalom státuszának kézi módosítása (pending → granted → used).
   * FONTOS: ez CSAK nyilvántartás – Stripe előfizetést nem módosít, PRO-t nem ad automatikusan.
   */
  r.patch('/:id/rewards/:rewardId', async (req, res) => {
    if (!UUID.test(req.params.id) || !UUID.test(req.params.rewardId)) return badId(res);
    const status = String(req.body?.status ?? '') as RewardStatus;
    if (!REWARD_STATUSES.includes(status)) return res.status(400).json({ error: 'Érvénytelen jutalom-státusz.' });
    try { res.json(await svc.setRewardStatus(req.params.id, req.params.rewardId, status)); } catch (e) { handle(res, e); }
  });

  return r;
}
