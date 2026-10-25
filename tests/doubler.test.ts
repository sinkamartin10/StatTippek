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
  MATCH_SPAN_MS, MAX_STEPS, ODDS_MIN, buildChain, chainProbability, daysBetween, fmtFt, grossPayout, jointProbOf, legReason, localDateKey,
  parseAmount, pickSlip, planSteps, rejectReason, totalOddsOf, type ChainStep,
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

describe('Lépéssorozat (többnapos keresés)', () => {
  /** a lépésterv sorai (érvényes tervhez) */
  const rowsOf = (stake: number, target: number) => { const p = planSteps(stake, target); if (!p.ok) throw new Error(p.error); return p.rows; };
  const plan = { rows: rowsOf(1000, 4000) };
  /** a futás „most”-ja: a 0. nap reggele (a tesztnapok kezdései ehhez képest jövőbeliek) */
  const NOW = Date.parse(`${day(0)}T06:00:00Z`);
  const at = (d: number, hhmm: string) => `${day(d)}T${hhmm}:00Z`;
  /** két lábas, 2,03-as szelvény a megadott meccsekből és kezdésekkel */
  const pair = (m1: string, k1: string, m2: string, k2: string) =>
    slip([leg({ matchId: m1, odds: 1.4, kickoff: k1 }), leg({ matchId: m2, odds: 1.45, kickoff: k2 })]);
  /** hamis szelvény-lekérő: nap → jelöltek (minden lábszámra ugyanaz) */
  const fetcher = (byDate: Record<string, Slip[]>) =>
    vi.fn(async (p: Record<string, string | undefined>) => ({ slips: byDate[p.from!] ?? [] }));

  it('L1. ha ma nincs megfelelő szelvény, de holnap van, azt találja meg (a „ma” üres lépés nincs)', async () => {
    const fetch = fetcher({ [day(1)]: [pair('a', at(1, '14:00'), 'b', at(1, '16:00'))] });
    const chain = await buildChain(rowsOf(1000, 2000), day, fetch, undefined, NOW);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ date: day(1), totalOdds: 2.03, payout: 2030, searched: { from: day(0), to: day(4) } });
    // a mai napot (2 és 3 lábbal) végignézte, mielőtt továbblépett
    expect(fetch.mock.calls.map(([p]) => `${p.from}/${p.legs}`)).toEqual([`${day(0)}/2`, `${day(0)}/3`, `${day(1)}/2`]);
  });

  it('L2. ma és holnap sincs, holnapután van → holnaputáni szelvény', async () => {
    const one = { rows: rowsOf(1000, 2000) };
    const chain = await buildChain(one.rows, day, fetcher({ [day(2)]: [pair('a', at(2, '12:00'), 'b', at(2, '12:00'))] }), undefined, NOW);
    expect(chain[0].slip?.legs.map((l) => l.matchId)).toEqual(['a', 'b']);
    expect(chain[0].date).toBe(day(2));
  });

  it('L3. a legkorábbi napot választja, akkor is, ha egy későbbi napon nagyobb esélyű szelvény lenne', async () => {
    const one = { rows: rowsOf(1000, 2000) };
    const early = pair('a', at(1, '12:00'), 'b', at(1, '13:00'));
    const better = slip([leg({ matchId: 'c', odds: 1.4, modelProb: 0.95, kickoff: at(3, '12:00') }), leg({ matchId: 'd', odds: 1.45, modelProb: 0.95, kickoff: at(3, '12:00') })]);
    const chain = await buildChain(one.rows, day, fetcher({ [day(1)]: [early], [day(3)]: [better] }), undefined, NOW);
    expect(chain[0].slip).toBe(early);
    // napon belül is a legkorábbi szelvény nyer
    const late = pair('e', at(1, '20:00'), 'f', at(1, '20:00'));
    expect(pickSlip([late, early])).toBe(early);
  });

  it('L4. több lépés: minden lépés az előző szelvény becsült vége után kezdődik, meccs nem ismétlődik', async () => {
    const fetch = fetcher({
      [day(0)]: [pair('a', at(0, '12:00'), 'b', at(0, '14:00'))],
      // ugyanazon a napon az előző lépés meccsei / átfedő kezdések → kizárva; a 0. nap esti szelvénye már jó
      [day(1)]: [pair('c', at(1, '12:00'), 'd', at(1, '13:00'))],
    });
    const chain = await buildChain(plan.rows, day, fetch, undefined, NOW);
    expect(chain.map((s) => [s.row.stake, s.date, s.slip?.legs.map((l) => l.matchId).join(',')])).toEqual([
      [1000, day(0), 'a,b'],
      [2000, day(1), 'c,d'],
    ]);
    const ids = chain.flatMap((s) => s.slip!.legs.map((l) => l.matchId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Date.parse(chain[1].slip!.legs[0].kickoff)).toBeGreaterThanOrEqual(Date.parse(at(0, '14:00')) + MATCH_SPAN_MS);
    expect(chain[1]).toMatchObject({ totalOdds: 2.03, payout: 4060 }); // 2 000 × 2,03
    expect(chainProbability(chain)).toBeCloseTo(jointProbOf(chain[0].slip!.legs) * jointProbOf(chain[1].slip!.legs), 12);
  });

  it('L5. a következő lépés ugyanazon a napon is folytatódhat, ha az előző meccsek becsült vége után van még megfelelő meccs', async () => {
    const morning = pair('a', at(1, '10:00'), 'b', at(1, '10:00'));
    const evening = pair('c', at(1, '18:00'), 'd', at(1, '19:00'));
    const chain = await buildChain(plan.rows, day, fetcher({ [day(1)]: [morning, evening] }), undefined, NOW);
    expect(chain.map((s) => s.slip?.legs[0].matchId)).toEqual(['a', 'c']);
    expect(chain[1].searched).toEqual({ from: day(1), to: day(5) }); // a 2. lépés a szelvény napjától keres
  });

  it('L6. már elkezdődött mérkőzést nem választ, és ugyanaz a meccs más napon sem kerül újra sorra', async () => {
    const started = pair('a', at(0, '05:00'), 'b', at(0, '12:00')); // 05:00 < most (06:00)
    const ok = pair('c', at(0, '15:00'), 'd', at(0, '16:00'));
    const reuse = pair('c', at(2, '12:00'), 'e', at(2, '12:00')); // „c” már szerepelt
    const fresh = pair('f', at(3, '12:00'), 'g', at(3, '12:00'));
    const chain = await buildChain(plan.rows, day, fetcher({ [day(0)]: [started, ok], [day(2)]: [reuse], [day(3)]: [fresh] }), undefined, NOW);
    expect(chain.map((s) => s.slip?.legs.map((l) => l.matchId).join(','))).toEqual(['c,d', 'f,g']);
  });

  it('L7. 2 lábú szelvény hiányában ugyanazon a napon 3 lábút keres, mielőtt a következő napra lépne', async () => {
    const one = { rows: rowsOf(1000, 2000) };
    const three = slip([leg({ matchId: 'a', odds: 1.25, kickoff: at(0, '12:00') }), leg({ matchId: 'b', odds: 1.3, kickoff: at(0, '12:00') }), leg({ matchId: 'c', odds: 1.25, kickoff: at(0, '12:00') })]);
    const fetch = vi.fn(async (p: Record<string, string | undefined>) => ({ slips: p.legs === '3' && p.from === day(0) ? [three] : [] }));
    const chain = await buildChain(one.rows, day, fetch, undefined, NOW);
    expect(fetch.mock.calls.map(([p]) => `${p.from}/${p.legs}`)).toEqual([`${day(0)}/2`, `${day(0)}/3`]);
    expect(chain[0].slip).toBe(three);
  });

  it('L8. csak ha a teljes ablakban (ma + 4 nap) sincs megfelelő szelvény, akkor üres a lépés; a sorozat ott megszakad', async () => {
    const fetch = fetcher({ [day(0)]: [pair('a', at(0, '12:00'), 'b', at(0, '12:00'))], [day(6)]: [pair('x', at(6, '12:00'), 'y', at(6, '12:00'))] });
    const chain = await buildChain(rowsOf(1000, 8000), day, fetch, undefined, NOW);
    expect(chain).toHaveLength(3);
    expect(chain[0].slip?.legs[0].matchId).toBe('a');
    // a 2. lépés a 0–4. napot nézte végig; a 6. napi szelvény az ablakon kívül esik
    expect(chain[1]).toMatchObject({ slip: null, totalOdds: null, payout: null, searched: { from: day(0), to: day(4) } });
    expect(chain[1].note).toMatch(/vizsgált időszakban/);
    expect(chain[2]).toMatchObject({ slip: null, searched: null });
    expect(chain[2].note).toMatch(/előző lépéshez nincs szelvény/);
    expect(chainProbability(chain)).toBeNull();
    expect(fetch.mock.calls.some(([p]) => p.from === day(6))).toBe(false);
  });

  it('L9. egy (nap, lábszám) párt egy futás alatt csak egyszer kér le', async () => {
    const fetch = fetcher({ [day(0)]: [pair('a', at(0, '08:00'), 'b', at(0, '08:00'))] });
    await buildChain(plan.rows, day, fetch, undefined, NOW);
    const keys = fetch.mock.calls.map(([p]) => `${p.from}/${p.legs}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`${day(0)}/2`);
  });

  it('L10. ha már az első lépéshez sincs szelvény a teljes ablakban, a többi lépés sem generálódik', async () => {
    const fetch = fetcher({});
    const chain = await buildChain(plan.rows, day, fetch, undefined, NOW);
    expect(chain.map((s) => s.slip)).toEqual([null, null]);
    expect(chain[0].searched).toEqual({ from: day(0), to: day(4) });
    expect(fetch).toHaveBeenCalledTimes(10); // 5 nap × (2 és 3 láb)
  });

  it('L11. értelmezhetetlen kezdési idő: a jelölt kiesik, és a későbbi lépések időszűrőjét sem rontja el', async () => {
    const broken = slip([leg({ matchId: 'a', odds: 1.4, kickoff: 'nincs-adat' }), leg({ matchId: 'b', odds: 1.45, kickoff: at(0, '08:00') })]);
    expect(rejectReason(broken)).toBe('missing_kickoff');
    expect(pickSlip([broken])).toBeNull();
    const good = pair('c', at(0, '12:00'), 'd', at(0, '12:00'));
    const tooSoon = pair('e', at(0, '13:00'), 'f', at(0, '13:00')); // a „c, d” becsült vége (14:30) előtt
    const chain = await buildChain(plan.rows, day, fetcher({ [day(0)]: [broken, good, tooSoon] }), undefined, NOW);
    expect(chain[0].slip).toBe(good);
    expect(chain[1].slip).toBeNull(); // az időrend továbbra is érvényes
  });

  it('L12. a következő ablak az előző szelvény BECSÜLT végének napjától indul (éjfél utáni befejezésnél sem vész el nap)', async () => {
    const late = pair('a', at(0, '22:00'), 'b', at(0, '23:30')); // becsült vége: másnap 02:00 (UTC)
    const endKey = localDateKey(new Date(Date.parse(at(0, '23:30')) + MATCH_SPAN_MS).toISOString());
    const anchor = Math.max(0, daysBetween(day(0), endKey));
    // a jelölt pontosan az ablak utolsó napján van: a régi (talált naphoz kötött) ablak ezt nem látta volna
    const last = pair('c', at(anchor + 4, '12:00'), 'd', at(anchor + 4, '12:00'));
    const chain = await buildChain(plan.rows, day, fetcher({ [day(0)]: [late], [day(anchor + 4)]: [last] }), undefined, NOW);
    expect(chain[1].searched).toEqual({ from: day(anchor), to: day(anchor + 4) });
    expect(chain[1].slip).toBe(last);
    expect(daysBetween('2026-10-25', '2026-10-30')).toBe(5);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // óraátállítás körül is egész nap
  });

  it('L13. teljes holtversenyben is determinisztikus: a jelöltek sorrendje nem számít', () => {
    const x = pair('m1', at(1, '12:00'), 'm2', at(1, '12:00'));
    const y = pair('m3', at(1, '12:00'), 'm4', at(1, '12:00'));
    expect(pickSlip([x, y])).toBe(x);
    expect(pickSlip([y, x])).toBe(x);
  });

  it('L14. a pontosan „most” kezdődő mérkőzés már elkezdettnek számít', async () => {
    const one = { rows: rowsOf(1000, 2000) };
    const exactlyNow = pair('a', new Date(NOW).toISOString(), 'b', at(0, '12:00'));
    const chain = await buildChain(one.rows, day, fetcher({ [day(0)]: [exactlyNow] }), undefined, NOW);
    expect(chain[0].slip).toBeNull();
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
    const step: ChainStep = { row: { step: 1, stake: 1000, goal: 2000 }, date: '2026-10-25', searched: { from: '2026-10-25', to: '2026-10-29' }, slip: s, totalOdds: 2.03, payout: 2030, note: null, failedDays: [], incomplete: false };
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
    // a kártya fejléce: a lépés kezdőnapja (szelvénynél), illetve a vizsgált napok (üres lépésnél)
    expect(out).toContain('Kezdés:');
    expect(empty).toContain('Vizsgált napok:');
    expect(empty).not.toContain('Kezdés:');
  });

  it('D20. a „Játék” menüben elérhető; nyilvános, indexelhető oldal (a PRO-szelvények ettől védettek maradnak)', () => {
    expect(PLAY.map((i) => i.to)).toContain('/duplazo');
    expect(metaForPath('/duplazo')).toMatchObject({ status: 200, index: true, canonicalPath: '/duplazo' });
  });
});
