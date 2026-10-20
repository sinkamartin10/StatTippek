/**
 * AI-meccsszimulátor (mc-poisson-lognormal-1) – Monte Carlo szimuláció a meglévő elemzés várható góljaiból.
 *
 * Modell: a két csapat gólszáma Poisson-eloszlású, a λ paramétereket azonban NEM pontosan ismerjük –
 * szimulációnként log-normális bizonytalansággal mintázzuk őket (várható érték-őrző korrekcióval):
 *   λ' = λ · exp(σ·Z − σ²/2),  Z ~ N(0, 1),  majd  gól ~ Poisson(λ')
 * Ez a paraméter-bizonytalanságot is tartalmazó prediktív eloszlás (Poisson–lognormál keverék). σ = 0
 * esetén pontosan a meglévő analitikus Poisson-modellt adja vissza (ezt teszt ellenőrzi).
 *
 * σ forrása: a több ligás PRO-modellnél (xs-strength-1) a modell saját `sdLog` értéke; az alap motornál
 * a hazai/idegen mintából becsült standard hiba (kevés gól → nagyobb bizonytalanság), a liga-átlag felé
 * zsugorító pszeudo-meccsekkel – ugyanazzal a k-val, mint az xG-modell.
 *
 * Adatszivárgás nincs: a bemenet a meglévő elemzés, amely a meccs kezdete előtti eredményekből épül
 * (a PRO-modell tanítóadata a kezdés előtt lezárult meccsekre korlátozott). Determinisztikus: a mag a
 * meccsazonosítóból és a bemenetekből jön, így ugyanaz a bemenet mindig ugyanazt az eredményt adja.
 * A kimenet BECSLÉS, nem garantált valószínűség.
 */
import type { MatchAnalysis } from '../types';

export const SIM_MODEL_ID = 'mc-poisson-lognormal-1';
export const DEFAULT_SIMULATIONS = 10_000;
/** ennyi napnál régebbi legfrissebb eredmény → elavult adat */
export const STALE_AFTER_DAYS = 30;
const MAX_GOALS = 10;
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5] as const;

export interface SimulationInput {
  seedKey: string;
  homeLambda: number;
  awayLambda: number;
  sdHome: number;
  sdAway: number;
  n?: number;
}

export interface SimulationCore {
  n: number;
  seed: number;
  homeWin: number;
  draw: number;
  awayWin: number;
  expectedGoals: { home: number; away: number; total: number };
  overUnder: { line: number; over: number; under: number }[];
  btts: { yes: number; no: number };
  teamOver05: { home: number; away: number };
  topScores: { score: string; prob: number }[];
  /** az összgólszám 80%-os tartománya (10. és 90. percentilis) */
  totalGoals80: [number, number];
  /** a legnagyobb Monte Carlo standard hiba az 1X2 valószínűségeken (0–1) */
  standardError: number;
}

/** Mulberry32 – kicsi, determinisztikus PRNG (nem kriptográfiai). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32 bites hash – a mag a bemenetből. */
export function seedFrom(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function normal(rand: () => number): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Poisson-minta (Knuth); a λ itt legfeljebb néhány gól, így gyors és pontos. */
function poisson(lambda: number, rand: () => number): number {
  const l = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > l);
  return k - 1;
}

