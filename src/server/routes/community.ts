/**
 * Közösségi Feed API (MVP).
 *
 * Biztonsági elvek (a meglévő social API-val azonosak):
 *  - a hívót KIZÁRÓLAG a hitelesített token azonosítja (res.locals.plan.user.id); a kérés
 *    törzséből vagy útvonalából SOHA nem olvasunk ki szerző- vagy lájkoló-azonosítót, ezért más
 *    nevében írni, törölni vagy lájkolni technikailag sem lehet,
 *  - írás (bejegyzés, törlés, lájk) csak bejelentkezve; a „Mindenki” nézet olvasása nyilvános,
 *  - a válaszban nincs user_id; a lista lapozott, a lapméret kötött.
 *
 * A rate limitet a meglévő, globális `/api` korlát adja (240 kérés/perc/IP); a bejegyzés-írást
 * ezen felül a szolgáltatás felhasználónkénti várakozási ideje korlátozza.
 */
import { Router, type Response } from 'express';
import { planOf } from '../billing/entitlement';
import { CommunityError, type CommunityService } from '../community/service';

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

/** A néző / a művelet tulajdonosa: kizárólag a hitelesített tokenből. */
function userOf(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

const needAuth = (res: Response) =>
  res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

function handle(res: Response, e: unknown): void {
  if (e instanceof CommunityError) {
    res.status(e.status).json({ error: e.message, code: e.code });
    return;
  }
  // A belső hiba részlete SOHA nem megy ki a válaszba
  console.error('[community]', e);
  res.status(500).json({ error: 'A művelet most nem hajtható végre.', code: 'COMMUNITY_ERROR' });
}

export function communityRouter(svc: CommunityService): Router {
  const r = Router();

  // Feed – a „Mindenki” nézet nyilvános, a „Követettek” bejelentkezést kér (a szolgáltatás dönt)
  r.get('/feed', async (req, res) => {
    try { res.json(await svc.feed(userOf(res), req.query.view, req.query.before)); } catch (e) { handle(res, e); }
  });

  r.post('/posts', async (req, res) => {
    const userId = userOf(res);
    if (!userId) return needAuth(res);
    // CSAK a `body` mező számít; bármilyen más mező (pl. userId) figyelmen kívül marad
    const body = (req.body as { body?: unknown } | undefined)?.body;
    try { res.status(201).json(await svc.createPost(userId, body)); } catch (e) { handle(res, e); }
  });

  r.delete('/posts/:id', async (req, res) => {
    const userId = userOf(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.deletePost(userId, req.params.id)); } catch (e) { handle(res, e); }
  });

  r.post('/posts/:id/like', async (req, res) => {
    const userId = userOf(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.like(userId, req.params.id)); } catch (e) { handle(res, e); }
  });

  r.delete('/posts/:id/like', async (req, res) => {
    const userId = userOf(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.unlike(userId, req.params.id)); } catch (e) { handle(res, e); }
  });

  return r;
}
