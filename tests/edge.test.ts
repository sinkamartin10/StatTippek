/**
 * Edge Radar 1. fázis – tiszta számítási alapok (src/shared/engine/edge.ts).
 */
import { describe, expect, it } from 'vitest';
import { checkFreshness, devig1x2, devigTwoWay, ev, evSupported, quoteFrom, rawImplied, validOdds, type OddsQuote } from '../src/shared/engine/edge';
import type { MatchOdds } from '../src/shared/types';

const T = '2026-10-20T10:00:00.000Z';
const q = (odds: number, bookmaker: string | null = 'DraftKings (ESPN)', observedAt: string | null = T): OddsQuote => ({ odds, bookmaker, observedAt });

describe('rawImplied / validOdds', () => {
  it('érvényes tizedes odds: 1/odds', () => {
    expect(rawImplied(2)).toBe(0.5);
    expect(rawImplied(1.25)).toBeCloseTo(0.8, 12);
    expect(rawImplied(1000)).toBeCloseTo(0.001, 12);
  });
  it('érvénytelen odds → null (nincs becsült érték)', () => {
    for (const bad of [1, 0.99, 0, -2, NaN, Infinity, 1000.01, '2.0', null, undefined]) {
      expect(rawImplied(bad), String(bad)).toBeNull();
      expect(validOdds(bad)).toBe(false);
    }
  });
});

