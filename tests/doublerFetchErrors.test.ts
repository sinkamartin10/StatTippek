/**
 * Duplázó – napi lekérések hibakezelése („Failed to fetch”).
 *
 * A hiba gyökere: egy forgalmas nap első (hideg) szelvény-lekérése hosszú (60 mérkőzés elemzése); a Render
 * előtti Cloudflare kb. 100 mp után CORS-fejléc nélküli hibaoldallal bontja a kapcsolatot, amit a böngésző
 * „Failed to fetch” (TypeError) hibaként jelez – és korábban egyetlen ilyen napi hiba az egész generálást
 * megszakította. Itt hamis lekérővel (hálózat nélkül), nulla várakozással és ezredmásodperces időkorláttal
 * teszteljük az újrapróbálkozást, a napi hibák külön kezelését és a duplikált kérések hiányát.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Slip, SlipLeg } from '../src/shared/types';
import {
  MAX_CONSECUTIVE_FAILED_DAYS, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, SEARCH_DAYS, buildChain, chainProbability, fetchDayWithRetry, fetchErrorText,
  isRetryable, planSteps,
  type ChainStep, type SlipFetcher,
} from '../src/client/lib/doubler';
import { StepCard } from '../src/client/pages/Doubler';

const day = (i: number) => `2026-10-${25 + i}`;
const at = (d: number, hhmm: string) => `${day(d)}T${hhmm}:00Z`;
const NOW = Date.parse(`${day(0)}T06:00:00Z`);
const FAST = { sleep: async () => {}, timeoutMs: 30 };
const leg = (o: Partial<SlipLeg>): SlipLeg => ({
  matchId: 'm', matchLabel: 'Hazai – Vendég', leagueName: 'Liga', kickoff: at(0, '12:00'), market: 'O1.5', label: 'Gólszám több mint 1,5',
  modelProb: 0.8, odds: 1.4, bookmaker: null, impliedProb: 0.7, diffPoints: 5, category: 'konzervatív', supportingIndicators: 3, dataQuality: 'magas', ...o,
});
const pair = (m1: string, m2: string, kickoff: string): Slip => ({
  id: `${m1}+${m2}`, strategy: 'legnagyobb esély', totalOdds: 0, jointProb: 0, impliedJointProb: 0, diffPoints: 0, expectedReturn: 0, warnings: [],
  legs: [leg({ matchId: m1, odds: 1.4, kickoff }), leg({ matchId: m2, odds: 1.45, kickoff })],
});
const rowsOf = (stake: number, target: number) => { const p = planSteps(stake, target); if (!p.ok) throw new Error(p.error); return p.rows; };
const networkError = () => new TypeError('Failed to fetch');
const httpError = (status: number) => Object.assign(new Error(`Hiba (${status})`), { status });

/**
 * Hamis lekérő napi forgatókönyvvel: `fail` = ennyiszer dob hálózati hibát az adott (nap, láb) kulcsra,
 * utána a megadott jelölteket adja. Számolja a hívásokat és az egyidejűleg futó kéréseket.
 */
function scripted(plan: Record<string, { fail?: number; slips?: Slip[] }>) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const seen = new Map<string, number>();
  const fetch: SlipFetcher = async (p) => {
    const key = `${p.from}/${p.legs}`;
    calls.push(key);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const sc = plan[p.from!] ?? {};
      if (n <= (sc.fail ?? 0)) throw networkError();
      return { slips: sc.slips ?? [] };
    } finally { inFlight--; }
  };
  return { fetch, calls, maxInFlight: () => maxInFlight };
}

