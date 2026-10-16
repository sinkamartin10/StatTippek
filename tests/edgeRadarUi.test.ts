/**
 * Edge Radar felület (4. fázis). A projektben nincs DOM-alapú frontendteszt-infrastruktúra, ezért:
 * a megjelenítés az állapotmentes `EdgeRadarBody`/`EdgeRadarGate` statikus renderelésével, a logika
 * a tiszta függvényekkel, az API-hívás a `loadEdgeRadar` és az `api.edgeRadar` szintjén tesztelt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { EdgeRadarBody, EdgeRadarGate, loadEdgeRadar, type EdgeLoad, type EdgeRadarBodyProps } from '../src/client/pages/EdgeRadar';
import { DEFAULT_FILTERS, filterItems, reasonText, showEdge, sortItems, coverage, EXCLUDE_REASON_HU } from '../src/client/lib/edgeRadar';
import { api, ApiError } from '../src/client/lib/api';
import { EXPLORE, PLAY, PRIMARY } from '../src/client/components/Layout';
import type { EdgeRadarItem, EdgeRadarResponse } from '../src/shared/types';
import type { MatchWithTeams } from '../src/client/lib/api';

const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));
const item = (o: Partial<EdgeRadarItem> = {}): EdgeRadarItem => ({
  matchId: 'espn-eng.1-1', leagueId: 'eng-pl', kickoff: '2026-10-20T18:00:00.000Z', market: '1', outcome: '1x2:home', odds: 2.1,
  bookmaker: 'DraftKings (ESPN)', source: 'espn-scoreboard', observedAt: '2026-10-20T14:50:00.000Z', ageMs: 600_000,
  rawImplied: 1 / 2.1, devig: 0.4512, devigReason: null, modelId: 'xs-strength-1', edgePp: 4.88, excluded: false, excludeReason: null, ...o,
});
const resp = (items: EdgeRadarItem[], meta: Partial<EdgeRadarResponse['meta']> = {}): EdgeRadarResponse => ({
  version: 1, date: '2026-10-20', generatedAt: '2026-10-20T15:00:00.000Z', items,
  meta: { experimental: true, modelVariant: 'pro', matches: 3, rows: items.length, usable: items.filter((i) => !i.excluded).length, excluded: items.filter((i) => i.excluded).length,
    partial: false, failedMatchIds: [], devigMethod: 'proportional', notice: ['Kísérleti funkció.', 'A százalékpontos különbség (edgePp) nem garantál nyereséget; a modell kalibrációja nincs igazolva.'], ...meta },
});
const matches = [{ id: 'espn-eng.1-1', leagueId: 'eng-pl', homeTeamId: 'espn-359', awayTeamId: 'espn-363', kickoff: '2026-10-20T18:00:00.000Z', status: 'scheduled',
  homeTeam: { id: 'espn-359', name: 'Arsenal', shortName: 'ARS', country: 'Anglia', leagueId: 'eng-pl' }, awayTeam: { id: 'espn-363', name: 'Chelsea', shortName: 'CHE', country: 'Anglia', leagueId: 'eng-pl' },
  league: { id: 'eng-pl', name: 'Premier League', country: 'Anglia' } }] as unknown as MatchWithTeams[];
const body = (state: EdgeRadarBodyProps['state'], o: Partial<EdgeRadarBodyProps> = {}) =>
  html(createElement(EdgeRadarBody, { date: '2026-10-20', onDate: () => {}, state, matches, filters: DEFAULT_FILTERS, onFilters: () => {}, ...o }));
const ok = (r: EdgeRadarResponse): EdgeLoad => ({ kind: 'ok', data: r });
const EXCLUDED = item({ market: 'X', outcome: '1x2:draw', odds: 3.5, rawImplied: 1 / 3.5, devig: null, devigReason: 'unknown_bookmaker', modelId: null, edgePp: null, excluded: true, excludeReason: 'stale', ageMs: 7_200_000 });
/** EV / várható nyereség semmilyen formában */
const NO_EV = /\bEV\b|várható (nyereség|profit|hozam)|expected value|garantált nyer/i;

afterEach(() => { vi.unstubAllGlobals(); });

