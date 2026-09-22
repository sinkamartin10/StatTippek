/**
 * Tippgenerátor: a modell és a historikus statisztikák alapján lehetséges piacokat javasol
 * három kockázati kategóriában. Minden javaslathoz mellette/ellene szóló érveket és kockázatokat ad.
 * A javaslatok NEM ösztönöznek tétemelésre; csak elemzési kiindulópontok.
 */
import type {
  FormSummary,
  H2HSummary,
  LeagueAverages,
  MatchOdds,
  PoissonResult,
  ResearchResult,
  StandingRow,
  Team,
  TipCategory,
  TipSuggestion,
  XgModelResult,
} from '../types';
import { marketLabel } from './markets';
import { marketProbability } from './models';
import { impliedProbability } from './evaluation';

export interface TipContext {
  homeTeam: Team;
  awayTeam: Team;
  poisson: PoissonResult;
  xg: XgModelResult;
  homeLast10: FormSummary;
  awayLast10: FormSummary;
  homeAtHome: FormSummary;
  awayAtAway: FormSummary;
  h2h: H2HSummary;
  league: LeagueAverages;
  odds: MatchOdds | null;
  research: ResearchResult;
  standings: { home: StandingRow | null; away: StandingRow | null; total: number };
}

const p100 = (x: number) => `${Math.round(x * 100)}%`;
const f1 = (x: number) => x.toFixed(2).replace('.', ',');

interface Indicator { ok: boolean; text: string }