describe('Hibaosztályozás', () => {
  it('átmeneti: hálózati hiba („Failed to fetch”), időtúllépés, 5xx, 408, 429; nem átmeneti: 400, 401, 403, 404', () => {
    expect(isRetryable(networkError())).toBe(true);
    expect(isRetryable(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    for (const s of [500, 502, 503, 504, 524, 408, 429]) expect(isRetryable(httpError(s)), String(s)).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(isRetryable(httpError(s)), String(s)).toBe(false);
    expect(isRetryable(new Error('valami más'))).toBe(false);
  });

  it('érthető hibaszöveg – a nyers „Failed to fetch” helyett', () => {
    expect(fetchErrorText(networkError())).toMatch(/kapcsolat|nem válaszolt/);
    expect(fetchErrorText(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('a szerver nem válaszolt időben');
    expect(fetchErrorText(httpError(429))).toMatch(/túl sok kérés/);
    expect(fetchErrorText(httpError(503))).toBe('szerverhiba (503)');
  });
});

describe('Egy napi lekérés: időkorlát és korlátozott újrapróbálkozás', () => {
  it('átmeneti hiba után újrapróbál, és a sikeres válasz érvényes', async () => {
    const s = scripted({ [day(0)]: { fail: 1, slips: [pair('a', 'b', at(0, '12:00'))] } });
    const r = await fetchDayWithRetry(s.fetch, { from: day(0), to: day(0), legs: '2' }, FAST);
    expect(r).toMatchObject({ ok: true });
    expect(s.calls).toEqual([`${day(0)}/2`, `${day(0)}/2`]);
  });

  it('legfeljebb 1 + RETRY_DELAYS_MS.length kísérlet, utána végleges hiba EREDMÉNYKÉNT (nem dob); a várakozások a megadottak', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const s = scripted({ [day(0)]: { fail: 99 } });
    const r = await fetchDayWithRetry(s.fetch, { from: day(0), to: day(0), legs: '2' }, { ...FAST, sleep });
    expect(r).toEqual({ ok: false, error: fetchErrorText(networkError()) });
    expect(s.calls).toHaveLength(RETRY_DELAYS_MS.length + 1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(RETRY_DELAYS_MS);
  });

  it('időtúllépés: a beragadt kérést megszakítja (AbortSignal), és újrapróbál', async () => {
    let n = 0;
    const fetch: SlipFetcher = (_p, signal) => new Promise((resolve, reject) => {
      n++;
      if (n >= 2) { resolve({ slips: [] }); return; }
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
    });
    const r = await fetchDayWithRetry(fetch, { from: day(0), to: day(0), legs: '2' }, FAST);
    expect(r).toEqual({ ok: true, slips: [] });
    expect(n).toBe(2);
  });

  it('az alapértelmezett időkorlát 90 mp – a Cloudflare kb. 100 mp-es bontása ELŐTT, ~10 mp tartalékkal; pontosan ekkor szakít', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(90_000);
    expect(100_000 - REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    vi.useFakeTimers();
    try {
      let aborted = 0;
      const fetch: SlipFetcher = (_p, signal) => new Promise((_res, reject) => {
        signal?.addEventListener('abort', () => { aborted = Date.now(); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
      const start = Date.now();
      const pending = fetchDayWithRetry(fetch, { from: day(0), to: day(0), legs: '2' }, { retryDelaysMs: [], sleep: async () => {} });
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      expect(aborted).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted - start).toBe(REQUEST_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ ok: false, error: 'a szerver nem válaszolt időben' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a legrosszabb eset korlátos: egy nap ≤ 3 × 90 mp + 40 mp várakozás; egy lépés ≤ 2 ilyen nap szerveroldali kiesésnél', () => {
    const perDay = (RETRY_DELAYS_MS.length + 1) * REQUEST_TIMEOUT_MS + RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(perDay).toBe(310_000);
    expect(MAX_CONSECUTIVE_FAILED_DAYS * perDay).toBeLessThanOrEqual(11 * 60_000);
  });

  it('nem átmeneti hiba (pl. 403 PRO_REQUIRED) azonnal továbbdobódik, újrapróbálkozás nélkül', async () => {
    const fetch = vi.fn(async () => { throw httpError(403); });
    await expect(fetchDayWithRetry(fetch, { from: day(0), to: day(0), legs: '2' }, FAST)).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('A teljes keresés napi hibák mellett', () => {
  it('1. az első nap lekérése végleg sikertelen, a második sikeres → a második napi szelvény, a hiba jelezve', async () => {
    const s = scripted({ [day(0)]: { fail: 99 }, [day(1)]: { slips: [pair('a', 'b', at(1, '12:00'))] } });
    const chain = await buildChain(rowsOf(1000, 2000), day, s.fetch, undefined, NOW, FAST);
    expect(chain[0]).toMatchObject({ date: day(1), failedDays: [day(0)], incomplete: false });
    expect(chain[0].slip?.legs.map((l) => l.matchId)).toEqual(['a', 'b']);
    // a sikertelen napra a 3 lábas lekérést már nem indítja (ugyanaz a szerveroldali elemzés lenne)
    expect(s.calls.filter((c) => c.startsWith(day(0)))).toEqual(Array(RETRY_DELAYS_MS.length + 1).fill(`${day(0)}/2`));
  });

  it('1/b. átmeneti hiba ugyanazon a napon: az újrapróbálás után a mai szelvény (nincs „nem vizsgált” nap)', async () => {
    const s = scripted({ [day(0)]: { fail: 1, slips: [pair('a', 'b', at(0, '12:00'))] } });
    const chain = await buildChain(rowsOf(1000, 2000), day, s.fetch, undefined, NOW, FAST);
    expect(chain[0]).toMatchObject({ date: day(0), failedDays: [], incomplete: false });
  });

  it('2. egy középső nap sikertelen, a további napok elérhetők → a későbbi napi szelvény', async () => {
    const s = scripted({ [day(2)]: { fail: 99 }, [day(3)]: { slips: [pair('a', 'b', at(3, '12:00'))] } });
    const chain = await buildChain(rowsOf(1000, 2000), day, s.fetch, undefined, NOW, FAST);
    expect(chain[0]).toMatchObject({ date: day(3), failedDays: [day(2)], incomplete: false });
  });

  it('3. minden nap lekérhető: nincs újrapróbálás, nincs „nem vizsgált” nap, minden kulcs egyszer', async () => {
    const s = scripted({
      [day(0)]: { slips: [pair('a', 'b', at(0, '12:00'))] },
      [day(1)]: { slips: [pair('c', 'd', at(1, '12:00'))] },
    });
    const chain = await buildChain(rowsOf(1000, 4000), day, s.fetch, undefined, NOW, FAST);
    expect(chain.map((x) => [x.date, x.failedDays.length, x.incomplete])).toEqual([[day(0), 0, false], [day(1), 0, false]]);
    expect(new Set(s.calls).size).toBe(s.calls.length);
    expect(chainProbability(chain)).not.toBeNull();
  });

  it('4. az összes lekérés sikertelen → „a keresés nem teljes” (nem „nincs megfelelő tipp”), a lánc megáll, nem dob', async () => {
    const s = scripted(Object.fromEntries(Array.from({ length: SEARCH_DAYS }, (_, i) => [day(i), { fail: 99 }])));
    const chain = await buildChain(rowsOf(1000, 4000), day, s.fetch, undefined, NOW, FAST);
    // MAX_CONSECUTIVE_FAILED_DAYS egymást követő végleges hiba után leáll – nem kéri végig mind az 5 napot
    const failed = Array.from({ length: MAX_CONSECUTIVE_FAILED_DAYS }, (_, i) => day(i));
    expect(chain[0]).toMatchObject({ slip: null, incomplete: true, failedDays: failed });
    expect(chain[0].note).toMatch(/nem teljes/);
    expect(chain[0].note).toMatch(/egymást követő/);
    expect(chain[0].note).not.toMatch(/nincs megfelelő adatokkal/);
    expect(chain[1]).toMatchObject({ slip: null, incomplete: false, searched: null });
    expect(chain[1].note).toMatch(/nem fejeződött be/);
    expect(chainProbability(chain)).toBeNull();
    // korlátos: napi 3 kísérlet, csak a 2 lábas kulcsra; a 2. lépés már nem keres
    expect(s.calls).toHaveLength(MAX_CONSECUTIVE_FAILED_DAYS * (RETRY_DELAYS_MS.length + 1));
    expect(s.calls.some((c) => c.startsWith(day(MAX_CONSECUTIVE_FAILED_DAYS)))).toBe(false);
  });

  it('4/c. nem egymást követő hibák: a keresés tovább halad, és a később talált szelvény érvényes', async () => {
    const s = scripted({ [day(0)]: { fail: 99 }, [day(1)]: { slips: [] }, [day(2)]: { fail: 99 }, [day(3)]: { slips: [pair('a', 'b', at(3, '12:00'))] } });
    const chain = await buildChain(rowsOf(1000, 2000), day, s.fetch, undefined, NOW, FAST);
    expect(chain[0]).toMatchObject({ date: day(3), failedDays: [day(0), day(2)], incomplete: false });
  });

  it('4/d. két egymást követő végleges hiba után a harmadik napot már nem kéri (akkor sem, ha ott lenne szelvény)', async () => {
    const s = scripted({ [day(0)]: { fail: 99 }, [day(1)]: { fail: 99 }, [day(2)]: { slips: [pair('a', 'b', at(2, '12:00'))] } });
    const chain = await buildChain(rowsOf(1000, 2000), day, s.fetch, undefined, NOW, FAST);
    expect(chain[0]).toMatchObject({ slip: null, incomplete: true, failedDays: [day(0), day(1)] });
    expect(s.calls.some((c) => c.startsWith(day(2)))).toBe(false);
  });

  it('4/b. ha minden nap lekérhető, de nincs megfelelő szelvény: a régi, „nincs megfelelő” üzenet (nem hiba)', async () => {
    const s = scripted({});
    const chain = await buildChain(rowsOf(1000, 2000), day, s.fetch, undefined, NOW, FAST);
    expect(chain[0]).toMatchObject({ slip: null, incomplete: false, failedDays: [] });
    expect(chain[0].note).toMatch(/nincs megfelelő adatokkal/);
  });

  it('5. időtúllépés / hálózati hiba esetén a generálás nem omlik össze: a beragadó nap kimarad, a keresés folytatódik', async () => {
    const fetch: SlipFetcher = (p, signal) => new Promise((resolve, reject) => {
      if (p.from === day(0)) { // soha nem válaszol – csak az időkorlát állítja meg
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        return;
      }
      resolve({ slips: p.from === day(1) ? [pair('a', 'b', at(1, '12:00'))] : [] });
    });
    const chain = await buildChain(rowsOf(1000, 2000), day, fetch, undefined, NOW, FAST);
    expect(chain[0]).toMatchObject({ date: day(1), failedDays: [day(0)], incomplete: false });
  });

  it('6. nincs végtelen újrapróbálkozás és duplikált kérés: egyszerre egy kérés, kulcsonként legfeljebb 3 kísérlet', async () => {
    const s = scripted({
      [day(0)]: { fail: 1, slips: [pair('a', 'b', at(0, '08:00'))] },
      [day(1)]: { fail: 99 },
      [day(2)]: { slips: [pair('c', 'd', at(2, '12:00'))] },
    });
    const progress: string[] = [];
    const chain = await buildChain(rowsOf(1000, 4000), day, s.fetch, (p) => progress.push(`${p.step}:${p.date}:${p.attempt}`), NOW, FAST);
    expect(chain.map((x) => x.slip?.legs[0].matchId)).toEqual(['a', 'c']);
    expect(s.maxInFlight()).toBe(1);
    const perKey = new Map<string, number>();
    for (const c of s.calls) perKey.set(c, (perKey.get(c) ?? 0) + 1);
    expect(Math.max(...perKey.values())).toBeLessThanOrEqual(RETRY_DELAYS_MS.length + 1);
    // a 2. lépés ugyanazt a napot (0.) újra átnézi, de a sikeres választ a gyorsítótárból veszi – nem kér újra
    expect(perKey.get(`${day(0)}/2`)).toBe(2); // 1 hiba + 1 siker, mindkettő az 1. lépésben
    expect(progress).toContain(`1:${day(0)}:2`); // az újrapróbálás látszik a folyamatjelzőben
  });

  it('7. nem átmeneti hiba (jogosultság) azonnal megszakítja a generálást, érthető üzenettel – nem „nincs tipp”', async () => {
    const fetch = vi.fn(async () => { throw Object.assign(new Error('Ez a funkció PRO előfizetéssel érhető el.'), { status: 403 }); });
    await expect(buildChain(rowsOf(1000, 2000), day, fetch, undefined, NOW, FAST)).rejects.toThrow(/PRO előfizetéssel/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Megjelenítés', () => {
  const base: ChainStep = { row: { step: 1, stake: 1000, goal: 2000 }, date: day(0), searched: { from: day(0), to: day(4) }, slip: null, totalOdds: null, payout: null, note: 'A keresés nem teljes.', failedDays: [day(0), day(1)], incomplete: true };
  const html = (s: ChainStep) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(StepCard, { step: s, isLast: true })));

  it('a nem teljes keresés külön jelzést kap (nem „Nincs megfelelő szelvény”), a nem vizsgált napokkal', () => {
    const out = html(base);
    expect(out).toContain('A keresés nem fejeződött be');
    expect(out).not.toContain('Nincs megfelelő szelvény');
    expect(out).toContain('Nem vizsgálható napok');
  });

  it('szelvény mellett a kimaradt napok figyelmeztetése', () => {
    const out = html({ ...base, slip: pair('a', 'b', at(2, '12:00')), totalOdds: 2.03, payout: 2030, note: null, failedDays: [day(1)], incomplete: false });
    expect(out).toContain('lekérése nem sikerült');
    expect(out).toContain('korábbi megfelelő szelvény is lehetett');
  });
});
