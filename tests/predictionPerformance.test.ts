/**
 * Az előrejelzések teljesítményoldala: időszak-képzés, találati arány, üres adatok, megjelenítés és SEO.
 * DOM-alapú frontendteszt-infrastruktúra nincs, ezért a megjelenítés az állapotmentes komponensek statikus
 * renderelésével, a betöltés a `loadPeriods` szintjén (hamis lekérővel) tesztelt.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { TipArchiveEntry, TipArchiveQuery, TipArchiveResponse, TipArchiveSummary } from '../src/shared/tipArchive';
import {
  MIN_SETTLED, budapestDateKey, mondayOf, monthPeriods, perfStats, weekPeriods,
} from '../src/client/lib/predictionPerformance';
import { PerformanceOverview, PeriodTable, PredictionList, loadPeriods } from '../src/client/pages/PredictionPerformance';
import { EXPLORE } from '../src/client/components/Layout';
import { metaForPath, renderSeoHead, sitemapUrls } from '../src/shared/seo';

const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const PATH = '/eloorejelzesek-teljesitmenye';

const summary = (o: Partial<TipArchiveSummary> = {}): TipArchiveSummary => ({
  records: 0, counted: 0, won: 0, lost: 0, void: 0, pending: 0, unsupported: 0, hitRate: null, ...o,
});
const response = (o: Partial<TipArchiveResponse> = {}): TipArchiveResponse => ({
  entries: [], page: 1, pageSize: 10, total: 0, hasMore: false, summary: summary(),
  coverageStart: '2026-10-10T09:18:28.571Z', engineVersion: 'xg-poisson-1', origin: 'live', ...o,
});
const entry = (o: Partial<TipArchiveEntry> = {}): TipArchiveEntry => ({
  id: 'e1', matchId: 'espn-ger.2-401885079', matchLabel: 'VfL Bochum – VfL Wolfsburg', leagueId: 'ger-b2', leagueName: '2. Bundesliga',
  kickoff: '2026-10-20T16:30:00.000Z', market: '2', marketLabel: 'Vendég győzelem (2)', marketType: '1X2', category: 'mérsékelt',
  modelProb: 0.4696, odds: 2.05, dataQuality: 'magas', sampleSize: 20, engineVersion: 'xs-strength-1', versionNo: 3,
  generatedAt: '2026-10-20T12:00:00.000Z', preKickoff: true, counted: true, availability: 'pro_on_request',
  status: 'won', homeGoals: 1, awayGoals: 2, settledAt: '2026-10-20T18:30:00.000Z', ...o,
});

describe('Időszakok (magyar naptár, a kezdési idő szerint)', () => {
  it('a pillanatot a magyar naptári napra képezi (nyári időszámítás)', () => {
    expect(budapestDateKey(new Date('2026-10-22T22:30:00Z'))).toBe('2026-10-23');
    expect(budapestDateKey(new Date('2026-10-22T21:30:00Z'))).toBe('2026-10-22');
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
  });

  it('hetek: hétfőtől vasárnapig, a lefedettség kezdetéig, a legfrissebbel kezdve; az aktuális hét jelölve', () => {
    const w = weekPeriods('2026-10-10T09:18:28.571Z', '2026-10-23');
    expect(w.map((p) => [p.from, p.to, p.current])).toEqual([
      ['2026-10-19', '2026-10-25', true],
      ['2026-10-12', '2026-10-18', false],
      ['2026-10-05', '2026-10-11', false],
    ]);
    expect(w[0].label).toBe('2026. 10. 19. – 10. 25.');
  });

  it('hetek: legfeljebb a megadott számú; üres archívumnál nincs időszak', () => {
    expect(weekPeriods('2025-01-01T00:00:00Z', '2026-10-23', 8)).toHaveLength(8);
    expect(weekPeriods(null, '2026-10-23')).toEqual([]);
  });

  it('hónapok: naptári hónapok, évhatáron át is, a hónap utolsó napjáig', () => {
    expect(monthPeriods('2026-08-15T10:00:00Z', '2026-10-23').map((p) => [p.from, p.to, p.label, p.current])).toEqual([
      ['2026-10-01', '2026-10-31', '2026. október', true],
      ['2026-09-01', '2026-09-30', '2026. szeptember', false],
      ['2026-08-01', '2026-08-31', '2026. augusztus', false],
    ]);
    expect(monthPeriods('2025-12-05T10:00:00Z', '2026-01-10').map((p) => [p.from, p.to])).toEqual([
      ['2026-01-01', '2026-01-31'],
      ['2025-12-01', '2025-12-31'],
    ]);
    expect(monthPeriods('2024-02-10T10:00:00Z', '2024-02-20')[0].to).toBe('2024-02-29');
    expect(monthPeriods(null, '2026-10-23')).toEqual([]);
  });
});

describe('Találati arány', () => {
  it('helyes / (helyes + helytelen) – a függő, érvénytelen és nem értékelhető nem számít bele', () => {
    const s = perfStats(summary({ won: 1732, lost: 1782, void: 89, pending: 33, unsupported: 4 }));
    expect(s.settled).toBe(3514);
    expect(s.hitRate).toBeCloseTo(1732 / 3514, 12);
    expect(s.pending).toBe(33);
    expect(s.excluded).toBe(93);
    expect(s.smallSample).toBe(false);
  });

  it('a függő előrejelzések száma nem változtat az arányon', () => {
    const a = perfStats(summary({ won: 40, lost: 60 }));
    const b = perfStats(summary({ won: 40, lost: 60, pending: 500, void: 7, unsupported: 3 }));
    expect(b.hitRate).toBe(a.hitRate);
    expect(b.hitRate).toBe(0.4);
  });

  it('üres adatoknál nincs arány (nem 0%), kis mintánál figyelmeztetés', () => {
    expect(perfStats(summary({ pending: 12 }))).toMatchObject({ settled: 0, hitRate: null, smallSample: false });
    expect(perfStats(summary({ won: 3, lost: 2 })).smallSample).toBe(true);
    expect(perfStats(summary({ won: MIN_SETTLED, lost: 0 })).smallSample).toBe(false);
  });
});

describe('Időszakos összesítések betöltése (a meglévő archívum-végpontból)', () => {
  it('időszakonként egy kérés: csak a statisztikába számító sorok, dátumszűrővel, egyelemű lappal', async () => {
    const fetch = vi.fn(async (q: TipArchiveQuery) => response({ summary: summary(q.from === '2026-10-19' ? { won: 6, lost: 4, pending: 9 } : { won: 1, lost: 1 }) }));
    const r = await loadPeriods('2026-10-10T09:18:28.571Z', '2026-10-23', fetch);
    expect(fetch).toHaveBeenCalledTimes(4); // 3 hét + 1 hónap
    for (const [q] of fetch.mock.calls) expect(q).toMatchObject({ scope: 'counted', pageSize: 1 });
    expect(fetch.mock.calls.map(([q]) => [q.from, q.to])).toEqual([
      ['2026-10-19', '2026-10-25'], ['2026-10-12', '2026-10-18'], ['2026-10-05', '2026-10-11'], ['2026-10-01', '2026-10-31'],
    ]);
    expect(r!.weeks[0].stats).toMatchObject({ correct: 6, incorrect: 4, settled: 10, hitRate: 0.6, pending: 9 });
    expect(r!.months).toHaveLength(1);
  });

  it('amíg az áttekintés nem töltött be, és üres archívumnál nem kér semmit', async () => {
    const fetch = vi.fn();
    expect(await loadPeriods(undefined, '2026-10-23', fetch)).toBeNull();
    expect(await loadPeriods(null, '2026-10-23', fetch)).toEqual({ weeks: [], months: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Megjelenítés', () => {
  it('összesítés valós számokkal, a százalék egy tizedesre kerekítve, az időszak megnevezve', () => {
    const out = html(createElement(PerformanceOverview, {
      data: response({ summary: summary({ won: 1732, lost: 1782, void: 89, pending: 33 }) }), today: '2026-10-23',
    }));
    expect(out).toContain('3514');
    expect(out).toContain('1732');
    expect(out).toContain('1782');
    expect(out).toContain('49,3%');
    expect(out).toContain('2026. 10. 10.');
    expect(out).toContain('33 feldolgozás alatt');
    expect(out).toContain('89 érvénytelen');
  });

  it('üres archívum: őszinte üres állapot, nincs százalék', () => {
    const out = html(createElement(PerformanceOverview, { data: response({ coverageStart: null }), today: '2026-10-23' }));
    expect(out).toContain('Még nincs rögzített előrejelzés');
    expect(out).not.toMatch(/\d%/);
  });

  it('csak függő előrejelzés: az arány „–”, nem 0%', () => {
    const out = html(createElement(PerformanceOverview, { data: response({ summary: summary({ pending: 5 }) }), today: '2026-10-23' }));
    expect(out).toContain('nincs még adat');
    expect(out).not.toContain('0,0%');
  });

  it('időszak-táblázat: folyamatban lévő időszak és kis minta jelölve; üresen szöveg', () => {
    const rows = [
      { period: { from: '2026-10-19', to: '2026-10-25', label: '2026. 10. 19. – 10. 25.', current: true }, stats: perfStats(summary({ won: 3, lost: 1 })) },
      { period: { from: '2026-10-12', to: '2026-10-18', label: '2026. 10. 12. – 10. 18.', current: false }, stats: perfStats(summary({ pending: 2 })) },
    ];
    const out = html(createElement(PeriodTable, { rows, empty: 'Még nincs heti adat.' }));
    expect(out).toContain('folyamatban');
    expect(out).toContain('75,0%');
    expect(out).toContain('kis minta');
    expect(html(createElement(PeriodTable, { rows: [], empty: 'Még nincs heti adat.' }))).toContain('Még nincs heti adat.');
  });

  it('előrejelzés-lista: mérkőzés, dátum, előrejelzés, végeredmény, értékelés', () => {
    const out = html(createElement(PredictionList, { entries: [
      entry(),
      entry({ id: 'e2', status: 'lost', homeGoals: 2, awayGoals: 0 }),
      entry({ id: 'e3', status: 'pending', homeGoals: null, awayGoals: null, settledAt: null }),
      entry({ id: 'e4', status: 'void', homeGoals: null, awayGoals: null }),
    ] }));
    expect(out).toContain('VfL Bochum – VfL Wolfsburg');
    expect(out).toContain('href="/meccs/espn-ger.2-401885079"');
    expect(out).toContain('Vendég győzelem (2)');
    expect(out).toContain('1–2');
    for (const label of ['Helyes', 'Helytelen', 'Feldolgozás alatt', 'Érvénytelen']) expect(out).toContain(label);
    expect(html(createElement(PredictionList, { entries: [] }))).toContain('Még nincs megjeleníthető előrejelzés');
  });
});

describe('SEO és elérhetőség', () => {
  it('indexelhető, saját canonical URL-lel, a kért címmel és leírással', () => {
    const m = metaForPath(PATH);
    expect(m).toMatchObject({
      status: 200, index: true, canonicalPath: PATH,
      title: 'AI futball-előrejelzések teljesítménye | TippStats',
      description: 'Nézd meg a TippStats AI-futball-előrejelzéseinek korábbi eredményeit, találati arányát és teljesítményét.',
    });
    const head = renderSeoHead(m, true);
    expect(head).toContain('<meta name="robots" content="index, follow" />');
    expect(head).toContain(`<link rel="canonical" href="https://tippstats.hu${PATH}" />`);
    // nem elsődleges hoszt (workers.dev): noindex, a canonical továbbra is a tippstats.hu-ra mutat
    const other = renderSeoHead(m, false);
    expect(other).toContain('noindex');
    expect(other).toContain(`href="https://tippstats.hu${PATH}"`);
    expect(metaForPath(`${PATH}/`).canonicalPath).toBe(PATH);
  });

  it('a sitemapben szerepel, és a Felfedezés menüből elérhető', () => {
    expect(sitemapUrls()).toContain(`https://tippstats.hu${PATH}`);
    expect(EXPLORE.map((i) => i.to)).toContain(PATH);
  });
});