export function simulate(inp: SimulationInput): SimulationCore {
  const n = inp.n ?? DEFAULT_SIMULATIONS;
  const seed = seedFrom(`${inp.seedKey}|${inp.homeLambda}|${inp.awayLambda}|${inp.sdHome}|${inp.sdAway}|${n}`);
  const rand = mulberry32(seed);
  const cap = (x: number) => Math.min(8, Math.max(0.05, x));
  const draw = (lambda: number, sd: number) => (sd > 0 ? cap(lambda * Math.exp(sd * normal(rand) - (sd * sd) / 2)) : cap(lambda));

  let hw = 0, dr = 0, aw = 0, btts = 0, h0 = 0, a0 = 0, sumH = 0, sumA = 0;
  const totals = new Array(2 * MAX_GOALS + 1).fill(0);
  const scores = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const h = Math.min(MAX_GOALS, poisson(draw(inp.homeLambda, inp.sdHome), rand));
    const a = Math.min(MAX_GOALS, poisson(draw(inp.awayLambda, inp.sdAway), rand));
    if (h > a) hw++; else if (h === a) dr++; else aw++;
    if (h > 0 && a > 0) btts++;
    if (h > 0) h0++;
    if (a > 0) a0++;
    sumH += h; sumA += a;
    totals[h + a]++;
    const k = `${h}–${a}`;
    scores.set(k, (scores.get(k) ?? 0) + 1);
  }
  const quantile = (q: number) => { let c = 0; for (let g = 0; g < totals.length; g++) { c += totals[g]; if (c >= q * n) return g; } return totals.length - 1; };
  const p = (x: number) => x / n;
  const se = (x: number) => Math.sqrt((x * (1 - x)) / n);
  return {
    n, seed,
    homeWin: p(hw), draw: p(dr), awayWin: p(aw),
    expectedGoals: { home: sumH / n, away: sumA / n, total: (sumH + sumA) / n },
    overUnder: OU_LINES.map((line) => {
      const over = p(totals.reduce((s, c, g) => (g > line ? s + c : s), 0));
      return { line, over, under: 1 - over };
    }),
    btts: { yes: p(btts), no: 1 - p(btts) },
    teamOver05: { home: p(h0), away: p(a0) },
    topScores: [...scores.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 6).map(([score, c]) => ({ score, prob: p(c) })),
    totalGoals80: [quantile(0.1), quantile(0.9)],
    standardError: Math.max(se(p(hw)), se(p(dr)), se(p(aw))),
  };
}

/** Egész százalékok, amelyek összege pontosan 100 (legnagyobb maradék módszere). */
export function percentages100(ps: number[]): number[] {
  const raw = ps.map((x) => x * 100);
  const out = raw.map(Math.floor);
  let rest = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (rest <= 0) break; out[i]++; rest--; }
  return out;
}

// ---------------------------------------------------------------------------
// Elemzésből szimuláció: bemenet, frissesség, bizonytalanság, magyarázat
// ---------------------------------------------------------------------------

export type UncertaintyLevel = 'alacsony' | 'közepes' | 'magas';

export interface SimulationReport {
  matchId: string;
  simulator: typeof SIM_MODEL_ID;
  /** az elemzést előállító modell (xg-poisson-1 / xs-strength-1) */
  modelId: string;
  modelLabel: string;
  status: 'ok' | 'insufficient';
  /** insufficient esetén: miért nincs szám (nem találunk ki értéket) */
  reasons: string[];
  freshness: { generatedAt: string; newestResultDate: string | null; daysBeforeKickoff: number | null; stale: boolean };
  uncertainty: { level: UncertaintyLevel; reasons: string[] } | null;
  /** 1X2 valószínűség (0–1) és egész százalék (összege 100) */
  oneXTwo: { home: number; draw: number; away: number; pct: { home: number; draw: number; away: number } } | null;
  mostLikely: '1' | 'X' | '2' | null;
  /** a teljes eredmény – csak PRO; FREE előnézetben hiányzik */
  full?: SimulationFull;
}

