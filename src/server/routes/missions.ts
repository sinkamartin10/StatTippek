/**
 * Küldetés API – a bejelentkezett felhasználó SAJÁT küldetései.
 *
 * Biztonsági elvek:
 *  - a felhasználót kizárólag a hitelesített Supabase token azonosítja;
 *    a kérésben küldött user_id / progress / completed / reward / xp mezőket SOHA nem olvassuk,
 *  - a haladást és a teljesítést a szerver számolja újra minden átvételkor,
 *  - a jutalom idempotens: ugyanaz a küldetés ugyanabban a periódusban egyszer fizet.
 */
import { Router, type Response } from 'express';
import { planOf } from '../billing/entitlement';
import { MissionError, type MissionService } from '../missions/service';

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';
const MISSION_KEY = /^[a-z0-9_]{2,64}$/;

function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

function handle(res: Response, e: unknown): void {
  if (e instanceof MissionError) { res.status(e.status).json({ error: e.message, code: e.code }); return; }
  console.error('[missions]', e);
  res.status(500).json({ error: 'Szerverhiba a küldetések feldolgozásakor.' });
}

export function missionsRouter(svc: MissionService): Router {
  const r = Router();

  /** Saját napi és heti küldetések, szerveroldalon számolt haladással. */
  r.get('/', async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.overview(userId)); } catch (e) { handle(res, e); }
  });

  /**
   * Jutalom átvétele. A törzsből SEMMIT nem olvasunk ki – a küldetés az útvonalból jön,
   * a teljesítést pedig a szerver ellenőrzi újra.
   */
  r.post('/:key/claim', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    const key = typeof req.params.key === 'string' ? req.params.key : '';
    if (!MISSION_KEY.test(key)) return res.status(400).json({ error: 'Érvénytelen küldetés-azonosító.' });
    try { res.json(await svc.claim(userId, key)); } catch (e) { handle(res, e); }
  });

  return r;
}
