/**
 * Progression API – a bejelentkezett felhasználó SAJÁT állapota.
 *
 * Biztonsági elvek:
 *  - a felhasználót kizárólag a hitelesített Supabase token azonosítja (res.locals.plan.user.id);
 *    a kérés törzsében küldött user_id / xp / level / achievements / unlocked mezőket SOHA nem olvassuk,
 *  - XP-t és achievementet a kliens nem adhat magának: nincs ilyen végpont, az írás kizárólag
 *    a Tippverseny kiértékeléséből származik,
 *  - a testreszabás mentése PRO-hoz kötött, és minden választást a szerver ellenőriz.
 */
import { Router, type Response } from 'express';
import { planOf } from '../billing/entitlement';
import { ProgressionError, type ProgressionService } from '../progression/service';
import type { AvatarSlot, ProfileSettings } from '../../shared/progression';
import { AVATAR_SLOTS, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, MAX_SHOWCASE } from '../../shared/progression';

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

function handle(res: Response, e: unknown): void {
  if (e instanceof ProgressionError) { res.status(e.status).json({ error: e.message, code: e.code }); return; }
  console.error('[progression]', e);
  res.status(500).json({ error: 'Szerverhiba a profil feldolgozásakor.' });
}

/** A törzsből KIZÁRÓLAG a választást olvassuk ki – XP-t, szintet, feloldást nem. */
function readSettings(body: unknown): Partial<ProfileSettings> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<ProfileSettings> = {};

  if (b.avatar && typeof b.avatar === 'object') {
    const src = b.avatar as Record<string, unknown>;
    const avatar: Partial<Record<AvatarSlot, string>> = {};
    for (const slot of AVATAR_SLOTS) if (typeof src[slot] === 'string') avatar[slot] = src[slot] as string;
    out.avatar = avatar as ProfileSettings['avatar'];
  }
  if (typeof b.border === 'string') out.border = b.border;
  if (typeof b.title === 'string') out.title = b.title;
  if (Array.isArray(b.showcase)) {
    out.showcase = b.showcase.filter((x): x is string => typeof x === 'string').slice(0, MAX_SHOWCASE + 1);
  }
  return out;
}

export function progressionRouter(svc: ProgressionService): Router {
  const r = Router();

  /** Saját progression-állapot: XP, szint, statisztika, achievementek, katalógus, beállítások. */
  r.get('/me', async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.profile(userId)); } catch (e) { handle(res, e); }
  });

  /**
   * Saját tipster statisztika. A felhasználót KIZÁRÓLAG a token azonosítja –
   * a queryben vagy a törzsben küldött user_id-t nem olvassuk, így más adata nem kérhető le.
   */
  r.get('/stats', async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.tipsterStats(userId)); } catch (e) { handle(res, e); }
  });

  /**
   * Saját tipp-előzmény, legfrissebb elöl. A limitet a szerver korlátozza
   * (alapértelmezés 50, legfeljebb 100); érvénytelen érték esetén az alapértelmezés érvényes.
   */
  r.get('/history', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    const raw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT;
    try { res.json(await svc.predictionHistory(userId, limit)); } catch (e) { handle(res, e); }
  });

  /** Testreszabás mentése (PRO). A szerver minden választást ellenőriz a feloldott elemek ellen. */
  r.put('/settings', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.saveSettings(userId, readSettings(req.body))); } catch (e) { handle(res, e); }
  });

  return r;
}