export interface SimulationFull {
  n: number;
  seed: number;
  inputs: { homeLambda: number; awayLambda: number; sdHome: number; sdAway: number; sdSource: 'pro-model' | 'sample' };
  expectedGoals: SimulationCore['expectedGoals'];
  overUnder: SimulationCore['overUnder'];
  btts: SimulationCore['btts'];
  teamOver05: SimulationCore['teamOver05'];
  topScores: SimulationCore['topScores'];
  totalGoals80: [number, number];
  standardError: number;
  explanation: string[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const f2 = (x: number) => x.toFixed(2).replace('.', ',');
const pc = (x: number) => `${Math.round(x * 100)}%`;

/** A λ log-skálás bizonytalansága a hazai/idegen mintából (zsugorító pszeudo-meccsekkel). */
export function sampleSdLog(an: MatchAnalysis): { sdHome: number; sdAway: number } {
  const k = an.xg?.shrinkageK ?? 3;
  const lg = an.leagueAverages;
  const H = an.form.homeAtHome, A = an.form.awayAtAway;
  // várható gólszám-„információ”: lőtt/kapott gólok száma + k átlagos meccs
  const v = (n: number, perMatch: number, leaguePerMatch: number) => 1 / Math.max(1, n * perMatch + k * leaguePerMatch);
  const sdHome = Math.sqrt(v(H.sampleSize, H.avgGoalsFor, lg.avgHomeGoals) + v(A.sampleSize, A.avgGoalsAgainst, lg.avgHomeGoals));
  const sdAway = Math.sqrt(v(A.sampleSize, A.avgGoalsFor, lg.avgAwayGoals) + v(H.sampleSize, H.avgGoalsAgainst, lg.avgAwayGoals));
  return { sdHome: r3(sdHome), sdAway: r3(sdAway) };
}

function newestResult(an: MatchAnalysis): string | null {
  const dates = [an.form.homeLast10, an.form.awayLast10].flatMap((f) => f.matches.map((m) => m.date)).filter((d) => d && d < an.match.kickoff).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/** A teljes szimulációs riport egy (szűretlen, szerveroldali) elemzésből. */
export function buildSimulation(an: MatchAnalysis, n = DEFAULT_SIMULATIONS): SimulationReport {
  const modelId = an.model?.id ?? 'xg-poisson-1';
  const modelLabel = an.model?.label ?? 'Várható gól + Poisson (alap motor)';
  const newest = newestResult(an);
  const days = newest ? Math.floor((Date.parse(an.match.kickoff) - Date.parse(newest)) / 86_400_000) : null;
  const freshness = { generatedAt: an.generatedAt, newestResultDate: newest, daysBeforeKickoff: days, stale: days == null || days > STALE_AFTER_DAYS };
  const base = { matchId: an.match.id, simulator: SIM_MODEL_ID, modelId, modelLabel, freshness } as const;

  const reasons: string[] = [];
  if (an.insufficientData) reasons.push(...an.insufficientReasons);
  if (!an.xg) reasons.push('A várható gól modell nem futtatható (kevés hazai/idegen meccs vagy liga-adat).');
  if (an.match.status !== 'scheduled') reasons.push('A szimuláció csak még el nem kezdődött mérkőzésre készül.');
  if (reasons.length || !an.xg) {
    return { ...base, status: 'insufficient', reasons: [...new Set(reasons)], uncertainty: null, oneXTwo: null, mostLikely: null };
  }

  const xg = an.xg;
  const fromPro = modelId === 'xs-strength-1' && typeof an.model?.sdLog === 'number';
  const sd = fromPro ? { sdHome: an.model!.sdLog!, sdAway: an.model!.sdLog! } : sampleSdLog(an);
  const core = simulate({ seedKey: an.match.id, homeLambda: xg.homeExpected, awayLambda: xg.awayExpected, ...sd, n });

  // bizonytalanság: adatminőség, paraméter-bizonytalanság, minta, frissesség
  const uReasons: string[] = [];
  let score = 0;
  const sdMax = Math.max(sd.sdHome, sd.sdAway);
  if (an.dataQuality.level === 'kevés') { score += 2; uReasons.push('Az adatminőség alacsony.'); }
  else if (an.dataQuality.level === 'közepes') { score += 1; uReasons.push('Az adatminőség közepes.'); }
  if (sdMax > 0.35) { score += 2; uReasons.push(`Nagy paraméter-bizonytalanság (σ = ${f2(sdMax)}).`); }
  else if (sdMax > 0.22) { score += 1; uReasons.push(`Mérsékelt paraméter-bizonytalanság (σ = ${f2(sdMax)}).`); }
  const minSample = Math.min(an.form.homeAtHome.sampleSize, an.form.awayAtAway.sampleSize);
  if (minSample < 6) { score += 1; uReasons.push(`Kis hazai/idegen minta (${minSample} meccs).`); }
  if (freshness.stale) { score += 2; uReasons.push(newest ? `A legfrissebb eredmény ${days} nappal a kezdés előtti – elavult lehet.` : 'Nincs dátumozott friss eredmény.'); }
  if (an.model?.fallbackReason) uReasons.push(`Alap motor szolgál ki: ${an.model.fallbackReason}`);
  const level: UncertaintyLevel = score >= 3 ? 'magas' : score >= 1 ? 'közepes' : 'alacsony';
  if (!uReasons.length) uReasons.push('Elegendő, friss adat és kis paraméter-bizonytalanság.');

  const [ph, pd, pa] = percentages100([core.homeWin, core.draw, core.awayWin]);
  const best = Math.max(core.homeWin, core.draw, core.awayWin);
  const mostLikely = best === core.homeWin ? '1' : best === core.draw ? 'X' : '2';
  const H = an.homeTeam.shortName, A = an.awayTeam.shortName;

  const explanation = [
    `${n.toLocaleString('hu-HU')} szimuláció ${modelId === 'xs-strength-1' ? 'a több ligás PRO-modell' : 'az alap motor'} várható góljaiból: ${H} ${f2(xg.homeExpected)} – ${A} ${f2(xg.awayExpected)}.`,
    `Erősségek a liga-átlaghoz mérve: ${H} hazai támadás ${f2(xg.homeAttack)}×, ${A} idegenbeli védekezés ${f2(xg.awayDefense)}× (1,00 = liga-átlag; nagyobb védekezési érték = több kapott gól).`,
    `Minta: ${H} ${an.form.homeAtHome.sampleSize} hazai, ${A} ${an.form.awayAtAway.sampleSize} idegenbeli meccs; liga-átlag ${an.leagueAverages.matches} meccsből.`,
    `Legvalószínűbb kimenetel: ${mostLikely === '1' ? `${H}-győzelem` : mostLikely === 'X' ? 'döntetlen' : `${A}-győzelem`} (${pc(best)}); leggyakoribb pontos eredmény: ${core.topScores[0]?.score ?? '–'} (${pc(core.topScores[0]?.prob ?? 0)}).`,
    `Az összgólszám a szimulációk 80%-ában ${core.totalGoals80[0]} és ${core.totalGoals80[1]} között van.`,
    `A paraméter-bizonytalanság (σ ${f2(sd.sdHome)} / ${f2(sd.sdAway)}, forrás: ${fromPro ? 'a PRO-modell' : 'a mintanagyság'}) miatt az eredmény kissé eltérhet az elemzés analitikus Poisson-számaitól.`,
  ];

  return {
    ...base,
    status: 'ok',
    reasons: [],
    uncertainty: { level, reasons: uReasons },
    oneXTwo: { home: r3(core.homeWin), draw: r3(core.draw), away: r3(core.awayWin), pct: { home: ph, draw: pd, away: pa } },
    mostLikely,
    full: {
      n: core.n, seed: core.seed,
      inputs: { homeLambda: xg.homeExpected, awayLambda: xg.awayExpected, ...sd, sdSource: fromPro ? 'pro-model' : 'sample' },
      expectedGoals: { home: r3(core.expectedGoals.home), away: r3(core.expectedGoals.away), total: r3(core.expectedGoals.total) },
      overUnder: core.overUnder.map((o) => ({ line: o.line, over: r3(o.over), under: r3(o.under) })),
      btts: { yes: r3(core.btts.yes), no: r3(core.btts.no) },
      teamOver05: { home: r3(core.teamOver05.home), away: r3(core.teamOver05.away) },
      topScores: core.topScores.map((s) => ({ score: s.score, prob: r3(s.prob) })),
      totalGoals80: core.totalGoals80,
      standardError: r3(core.standardError),
      explanation,
    },
  };
}

/** FREE előnézet: csak az 1X2, a frissesség és a bizonytalanság – a teljes eredmény (`full`) NEM kerül bele. */
export function previewSimulation(r: SimulationReport): SimulationReport {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { full: _full, ...rest } = r;
  return rest;
}
