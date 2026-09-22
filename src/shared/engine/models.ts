/**
 * Előrejelző modellek:
 *  1. Várható gól (xG-jellegű) modell – támadó/védekező erősség a liga-átlaghoz viszonyítva.
 *  2. Poisson gólmodell – a várható gólokból teljes eredmény-eloszlás.
 *
 * Mindkettő átlátható és determinisztikus: ugyanabból a bemenetből mindig ugyanaz jön ki.
 * A kimenet BECSLÉS, nem garantált valószínűség – a felület ezt mindig jelzi.
 */
import type { FormSummary, LeagueAverages, PoissonResult, XgModelResult } from '../types';

export interface XgModelOptions {
  /** Bayes-i zsugorítás erőssége: hány "átlagos" meccset keverünk a mintához (alapértelmezés 3). */
  shrinkageK?: number;
  /** ennél kevesebb meccsnél nem futtatjuk a modellt (alapértelmezés 3) */
  minSample?: number;
}

/**
 * Várható gól modell.
 *
 * Képletek (H = hazai csapat hazai meccsei, A = vendég csapat idegenbeli meccsei):
 *   hazai támadóerő   = H átlag lőtt gól  / liga átlag hazai gól
 *   hazai védőerő     = H átlag kapott gól / liga átlag vendég gól
 *   vendég támadóerő  = A átlag lőtt gól  / liga átlag vendég gól
 *   vendég védőerő    = A átlag kapott gól / liga átlag hazai gól
 *   λ_hazai  = hazai támadóerő  × vendég védőerő × liga átlag hazai gól
 *   λ_vendég = vendég támadóerő × hazai védőerő  × liga átlag vendég gól
 *
 * Kis mintánál minden erősségmutatót a semleges 1.0 felé húzunk:
 *   erősség' = (n × erősség + k × 1) / (n + k)
 * így 2–3 meccs nem okoz szélsőséges becslést.
 */
export function xgModel(
  homeAtHome: FormSummary,
  awayAtAway: FormSummary,
  league: LeagueAverages,
  opts: XgModelOptions = {},
): XgModelResult | null {
  const k = opts.shrinkageK ?? 3;
  const minSample = opts.minSample ?? 3;
  const notes: string[] = [];

  if (homeAtHome.sampleSize < minSample || awayAtAway.sampleSize < minSample) {
    return null;
  }
  if (league.matches < 10 || league.avgHomeGoals <= 0 || league.avgAwayGoals <= 0) {
    return null;
  }

  const shrink = (raw: number, n: number) => (n * raw + k * 1) / (n + k);
  const nH = homeAtHome.sampleSize;
  const nA = awayAtAway.sampleSize;

  const homeAttack = shrink(homeAtHome.avgGoalsFor / league.avgHomeGoals, nH);
  const homeDefense = shrink(homeAtHome.avgGoalsAgainst / league.avgAwayGoals, nH);
  const awayAttack = shrink(awayAtAway.avgGoalsFor / league.avgAwayGoals, nA);
  const awayDefense = shrink(awayAtAway.avgGoalsAgainst / league.avgHomeGoals, nA);

  // Felső korlát: 4.5 gól/csapat – ennél nagyobb λ már nem értelmes ligameccsen
  const homeExpected = Math.min(4.5, homeAttack * awayDefense * league.avgHomeGoals);
  const awayExpected = Math.min(4.5, awayAttack * homeDefense * league.avgAwayGoals);

  if (nH < 6 || nA < 6) notes.push(`Kis minta (hazai: ${nH}, vendég: ${nA} meccs) – a becslés a liga-átlag felé van zsugorítva (k=${k}).`);
  if (homeAttack > 1.4) notes.push('A hazai csapat hazai támadóteljesítménye jóval liga-átlag feletti.');
  if (awayDefense > 1.3) notes.push('A vendég csapat idegenben az átlagnál több gólt kap.');
  if (awayAttack > 1.4) notes.push('A vendég csapat idegenbeli támadóteljesítménye jóval liga-átlag feletti.');
  if (homeDefense < 0.75) notes.push('A hazai védelem hazai pályán az átlagnál kevesebb gólt kap.');

  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    homeExpected: r2(homeExpected),
    awayExpected: r2(awayExpected),
    totalExpected: r2(homeExpected + awayExpected),
    homeAttack: r2(homeAttack),
    homeDefense: r2(homeDefense),
    awayAttack: r2(awayAttack),
    awayDefense: r2(awayDefense),
    homeSample: nH,
    awaySample: nA,
    shrinkageK: k,
    notes,
  };
}

/** Poisson valószínűség: P(X = k) = λ^k · e^(−λ) / k! */
export function poissonPmf(lambda: number, k: number): number {
  let logFact = 0;
  for (let i = 2; i <= k; i++) logFact += Math.log(i);
  return Math.exp(k * Math.log(lambda) - lambda - logFact);
}