describe('devig1x2', () => {
  it('teljes, egyirodás, egy megfigyelésű 1X2: arányos normalizálás, az összeg 1', () => {
    const r = devig1x2({ home: q(2.1), draw: q(3.5), away: q(3.4) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const over = 1 / 2.1 + 1 / 3.5 + 1 / 3.4;
    expect(r.overround).toBeCloseTo(over, 12);
    expect(r.method).toBe('proportional');
    expect(r.probs.home).toBeCloseTo(1 / 2.1 / over, 12);
    expect(r.probs.home + r.probs.draw + r.probs.away).toBeCloseTo(1, 12);
    expect(r.bookmaker).toBe('DraftKings (ESPN)');
    expect(r.observedAt).toBe(T);
  });
  it('hiányzó kimenetel → missing_outcome', () => {
    expect(devig1x2({ home: q(2.1), away: q(3.4) })).toEqual({ ok: false, reason: 'missing_outcome' });
    expect(devig1x2({ home: q(2.1), draw: null, away: q(3.4) })).toEqual({ ok: false, reason: 'missing_outcome' });
  });
  it('vegyes iroda, ismeretlen iroda, eltérő vagy ismeretlen megfigyelés → elutasítva', () => {
    expect(devig1x2({ home: q(2.1), draw: q(3.5, 'Bet365'), away: q(3.4) })).toEqual({ ok: false, reason: 'mixed_bookmakers' });
    expect(devig1x2({ home: q(2.1, null), draw: q(3.5, null), away: q(3.4, null) })).toEqual({ ok: false, reason: 'unknown_bookmaker' });
    expect(devig1x2({ home: q(2.1), draw: { odds: 3.5, bookmaker: undefined, observedAt: T }, away: q(3.4) })).toEqual({ ok: false, reason: 'unknown_bookmaker' });
    expect(devig1x2({ home: q(2.1), draw: { odds: 3.5, bookmaker: '  ', observedAt: T }, away: q(3.4) })).toEqual({ ok: false, reason: 'unknown_bookmaker' });
    expect(devig1x2({ home: q(2.1), draw: q(3.5, 'DraftKings (ESPN)', '2026-10-20T10:05:00.000Z'), away: q(3.4) })).toEqual({ ok: false, reason: 'mixed_observations' });
    expect(devig1x2({ home: q(2.1, 'X', null), draw: q(3.5, 'X', null), away: q(3.4, 'X', null) })).toEqual({ ok: false, reason: 'unknown_observation' });
  });
  it('irreális árrés (Σ<1: „arbitrázs”; Σ>1,25) és érvénytelen odds → elutasítva; a határ konfigurálható', () => {
    expect(devig1x2({ home: q(3), draw: q(4), away: q(4) })).toEqual({ ok: false, reason: 'overround_out_of_range' }); // Σ≈0,83
    expect(devig1x2({ home: q(1.5), draw: q(2.5), away: q(3) })).toEqual({ ok: false, reason: 'overround_out_of_range' }); // Σ≈1,40
    expect(devig1x2({ home: q(1.5), draw: q(2.5), away: q(3) }, { maxOverround: 1.5 }).ok).toBe(true);
    expect(devig1x2({ home: q(2.1), draw: q(3.5), away: q(3.4) }, { maxOverround: 1.02 })).toEqual({ ok: false, reason: 'overround_out_of_range' });
    expect(devig1x2({ home: q(1), draw: q(3.5), away: q(3.4) })).toEqual({ ok: false, reason: 'invalid_odds' });
  });
});

describe('devigTwoWay (O/U)', () => {
  const ou = (odds: number, line = 2.5, book = 'DraftKings (ESPN)', at = T) => ({ ...q(odds, book, at), line });
  it('teljes, egyirodás pár azonos vonalon', () => {
    const r = devigTwoWay({ over: ou(1.91), under: ou(1.91) });
    expect(r.ok && r.probs.over).toBeCloseTo(0.5, 12);
    expect(r.ok && r.overround).toBeCloseTo(2 / 1.91, 12);
  });
  it('hiányzó oldal, eltérő vonal, vegyes iroda vagy megfigyelés → elutasítva', () => {
    expect(devigTwoWay({ over: ou(1.91) })).toEqual({ ok: false, reason: 'missing_outcome' });
    expect(devigTwoWay({ over: ou(1.91, 2.5), under: ou(1.91, 3.5) })).toEqual({ ok: false, reason: 'line_mismatch' });
    expect(devigTwoWay({ over: ou(1.91), under: ou(1.91, 2.5, 'Bet365') })).toEqual({ ok: false, reason: 'mixed_bookmakers' });
    expect(devigTwoWay({ over: ou(1.91), under: ou(1.91, 2.5, 'DraftKings (ESPN)', '2026-10-20T11:00:00.000Z') })).toEqual({ ok: false, reason: 'mixed_observations' });
  });
});

describe('quoteFrom: csak igazoltan egyirodás megfigyelés kap irodát és időt', () => {
  const base: MatchOdds = { matchId: 'm', source: 'live', bookmaker: 'DraftKings (ESPN)', retrievedAt: '2026-10-20T10:30:00.000Z', markets: { '1': 2.1, X: 3.5, '2': 3.4 } };
  const close = { '1': 'close', X: 'close', '2': 'close' } as const;
  it('ESPN-megfigyelés: egy iroda, egy megfigyelés, minden ár az aktuális (close) vonalból → árrésmentesíthető', () => {
    const o: MatchOdds = { ...base, observedAt: T, observation: { via: 'espn-scoreboard', singleBook: true, matchStatus: 'scheduled', priceKind: close } };
    expect(devig1x2({ home: quoteFrom(o, '1'), draw: quoteFrom(o, 'X'), away: quoteFrom(o, '2') }).ok).toBe(true);
  });
  it('a singleBook önmagában NEM elég: vegyes close/open ár, igazolatlan vonal vagy hiányzó vonal-jelölés (ESPN) → unavailable', () => {
    for (const priceKind of [{ ...close, X: 'open' as const }, { ...close, '2': 'unverified' as const }, undefined]) {
      const o: MatchOdds = { ...base, observedAt: T, observation: { via: 'espn-scoreboard', singleBook: true, matchStatus: 'scheduled', priceKind } };
      const r = devig1x2({ home: quoteFrom(o, '1'), draw: quoteFrom(o, 'X'), away: quoteFrom(o, '2') });
      expect(r.ok, JSON.stringify(priceKind)).toBe(false);
    }
  });
  it('eredet nélküli (kézi / összefésült / régi) vagy több irodás odds → unavailable; a feldolgozási idő NEM számít megfigyelésnek', () => {
    for (const o of [base, { ...base, observedAt: T }, { ...base, observedAt: T, observation: { via: 'the-odds-api' as const, singleBook: false } }]) {
      const r = devig1x2({ home: quoteFrom(o, '1'), draw: quoteFrom(o, 'X'), away: quoteFrom(o, '2') });
      expect(r.ok).toBe(false);
    }
    expect(quoteFrom(base, 'O2.5')).toBeNull();
    expect(quoteFrom(null, '1')).toBeNull();
  });
});

describe('ev: csak visszatérítés nélküli piacokon', () => {
  it('érvényes EV = p·o − 1', () => {
    expect(ev(0.55, 2, '1')).toEqual({ ok: true, ev: 0.10000000000000009 });
    const r = ev(0.4, 2.2, 'O2.5');
    expect(r.ok && r.ev).toBeCloseTo(-0.12, 12);
    expect(ev(0, 3, 'X')).toEqual({ ok: true, ev: -1 });
  });
  it('DNB és ázsiai hendikep: nincs általános EV', () => {
    for (const m of ['DNB_1', 'DNB_2', 'AH_HOME_-1']) {
      expect(evSupported(m)).toBe(false);
      expect(ev(0.6, 1.8, m)).toEqual({ ok: false, reason: 'market_not_supported' });
    }
    expect(ev(0.5, 2, 'CS_1-0')).toEqual({ ok: false, reason: 'market_not_supported' });
  });
  it('érvénytelen valószínűség vagy odds → elutasítva', () => {
    expect(ev(1.2, 2, '1')).toEqual({ ok: false, reason: 'invalid_probability' });
    expect(ev(NaN, 2, '1')).toEqual({ ok: false, reason: 'invalid_probability' });
    expect(ev(0.5, 1, '1')).toEqual({ ok: false, reason: 'invalid_odds' });
  });
});

describe('checkFreshness: csak friss, kezdés előtti, tervezett állapotú megfigyelés', () => {
  const kickoff = '2026-10-20T18:00:00.000Z';
  const ok = { observedAt: '2026-10-20T16:30:00.000Z', observedStatus: 'scheduled' as const, matchStatus: 'scheduled' as const, kickoff, now: '2026-10-20T17:00:00.000Z' };
  it('friss megfigyelés: elfogadva, a kor kiszámítva', () => {
    expect(checkFreshness(ok)).toEqual({ ok: true, ageMs: 30 * 60_000 });
  });
  it('elavult (alapból 60 perc, konfigurálható)', () => {
    expect(checkFreshness({ ...ok, now: '2026-10-20T17:31:00.000Z' })).toEqual({ ok: false, reason: 'stale' });
    expect(checkFreshness({ ...ok, maxAgeMs: 10 * 60_000 })).toEqual({ ok: false, reason: 'stale' });
  });
  it('kezdés utáni megfigyelés, elmúlt kezdés, élő/befejezett/halasztott meccs, élő állapotú megfigyelés → kizárva', () => {
    expect(checkFreshness({ ...ok, observedAt: '2026-10-20T18:05:00.000Z', kickoff: '2026-10-20T18:00:00.000Z', now: '2026-10-20T17:59:00.000Z' })).toEqual({ ok: false, reason: 'observed_after_kickoff' });
    expect(checkFreshness({ ...ok, now: '2026-10-20T18:00:00.000Z' })).toEqual({ ok: false, reason: 'kickoff_passed' });
    for (const s of ['live', 'finished', 'postponed'] as const) expect(checkFreshness({ ...ok, matchStatus: s })).toEqual({ ok: false, reason: 'not_prematch' });
    expect(checkFreshness({ ...ok, observedStatus: 'live' })).toEqual({ ok: false, reason: 'observed_in_play' });
  });
  it('ismeretlen megfigyelés (nincs idő vagy állapot), jövőbeli megfigyelés, hibás idő → kizárva', () => {
    expect(checkFreshness({ ...ok, observedAt: undefined })).toEqual({ ok: false, reason: 'unknown_observation' });
    expect(checkFreshness({ ...ok, observedStatus: undefined })).toEqual({ ok: false, reason: 'unknown_observation' });
    expect(checkFreshness({ ...ok, observedAt: '2026-10-20T17:10:00.000Z' })).toEqual({ ok: false, reason: 'observed_in_future' });
    expect(checkFreshness({ ...ok, kickoff: 'nem-dátum' })).toEqual({ ok: false, reason: 'invalid_time' });
  });
});
