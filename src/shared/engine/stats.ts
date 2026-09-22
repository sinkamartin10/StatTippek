/**
 * Statisztikai motor: forma, gólpiacok, egymás elleni mérkőzések, tabella, liga-átlagok.
 * Minden függvény tiszta (nincs mellékhatás), így a szerveren és tesztekben is futtatható.
 * A százalékok 0–100 skálán vannak. Üres mintánál 0-t vagy null-t adunk, sosem kitalált számot.
 */
import type {
  FormSummary,
  FormMatchRow,
  GoalMarketIndicator,
  H2HSummary,
  LeagueAverages,
  MatchResult,
  StandingRow,
} from '../types';

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Egy csapat szemszögéből nézve a meccs (gf/ga, helyszín). */
export function teamPerspective(teamId: string, r: MatchResult): FormMatchRow {
  const home = r.homeTeamId === teamId;
  const gf = home ? r.homeGoals : r.awayGoals;
  const ga = home ? r.awayGoals : r.homeGoals;
  return {
    date: r.date,
    opponentId: home ? r.awayTeamId : r.homeTeamId,
    venue: home ? 'H' : 'A',
    gf,
    ga,
    result: gf > ga ? 'W' : gf === ga ? 'D' : 'L',
  };
}

/** A csapat mérkőzései időrendben csökkenő sorrendben (legfrissebb elöl). */
export function teamResults(teamId: string, results: MatchResult[], beforeDate?: string): MatchResult[] {
  return results
    .filter((r) => (r.homeTeamId === teamId || r.awayTeamId === teamId) && (!beforeDate || r.date < beforeDate))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Formaösszegzés az utolsó `n` meccsből, opcionálisan csak hazai/idegen meccsekre szűrve.
 * Ha kevesebb meccs van, mint `n`, a mintanagyság (sampleSize) mutatja a valós számot.
 */
export function computeForm(
  teamId: string,
  results: MatchResult[],
  n: number,
  venue: 'összes' | 'hazai' | 'idegen' = 'összes',
  beforeDate?: string,
): FormSummary {
  const all = teamResults(teamId, results, beforeDate).filter((r) => {
    if (venue === 'hazai') return r.homeTeamId === teamId;
    if (venue === 'idegen') return r.awayTeamId === teamId;
    return true;
  });
  const slice = all.slice(0, n);
  const rows = slice.map((r) => teamPerspective(teamId, r));
  const size = rows.length;

  const wins = rows.filter((r) => r.result === 'W').length;
  const draws = rows.filter((r) => r.result === 'D').length;
  const losses = rows.filter((r) => r.result === 'L').length;
  const gf = rows.reduce((s, r) => s + r.gf, 0);
  const ga = rows.reduce((s, r) => s + r.ga, 0);
  const totals = rows.map((r) => r.gf + r.ga);

  // Félidei gólok csak akkor, ha minden meccsnél elérhető a félidei eredmény
  const withHt = slice.filter((r) => r.htHomeGoals != null && r.htAwayGoals != null);
  const fh = withHt.length === size && size > 0
    ? round2(withHt.reduce((s, r) => s + (r.htHomeGoals! + r.htAwayGoals!), 0) / size)
    : null;
  const sh = fh != null ? round2(totals.reduce((a, b) => a + b, 0) / size - fh) : null;

  return {
    teamId,
    venue,
    sampleSize: size,
    wins,
    draws,
    losses,
    goalsFor: gf,
    goalsAgainst: ga,
    avgGoalsFor: size ? round2(gf / size) : 0,
    avgGoalsAgainst: size ? round2(ga / size) : 0,
    cleanSheets: rows.filter((r) => r.ga === 0).length,
    failedToScore: rows.filter((r) => r.gf === 0).length,
    formString: rows.map((r) => r.result).join(''),
    points: wins * 3 + draws,
    over05: pct(totals.filter((t) => t > 0.5).length, size),
    over15: pct(totals.filter((t) => t > 1.5).length, size),
    over25: pct(totals.filter((t) => t > 2.5).length, size),
    over35: pct(totals.filter((t) => t > 3.5).length, size),
    under15: pct(totals.filter((t) => t < 1.5).length, size),
    under25: pct(totals.filter((t) => t < 2.5).length, size),
    under35: pct(totals.filter((t) => t < 3.5).length, size),
    btts: pct(rows.filter((r) => r.gf > 0 && r.ga > 0).length, size),
    firstHalfGoalsAvg: fh,
    secondHalfGoalsAvg: sh,
    matches: rows,
  };
}

/** Egymás elleni mérkőzések (bármelyik pályán, bármely sorozatban). */
export function computeH2H(homeTeamId: string, awayTeamId: string, results: MatchResult[], limit = 10, beforeDate?: string): H2HSummary {
  const ms = results
    .filter(
      (r) =>
        ((r.homeTeamId === homeTeamId && r.awayTeamId === awayTeamId) ||
          (r.homeTeamId === awayTeamId && r.awayTeamId === homeTeamId)) &&
        (!beforeDate || r.date < beforeDate),
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit);
  const size = ms.length;
  const homeTeamWins = ms.filter((r) => (r.homeTeamId === homeTeamId ? r.homeGoals > r.awayGoals : r.awayGoals > r.homeGoals)).length;
  const draws = ms.filter((r) => r.homeGoals === r.awayGoals).length;
  return {
    sampleSize: size,
    homeTeamWins,
    draws,
    awayTeamWins: size - homeTeamWins - draws,
    avgGoals: size ? round2(ms.reduce((s, r) => s + r.homeGoals + r.awayGoals, 0) / size) : 0,
    bttsPct: pct(ms.filter((r) => r.homeGoals > 0 && r.awayGoals > 0).length, size),
    over25Pct: pct(ms.filter((r) => r.homeGoals + r.awayGoals > 2.5).length, size),
    matches: ms.map((r) => ({ date: r.date, homeTeamId: r.homeTeamId, awayTeamId: r.awayTeamId, hg: r.homeGoals, ag: r.awayGoals, leagueId: r.leagueId })),
  };
}

/** Tabella egy bajnokság eredményeiből. */
export function computeStandings(leagueId: string, results: MatchResult[], beforeDate?: string): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  const get = (id: string) => {
    if (!rows.has(id)) rows.set(id, { teamId: id, played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, gd: 0, points: 0, position: 0 });
    return rows.get(id)!;
  };
  for (const r of results) {
    if (r.leagueId !== leagueId || (beforeDate && r.date >= beforeDate)) continue;
    const h = get(r.homeTeamId);
    const a = get(r.awayTeamId);
    h.played++; a.played++;
    h.gf += r.homeGoals; h.ga += r.awayGoals;
    a.gf += r.awayGoals; a.ga += r.homeGoals;
    if (r.homeGoals > r.awayGoals) { h.wins++; a.losses++; h.points += 3; }
    else if (r.homeGoals < r.awayGoals) { a.wins++; h.losses++; a.points += 3; }
    else { h.draws++; a.draws++; h.points++; a.points++; }
  }
  const list = [...rows.values()].map((r) => ({ ...r, gd: r.gf - r.ga }));
  list.sort((x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || x.teamId.localeCompare(y.teamId));
  list.forEach((r, i) => (r.position = i + 1));
  return list;
}

/** Liga-átlagok – a várható gól modell normalizálásához. */
export function computeLeagueAverages(leagueId: string, results: MatchResult[], beforeDate?: string): LeagueAverages {
  const ms = results.filter((r) => r.leagueId === leagueId && (!beforeDate || r.date < beforeDate));
  const n = ms.length;
  const hg = ms.reduce((s, r) => s + r.homeGoals, 0);
  const ag = ms.reduce((s, r) => s + r.awayGoals, 0);
  return {
    leagueId,
    matches: n,
    avgHomeGoals: n ? round2(hg / n) : 0,
    avgAwayGoals: n ? round2(ag / n) : 0,
    avgTotalGoals: n ? round2((hg + ag) / n) : 0,
    homeWinPct: pct(ms.filter((r) => r.homeGoals > r.awayGoals).length, n),
    drawPct: pct(ms.filter((r) => r.homeGoals === r.awayGoals).length, n),
    awayWinPct: pct(ms.filter((r) => r.homeGoals < r.awayGoals).length, n),
    over25Pct: pct(ms.filter((r) => r.homeGoals + r.awayGoals > 2.5).length, n),
    bttsPct: pct(ms.filter((r) => r.homeGoals > 0 && r.awayGoals > 0).length, n),
  };
}

/**
 * Gólpiaci mutatók: a két csapat historikus gyakoriságának egyszerű átlaga.
 * Ez HISTORIKUS statisztika, nem jövőbeli valószínűség – a modell (Poisson) külön számol.
 */
export function computeGoalMarkets(home: FormSummary, away: FormSummary): GoalMarketIndicator[] {
  const size = home.sampleSize + away.sampleSize;
  const mk = (market: string, label: string, h: number, a: number): GoalMarketIndicator => {
    const hp = home.sampleSize ? h : null;
    const ap = away.sampleSize ? a : null;
    const combined = hp != null && ap != null ? Math.round(((hp + ap) / 2) * 10) / 10 : hp ?? ap;
    return { market, label, homePct: hp, awayPct: ap, combinedPct: combined, sampleSize: size };
  };
  return [
    mk('O0.5', 'Több mint 0,5', home.over05, away.over05),
    mk('O1.5', 'Több mint 1,5', home.over15, away.over15),
    mk('O2.5', 'Több mint 2,5', home.over25, away.over25),
    mk('O3.5', 'Több mint 3,5', home.over35, away.over35),
    mk('O4.5', 'Több mint 4,5',
      pct(home.matches.filter((m) => m.gf + m.ga > 4.5).length, home.sampleSize),
      pct(away.matches.filter((m) => m.gf + m.ga > 4.5).length, away.sampleSize)),
    mk('U1.5', 'Kevesebb mint 1,5', home.under15, away.under15),
    mk('U2.5', 'Kevesebb mint 2,5', home.under25, away.under25),
    mk('U3.5', 'Kevesebb mint 3,5', home.under35, away.under35),
    mk('U4.5', 'Kevesebb mint 4,5',
      pct(home.matches.filter((m) => m.gf + m.ga < 4.5).length, home.sampleSize),
      pct(away.matches.filter((m) => m.gf + m.ga < 4.5).length, away.sampleSize)),
    mk('BTTS_Y', 'Mindkét csapat szerez gólt – igen', home.btts, away.btts),
    mk('BTTS_N', 'Mindkét csapat szerez gólt – nem', 100 - home.btts, 100 - away.btts),
  ];
}
