/**
 * Lista-állapot az URL-ben – a választott nap megőrzése.
 *
 * A hiba, amit ez a csomag őriz: a mérkőzés- és tipp-lista a napot
 * komponens-állapotban tartotta, ezért a meccs megnyitása utáni visszalépés
 * (a komponens újracsatolása) visszaugrott a mai napra.
 *
 * A projektben nincs DOM-futtató, ezért a hook helyett a TISZTA magot
 * (`paramsToState` / `stateToParams`) mérjük – ez tartalmazza a teljes
 * érvényesítési és sorrendezési logikát –, plusz a komponensek forrás-
 * szerződését. A tényleges navigációt valódi böngészőben néztem meg.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dateFromParams, isDateKey, paramsToState, stateToParams } from '../src/client/lib/listState';
import { todayKey } from '../src/client/lib/format';

const read = (p: string) => readFileSync(p, 'utf8');

/** A mérkőzéslista alapértelmezett szűrői (a MatchList-ből tükrözve). */
const DEFAULTS = {
  date: todayKey(), country: '', leagueId: '', team: '', importance: '', timeFrom: '', timeTo: '',
};

const sp = (q: string) => new URLSearchParams(q);

// ===========================================================================
// 1) Dátum-érvényesség
// ===========================================================================

describe('Lista-állapot – dátum érvényessége', () => {
  it('L1. valódi naptári napot elfogad', () => {
    for (const d of ['2026-10-09', '2024-02-29', '2026-01-01', '2026-12-31']) {
      expect(isDateKey(d), d).toBe(true);
    }
  });

  it('L2. alakilag hibás értéket elutasít', () => {
    for (const d of ['', '2026-10-9', '26-10-09', '2026/10/09', 'ma', '2026-10-09T12:00', null, undefined, 42]) {
      expect(isDateKey(d), String(d)).toBe(false);
    }
  });

  it('L3. nem létező naptári napot elutasít', () => {
    for (const d of ['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29']) {
      expect(isDateKey(d), d).toBe(false);
    }
  });
});

// ===========================================================================
// 2) URL → állapot
// ===========================================================================

describe('Lista-állapot – URL-ből olvasás', () => {
  it('L4. a megadott nap jön vissza, NEM a mai', () => {
    const s = paramsToState(DEFAULTS, sp('date=2026-10-11'));
    expect(s.date).toBe('2026-10-11');
    expect(s.date).not.toBe(todayKey());
  });

  it('L5. hiányzó dátum esetén a mai nap az alapértelmezés', () => {
    expect(paramsToState(DEFAULTS, sp('')).date).toBe(todayKey());
    expect(dateFromParams(sp(''))).toBe(todayKey());
  });

  it('L6. ÉRVÉNYTELEN dátum nem dob hibát, hanem a mai napra esik vissza', () => {
    for (const q of ['date=tegnap', 'date=2026-02-30', 'date=', 'date=%27%20OR%201%3D1']) {
      expect(paramsToState(DEFAULTS, sp(q)).date, q).toBe(todayKey());
      expect(dateFromParams(sp(q)), q).toBe(todayKey());
    }
  });

  it('L7. a többi szűrő is visszaáll az URL-ből', () => {
    const s = paramsToState(DEFAULTS, sp('date=2026-10-11&country=Anglia&leagueId=eng-pl&team=Arsenal&importance=top'));
    expect(s).toMatchObject({
      date: '2026-10-11', country: 'Anglia', leagueId: 'eng-pl', team: 'Arsenal', importance: 'top',
    });
  });

  it('L8. ismeretlen paraméter nem szivárog be az állapotba', () => {
    const s = paramsToState(DEFAULTS, sp('date=2026-10-11&idegen=x'));
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });
});

// ===========================================================================
// 3) Állapot → URL
// ===========================================================================

describe('Lista-állapot – URL-be írás', () => {
  it('L9. a nem alapértelmezett nap bekerül a címbe', () => {
    const out = stateToParams(DEFAULTS, { ...DEFAULTS, date: '2026-10-11' }, sp(''), ['date']);
    expect(out.get('date')).toBe('2026-10-11');
  });

  it('L10. a mai nap NEM szemeteli tele a címet', () => {
    const out = stateToParams(DEFAULTS, { ...DEFAULTS }, sp(''), ['date']);
    expect(out.toString()).toBe('');
  });

  it('L11. az üres szűrő kikerül a címből', () => {
    const out = stateToParams(DEFAULTS, { ...DEFAULTS, country: '' }, sp('country=Anglia'), ['date']);
    expect(out.has('country')).toBe(false);
  });

  it('L12. idegen paramétert érintetlenül hagy', () => {
    const out = stateToParams(DEFAULTS, { ...DEFAULTS, date: '2026-10-11' }, sp('matchId=abc'), ['date']);
    expect(out.get('matchId')).toBe('abc');
  });

  it('L13. oda-vissza úton az állapot változatlan', () => {
    const wanted = { ...DEFAULTS, date: '2026-10-11', country: 'Anglia', team: 'Arsenal' };
    const back = paramsToState(DEFAULTS, stateToParams(DEFAULTS, wanted, sp(''), ['date']));
    expect(back).toEqual(wanted);
  });
});

