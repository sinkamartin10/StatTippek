/**
 * Párbaj – SZOCIÁLIS BELÉPÉSI PONT a nyilvános játékosprofilról.
 *
 * Ez a fázis NEM épített új párbajrendszert: a meglévő 1v1 Tipp Battle
 * (állapotgép, mérkőzésválasztás, zárolás, pontozás, lezárás, jogosultság)
 * változatlan, és azt a `tests/battles.test.ts` 55 tesztje fedi. Itt kizárólag
 * az ÚJ felületi réteget és a hozzá tartozó határokat ellenőrizzük:
 *
 *   • a kihívás-gomb mikor jelenik meg és mikor NEM,
 *   • a nyilvános profil API alakja NEM változott (nincs user_id-szivárgás),
 *   • a meglévő battle-szabályok érintetlenek (regresszió).
 *
 * A projektben nincs DOM-futtató, ezért a komponens-szerződést a forráson
 * mérjük – ugyanaz a minta, mint a `cosmeticsV2.test.ts`-ben. A tényleges
 * megjelenést valódi böngészőben néztem meg (lásd a reportot).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BATTLE_MATCH_COUNT, BATTLE_STATUSES, BATTLE_XP, INVITE_TTL_HOURS, MAX_PENDING_BATTLES,
  battleWinner,
} from '../src/shared/battles';
import { POINTS_EXACT, POINTS_OUTCOME, scorePrediction } from '../src/shared/competition';
import { FREE_DAILY_PREDICTION_LIMIT } from '../src/shared/freeQuota';
import { toPublicProfile } from '../src/shared/publicProfile';

const read = (p: string) => readFileSync(p, 'utf8');
/** A forrás KÓD-része, kommentek nélkül – a fejléc szándékosan megnevez tiltott mezőket. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

const ACTION = 'src/client/components/ChallengeAction.tsx';
const PROFILE = 'src/client/pages/PublicProfile.tsx';
const BATTLES_PAGE = 'src/client/pages/Battles.tsx';
const BATTLES_ROUTE = 'src/server/routes/battles.ts';

// ===========================================================================
// 1) A kihívás-gomb láthatósága
// ===========================================================================

describe('Párbaj belépési pont – láthatóság', () => {
  const src = read(ACTION);

  it('D1. saját profilon NEM jelenik meg kihívás-gomb', () => {
    expect(src).toContain('if (isMe) return null;');
    // a profil a saját eset kezelését külön ágon oldja meg
    expect(read(PROFILE)).toContain('Ez a te profilod');
  });

  it('D2. a profil csak a NEM saját ágon rendereli a komponenst', () => {
    const profile = read(PROFILE);
    expect(profile).toContain('<ChallengeAction displayName={p.displayName} isMe={isMe} />');
    expect(profile).toMatch(/isMe\s*\n?\s*\?\s*<Link to="\/profil"/);
  });

  it('D3. kijelentkezve a profil látható marad, a kihívás bejelentkezésre visz', () => {
    expect(src).toContain('if (configured && !loggedIn)');
    expect(src).toContain('to="/bejelentkezes"');
    expect(src).toContain('Jelentkezz be a kihíváshoz');
  });

  it('D4. FREE felhasználó IS kihívhat: nincs csomagkapu a komponensben', () => {
    expect(src).toContain('const canChallenge = !configured || loggedIn;');
    // a korábbi PRO-terelés megszűnt
    expect(src).not.toContain('to="/pro"');
    expect(src).not.toMatch(/configured && !pro/);
  });

  it('D5. már nyitott párbajnál NEM indít újat, hanem a meglévőre mutat', () => {
    expect(src).toContain("kind: 'open'");
    expect(src).toContain('Függőben lévő párbaj');
    expect(src).toContain('/battles/${encodeURIComponent(state.data.battleId)}');
  });

  it('D6. nem kihívható játékosnál magyarázatot ad, nem gombot', () => {
    expect(src).toContain("('not-eligible' as const)");
    expect(src).toContain("state.data.kind === 'not-eligible'");
    expect(src).toContain('megjelenítési nevet beállított játékosok');
  });

  it('D7. a kihívás-gomb a MEGLÉVŐ párbaj-folyamatba visz, nem új rendszerbe', () => {
    expect(src).toContain('/battles?kihivas=${encodeURIComponent(displayName)}');
    expect(src).toContain('Párbajra hívás');
  });

  it('D8. felesleges hálózati kérés nincs: csak értelmes esetben indul lekérdezés', () => {
    expect(src).toContain('if (!active) return null;');
    expect(src).toContain('const active = !isMe && canChallenge;');
  });

  it('D9. a két lekérdezés párhuzamos és hibatűrő (a profilt nem töri el)', () => {
    expect(src).toContain('Promise.all');
    expect(src).toContain('.catch(() => null)');
    expect(src).toContain('.catch(() => [])');
  });
});

// ===========================================================================
// 2) Adatvédelem – a nyilvános profil alakja nem változott
// ===========================================================================

describe('Párbaj belépési pont – adatvédelem', () => {
  it('D10. a belépési pont NEM a nyilvános profilból veszi az azonosítót', () => {
    const c = code(ACTION);
    // a kihíváshoz szükséges userId a HITELESÍTETT eligible-opponents végpontról jön
    expect(c).toContain('api.battleEligibleOpponents()');
    // és sosem a publikus profilból
    expect(c).not.toContain('api.publicProfile');
  });

  it('D11. a párosítás megjelenítési NÉV alapján történik, a meglévő szabállyal', () => {
    const c = code(ACTION);
    expect(c).toContain('sameDisplayName(');
    expect(c).not.toMatch(/\buser_id\b|\buserId\s*:/);
  });

  it('D12. a nyilvános profil DTO engedélyező listája változatlan', () => {
    const out = toPublicProfile({
      displayName: 'Teszt1',
      stats: {
        level: 1, levelTier: 'Rookie', totalXp: 0, xpIntoLevel: 0, xpForNextLevel: 120, progress: 0,
        totalPredictions: 0, settledPredictions: 0, correctPredictions: 0, exactScores: 0,
        accuracy: null, bestStreak: 0, currentStreak: 0, distinctLeagues: 0,
        competitionWins: 0, competitionPodiums: 0,
      },
      cosmetics: { avatar: {}, borderKey: 'classic', titleKey: 'none' },
      achievements: [], competitions: [],
    });
    expect(Object.keys(out).sort()).toEqual(
      ['achievements', 'competitions', 'cosmetics', 'displayName', 'highlights',
        'progression', 'showcase', 'social', 'statistics'],
    );
    // a párbaj-statisztika SZÁNDÉKOSAN nincs benne (későbbi fázis)
    expect(Object.keys(out)).not.toContain('duels');
  });

  it('D13. a profil-oldal kódja továbbra sem hivatkozik privát mezőre', () => {
    expect(code(PROFILE)).not.toMatch(/\bemail\b|user_id|userId|coinBalance|purchase|inventory/i);
  });
});

// ===========================================================================
// 3) A mélylink csak ELŐVÁLASZTÁS – a szerver dönt
// ===========================================================================

describe('Párbaj belépési pont – mélylink', () => {
  const src = read(BATTLES_PAGE);

  it('D14. a párbaj-oldal fogadja a `kihivas` paramétert', () => {
    expect(src).toContain("params.get('kihivas')");
    expect(src).toContain('useSearchParams');
  });

  it('D15. a név a SZERVERTŐL kapott kihívható listához kötődik', () => {
    expect(src).toContain('opponents.data.find((o) => sameDisplayName(o.displayName, invited))');
    expect(src).toContain('setOpponent(match.userId)');
  });

  it('D16. ismeretlen név esetén nem történik semmi (nincs kitalált azonosító)', () => {
    expect(src).toContain('if (!invited || opponent || !opponents.data?.length) return;');
  });

  it('D17. az előválasztás nem írja felül a felhasználó választását', () => {
    // `opponent` már kitöltött állapotnál a hatás kilép
    expect(src).toMatch(/if \(!invited \|\| opponent \|\|/);
  });

  it('D18. az új párbaj űrlap csomagkapu NÉLKÜL jelenik meg', () => {
    expect(src).toContain('<NewBattle invited={invited}');
    expect(src).not.toContain('{pro && <NewBattle');
    // a felület nem is kérdezi le a csomagot a párbajhoz
    expect(src).not.toMatch(/const \{ pro[,}]/);
  });
});

// ===========================================================================
// 4) Regresszió – a meglévő párbajrendszer érintetlen
// ===========================================================================

describe('Párbaj – regresszió a meglévő rendszeren', () => {
  it('D19. a fix szabályok változatlanok', () => {
    expect(BATTLE_MATCH_COUNT).toBe(3);
    expect(INVITE_TTL_HOURS).toBe(24);
    expect(MAX_PENDING_BATTLES).toBe(5);
    expect(BATTLE_XP).toBe(0);
  });

  it('D20. az állapotgép hat állapota változatlan', () => {
    expect(BATTLE_STATUSES).toEqual(['pending', 'active', 'settled', 'declined', 'cancelled', 'expired']);
  });

  it('D21. a pontozás a MEGLÉVŐ 5/3/0 szabály, nincs második implementáció', () => {
    expect(POINTS_EXACT).toBe(5);
    expect(POINTS_OUTCOME).toBe(3);
    expect(scorePrediction(2, 1, 2, 1)).toBe(5);
    expect(scorePrediction(3, 1, 2, 1)).toBe(3);
    expect(scorePrediction(0, 2, 2, 1)).toBe(0);
    // a pontos találat NEM kap ráadásként kimenetel-pontot is
    expect(scorePrediction(2, 1, 2, 1)).not.toBe(POINTS_EXACT + POINTS_OUTCOME);
  });

  it('D22. a győztes-számítás változatlan: egyenlő pontnál VALÓDI döntetlen', () => {
    expect(battleWinner('a', 'b', 8, 6)).toBe('a');
    expect(battleWinner('a', 'b', 6, 8)).toBe('b');
    expect(battleWinner('a', 'b', 7, 7)).toBeNull();
  });

  it('D23. a battle API-ban NINCS több PRO-kapu, de hitelesítés mindenhol van', () => {
    const r = read(BATTLES_ROUTE);
    expect(r).not.toContain('requirePro');
    for (const route of [
      "r.get('/', requireAuthenticated",
      "r.post('/', requireAuthenticated",
      "r.get('/eligible-opponents', requireAuthenticated",
      "r.get('/eligible-matches', requireAuthenticated",
      "r.get('/:id', requireAuthenticated",
      "r.post('/:id/accept', requireAuthenticated",
      "r.post('/:id/decline', requireAuthenticated",
      "r.post('/:id/cancel', requireAuthenticated",
      "r.post('/:id/predictions', requireAuthenticated",
    ]) expect(r, route).toContain(route);
  });

  it('D23b. a párbaj-szolgáltatás már nem is ismeri a csomagot', () => {
    const svc = code('src/server/battles/service.ts');
    expect(svc).not.toContain('isPro');
    expect(svc).not.toContain('proUsers');
    expect(svc).not.toContain('checkPro');
  });

  it('D23c. a PRO-kapu MÁSHOL érintetlen (nem globális változtatás)', () => {
    // a Tippverseny tippbeküldés és a PRO-only végpontok maradnak
    const index = read('src/server/index.ts');
    expect(index).toContain("app.post('/api/matches/:id/predictions', requirePro)");
    expect(index).toContain("app.use(['/api/slips', '/api/history'], requirePro)");
  });

  it('D24. a FREE napi Tippverseny-kvóta változatlan', () => {
    expect(FREE_DAILY_PREDICTION_LIMIT).toBe(3);
  });

  it('D25. a belépési pont NEM nyúl coinhoz, tételhez vagy fogadáshoz', () => {
    const c = code(ACTION);
    for (const bad of ['coin', 'wager', 'tét', 'stake', 'purchase', 'price']) {
      expect(c.toLowerCase(), bad).not.toContain(bad);
    }
  });

  it('D26. nem jött létre párhuzamos párbaj-útvonal vagy -tábla', () => {
    const app = read('src/client/App.tsx');
    expect(app).not.toContain('/parbaj/');
    expect(app).toContain('path="/battles/:id"');
  });
});