/** Statisztikai mutatók egy piachoz – a "támogató mutatók" száma ebből jön. */
function indicatorsFor(market: string, c: TipContext): Indicator[] {
  const { homeLast10: h, awayLast10: a, homeAtHome: hh, awayAtAway: aa, h2h, league, xg, homeTeam, awayTeam } = c;
  const h2hOk = h2h.sampleSize >= 3;
  const ind: Indicator[] = [];
  const push = (ok: boolean, text: string) => ind.push({ ok, text });

  const goalLine = market.match(/^([OU])(\d\.5)$/);
  if (goalLine) {
    const over = goalLine[1] === 'O';
    const line = parseFloat(goalLine[2]);
    const key = (`${over ? 'over' : 'under'}${String(line).replace('.', '')}`) as keyof FormSummary;
    const hv = (h as any)[key] as number | undefined;
    const av = (a as any)[key] as number | undefined;
    if (hv != null) push(hv >= 60, `${homeTeam.shortName} utolsó ${h.sampleSize} meccsén ${over ? 'több' : 'kevesebb'} mint ${goalLine[2].replace('.', ',')} gól: ${hv}%`);
    if (av != null) push(av >= 60, `${awayTeam.shortName} utolsó ${a.sampleSize} meccsén ${over ? 'több' : 'kevesebb'} mint ${goalLine[2].replace('.', ',')} gól: ${av}%`);
    if (line === 2.5) push(over ? league.over25Pct >= 52 : league.over25Pct <= 48, `Liga-átlag: a meccsek ${league.over25Pct}%-án esett több mint 2,5 gól`);
    if (h2hOk && line === 2.5) push(over ? h2h.over25Pct >= 55 : h2h.over25Pct <= 45, `Egymás elleni (${h2h.sampleSize} meccs): több mint 2,5 gól ${h2h.over25Pct}%`);
    push(over ? xg.totalExpected >= line + 0.3 : xg.totalExpected <= line - 0.3, `Modell összes várható gól: ${f1(xg.totalExpected)}`);
    return ind;
  }
  if (market === 'BTTS_Y' || market === 'BTTS_N') {
    const yes = market === 'BTTS_Y';
    push(yes ? h.btts >= 60 : h.btts <= 40, `${homeTeam.shortName}: mindkét csapat gólt szerzett az utolsó ${h.sampleSize} meccs ${h.btts}%-án`);
    push(yes ? a.btts >= 60 : a.btts <= 40, `${awayTeam.shortName}: mindkét csapat gólt szerzett az utolsó ${a.sampleSize} meccs ${a.btts}%-án`);
    if (h2hOk) push(yes ? h2h.bttsPct >= 55 : h2h.bttsPct <= 45, `Egymás elleni: BTTS ${h2h.bttsPct}%`);
    push(yes ? Math.min(xg.homeExpected, xg.awayExpected) >= 1.1 : Math.min(xg.homeExpected, xg.awayExpected) <= 0.8, `Alacsonyabb várható gól: ${f1(Math.min(xg.homeExpected, xg.awayExpected))}`);
    push(yes ? hh.cleanSheets / Math.max(1, hh.sampleSize) <= 0.3 : hh.cleanSheets / Math.max(1, hh.sampleSize) >= 0.4, `${homeTeam.shortName} kapott gól nélküli hazai meccsei: ${hh.cleanSheets}/${hh.sampleSize}`);
    return ind;
  }
  if (['1', '1X', 'DNB_1', 'AH_HOME_-1', 'HOME_O0.5', 'HOME_O1.5'].includes(market)) {
    push(hh.points / Math.max(1, hh.sampleSize) >= 1.8, `${homeTeam.shortName} hazai pályán: ${hh.wins}Gy ${hh.draws}D ${hh.losses}V (${hh.sampleSize} meccs)`);
    push(h.points >= a.points + 4, `Forma (utolsó ${h.sampleSize}/${a.sampleSize}): ${h.points} vs ${a.points} pont`);
    push(xg.homeExpected - xg.awayExpected >= 0.5, `Várható gólkülönbség a hazai javára: ${f1(xg.homeExpected - xg.awayExpected)}`);
    if (c.standings.home && c.standings.away) push(c.standings.home.position < c.standings.away.position, `Tabella: ${c.standings.home.position}. vs ${c.standings.away.position}. hely`);
    if (h2hOk) push(h2h.homeTeamWins > h2h.awayTeamWins, `Egymás elleni: ${h2h.homeTeamWins}–${h2h.draws}–${h2h.awayTeamWins} (hazai csapat–döntetlen–vendég csapat)`);
    if (market.startsWith('HOME_O')) push(hh.avgGoalsFor >= (market === 'HOME_O1.5' ? 1.8 : 1.2), `${homeTeam.shortName} hazai gólátlag: ${f1(hh.avgGoalsFor)}`);
    return ind;
  }
  if (['2', 'X2', 'DNB_2', 'AWAY_O0.5', 'AWAY_O1.5'].includes(market)) {
    push(aa.points / Math.max(1, aa.sampleSize) >= 1.8, `${awayTeam.shortName} idegenben: ${aa.wins}Gy ${aa.draws}D ${aa.losses}V (${aa.sampleSize} meccs)`);
    push(a.points >= h.points + 4, `Forma (utolsó ${h.sampleSize}/${a.sampleSize}): ${h.points} vs ${a.points} pont`);
    push(xg.awayExpected - xg.homeExpected >= 0.5, `Várható gólkülönbség a vendég javára: ${f1(xg.awayExpected - xg.homeExpected)}`);
    if (c.standings.home && c.standings.away) push(c.standings.away.position < c.standings.home.position, `Tabella: ${c.standings.home.position}. vs ${c.standings.away.position}. hely`);
    if (h2hOk) push(h2h.awayTeamWins > h2h.homeTeamWins, `Egymás elleni: ${h2h.homeTeamWins}–${h2h.draws}–${h2h.awayTeamWins}`);
    if (market.startsWith('AWAY_O')) push(aa.avgGoalsFor >= (market === 'AWAY_O1.5' ? 1.8 : 1.2), `${awayTeam.shortName} idegenbeli gólátlag: ${f1(aa.avgGoalsFor)}`);
    return ind;
  }
  if (market === 'X' || market === '12') {
    push(Math.abs(xg.homeExpected - xg.awayExpected) < 0.3, `Várható gólok közel azonosak: ${f1(xg.homeExpected)} – ${f1(xg.awayExpected)}`);
    push((h.draws + a.draws) / Math.max(1, h.sampleSize + a.sampleSize) >= 0.3, `Döntetlen-arány a két csapatnál: ${h.draws + a.draws}/${h.sampleSize + a.sampleSize}`);
    push(league.drawPct >= 26, `Liga döntetlen-arány: ${league.drawPct}%`);
    return ind;
  }
  if (market.startsWith('CS_')) {
    push(true, `A Poisson-modell szerint ez az egyik legvalószínűbb pontos eredmény`);
    push(xg.totalExpected < 3, `Összes várható gól: ${f1(xg.totalExpected)} (alacsonyabb gólvárakozásnál koncentráltabb az eloszlás)`);
    return ind;
  }
  return ind;
}

