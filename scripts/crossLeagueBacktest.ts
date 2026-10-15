/**
 * Több ligás erősségmodell (`xs-strength-1`, KÍSÉRLETI, csak árnyék) –
 * adatlefedettségi audit és időrendi összehasonlítás az éles `xg-poisson-1`-gyel.
 *
 *   npx tsx scripts/crossLeagueBacktest.ts            (teljes futás)
 *   npx tsx scripts/crossLeagueBacktest.ts --quick    (kisebb hiperparaméter-rács)
 *
 * - Nem tölt be .env-et, nem használ Supabase-t, nem ír éles adatot, nem hív hálózatot:
 *   a data/corners-backtest-cache.db-ben tárolt, nyilvános ESPN havi scoreboardokból
 *   (2023-07 – 2026-06, 17 sorozat) olvassa ki a VÉGEREDMÉNYEKET (csak olvasás).
 * - Baseline: a VÁLTOZATLAN éles motor (`analyzeMatch`) – azzal az adatkörrel, amit az
 *   éles ESPN-szolgáltató a meccshez ténylegesen letöltene (szimulálva, lásd `prodAvailable`).
 * - Időrend: hiperparaméter-választás és küszöbök KIZÁRÓLAG a validációs idényen
 *   (2024-25); a teszt (2025-26) egyszer, a már rögzített beállítással fut.
 * - Szivárgás ellen: minden előrejelzés csak a kezdés (kísérleti modellnél a heti
 *   újrabecslés időpontja) előtt legalább 3 órával kezdődött, tehát lezárt meccseket lát.
 * - Kimenet: docs/model-learning/cross-league/report.md és result.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ESPN_LEAGUES } from '../src/server/data/espnProvider';
import { Index, KINDS, available, loadDataset, type Row } from './lib/espnDataset';
import { analyzeMatch } from '../src/shared/engine/analysis';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import type { League, Match, MatchResult, ResearchResult, Team } from '../src/shared/types';
import {
  XS_MODEL_ID, XS_MODEL_STATUS, XS_QUALITY_LABEL, fitCrossLeague, predictCrossLeague, qualityOf,
  type XsFit, type XsMatch, type XsParams, type XsQuality, type XsQualityThresholds,
} from '../src/shared/engine/experimental/crossLeague';
import {
  calibration, calibrationPoints1x2, ece, naiveProbs, pairedBootstrap, probsFromPoisson, score,
  type Outcome, type Probs, type Scores,
} from '../src/shared/engine/experimental/crossLeagueEval';

const QUICK = process.argv.includes('--quick');
const VAL: readonly [string, string] = ['2024-07-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z'];
const TEST: readonly [string, string] = ['2025-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'];
const CLOSED_HOURS = 3;
const HOUR = 3600_000, DAY = 86_400_000;

// ---------------------------------------------------------------------------
// 1–2) Adatkészlet és az éles adatkör szimulációja: a közös könyvtárból (scripts/lib/espnDataset.ts),
// ugyanazzal a `historyPlan`-nel, amelyet egy teszt a valódi szolgáltató kéréseivel vet össze
// (ESPN-idény-szemantika; frissen indult szerver = alsó korlát).
// ---------------------------------------------------------------------------

const LEAGUE = new Map(ESPN_LEAGUES.map((l) => [l.id, l]));
const prodAvailable = (ix: Index, m: Row): Row[] => available(ix, m, { mode: 'cold', extended: false }).rows;
const hasAnyDomestic = (ix: Index, t: string) => [...(ix.part.get(t)?.keys() ?? [])].some((c) => KINDS[c] === 'domestic');

/** Minden lefedett adat a kezdés előtt (bármely sorozat, bármely idény) – a „létezik-e egyáltalán adat” kérdéshez. */
function allAvailable(ix: Index, m: Row): Row[] {
  const cutoff = Date.parse(m.date) - CLOSED_HOURS * HOUR;
  const out = new Map<string, Row>();
  for (const r of ix.byComp.get(m.competitionId) ?? []) if (Date.parse(r.date) <= cutoff) out.set(r.id, r);
  for (const t of [m.homeTeamId, m.awayTeamId]) for (const r of ix.byTeam.get(t) ?? []) if (Date.parse(r.date) <= cutoff) out.set(r.id, r);
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// 3) Baseline: a VÁLTOZATLAN éles motor
// ---------------------------------------------------------------------------

const RESEARCH: ResearchResult = {
  matchId: '', origin: 'live', performedAt: '', provider: 'backtest', news: [],
  availability: { home: { teamId: '', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: '', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } },
  externalPredictions: [], sources: [], warnings: [],
};
const team = (id: string, leagueId: string): Team => ({ id, name: id, shortName: id, country: '–', leagueId });

function baseline(m: Row, available: Row[]) {
  const league: League = LEAGUE.get(m.competitionId)!;
  const match: Match = { id: m.id, leagueId: m.competitionId, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, kickoff: m.date, status: 'finished', importance: 'normal', importanceReasons: [], origin: 'live' };
  const results: MatchResult[] = available.map((r) => ({ id: r.id, leagueId: r.competitionId, date: r.date, homeTeamId: r.homeTeamId, awayTeamId: r.awayTeamId, homeGoals: r.homeGoals, awayGoals: r.awayGoals, origin: 'live' }));
  const a = analyzeMatch({ match, league, homeTeam: team(m.homeTeamId, m.competitionId), awayTeam: team(m.awayTeamId, m.competitionId), results, odds: null, research: { ...RESEARCH, matchId: m.id }, now: m.date });
  return { probs: a.poisson ? probsFromPoisson(a.poisson) : null, insufficient: a.insufficientData, reasons: a.insufficientReasons, form: a.form, leagueMatches: a.leagueAverages.matches };
}

// ---------------------------------------------------------------------------
// 4) Kísérleti modell: heti újrabecslés, időrendben
// ---------------------------------------------------------------------------

interface XsRec { id: string; probs: Probs; sdLog: number; homeKnown: boolean; awayKnown: boolean; nRawMin: number }

function weekStart(iso: string): number {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // hétfő = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** Konvergencia-napló: minden heti becslés körszáma (a jelentésbe kerül). */
const FIT_LOG: { sweeps: number; limit: number; cutoff: string; params: string }[] = [];

function runExperimental(train: XsMatch[], targets: Row[], params: XsParams): Map<string, XsRec> {
  const out = new Map<string, XsRec>();
  const byWeek = new Map<number, Row[]>();
  for (const t of targets) (byWeek.get(weekStart(t.date)) ?? byWeek.set(weekStart(t.date), []).get(weekStart(t.date))!).push(t);
  let warm: XsFit | null = null;
  for (const wk of [...byWeek.keys()].sort((a, b) => a - b)) {
    const cutoff = new Date(wk).toISOString();
    const fit = fitCrossLeague(train, KINDS, cutoff, params, { closedHours: CLOSED_HOURS, warm });
    FIT_LOG.push({ sweeps: fit.sweeps, limit: params.maxSweeps ?? 1000, cutoff, params: `${params.halfLifeDays}/${params.sigmaTeam}/${params.sigmaGroup}` });
    warm = fit;
    for (const t of byWeek.get(wk)!) {
      const p = predictCrossLeague(fit, t.homeTeamId, t.awayTeamId, t.competitionId, KINDS);
      out.set(t.id, { id: t.id, probs: probsFromPoisson(p.poisson), sdLog: p.sdLog, homeKnown: p.home.known, awayKnown: p.away.known, nRawMin: Math.min(p.home.nRaw, p.away.nRaw) });
    }
  }
  return out;
}

/** Naiv alap: a sorozat utolsó 365 napjának gyakoriságai (≥ 50 meccs), különben az azonos típusú sorozatoké. */
const naiveMemo = new Map<string, Probs>();
function naiveFor(ix: Index, m: Row): Probs {
  const cutoff = Date.parse(m.date) - CLOSED_HOURS * HOUR, from = cutoff - 365 * DAY;
  const key = `${m.competitionId}|${Math.floor(cutoff / HOUR)}`;
  const hit = naiveMemo.get(key);
  if (hit) return hit;
  const pick = (rows: Row[]) => rows.filter((r) => r.regulation && Date.parse(r.date) <= cutoff && Date.parse(r.date) > from);
  const own = pick(ix.byComp.get(m.competitionId) ?? []);
  // kevés saját meccs: az azonos típusú sorozatok (klub vagy válogatott) együtt
  const national = KINDS[m.competitionId] === 'national';
  const out = naiveProbs(own.length >= 50 ? own : pick(ix.rows.filter((r) => (KINDS[r.competitionId] === 'national') === national)));
  naiveMemo.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// 5) Fő futás
// ---------------------------------------------------------------------------

type Agg = { n: number } & Scores;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function aggregate(rows: { s: Scores }[]): Agg {
  const k = (f: keyof Scores) => mean(rows.map((r) => r.s[f]));
  return { n: rows.length, ll1x2: k('ll1x2'), br1x2: k('br1x2'), llO25: k('llO25'), brO25: k('brO25'), llBtts: k('llBtts'), brBtts: k('brBtts') };
}

function causeOf(ix: Index, m: Row, base: ReturnType<typeof baseline>, all: ReturnType<typeof baseline>): string {
  if (!all.insufficient) return 'adat_letezik_de_az_eles_adatkor_nem_tartalmazza';
  const failing: string[] = [];
  for (const [t, f10, venue] of [[m.homeTeamId, all.form.homeLast10, all.form.homeAtHome], [m.awayTeamId, all.form.awayLast10, all.form.awayAtAway]] as const) {
    if (f10.sampleSize >= 3 && venue.sampleSize >= 3) continue;
    if (KINDS[m.competitionId] === 'club_intl' && !hasAnyDomestic(ix, t)) failing.push('forras_nem_szolgaltatja_a_hazai_bajnoksagot');
    else if (f10.sampleSize < 3) failing.push('valoban_nincs_eleg_tortenet');
    else failing.push('szigoru_kuszob_hazai_idegen_bontas');
  }
  if (!failing.length && all.leagueMatches < 10) failing.push('szigoru_kuszob_liga_atlag');
  void base;
  return failing.length ? [...new Set(failing)].sort().join('+') : 'egyeb';
}

async function main() {
  const root = process.cwd();
  const t0 = Date.now();
  const { rows, scoreboards, skipped } = loadDataset(path.join(root, 'data', 'corners-backtest-cache.db'));
  const datasetHash = createHash('sha256').update(rows.map((r) => `${r.id}|${r.date}|${r.homeTeamId}|${r.awayTeamId}|${r.homeGoals}|${r.awayGoals}|${r.regulation}`).join('\n')).digest('hex');
  const ix = new Index(rows);
  const reg = rows.filter((r) => r.regulation);
  const train: XsMatch[] = reg; // a kísérleti modell CSAK rendes játékidős eredményből tanul
  console.log(`[adat] ${scoreboards} havi scoreboard · ${rows.length} befejezett meccs · rendes játékidős: ${reg.length} · sha256 ${datasetHash.slice(0, 12)}`);

  const inRange = (r: Row, [a, b]: readonly [string, string]) => r.date >= a && r.date < b;
  const valTargets = reg.filter((r) => inRange(r, VAL));
  const testTargets = reg.filter((r) => inRange(r, TEST));

  // ---- baseline + okelemzés (validáció és teszt) ----
  const baseRec = new Map<string, ReturnType<typeof baseline> & { cause?: string; naive: Probs }>();
  for (const m of [...valTargets, ...testTargets]) {
    const b = baseline(m, prodAvailable(ix, m));
    const rec: ReturnType<typeof baseline> & { cause?: string; naive: Probs } = { ...b, naive: naiveFor(ix, m) };
    if (b.insufficient) rec.cause = causeOf(ix, m, b, baseline(m, allAvailable(ix, m)));
    baseRec.set(m.id, rec);
  }
  console.log(`[baseline] kész (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  // ---- hiperparaméter-választás a validáción ----
  const grid: XsParams[] = [];
  for (const halfLifeDays of QUICK ? [365] : [180, 365, 730]) for (const sigmaTeam of QUICK ? [0.3] : [0.15, 0.3, 0.5]) for (const sigmaGroup of QUICK ? [0.35] : [0.15, 0.35]) {
    grid.push({ halfLifeDays, sigmaTeam, sigmaGroup });
  }
  const tuning: { params: XsParams; ll1x2: number; llO25: number; llBtts: number; n: number }[] = [];
  let best: { params: XsParams; ll: number; recs: Map<string, XsRec> } | null = null;
  for (const params of grid) {
    const recs = runExperimental(train, valTargets, params);
    const s = valTargets.map((m) => score(recs.get(m.id)!.probs, m));
    const row = { params, ll1x2: mean(s.map((x) => x.ll1x2)), llO25: mean(s.map((x) => x.llO25)), llBtts: mean(s.map((x) => x.llBtts)), n: s.length };
    tuning.push(row);
    console.log(`[hangolás] felezés ${params.halfLifeDays} n · σ_csapat ${params.sigmaTeam} · σ_csoport ${params.sigmaGroup} → 1X2 log loss ${row.ll1x2.toFixed(5)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    if (!best || row.ll1x2 < best.ll) best = { params, ll: row.ll1x2, recs };
  }
  const chosen = best!.params;

  // ---- kategória-küszöbök a validációból ----
  const valRecs = best!.recs;
  const covered = valTargets.filter((m) => !baseRec.get(m.id)!.insufficient).map((m) => valRecs.get(m.id)!.sdLog).sort((a, b) => a - b);
  const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.floor(p * (xs.length - 1))))];
  const sdGood = q(covered, 0.5), sdLimited = q(covered, 0.9);
  // a „normál” tartományon túl: kvintilis-sávokban mérjük a nyereséget a naiv alaphoz képest (validáción)
  const beyond = valTargets.filter((m) => valRecs.get(m.id)!.homeKnown && valRecs.get(m.id)!.awayKnown && valRecs.get(m.id)!.sdLog > sdLimited)
    .sort((a, b) => valRecs.get(a.id)!.sdLog - valRecs.get(b.id)!.sdLog);
  const bandStats: { upTo: number; n: number; ci: ReturnType<typeof pairedBootstrap> }[] = [];
  let sdMax = sdLimited;
  let contiguous = true;
  const bands = 5;
  for (let b = 0; b < bands && beyond.length; b++) {
    const slice = beyond.slice(Math.floor((b * beyond.length) / bands), Math.floor(((b + 1) * beyond.length) / bands));
    if (!slice.length) continue;
    const diffs = slice.map((m) => score(valRecs.get(m.id)!.probs, m).ll1x2 - score(baseRec.get(m.id)!.naive, m).ll1x2);
    const ci = pairedBootstrap(diffs, 2000, 1000 + b);
    const upTo = valRecs.get(slice[slice.length - 1].id)!.sdLog;
    bandStats.push({ upTo, n: slice.length, ci });
    // csak a balról (kisebb bizonytalanságtól) FOLYTONOSAN, bizonyítottan jobb sávok számítanak
    if (contiguous && ci.hi < 0) sdMax = upTo; else contiguous = false;
  }
  const thresholds: XsQualityThresholds = { sdGood, sdLimited, sdMax };
  console.log(`[küszöbök] elegendő ≤ ${sdGood.toFixed(3)} · korlátozott ≤ ${sdLimited.toFixed(3)} · kevés ≤ ${sdMax.toFixed(3)}`);

  // ---- TESZT: egyszer, a rögzített beállítással ----
  const testRecs = runExperimental(train, testTargets, chosen);
  const cat = (m: Row): XsQuality => {
    const r = testRecs.get(m.id)!;
    return qualityOf({ sdLog: r.sdLog, home: { known: r.homeKnown }, away: { known: r.awayKnown } }, thresholds).quality;
  };
  const both = testTargets.filter((m) => !baseRec.get(m.id)!.insufficient);
  const sparse = testTargets.filter((m) => baseRec.get(m.id)!.insufficient);

  const pairs = (ms: Row[], a: (m: Row) => Probs, b: (m: Row) => Probs, f: keyof Scores, seed: number) =>
    pairedBootstrap(ms.map((m) => score(a(m), m)[f] - score(b(m), m)[f]), 2000, seed);
  const XS = (m: Row) => testRecs.get(m.id)!.probs, BASE = (m: Row) => baseRec.get(m.id)!.probs!, NAIVE = (m: Row) => baseRec.get(m.id)!.naive;
  const metrics: (keyof Scores)[] = ['ll1x2', 'br1x2', 'llO25', 'brO25', 'llBtts', 'brBtts'];

  const vsBase = Object.fromEntries(metrics.map((f, i) => [f, pairs(both, XS, BASE, f, 11 + i)]));
  const baseVsNaive = Object.fromEntries(metrics.map((f, i) => [f, pairs(both, BASE, NAIVE, f, 31 + i)]));
  const aggBoth = { xs: aggregate(both.map((m) => ({ s: score(XS(m), m) }))), base: aggregate(both.map((m) => ({ s: score(BASE(m), m) }))), naive: aggregate(both.map((m) => ({ s: score(NAIVE(m), m) }))) };

  const qualities: XsQuality[] = ['elegendo', 'korlatozott', 'keves_regularizalt', 'elegtelen'];
  const sparseByCat = qualities.map((qq, i) => {
    const ms = sparse.filter((m) => cat(m) === qq);
    return { quality: qq, n: ms.length, vsNaive: pairs(ms, XS, NAIVE, 'll1x2', 51 + i), vsNaiveO25: pairs(ms, XS, NAIVE, 'llO25', 61 + i), xs: aggregate(ms.map((m) => ({ s: score(XS(m), m) }))), naive: aggregate(ms.map((m) => ({ s: score(NAIVE(m), m) }))) };
  });
  const usable = sparse.filter((m) => cat(m) !== 'elegtelen');
  const usableVsNaive = Object.fromEntries(metrics.map((f, i) => [f, pairs(usable, XS, NAIVE, f, 71 + i)]));
  const bothByCat = qualities.map((qq, i) => {
    const ms = both.filter((m) => cat(m) === qq);
    return { quality: qq, n: ms.length, vsBase: pairs(ms, XS, BASE, 'll1x2', 81 + i) };
  });

  // „elégtelen” bontása: valódi adathiány (ismeretlen csapat) vs. túl nagy bizonytalanság
  const unknownTeam = (m: Row) => !testRecs.get(m.id)!.homeKnown || !testRecs.get(m.id)!.awayKnown;
  const insuffSplit = { noData: sparse.filter((m) => cat(m) === 'elegtelen' && unknownTeam(m)).length, highUncertainty: sparse.filter((m) => cat(m) === 'elegtelen' && !unknownTeam(m)).length };

  // ---- POST-HOC érzékenységvizsgálat (a teszt megtekintése UTÁN hozzáadva – NEM megerősítő) ----
  // (a) halmozott küszöbszabály a validáción: a „normál” tartomány feletti meccsek EGYÜTT, sávhatáronként
  let sdMaxCum = sdLimited;
  const cumStats: { upTo: number; n: number; ci: ReturnType<typeof pairedBootstrap> }[] = [];
  for (let b = 1; b <= bands && beyond.length; b++) {
    const slice = beyond.slice(0, Math.floor((b * beyond.length) / bands));
    const c = pairedBootstrap(slice.map((m) => score(valRecs.get(m.id)!.probs, m).ll1x2 - score(baseRec.get(m.id)!.naive, m).ll1x2), 2000, 2000 + b);
    const upTo = valRecs.get(slice[slice.length - 1].id)!.sdLog;
    cumStats.push({ upTo, n: slice.length, ci: c });
    if (c.hi < 0) sdMaxCum = upTo;
  }
  const catCum = (m: Row): XsQuality => {
    const r = testRecs.get(m.id)!;
    return qualityOf({ sdLog: r.sdLog, home: { known: r.homeKnown }, away: { known: r.awayKnown } }, { ...thresholds, sdMax: sdMaxCum }).quality;
  };
  const usableCum = sparse.filter((m) => catCum(m) !== 'elegtelen');
  const usableCumVsNaive = Object.fromEntries(metrics.map((f, i) => [f, pairs(usableCum, XS, NAIVE, f, 91 + i)]));
  // (b) kibővített σ_csapat a validáción (a választás a rács szélére esett)
  const extended: { params: XsParams; ll1x2: number }[] = [];
  if (!QUICK) {
    for (const sigmaTeam of [0.75, 1.0]) {
      const params: XsParams = { halfLifeDays: chosen.halfLifeDays, sigmaTeam, sigmaGroup: chosen.sigmaGroup };
      const recs = runExperimental(train, valTargets, params);
      extended.push({ params, ll1x2: mean(valTargets.map((m) => score(recs.get(m.id)!.probs, m).ll1x2)) });
      console.log(`[post-hoc] σ_csapat ${sigmaTeam} → validációs 1X2 log loss ${extended[extended.length - 1].ll1x2.toFixed(5)}`);
    }
  }
  const bestExt = extended.filter((e) => e.ll1x2 < best!.ll).sort((a, b) => a.ll1x2 - b.ll1x2)[0] ?? null;
  let extTest: { params: XsParams; vsBase: ReturnType<typeof pairedBootstrap> } | null = null;
  if (bestExt) {
    const r = runExperimental(train, testTargets, bestExt.params);
    extTest = { params: bestExt.params, vsBase: pairedBootstrap(both.map((m) => score(r.get(m.id)!.probs, m).ll1x2 - score(BASE(m), m).ll1x2), 2000, 99) };
  }

  // okok (validáció + teszt külön)
  const causeTable = (ms: Row[]) => {
    const t: Record<string, number> = {};
    for (const m of ms) { const c = baseRec.get(m.id)!.cause; if (c) t[c] = (t[c] ?? 0) + 1; }
    return Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1]));
  };
  const reasonTable = (ms: Row[]) => {
    const t: Record<string, number> = {};
    for (const m of ms) for (const r of baseRec.get(m.id)!.reasons) {
      const key = r.includes('liga-átlaghoz') ? 'liga_atlag_kevesebb_mint_10' : r.includes('hazai meccs') ? 'hazai_csapat_kevesebb_mint_3_hazai' : r.includes('idegenbeli meccs') ? 'vendeg_csapat_kevesebb_mint_3_idegen' : r.includes('lejátszott meccs érhető el') ? 'kevesebb_mint_3_meccs_osszesen' : 'egyeb';
      t[key] = (t[key] ?? 0) + 1;
    }
    return t;
  };
  const byComp = (ms: Row[]) => Object.fromEntries([...new Set(ms.map((m) => m.competitionId))].sort().map((c) => {
    const cm = ms.filter((m) => m.competitionId === c);
    const cb = cm.filter((m) => !baseRec.get(m.id)!.insufficient);
    return [c, {
      targets: cm.length, baselineCovered: cb.length, baselineSparse: cm.length - cb.length,
      xsUsable: cm.filter((m) => baseRec.get(m.id)!.insufficient && cat(m) !== 'elegtelen').length,
      ll1x2: { xs: mean(cb.map((m) => score(XS(m), m).ll1x2)), base: mean(cb.map((m) => score(BASE(m), m).ll1x2)) },
      vsBase: pairedBootstrap(cb.map((m) => score(XS(m), m).ll1x2 - score(BASE(m), m).ll1x2), 1000, 7),
    }];
  }));

  const calXs = calibration(calibrationPoints1x2(both.map((m) => ({ p: XS(m), o: m as Outcome }))));
  const calBase = calibration(calibrationPoints1x2(both.map((m) => ({ p: BASE(m), o: m as Outcome }))));
  const calXsSparse = calibration(calibrationPoints1x2(usable.map((m) => ({ p: XS(m), o: m as Outcome }))));
  const calO25Xs = calibration(both.map((m) => ({ p: XS(m).pO25, y: m.homeGoals + m.awayGoals > 2.5 })));
  const calO25Base = calibration(both.map((m) => ({ p: BASE(m).pO25, y: m.homeGoals + m.awayGoals > 2.5 })));

  // ---- jelentés ----
  const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'n. a.');
  const ci = (c: { mean: number; lo: number; hi: number; n: number }) => `${f(c.mean, 5)} (95% CI ${f(c.lo, 5)} … ${f(c.hi, 5)}; n=${c.n})`;
  const pctf = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
  const L: string[] = [];
  L.push(`# ${XS_MODEL_ID} – több ligás erősségmodell: adatlefedettség és időrendi összehasonlítás`, '');
  L.push(`Futtatva: ${new Date().toISOString()} · éles modell: \`${ENGINE_VERSION}\` (változatlan) · kísérleti: \`${XS_MODEL_ID}\` (állapot: **${XS_MODEL_STATUS}**, nem szolgál ki tippet)${QUICK ? ' · **GYORS mód (szűk rács)**' : ''}.`, '');
  L.push(`Adat: ${scoreboards} havi ESPN-scoreboard a helyi cache-ből (hálózat nélkül), ${rows.length} befejezett meccs 17 sorozatból (2023-07 – 2026-06), ebből ${reg.length} rendes játékidős. Adatkészlet-ujjlenyomat (sha256): \`${datasetHash}\`. Kihagyva: ${Object.entries(skipped).map(([k, v]) => `${k}: ${v}`).join(', ') || '–'}.`, '');
  L.push('Időrend: validáció 2024-07-01 – 2025-07-01 (hiperparaméterek, küszöbök), teszt 2025-07-01 – 2026-07-01 (egyszeri értékelés). Minden előrejelzés csak a kezdés (kísérleti modellnél: a heti újrabecslés) előtt legalább 3 órával kezdődött meccseket lát. A célmeccsek rendes játékidővel zárultak (hosszabbítás/tizenegyesek kizárva, mert a forrás eredménye azokban nem a 90 perces).', '');

  L.push('## 1. Miért kevés az adat? (éles adatkör, xg-poisson-1)', '');
  for (const [name, ms] of [['Validáció (2024-25)', valTargets], ['Teszt (2025-26)', testTargets]] as const) {
    const sp = ms.filter((m) => baseRec.get(m.id)!.insufficient);
    L.push(`### ${name}: ${ms.length} célmeccs, ebből „kevés adat”: **${sp.length} (${pctf(sp.length, ms.length)})**`, '');
    L.push('Ok (a meccs akkor is egyszer számít, ha több csapatnál/szinten hibázik):', '', '| ok | meccs |', '|---|---|');
    for (const [k, v] of Object.entries(causeTable(ms))) L.push(`| ${k} | ${v} |`);
    L.push('', 'A motor által jelzett feltételek (egy meccs több feltételen is elbukhat):', '', '| feltétel | előfordulás |', '|---|---|');
    for (const [k, v] of Object.entries(reasonTable(sp))) L.push(`| ${k} | ${v} |`);
    L.push('');
  }
  {
    const sp = testTargets.filter((m) => baseRec.get(m.id)!.insufficient);
    const causes = [...new Set(sp.map((m) => baseRec.get(m.id)!.cause!))].sort();
    const comps = [...new Set(sp.map((m) => m.competitionId))].sort();
    L.push('### Teszt: ok × sorozat', '', `| sorozat | ${causes.join(' | ')} |`, `|---|${causes.map(() => '---').join('|')}|`);
    for (const c of comps) L.push(`| ${c} | ${causes.map((k) => sp.filter((m) => m.competitionId === c && baseRec.get(m.id)!.cause === k).length || '–').join(' | ')} |`);
    L.push('');
  }
  L.push('Az okok jelentése:', '');
  L.push('- **adat_letezik_de_az_eles_adatkor_nem_tartalmazza**: a lefedett forrásban (17 sorozat, 3 idény) van elég korábbi meccs, és az éles motor a SAJÁT küszöbeivel elemezné is, de az éles szolgáltató ezeket nem tölti le / nem kapcsolja a meccshez (pl. a nemzetközi kupák előző idényei nem kerülnek be; kupameccsnél a liga-átlag csak az aktuális kupaidényből számol).');
  L.push('- **forras_nem_szolgaltatja_a_hazai_bajnoksagot**: nemzetközi kupameccs, ahol a csapat hazai bajnoksága nincs a beállított ESPN-sorozatok között (pl. portugál, holland, skót, belga… klubok) – az adat létezik a világban, de a forrásunkból nem érhető el.');
  L.push('- **valoban_nincs_eleg_tortenet**: a csapatnak a teljes lefedett adatban sincs legalább 3 korábbi meccse.');
  L.push('- **szigoru_kuszob_hazai_idegen_bontas / szigoru_kuszob_liga_atlag**: van elég összesített adat, de a motor hazai/idegen bontásban kér ≥3 meccset, illetve a sorozatból ≥10 liga-átlagmeccset.');
  L.push('- Csapat-/ligaazonosító eltérés: az adatkészletben **0** olyan csapatnév van, amely több ESPN-azonosítóhoz tartozna, és ugyanaz az ESPN-azonosító minden sorozatban ugyanazt a csapatot jelöli – ilyen hiba ebben az adatkörben nem mutatható ki. A magyar NB I/NB II nincs az ESPN-ben, ezért nem mérhető.', '');

  const atLimit = FIT_LOG.filter((x) => x.sweeps >= x.limit).length;
  L.push('## 2. A kísérleti modell', '');
  L.push(`> **Optimalizáló-javítás az első futáshoz képest:** az első változat a paraméterezés likelihood szempontjából „lapos” irányai (csoportszint ↔ a csoport csapatai, konstans ↔ csoportszintek, közös támadás/védekezés-eltolás) mentén nem konvergált a körlimiten belül. Ezek az irányok a likelihoodot – így az ismert csapatok előrejelzését – nem változtatják, csak az erősség liga- és csapatszint közötti felosztását; ezért a mérőszámok gyakorlatilag változatlanok (a teszt Δ 1X2 öt tizedesig azonos). A javítás (az irányok – összefüggő komponensenként is – pontos, zárt alakú optimalizálása minden körben) az ismeretlen csapatoknál használt csoportátlagot és a ligaszintek értelmezhetőségét teszi helyessé. A maradék lassú konvergenciát egy adatminőségi hiba okozta: az ESPN MLS-scoreboardja bemutató-meccseket (MLS All-Stars – Liga MX All-Stars) bajnokiként ad; ezeket kizártuk (az éles szolgáltató sem látja őket). A hangolási rács, az időszakok és a küszöbszabály változatlan. Konvergencia: ${FIT_LOG.length} heti becslés, átlagosan ${f(mean(FIT_LOG.map((x) => x.sweeps)), 1)} kör, legfeljebb ${Math.max(...FIT_LOG.map((x) => x.sweeps))}; a körlimitet elérte: **${atLimit}**.`, '');
  L.push(`Hierarchikus, regularizált Poisson támadó/védekező erősség (lásd \`src/shared/engine/experimental/crossLeague.ts\`). Csoport = a csapat legtöbbet játszott hazai bajnoksága; a csapat a csoportja, a csoport a globális szint felé húzódik. A ligák közti szintet a nemzetközi kupameccsek és a ligák között mozgó csapatok kötik össze; a ligaerősség egyszer szerepel. Bizonytalanság: Laplace-diagonális szórások, Gauss–Hermite keverékkel a valószínűségekben. Heti újrabecslés, időrendben.`, '');
  L.push('### Hiperparaméter-választás (CSAK validáció, elsődleges mérőszám: 1X2 log loss)', '', '| felezési idő (nap) | σ csapat | σ csoport | 1X2 log loss | O2,5 log loss | BTTS log loss | n |', '|---|---|---|---|---|---|---|');
  for (const t of [...tuning].sort((a, b) => a.ll1x2 - b.ll1x2)) L.push(`| ${t.params.halfLifeDays} | ${t.params.sigmaTeam} | ${t.params.sigmaGroup} | ${f(t.ll1x2, 5)} | ${f(t.llO25, 5)} | ${f(t.llBtts, 5)} | ${t.n} |`);
  L.push('', `Kiválasztott: **felezési idő ${chosen.halfLifeDays} nap, σ_csapat ${chosen.sigmaTeam}, σ_csoport ${chosen.sigmaGroup}**.`, '');
  L.push('### Adatminőségi kategóriák és küszöbeik (validációból, nem önkényes)', '');
  L.push(`Mérőszám: a meccs log-várhatógól-rátáinak összevont bizonytalansága (sdLog).`);
  L.push(`- **${XS_QUALITY_LABEL.elegendo}**: sdLog ≤ ${f(sdGood, 3)} – a validáción az éles motor által elemzett meccsek bizonytalanságának mediánja.`);
  L.push(`- **${XS_QUALITY_LABEL.korlatozott}**: ≤ ${f(sdLimited, 3)} – ugyanezek 90. percentilise.`);
  L.push(`- **${XS_QUALITY_LABEL.keves_regularizalt}**: ≤ ${f(sdMax, 3)} – a ${f(sdLimited, 3)} feletti tartomány kvintilis-sávjai közül csak azok, amelyekben a modell a validáción BIZONYÍTOTTAN (95% CI teljesen 0 alatt) jobb volt a naiv alapnál, balról folytonosan.`);
  L.push(`- **${XS_QUALITY_LABEL.elegtelen}**: e felett, vagy ha bármelyik csapatnak nincs egyetlen lezárt meccse sem (adathiány ≠ gyengeség).`, '');
  L.push('| sáv felső határa (sdLog) | n | Δ 1X2 log loss a naiv alaphoz (validáció) |', '|---|---|---|');
  for (const b of bandStats) L.push(`| ${f(b.upTo, 3)} | ${b.n} | ${ci(b.ci)} |`);
  L.push('');

  L.push('## 3. Teszt (2025-26) – egyszeri értékelés', '');
  L.push(`Célmeccsek: ${testTargets.length} · az éles motor elemzi: **${both.length}** · „kevés adat” az élesben: **${sparse.length}**.`, '');
  L.push('### 3.1 Ahol az éles motor is elemez – kísérleti vs. éles (páros, Δ = kísérleti − éles; negatív = a kísérleti jobb)', '');
  L.push('| mérőszám | kísérleti | éles | naiv | Δ kísérleti − éles |', '|---|---|---|---|---|');
  for (const k of metrics) L.push(`| ${k} | ${f(aggBoth.xs[k], 5)} | ${f(aggBoth.base[k], 5)} | ${f(aggBoth.naive[k], 5)} | ${ci(vsBase[k])} |`);
  L.push('', 'Viszonyítás – éles vs. naiv alap ugyanezeken a meccseken:', '');
  for (const k of metrics) L.push(`- ${k}: Δ éles − naiv = ${ci(baseVsNaive[k])}`);
  L.push('', 'Bontás a kísérleti modell kategóriája szerint (Δ 1X2 log loss, kísérleti − éles):', '', '| kategória | n | Δ |', '|---|---|---|');
  for (const b of bothByCat) L.push(`| ${XS_QUALITY_LABEL[b.quality]} | ${b.n} | ${b.n ? ci(b.vsBase) : '–'} |`);
  L.push('', '### 3.2 Ahol az éles motor „kevés adatot” jelez – kísérleti vs. naiv alap (éles előrejelzés itt nincs)', '');
  L.push('| kategória | meccs | 1X2 log loss kísérleti | naiv | Δ 1X2 (95% CI) | Δ O2,5 (95% CI) |', '|---|---|---|---|---|---|');
  for (const s of sparseByCat) L.push(`| ${XS_QUALITY_LABEL[s.quality]} | ${s.n} | ${f(s.xs.ll1x2, 5)} | ${f(s.naive.ll1x2, 5)} | ${s.n ? ci(s.vsNaive) : '–'} | ${s.n ? ci(s.vsNaiveO25) : '–'} |`);
  L.push('', `Az „elégtelen” kategória bontása: valódi adathiány (legalább az egyik csapatnak nincs lezárt meccse) **${insuffSplit.noData}**, túl nagy bizonytalanság **${insuffSplit.highUncertainty}**.`, '');
  L.push(`**Megalapozottan elemezhető további meccs (teszt, előre rögzített szabály):** ${usable.length} a ${sparse.length} „kevés adat” meccsből (nem „elégtelen” kategória). Ezeken a kísérleti modell a naiv alaphoz képest:`, '');
  for (const k of metrics) L.push(`- ${k}: Δ = ${ci(usableVsNaive[k])}`);
  L.push('');
  L.push('### 3.3 Sorozatonként (teszt)', '', '| sorozat | célmeccs | éles elemzi | éles: kevés adat | ebből a kísérleti használható | 1X2 log loss kísérleti / éles (közös) | Δ (95% CI) |', '|---|---|---|---|---|---|---|');
  for (const [c, v] of Object.entries(byComp(testTargets))) L.push(`| ${c} | ${v.targets} | ${v.baselineCovered} | ${v.baselineSparse} | ${v.xsUsable} | ${f(v.ll1x2.xs)} / ${f(v.ll1x2.base)} | ${v.vsBase.n ? ci(v.vsBase) : '–'} |`);
  L.push('', '### 3.4 Kalibráció (teszt)', '');
  L.push(`1X2 (egy-a-többi ellen, közös meccsek) – ECE kísérleti ${f(ece(calXs))}, éles ${f(ece(calBase))}; a „kevés adat”, de használható meccseken kísérleti ${f(ece(calXsSparse))}. O2,5 – ECE kísérleti ${f(ece(calO25Xs))}, éles ${f(ece(calO25Base))}.`, '');
  L.push('| sáv | n kís. | átl. p | tényl. | n éles | átl. p | tényl. |', '|---|---|---|---|---|---|---|');
  calXs.forEach((b, i) => { const c = calBase[i]; L.push(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${b.n ? f(b.meanP, 3) : '–'} | ${b.n ? f(b.observed, 3) : '–'} | ${c.n} | ${c.n ? f(c.meanP, 3) : '–'} | ${c.n ? f(c.observed, 3) : '–'} |`); });
  L.push('', '## 4. Post-hoc érzékenységvizsgálat – NEM megerősítő', '');
  L.push('> Az alábbiakat a teszteredmény megtekintése UTÁN adtuk hozzá. A paraméterek és küszöbök itt is csak a validációból jönnek, de a vizsgálat ötlete a teszt ismeretében született, ezért ezek az eredmények NEM bizonyítékok – elfogadásukhoz új, érintetlen időszak (pl. a 2026-27-es idény árnyék-üzemben) kell.', '');
  L.push(`**(a) Halmozott küszöbszabály.** Az előre rögzített szabály balról folytonos sávonkénti bizonyítást kér, ezért az első, 195 meccses sáv határeseti CI-je (lásd a 2. pont táblázatát) a „kevés adat” kategóriát üresen hagyta, miközben a következő sávok bizonyítottan jobbak voltak a naiv alapnál. Halmozott szabállyal (a ${f(sdLimited, 3)} feletti meccsek együtt, sávhatáronként; a legnagyobb határ, ahol a 95% CI teljesen 0 alatt van) a felső küszöb: **${f(sdMaxCum, 3)}**.`, '');
  L.push('| halmozott határ (sdLog) | n | Δ 1X2 log loss a naivhoz (validáció) |', '|---|---|---|');
  for (const c of cumStats) L.push(`| ${f(c.upTo, 3)} | ${c.n} | ${ci(c.ci)} |`);
  L.push('', `Ezzel a teszten használható „kevés adat” meccs: **${usableCum.length}** a ${sparse.length}-ből. A naiv alaphoz képest:`, '');
  for (const k of metrics) L.push(`- ${k}: Δ = ${ci(usableCumVsNaive[k])}`);
  L.push('', `**(b) Kibővített σ_csapat.** A választás a rács szélére (σ_csapat ${chosen.sigmaTeam}) esett. Validációs 1X2 log loss nagyobb σ-val: ${extended.length ? extended.map((e) => `σ ${e.params.sigmaTeam}: ${f(e.ll1x2, 5)}`).join(', ') : 'gyors módban nem futott'} (a választotté ${f(best!.ll, 5)}).${extTest ? ` A validáción jobb σ ${extTest.params.sigmaTeam} a teszten az élessel szemben: Δ 1X2 = ${ci(extTest.vsBase)}.` : ' Nagyobb σ a validáción nem javított.'}`, '');
  L.push('## 5. Korlátok', '');
  L.push('- Egy adatforrás (ESPN, 17 sorozat), két kiértékelt idény; a mért különbség más ligákra/időszakokra nem garantáltan általánosítható.');
  L.push('- Hazai kupák, más országok bajnokságai és keretadatok nincsenek a forrásban – a modell ezeket nem látja, és nem is pótolja.');
  L.push('- Az éles adatkör szimuláció: a szolgáltató letöltési szabályait követi (`scripts/lib/espnDataset.ts` – `available`, a `historyPlan` alapján, amelyet teszt vet össze a valódi szolgáltatóval), frissen indult szerver állapotában (alsó korlát); az élő rendszer pillanatnyi hálózati hibáit nem modellezi.');
  L.push('- Az éles szolgáltató ma NEM tölti le a kísérleti modell tanítóadatát (több idény, minden sorozat); árnyék-üzemhez ehhez külön adatgyűjtés kell.');
  L.push(`- A modell automatikusan nem kerül élesbe: állapota \`${XS_MODEL_STATUS}\`; élesítés csak külön, kézi döntéssel.`);

  const outDir = path.join(root, 'docs', 'model-learning', 'cross-league');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'report.md'), L.join('\n') + '\n', 'utf8');
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), quick: QUICK, engine: ENGINE_VERSION, experimental: { id: XS_MODEL_ID, status: XS_MODEL_STATUS },
    dataset: { scoreboards, matches: rows.length, regulation: reg.length, sha256: datasetHash, skipped },
    periods: { validation: VAL, test: TEST, closedHours: CLOSED_HOURS },
    coverage: {
      validation: { targets: valTargets.length, sparse: valTargets.filter((m) => baseRec.get(m.id)!.insufficient).length, causes: causeTable(valTargets), reasons: reasonTable(valTargets.filter((m) => baseRec.get(m.id)!.insufficient)) },
      test: { targets: testTargets.length, sparse: sparse.length, causes: causeTable(testTargets), reasons: reasonTable(sparse) },
    },
    convergence: { fits: FIT_LOG.length, meanSweeps: mean(FIT_LOG.map((x) => x.sweeps)), maxSweeps: Math.max(...FIT_LOG.map((x) => x.sweeps)), hitLimit: FIT_LOG.filter((x) => x.sweeps >= x.limit).length },
    tuning, chosen, thresholds, bandStats,
    postHoc: { note: 'a teszt megtekintése után hozzáadva – nem megerősítő', cumulativeRule: { sdMax: sdMaxCum, cumStats, usable: usableCum.length, usableVsNaive: usableCumVsNaive }, extendedGrid: extended, extendedTest: extTest },
    insufficientSplit: insuffSplit,
    test: { both: both.length, sparse: sparse.length, usable: usable.length, aggBoth, vsBase, baseVsNaive, bothByCat, sparseByCat, usableVsNaive, byCompetition: byComp(testTargets),
      calibration: { x1x2: calXs, base1x2: calBase, xsSparse1x2: calXsSparse, xsO25: calO25Xs, baseO25: calO25Base } },
  }, null, 1), 'utf8');
  const hit = FIT_LOG.filter((x) => x.sweeps >= x.limit);
  console.log(`[konvergencia] limitet elérte: ${hit.length} – beállítás szerint: ${JSON.stringify(hit.reduce((o, x) => ((o[x.params] = (o[x.params] ?? 0) + 1), o), {} as Record<string, number>))} – első: ${hit.slice(0, 3).map((x) => x.cutoff.slice(0, 10)).join(', ')}`);
  console.log(`[kész] ${((Date.now() - t0) / 1000).toFixed(0)} s · teszt: éles elemzi ${both.length}, kevés adat ${sparse.length}, ebből kísérleti használható ${usable.length}`);
  console.log(`[teszt] Δ 1X2 log loss (kísérleti − éles): ${ci(vsBase.ll1x2)} · használható ritka meccsek vs naiv: ${ci(usableVsNaive.ll1x2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
