/**
 * Duplázó – lépésterv, összodds, kifizetés, szelvényválasztás, láncépítés és megjelenítés.
 * A láncépítés a `buildChain` szintjén, hamis szelvény-lekérővel tesztelt (hálózat nélkül); a
 * megjelenítés az állapotmentes komponensek statikus renderelésével (DOM-infrastruktúra nincs).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Slip, SlipLeg } from '../src/shared/types';
import {
  MATCH_SPAN_MS, MAX_STEPS, ODDS_MIN, buildChain, chainProbability, fmtFt, grossPayout, jointProbOf, legReason, parseAmount,
  pickSlip, planSteps, rejectReason, totalOddsOf, type ChainStep,
} from '../src/client/lib/doubler';
import { PlanTable, StepCard } from '../src/client/pages/Doubler';
import { PLAY } from '../src/client/components/Layout';
import { metaForPath } from '../src/shared/seo';

const leg = (o: Partial<SlipLeg> = {}): SlipLeg => ({
  matchId: 'm1', matchLabel: 'Arsenal – Chelsea', leagueName: 'Premier League', kickoff: '2026-10-25T14:00:00.000Z',
  market: 'O1.5', label: 'Gólszám több mint 1,5', modelProb: 0.78, odds: 1.4, bookmaker: null, impliedProb: 0.714,
  diffPoints: 6.6, category: 'konzervatív', supportingIndicators: 3, dataQuality: 'magas', ...o,
});
const slip = (legs: SlipLeg[], id = legs.map((l) => l.matchId).join('+')): Slip => ({
  id, strategy: 'legnagyobb esély', legs, totalOdds: 0, jointProb: 0, impliedJointProb: 0, diffPoints: 0, expectedReturn: 0, warnings: [],
});
const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const day = (i: number) => `2026-10-${25 + i}`;

describe('Összegek és lépésterv', () => {
  it('D1. az összeg beolvasása: szóköz, pont, „Ft” megengedett; hibás bemenet → null', () => {
    expect(parseAmount('1000')).toBe(1000);
    expect(parseAmount('1 000 Ft')).toBe(1000);
    expect(parseAmount('16.000')).toBe(16000);
    for (const bad of ['', 'abc', '-500', '0', '1,5', '12e3', '1000000000000']) expect(parseAmount(bad), bad).toBeNull();
  });

  it('D2. pontos duplázás: 1 000 → 16 000 Ft = 4 lépés, a példatáblázat szerint', () => {
    const p = planSteps(1000, 16000);
    expect(p).toMatchObject({ ok: true, steps: 4, exact: true, finalAmount: 16000, lower: null, upper: 16000 });
    if (!p.ok) throw new Error();
    expect(p.rows).toEqual([
      { step: 1, stake: 1000, goal: 2000 },
      { step: 2, stake: 2000, goal: 4000 },
      { step: 3, stake: 4000, goal: 8000 },
      { step: 4, stake: 8000, goal: 16000 },
    ]);
    expect(planSteps(1000, 2000)).toMatchObject({ ok: true, steps: 1 });
    expect(planSteps(1000, 32000)).toMatchObject({ ok: true, steps: 5 });
  });

  it('D3. nem pontos cél: a legközelebbi elérhető összegek alatta és fölötte', () => {
    expect(planSteps(1000, 10000)).toMatchObject({ ok: true, steps: 4, exact: false, lower: 8000, upper: 16000 });
    // egy lépésen belüli cél: alatta nincs (az maga a kezdőösszeg lenne)
    expect(planSteps(1000, 1500)).toMatchObject({ ok: true, steps: 1, exact: false, lower: null, upper: 2000 });
  });

  it('D4. érvénytelen beállítások: túl kicsi / nagy tét, nem nagyobb cél, túl sok lépés', () => {
    expect(planSteps(null, 4000).ok).toBe(false);
    expect(planSteps(50, 4000).ok).toBe(false);
    expect(planSteps(2_000_000, 4_000_000).ok).toBe(false);
    expect(planSteps(1000, 1000).ok).toBe(false);
    expect(planSteps(1000, 500).ok).toBe(false);
    expect(planSteps(1000, null)).toMatchObject({ ok: false, error: expect.stringContaining('érvényes célösszeget') });
    expect(planSteps(1000, 900)).toMatchObject({ ok: false, error: expect.stringContaining('nagyobbnak') });
    expect(planSteps(1000, 1000 * 2 ** MAX_STEPS)).toMatchObject({ ok: true, steps: MAX_STEPS });
    const tooMany = planSteps(1000, 1000 * 2 ** MAX_STEPS + 1);
    expect(tooMany.ok).toBe(false);
  });

  it('D5. a forint-formázás nyelvi beállítástól független', () => {
    expect(fmtFt(1000)).toBe('1 000 Ft');
    expect(fmtFt(1234567)).toBe('1 234 567 Ft');
    expect(fmtFt(999)).toBe('999 Ft');
  });
});

describe('Összodds és kifizetés', () => {
  it('D6. az összodds a tényleges oddsok szorzata, két tizedesre kerekítve', () => {
    expect(totalOddsOf([{ odds: 1.4 }, { odds: 1.45 }])).toBe(2.03);
    expect(totalOddsOf([{ odds: 1.25 }, { odds: 1.3 }, { odds: 1.25 }])).toBe(2.03);
    expect(totalOddsOf([{ odds: 2 }])).toBe(2);
  });

  it('D7. hiányzó vagy érvénytelen odds esetén nincs összodds (nem találunk ki értéket)', () => {
    for (const bad of [null, undefined, NaN, 1, 0.9, -2, Infinity]) {
      expect(totalOddsOf([{ odds: 1.5 }, { odds: bad as unknown as number }]), String(bad)).toBeNull();
    }
    expect(totalOddsOf([])).toBeNull();
  });

  it('D8. kifizetés = tét × összodds, egész forintra', () => {
    expect(grossPayout(1000, 2.03)).toBe(2030);
    expect(grossPayout(8000, 1.95)).toBe(15600);
    expect(grossPayout(1000, 1.999)).toBe(1999);
  });
});

describe('Szelvényválasztás', () => {
  const a = leg({ matchId: 'a', odds: 1.4, modelProb: 0.8 });
  const b = leg({ matchId: 'b', odds: 1.45, modelProb: 0.75 });
  const c = leg({ matchId: 'c', odds: 1.42, modelProb: 0.7 });

  it('D9. használható: kb. 2,00 összodds, megfelelő adat, különböző mérkőzések', () => {
    expect(rejectReason(slip([a, b]))).toBeNull();
  });

  it('D10. kizárási okok: hiányzó odds, ismétlődő mérkőzés, gyenge adat, odds-tartomány, időrend, már használt meccs', () => {
    expect(rejectReason(slip([a, leg({ matchId: 'b', odds: null as unknown as number })]))).toBe('missing_odds');
    expect(rejectReason(slip([a, leg({ matchId: 'a', market: 'BTTS', odds: 1.45 })]))).toBe('duplicate_match');
    expect(rejectReason(slip([a, leg({ matchId: 'b', odds: 1.45, dataQuality: 'kevés' })]))).toBe('weak_data');
    expect(rejectReason(slip([a, leg({ matchId: 'b', odds: 1.2 })]))).toBe('odds_out_of_range'); // 1,68
    expect(rejectReason(slip([a, leg({ matchId: 'b', odds: 1.9 })]))).toBe('odds_out_of_range'); // 2,66
    expect(rejectReason(slip([a, b]), { notBefore: Date.parse('2026-10-25T15:00:00Z') })).toBe('too_early');
    expect(rejectReason(slip([a, b]), { usedMatches: new Set(['b']) })).toBe('used_match');
  });

  it('D11. a legnagyobb modell-esélyű használható szelvényt választja; ha nincs ilyen, null', () => {
    const best = slip([a, b]);
    const worse = slip([b, c]);
    const invalid = slip([a, leg({ matchId: 'x', odds: 1.45, dataQuality: 'kevés', modelProb: 0.99 })]);
    expect(pickSlip([worse, invalid, best])).toBe(best);
    expect(pickSlip([invalid])).toBeNull();
    expect(pickSlip([])).toBeNull();
  });

  it('D12. indoklás a meglévő elemzés adataiból', () => {
    expect(legReason(a)).toBe('a modell szerint 80% esély · az odds alapján 71% · 3 támogató statisztikai mutató · magas adatminőség');
  });
});

describe('Lépéssorozat', () => {
  const plan = planSteps(1000, 4000);
  if (!plan.ok) throw new Error();

  it('D13. lépésenként a következő nap szelvénye; a tét az előző lépés célösszege; egy meccs csak egyszer', async () => {
    const byDate: Record<string, Slip[]> = {
      [day(0)]: [slip([leg({ matchId: 'a', odds: 1.4, kickoff: `${day(0)}T14:00:00Z` }), leg({ matchId: 'b', odds: 1.45, kickoff: `${day(0)}T16:00:00Z` })])],
      [day(1)]: [
        // ugyanaz a meccs újra → kizárva; a második jelölt jó
        slip([leg({ matchId: 'a', odds: 1.4, kickoff: `${day(1)}T14:00:00Z` }), leg({ matchId: 'c', odds: 1.45, kickoff: `${day(1)}T14:00:00Z` })]),
        slip([leg({ matchId: 'd', odds: 1.38, kickoff: `${day(1)}T18:00:00Z` }), leg({ matchId: 'e', odds: 1.47, kickoff: `${day(1)}T19:00:00Z` })]),
      ],
    };
    const fetch = vi.fn(async (p: Record<string, string | undefined>) => ({ slips: byDate[p.from!] ?? [] }));
    const chain = await buildChain(plan.rows, day, fetch);
    expect(chain.map((s) => [s.row.stake, s.date, s.slip?.legs.map((l) => l.matchId).join(',')])).toEqual([
      [1000, day(0), 'a,b'],
      [2000, day(1), 'd,e'],
    ]);
    expect(chain[0]).toMatchObject({ totalOdds: 2.03, payout: 2030 });
    expect(chain[1]).toMatchObject({ totalOdds: 2.03, payout: 4060 }); // 1,38 × 1,47 = 2,0286 → 2,03; 2 000 × 2,03
    // a meglévő szelvényépítőt kéri: egynapos időszak, ~2,00 alsó határ, 2 láb elsőként
    expect(fetch.mock.calls[0][0]).toMatchObject({ from: day(0), to: day(0), legs: '2', minOdds: String(ODDS_MIN) });
    expect(chainProbability(chain)).toBeCloseTo(jointProbOf(chain[0].slip!.legs) * jointProbOf(chain[1].slip!.legs), 12);
  });

  it('D14. a következő lépés csak az előző mérkőzéseinek vége után kezdődhet', async () => {
    // az első lépés utolsó meccse 23:00-kor kezdődik → kb. 01:30-ig tart; a 00:30-as kezdés túl korai
    const lateFirst = slip([leg({ matchId: 'a', odds: 1.4, kickoff: `${day(0)}T21:00:00Z` }), leg({ matchId: 'b', odds: 1.45, kickoff: `${day(0)}T23:00:00Z` })]);
    const tooSoon = slip([leg({ matchId: 'c', odds: 1.4, kickoff: `${day(1)}T00:30:00Z` }), leg({ matchId: 'd', odds: 1.45, kickoff: `${day(1)}T12:00:00Z` })]);
    const chain = await buildChain(plan.rows, day, async (p) => ({ slips: p.from === day(0) ? [lateFirst] : [tooSoon] }));
    expect(Date.parse(`${day(1)}T00:30:00Z`)).toBeLessThan(Date.parse(`${day(0)}T23:00:00Z`) + MATCH_SPAN_MS);
    expect(chain[1].slip).toBeNull();
    // egy elég késői jelölt viszont elfogadott
    const later = slip([leg({ matchId: 'c', odds: 1.4, kickoff: `${day(1)}T02:00:00Z` }), leg({ matchId: 'd', odds: 1.45, kickoff: `${day(1)}T12:00:00Z` })]);
    const ok = await buildChain(plan.rows, day, async (p) => ({ slips: p.from === day(0) ? [lateFirst] : [tooSoon, later] }));
    expect(ok[1].slip).toBe(later);
  });

  it('D15. 2 lábú szelvény hiányában 3 lábút keres', async () => {
    const three = slip([leg({ matchId: 'a', odds: 1.25 }), leg({ matchId: 'b', odds: 1.3 }), leg({ matchId: 'c', odds: 1.25 })]);
    const fetch = vi.fn(async (p: Record<string, string | undefined>) => ({ slips: p.legs === '3' ? [three] : [] }));
    const one = planSteps(1000, 2000);
    if (!one.ok) throw new Error(one.error);
    const chain = await buildChain(one.rows, day, fetch);
    expect(fetch.mock.calls.map(([p]) => p.legs)).toEqual(['2', '3']);
    expect(chain[0].slip).toBe(three);
  });

  it('D16. nincs megfelelő szelvény: a lépés üres, a sorozat ott megszakad, kitalált tipp nincs', async () => {
    const onlyFirst = slip([leg({ matchId: 'a', odds: 1.4, kickoff: `${day(0)}T12:00:00Z` }), leg({ matchId: 'b', odds: 1.45, kickoff: `${day(0)}T12:00:00Z` })]);
    const fetch = vi.fn(async (p: Record<string, string | undefined>) => ({ slips: p.from === day(0) ? [onlyFirst] : [] }));
    const chain = await buildChain(plan.rows, day, fetch);
    expect(chain).toHaveLength(2);
    expect(chain[0].slip).toBe(onlyFirst);
    expect(chain[1]).toMatchObject({ slip: null, totalOdds: null, payout: null });
    expect(chain[1].note).toMatch(/nincs megfelelő/);
    expect(chainProbability(chain)).toBeNull();
    // az első hiányzó lépés után nem kér további napot
    expect(fetch.mock.calls.every(([p]) => p.from === day(0) || p.from === day(1))).toBe(true);
  });

  it('D17. ha már az első lépéshez sincs szelvény, a többi lépés sem generálódik', async () => {
    const chain = await buildChain(plan.rows, day, async () => ({ slips: [] }));
    expect(chain.map((s) => s.slip)).toEqual([null, null]);
    expect(chain[1].note).toMatch(/előző lépéshez nincs szelvény/);
  });
});

describe('Megjelenítés, navigáció', () => {
  it('D18. lépéstábla és a nem pontos cél jelzése', () => {
    const out = html(createElement(PlanTable, { plan: planSteps(1000, 10000), target: 10000 }));
    expect(out).toContain('8 000 Ft');
    expect(out).toContain('16 000 Ft');
    expect(out).toContain('nem érhető el');
    expect(html(createElement(PlanTable, { plan: planSteps(1000, 500), target: 500 }))).toContain('role="alert"');
  });

  it('D19. lépéskártya: meccs, piac, odds, indoklás, összodds, tét, kifizetés, figyelmeztetés', () => {
    const s = slip([leg({ matchId: 'a', odds: 1.4 }), leg({ matchId: 'b', odds: 1.45, matchLabel: 'Real Madrid – Barcelona', label: 'Mindkét csapat szerez gólt – igen' })]);
    const step: ChainStep = { row: { step: 1, stake: 1000, goal: 2000 }, date: '2026-10-25', slip: s, totalOdds: 2.03, payout: 2030, note: null };
    const out = html(createElement(StepCard, { step, isLast: false }));
    for (const t of ['Arsenal', 'Real Madrid', 'Gólszám több mint 1,5', 'Mindkét csapat szerez gólt – igen', '1,40', '1,45', '2,03', '1 000 Ft', '2 030 Ft', 'a modell szerint', 'nem garantált', 'csak akkor indulhat']) {
      expect(out, t).toContain(t);
    }
    // a kezdés + 2,5 óra csak becsült lezárás – a tényleges elszámolás a mérvadó
    expect(out).toContain('becsült lezárással');
    expect(out).toContain('tényleges elszámolását');
    expect(html(createElement(StepCard, { step, isLast: true }))).not.toContain('csak akkor indulhat');
    const empty = html(createElement(StepCard, { step: { ...step, slip: null, totalOdds: null, payout: null, note: 'Nincs adat.' }, isLast: true }));
    expect(empty).toContain('Nincs megfelelő szelvény');
    expect(empty).not.toContain('Összodds');
  });

  it('D20. a „Játék” menüben elérhető; nyilvános, indexelhető oldal (a PRO-szelvények ettől védettek maradnak)', () => {
    expect(PLAY.map((i) => i.to)).toContain('/duplazo');
    expect(metaForPath('/duplazo')).toMatchObject({ status: 200, index: true, canonicalPath: '/duplazo' });
  });
});
