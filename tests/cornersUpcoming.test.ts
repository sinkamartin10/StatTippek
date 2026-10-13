/**
 * Közelgő (még el nem kezdődött) mérkőzések szöglet-előrejelzése – VALÓS,
 * rögzített ESPN-fixture-rel (tests/fixtures/espn-eng1-corners-2025-26.json:
 * a Premier League 2025-08 – 2026-10 havi scoreboard-válaszai, mezőkre
 * szűkítve, változatlan értékekkel; célmeccs: Everton – Chelsea, 2026-10-17,
 * a lekérés idején ütemezett).
 *
 * A tesztek a VALÓDI EspnProvider szögletútját (hónap-lekérés, parser, éjfél-
 * kezelés), a valódi CornerService-t és a kiadott CORNER_RELEASE paramétereket
 * futtatják; csak a `fetch` van kicserélve a fixture-re. Ezért az élő ESPN-
 * integrációt NEM igazolják – azt csak a fixture rögzítésekori állapotra.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EspnProvider } from '../src/server/data/espnProvider';
import { parseScoreboardCorners } from '../src/server/data/espnCorners';
import { CornerService } from '../src/server/corners/service';
import { CornerIndex, cornerCutoff } from '../src/shared/engine/corners/stats';
import { cornerExpectation } from '../src/shared/engine/corners/model';
import { CORNER_RELEASE } from '../src/shared/engine/corners/release';
import { AnalysisService } from '../src/server/services/analysisService';
import { DemoMatchDataProvider, localDateKey } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import type { Container } from '../src/server/container';
import type { MatchDataProvider } from '../src/server/data/provider';
import type { CornerResult, Match, MatchAnalysis, MatchResult } from '../src/shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const FIX: { months: Record<string, { events: Json[] }>; target: Json } = JSON.parse(readFileSync(new URL('./fixtures/espn-eng1-corners-2025-26.json', import.meta.url), 'utf8'));

const TARGET_ID = 'espn-eng.1-401878771';
const HOME = 'espn-368'; // Everton
const AWAY = 'espn-363'; // Chelsea
const KICKOFF = new Date(FIX.target.date).toISOString(); // 2026-10-17T11:30:00.000Z
const BEFORE = new Date('2026-10-13T12:00:00.000Z');

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** A fixture-ből a `fetch`: csak az eng.1 havi scoreboard-ja; minden más üres válasz. */
function stubFetch(months: Record<string, { events: Json[] }>, fail = false) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    if (fail) throw new Error('ESPN nem elérhető');
    const m = String(url).match(/\/eng\.1\/scoreboard\?dates=(\d{6})$/);
    return new Response(JSON.stringify(m ? months[m[1]] ?? { events: [] } : { events: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

/** Befejezett meccsek a fixture-ből (szögletadattól függetlenül) – a gólelemzés előzménylistájának megfelelője. */
function finishedResults(months: Record<string, { events: Json[] }>): MatchResult[] {
  const out: MatchResult[] = [];
  for (const { events } of Object.values(months)) for (const ev of events) {
    const c = ev.competitions[0];
    if (c.status.type.completed !== true) continue;
    const h = c.competitors.find((x: Json) => x.homeAway === 'home'), a = c.competitors.find((x: Json) => x.homeAway === 'away');
    out.push({ id: `espn-eng.1-${ev.id}`, leagueId: 'eng-pl', date: new Date(ev.date).toISOString(), homeTeamId: `espn-${h.team.id}`, awayTeamId: `espn-${a.team.id}`, homeGoals: Number(h.score), awayGoals: Number(a.score), origin: 'live' });
  }
  return out;
}

function targetMatch(over: Partial<Match> = {}): Match {
  return { id: TARGET_ID, leagueId: 'eng-pl', homeTeamId: HOME, awayTeamId: AWAY, kickoff: KICKOFF, status: 'scheduled', importance: 'normal', importanceReasons: [], origin: 'live', ...over } as Match;
}

/** A valódi EspnProvider szögletútja + a célmeccs és az előzménylista a fixture-ből. */
function provider(months: Record<string, { events: Json[] }>, match: Match): MatchDataProvider {
  const espn = new EspnProvider();
  const p = Object.create(espn) as MatchDataProvider;
  p.getMatch = async (id: string) => (id === match.id ? match : null);
  p.getLeagues = async () => [{ id: 'eng-pl', name: 'Premier League', country: 'Anglia', countryCode: 'ENG', tier: 1, international: false }];
  p.getTeam = async (id: string) => ({ id, name: id === HOME ? 'Everton' : id === AWAY ? 'Chelsea' : id, shortName: id, country: 'Anglia', leagueId: 'eng-pl' });
  p.getResultsForAnalysis = async () => finishedResults(months);
  return p;
}

/** A fixture összes elfogadott szögletadata – a visszateszt kódútjának bemenete. */
function allCorners(months: Record<string, { events: Json[] }>): CornerResult[] {
  return Object.values(months).flatMap((m) => parseScoreboardCorners(m, 'eng.1', 'eng-pl').results);
}

const svc = (p: MatchDataProvider, now: Date) => new CornerService(p, { now: () => now });

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('közelgő mérkőzés – valós ESPN-fixture', () => {
  it('a fixture célmeccse valóban ütemezett, még le nem játszott meccs, szögletadat nélkül', () => {
    expect(FIX.target.competitions[0].status.type).toMatchObject({ completed: false, name: 'STATUS_SCHEDULED' });
    expect(parseScoreboardCorners({ events: [FIX.target] }, 'eng.1', 'eng-pl').results).toEqual([]);
    expect(BEFORE.toISOString() < KICKOFF).toBe(true);
  });

  it('1) közelgő meccshez elegendő adatnál előállítja a validált hazai/vendég előrejelzést (az összes szöglet NEM)', async () => {
    stubFetch(FIX.months);
    const a = await svc(provider(FIX.months, targetMatch()), BEFORE).analyze(TARGET_ID);
    expect(a!.status).toBe('ok');
    expect(a!.reasons).toEqual([]);
    expect(a!.validation).toMatchObject({ validated: true, scopes: ['home', 'away'] });
    const p = a!.prediction!;
    expect(p.modelVersion).toBe('corners-nb-1');
    expect(p.markets.map((m) => m.market)).toEqual([
      'CRN_HOME_O2.5', 'CRN_HOME_O3.5', 'CRN_HOME_O4.5', 'CRN_HOME_O5.5', 'CRN_HOME_O6.5',
      'CRN_AWAY_O2.5', 'CRN_AWAY_O3.5', 'CRN_AWAY_O4.5', 'CRN_AWAY_O5.5', 'CRN_AWAY_O6.5',
    ]);
    expect(p.totalExpected).toBeNull();
    for (const scope of ['home', 'away'] as const) {
      const xs = p.markets.filter((m) => m.scope === scope).map((m) => m.over);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeLessThan(xs[i - 1]);
      expect(xs.every((x) => x > 0 && x < 1)).toBe(true);
    }
    // leíró statisztika mintamérettel, hazai/idegen bontással
    expect(a!.home!.last5.sampleSize).toBe(5);
    expect(a!.home!.last10.sampleSize).toBe(10);
    expect(a!.home!.venue.venue).toBe('hazai');
    expect(a!.away!.venue.venue).toBe('idegen');
    expect(a!.league!.sampleSize).toBe(CORNER_RELEASE.params.leagueWindow);
    expect(a!.oddsAvailable).toBe(false);
  });

  it('4) KISZOLGÁLÁS = VALIDÁLÁS: ugyanazt adja, mint a visszateszt kódútja (cornerExpectation) a teljes fixture-előzményen, a kiadott paraméterekkel', async () => {
    stubFetch(FIX.months);
    const a = await svc(provider(FIX.months, targetMatch()), BEFORE).analyze(TARGET_ID);
    const full = cornerExpectation(new CornerIndex(allCorners(FIX.months)), HOME, AWAY, 'eng-pl', cornerCutoff(KICKOFF), CORNER_RELEASE.params);
    expect(full.ok).toBe(true);
    expect(CORNER_RELEASE.params).toMatchObject({ k: 20, window: 20, distribution: 'negbin', minTeamMatches: 8, minVenueMatches: 4, minLeagueMatches: 40 });
    expect(a!.prediction!.homeExpected).toBeCloseTo(full.homeExpected, 12);
    expect(a!.prediction!.awayExpected).toBeCloseTo(full.awayExpected, 12);
  });

  it('2) a célmeccs saját eredménye és a jövőbeli meccsek nem szivárognak be az előrejelzésbe', async () => {
    stubFetch(FIX.months);
    const base = await svc(provider(FIX.months, targetMatch()), BEFORE).analyze(TARGET_ID);

    // „mintha már lejátszották volna”: a célmeccs befejezett, szélsőséges szögletszámmal + a két csapat jövőbeli meccsei
    const leaked = clone(FIX.months);
    const self = clone(FIX.target);
    self.competitions[0].status.type = { completed: true, name: 'STATUS_FULL_TIME', state: 'post', shortDetail: 'FT' };
    for (const c of self.competitions[0].competitors) c.statistics = [{ name: 'wonCorners', displayValue: '30' }, { name: 'possessionPct', displayValue: '50' }, { name: 'totalShots', displayValue: '20' }];
    const at = leaked['202610'].events.findIndex((e: Json) => e.id === FIX.target.id);
    expect(at).toBeGreaterThanOrEqual(0);
    leaked['202610'].events[at] = self; // a célmeccs „lejátszott” változata (nem duplikátumként)
    for (let i = 0; i < 6; i++) {
      const f = clone(self);
      f.id = `99990${i}`;
      f.date = new Date(new Date(KICKOFF).getTime() + (i + 1) * 3 * 86400_000).toISOString();
      leaked['202610'].events.push(f);
    }
    // a parser ezeket valóban elfogadná – tehát csak az időrendi szűrés véd
    expect(allCorners(leaked).some((r) => r.matchId === TARGET_ID && r.homeCorners === 30)).toBe(true);

    stubFetch(leaked);
    const after = await svc(provider(leaked, targetMatch()), BEFORE).analyze(TARGET_ID);
    expect(after!.prediction).toEqual(base!.prediction);
    expect(after!.home).toEqual(base!.home);
    expect(after!.league).toEqual(base!.league);
  });

  it('3) a kezdés után (vagy élő/befejezett/halasztott meccsnél) nincs mérkőzés előtti előrejelzés – a cache-ből sem', async () => {
    stubFetch(FIX.months);
    const kick = new Date(KICKOFF).getTime();
    const p = provider(FIX.months, targetMatch());
    let now = BEFORE;
    const s = new CornerService(p, { now: () => now });
    expect((await s.analyze(TARGET_ID))!.prediction).not.toBeNull();
    now = new Date(kick + 60_000); // ugyanaz a szolgáltatás-példány, a cache-ben még ott a kezdés előtti eredmény
    const later = await s.analyze(TARGET_ID);
    expect(later!.prediction).toBeNull();
    expect(later!.reasons.join(' ')).toMatch(/már elkezdődött vagy befejeződött/);
    expect(later!.home!.last10.sampleSize).toBe(10); // a kezdés előtti leíró statisztika marad

    for (const [status, re] of [['live', /elkezdődött/], ['finished', /elkezdődött/], ['postponed', /elhalasztották/]] as const) {
      const a = await svc(provider(FIX.months, targetMatch({ status })), BEFORE).analyze(TARGET_ID);
      expect(a!.prediction, status).toBeNull();
      expect(a!.reasons.join(' ')).toMatch(re);
    }
    // a szolgáltató elavult „scheduled” státusza mellett is: ha a kezdés elmúlt, nincs előrejelzés
    const stale = await svc(provider(FIX.months, targetMatch()), new Date(kick + 3600_000)).analyze(TARGET_ID);
    expect(stale!.prediction).toBeNull();
  });

  it('5) ESPN-hiba: biztonságos „nem elérhető” állapot, nincs előrejelzés és nincs kitalált adat', async () => {
    stubFetch(FIX.months, true);
    const a = await svc(provider(FIX.months, targetMatch()), BEFORE).analyze(TARGET_ID);
    expect(a!.status).toBe('unavailable');
    expect(a!.prediction).toBeNull();
    expect(a!.home).toBeNull();
    expect(a!.reasons.join(' ')).toMatch(/nem érhető el/);
  });

  it('6) a hiányzó szögletadat nem válik nullává: kimarad, a mintaméret csökken', async () => {
    const missing = clone(FIX.months);
    // az Everton legutóbbi hazai meccsén töröljük a szögletszámot (a többi statisztika marad)
    const evs = Object.values(missing).flatMap((m) => m.events).filter((e) => e.competitions[0].status.type.completed && e.competitions[0].competitors.find((c: Json) => c.homeAway === 'home').team.id === '368' && e.date < KICKOFF);
    const last = evs.sort((a, b) => b.date.localeCompare(a.date))[0];
    for (const c of last.competitions[0].competitors) c.statistics = c.statistics.filter((s: Json) => s.name !== 'wonCorners');
    stubFetch(missing);
    const a = await svc(provider(missing, targetMatch()), BEFORE).analyze(TARGET_ID);
    stubFetch(FIX.months);
    const full = await svc(provider(FIX.months, targetMatch()), BEFORE).analyze(TARGET_ID);
    expect(a!.coverage.skipped.missing_value).toBe(1);
    expect(a!.coverage.valid).toBe(full!.coverage.valid - 1);
    expect(a!.home!.last5.considered).toBe(5);
    expect(a!.home!.last5.sampleSize).toBe(4); // a hiányzó meccs kimarad, nem 0 szögletként számít
    const zeroed = allCorners(FIX.months).find((r) => r.matchId === `espn-eng.1-${last.id}`)!;
    expect(zeroed.homeCorners + zeroed.awayCorners).toBeGreaterThan(0);
  });

  it('7) kevés történelmi adat: „Nincs megbízható” állapot okkal, és nincs megbízhatónak feltüntetett előrejelzés', async () => {
    // idény eleji meccs: a fixture 2025-08-tól indul, a csapatoknak még nincs 8 érvényes meccsük
    const early = targetMatch({ kickoff: '2025-08-23T14:00:00.000Z' });
    stubFetch(FIX.months);
    const a = await svc(provider(FIX.months, early), new Date('2025-08-22T12:00:00.000Z')).analyze(TARGET_ID);
    expect(a!.status).toBe('insufficient');
    expect(a!.prediction).toBeNull();
    expect(a!.reasons.join(' ')).toMatch(/legalább 8 kell|legalább 40 kell/);
    // a küszöböket nem csökkentjük automatikusan
    expect(CORNER_RELEASE.params.minTeamMatches).toBe(8);
  });

  it('lekérés: csak az eng.1 havi scoreboardja, ismétlés nélkül; a második elemzés nem indít új kérést', async () => {
    const calls = stubFetch(FIX.months);
    const p = provider(FIX.months, targetMatch());
    await svc(p, BEFORE).analyze(TARGET_ID);
    expect(calls.every((u) => /\/eng\.1\/scoreboard\?dates=\d{6}$/.test(u))).toBe(true);
    expect(new Set(calls).size).toBe(calls.length);
    const n = calls.length;
    await svc(p, BEFORE).analyze(TARGET_ID); // ugyanaz a provider (memória-cache), új szolgáltatás-példány
    expect(calls.length).toBe(n);
  });
});

describe('10) a szöglet-előrejelzés nem kerül a Tippek listára és a gólpiaci archívumba', () => {
  it('Tippek lista és archívum-rögzítés: csak gólpiaci tippek, CRN_ kód és corners mező nélkül', async () => {
    const demo = new DemoMatchDataProvider();
    const recorded: MatchAnalysis[] = [];
    const archive = { record: async (a: MatchAnalysis) => { recorded.push(a); return { inserted: 0 }; } };
    const container = {
      data: demo, research: new DemoResearchProvider(demo), oddsApi: null,
      db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
    } as unknown as Container;
    const s = new AnalysisService(container, archive as never);
    // a Tippek lista helyi nap szerint szűr (ugyanaz a kulcs, mint az API-ban) – nem UTC-szelet
    const day = localDateKey((await demo.getMatches({ status: 'scheduled' }))[0].kickoff);
    const list = await s.tipsForDate(day);
    await s.archiveIdle();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((e) => e.tip.market.startsWith('CRN_'))).toBe(false);
    expect(recorded.length).toBeGreaterThan(0);
    for (const a of recorded) {
      expect(a.tips.some((t) => t.market.startsWith('CRN_'))).toBe(false);
      expect('corners' in a).toBe(false);
    }
  });
});