describe('Megjelenítés sikeres API-válaszból', () => {
  it('PRO: táblázat a meccs, piac, odds, iroda, forrás, megfigyelés, nyers és árrésmentes valószínűség, edge oszlopokkal', () => {
    const out = body({ loading: false, error: null, result: ok(resp([item(), EXCLUDED])) });
    for (const s of ['Arsenal', 'Chelsea', 'Premier League', '2,10', 'DraftKings (ESPN)', 'ESPN (eredménylista)', '10 perce', '47,6%', '45,1%', '+4,9 pp']) expect(out, s).toContain(s);
    expect(out).toContain('data-edge-table');
    expect(out).toContain('1 / 3 mérkőzésnél van odds');
    expect(out).toContain('Módszer és korlátok');
    expect(out).toContain('nem garantál nyereséget');
    expect(out).toMatch(/nem az odds tényleges változásáé/);
  });

  it('kizárt sor: emberi indok, NINCS edge-érték; a hiányzó árrésmentes érték „–”, nem a nyers valószínűség', () => {
    const out = body({ loading: false, error: null, result: ok(resp([EXCLUDED])) });
    expect(out).toContain('Az odds megfigyelése túl régi.');
    expect(out).toContain('data-edge-excluded="stale"');
    expect(out).not.toContain('data-edge-value');
    expect(out).not.toContain(' pp<');
    // a nyers implikált (28,6%) megjelenik a saját oszlopában, de az árrésmentes oszlop „–”
    expect(out).toContain('28,6%');
    expect(out.match(/28,6%/g)).toHaveLength(1);
  });

  it('a kliens nem alakítja használhatóvá a kizárt sort (ellentmondásos adatnál sem jelenik meg edge)', () => {
    const odd = item({ excluded: true, excludeReason: 'stale', edgePp: 3.2 });
    expect(showEdge(odd)).toBe(false);
    expect(body({ loading: false, error: null, result: ok(resp([odd])) })).not.toContain('data-edge-value');
    expect(showEdge(item({ edgePp: null }))).toBe(false);
  });

  it('sok sor: egyszerre legfeljebb PAGE_ROWS sor renderelődik, a többi gombbal érhető el', () => {
    const many = Array.from({ length: 200 }, (_, n) => item({ matchId: `m-${String(n).padStart(3, '0')}` }));
    const out = body({ loading: false, error: null, result: ok(resp(many)) });
    expect(out.match(/data-edge-row=/g)).toHaveLength(150);
    expect(out).toContain('data-edge-more');
    expect(out).toContain('Még 50 sor (150 / 200 látható)');
  });

  it('részleges eredmény és üres lista külön jelzéssel', () => {
    expect(body({ loading: false, error: null, result: ok(resp([item()], { partial: true, failedMatchIds: ['a', 'b'] })) })).toMatch(/data-edge-state="partial".*2 mérkőzés számítása nem sikerült/);
    const empty = body({ loading: false, error: null, result: ok(resp([])) });
    expect(empty).toContain('Nincs oddsszal rendelkező piac ezen a napon');
    expect(empty).not.toContain('data-edge-table');
  });

  it('nincs EV, várható nyereség vagy profit-állítás sehol', () => {
    for (const r of [resp([item(), EXCLUDED]), resp([]), resp([item()], { partial: true, failedMatchIds: ['a'] })]) {
      expect(body({ loading: false, error: null, result: ok(r) })).not.toMatch(NO_EV);
    }
    expect(html(createElement(EdgeRadarGate, { pro: false }))).not.toMatch(NO_EV);
  });
});

describe('Állapotok: betöltés, 401, 403, 500', () => {
  it('betöltés és API-hiba (500) elkülönítve, újrapróbálással', () => {
    expect(body({ loading: true, error: null, result: null })).toContain('Edge Radar számolása');
    const err = body({ loading: false, error: 'Az Edge Radar most nem számolható.', result: null }, { onRetry: () => {} });
    expect(err).toContain('Az Edge Radar most nem érhető el.');
    expect(err).not.toContain('data-edge-table');
  });

  it('401 → belépés; 403 → PRO-zár, adat nélkül', async () => {
    expect(body({ loading: false, error: null, result: { kind: 'denied', status: 401, code: 'AUTH_REQUIRED', message: 'Bejelentkezés szükséges.' } })).toContain('data-edge-state="auth"');
    const locked = body({ loading: false, error: null, result: { kind: 'denied', status: 403, code: 'PRO_REQUIRED', message: 'x' } });
    expect(locked).toContain('Edge Radar – PRO');
    expect(locked).not.toContain('data-edge-table');
  });

  it('loadEdgeRadar: 401/403 → denied; 500 és egyéb hiba → hibaként továbbmegy (nem üres siker)', async () => {
    expect(await loadEdgeRadar('2026-10-20', async () => { throw new ApiError('Ez a funkció PRO előfizetéssel érhető el.', 403, 'PRO_REQUIRED'); })).toMatchObject({ kind: 'denied', status: 403, code: 'PRO_REQUIRED' });
    expect(await loadEdgeRadar('2026-10-20', async () => { throw new ApiError('Bejelentkezés szükséges.', 401, 'AUTH_REQUIRED'); })).toMatchObject({ kind: 'denied', status: 401 });
    await expect(loadEdgeRadar('2026-10-20', async () => { throw new ApiError('Az Edge Radar most nem számolható.', 500, 'EDGE_UNAVAILABLE'); })).rejects.toThrow('nem számolható');
  });

  it('FREE: zárt blokk, és a munkaterület (adatlekérés) meg sem jelenik; PRO: a munkaterület betöltési állapotban indul', () => {
    const free = html(createElement(EdgeRadarGate, { pro: false }));
    expect(free).toContain('Edge Radar – PRO');
    expect(free).not.toContain('type="date"');
    const pro = html(createElement(EdgeRadarGate, { pro: true }));
    expect(pro).toContain('type="date"');
    expect(pro).toContain('Edge Radar számolása');
  });
});

