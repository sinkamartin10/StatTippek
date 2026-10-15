/**
 * Adatlefedettség – az éles (eredeti) és a bővített történeti adatkör összehasonlítása.
 *
 *   npx tsx scripts/coverageAudit.ts --fetch-history   (egyszer: a csak-előzmény hazai bajnokságok havi
 *                                                      scoreboardjai a helyi backtest-cache-be; nyilvános ESPN)
 *   npx tsx scripts/coverageAudit.ts                   (mérés; hálózat nélkül)
 *
 * - Nem tölt be .env-et, nem ír éles adatot. A mérés a VÁLTOZATLAN `analyzeMatch`-et (xg-poisson-1)
 *   futtatja minden adatkörrel – az éles tippek és valószínűségek nem változnak, csak azt mérjük,
 *   hány meccs válna elemezhetővé, és milyen forrásból.
 * - Adatkörök: eredeti / frissen indult szerver, eredeti / bemelegedett szerver, bővített (frissen indult + bővítések).
 * - Minden adat csak a kezdés előtt legalább 3 órával indult meccsekből; egy meccs egyszer.
 * - Kimenet: docs/model-learning/data-coverage/report.md és result.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CacheDb } from '../src/server/db/cacheDb';
import { ESPN_LEAGUES } from '../src/server/data/espnProvider';
import { HISTORY_ONLY_DOMESTIC, dedupeResults, type CoverageReason } from '../src/server/data/historyPlan';
import { analyzeMatch } from '../src/shared/engine/analysis';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import type { League, Match, MatchResult, ResearchResult, Team } from '../src/shared/types';
import { naiveProbs, pairedBootstrap, probsFromPoisson, score, type Probs } from '../src/shared/engine/experimental/crossLeagueEval';
import { COVERED, Index, KINDS, available, loadDataset, type Row } from './lib/espnDataset';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const CACHE = path.join(process.cwd(), 'data', 'corners-backtest-cache.db');
const FIRST_MONTH = '202307', LAST_MONTH = '202606';
const PERIODS: Record<string, readonly [string, string]> = {
  '2024-25': ['2024-07-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z'],
  '2025-26': ['2025-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'],
};

const shiftMonth = (m: string, d: number) => { const y = +m.slice(0, 4), mo = +m.slice(4) - 1 + d; return `${y + Math.floor(mo / 12)}${String(((mo % 12) + 12) % 12 + 1).padStart(2, '0')}`; };

/** Egyszeri letöltés: a csak-előzmény ligák havi scoreboardjai (sorban, szünetekkel; ami már a cache-ben van, kimarad). */
async function fetchHistory() {
  const db = new CacheDb(CACHE);
  const cache = db.httpCache();
  const raw = db.handle();
  let fetched = 0, cached = 0, failed = 0;
  for (const { slug } of Object.values(HISTORY_ONLY_DOMESTIC)) {
    for (let m = FIRST_MONTH; m <= LAST_MONTH; m = shiftMonth(m, 1)) {
      const url = `${BASE}/${slug}/scoreboard?dates=${m}`;
      if (raw.prepare('SELECT 1 FROM http_cache WHERE url = ?').get(url)) { cached++; continue; }
      const res = await fetch(url, { headers: { 'user-agent': 'TIPPMIX-AI/1.0 (personal research tool)', accept: 'application/json' } }).catch(() => null);
      if (!res?.ok) { failed++; console.error(`[letöltés] ${slug} ${m} -> ${res?.status ?? 'hálózati hiba'}`); continue; }
      cache.set(url, JSON.stringify(await res.json()));
      fetched++;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`[letöltés] ${slug}: kész (új: ${fetched}, már megvolt: ${cached}, hiba: ${failed})`);
  }
}

const RESEARCH: ResearchResult = {
  matchId: '', origin: 'live', performedAt: '', provider: 'audit', news: [],
  availability: { home: { teamId: '', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] }, away: { teamId: '', injuries: [], suspensions: [], lineupStatus: 'nincs adat', notes: [] } },
  externalPredictions: [], sources: [], warnings: [],
};
const LEAGUE = new Map(ESPN_LEAGUES.map((l) => [l.id, l]));

