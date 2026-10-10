/**
 * 0014 + 0015 + 0016 – valódi PostgreSQL 17 integráció a PostgREST-hívások
 * SQL-szintű megfelelőivel, egy EGYSZER HASZNÁLATOS, LOKÁLIS adatbázison.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA. Csak kifejezett kérésre fut:
 *   TIPARCHIVE_PG_TEST=1 PGPASSWORD=… [PSQL=/út/a/psql] npx vitest run tests/modelLearning.pg.test.ts
 *
 * Mit ellenőriz:
 *  1) SZERZŐDÉS: a `Postgres*Store` FORRÁSKÓDJÁBÓL kinyert minden tábla/nézet,
 *     oszlop (select, szűrés, rendezés, beszúrás, frissítés) és RPC létezik a
 *     migrált sémában, és a `service_role`-nak megvan hozzá a szükséges joga.
 *  2) MŰVELETEK: a PostgREST által generált utasítások SQL-megfelelői
 *     `service_role` szerepben (beszúrás ütközés-kezeléssel, feltételes
 *     frissítések, nézet-lapozás, RPC), az RLS és a triggerek mellett.
 * Mit NEM: a PostgREST HTTP-rétegét (URL-szintaxis, `or=` idézés, max-rows,
 * séma-gyorsítótár) – ahhoz PostgREST kellene, ez itt NEM ELLENŐRZÖTT.
 *
 * IZOLÁCIÓ: a gép kódba írva 127.0.0.1; a kapcsolatot átirányítani képes
 * libpq-változók (PGHOSTADDR, PGSERVICE, PGSERVICEFILE, PGDATABASE) a
 * gyerekfolyamatból TÖRÖLVE; az adatbázis neve rögzített és eldobható.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1';
const DB = 'tippstats_v1_pgaudit';
const PSQL = process.env.PSQL || 'psql';
const file = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function psql(db: string, sql: string, opts: { role?: string; args?: string[] } = {}): { ok: boolean; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: HOST, PGDATABASE: db, PGCLIENTENCODING: 'UTF8' };
  for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete env[k];
  try {
    const out = execFileSync(PSQL, ['-h', HOST, '-U', process.env.PGUSER || 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-F', '|',
      '-v', 'ON_ERROR_STOP=1', ...(opts.args ?? [])], {
      encoding: 'utf8', input: opts.role ? `set role ${opts.role};\n${sql}` : sql, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    return { ok: true, out: out.replace(/\r/g, '').trim(), err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(x.stdout ?? '').trim(), err: String(x.stderr ?? '') };
  }
}
const sql = (q: string, role?: string) => psql(DB, q, { role });
const must = (q: string, role?: string) => { const r = sql(q, role); if (!r.ok) throw new Error(r.err); return r.out; };

// ---------------------------------------------------------------------------
// A PostgREST-műveletek kinyerése a forráskódból
// ---------------------------------------------------------------------------

interface Op { file: string; rel: string; kind: 'select' | 'insert' | 'update'; cols: string[] }

function extractOps(path: string, consts: Record<string, string>): { ops: Op[]; rpcs: { name: string; params: string[] }[] } {
  const src = readFileSync(file(path), 'utf8');
  const pg = src.slice(src.indexOf('export class Postgres'), src.indexOf('// SQLite'));
  const ops: Op[] = [];
  const rels = (expr: string): string[] => {
    const names = expr.match(/'[^']+'|[A-Z_]+/g) ?? [];
    // csak táblanév-konstans vagy 'model_*' literál számít relációnak (pl. a `scope === 'counted'` nem)
    return names.map((n) => (n.startsWith("'") ? n.slice(1, -1) : consts[n])).filter((n): n is string => !!n && n.startsWith('model_'));
  };
  const keysOf = (obj: string) => [...obj.matchAll(/(?:^|[\s,{(])([a-z_]+)\s*:/g)].map((m) => m[1]);
  for (const m of pg.matchAll(/this\.db\.from\(([^)]*)\)([\s\S]*?);\s*\n/g)) {
    const [, relExpr, chain] = m;
    const targets = rels(relExpr);
    if (!targets.length) continue; // változó tábla (pl. healthCheck ciklus) – külön ellenőrizve
    const sel = [...chain.matchAll(/\.select\('([^']*)'/g)].flatMap((x) => x[1].split(',').map((c) => c.trim())).filter((c) => c && c !== '*');
    const filters = [...chain.matchAll(/\.(?:eq|neq|lt|gte|in|order|ilike)\('([a-z_]+)'/g)].map((x) => x[1]);
    const or = [...chain.matchAll(/\.or\(`([^`]*)`\)/g)].flatMap((x) => [...x[1].matchAll(/([a-z_]+)\.(?:is|lt|eq|gt)\./g)].map((y) => y[1]));
    const upd = [...chain.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].flatMap((x) => keysOf(x[1]));
    const ins = [...chain.matchAll(/\.(?:insert|upsert)\(\{([\s\S]*?)\}\s*(?:,|\))/g)].flatMap((x) => keysOf(x[1]).filter((k) => k !== 'onConflict' && k !== 'ignoreDuplicates'));
    const upsertDrafts = /\.upsert\(rows\.map\(draftToPg\)/.test(chain);
    for (const rel of targets) {
      ops.push({ file: path, rel, kind: 'select', cols: [...new Set([...sel, ...filters, ...or])] });
      if (upd.length) ops.push({ file: path, rel, kind: 'update', cols: [...new Set(upd)] });
      if (ins.length) ops.push({ file: path, rel, kind: 'insert', cols: [...new Set(ins)] });
      if (upsertDrafts) {
        const d = src.slice(src.indexOf('function draftToPg'), src.indexOf('export class Postgres'));
        ops.push({ file: path, rel, kind: 'insert', cols: [...new Set(keysOf(d.slice(d.indexOf('return {'))))] });
      }
    }
  }
  // a közös szűrő mindkét listázó nézeten
  const af = pg.slice(pg.indexOf('private applyFilter'), pg.indexOf('async latestVersions'));
  const afCols = [...af.matchAll(/\.(?:eq|lt|gte|in|ilike)\('([a-z_]+)'/g)].map((x) => x[1]);
  if (afCols.length) for (const rel of ['model_tip_archive_listing', 'model_tip_archive_counted_listing']) ops.push({ file: path, rel, kind: 'select', cols: [...new Set(afCols)] });
  const rpcs = [...pg.matchAll(/this\.db\.rpc\('([a-z_]+)',\s*\{([\s\S]*?)\}\)/g)].map((x) => ({ name: x[1], params: keysOf(x[2]) }));
  return { ops, rpcs };
}

const ARCHIVE_CONSTS = {
  TABLE: 'model_tip_archive', STATE: 'model_tip_archive_match_state', COUNTED: 'model_tip_archive_counted',
  LISTING: 'model_tip_archive_listing', COUNTED_LISTING: 'model_tip_archive_counted_listing',
};

// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('V1 – PostgreSQL 17 szerződés és műveletek (lokális, eldobható DB)', () => {
  beforeAll(() => {
    for (const q of [`drop database if exists ${DB}`, `create database ${DB}`]) {
      const r = psql('postgres', q);
      if (!r.ok) throw new Error(r.err);
    }
    must(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema auth; create table auth.users (id uuid primary key);
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
    const apply = (p: string) => { const r = psql(DB, readFileSync(file(p), 'utf8'), { args: ['--single-transaction'] }); if (!r.ok) throw new Error(`${p}: ${r.err}`); };
    apply('../supabase/migrations/0014_model_tip_archive.sql');
    // „történeti” sorok a 0016 ELŐTT – a production jelenlegi állapotának megfelelője
    must(`
      insert into public.model_tip_archive (match_id, market, version_no, content_hash, engine_version, generated_at, origin,
        match_label, league_id, league_name, kickoff, market_label, market_type, category, model_prob, data_quality,
        sample_size, supporting_indicators, pre_kickoff)
      values ('legacy1', 'O2.5', 1, repeat('a',64), 'xg-poisson-1', '2026-10-01T10:00Z', 'live', 'A – B', 'L1', 'Liga',
        '2026-10-01T18:00Z', 'x', 'gólszám', 'mérsékelt', 0.61, 'magas', 10, 2, true);
      update public.model_tip_archive set settlement_status = 'won', home_goals = 3, away_goals = 1, settled_at = now(),
        result_kickoff = '2026-10-01T18:00Z' where match_id = 'legacy1';`);
    for (const p of ['../supabase/migrations/0015_model_learning.sql', '../supabase/migrations/0016_tip_archive_provenance.sql',
      '../supabase/migrations/0015_model_learning.sql', '../supabase/migrations/0016_tip_archive_provenance.sql']) apply(p);
  });

  it('SZERZŐDÉS: a forráskód minden PostgREST-oszlopa létezik, és a service_role-nak megvan a joga', () => {
    const a = extractOps('../src/server/tipArchive/store.ts', ARCHIVE_CONSTS);
    const l = extractOps('../src/server/modelLearning/store.ts', {});
    const ops = [...a.ops, ...l.ops];
    // a kinyerés valóban megtalálta a hívásokat (különben a teszt üres lenne)
    expect(ops.filter((o) => o.kind === 'select').length).toBeGreaterThanOrEqual(20);
    expect(ops.filter((o) => o.kind === 'insert').map((o) => o.rel).sort()).toEqual(['model_calibration_versions', 'model_learning_events', 'model_tip_archive']);
    expect(ops.filter((o) => o.kind === 'update').map((o) => o.rel).sort()).toEqual([
      'model_calibration_versions', 'model_learning_state', 'model_learning_state', 'model_learning_state', 'model_tip_archive']);
    const archiveInsert = ops.find((o) => o.kind === 'insert' && o.rel === 'model_tip_archive')!;
    expect(archiveInsert.cols).toEqual(expect.arrayContaining(['provenance', 'served_prob', 'served_model', 'model_prob', 'engine_version']));

    const problems: string[] = [];
    for (const o of ops) {
      for (const c of o.cols) {
        const priv = o.kind === 'select' ? 'SELECT' : o.kind === 'insert' ? 'INSERT' : 'UPDATE';
        const r = sql(`select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${o.rel}' and column_name = '${c}')
          and has_column_privilege('service_role', 'public.${o.rel}', '${c}', '${priv}')`);
        if (r.out !== 't') problems.push(`${o.kind} ${o.rel}.${c} (${priv})`);
      }
    }
    expect(problems).toEqual([]);

    // RPC: név, paraméternevek sorrendben, EXECUTE jog
    expect(a.rpcs).toEqual([{ name: 'model_tip_archive_observe', params: ['p_match_id', 'p_kickoff', 'p_status', 'p_observed_at'] }]);
    expect(must(`select array_to_string(proargnames, ',') from pg_proc where proname = 'model_tip_archive_observe'`)).toBe('p_match_id,p_kickoff,p_status,p_observed_at');
    expect(must(`select has_function_privilege('service_role', 'public.model_tip_archive_observe(text,timestamptz,text,timestamptz)', 'EXECUTE')`)).toBe('t');
    // a health check változó-táblás lekérdezései
    for (const rel of Object.values(ARCHIVE_CONSTS)) expect(must(`select has_table_privilege('service_role', 'public.${rel}', 'SELECT')`), rel).toBe('t');
  });

  it('régi sor: „legacy_baseline”, kiszolgált érték nélkül, és megváltoztathatatlan', () => {
    expect(must(`select provenance || '|' || coalesce(served_prob::text, 'null') || '|' || coalesce(served_model, 'null') || '|' || model_prob from model_tip_archive where match_id = 'legacy1'`))
      .toBe('legacy_baseline|null|null|0.61');
    for (const q of [`update model_tip_archive set provenance = 'recorded', served_prob = 0.61, served_model = 'xg-poisson-1' where match_id = 'legacy1'`,
      `update model_tip_archive set model_prob = 0.7 where match_id = 'legacy1'`, `delete from model_tip_archive where match_id = 'legacy1'`]) {
      expect(sql(q, 'service_role').ok, q).toBe(false);
    }
  });

  const insertDraft = (rows: { match: string; market: string; v: number; prob: number; served: number | null; model: string | null; prov?: string }[]) => `
    insert into model_tip_archive (match_id, market, version_no, content_hash, engine_version, generated_at, origin, match_label,
      league_id, league_name, kickoff, market_label, market_type, category, model_prob, odds_at_generation, implied_prob, data_quality,
      sample_size, supporting_indicators, pre_kickoff, availability, provenance, served_prob, served_model)
    values ${rows.map((r) => `('${r.match}', '${r.market}', ${r.v}, repeat('b', 64), 'xg-poisson-1', '2026-10-02T10:00Z', 'live', 'C – D',
      'L1', 'Liga', '2026-10-02T18:00Z', 'x', 'gólszám', 'mérsékelt', ${r.prob}, null, null, 'magas', 10, 2, true, 'pro_on_request',
      '${r.prov ?? 'recorded'}', ${r.served ?? 'null'}, ${r.model ? `'${r.model}'` : 'null'})`).join(',\n')}
    on conflict (match_id, market, version_no) do nothing returning market`;

  it('provenance-beszúrás (a PostgREST upsert ignore-duplicates megfelelője): helyes alap-motor sor; ütközés → 0 sor', () => {
    expect(must(insertDraft([{ match: 'n1', market: 'O2.5', v: 1, prob: 0.55, served: 0.55, model: 'xg-poisson-1' }]), 'service_role')).toBe('O2.5');
    expect(must(insertDraft([{ match: 'n1', market: 'O2.5', v: 1, prob: 0.55, served: 0.55, model: 'xg-poisson-1' }]), 'service_role')).toBe('');
    expect(must(`select provenance || '|' || served_model || '|' || (served_prob = model_prob) from model_tip_archive where match_id = 'n1'`)).toBe('recorded|xg-poisson-1|true');
  });

  it('hibás provenance-írás: a TELJES utasítás elbukik, egyetlen sor sem kerül be (nincs csendes részleges írás)', () => {
    const r = sql(insertDraft([
      { match: 'n2', market: 'O2.5', v: 1, prob: 0.5, served: 0.5, model: 'xg-poisson-1' },     // helyes
      { match: 'n2', market: '1X', v: 1, prob: 0.5, served: 0.6, model: 'xg-poisson-1' },       // alap motor, de eltérő érték
    ]), 'service_role');
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/model_tip_archive_provenance/);
    expect(must(`select count(*) from model_tip_archive where match_id = 'n2'`)).toBe('0');
    for (const bad of [
      { match: 'n3', market: 'O2.5', v: 1, prob: 0.5, served: 0.5, model: null },
      { match: 'n3', market: 'O2.5', v: 1, prob: 0.5, served: 0.5, model: 'masik-motor' },
      { match: 'n3', market: 'O2.5', v: 1, prob: 0.5, served: 0.5, model: 'xg-poisson-1', prov: 'legacy_baseline' },
    ]) expect(sql(insertDraft([bad]), 'service_role').ok).toBe(false);
    // ütközésnél is ellenőrzött (a CHECK az ütközés-vizsgálat előtt fut)
    expect(sql(insertDraft([{ match: 'n1', market: 'O2.5', v: 1, prob: 0.55, served: 0.9, model: 'xg-poisson-1' }]), 'service_role').ok).toBe(false);
  });

  it('kalibrált kiszolgálás formátuma elfogadott (jövőbeli képesség), és az is megváltoztathatatlan', () => {
    expect(must(insertDraft([{ match: 'n4', market: 'O2.5', v: 1, prob: 0.55, served: 0.53, model: 'xg-poisson-1+cal-0123456789ab' }]), 'service_role')).toBe('O2.5');
    expect(sql(`update model_tip_archive set served_prob = 0.6 where match_id = 'n4'`, 'service_role').ok).toBe(false);
  });

  it('RPC + elszámolás + statisztikai nézet: a tanító olvasás (loadArchive) oszlopai és lapozása', () => {
    must(`select model_tip_archive_observe('n1', '2026-10-02T18:00Z', 'finished', '2026-10-02T21:00Z')`, 'service_role');
    expect(must(`with u as (update model_tip_archive set settlement_status = 'won', home_goals = 1, away_goals = 0, result_kickoff = '2026-10-02T18:00Z',
      settled_at = now() where match_id = 'n1' and settlement_status = 'pending' and market in ('O2.5') returning id) select count(*) from u`, 'service_role')).toBe('1');
    const cols = 'id, match_id, market, market_type, league_id, generated_at, kickoff, result_kickoff, model_prob, settlement_status, engine_version, origin, pre_kickoff, home_goals, away_goals, provenance, served_prob, served_model';
    const page = (limit: number, offset: number) => must(`select match_id || ':' || provenance from (select ${cols} from model_tip_archive_counted
      where engine_version = 'xg-poisson-1' and origin = 'live' order by kickoff asc, id asc limit ${limit} offset ${offset}) x`, 'service_role');
    const all = page(1000, 0).split('\n');
    expect(all).toEqual(expect.arrayContaining(['legacy1:legacy_baseline', 'n1:recorded']));
    // determinisztikus lapozás: két 1-es lap = az első két sor
    expect([page(1, 0), page(1, 1)]).toEqual(all.slice(0, 2));
  });

  it('tanulási állapot: zár, lezárás, CAS, jelölt (ütközés-kezeléssel), állapotváltás, esemény – service_role szerepben', () => {
    const now = "'2026-10-10T12:00:00.000Z'";
    const upd = (q: string) => must(`with u as (${q} returning id) select count(*) from u`, 'service_role');
    expect(upd(`update model_learning_state set lock_owner = 'o1', lock_until = '2026-10-10T12:10:00Z', last_run_started_at = ${now},
      last_run_status = 'running', last_run_error = null, updated_at = ${now} where id = 1 and (lock_until is null or lock_until < ${now})`)).toBe('1');
    expect(upd(`update model_learning_state set lock_owner = 'o2' where id = 1 and (lock_until is null or lock_until < ${now})`)).toBe('0');
    expect(upd(`update model_learning_state set lock_owner = null, lock_until = null, last_run_finished_at = ${now}, last_run_status = 'succeeded',
      last_run_error = null, last_run_summary = '{"outcome":"insufficient_data"}'::jsonb, updated_at = ${now} where id = 1 and lock_owner = 'o1'`)).toBe('1');
    const ins = `insert into model_calibration_versions (id, base_engine_version, method, params, data_fingerprint, training_window, metrics, gate_result, status, status_reason)
      values ('cal-abcdefabcdef', 'xg-poisson-1', 'platt-shrunk-v1', '{"global":{"a":0,"b":1},"byMarketType":{},"lambda":8}', repeat('f',64), '{}', '{}',
      '{"passed":true,"reasons":[]}', 'shadow', 'árnyék') on conflict (id) do nothing returning id`;
    expect(must(ins, 'service_role')).toBe('cal-abcdefabcdef');
    expect(must(ins, 'service_role')).toBe('');
    expect(upd(`update model_calibration_versions set status = 'eligible', status_reason = 'ok', status_changed_at = ${now} where id = 'cal-abcdefabcdef' and status in ('shadow')`)).toBe('1');
    expect(upd(`update model_learning_state set active_model_id = 'cal-abcdefabcdef', previous_model_id = null, state_version = 1, updated_at = ${now} where id = 1 and state_version = 0`)).toBe('1');
    expect(upd(`update model_learning_state set active_model_id = null, state_version = 1 where id = 1 and state_version = 0`)).toBe('0');
    // esemény: a supabase-js insert (return=minimal) csak INSERT jogot igényel; módosítani nem lehet
    must(`insert into model_learning_events (kind, model_id, actor, details) values ('shadow_evaluation', 'cal-abcdefabcdef', 'u1', '{"outcome":"passed"}')`, 'service_role');
    expect(sql(`update model_learning_events set kind = 'failure'`, 'service_role').ok).toBe(false);
    expect(must(`select details->>'outcome' from model_learning_events where model_id = 'cal-abcdefabcdef' and kind = 'shadow_evaluation' order by at desc limit 1`, 'service_role')).toBe('passed');
  });

  it('kliens szerepek: semmilyen tábla, nézet vagy RPC nem érhető el (RLS + visszavont jogok)', () => {
    for (const role of ['anon', 'authenticated']) {
      for (const q of ['select 1 from model_tip_archive limit 1', 'select 1 from model_tip_archive_counted limit 1',
        'select 1 from model_tip_archive_listing limit 1', 'select 1 from model_calibration_versions limit 1',
        'select 1 from model_learning_state limit 1', 'select 1 from model_learning_events limit 1',
        `select model_tip_archive_observe('x', now(), 'live', now())`]) {
        const r = sql(q, role);
        expect(r.ok, `${role}: ${q}`).toBe(false);
        expect(r.err).toMatch(/permission denied/);
      }
    }
  });

  it('a 0014 újrafuttatása a 0016 után EGY tranzakcióban elbukik és mindent visszagörget – az őr érintetlen', () => {
    const r = psql(DB, readFileSync(file('../supabase/migrations/0014_model_tip_archive.sql'), 'utf8'), { args: ['--single-transaction'] });
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/cannot change name of view column/);
    expect(must(`select position('served_model' in prosrc) > 0 from pg_proc where proname = 'model_tip_archive_guard'`)).toBe('t');
  });
});
