/**
 * corners-nb-1 – időrendi visszatesztelés VALÓS ESPN-szögletadatokon.
 *
 *   npx tsx scripts/cornersBacktest.ts
 *
 * - Nem tölt be .env-et, nem használ Supabase-t, nem ír éles adatot.
 * - Ugyanazt az `EspnProvider.getCornerMonth` kódutat használja, mint a szerver
 *   (nyilvános, kulcs nélküli ESPN-végpont), saját helyi cache-sel
 *   (data/corners-backtest-cache.db – gitignore-olt).
 * - Hangolás: 2024–25 (2024-07-01 – 2025-06-30); holdout: 2025–26
 *   (2025-07-01 – 2026-06-30). A paramétert KIZÁRÓLAG a hangolási szakasz
 *   választja; a holdout csak a végső értékelésben szerepel.
 * - Kimenet: docs/corners/backtest-report.md és docs/corners/backtest-result.json.
 *
 * A jelentés eredménye alapján lehet (kézzel, felülvizsgálat után) a
 * src/shared/engine/corners/release.ts `validated` értékét módosítani.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CacheDb } from '../src/server/db/cacheDb';
import { ESPN_LEAGUES, EspnProvider } from '../src/server/data/espnProvider';
import { CORNER_UNSUPPORTED_LEAGUES, shiftMonth } from '../src/server/data/espnCorners';
import type { CornerResult } from '../src/shared/types';
import { CornerIndex } from '../src/shared/engine/corners/stats';
import { DEFAULT_CORNER_PARAMS, type CornerModelParams } from '../src/shared/engine/corners/model';
import {
  bootstrapDiff, calibrationTable, evaluateTargets, releaseGate, selectParams, summarize, type EvalRecord,
} from '../src/shared/engine/corners/backtest';
import type { CornerScope } from '../src/shared/engine/corners/markets';

const FIRST_MONTH = '202307';
const LAST_MONTH = '202606';
const TUNE = ['2024-07-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z'] as const;
const HOLD = ['2025-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'] as const;

const seasonOf = (yyyymm: string) => {
  const y = parseInt(yyyymm.slice(0, 4), 10), m = parseInt(yyyymm.slice(4, 6), 10);
  const s = m >= 7 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
};

async function main() {
  const root = process.cwd();
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const cache = new CacheDb(path.join(root, 'data', 'corners-backtest-cache.db')).httpCache();
  const espn = new EspnProvider(cache);

  const months: string[] = [];
  for (let m = FIRST_MONTH; m <= LAST_MONTH; m = shiftMonth(m, 1)) months.push(m);

  // ---- 1) Adatgyűjtés és lefedettség ----
  type Cov = { completed: number; valid: number; skipped: Record<string, number>; failedMonths: number };
  const coverage: Record<string, Record<string, Cov>> = {};
  const all: CornerResult[] = [];
  let requests = 0;
  for (const lg of ESPN_LEAGUES) {
    coverage[lg.id] = {};
    for (const mo of months) {
      const season = seasonOf(mo);
      const c = (coverage[lg.id][season] ??= { completed: 0, valid: 0, skipped: {}, failedMonths: 0 });
      const parsed = await espn.getCornerMonth(lg.id, mo);
      requests++;
      if (!parsed) { c.failedMonths++; continue; }
      c.valid += parsed.results.length;
      for (const s of parsed.skipped) {
        if (s.reason === 'not_completed' || s.reason === 'duplicate') continue;
        c.skipped[s.reason] = (c.skipped[s.reason] ?? 0) + 1;
      }
      c.completed += parsed.results.length + parsed.skipped.filter((s) => s.reason !== 'not_completed' && s.reason !== 'duplicate').length;
      all.push(...parsed.results);
    }
    const tot = Object.values(coverage[lg.id]).reduce((s, c) => ({ v: s.v + c.valid, c: s.c + c.completed }), { v: 0, c: 0 });
    console.log(`[adat] ${lg.id.padEnd(14)} ${tot.v}/${tot.c} érvényes`);
  }

  // ---- 2) Index és célmeccsek ----
  const idx = new CornerIndex(all);
  const evaluable = idx.all.filter((r) => !CORNER_UNSUPPORTED_LEAGUES[r.leagueId]);
  const inRange = (r: CornerResult, [a, b]: readonly [string, string]) => r.date >= a && r.date < b;
  const tuneTargets = evaluable.filter((r) => inRange(r, TUNE));
  const holdTargets = evaluable.filter((r) => inRange(r, HOLD));
  console.log(`[index] ${idx.all.length} meccs · hangolás: ${tuneTargets.length} · holdout: ${holdTargets.length}`);

  // ---- 3) Hangolás (csak a hangolási szakaszon) ----
  const grid: CornerModelParams[] = [];
  for (const k of [0, 2, 5, 10, 20]) for (const window of [5, 10, 20]) for (const distribution of ['negbin', 'poisson'] as const) {
    grid.push({ ...DEFAULT_CORNER_PARAMS, k, window, distribution });
  }
  const tuning = selectParams(idx, tuneTargets, grid);
  const best = tuning.best;
  console.log(`[hangolás] legjobb: k=${best.k}, window=${best.window}, ${best.distribution}`);

  // ---- 4) Holdout-értékelés (a kiválasztott paraméterrel, egyszer) ----
  const hold = evaluateTargets(idx, holdTargets, best);
  const overall = summarize(hold.records);
  const scopes: CornerScope[] = ['total', 'home', 'away'];
  const byScope = Object.fromEntries(scopes.map((s) => [s, summarize(hold.records.filter((r) => r.scope === s))])) as Record<CornerScope, ReturnType<typeof summarize>>;
  const ciLL = bootstrapDiff(hold.records, 'logLoss');
  const ciBr = bootstrapDiff(hold.records, 'brier');
  const ciScope = Object.fromEntries(scopes.map((s) => [s, bootstrapDiff(hold.records.filter((r) => r.scope === s), 'logLoss')])) as Record<CornerScope, ReturnType<typeof bootstrapDiff>>;
  const leagues = [...new Set(hold.records.map((r) => r.leagueId))].sort();
  const byLeague = leagues.map((l) => ({ leagueId: l, ...summarize(hold.records.filter((r) => r.leagueId === l)) }));
  const byMarket: { scope: CornerScope; line: number; s: ReturnType<typeof summarize> }[] = [];
  for (const s of scopes) for (const line of [...new Set(hold.records.filter((r) => r.scope === s).map((r) => r.line))]) {
    byMarket.push({ scope: s, line, s: summarize(hold.records.filter((r) => r.scope === s && r.line === line)) });
  }
  const calModel = calibrationTable(hold.records, 'pModel');
  const calBase = calibrationTable(hold.records, 'pBase');
  const gate = releaseGate({ eligibleMatches: hold.eligible, logLoss: ciLL, brier: ciBr, byScope: ciScope });

  // függetlenségi ellenőrzés: a hazai és vendég szögletszám korrelációja a holdout meccseken
  const hm = holdTargets;
  const corr = (() => {
    const n = hm.length; if (n < 3) return NaN;
    const mx = hm.reduce((s, r) => s + r.homeCorners, 0) / n, my = hm.reduce((s, r) => s + r.awayCorners, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const r of hm) { const dx = r.homeCorners - mx, dy = r.awayCorners - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return sxy / Math.sqrt(sxx * syy);
  })();

  // ---- 5) Jelentés ----
  const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'n. a.');
  const pctf = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
  const lines: string[] = [];
  lines.push('# corners-nb-1 – időrendi visszateszt', '');
  lines.push(`Futtatva: ${new Date().toISOString()} · adatforrás: ESPN nyilvános scoreboard (havi lekérés), ${requests} hónap-lekérés · ${idx.all.length} érvényes meccs (${FIRST_MONTH}–${LAST_MONTH}).`, '');
  lines.push('Szabályok: csak befejezett, rendes játékidős meccs; mindkét csapat szögletszáma kell; hiányzó érték soha nem nulla; az üres (csupa nulla, pl. 0%–0% labdabirtoklású) statisztika-blokk hiányzó adatnak számít; duplikátum event ID szerint kiszűrve. A becslések a kezdés előtt 3 órával lezárt adatokból készülnek.', '');
  lines.push('> **Adatminőségi javítás:** az első futás ÉRVÉNYTELEN volt – a parser az ESPN üres statisztika-blokkjainak „0” helyőrzőit valódi 0 szögletként fogadta el (Championship: a meccsek közel fele; EPL/MLS: néhány meccs). A hibát adat-szabállyal javítottuk (`empty_stats`), a hangolási rács, a holdout-időszak és a kiadási kapu változatlan; paramétert a holdout alapján nem módosítottunk.', '');
  lines.push('## Kiadási kapu', '');
  lines.push(gate.passed ? '**ÁTMENT** – a modell a rögzített holdouton jobb a baseline-nál.' : '**NEM MENT ÁT** – a modell kísérleti marad, modell-valószínűség és szöglettipp nem jelenik meg.', '');
  for (const r of gate.reasons) lines.push(`- ${r}`);
  lines.push('');
  lines.push('## Lefedettség ligánként és idényenként (érvényes / befejezett rendes játékidős+kizárt)', '');
  const seasons = [...new Set(months.map(seasonOf))];
  lines.push(`| Liga | ${seasons.join(' | ')} |`, `|---|${seasons.map(() => '---').join('|')}|`);
  for (const lg of ESPN_LEAGUES) {
    lines.push(`| ${lg.name} (${lg.id}) | ${seasons.map((s) => { const c = coverage[lg.id][s]; return c ? `${c.valid}/${c.completed} (${pctf(c.valid, c.completed)})${c.failedMonths ? ` ⚠${c.failedMonths}` : ''}` : '–'; }).join(' | ')} |`);
  }
  lines.push('', 'Kizárási okok összesítve:', '');
  const reasonsTot: Record<string, number> = {};
  for (const lg of Object.values(coverage)) for (const c of Object.values(lg)) for (const [k, v] of Object.entries(c.skipped)) reasonsTot[k] = (reasonsTot[k] ?? 0) + v;
  for (const [k, v] of Object.entries(reasonsTot)) lines.push(`- ${k}: ${v}`);
  lines.push('', '- A magyar NB I nincs az ESPN-ben – nem támogatott, nem mérhető.', '- Barátságos válogatott: a modell nem fut rá (CORNER_UNSUPPORTED_LEAGUES).', '');
  lines.push('## Hangolás (2024–25, csak hangolási célmeccsek)', '');
  lines.push(`Célmeccsek: ${tuneTargets.length}. Rács: k ∈ {0,2,5,10,20}, ablak ∈ {5,10,20}, eloszlás ∈ {negbin, poisson}. Választás: átlagos log loss.`, '');
  lines.push('| k | ablak | eloszlás | értékelhető meccs | log loss | Brier |', '|---|---|---|---|---|---|');
  for (const t of [...tuning.table].sort((a, b) => a.logLoss - b.logLoss)) lines.push(`| ${t.params.k} | ${t.params.window} | ${t.params.distribution} | ${t.eligible} | ${f(t.logLoss, 5)} | ${f(t.brier, 5)} |`);
  lines.push('', `Kiválasztott: **k=${best.k}, ablak=${best.window}, ${best.distribution}**.`, '');
  lines.push('## Holdout (2025–26) – modell vs. liga-átlag baseline', '');
  lines.push(`Célmeccsek: ${hold.targets} · értékelhető (a modell adatminimumait teljesíti): **${hold.eligible}** · kihagyva hiány miatt: ${Object.entries(hold.skipped).map(([k, v]) => `${k}: ${v}`).join(', ') || '–'} (egy meccs több okból is kimaradhat).`, '');
  lines.push('| | rekord | log loss modell | log loss baseline | Brier modell | Brier baseline |', '|---|---|---|---|---|---|');
  lines.push(`| Összes | ${overall.records} | ${f(overall.logLossModel, 5)} | ${f(overall.logLossBase, 5)} | ${f(overall.brierModel, 5)} | ${f(overall.brierBase, 5)} |`);
  for (const s of scopes) lines.push(`| ${s} | ${byScope[s].records} | ${f(byScope[s].logLossModel, 5)} | ${f(byScope[s].logLossBase, 5)} | ${f(byScope[s].brierModel, 5)} | ${f(byScope[s].brierBase, 5)} |`);
  lines.push('', 'Páros meccsenkénti bootstrap (1000 újramintavétel), Δ = modell − baseline (negatív = a modell jobb):', '');
  lines.push(`- log loss: Δ = ${f(ciLL.mean, 5)} (95% CI ${f(ciLL.lo, 5)} … ${f(ciLL.hi, 5)})`);
  lines.push(`- Brier: Δ = ${f(ciBr.mean, 5)} (95% CI ${f(ciBr.lo, 5)} … ${f(ciBr.hi, 5)})`);
  for (const s of scopes) lines.push(`- log loss, ${s}: Δ = ${f(ciScope[s].mean, 5)} (95% CI ${f(ciScope[s].lo, 5)} … ${f(ciScope[s].hi, 5)})`);
  lines.push('', '### Piaconként', '', '| Piac | vonal | meccs | log loss modell | baseline | Brier modell | baseline |', '|---|---|---|---|---|---|---|');
  for (const m of byMarket) lines.push(`| ${m.scope} | ${m.line} | ${m.s.matches} | ${f(m.s.logLossModel)} | ${f(m.s.logLossBase)} | ${f(m.s.brierModel)} | ${f(m.s.brierBase)} |`);
  lines.push('', '### Ligánként', '', '| Liga | meccs | log loss modell | baseline | Brier modell | baseline |', '|---|---|---|---|---|---|');
  for (const l of byLeague) lines.push(`| ${l.leagueId} | ${l.matches} | ${f(l.logLossModel)} | ${f(l.logLossBase)} | ${f(l.brierModel)} | ${f(l.brierBase)} |`);
  lines.push('', '### Kalibráció (holdout, minden vonal)', '', '| sáv | n (modell) | átl. p | tényleges | n (baseline) | átl. p | tényleges |', '|---|---|---|---|---|---|---|');
  calModel.forEach((b, i) => { const c = calBase[i]; lines.push(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${b.n ? f(b.meanP, 3) : '–'} | ${b.n ? f(b.observed, 3) : '–'} | ${c.n} | ${c.n ? f(c.meanP, 3) : '–'} | ${c.n ? f(c.observed, 3) : '–'} |`); });
  lines.push('', '## Függetlenségi feltételezés', '', `A holdout meccseken a hazai és vendég szögletszám Pearson-korrelációja: **${f(corr, 3)}** (n = ${hm.length}). Az összes szöglet eloszlása a két oldal konvolúciója; ennek kalibrációja a „total” sorokban látható.`, '');
  lines.push('## Korlátok', '');
  lines.push('- A visszateszt egy valós adatforráson, két idényen fut; a mért különbség más ligákra/időszakokra nem garantáltan általánosítható.');
  lines.push('- A tesztek sikeressége nem bizonyítja a modell előrejelző pontosságát; erre csak ez a holdout-mérés utal.');
  lines.push('- Szöglet-odds nincs a forrásban, ezért value/megtérülés nem mérhető.');

  const outDir = path.join(root, 'docs', 'corners');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'backtest-report.md'), lines.join('\n') + '\n', 'utf8');
  writeFileSync(path.join(outDir, 'backtest-result.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), months: [FIRST_MONTH, LAST_MONTH], requests, matches: idx.all.length,
    coverage, tune: { period: TUNE, targets: tuneTargets.length, best, table: tuning.table },
    holdout: { period: HOLD, targets: hold.targets, eligible: hold.eligible, skipped: hold.skipped, overall, byScope, byLeague, ci: { logLoss: ciLL, brier: ciBr, byScope: ciScope }, calibration: { model: calModel, baseline: calBase } },
    independence: { pearson: corr, n: hm.length }, gate,
  }, null, 1), 'utf8');
  console.log(`[kapu] ${gate.passed ? 'ÁTMENT' : 'NEM MENT ÁT'}`);
  for (const r of gate.reasons) console.log('  -', r);
  console.log(`[holdout] értékelhető meccs: ${hold.eligible}; log loss Δ ${f(ciLL.mean, 5)} [${f(ciLL.lo, 5)}, ${f(ciLL.hi, 5)}]; Brier Δ ${f(ciBr.mean, 5)}`);
  // a holdout rekordjait nem használjuk semmilyen döntésre a kapun kívül
  void (hold.records as EvalRecord[]);
}

main().catch((e) => { console.error(e); process.exit(1); });
