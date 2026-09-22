/**
 * DEMO ADAT generátor.
 * Determinisztikus (rögzített seed) mérkőzés-előzményeket, közelgő meccseket és demo oddsokat állít elő,
 * hogy a teljes felület külső szolgáltatás nélkül is tesztelhető legyen.
 * A dátumok a mai naphoz relatívak (így mindig vannak "mai meccsek"), az eredmények viszont mindig ugyanazok.
 * Minden itt keletkező rekord origin = 'demo'.
 */
import type { League, Match, MatchImportance, MatchOdds, MatchResult, Team } from '../../../shared/types';
import { computeStandings } from '../../../shared/engine/stats';
import { poissonModel } from '../../../shared/engine/models';
import { CUP_PARTICIPANTS, DERBIES, EXTRA_CUP_TEAMS, LEAGUES, TEAMS, type DemoTeamDef } from './leagues';

/** mulberry32 – kicsi, determinisztikus PRNG */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function samplePoisson(lambda: number, rng: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/** Körmérkőzéses sorsolás (kör-módszer). Páratlan létszámnál egy csapat pihen. */
function roundRobin(ids: string[]): [string, string][][] {
  const teams = [...ids];
  if (teams.length % 2 === 1) teams.push('__bye__');
  const n = teams.length;
  const rounds: [string, string][][] = [];
  const homeCount = new Map<string, number>();
  for (let r = 0; r < n - 1; r++) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      let a = teams[i], b = teams[n - 1 - i];
      if (a === '__bye__' || b === '__bye__') continue;
      // Kiegyenlített hazai/vendég elosztás: az kapja a pályaválasztást, akinek eddig kevesebb hazai meccse volt
      if ((homeCount.get(a) ?? 0) > (homeCount.get(b) ?? 0)) [a, b] = [b, a];
      homeCount.set(a, (homeCount.get(a) ?? 0) + 1);
      pairs.push([a, b]);
    }
    rounds.push(pairs);
    teams.splice(1, 0, teams.pop()!);
  }
  return rounds;
}

const HOME_BASE = 1.45; // demo liga: átlag hazai gól
const AWAY_BASE = 1.15; // demo liga: átlag vendég gól

export interface DemoDataset {
  leagues: League[];
  teams: Team[];
  matches: Match[];
  results: MatchResult[];
  odds: Map<string, MatchOdds>;
  /** a generátor "valódi" λ-i – csak a demo odds és a demo külső tippek előállításához */
  trueLambda: Map<string, [number, number]>;
  generatedFor: string;
}

function toTeam(d: DemoTeamDef): Team {
  return { id: d.id, name: d.name, shortName: d.shortName, country: d.country, leagueId: d.leagueId };
}

