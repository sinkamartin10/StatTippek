/**
 * Liga-alapérték (liga-átlag) a várható gól modellhez.
 *
 * BAJNOKI MECCS: változatlanul a bajnokság saját eredményeiből (`computeLeagueAverages(league.id, …)`).
 *
 * KUPAMECCS (hazai vagy nemzetközi kupa, válogatott sorozat, barátságos): a sorozat saját eredményei
 * félrevezetők – az első fordulók profi–amatőr párharcai (pl. 11–0) és a vegyes erősségű mezőny torzítják
 * a gólszintet. Ezért a részt vevő csapatok ELSŐDLEGES BAJNOKSÁGÁNAK rendes játékidős átlagát használjuk:
 *  - mindkét csapat ugyanabból a bajnokságból (pl. két Bundesliga-csapat): annak a bajnokságnak az átlaga,
 *  - két különböző bajnokság (pl. Bundesliga és 2. Bundesliga, vagy két ország a BL-ben): a két bajnoki átlag
 *    EGYENLŐ SÚLYÚ átlaga – mindkét csapat a saját bajnoksága szintjéről érkezik, és a mérkőzésen egyformán
 *    számít; a meccsszám szerinti súlyozás a nagyobb mintájú bajnokságot indokolatlanul előnyben részesítené.
 *    (Ismert korlát: a bajnokságok közti erőkülönbséget ez nem korrigálja – arra a modellnek nincs adata.)
 *  - csak az egyik csapatnak van elég bajnoki adata (pl. alsóbb osztályú, csak kupából ismert ellenfél):
 *    az ő bajnoksága,
 *  - egyiknek sincs: a meglévő viselkedés – a sorozat saját (rendes játékidős) eredményei.
 * Egy bajnokság akkor használható, ha legalább `MIN_BASELINE_MATCHES` rendes játékidős meccse ismert
 * (ugyanaz a küszöb, mint az elemzés „kevés liga-adat” jelzéséé).
 *
 * A hosszabbítással / tizenegyespárbajjal eldőlt meccsek (`regulation === false`) semmilyen átlagba nem
 * számítanak (lásd `computeLeagueAverages`).
 */
import type { League, LeagueAverages, MatchResult } from '../types';
import { competitionFormat } from '../competitionFormat';
import { computeLeagueAverages } from './stats';

export const MIN_BASELINE_MATCHES = 10;

export type BaselineSource = 'league' | 'teams_league' | 'teams_leagues_mixed' | 'competition';

export interface Baseline {
  averages: LeagueAverages;
  source: BaselineSource;
  /** a felhasznált bajnokság(ok) azonosítója */
  leagueIds: string[];
  /** emberi felirat (pl. „Bundesliga” vagy „Bundesliga + 2. Bundesliga”) */
  label: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Két bajnoki átlag egyenlő súlyú kombinációja (a meccsszám összeadódik – a minta mérete). */
export function combineAverages(a: LeagueAverages, b: LeagueAverages): LeagueAverages {
  return {
    leagueId: `${a.leagueId}+${b.leagueId}`,
    matches: a.matches + b.matches,
    avgHomeGoals: round2((a.avgHomeGoals + b.avgHomeGoals) / 2),
    avgAwayGoals: round2((a.avgAwayGoals + b.avgAwayGoals) / 2),
    avgTotalGoals: round2((a.avgTotalGoals + b.avgTotalGoals) / 2),
    homeWinPct: round1((a.homeWinPct + b.homeWinPct) / 2),
    drawPct: round1((a.drawPct + b.drawPct) / 2),
    awayWinPct: round1((a.awayWinPct + b.awayWinPct) / 2),
    over25Pct: round1((a.over25Pct + b.over25Pct) / 2),
    bttsPct: round1((a.bttsPct + b.bttsPct) / 2),
  };
}

export function chooseBaseline(inp: {
  league: League;
  /** a két csapat elsődleges sorozata (a csapat `leagueId`-ja szerint), ha ismert */
  teamLeagues?: { home: League | null; away: League | null };
  results: MatchResult[];
  before?: string;
}): Baseline {
  const { league, results, before } = inp;
  const own = computeLeagueAverages(league.id, results, before);
  if (competitionFormat(league) === 'league') return { averages: own, source: 'league', leagueIds: [league.id], label: league.name };

  const candidates: League[] = [];
  for (const l of [inp.teamLeagues?.home, inp.teamLeagues?.away]) {
    if (l && l.id !== league.id && competitionFormat(l) === 'league' && !candidates.some((c) => c.id === l.id)) candidates.push(l);
  }
  const usable = candidates
    .map((l) => ({ l, avg: computeLeagueAverages(l.id, results, before) }))
    .filter((x) => x.avg.matches >= MIN_BASELINE_MATCHES);

  if (usable.length === 0) return { averages: own, source: 'competition', leagueIds: [league.id], label: league.name };
  if (usable.length === 1) return { averages: usable[0].avg, source: 'teams_league', leagueIds: [usable[0].l.id], label: usable[0].l.name };
  const [a, b] = usable;
  return {
    averages: combineAverages(a.avg, b.avg),
    source: 'teams_leagues_mixed',
    leagueIds: [a.l.id, b.l.id],
    label: `${a.l.name} + ${b.l.name}`,
  };
}