function genericRisks(c: TipContext): string[] {
  const risks: string[] = [];
  const { research } = c;
  const hAv = research.availability.home;
  const aAv = research.availability.away;
  if (hAv.lineupStatus !== 'megerősített' || aAv.lineupStatus !== 'megerősített') risks.push('A kezdőcsapatok nem megerősítettek – a felállás megváltoztathatja a modell alapjait.');
  if (hAv.injuries.length + hAv.suspensions.length > 0) risks.push(`${c.homeTeam.shortName}: ${hAv.injuries.length} sérült, ${hAv.suspensions.length} eltiltott játékos (a modell ezt nem számszerűsíti).`);
  if (aAv.injuries.length + aAv.suspensions.length > 0) risks.push(`${c.awayTeam.shortName}: ${aAv.injuries.length} sérült, ${aAv.suspensions.length} eltiltott játékos (a modell ezt nem számszerűsíti).`);
  if (hAv.midweekEuropeanMatch || aAv.midweekEuropeanMatch) risks.push('Hét közbeni nemzetközi mérkőzés – fáradtság és rotáció kockázata.');
  if (c.homeAtHome.sampleSize < 6 || c.awayAtAway.sampleSize < 6) risks.push('Kis hazai/idegen minta – a várható gól becslés bizonytalanabb.');
  if (research.warnings.length) risks.push(...research.warnings);
  return risks;
}

function buildTip(market: string, category: TipCategory, c: TipContext): TipSuggestion | null {
  const prob = marketProbability(c.poisson, market);
  if (prob == null) return null;
  const ind = indicatorsFor(market, c);
  const supporting = ind.filter((i) => i.ok);
  const against = ind.filter((i) => !i.ok);
  const o = c.odds?.markets[market] ?? null;
  const implied = o ? impliedProbability(o) : null;
  const diff = implied != null ? Math.round((prob - implied) * 10000) / 100 : null;

  const reasonsFor = supporting.map((i) => i.text);
  reasonsFor.unshift(`Modell-becslés: ${p100(prob)} (Poisson, λ=${f1(c.xg.homeExpected)} / ${f1(c.xg.awayExpected)})`);
  const reasonsAgainst = against.map((i) => `Nem támogatja: ${i.text}`);
  if (diff != null && diff < 0) reasonsAgainst.push(`Az odds implikált valószínűsége (${p100(implied!)}) magasabb a modellnél – negatív modellkülönbség.`);
  if (prob < 0.5 && category !== 'magas variancia') reasonsAgainst.push('A modell szerint 50% alatti esély.');

  return {
    id: `${market}`,
    category,
    market,
    label: marketLabel(market),
    modelProb: prob,
    odds: o,
    impliedProb: implied,
    diffPoints: diff,
    supportingStats: ind.map((i) => `${i.ok ? '✔' : '✘'} ${i.text}`),
    reasonsFor,
    reasonsAgainst,
    risks: genericRisks(c),
    supportingIndicators: supporting.length,
    sampleSize: c.homeLast10.sampleSize + c.awayLast10.sampleSize,
  };
}

export function generateTips(c: TipContext): TipSuggestion[] {
  const p = c.poisson;
  const tips: TipSuggestion[] = [];
  const add = (market: string, cat: TipCategory) => {
    if (tips.some((t) => t.market === market)) return;
    const t = buildTip(market, cat, c);
    if (t) tips.push(t);
  };

  const homeFav = p.homeWin >= p.awayWin;

  // Konzervatív: magas modell-valószínűségű, alacsony varianciájú piacok
  add('O1.5', 'konzervatív');
  add(homeFav ? '1X' : 'X2', 'konzervatív');
  add(homeFav ? 'HOME_O0.5' : 'AWAY_O0.5', 'konzervatív');
  if (Math.max(p.drawNoBet.home, p.drawNoBet.away) >= 0.6) add(homeFav ? 'DNB_1' : 'DNB_2', 'konzervatív');

  // Mérsékelt
  add(p.over['2.5'] >= 0.5 ? 'O2.5' : 'U2.5', 'mérsékelt');
  add(p.bttsYes >= 0.5 ? 'BTTS_Y' : 'BTTS_N', 'mérsékelt');
  if (Math.max(p.homeWin, p.awayWin) >= 0.45) add(homeFav ? '1' : '2', 'mérsékelt');
  else add(homeFav ? 'DNB_1' : 'DNB_2', 'mérsékelt');

  // Magas variancia
  for (const cs of p.correctScores.slice(0, 2)) {
    const [h, a] = cs.score.split('–');
    add(`CS_${h}-${a}`, 'magas variancia');
  }
  add(p.over['3.5'] >= 0.35 ? 'O3.5' : 'U1.5', 'magas variancia');
  add(homeFav ? 'HOME_O1.5' : 'AWAY_O1.5', 'magas variancia');
  if (p.asianHome1.win >= 0.3) add('AH_HOME_-1', 'magas variancia');
  if (p.draw >= 0.27) add('X', 'magas variancia');

  return tips;
}