/**
 * Poisson gólmodell. A két csapat gólszámát független Poisson-eloszlásúnak tekintjük
 * (ez a klasszikus Maher-féle egyszerűsítés; a döntetlenek enyhe alulbecslése ismert korlát).
 * A mátrix 0..maxGoals gólig tart; a maradék tömeg az utolsó cellákba kerül, hogy az összeg 1 legyen.
 */
export function poissonModel(homeLambda: number, awayLambda: number, maxGoals = 8): PoissonResult {
  const lh = Math.max(0.05, homeLambda);
  const la = Math.max(0.05, awayLambda);
  const hp: number[] = [];
  const ap: number[] = [];
  for (let i = 0; i <= maxGoals; i++) {
    hp.push(poissonPmf(lh, i));
    ap.push(poissonPmf(la, i));
  }
  // Maradék tömeg az utolsó cellába (>= maxGoals)
  hp[maxGoals] += Math.max(0, 1 - hp.reduce((a, b) => a + b, 0));
  ap[maxGoals] += Math.max(0, 1 - ap.reduce((a, b) => a + b, 0));

  const matrix: number[][] = [];
  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0;
  const totalDist: number[] = new Array(2 * maxGoals + 1).fill(0);
  let ahWin = 0, ahPush = 0, ahLose = 0;
  const scores: { score: string; prob: number }[] = [];

  for (let h = 0; h <= maxGoals; h++) {
    matrix.push([]);
    for (let a = 0; a <= maxGoals; a++) {
      const p = hp[h] * ap[a];
      matrix[h].push(p);
      if (h > a) homeWin += p; else if (h === a) draw += p; else awayWin += p;
      if (h > 0 && a > 0) bttsYes += p;
      totalDist[h + a] += p;
      const diff = h - a;
      if (diff > 1) ahWin += p; else if (diff === 1) ahPush += p; else ahLose += p;
      scores.push({ score: `${h}–${a}`, prob: p });
    }
  }

  const over: Record<string, number> = {};
  const under: Record<string, number> = {};
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    let o = 0;
    totalDist.forEach((p, g) => { if (g > line) o += p; });
    over[String(line)] = o;
    under[String(line)] = 1 - o;
  }

  const dist6 = (arr: number[]) => {
    const d = arr.slice(0, 5);
    d.push(arr.slice(5).reduce((a, b) => a + b, 0));
    return d;
  };
  const tail = (arr: number[], from: number) => arr.slice(from).reduce((a, b) => a + b, 0);

  scores.sort((x, y) => y.prob - x.prob);

  return {
    maxGoals,
    matrix,
    homeGoalDist: dist6(hp),
    awayGoalDist: dist6(ap),
    homeWin,
    draw,
    awayWin,
    over,
    under,
    bttsYes,
    bttsNo: 1 - bttsYes,
    homeOver05: tail(hp, 1),
    homeOver15: tail(hp, 2),
    awayOver05: tail(ap, 1),
    awayOver15: tail(ap, 2),
    doubleChance: { '1X': homeWin + draw, X2: draw + awayWin, '12': homeWin + awayWin },
    drawNoBet: { home: homeWin / (homeWin + awayWin), away: awayWin / (homeWin + awayWin) },
    asianHome1: { win: ahWin, push: ahPush, lose: ahLose },
    correctScores: scores.slice(0, 8),
  };
}

/** Egy piac modell-valószínűsége a Poisson-eredményből (0–1). Ismeretlen piacnál null. */
export function marketProbability(p: PoissonResult, market: string): number | null {
  switch (market) {
    case '1': return p.homeWin;
    case 'X': return p.draw;
    case '2': return p.awayWin;
    case '1X': return p.doubleChance['1X'];
    case 'X2': return p.doubleChance.X2;
    case '12': return p.doubleChance['12'];
    case 'DNB_1': return p.drawNoBet.home;
    case 'DNB_2': return p.drawNoBet.away;
    case 'BTTS_Y': return p.bttsYes;
    case 'BTTS_N': return p.bttsNo;
    case 'HOME_O0.5': return p.homeOver05;
    case 'HOME_O1.5': return p.homeOver15;
    case 'AWAY_O0.5': return p.awayOver05;
    case 'AWAY_O1.5': return p.awayOver15;
    case 'AH_HOME_-1': return p.asianHome1.win;
  }
  let m = market.match(/^O(\d\.5)$/);
  if (m) return p.over[m[1]] ?? null;
  m = market.match(/^U(\d\.5)$/);
  if (m) return p.under[m[1]] ?? null;
  m = market.match(/^CS_(\d+)-(\d+)$/);
  if (m) {
    const h = parseInt(m[1]), a = parseInt(m[2]);
    return p.matrix[h]?.[a] ?? null;
  }
  return null;
}