// ===========================================================================
// 4) Időzóna – NINCS egy nap elcsúszás
// ===========================================================================

describe('Lista-állapot – időzóna', () => {
  it('L14. a dátum végig szöveg marad, nem megy át Date/UTC alakon', () => {
    // Nyári időszámítás-váltás napjai és az év határai is változatlanok
    for (const d of ['2026-03-29', '2026-10-25', '2026-01-01', '2026-12-31', '2026-06-15']) {
      const back = paramsToState(DEFAULTS, stateToParams(DEFAULTS, { ...DEFAULTS, date: d }, sp(''), ['date']));
      expect(back.date, d).toBe(d);
    }
  });

  it('L15. a `todayKey()` HELYI dátumot ad, nem UTC-t', () => {
    const now = new Date();
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(todayKey()).toBe(local);
    // UTC-alapú képzés eltérhet – pontosan ezt kerüljük
    expect(todayKey()).not.toBe(''); // értelmes érték
  });

  it('L16. az eltolt nap is helyi számítású és érvényes kulcs', () => {
    for (const off of [-1, 0, 1, 2]) expect(isDateKey(todayKey(off)), String(off)).toBe(true);
  });
});

// ===========================================================================
// 5) A komponensek tényleg az URL-t használják (forrás-szerződés)
// ===========================================================================

describe('Lista-állapot – komponens-szerződés', () => {
  const matches = read('src/client/pages/Matches.tsx');
  const tips = read('src/client/pages/Tips.tsx');

  it('L17. a mérkőzéslista NEM komponens-állapotban tartja a szűrőket', () => {
    expect(matches).toContain('useUrlState(defaultFilters()');
    expect(matches).not.toContain('useState(defaultFilters())');
  });

  it('L18. a tipp-lista napja is az URL-ben él', () => {
    expect(tips).toContain('useUrlState({ date: todayKey() }');
    expect(tips).not.toContain('useState(todayKey())');
  });

  it('L19. mindkét lista pillanatkép-kulcsot ad a lekéréshez (nincs felesleges töltőképernyő)', () => {
    expect(matches).toContain('`matches:${f.date}');
    expect(tips).toContain('`tips:${date}`');
  });

  it('L20. a szűrőállítás nem szemeteli az előzményt (replace)', () => {
    expect(read('src/client/lib/listState.ts')).toContain("{ replace: true }");
  });

  it('L21. a meccs-részletekre mutató link változatlan maradt', () => {
    const list = read('src/client/components/MatchList.tsx');
    expect(list).toContain('to={`/meccs/${encodeURIComponent(m.id)}`}');
    expect(list).toContain('to={`/meccs/${encodeURIComponent(m.id)}#tippek`}');
  });
});

// ===========================================================================
// 6) Pillanatkép – frissesség nem gyengül
// ===========================================================================

describe('Lista-állapot – pillanatkép', () => {
  const fmt = read('src/client/lib/format.ts');

  it('L22. a pillanatkép rövid lejáratú és kötött méretű', () => {
    expect(fmt).toMatch(/SNAPSHOT_TTL_MS\s*=\s*60_000/);
    expect(fmt).toMatch(/SNAPSHOT_MAX\s*=\s*\d+/);
  });

  it('L23. a hook a pillanatkép mellett MINDIG újratölt (stale-while-revalidate)', () => {
    // a fn() hívás nincs feltételhez kötve: a cache csak a kezdeti kirajzolást gyorsítja
    const body = fmt.slice(fmt.indexOf('export function useAsync'));
    expect(body).toContain('fn().then(');
    expect(body).not.toMatch(/if \(cached[^)]*\) return;/);
  });

  it('L24. kulcs nélkül a viselkedés változatlan (nincs pillanatkép)', () => {
    const body = fmt.slice(fmt.indexOf('export function useAsync'));
    expect(body).toContain('snapshotKey ? readSnapshot<T>(snapshotKey) : null');
  });

  it('L25. hiba esetén a pillanatkép NEM íródik felül', () => {
    const body = fmt.slice(fmt.indexOf('export function useAsync'));
    const errBranch = body.slice(body.indexOf('(e: Error)'));
    expect(errBranch).not.toContain('writeSnapshot');
  });
});