function dayAt(base: Date, dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function importanceFor(
  home: string,
  away: string,
  league: League,
  standings: ReturnType<typeof computeStandings>,
): { importance: MatchImportance; reasons: string[] } {
  const reasons: string[] = [];
  const derby = DERBIES.find(([a, b]) => (a === home && b === away) || (a === away && b === home));
  if (derby) reasons.push(derby[2]);
  const pos = (id: string) => standings.find((s) => s.teamId === id)?.position ?? 99;
  const n = standings.length;
  const ph = pos(home), pa = pos(away);
  if (league.international) reasons.push('Nemzetközi kupamérkőzés');
  if (!league.international && n >= 8) {
    if (ph <= 3 && pa <= 3) reasons.push('Éllovasok rangadója');
    else if (ph <= 6 && pa <= 6) reasons.push('Nemzetközi kupaindulásért folyó harc');
    if (ph >= n - 2 && pa >= n - 2) reasons.push('Kiesés elleni harc');
    else if (ph >= n - 2 || pa >= n - 2) reasons.push('Az egyik csapat kiesőhelyen áll');
  }
  let importance: MatchImportance = league.tier === 2 ? 'low' : 'normal';
  if (reasons.some((r) => r.includes('rangadó') || r.includes('derbi') || r.includes('Clásico') || r.includes('Klassiker') || r.includes('Classique') || r.includes('Derby') || r.includes('Tráfico'))) importance = 'top';
  else if (reasons.length) importance = 'high';
  return { importance, reasons };
}

function demoOdds(matchId: string, lh: number, la: number, rng: () => number, now: string): MatchOdds {
  const p = poissonModel(lh, la);
  const margin = 1.06; // demo árrés
  const o = (prob: number) => Math.max(1.01, Math.round((1 / (Math.min(0.97, prob) * margin)) * (1 + (rng() - 0.5) * 0.04) * 100) / 100);
  return {
    matchId,
    source: 'demo',
    bookmaker: 'DEMO fogadóiroda',
    retrievedAt: now,
    markets: {
      '1': o(p.homeWin), X: o(p.draw), '2': o(p.awayWin),
      '1X': o(p.doubleChance['1X']), X2: o(p.doubleChance.X2), '12': o(p.doubleChance['12']),
      'O1.5': o(p.over['1.5']), 'O2.5': o(p.over['2.5']), 'O3.5': o(p.over['3.5']),
      'U1.5': o(p.under['1.5']), 'U2.5': o(p.under['2.5']), 'U3.5': o(p.under['3.5']),
      BTTS_Y: o(p.bttsYes), BTTS_N: o(p.bttsNo),
      DNB_1: o(p.drawNoBet.home), DNB_2: o(p.drawNoBet.away),
    },
  };
}

export function buildDemoDataset(nowDate = new Date()): DemoDataset {
  const now = nowDate.toISOString();
  const allDefs = [...TEAMS, ...EXTRA_CUP_TEAMS];
  const defById = new Map(allDefs.map((d) => [d.id, d]));
  const teams = allDefs.map(toTeam);
  const results: MatchResult[] = [];
  const matches: Match[] = [];
  const odds = new Map<string, MatchOdds>();
  const trueLambda = new Map<string, [number, number]>();

  const lambdas = (h: string, a: string): [number, number] => {
    const H = defById.get(h)!, A = defById.get(a)!;
    return [HOME_BASE * H.attack * A.defense, AWAY_BASE * A.attack * H.defense];
  };

  for (const league of LEAGUES) {
    const rng = makeRng(hashString('demo-' + league.id));
    const ids = league.international
      ? CUP_PARTICIPANTS[league.id]
      : TEAMS.filter((t) => t.leagueId === league.id).map((t) => t.id);
    let rounds = roundRobin(ids);
    // Kupáknál kevesebb fordulót játszunk, keverve
    const pastRounds = league.international ? 5 : 12;
    if (league.international) rounds = rounds.sort(() => rng() - 0.5);

    // Múltbeli fordulók: hetente visszafelé, egy forduló 2 napra (szombat/vasárnap jelleg) szétosztva
    for (let r = 0; r < pastRounds; r++) {
      const round = rounds[r % rounds.length];
      const weeksAgo = pastRounds - r;
      round.forEach(([h, a], i) => {
        const dayOffset = -7 * weeksAgo + (i % 2) + (league.international ? -3 : 0);
        const date = dayAt(nowDate, dayOffset, 15 + (i % 3) * 2, 0);
        const [lh, la] = lambdas(h, a);
        const hg = samplePoisson(lh, rng), ag = samplePoisson(la, rng);
        let hth = 0, hta = 0;
        for (let g = 0; g < hg; g++) if (rng() < 0.44) hth++;
        for (let g = 0; g < ag; g++) if (rng() < 0.44) hta++;
        const id = `demo-${league.id}-r${r + 1}-${i + 1}`;
        results.push({ id, leagueId: league.id, date: date.toISOString(), homeTeamId: h, awayTeamId: a, homeGoals: hg, awayGoals: ag, htHomeGoals: hth, htAwayGoals: hta, origin: 'demo' });
        matches.push({ id, leagueId: league.id, homeTeamId: h, awayTeamId: a, kickoff: date.toISOString(), status: 'finished', round: `${r + 1}. forduló`, importance: 'normal', importanceReasons: [], homeGoals: hg, awayGoals: ag, origin: 'demo' });
        // Az utolsó két lejátszott fordulóhoz is készül demo odds, hogy az előzmény-követő ROI-t tudjon mutatni
        if (r >= pastRounds - 2) {
          trueLambda.set(id, [lh, la]);
          odds.set(id, demoOdds(id, lh, la, makeRng(hashString(id)), now));
        }
      });
    }

    // Közelgő fordulók: ma, holnap, holnapután
    const standings = computeStandings(league.id, results);
    const upcomingRounds = 2;
    for (let u = 0; u < upcomingRounds; u++) {
      const round = rounds[(pastRounds + u) % rounds.length];
      round.forEach(([h, a], i) => {
        let date: Date;
        if (u === 0) {
          // Ma: a mostani időponttól számítva 1–7 órán belüli kezdések, hogy mindig legyen "mai meccs"
          const start = new Date(nowDate);
          start.setMinutes(0, 0, 0);
          start.setHours(start.getHours() + 1 + (i % 6));
          date = start;
          if (i >= 6) date = dayAt(nowDate, 1, 13 + (i % 5) * 2, i % 2 ? 30 : 0);
        } else {
          date = dayAt(nowDate, 2 + (i % 2), 14 + (i % 4) * 2, i % 2 ? 30 : 0);
        }
        const id = `demo-${league.id}-r${pastRounds + u + 1}-${i + 1}`;
        const imp = importanceFor(h, a, league, standings);
        matches.push({ id, leagueId: league.id, homeTeamId: h, awayTeamId: a, kickoff: date.toISOString(), status: 'scheduled', round: `${pastRounds + u + 1}. forduló`, importance: imp.importance, importanceReasons: imp.reasons, origin: 'demo' });
        const [lh, la] = lambdas(h, a);
        trueLambda.set(id, [lh, la]);
        odds.set(id, demoOdds(id, lh, la, makeRng(hashString(id)), now));
      });
    }
  }

  return { leagues: LEAGUES, teams, matches, results, odds, trueLambda, generatedFor: nowDate.toDateString() };
}
