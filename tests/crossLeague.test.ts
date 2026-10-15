/**
 * Kísérleti több ligás erősségmodell (`xs-strength-1`, csak árnyék) – tesztek.
 * Szintetikus, ismert „valóságból” generált adatokon ellenőrzi a ligaerősség
 * becslését, a csapatok sorozatokon átívelő összekapcsolását, a kis minták és a
 * hibás adatok kezelését, az időbeli szivárgás kizárását és az éles modell változatlanságát.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  INTL_ONLY_GROUP, NATIONAL_GROUP, XS_MODEL_ID, XS_MODEL_STATUS, assignGroups, fitCrossLeague, poissonResultFromMatrix,
  predictCrossLeague, qualityOf, type CompetitionKind, type XsMatch, type XsParams,
} from '../src/shared/engine/experimental/crossLeague';
import {
  brier1x2, calibration, ece, logLoss1x2, naiveProbs, pairedBootstrap, probsFromPoisson, rng, score,
} from '../src/shared/engine/experimental/crossLeagueEval';
import { poissonModel, xgModel } from '../src/shared/engine/models';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import type { FormSummary, LeagueAverages } from '../src/shared/types';

const KINDS: Record<string, CompetitionKind> = { erős: 'domestic', gyenge: 'domestic', kupa: 'club_intl', nl: 'national' };
const P: XsParams = { halfLifeDays: 365, sigmaTeam: 0.5, sigmaGroup: 0.35 };
const DAY = 86_400_000;
const iso = (d: number) => new Date(Date.UTC(2025, 0, 1) + d * DAY).toISOString();

/** Poisson-mintavétel (Knuth) rögzített magú generátorral. */
function poisson(lambda: number, r: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

/**
 * Két liga ismert erősséggel: „erős” (+0,3 támadás, +0,3 védekezés) és „gyenge” (−0,3, −0,3);
 * ligánként 8 csapat, oda-vissza körmérkőzés, plusz kupameccsek a két liga csapatai között.
 */
const TRUTH: { id: string; league: string; att: number; def: number }[] = [];
function synthetic(seed = 7, withCup = true): XsMatch[] {
  const r = rng(seed);
  const teams: { id: string; league: string; att: number; def: number }[] = [];
  TRUTH.length = 0;
  for (const [league, off] of [['erős', 0.3], ['gyenge', -0.3]] as const) {
    for (let i = 0; i < 8; i++) teams.push({ id: `${league}-${i}`, league, att: off + (i - 3.5) * 0.04, def: off + (3.5 - i) * 0.03 });
  }
  TRUTH.push(...teams);
  const out: XsMatch[] = [];
  let day = 0, n = 0;
  const play = (h: typeof teams[number], a: typeof teams[number], comp: string) => {
    const lh = Math.exp(0.1 + 0.25 + h.att - a.def), la = Math.exp(0.1 + a.att - h.def);
    out.push({ id: `m${n++}`, date: iso(day), competitionId: comp, homeTeamId: h.id, awayTeamId: a.id, homeGoals: poisson(lh, r), awayGoals: poisson(la, r) });
  };
  for (const league of ['erős', 'gyenge']) {
    const lt = teams.filter((t) => t.league === league);
    for (const h of lt) for (const a of lt) if (h !== a) { play(h, a, league); day += 1; }
  }
  if (withCup) {
    const strong = teams.filter((t) => t.league === 'erős'), weak = teams.filter((t) => t.league === 'gyenge');
    for (let rep = 0; rep < 3; rep++) for (let i = 0; i < 8; i++) { play(strong[i], weak[(i + rep) % 8], 'kupa'); play(weak[i], strong[(i + rep + 1) % 8], 'kupa'); day += 1; }
  }
  return out;
}
const cutoffAfter = (ms: XsMatch[]) => new Date(Math.max(...ms.map((m) => Date.parse(m.date))) + 2 * DAY).toISOString();

describe('xs-strength-1 – ligaerősség és több sorozat', () => {
  it('a kupameccsekből a ligák közti szintkülönbség helyes irányban és nagyságrendben becsülhető', () => {
    const ms = synthetic();
    const fit = fitCrossLeague(ms, KINDS, cutoffAfter(ms), P);
    const gap = (fit.groupAtt.get('erős')! - fit.groupAtt.get('gyenge')!) + (fit.groupDef.get('erős')! - fit.groupDef.get('gyenge')!);
    expect(gap).toBeGreaterThan(0.5); // valóság: 0,6 + 0,6 = 1,2 – a regularizáció lefelé húz, de az irány és a nagyság megvan
    expect(gap).toBeLessThan(1.6);
    expect(fit.sweeps).toBeLessThan(1000); // konvergált (nem a körlimit állította meg)
    // átlagosan egy erős ligás csapat esélyesebb egy gyenge ligás ellen, mint fordítva (minden párosításra)
    const strong = TRUTH.filter((t) => t.league === 'erős'), weak = TRUTH.filter((t) => t.league === 'gyenge');
    let sw = 0, ws = 0, k = 0;
    for (const a of strong) for (const b of weak) {
      sw += predictCrossLeague(fit, a.id, b.id, 'kupa', KINDS).poisson.homeWin;
      ws += predictCrossLeague(fit, b.id, a.id, 'kupa', KINDS).poisson.homeWin;
      k++;
    }
    expect(sw / k).toBeGreaterThan(ws / k + 0.15);
    // a becsült nettó csapaterősség (támadás + védekezés) erősen együtt mozog a valódival
    const est = TRUTH.map((t) => { const g = fit.groupOf.get(t.id)!; return fit.groupAtt.get(g)! + fit.att.get(t.id)! + fit.groupDef.get(g)! + fit.def.get(t.id)!; });
    const tru = TRUTH.map((t) => t.att + t.def);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const me = mean(est), mt = mean(tru);
    const cov = est.reduce((s, e, i) => s + (e - me) * (tru[i] - mt), 0);
    const corr = cov / Math.sqrt(est.reduce((s, e) => s + (e - me) ** 2, 0) * tru.reduce((s, t) => s + (t - mt) ** 2, 0));
    expect(corr).toBeGreaterThan(0.8);
  });

  it('kupameccsek NÉLKÜL a ligák nem köthetők össze: a csoportszintek a globális szint körül maradnak (nincs hamis pontosság)', () => {
    const ms = synthetic(7, false);
    const fit = fitCrossLeague(ms, KINDS, cutoffAfter(ms), P);
    expect(Math.abs(fit.groupAtt.get('erős')! - fit.groupAtt.get('gyenge')!)).toBeLessThan(0.15);
    // és a csoportszint bizonytalansága nagyobb, mint amikor a kupa összeköti őket
    const linked = fitCrossLeague(synthetic(), KINDS, cutoffAfter(synthetic()), P);
    expect(fit.groupAttVar.get('erős')!).toBeGreaterThan(linked.groupAttVar.get('erős')! * 0.99);
  });

  it('ugyanaz a csapat a bajnokságban és a kupában EGY erősséget kap; csoportja a hazai bajnoksága', () => {
    const ms = synthetic();
    const fit = fitCrossLeague(ms, KINDS, cutoffAfter(ms), P);
    const t = 'erős-0';
    const inLeague = ms.filter((m) => m.competitionId === 'erős' && (m.homeTeamId === t || m.awayTeamId === t)).length;
    const inCup = ms.filter((m) => m.competitionId === 'kupa' && (m.homeTeamId === t || m.awayTeamId === t)).length;
    expect(fit.nRaw.get(t)).toBe(inLeague + inCup);
    expect(fit.groupOf.get(t)).toBe('erős');
    expect([...fit.att.keys()].filter((k) => k === t)).toHaveLength(1);
  });

  it('csoport-hozzárendelés: hazai bajnokság nélkül „csak nemzetközi kupa”, válogatottnál „válogatott”', () => {
    const ms: XsMatch[] = [
      { id: '1', date: iso(0), competitionId: 'kupa', homeTeamId: 'K', awayTeamId: 'erős-0', homeGoals: 1, awayGoals: 1 },
      { id: '2', date: iso(1), competitionId: 'erős', homeTeamId: 'erős-0', awayTeamId: 'erős-1', homeGoals: 1, awayGoals: 0 },
      { id: '3', date: iso(2), competitionId: 'nl', homeTeamId: 'HUN', awayTeamId: 'GER', homeGoals: 0, awayGoals: 2 },
    ];
    const g = assignGroups(ms, KINDS, () => 1);
    expect(g.get('K')).toBe(INTL_ONLY_GROUP);
    expect(g.get('erős-0')).toBe('erős');
    expect(g.get('HUN')).toBe(NATIONAL_GROUP);
  });
});

describe('xs-strength-1 – kis minta, adathiány, hibás adat', () => {
  it('kevés meccs: a csapat a csoportátlag közelében marad, nagyobb bizonytalansággal; sok meccsnél kisebb a szórás', () => {
    const ms = synthetic();
    const extra: XsMatch[] = [{ id: 'új', date: iso(200), competitionId: 'erős', homeTeamId: 'ÚJ', awayTeamId: 'erős-3', homeGoals: 5, awayGoals: 0 }];
    const fit = fitCrossLeague([...ms, ...extra], KINDS, cutoffAfter([...ms, ...extra]), P);
    expect(Math.abs(fit.att.get('ÚJ')!)).toBeLessThan(0.5); // egy 5–0 nem tesz belőle szupercsapatot
    expect(fit.attVar.get('ÚJ')!).toBeGreaterThan(fit.attVar.get('erős-3')! * 2);
    const sparse = predictCrossLeague(fit, 'ÚJ', 'erős-2', 'erős', KINDS);
    const rich = predictCrossLeague(fit, 'erős-1', 'erős-2', 'erős', KINDS);
    expect(sparse.sdLog).toBeGreaterThan(rich.sdLog);
    // a nagyobb bizonytalanság a valószínűségeket is óvatosabbá (a középhez közelebbivé) teszi, mint a pontbecslés
    const point = poissonModel(sparse.lambdaHome, sparse.lambdaAway);
    expect(Math.abs(sparse.poisson.homeWin - sparse.poisson.awayWin)).toBeLessThan(Math.abs(point.homeWin - point.awayWin) + 1e-9);
  });

  it('adathiány ≠ gyengeség: ismeretlen csapat a csoportja átlagát kapja, és a kategória „elégtelen”', () => {
    const ms = synthetic();
    const fit = fitCrossLeague(ms, KINDS, cutoffAfter(ms), P);
    const p = predictCrossLeague(fit, 'SOHA-NEM-JÁTSZOTT', 'erős-2', 'erős', KINDS);
    expect(p.home.known).toBe(false);
    expect(p.home.group).toBe('erős');
    const groupOnly = Math.exp(fit.mu + fit.home + fit.groupAtt.get('erős')! - (fit.groupDef.get('erős')! + fit.def.get('erős-2')!));
    expect(p.lambdaHome).toBeCloseTo(groupOnly, 10);
    const q = qualityOf(p, { sdGood: 0.3, sdLimited: 0.4, sdMax: 0.9 });
    expect(q.quality).toBe('elegtelen');
    expect(q.reason).toMatch(/adathiány, nem gyengeség/);
  });

  it('kategóriák a megadott (validációból származó) küszöbök szerint', () => {
    const base = { home: { group: 'g', known: true, nEff: 5, nRaw: 5 }, away: { group: 'g', known: true, nEff: 5, nRaw: 5 } };
    const t = { sdGood: 0.3, sdLimited: 0.4, sdMax: 0.6 };
    expect(qualityOf({ ...base, sdLog: 0.2 }, t).quality).toBe('elegendo');
    expect(qualityOf({ ...base, sdLog: 0.35 }, t).quality).toBe('korlatozott');
    expect(qualityOf({ ...base, sdLog: 0.5 }, t).quality).toBe('keves_regularizalt');
    expect(qualityOf({ ...base, sdLog: 0.7 }, t).quality).toBe('elegtelen');
  });

  it('hiányzó vagy hibás adat: nem véges gólszám és önmaga elleni meccs kimarad, a becslés véges marad', () => {
    const ms = synthetic();
    const bad: XsMatch[] = [
      { id: 'b1', date: iso(10), competitionId: 'erős', homeTeamId: 'erős-0', awayTeamId: 'erős-1', homeGoals: NaN, awayGoals: 1 },
      { id: 'b2', date: iso(11), competitionId: 'erős', homeTeamId: 'erős-0', awayTeamId: 'erős-0', homeGoals: 3, awayGoals: 0 },
      { id: 'b3', date: iso(12), competitionId: 'ismeretlen-sorozat', homeTeamId: 'X1', awayTeamId: 'X2', homeGoals: 1, awayGoals: 1 },
    ];
    const fit = fitCrossLeague([...ms, ...bad], KINDS, cutoffAfter(ms), P);
    expect(fit.trainedMatches).toBe(ms.length + 1); // csak a b3 érvényes (ismeretlen sorozat → külön csoport)
    for (const v of [fit.mu, fit.home, ...fit.att.values(), ...fit.def.values()]) expect(Number.isFinite(v)).toBe(true);
    expect(fit.groupOf.get('X1')).toBe(INTL_ONLY_GROUP);
  });
});

describe('xs-strength-1 – időbeli szivárgás kizárása', () => {
  it('a cutoff előtt 3 órán belül kezdődött és a későbbi meccsek NEM befolyásolják a becslést', () => {
    const ms = synthetic();
    const cutoff = cutoffAfter(ms);
    const base = fitCrossLeague(ms, KINDS, cutoff, P);
    const c = Date.parse(cutoff);
    const future: XsMatch[] = [
      { id: 'f1', date: new Date(c - 2 * 3600_000).toISOString(), competitionId: 'erős', homeTeamId: 'erős-0', awayTeamId: 'erős-7', homeGoals: 9, awayGoals: 0 },
      { id: 'f2', date: new Date(c + DAY).toISOString(), competitionId: 'kupa', homeTeamId: 'gyenge-0', awayTeamId: 'erős-0', homeGoals: 9, awayGoals: 0 },
    ];
    const withFuture = fitCrossLeague([...ms, ...future], KINDS, cutoff, P);
    expect(withFuture.trainedMatches).toBe(base.trainedMatches);
    expect(withFuture.att.get('erős-0')).toBe(base.att.get('erős-0'));
    expect(predictCrossLeague(withFuture, 'erős-0', 'gyenge-0', 'kupa', KINDS).poisson.homeWin)
      .toBe(predictCrossLeague(base, 'erős-0', 'gyenge-0', 'kupa', KINDS).poisson.homeWin);
  });

  it('a melegindítás (előző becslés) nem változtatja meg az eredményt, csak a lépésszámot', () => {
    const ms = synthetic();
    const cutoff = cutoffAfter(ms);
    const cold = fitCrossLeague(ms, KINDS, cutoff, { ...P, tol: 1e-9, maxSweeps: 400 });
    const prev = fitCrossLeague(ms.slice(0, 150), KINDS, iso(160), P);
    const warm = fitCrossLeague(ms, KINDS, cutoff, { ...P, tol: 1e-9, maxSweeps: 400 }, { warm: prev });
    expect(warm.att.get('erős-5')!).toBeCloseTo(cold.att.get('erős-5')!, 5);
    expect(warm.mu).toBeCloseTo(cold.mu, 5);
  });
});

describe('Kimeneti formátum és összehasonlítás', () => {
  it('bizonytalanság nélkül a mátrixból képzett eredmény AZONOS az éles poissonModel kimenetével', () => {
    const ref = poissonModel(1.7, 1.1);
    const mine = poissonResultFromMatrix(ref.matrix);
    for (const k of ['homeWin', 'draw', 'awayWin', 'bttsYes', 'bttsNo', 'homeOver05', 'homeOver15', 'awayOver05', 'awayOver15'] as const) expect(mine[k]).toBeCloseTo(ref[k], 12);
    for (const l of ['0.5', '1.5', '2.5', '3.5', '4.5']) expect(mine.over[l]).toBeCloseTo(ref.over[l], 12);
    expect(mine.homeGoalDist.map((x) => +x.toFixed(12))).toEqual(ref.homeGoalDist.map((x) => +x.toFixed(12)));
    expect(mine.correctScores.map((s) => s.score)).toEqual(ref.correctScores.map((s) => s.score));
    expect(mine.asianHome1.win).toBeCloseTo(ref.asianHome1.win, 12);
  });

  it('pontozás: log loss, Brier, naiv alap, determinisztikus bootstrap, kalibráció', () => {
    const p = { p1: 0.5, pX: 0.3, p2: 0.2, pO25: 0.6, pBtts: 0.5 };
    expect(logLoss1x2(p, { homeGoals: 2, awayGoals: 1 })).toBeCloseTo(-Math.log(0.5), 12);
    expect(brier1x2(p, { homeGoals: 0, awayGoals: 0 })).toBeCloseTo(0.25 + 0.49 + 0.04, 12);
    expect(score(p, { homeGoals: 2, awayGoals: 1 }).llO25).toBeCloseTo(-Math.log(0.6), 12);
    const nv = naiveProbs([{ homeGoals: 1, awayGoals: 0 }, { homeGoals: 0, awayGoals: 0 }]);
    expect(nv.p1 + nv.pX + nv.p2).toBeCloseTo(1, 12);
    expect(nv.p1).toBeCloseTo(2 / 5, 12);
    const a = pairedBootstrap([0.1, -0.2, 0.05, -0.1], 500, 3), b = pairedBootstrap([0.1, -0.2, 0.05, -0.1], 500, 3);
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
    const cal = calibration([{ p: 0.15, y: true }, { p: 0.15, y: false }, { p: 0.85, y: true }]);
    expect(cal[1]).toMatchObject({ n: 2, observed: 0.5 });
    expect(ece(cal)).toBeCloseTo((2 / 3) * 0.35 + (1 / 3) * 0.15, 12);
  });

  it('ismert erősségekből generált adaton a kísérleti modell későbbi meccsekre jobb a naiv alapnál', () => {
    // két „idény” ugyanazokkal az erősségekkel: az elsőből tanul, a másodikat jósolja
    const first = synthetic(11);
    const span = Math.max(...first.map((m) => Date.parse(m.date))) - Date.parse(iso(0)) + 5 * DAY;
    const second = synthetic(12).map((m) => ({ ...m, id: `2-${m.id}`, date: new Date(Date.parse(m.date) + span).toISOString() }));
    const train = first, test = second;
    const fit = fitCrossLeague(train, KINDS, new Date(Date.parse(iso(0)) + span).toISOString(), P);
    const nv = naiveProbs(train);
    const diff = test.map((m) => score(probsFromPoisson(predictCrossLeague(fit, m.homeTeamId, m.awayTeamId, m.competitionId, KINDS).poisson), m).ll1x2 - score(nv, m).ll1x2);
    expect(diff.length).toBeGreaterThan(20);
    expect(diff.reduce((s, x) => s + x, 0) / diff.length).toBeLessThan(0);
  });
});

describe('Az alap motor változatlan, a több ligás modell csak a kijelölt PRO-kiszolgálási pontokon', () => {
  it('az éles motor verziója és kimenete változatlan (rögzített referenciaértékek)', () => {
    expect(ENGINE_VERSION).toBe('xg-poisson-1');
    const f = (gf: number, ga: number, n: number) => ({ teamId: 'x', venue: 'hazai', sampleSize: n, wins: 0, draws: 0, losses: 0, goalsFor: gf * n, goalsAgainst: ga * n, avgGoalsFor: gf, avgGoalsAgainst: ga, cleanSheets: 0, failedToScore: 0, formString: '', points: 0, over05: 0, over15: 0, over25: 0, over35: 0, under15: 0, under25: 0, under35: 0, btts: 0, firstHalfGoalsAvg: null, secondHalfGoalsAvg: null, matches: [] }) as FormSummary;
    const lg: LeagueAverages = { leagueId: 'L', matches: 120, avgHomeGoals: 1.55, avgAwayGoals: 1.2, avgTotalGoals: 2.75, homeWinPct: 45, drawPct: 26, awayWinPct: 29, over25Pct: 52, bttsPct: 50 };
    const xg = xgModel(f(2.1, 0.9, 8), f(1.1, 1.6, 7), lg)!;
    expect([xg.homeExpected, xg.awayExpected, xg.homeAttack, xg.homeDefense, xg.awayAttack, xg.awayDefense]).toEqual([1.99, 0.92, 1.26, 0.82, 0.94, 1.02]);
    const p = poissonModel(xg.homeExpected, xg.awayExpected);
    expect(p.homeWin).toBeCloseTo(0.6228512678856089, 14);
    expect(p.draw).toBeCloseTo(0.21028856835602613, 14);
    expect(p.over['2.5']).toBeCloseTo(0.5563469321588242, 14);
    expect(p.bttsYes).toBeCloseTo(0.5192612633391517, 14);
  });

  it('a több ligás modell külön azonosítójú; az ALAP motor fájljai nem hivatkoznak rá, a szerverben csak a kijelölt kiszolgálási pontok', () => {
    expect(XS_MODEL_ID).toBe('xs-strength-1');
    expect(XS_MODEL_ID).not.toBe(ENGINE_VERSION);
    expect(XS_MODEL_STATUS).toBe('pro');
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(e)) files.push(p); } };
    walk(path.join(process.cwd(), 'src', 'server'));
    const base = ['analysis.ts', 'models.ts', 'tips.ts', 'evaluation.ts', 'version.ts'].map((f) => path.join(process.cwd(), 'src', 'shared', 'engine', f));
    const uses = (f: string) => /experimental\/crossLeague|experimental\/xsRelease|xsAnalysis|model\/xsService|model\/xsBootstrap|\.\/xsService'/.test(readFileSync(f, 'utf8'));
    expect(base.filter(uses)).toEqual([]);
    const rel = (f: string) => path.relative(process.cwd(), f).split(path.sep).join('/');
    expect(files.filter(uses).map(rel).sort()).toEqual([
      'src/server/index.ts', 'src/server/model/xsBootstrap.ts', 'src/server/model/xsCompetitions.ts', 'src/server/model/xsService.ts', 'src/server/services/analysisService.ts',
    ]);
  });
});
