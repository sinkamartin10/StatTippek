/**
 * Profil API – megjelenítési név (Display Name).
 *
 * Biztonsági elvek:
 *  - a felhasználót KIZÁRÓLAG a hitelesített Supabase token azonosítja (res.locals.plan.user.id);
 *    a kérés törzsében küldött user_id / userId / id mezőt SOHA nem olvassuk ki,
 *    ezért más felhasználó nevét technikailag sem lehet módosítani,
 *  - a név ellenőrzése (hossz, karakterek, tiltólista) KÖTELEZŐEN itt, a szerveren fut –
 *    a kliensoldali ellenőrzés csak azonnali visszajelzés,
 *  - az egyediséget az adatbázis kis-nagybetűtől független egyedi indexe garantálja.
 */
import { Router, type Response } from 'express';
import { planOf } from '../billing/entitlement';
import type { DisplayNameDirectory } from '../profile/displayNameDirectory';
import {
  DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, DISPLAY_NAME_RULES, validateDisplayName,
} from '../../shared/displayName';

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

export function profileRouter(names: DisplayNameDirectory): Router {
  const r = Router();

  /** A bejelentkezett felhasználó megjelenítési neve és a rá vonatkozó szabályok. */
  r.get('/me', async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try {
      const displayName = await names.get(userId);
      res.json({
        displayName,
        hasDisplayName: !!displayName,
        rules: DISPLAY_NAME_RULES,
        min: DISPLAY_NAME_MIN,
        max: DISPLAY_NAME_MAX,
      });
    } catch (e) {
      console.error('[profil] me:', e);
      res.status(500).json({ error: 'A profil nem tölthető be.' });
    }
  });

  /**
   * Megjelenítési név beállítása / módosítása – mindig a SAJÁT profilon.
   * A törzsből kizárólag a displayName mezőt olvassuk ki.
   */
  r.put('/display-name', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);

    const raw = typeof req.body?.displayName === 'string' ? req.body.displayName : '';
    const check = validateDisplayName(raw);
    if (!check.ok) {
      // Tiltott kifejezésnél szándékosan nem áruljuk el, melyik szó okozta
      return res.status(400).json({ error: check.message, code: check.error });
    }

    try {
      const saved = await names.set(userId, check.value);
      if (!saved.ok) {
        return res.status(saved.reason === 'TAKEN' ? 409 : 500).json({ error: saved.message, code: saved.reason });
      }
      res.json({ displayName: check.value, hasDisplayName: true });
    } catch (e) {
      console.error('[profil] display-name:', e);
      res.status(500).json({ error: 'A megjelenítési név mentése nem sikerült.' });
    }
  });

  return r;
}
