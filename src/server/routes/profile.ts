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
import { ProgressionError, type ProgressionService } from '../progression/service';
import { EMPTY_EQUIPS, PROFILE_SLOTS } from '../../shared/shop';
import {
  DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, DISPLAY_NAME_RULES,
  isLookupSafeDisplayName, validateDisplayName,
} from '../../shared/displayName';

const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

/** Egységes „nincs ilyen játékos” válasz – nem árul el létezést és hibát sem. */
const notFoundPlayer = (res: Response) =>
  res.status(404).json({ error: 'Nincs ilyen játékos.', code: 'PLAYER_NOT_FOUND' });

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

export function profileRouter(
  names: DisplayNameDirectory,
  /**
   * Opcionális progression-réteg a SHOP kozmetikumok felvételéhez. Ha nincs
   * megadva, a profil API működése bitre azonos a korábbival.
   */
  progression?: ProgressionService,
): Router {
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
   * A felvett SHOP kozmetikumok olvasása és írása.
   *
   * KÜLÖN RENDSZER a megszolgált testreszabástól (`PUT /api/progression/settings`):
   * saját slotok, saját oszlopok, és NINCS PRO-kapu – a coin FREE-vel is
   * megszerezhető, ezért a megvásárolt kozmetikum FREE felhasználónak is
   * felvehető. A megszolgált kozmetikumok PRO-szabályai változatlanok.
   *
   * A törzsből KIZÁRÓLAG a `slot` és az `itemKey` mezőt olvassuk ki: a
   * kategória, a ritkaság, az ár, a név és a metadata SOSEM authority – ezek a
   * készletből és a katalógusból jönnek. A felhasználót kizárólag a
   * hitelesített token azonosítja, ezért a `userId` / `targetUserId` /
   * `ownerId` / `recipient` mező hatástalan.
   */
  r.get('/customization', async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    if (!progression) return res.json({ shop: { ...EMPTY_EQUIPS }, slots: PROFILE_SLOTS });
    try {
      res.json({ shop: await progression.shopCustomization(userId), slots: PROFILE_SLOTS });
    } catch (e) {
      console.error('[profil] customization:', e);
      res.status(500).json({ error: 'A testreszabás nem tölthető be.' });
    }
  });

  r.put('/customization', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    if (!progression) return res.status(503).json({ error: 'A testreszabás most nem elérhető.', code: 'UNAVAILABLE' });

    // `itemKey: null` = levétel. A hiányzó mező is levételt jelent.
    const itemKey = req.body?.itemKey === undefined ? null : req.body.itemKey;
    try {
      const { equips, slot } = await progression.equipShopItem(userId, req.body?.slot, itemKey);
      res.json({ shop: equips, slot });
    } catch (e) {
      if (e instanceof ProgressionError) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error('[profil] customization mentés:', e);
      res.status(500).json({ error: 'A testreszabás nem mentheto.' });
    }
  });

  /**
   * NYILVÁNOS játékosprofil a megjelenítési név alapján.
   *
   * Hitelesítés NEM kell: minden kiadott mező eddig is nyilvános volt
   * (ranglista-megjelenés, versenypontok, szint, achievement). A válasz
   * alakját a `shared/publicProfile.ts` engedélyező listája zárja le, ezért
   * nyers adatbázis-sor nem jut ki.
   *
   * SOHA NEM kerül a válaszba: user_id, e-mail, hitelesítési adat,
   * coin-egyenleg, coin-tranzakció, vásárlási előzmény, készlet, Stripe- és
   * előfizetési adat, privát beállítás, egyedi tipp részletei, IP, belső
   * adatbázis-azonosító.
   *
   * Ismeretlen játékos: egységes 404, ugyanazzal az üzenettel, mint az
   * alakilag hibás név – így a válaszból nem derül ki, hogy létezik-e a név
   * (felhasználó-felderítés ellen), és adatbázis-hiba sem szivárog ki.
   */
  r.get('/public/:displayName', async (req, res) => {
    const raw = typeof req.params.displayName === 'string' ? req.params.displayName : '';

    // Alaki ellenőrzés MÉG a lekérdezés előtt (a meglévő név-szabályokkal):
    // így a tárba sosem jut mintakarakter vagy méreten kívüli érték.
    if (!isLookupSafeDisplayName(raw)) return notFoundPlayer(res);

    try {
      const found = await names.findByName(raw);
      if (!found) return notFoundPlayer(res);
      if (!progression) return res.status(503).json({ error: 'A játékosprofil most nem elérhető.', code: 'UNAVAILABLE' });

      // A `found.userId` csak szerveroldalon él – a szerializáló nem kapja meg.
      const profile = await progression.publicProfileFor(found.userId, found.displayName);
      res.json(profile);
    } catch (e) {
      // A belső hiba részlete sosem megy ki a válaszba
      console.error('[profil] nyilvános profil:', e);
      res.status(500).json({ error: 'A játékosprofil most nem tölthető be.', code: 'PROFILE_UNAVAILABLE' });
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
