/**
 * Elemzés-orchestrátor: a kutatómotor és az adatszolgáltató kimenetéből teljes MatchAnalysis-t állít elő.
 * Az összes számítás itt tiszta függvényekkel történik; a szerver csak adatot gyűjt és ezt hívja.
 */
import type { League, Match, MatchAnalysis, MatchOdds, MatchResult, ResearchResult, Team } from '../types';
import { computeForm, computeGoalMarkets, computeH2H, computeLeagueAverages, computeStandings } from './stats';
import { poissonModel, xgModel, type XgModelOptions } from './models';
import { computeConsensus, computeDataQuality, computeValue } from './evaluation';
import { generateTips } from './tips';

export interface AnalysisInput {
  match: Match;
  league: League;
  homeTeam: Team;
  awayTeam: Team;
  /** minden elérhető lejátszott meccs (bármely liga) – a motor szűri */
  results: MatchResult[];
  odds: MatchOdds | null;
  research: ResearchResult;
  now: string;
  modelOptions?: XgModelOptions;
  /** ha adott, a tabella csak az ettől kezdődő (aktuális idény) eredményekből épül */
  seasonStart?: string;
}

const f1 = (x: number) => x.toFixed(2).replace('.', ',');

export function analyzeMatch(inp: AnalysisInput): MatchAnalysis {
  const { match, league, homeTeam, awayTeam, results, odds, research, now } = inp;
  const before = match.status === 'finished' ? match.kickoff : undefined;
  const hId = homeTeam.id, aId = awayTeam.id;

  const homeLast5 = computeForm(hId, results, 5, 'összes', before);
  const homeLast10 = computeForm(hId, results, 10, 'összes', before);
  const awayLast5 = computeForm(aId, results, 5, 'összes', before);
  const awayLast10 = computeForm(aId, results, 10, 'összes', before);
  const homeAtHome = computeForm(hId, results, 10, 'hazai', before);
  const awayAtAway = computeForm(aId, results, 10, 'idegen', before);
  const h2h = computeH2H(hId, aId, results, 10, before);
  const standingsList = computeStandings(league.id, inp.seasonStart ? results.filter((r) => r.date >= inp.seasonStart!) : results, before);
  const standings = {
    home: standingsList.find((s) => s.teamId === hId) ?? null,
    away: standingsList.find((s) => s.teamId === aId) ?? null,
    total: standingsList.length,
  };
  const leagueAverages = computeLeagueAverages(league.id, results, before);
  const goalMarkets = computeGoalMarkets(homeLast10, awayLast10);

  const insufficientReasons: string[] = [];
  if (homeLast10.sampleSize < 3) insufficientReasons.push(`${homeTeam.name}: csak ${homeLast10.sampleSize} lejátszott meccs érhető el.`);
  if (awayLast10.sampleSize < 3) insufficientReasons.push(`${awayTeam.name}: csak ${awayLast10.sampleSize} lejátszott meccs érhető el.`);
  if (homeAtHome.sampleSize < 3) insufficientReasons.push(`${homeTeam.name}: kevesebb mint 3 hazai meccs – a hazai/idegen modell nem futtatható.`);
  if (awayAtAway.sampleSize < 3) insufficientReasons.push(`${awayTeam.name}: kevesebb mint 3 idegenbeli meccs – a hazai/idegen modell nem futtatható.`);
  if (leagueAverages.matches < 10) insufficientReasons.push(`A(z) ${league.name} bajnokságból kevesebb mint 10 lejátszott meccs áll rendelkezésre a liga-átlaghoz.`);

  const xg = xgModel(homeAtHome, awayAtAway, leagueAverages, inp.modelOptions);
  const poisson = xg ? poissonModel(xg.homeExpected, xg.awayExpected) : null;
  const insufficientData = !xg || insufficientReasons.length > 0;

  // Forma-értelmezés emberi nyelven
  const interpretation: string[] = [];
  const ppg = (f: typeof homeLast10) => (f.sampleSize ? (f.points / f.sampleSize).toFixed(2).replace('.', ',') : '–');
  interpretation.push(`${homeTeam.name} – utolsó ${homeLast10.sampleSize}: ${homeLast10.wins} győzelem, ${homeLast10.draws} döntetlen, ${homeLast10.losses} vereség (${ppg(homeLast10)} pont/meccs, gólátlag ${f1(homeLast10.avgGoalsFor)}–${f1(homeLast10.avgGoalsAgainst)}).`);
  interpretation.push(`${awayTeam.name} – utolsó ${awayLast10.sampleSize}: ${awayLast10.wins} győzelem, ${awayLast10.draws} döntetlen, ${awayLast10.losses} vereség (${ppg(awayLast10)} pont/meccs, gólátlag ${f1(awayLast10.avgGoalsFor)}–${f1(awayLast10.avgGoalsAgainst)}).`);
  if (homeLast10.sampleSize && awayLast10.sampleSize) {
    const diff = homeLast10.points - awayLast10.points;
    if (Math.abs(diff) >= 6) interpretation.push(`Statisztikailag jelentős formakülönbség: ${diff > 0 ? homeTeam.shortName : awayTeam.shortName} ${Math.abs(diff)} ponttal többet gyűjtött ugyanannyi meccsből.`);
    else if (Math.abs(diff) <= 2) interpretation.push('A két csapat formája hasonló – a forma önmagában nem ad egyértelmű irányt.');
    else interpretation.push(`Mérsékelt formaelőny: ${diff > 0 ? homeTeam.shortName : awayTeam.shortName} (+${Math.abs(diff)} pont).`);
  }
  if (homeAtHome.sampleSize >= 3) interpretation.push(`Hazai forma: ${homeTeam.shortName} hazai pályán ${homeAtHome.wins}–${homeAtHome.draws}–${homeAtHome.losses}, ${f1(homeAtHome.avgGoalsFor)} lőtt / ${f1(homeAtHome.avgGoalsAgainst)} kapott gól meccsenként.`);
  if (awayAtAway.sampleSize >= 3) interpretation.push(`Idegenbeli forma: ${awayTeam.shortName} idegenben ${awayAtAway.wins}–${awayAtAway.draws}–${awayAtAway.losses}, ${f1(awayAtAway.avgGoalsFor)} lőtt / ${f1(awayAtAway.avgGoalsAgainst)} kapott gól meccsenként.`);
  if (homeLast5.formString) interpretation.push(`Utolsó 5 (legfrissebb elöl): ${homeTeam.shortName} ${homeLast5.formString} · ${awayTeam.shortName} ${awayLast5.formString}.`);

  // 1X2 fő tényezők
  const oneXtwoFactors: string[] = [];
  if (xg && poisson) {
    oneXtwoFactors.push(`Várható gólok: ${homeTeam.shortName} ${f1(xg.homeExpected)} – ${awayTeam.shortName} ${f1(xg.awayExpected)} (hazai támadóerő ${f1(xg.homeAttack)}, vendég védőerő ${f1(xg.awayDefense)}).`);
    oneXtwoFactors.push(`Liga-átlag: hazai győzelem ${leagueAverages.homeWinPct}%, döntetlen ${leagueAverages.drawPct}%, vendég ${leagueAverages.awayWinPct}% (${leagueAverages.matches} meccs) – a hazai pálya előnye a liga-átlagon keresztül épül be.`);
    if (standings.home && standings.away) oneXtwoFactors.push(`Tabella: ${homeTeam.shortName} ${standings.home.position}. (${standings.home.points} pont), ${awayTeam.shortName} ${standings.away.position}. (${standings.away.points} pont) ${standings.total} csapatból.`);
    if (h2h.sampleSize >= 3) oneXtwoFactors.push(`Egymás elleni (${h2h.sampleSize}): ${h2h.homeTeamWins} ${homeTeam.shortName}-győzelem, ${h2h.draws} döntetlen, ${h2h.awayTeamWins} ${awayTeam.shortName}-győzelem – tájékoztató jellegű, a modellbe nem számít be.`);
    oneXtwoFactors.push(...xg.notes);
    oneXtwoFactors.push('A Poisson-modell a döntetlent jellemzően enyhén alulbecsüli (a két csapat gólszáma a valóságban nem teljesen független).');
  }

  const value = computeValue(poisson, odds);
  const tips = xg && poisson
    ? generateTips({ homeTeam, awayTeam, poisson, xg, homeLast10, awayLast10, homeAtHome, awayAtAway, h2h, league: leagueAverages, odds, research, standings })
    : [];

  const allDates = [...results].map((r) => r.date).sort();
  const dataQuality = computeDataQuality({
    homeLast10, awayLast10, homeAtHome, awayAtAway,
    leagueMatches: leagueAverages.matches,
    research, odds,
    newestResultDate: allDates.length ? allDates[allDates.length - 1] : null,
    now,
  });
  const consensus = computeConsensus(research.externalPredictions);

  // Kockázatok: mi teheti tévessé az elemzést?
  const risks: string[] = [];
  risks.push('A modell kizárólag gólstatisztikákra épül; nem látja a játékosok minőségét, a taktikát és a motivációt.');
  if (match.importance === 'top' || match.importance === 'high') risks.push(`Kiemelt tét (${match.importanceReasons.join(', ')}) – az ilyen meccseken a historikus minták kevésbé megbízhatóak.`);
  if (research.availability.home.lineupStatus !== 'megerősített' || research.availability.away.lineupStatus !== 'megerősített') risks.push('Nincs megerősített kezdőcsapat – hiányzók módosíthatják a képet.');
  if (research.externalPredictions.length === 0) risks.push('Nem található külső előrejelzés az összehasonlításhoz.');
  if (consensus.disagreementNote) risks.push(consensus.disagreementNote);
  if (dataQuality.level === 'kevés') risks.push('Kevés ellenőrizhető adat – az elemzés bizonytalansága magas.');
  if (odds == null) risks.push('Nincs odds – nem vizsgálható, hogy a piac mennyire árazza a modell által jelzett esélyeket.');
  if (research.origin === 'demo') risks.push('DEMO ADAT: a hírek és külső tippek szemléltető célúak, nem valós források.');
  for (const [team, form] of [[homeTeam, homeLast10], [awayTeam, awayLast10]] as const) {
    const otherLeagues = new Set(results.filter((r) => (r.homeTeamId === team.id || r.awayTeamId === team.id) && r.leagueId !== league.id && form.matches.some((m) => m.date === r.date)).map((r) => r.leagueId));
    const lower = [...otherLeagues].filter((l) => /-(ch|l2|sb|b2)$/.test(l));
    if (lower.length) risks.push(`${team.shortName}: a historikus minta részben az előző idény másodosztályú meccseiből áll – a modell ezt nem súlyozza külön.`);
  }

  const methodology = [
    `Forma: az utolsó 5 és 10 mérkőzés (bármely sorozatban), külön hazai/idegen bontásban (utolsó 10 hazai, ill. idegenbeli meccs).`,
    `Gólpiaci mutatók: a két csapat historikus gyakoriságának egyszerű átlaga. Ez múltbeli statisztika, nem előrejelzés.`,
    `Várható gól modell: λ_hazai = (hazai lőtt gól/meccs hazai pályán ÷ liga hazai átlag) × (vendég kapott gól/meccs idegenben ÷ liga hazai átlag) × liga hazai átlag; λ_vendég tükörképe. Az erősségeket kis mintánál a semleges 1,0 felé zsugorítjuk: (n·x + k·1)/(n + k), k=${xg?.shrinkageK ?? inp.modelOptions?.shrinkageK ?? 3}.`,
    `Poisson-modell: mindkét csapat gólszáma független Poisson-eloszlás λ paraméterrel; a 0–8 gólos mátrixból számoljuk az 1X2, gólszám, BTTS, dupla esély, hendikep és pontos eredmény valószínűségeket.`,
    `Értékelemzés: implikált valószínűség = 1 ÷ odds (árrés nélkül). Különbség = modell − implikált, százalékpontban. ±3 pont felett/alatt „pozitív/negatív modellkülönbség”. Ez nem nyereségígéret.`,
    `Adatminőség: mintanagyság, források, csapatinformáció, felállás, odds és frissesség alapján számolt 0–100 pont. Nem nyerési esély.`,
    `Külső tippek: csak megjelenítjük és összevetjük őket; a konszenzus nem bizonyíték.`,
  ];

  return {
    match, league, homeTeam, awayTeam,
    origin: match.origin,
    generatedAt: now,
    insufficientData,
    insufficientReasons,
    form: { homeLast5, homeLast10, awayLast5, awayLast10, homeAtHome, awayAtAway, interpretation },
    h2h,
    standings,
    leagueAverages,
    goalMarkets,
    xg,
    poisson,
    oneXtwoFactors,
    odds,
    value,
    tips,
    dataQuality,
    research,
    consensus,
    risks,
    methodology,
  };
}