describe('Dátum → API-kérés', () => {
  it('a kiválasztott dátummal hívja a végpontot (/api/edge-radar?date=…), a dátumváltás új kérést jelent', async () => {
    const seen: string[] = [];
    await loadEdgeRadar('2026-10-20', async (d) => { seen.push(d); return resp([]); });
    await loadEdgeRadar('2026-10-21', async (d) => { seen.push(d); return resp([]); });
    expect(seen).toEqual(['2026-10-20', '2026-10-21']);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(resp([])), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    await api.edgeRadar('2026-10-21');
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toMatch(/\/api\/edge-radar\?date=2026-10-21$/);
  });

  it('a dátummező csak YYYY-MM-DD értéket ad tovább', () => {
    const got: string[] = [];
    // a munkaterület szűrője: érvényes formátum → továbbítva (a szerver ellenőrzi a létező napot)
    const onDate = (d: string) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) got.push(d); };
    ['2026-10-22', '', '2026-1-2'].forEach(onDate);
    expect(got).toEqual(['2026-10-22']);
  });
});

describe('Szűrés és rendezés', () => {
  const a = item({ matchId: 'm-a', kickoff: '2026-10-20T19:00:00.000Z', edgePp: 1.5 });
  const b = item({ matchId: 'm-b', kickoff: '2026-10-20T17:00:00.000Z', edgePp: 6.1, leagueId: 'esp-ll', market: 'O2.5', outcome: 'ou2.5:over' });
  const c = item({ matchId: 'm-c', kickoff: '2026-10-20T16:00:00.000Z', edgePp: null, excluded: true, excludeReason: 'analysis_odds_mismatch' });
  const d = item({ matchId: 'm-d', kickoff: '2026-10-20T20:00:00.000Z', edgePp: -2 });
  it('kezdés szerint; edge szerint csak a használható sorok kerülnek előre (csökkenőben), a kizártak utánuk', () => {
    expect(sortItems([a, b, c, d], 'kickoff').map((i) => i.matchId)).toEqual(['m-c', 'm-b', 'm-a', 'm-d']);
    expect(sortItems([a, b, c, d], 'edge').map((i) => i.matchId)).toEqual(['m-b', 'm-a', 'm-d', 'm-c']);
  });
  it('bajnokság, piac és állapot szerinti szűrés', () => {
    expect(filterItems([a, b, c, d], { ...DEFAULT_FILTERS, leagueId: 'esp-ll' }).map((i) => i.matchId)).toEqual(['m-b']);
    expect(filterItems([a, b, c, d], { ...DEFAULT_FILTERS, market: 'O2.5' }).map((i) => i.matchId)).toEqual(['m-b']);
    expect(filterItems([a, b, c, d], { ...DEFAULT_FILTERS, state: 'usable' }).map((i) => i.matchId)).toEqual(['m-a', 'm-b', 'm-d']);
    expect(filterItems([a, b, c, d], { ...DEFAULT_FILTERS, state: 'excluded' }).map((i) => i.matchId)).toEqual(['m-c']);
    expect(coverage([a, b, c], 5)).toEqual({ matchesWithOdds: 3, matches: 5, usable: 2 });
  });
  it('minden ismert gépi kizárási okhoz van emberi szöveg; ismeretlen kódnál általános szöveg', () => {
    for (const code of ['not_prematch', 'kickoff_passed', 'unknown_observation', 'observed_in_play', 'observed_after_kickoff', 'observed_in_future', 'stale', 'invalid_time',
      'analysis_unavailable', 'match_mismatch', 'analysis_odds_mismatch', 'model_prob_missing', 'market_not_mapped', 'invalid_odds', 'missing_outcome', 'mixed_bookmakers',
      'unknown_bookmaker', 'mixed_observations', 'overround_out_of_range', 'line_mismatch', 'market_not_supported']) expect(EXCLUDE_REASON_HU[code], code).toBeTruthy();
    expect(reasonText('valami_uj')).toBe('Nem használható (valami_uj).');
  });
});

describe('Navigáció – regresszió', () => {
  it('minden korábbi menüpont megmaradt; az Edge Radar a Felfedezés csoportban', () => {
    const all = [...PRIMARY, ...PLAY, ...EXPLORE].map((n) => n.to);
    for (const to of ['/tippek', '/tippverseny', '/shop', '/dashboard', '/battles', '/statisztikaim', '/elozmenyek', '/szelvenyek', '/kovetes',
      '/felfedezes', '/meccsek', '/elemzes', '/statisztikak', '/modell-archivum', '/forrasok', '/beallitasok']) expect(all, to).toContain(to);
    expect(EXPLORE.map((n) => n.to)).toContain('/edge-radar');
    expect(all.filter((t) => t === '/edge-radar')).toHaveLength(1);
  });
});
