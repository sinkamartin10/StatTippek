/**
 * Az offline lefedettség-mérés szimulációja (scripts/lib/espnDataset.ts): idényváltás,
 * feljutó/kieső csapat, frissen indult vs. bemelegedett szerver, csak-előzmény liga,
 * egy meccs egyszer, időbeli szivárgás.
 */
import { describe, expect, it } from 'vitest';
import { Index, available, teamState, type Row } from '../scripts/lib/espnDataset';
import { espnSeasonOf } from '../src/server/data/historyPlan';

let n = 0;
const row = (competitionId: string, date: string, home: string, away: string, hg = 1, ag = 0): Row => ({
  id: `espn-x-${++n}`, date, competitionId, homeTeamId: home, awayTeamId: away, homeGoals: hg, awayGoals: ag, regulation: true, espnSeason: espnSeasonOf(competitionId, date),
});

describe('Lefedettség-szimuláció', () => {
  // R: 2025-26-ban PL, 2026-27-ben Championship (kiesett). P: 2025-26-ban Championship, 2026-27-ben PL (feljutott).
  const rows: Row[] = [
    row('eng-pl', '2025-09-01T14:00:00Z', 'R', 'A'), row('eng-pl', '2026-01-10T14:00:00Z', 'A', 'R'), row('eng-pl', '2026-03-01T14:00:00Z', 'R', 'B'),
    row('eng-ch', '2025-10-01T14:00:00Z', 'P', 'C'), row('eng-ch', '2026-02-01T14:00:00Z', 'C', 'P'),
    row('eng-pl', '2026-08-20T14:00:00Z', 'P', 'A'), row('eng-ch', '2026-08-21T14:00:00Z', 'R', 'C'),
    row('eng-ch', '2026-09-05T14:00:00Z', 'C', 'R'), // célmeccs
    row('eng-ch', '2026-09-05T12:00:00Z', 'R', 'X'), // a kezdés előtti 3 órán belül – nem látható
  ];
  const ix = new Index(rows);
  const target = rows[7];

  it('idényváltás: a kiesett csapat friss szerveren csak Championship-csapat, bemelegedett szerveren a PL-hez is tartozik', () => {
    expect(teamState(ix, 'R', target.date, 'cold')).toEqual({ id: 'R', leagueId: 'eng-ch', competitions: ['eng-ch'] });
    expect(teamState(ix, 'R', target.date, 'warm').competitions.sort()).toEqual(['eng-ch', 'eng-pl']);
    expect(teamState(ix, 'P', target.date, 'cold')).toEqual({ id: 'P', leagueId: 'eng-pl', competitions: ['eng-pl'] });
  });

  it('kiesett csapat: az előző PL-idény csak a bemelegedett szerveren vagy a bővítéssel látszik', () => {
    const plOf = (rs: Row[]) => rs.filter((r) => r.competitionId === 'eng-pl' && (r.homeTeamId === 'R' || r.awayTeamId === 'R')).length;
    expect(plOf(available(ix, target, { mode: 'cold', extended: false }).rows)).toBe(0);
    expect(plOf(available(ix, target, { mode: 'warm', extended: false }).rows)).toBe(3);
    const ext = available(ix, target, { mode: 'cold', extended: true });
    expect(plOf(ext.rows)).toBe(3);
    expect(ext.rows.filter((r) => r.competitionId === 'eng-pl').every((r) => ext.sourceOf.get(r.id) === 'kieso_elozo_elsoosztaly' || ext.sourceOf.get(r.id) === 'elozo_hazai_idény')).toBe(true);
  });

  it('feljutott csapat: az előző másodosztályú idény már az eredeti adatkörben is bent van (feljutó-szabály)', () => {
    const m = row('eng-pl', '2026-09-12T14:00:00Z', 'P', 'B');
    const ix2 = new Index([...rows, m]);
    const got = available(ix2, m, { mode: 'cold', extended: false });
    expect(got.rows.filter((r) => r.competitionId === 'eng-ch' && (r.homeTeamId === 'P' || r.awayTeamId === 'P')).length).toBe(2);
    expect([...got.sourceOf.values()]).toContain('feljuto_elozo_masodosztaly');
  });

  it('időbeli szivárgás és duplikáció: a kezdés előtti 3 órán belüli és későbbi meccs nincs benne; minden meccs egyszer', () => {
    for (const opts of [{ mode: 'cold' as const, extended: false }, { mode: 'warm' as const, extended: false }, { mode: 'cold' as const, extended: true }]) {
      const got = available(ix, target, opts).rows;
      expect(got.every((r) => Date.parse(r.date) <= Date.parse(target.date) - 3 * 3600_000)).toBe(true);
      expect(new Set(got.map((r) => r.id)).size).toBe(got.length);
      expect(got.some((r) => r.id === target.id)).toBe(false);
    }
  });

  it('csak-előzmény hazai liga: kupameccsnél a hazai bajnoki adat nélküli klub ligája bekerül; ha nincs adat, nem talál ki semmit', () => {
    const r2: Row[] = [
      row('por-pl', '2026-08-15T19:00:00Z', 'BEN', 'POR'), row('por-pl', '2026-03-01T19:00:00Z', 'POR', 'BEN'),
      row('uefa-ucl', '2026-09-17T19:00:00Z', 'A', 'BEN'), row('eng-pl', '2026-08-30T14:00:00Z', 'A', 'B'),
    ];
    const m = row('uefa-ucl', '2026-10-21T19:00:00Z', 'BEN', 'A');
    const ix3 = new Index([...r2, m]);
    const base = available(ix3, m, { mode: 'cold', extended: false }).rows;
    const ext = available(ix3, m, { mode: 'cold', extended: true });
    expect(base.some((r) => r.competitionId === 'por-pl')).toBe(false);
    expect(ext.rows.filter((r) => r.competitionId === 'por-pl')).toHaveLength(2);
    // ismeretlen hazai ligájú klub: nincs mit hozzáadni
    const m2 = row('uefa-ucl', '2026-10-21T19:00:00Z', 'ZAG', 'A');
    const ix4 = new Index([...r2, m2]);
    expect(available(ix4, m2, { mode: 'cold', extended: true }).rows.filter((r) => r.homeTeamId === 'ZAG' || r.awayTeamId === 'ZAG')).toHaveLength(0);
  });

  it('válogatott: márciusban az eredeti adatkör az előző naptári év barátságos meccseit kihagyja, a bővített nem', () => {
    const r4: Row[] = [row('fifa-friendly', '2025-06-06T18:00:00Z', 'HUN', 'GER'), row('uefa-nl', '2024-09-07T18:00:00Z', 'HUN', 'GER')];
    const m = row('fifa-friendly', '2026-03-26T19:00:00Z', 'HUN', 'GER');
    const ix5 = new Index([...r4, m]);
    const f = (rs: Row[]) => rs.filter((r) => r.competitionId === 'fifa-friendly').length;
    expect(f(available(ix5, m, { mode: 'cold', extended: false }).rows)).toBe(0);
    expect(f(available(ix5, m, { mode: 'cold', extended: true }).rows)).toBe(1);
  });
});