function analyze(m: Row, rows: Row[]) {
  const league: League = LEAGUE.get(m.competitionId)!;
  const match: Match = { id: m.id, leagueId: m.competitionId, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, kickoff: m.date, status: 'finished', importance: 'normal', importanceReasons: [], origin: 'live' };
  const results: MatchResult[] = rows.map((r) => ({ id: r.id, leagueId: r.competitionId, date: r.date, homeTeamId: r.homeTeamId, awayTeamId: r.awayTeamId, homeGoals: r.homeGoals, awayGoals: r.awayGoals, origin: 'live' }));
  const team = (id: string): Team => ({ id, name: id, shortName: id, country: '–', leagueId: m.competitionId });
  const a = analyzeMatch({ match, league, homeTeam: team(m.homeTeamId), awayTeam: team(m.awayTeamId), results, odds: null, research: { ...RESEARCH, matchId: m.id }, now: m.date });
  return { ok: !a.insufficientData && !!a.poisson, probs: a.poisson ? probsFromPoisson(a.poisson) : null, form: a.form, leagueMatches: a.leagueAverages.matches };
}

async function main() {
  if (process.argv.includes('--fetch-history')) { await fetchHistory(); return; }
  const t0 = Date.now();
  const { rows, scoreboards, skipped } = loadDataset(CACHE, { includeHistoryOnly: true });
  const ix = new Index(rows);
  const histRows = rows.filter((r) => !COVERED.has(r.competitionId));
  const histByLeague = Object.fromEntries(Object.keys(HISTORY_ONLY_DOMESTIC).map((l) => [l, histRows.filter((r) => r.competitionId === l).length]));
  console.log(`[adat] ${scoreboards} scoreboard · ${rows.length} meccs (ebből csak-előzmény ligákból ${histRows.length})`);

  // naiv alap a minőségi összevetéshez (a sorozat utolsó 365 napja, lezárt meccsek)
  const naive = (m: Row): Probs => {
    const cut = Date.parse(m.date) - 3 * 3600_000, from = cut - 365 * 86_400_000;
    const own = (ix.byComp.get(m.competitionId) ?? []).filter((r) => r.regulation && Date.parse(r.date) <= cut && Date.parse(r.date) > from);
    return naiveProbs(own.length >= 50 ? own : rows.filter((r) => r.regulation && (KINDS[r.competitionId] === 'national') === (KINDS[m.competitionId] === 'national') && Date.parse(r.date) <= cut && Date.parse(r.date) > from));
  };

  type Rec = { m: Row; cold: ReturnType<typeof analyze>; warm: ReturnType<typeof analyze>; ext: ReturnType<typeof analyze>; newSources: CoverageReason[]; extRows: number; coldRows: number; duplicates: number; leak: number; reqCold: number; reqExtra: number };
  const out: Record<string, Rec[]> = {};
  let dupTotal = 0, leakTotal = 0;
  for (const [name, [a, b]] of Object.entries(PERIODS)) {
    const targets = rows.filter((r) => COVERED.has(r.competitionId) && r.regulation && r.date >= a && r.date < b);
    const recs: Rec[] = [];
    for (const m of targets) {
      const c = available(ix, m, { mode: 'cold', extended: false });
      const w = available(ix, m, { mode: 'warm', extended: false });
      const e = available(ix, m, { mode: 'cold', extended: true });
      // egy meccs egyszer + szivárgás-ellenőrzés a bővített adatkörön
      const asResults = e.rows.map((r) => ({ ...r, origin: 'live' as const, leagueId: r.competitionId }));
      const d = dedupeResults(asResults).duplicates;
      const leak = e.rows.filter((r) => Date.parse(r.date) > Date.parse(m.date) - 3 * 3600_000).length;
      dupTotal += d; leakTotal += leak;
      const coldIds = new Set(c.rows.map((r) => r.id));
      const newSources = [...new Set(e.rows.filter((r) => !coldIds.has(r.id)).map((r) => e.sourceOf.get(r.id)!))].sort();
      const reqExtra = [...e.requests].filter((k) => !c.requests.has(k)).length;
      recs.push({ m, cold: analyze(m, c.rows), warm: analyze(m, w.rows), ext: analyze(m, e.rows), newSources, extRows: e.rows.length, coldRows: c.rows.length, duplicates: d, leak, reqCold: c.requests.size, reqExtra });
    }
    out[name] = recs;
    console.log(`[${name}] ${recs.length} célmeccs · elemezhető: eredeti/friss ${recs.filter((r) => r.cold.ok).length}, eredeti/bemelegedett ${recs.filter((r) => r.warm.ok).length}, bővített ${recs.filter((r) => r.ext.ok).length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  // ---- jelentés ----
  const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'n. a.');
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
  const ci = (c: { mean: number; lo: number; hi: number; n: number }) => (c.n ? `${f(c.mean, 5)} (95% CI ${f(c.lo, 5)} … ${f(c.hi, 5)}; n=${c.n})` : '–');
  const L: string[] = [];
  L.push('# Adatlefedettség – eredeti és bővített történeti adatkör', '');
  L.push(`Futtatva: ${new Date().toISOString()} · éles modell: \`${ENGINE_VERSION}\` (VÁLTOZATLAN – minden adatkörre ugyanaz a kód fut). Adat: ${scoreboards} havi ESPN-scoreboard a helyi cache-ből, ${rows.length} befejezett meccs, ebből a csak-előzmény hazai bajnokságokból ${histRows.length}. Kihagyva: ${Object.entries(skipped).map(([k, v]) => `${k}: ${v}`).join(', ')}.`, '');
  L.push('Adatkörök:', '');
  L.push('- **eredeti / frissen indult szerver**: amit az éles `getResultsForAnalysis` letölt, ha a szerver épp elindult (csak az aktuális idény csapatlistái ismertek) – alsó korlát;');
  L.push('- **eredeti / bemelegedett szerver**: ugyanez, miután a szerver korábbi elemzésekhez már letöltötte a ligák előző idényeit, és a csapatokat azokhoz a sorozatokhoz is hozzárendelte – felső korlát. Az éles lefedettség a folyamat előzményeitől függ (a Render minden deploy és alvás után újraindul);');
  L.push('- **bővített**: frissen indult szerver + a `historyPlan` bővítései (determinisztikus, a folyamat előzményeitől független).', '');
  L.push(`Ellenőrzések a bővített adatkörön: duplikált meccs **${dupTotal}**, a kezdés előtti 3 órán belüli vagy későbbi meccs **${leakTotal}**.`, '');

  for (const [name, recs] of Object.entries(out)) {
    const n = recs.length;
    const cOk = recs.filter((r) => r.cold.ok).length, wOk = recs.filter((r) => r.warm.ok).length, eOk = recs.filter((r) => r.ext.ok).length;
    const gained = recs.filter((r) => !r.cold.ok && r.ext.ok);
    const lost = recs.filter((r) => r.cold.ok && !r.ext.ok);
    L.push(`## ${name}: ${n} célmeccs`, '');
    L.push('| adatkör | elemezhető | kevés adat |', '|---|---|---|');
    L.push(`| eredeti / frissen indult | ${cOk} (${pct(cOk, n)}) | ${n - cOk} |`);
    L.push(`| eredeti / bemelegedett | ${wOk} (${pct(wOk, n)}) | ${n - wOk} |`);
    L.push(`| bővített | **${eOk} (${pct(eOk, n)})** | ${n - eOk} |`);
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    L.push('', `Újonnan elemezhető (frissen indult → bővített): **${gained.length}**; elemezhetőségét elvesztő: ${lost.length}.`, '');
    L.push(`Terhelés (egyedi csapat-menetrend kérés meccsenként, cache nélkül): eredeti átlagosan ${avg(recs.map((r) => r.reqCold)).toFixed(1)}, a bővítés többlete átlagosan ${avg(recs.map((r) => r.reqExtra)).toFixed(1)} (kupameccsen ${avg(recs.filter((r) => KINDS[r.m.competitionId] === 'club_intl').map((r) => r.reqExtra)).toFixed(1)}). A lezárt idények menetrendje nem változik, ezért ezek hosszú ideig cache-elhetők.`, '');
    L.push('### Sorozatonként', '', '| sorozat | célmeccs | eredeti friss | eredeti bemeleg. | bővített | új |', '|---|---|---|---|---|---|');
    for (const c of [...new Set(recs.map((r) => r.m.competitionId))].sort()) {
      const cr = recs.filter((r) => r.m.competitionId === c);
      L.push(`| ${c} | ${cr.length} | ${cr.filter((r) => r.cold.ok).length} | ${cr.filter((r) => r.warm.ok).length} | ${cr.filter((r) => r.ext.ok).length} | ${cr.filter((r) => !r.cold.ok && r.ext.ok).length} |`);
    }
    L.push('', '### Az újonnan elemezhető meccsek – milyen forrás hozta az új adatot', '', '| forrás (bővítés) | meccs, amelynél új adatot hozott |', '|---|---|');
    const srcCount: Record<string, number> = {};
    for (const r of gained) for (const s of r.newSources) srcCount[s] = (srcCount[s] ?? 0) + 1;
    for (const [k, v] of Object.entries(srcCount).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
    // a megmaradó „kevés adat” okai
    const remaining = recs.filter((r) => !r.ext.ok);
    const cause = (r: Rec): string => {
      const fails: string[] = [];
      for (const [t, f10, venue] of [[r.m.homeTeamId, r.ext.form.homeLast10, r.ext.form.homeAtHome], [r.m.awayTeamId, r.ext.form.awayLast10, r.ext.form.awayAtAway]] as const) {
        if (f10.sampleSize >= 3 && venue.sampleSize >= 3) continue;
        const comps = [...(ix.part.get(t)?.keys() ?? [])];
        const intlOnlyClub = KINDS[r.m.competitionId] === 'club_intl' && !comps.some((c) => KINDS[c] === 'domestic');
        fails.push(intlOnlyClub ? 'a_hazai_bajnoksag_nem_erheto_el_az_espn_ben' : f10.sampleSize < 3 ? 'valoban_keves_meccs_a_forrasban' : 'kuszob_hazai_idegen_bontas');
      }
      if (!fails.length && r.ext.leagueMatches < 10) fails.push('kuszob_liga_atlag');
      return [...new Set(fails)].sort().join('+') || 'egyeb';
    };
    const remCause: Record<string, number> = {};
    for (const r of remaining) { const k = cause(r); remCause[k] = (remCause[k] ?? 0) + 1; }
    L.push('', '### A bővítés után is „kevés adat” – miért', '', '| ok | meccs |', '|---|---|');
    for (const [k, v] of Object.entries(remCause).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
    // minőség: az új meccseken a (változatlan) modell vs naiv alap; a korábban is elemzetteken a bővített vs eredeti adat
    const llGain = pairedBootstrap(gained.map((r) => score(r.ext.probs!, r.m).ll1x2 - score(naive(r.m), r.m).ll1x2), 2000, 5);
    const o25Gain = pairedBootstrap(gained.map((r) => score(r.ext.probs!, r.m).llO25 - score(naive(r.m), r.m).llO25), 2000, 6);
    const both = recs.filter((r) => r.cold.ok && r.ext.ok);
    const llBoth = pairedBootstrap(both.map((r) => score(r.ext.probs!, r.m).ll1x2 - score(r.cold.probs!, r.m).ll1x2), 2000, 7);
    const o25Both = pairedBootstrap(both.map((r) => score(r.ext.probs!, r.m).llO25 - score(r.cold.probs!, r.m).llO25), 2000, 8);
    L.push('', '### Minőség (tájékoztató – a modell NEM változik)', '');
    L.push(`- Az újonnan elemezhető meccseken a változatlan xg-poisson-1 a naiv alaphoz képest: Δ 1X2 log loss ${ci(llGain)}; Δ O2,5 log loss ${ci(o25Gain)} (negatív = a modell jobb).`);
    L.push(`- A korábban is elemezhető meccseken a bővített adat az eredetihez képest: Δ 1X2 log loss ${ci(llBoth)}; Δ O2,5 log loss ${ci(o25Both)} (negatív = a bővített adattal jobb).`, '');
  }
  L.push('## Csak-előzmény hazai bajnokságok a cache-ben', '', '| liga | meccs |', '|---|---|');
  for (const [l, v] of Object.entries(histByLeague)) L.push(`| ${l} (${HISTORY_ONLY_DOMESTIC[l].slug}) | ${v} |`);
  L.push('', 'Az ESPN-ben a kipróbált azonosítókkal NEM érhető el (pl. cseh, lengyel, horvát, szerb, ukrán, magyar, bolgár, szlovák bajnokság) – ezek klubjainál az adat ténylegesen nem hozzáférhető ebből a forrásból.', '');

  const outDir = path.join(process.cwd(), 'docs', 'model-learning', 'data-coverage');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'report.md'), L.join('\n') + '\n', 'utf8');
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), engine: ENGINE_VERSION, scoreboards, matches: rows.length, historyOnly: histByLeague, duplicates: dupTotal, leaks: leakTotal,
    periods: Object.fromEntries(Object.entries(out).map(([k, recs]) => [k, {
      targets: recs.length, cold: recs.filter((r) => r.cold.ok).length, warm: recs.filter((r) => r.warm.ok).length, extended: recs.filter((r) => r.ext.ok).length,
      gained: recs.filter((r) => !r.cold.ok && r.ext.ok).length, lost: recs.filter((r) => r.cold.ok && !r.ext.ok).length,
      byCompetition: Object.fromEntries([...new Set(recs.map((r) => r.m.competitionId))].sort().map((c) => { const cr = recs.filter((r) => r.m.competitionId === c); return [c, { targets: cr.length, cold: cr.filter((r) => r.cold.ok).length, warm: cr.filter((r) => r.warm.ok).length, extended: cr.filter((r) => r.ext.ok).length }]; })),
    }])),
  }, null, 1), 'utf8');
  console.log(`[kész] ${((Date.now() - t0) / 1000).toFixed(0)} s · duplikátum ${dupTotal} · szivárgás ${leakTotal}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
