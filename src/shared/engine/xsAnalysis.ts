/**
 * PRO-kiszolgálás: elemzés a több ligás `xs-strength-1` modellből.
 *
 * Az alap elemzés (`analyzeMatch`, xg-poisson-1) LEÍRÓ részei maradnak (forma, tabella,
 * egymás elleni, hírek, odds, adatminőség), a VALÓSZÍNŰSÉGEK és a TIPPEK viszont a több ligás
 * modell (bizonytalansággal kevert) gólmátrixából jönnek – a meglévő tippgenerátorral és
 * értékelemzéssel, így a kimeneti formátum azonos.
 * Tiszta függvény: ugyanabból a bemenetből mindig ugyanaz jön ki.
 */
import type { MatchAnalysis, ServedModelInfo, XgModelResult } from '../types';
import { generateTips } from './tips';
import { computeValue } from './evaluation';
import { XS_MODEL_ID, XS_QUALITY_LABEL, type XsPrediction, type XsQuality } from './experimental/crossLeague';
import { hasLeagueTable } from '../competitionFormat';

export const XG_MODEL_INFO: ServedModelInfo = { id: 'xg-poisson-1', label: 'xG + Poisson (alap motor)' };
/** Az alap motor kupasorozatokra – külön motorverzió (lásd engine/version: CUP_ENGINE_VERSION). */
export const CUP_MODEL_INFO: ServedModelInfo = { id: 'xg-poisson-cup-1', label: 'xG + Poisson (alap motor, kupa-alapérték)' };

/** Az alap motor modell-azonosítója a sorozat szerint: bajnokság → xg-poisson-1, minden más → xg-poisson-cup-1. */
export const baseModelInfo = (league: Parameters<typeof hasLeagueTable>[0]): ServedModelInfo =>
  (hasLeagueTable(league) ? XG_MODEL_INFO : CUP_MODEL_INFO);
export const XS_MODEL_LABEL = 'Több ligás erősségmodell';

export interface XsFitMeta { fitId: string; cutoff: string; trainedMatches: number }

const f2 = (x: number) => x.toFixed(2).replace('.', ',');
const r2 = (x: number) => Math.round(x * 100) / 100;

/** A (keverék) gólmátrix várható gólszámai. */
function expectedGoals(m: number[][]): { home: number; away: number } {
  let home = 0, away = 0;
  m.forEach((row, h) => row.forEach((p, a) => { home += h * p; away += a * p; }));
  return { home, away };
}

export function buildXsAnalysis(base: MatchAnalysis, pred: XsPrediction, quality: { quality: XsQuality; reason: string }, fit: XsFitMeta): MatchAnalysis {
  const poisson = pred.poisson;
  const eg = expectedGoals(poisson.matrix);
  const groupLabel = (g: string) => (g.startsWith('csoport:') ? g.replace('csoport:', '').replace(/-/g, ' ') : g);
  const notes = [
    `Több ligás erősségmodell (${XS_MODEL_ID}): a csapatok erőssége az összes elérhető sorozatból (bajnokság, nemzetközi kupa, előző idények) becsült, a ligák szintkülönbségével korrigálva.`,
    `Adatminőség: ${XS_QUALITY_LABEL[quality.quality]} – ${quality.reason}`,
  ];
  // a tippgenerátor és a felület ugyanazt az xG-formát használja; az erősségek itt e^(log-erősség)
  const xg: XgModelResult = {
    homeExpected: r2(eg.home), awayExpected: r2(eg.away), totalExpected: r2(eg.home + eg.away),
    homeAttack: r2(Math.exp(pred.home.att)), homeDefense: r2(Math.exp(-pred.home.def)),
    awayAttack: r2(Math.exp(pred.away.att)), awayDefense: r2(Math.exp(-pred.away.def)),
    homeSample: pred.home.nRaw, awaySample: pred.away.nRaw, shrinkageK: 0, notes,
  };
  const tips = generateTips({
    homeTeam: base.homeTeam, awayTeam: base.awayTeam, poisson, xg,
    homeLast10: base.form.homeLast10, awayLast10: base.form.awayLast10, homeAtHome: base.form.homeAtHome, awayAtAway: base.form.awayAtAway,
    h2h: base.h2h, league: base.leagueAverages, odds: base.odds, research: base.research, standings: base.standings,
  });
  const model: ServedModelInfo = {
    id: XS_MODEL_ID, label: XS_MODEL_LABEL, quality: quality.quality, qualityLabel: XS_QUALITY_LABEL[quality.quality],
    qualityReason: quality.reason, sdLog: Math.round(pred.sdLog * 1000) / 1000, fitId: fit.fitId, fitCutoff: fit.cutoff, trainedMatches: fit.trainedMatches,
  };
  const oneXtwoFactors = [
    `Várható gólok (több ligás modell): ${base.homeTeam.shortName} ${f2(eg.home)} – ${base.awayTeam.shortName} ${f2(eg.away)}.`,
    `Erősség-csoport: ${base.homeTeam.shortName} – ${groupLabel(pred.home.group)} (${pred.home.nRaw} meccs a tanítóadatban), ${base.awayTeam.shortName} – ${groupLabel(pred.away.group)} (${pred.away.nRaw} meccs).`,
    ...notes,
    'A valószínűségek a becslés bizonytalanságát is tartalmazzák (kevés adatnál óvatosabbak).',
  ];
  const risks = [...base.risks];
  if (base.insufficientData) risks.unshift(`Az alap motor itt kevés adatot jelzett (${base.insufficientReasons.join(' ')}); a több ligás modell más sorozatok és idények adatait is felhasználja.`);
  if (quality.quality !== 'elegendo') risks.unshift(`${XS_QUALITY_LABEL[quality.quality]}: a becslés a szokásosnál bizonytalanabb.`);
  const methodology = [
    `Előrejelzés: ${XS_MODEL_ID} – hierarchikus, regularizált Poisson támadó/védekező erősség minden elérhető sorozatból (hazai bajnokság, BL/EL/KL, válogatott sorozatok, előző idények), időben súlyozva; a csapat a bajnoksága, a bajnokság a globális szint felé húzódik. A ligák közti szintet a nemzetközi és a ligák között mozgó csapatok meccsei becsülik.`,
    `Tanítóadat: ${fit.trainedMatches} lezárt meccs, a ${fit.cutoff} előtt legalább 3 órával kezdődöttek (jövőbeli adat nincs benne). Becslés-azonosító: ${fit.fitId.slice(0, 12)}.`,
    `Adatminőségi kategóriák és paraméterek: időrendi validációból (2024-25), egyszeri teszttel (2025-26) – lásd a modell-dokumentációt.`,
    ...base.methodology.filter((m) => !m.startsWith('Várható gól modell') && !m.startsWith('Poisson-modell')),
  ];
  return {
    ...base,
    insufficientData: false,
    insufficientReasons: [],
    xg,
    poisson,
    oneXtwoFactors,
    value: computeValue(poisson, base.odds),
    tips,
    risks,
    methodology,
    model,
  };
}
