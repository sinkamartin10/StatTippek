/**
 * Social API – játékos-keresés, követés és Top Tipsterek.
 *
 * Biztonsági elvek (a meglévő rendszerrel azonosak):
 *  - a hívót KIZÁRÓLAG a hitelesített token azonosítja (res.locals.plan.user.id);
 *    a kérés törzséből vagy útvonalából SOHA nem olvasunk ki követő-azonosítót,
 *    ezért más nevében követni technikailag sem lehet,
 *  - a célszemélyt a MEGJELENÍTÉSI NEVE azonosítja – a válaszban nincs user_id,
 *  - a keresés bemenete alakilag ellenőrzött MÉG az adatbázis-lekérdezés előtt,
 *    és a találatszám kötött,
 *  - a listák lapozottak; korlátlan lekérdezés nincs.
 *
 * A rate limitet a meglévő, globális `/api` korlát adja (240 kérés/perc/IP) –
 * nem építünk második korlátozó rendszert.
 */
import { Router, type Response } from 'express';
import { planOf } from '../billing/entitlement';
import { SocialError, type SocialService } from '../social/service';
import {
  FOLLOW_PAGE_MAX, FOLLOW_PAGE_SIZE, SEARCH_LIMIT, SEARCH_MIN_LENGTH,
} from '../../shared/social';

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

/** A művelet tulajdonosa: kizárólag a hitelesített tokenből. */
function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

const needAuth = (res: Response) =>
  res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

function handle(res: Response, e: unknown): void {
  if (e instanceof SocialError) {
    res.status(e.status).json({ error: e.message, code: e.code });
    return;
  }
  // A belső hiba részlete SOHA nem megy ki a válaszba
  console.error('[social]', e);
  res.status(500).json({ error: 'A művelet most nem hajtható végre.', code: 'SOCIAL_ERROR' });
}

/** Az útvonal :displayName paramétere ellenőrzött alakban. */
const nameOf = (req: { params: Record<string, unknown> }): string =>
  (typeof req.params.displayName === 'string' ? req.params.displayName : '');

/** Kötött oldalméret a lapozáshoz. */
const pageLimit = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(FOLLOW_PAGE_MAX, Math.floor(n)) : FOLLOW_PAGE_SIZE;
};

export function socialRouter(svc: SocialService): Router {
  const r = Router();

  // -------------------------------------------------------------------------
  // Játékos-keresés – NYILVÁNOS (minden kiadott mező eddig is nyilvános volt)
  // -------------------------------------------------------------------------
  r.get('/players/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    // Rövid töredékre nem indul adatbázis-lekérdezés
    if (q.trim().length < SEARCH_MIN_LENGTH) return res.json({ players: [] });
    try {
      res.json({ players: await svc.searchPlayers(q, SEARCH_LIMIT) });
    } catch (e) { handle(res, e); }
  });

  // -------------------------------------------------------------------------
  // Top Tipsterek – NYILVÁNOS, kötött jelöltkörrel
  // -------------------------------------------------------------------------
  r.get('/top-tipsters', async (_req, res) => {
    try { res.json(await svc.topTipsters()); } catch (e) { handle(res, e); }
  });

  // -------------------------------------------------------------------------
  // Követési állapot – bejelentkezés nélkül is olvasható (a számlálók
  // nyilvánosak), de a `following` ilyenkor mindig false.
  // -------------------------------------------------------------------------
  r.get('/follow/status/:displayName', async (req, res) => {
    const plan = planOf(res);
    const viewer = plan.enforced ? (plan.user?.id ?? null) : LOCAL_USER_ID;
    try { res.json(await svc.status(viewer, nameOf(req))); } catch (e) { handle(res, e); }
  });

  // -------------------------------------------------------------------------
  // Követés / követés megszüntetése – a követő MINDIG a hitelesített user
  // -------------------------------------------------------------------------
  r.post('/follow/:displayName', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.follow(userId, nameOf(req))); } catch (e) { handle(res, e); }
  });

  r.delete('/follow/:displayName', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.unfollow(userId, nameOf(req))); } catch (e) { handle(res, e); }
  });

  // -------------------------------------------------------------------------
  // Saját követettek / követők – lapozva, a meglévő kurzor-konvencióval
  // -------------------------------------------------------------------------
  r.get('/following', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    try { res.json(await svc.listFollowing(userId, pageLimit(req.query.limit), before)); } catch (e) { handle(res, e); }
  });

  r.get('/followers', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    try { res.json(await svc.listFollowers(userId, pageLimit(req.query.limit), before)); } catch (e) { handle(res, e); }
  });

  return r;
}
