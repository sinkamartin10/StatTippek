/**
 * 1v1 Tipp Battle API.
 *
 * Biztonsági elvek (a meglévő rendszerrel azonosak):
 *  - a hívót KIZÁRÓLAG a hitelesített Supabase token azonosítja
 *    (res.locals.plan.user.id); a kérés törzsében küldött user_id / userId /
 *    plan / subscription / isPro mezőt SOHA nem olvassuk ki,
 *  - a points / winner / status / xp mezőket a kérésből figyelmen kívül hagyjuk,
 *    ezeket kizárólag a szerver számolja és írja,
 *  - a battle PRO funkció: új párbaj indítása és elfogadása requirePro mögött van.
 *
 * PRO LEJÁRAT (szándékos, dokumentált kivétel):
 * Új párbaj INDÍTÁSA és ELFOGADÁSA szigorúan PRO. A már elfogadott (active)
 * párbaj viszont végigfut akkor is, ha a felhasználó közben elveszíti a PRO-t:
 * ezért a lista, a részletek, a tippbeküldés, az elutasítás és a visszavonás
 * csak bejelentkezést kér. Így senki nem tud PRO nélkül ÚJ kötelezettséget
 * vállalni, de a futó párbaj nem szakad meg félúton.
 */
import { Router, type Response } from 'express';
import { planOf, requireAuthenticated, requirePro } from '../billing/entitlement';
import { BattleError, type BattleService } from '../battles/service';
import { BATTLE_MATCH_COUNT, MAX_PENDING_BATTLES } from '../../shared/battles';

const UUID = /^[0-9a-fA-F-]{36}$/;
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

/** A művelet tulajdonosa: kizárólag a hitelesített tokenből. */
function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

/** Az útvonal :id paramétere ellenőrzött alakban (Express 5 string | string[]-et ad). */
const idOf = (req: { params: Record<string, unknown> }): string =>
  (typeof req.params.id === 'string' ? req.params.id : '');

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });
const badId = (res: Response) => res.status(400).json({ error: 'Érvénytelen azonosító.', code: 'INVALID_ID' });

function handle(res: Response, e: unknown): void {
  if (e instanceof BattleError) {
    res.status(e.status).json({ error: e.message, code: e.code, ...(e.details ?? {}) });
    return;
  }
  console.error('[battles]', e);
  res.status(500).json({ error: 'Szerverhiba a párbaj feldolgozásakor.' });
}

/** Egész szám kiolvasása a kérés törzséből (string és number is elfogadott). */
function intOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d{1,2}$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

export function battlesRouter(svc: BattleService): Router {
  const r = Router();

  /** Saját párbajok: bejövő, kimenő, folyamatban, lezárt. Lusta lejárat és lezárás itt történik. */
  r.get('/', requireAuthenticated, async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.list(userId, new Date())); } catch (e) { handle(res, e); }
  });

  /**
   * Új párbaj indítása – PRO. A törzsből KIZÁRÓLAG az opponentId és a
   * competitionMatchIds olvasódik ki; minden más mezőt figyelmen kívül hagyunk.
   */
  r.post('/', requirePro, async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);

    const opponentId = typeof req.body?.opponentId === 'string' ? req.body.opponentId : '';
    if (!UUID.test(opponentId)) return badId(res);

    const raw = req.body?.competitionMatchIds;
    if (!Array.isArray(raw)) {
      return res.status(422).json({
        error: `A párbaj pontosan ${BATTLE_MATCH_COUNT} mérkőzésből áll – add meg a mérkőzések listáját.`,
        code: 'BATTLE_MATCH_COUNT_INVALID', required: BATTLE_MATCH_COUNT,
      });
    }
    const ids = raw.filter((v: unknown): v is string => typeof v === 'string' && UUID.test(v));
    if (ids.length !== raw.length) return badId(res);

    try { res.json(await svc.create(userId, opponentId, ids, new Date())); } catch (e) { handle(res, e); }
  });

  /** Kihívható ellenfelek – kizárólag a Tippverseny ranglistáján szereplő PRO résztvevők. */
  r.get('/eligible-opponents', requirePro, async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.eligibleOpponents(userId)); } catch (e) { handle(res, e); }
  });

  /** Választható mérkőzések (scheduled, kickoff előtt). */
  r.get('/eligible-matches', requirePro, async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.eligibleMatches(new Date())); } catch (e) { handle(res, e); }
  });

  /** Egy párbaj részletei. A szerver takarja ki az ellenfél tippjét kickoff előtt. */
  r.get('/:id', requireAuthenticated, async (req, res) => {
    const battleId = idOf(req);
    if (!UUID.test(battleId)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.get(userId, battleId, new Date())); } catch (e) { handle(res, e); }
  });

  /** Elfogadás – PRO, csak a kihívott, csak le nem járt kihívás. */
  r.post('/:id/accept', requirePro, async (req, res) => {
    const battleId = idOf(req);
    if (!UUID.test(battleId)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.accept(userId, battleId, new Date())); } catch (e) { handle(res, e); }
  });

  /** Elutasítás – csak a kihívott. */
  r.post('/:id/decline', requireAuthenticated, async (req, res) => {
    const battleId = idOf(req);
    if (!UUID.test(battleId)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.decline(userId, battleId, new Date())); } catch (e) { handle(res, e); }
  });

  /** Visszavonás – csak a kihívó, csak nyitott kihívás. */
  r.post('/:id/cancel', requireAuthenticated, async (req, res) => {
    const battleId = idOf(req);
    if (!UUID.test(battleId)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json(await svc.cancel(userId, battleId, new Date())); } catch (e) { handle(res, e); }
  });

  /**
   * Battle-tipp leadása / módosítása. KIZÁRÓLAG a battle_predictions táblába ír –
   * a Tippverseny user_predictions táblájához nem nyúl.
   * Bejelentkezés kell, de nem PRO: a már elfogadott párbaj a PRO lejárata után is
   * végigvihető (lásd a fájl fejlécét).
   */
  r.post('/:id/predictions', requireAuthenticated, async (req, res) => {
    const battleId = idOf(req);
    if (!UUID.test(battleId)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);

    const matchId = typeof req.body?.competitionMatchId === 'string' ? req.body.competitionMatchId : '';
    if (!UUID.test(matchId)) return badId(res);
    const home = intOf(req.body?.predictedHomeScore);
    const away = intOf(req.body?.predictedAwayScore);
    if (home == null || away == null) {
      return res.status(400).json({
        error: 'Add meg mindkét csapat tippelt gólszámát (0–99 egész szám).', code: 'INVALID_SCORE',
      });
    }

    try {
      res.json(await svc.submitPrediction(userId, battleId, matchId, home, away, new Date()));
    } catch (e) { handle(res, e); }
  });

  /** A szabályok – a felület innen olvassa a korlátokat, nem égeti be. */
  r.get('/meta/rules', requireAuthenticated, (_req, res) => {
    res.json({ matchCount: BATTLE_MATCH_COUNT, maxPending: MAX_PENDING_BATTLES });
  });

  return r;
}
