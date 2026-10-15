/**
 * 0021 – a több ligás modell tartós tanítóadata a VALÓDI PostgreSQL 17-en (helyi, ELDOBHATÓ DB):
 * megszorítások, jogok, append-only becslésnapló, és a valódi PostgresXsStore olvasó útjai
 * (a SqlRest PostgREST-utánzattal, service_role szerepben).
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut, és
 * pozitívan ellenőrzi, hogy a szerver 127.0.0.1 – különben nem ír semmit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SqlRest } from './helpers/sqlRest';
import { PostgresXsStore } from '../src/server/model/xsStore';
import { XsModelService, type MonthlyResultsSource } from '../src/server/model/xsService';
import { XS_TRAINING_COMPETITIONS } from '../src/server/model/xsCompetitions';
import type { ScoreboardResult } from '../src/server/data/scoreboardResults';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_xs_training';
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${n}`, import.meta.url)), 'utf8');
const VERIFY = readFileSync(fileURLToPath(new URL('../docs/model-learning/xs-production/verify_0021.sql', import.meta.url)), 'utf8');
/** a valódi PostgresXsStore, a PostgREST-utánzaton át service_role szerepben (opcionális max-rows emulációval) */
function pgStore(maxRows?: number): PostgresXsStore {
  const store = new PostgresXsStore('http://127.0.0.1:9', 'helyi-teszt-kulcs-nem-titok');
  (store as unknown as { db: unknown }).db = new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role', maxRows });
  return store;
}

function psql(db: string, sql: string, extra: string[] = []): { ok: boolean; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: HOST, PGDATABASE: db, PGCLIENTENCODING: 'UTF8' };
  for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete env[k];
  try {
    const out = execFileSync(PSQL, ['-h', HOST, '-U', process.env.PGUSER || 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra],
      { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'], env });
    return { ok: true, out: out.replace(/\r/g, '').trim(), err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(x.stdout ?? ''), err: String(x.stderr ?? '') };
  }
}
const must = (sql: string, db = DB) => { const r = psql(db, sql); if (!r.ok) throw new Error(r.err); return r.out; };
const asService = (sql: string) => `set role service_role; ${sql}`;

describe.skipIf(!ENABLED)('0021 xs-strength-1 tanítóadat – valódi PostgreSQL 17 (helyi, eldobható DB)', () => {
  beforeAll(() => {
    const [addr, ver] = must(`select inet_server_addr()::text || '|' || current_setting('server_version_num')`, 'postgres').split('|');
    if (!addr.startsWith('127.0.0.1') && !addr.startsWith('::1')) throw new Error(`nem helyi szerver: ${addr}`);
    if (Number(ver) < 170000) throw new Error(`PostgreSQL 17 kell, ez: ${ver}`);
    must(`drop database if exists ${DB}`, 'postgres');
    must(`create database ${DB}`, 'postgres');
    must(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema auth; create table auth.users (id uuid primary key);
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
    for (const n of ['0014_model_tip_archive.sql', '0015_model_learning.sql', '0021_xs_model_training.sql', '0021_xs_model_training.sql']) {
      const r = psql(DB, mig(n), ['--single-transaction']);
      if (!r.ok) throw new Error(`${n}: ${r.err}`);
    }
  });

  it('meccsenként egy sor (ESPN-azonosító), megszorítások: azonosító-formátum, önmaga elleni meccs, negatív gól, hónap-formátum', () => {
    must(asService(`insert into public.xs_training_matches (id, competition_id, match_date, home_team_id, away_team_id, home_goals, away_goals, regulation, source_month)
      values ('espn-eng.1-1001', 'eng-pl', '2026-09-01T14:00:00Z', 'espn-1', 'espn-2', 2, 1, true, '202609')
      on conflict (id) do update set home_goals = excluded.home_goals;`));
    // ugyanaz az esemény újra → nem duplikál
    must(asService(`insert into public.xs_training_matches (id, competition_id, match_date, home_team_id, away_team_id, home_goals, away_goals, regulation, source_month)
      values ('espn-eng.1-1001', 'eng-pl', '2026-09-01T14:00:00Z', 'espn-1', 'espn-2', 2, 1, true, '202609') on conflict (id) do update set home_goals = excluded.home_goals;`));
    expect(must(`select count(*) from public.xs_training_matches`)).toBe('1');
    for (const bad of [
      `('nem-espn', 'eng-pl', now(), 'espn-1', 'espn-2', 1, 0, true, '202609')`,
      `('espn-eng.1-2', 'eng-pl', now(), 'espn-1', 'espn-1', 1, 0, true, '202609')`,
      `('espn-eng.1-3', 'eng-pl', now(), 'espn-1', 'espn-2', -1, 0, true, '202609')`,
      `('espn-eng.1-4', 'eng-pl', now(), 'espn-1', 'espn-2', 1, 0, true, '2026-09')`,
    ]) expect(psql(DB, asService(`insert into public.xs_training_matches (id, competition_id, match_date, home_team_id, away_team_id, home_goals, away_goals, regulation, source_month) values ${bad};`)).ok, bad).toBe(false);
  });

  it('becslésnapló: append-only, determinisztikus azonosító (64 hex), csak xs-strength-1', () => {
    const fit = 'a'.repeat(64);
    must(asService(`insert into public.xs_model_fits (fit_id, model_id, cutoff, closed_hours, params, dataset_sha256, trained_matches, sweeps)
      values ('${fit}', 'xs-strength-1', now(), 3, '{"halfLifeDays":365}', '${'b'.repeat(64)}', 100, 10) on conflict (fit_id) do nothing;`));
    expect(psql(DB, asService(`update public.xs_model_fits set sweeps = 0;`)).err).toMatch(/permission denied/);
    expect(psql(DB, `update public.xs_model_fits set sweeps = 0;`).err).toMatch(/nem módosíthatók/);
    expect(psql(DB, `delete from public.xs_model_fits;`).err).toMatch(/nem törölhetők/);
    expect(psql(DB, asService(`insert into public.xs_model_fits (fit_id, model_id, cutoff, closed_hours, params, dataset_sha256, trained_matches, sweeps) values ('${'c'.repeat(64)}', 'xg-poisson-1', now(), 3, '{}', '${'b'.repeat(64)}', 1, 1);`)).ok).toBe(false);
  });

  it('jogok: anon/authenticated semmit nem ér el; service_role nem töröl', () => {
    for (const role of ['anon', 'authenticated']) {
      for (const t of ['xs_training_matches', 'xs_training_months', 'xs_model_fits']) {
        expect(psql(DB, `set role ${role}; select 1 from public.${t} limit 1;`).err, `${role} ${t}`).toMatch(/permission denied/);
      }
    }
    expect(psql(DB, asService(`delete from public.xs_training_matches;`)).err).toMatch(/permission denied/);
    expect(must(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_name = 'xs_model_fits' and grantee = 'service_role'`)).toBe('INSERT,SELECT');
  });

  it('a VALÓDI PostgresXsStore olvasó útjai a migrált sémán: hónapok, meccsek (lapozva), becslésnapló (idempotens)', async () => {
    must(asService(`insert into public.xs_training_months (competition_id, month, closed, match_count) values ('eng-pl', '202609', true, 1) on conflict do nothing;`));
    const store = new PostgresXsStore('http://127.0.0.1:9', 'helyi-teszt-kulcs-nem-titok');
    (store as unknown as { db: unknown }).db = new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role' });
    expect(await store.months()).toEqual(new Map([['eng-pl|202609', true]]));
    const rows = await store.loadMatches('2026-01-01T00:00:00.000Z');
    expect(rows).toEqual([{ id: 'espn-eng.1-1001', competitionId: 'eng-pl', date: '2026-09-01T14:00:00.000Z', homeTeamId: 'espn-1', awayTeamId: 'espn-2', homeGoals: 2, awayGoals: 1, regulation: true }]);
    const f = { fitId: 'd'.repeat(64), modelId: 'xs-strength-1' as const, cutoff: '2026-10-15T10:00:00.000Z', closedHours: 3, params: { halfLifeDays: 365 }, datasetSha256: 'e'.repeat(64), trainedMatches: 5, sweeps: 2 };
    await store.recordFit(f);
    await store.recordFit(f);
    expect(must(`select count(*) from public.xs_model_fits where fit_id = '${'d'.repeat(64)}'`)).toBe('1');
  });

  it('saveMonth (merge-upsert): a javított eredmény és a lezárás felülír, duplikáció nélkül; service_role update-tel', async () => {
    const store = pgStore();
    const row: ScoreboardResult = { id: 'espn-eng.1-2001', competitionId: 'eng-pl', date: '2026-10-04T14:00:00.000Z', homeTeamId: 'espn-1', awayTeamId: 'espn-2', homeGoals: 1, awayGoals: 1, regulation: true };
    await store.saveMonth('eng-pl', '202610', false, [row]);
    await store.saveMonth('eng-pl', '202610', true, [{ ...row, homeGoals: 2 }]);
    expect(must(`select home_goals || '|' || (select count(*) from public.xs_training_matches where id = 'espn-eng.1-2001') from public.xs_training_matches where id = 'espn-eng.1-2001'`)).toBe('2|1');
    expect((await store.months()).get('eng-pl|202610')).toBe(true);
  });

  it('lapozás a PostgREST max-rows korlátja mellett is teljes (a kért 1000-nél kisebb lap nem vágja le az adatot)', async () => {
    const all = await pgStore().loadMatches('2000-01-01T00:00:00.000Z');
    const months = await pgStore().months();
    expect(all.length).toBeGreaterThan(1);
    expect((await pgStore(1).loadMatches('2000-01-01T00:00:00.000Z')).map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(await pgStore(1).months()).toEqual(months);
  });

  it('újraindulás a VALÓDI PostgreSQL-tárral: hidegen minden hónap egyszer, utána csak a nyitott hónapok (ugyanaz a tanítóadat)', async () => {
    must(`truncate public.xs_training_matches, public.xs_training_months`);
    const comps = XS_TRAINING_COMPETITIONS.slice(0, 4);
    const now = new Date('2026-10-15T12:00:00.000Z');
    const counting = () => {
      const calls: string[] = [];
      const source: MonthlyResultsSource = {
        async monthResults(c, m) {
          calls.push(`${c}|${m}`);
          const ci = comps.indexOf(c), mo = +m.slice(4);
          return Array.from({ length: 6 }, (_, k) => ({ id: `espn-t${ci}.x-${m}${k}`, competitionId: c, date: new Date(Date.UTC(+m.slice(0, 4), mo - 1, 2 + k * 3, 15)).toISOString(),
            homeTeamId: `espn-${ci * 100 + 1 + ((k * 3 + mo) % 8)}`, awayTeamId: `espn-${ci * 100 + 1 + ((k * 3 + mo + 1 + (k % 6)) % 8)}`, homeGoals: (ci + mo + k) % 4, awayGoals: (mo + k) % 3, regulation: true }))
            .filter((r) => r.homeTeamId !== r.awayTeamId);
        },
      };
      return { source, calls };
    };
    const opts = { now: () => now, minTrainingMatches: 200, competitions: comps, log: () => {} };
    const cold = counting();
    const a = new XsModelService(cold.source, pgStore(), opts);
    await a.refresh();
    expect(cold.calls.length).toBe(comps.length * 37);
    expect(a.status()).toMatchObject({ ready: true, durableStore: true, storeError: null });
    expect(must(`select count(*) from public.xs_training_months where closed`)).toBe(String(comps.length * 36));
    expect(must(`select count(*) from public.xs_model_fits where fit_id = '${a.status().fitId}'`)).toBe('1');

    const warm = counting();
    const b = new XsModelService(warm.source, pgStore(), opts);
    await b.refresh();
    expect(warm.calls.sort()).toEqual(comps.map((c) => `${c}|202610`).sort()); // csak a folyó hónap
    expect(b.status()).toMatchObject({ months: { stored: comps.length * 36, fetched: comps.length, failed: 0 }, durableStore: true });
    expect(b.status().datasetSha256).toBe(a.status().datasetSha256);
    expect(b.status().fitId).toBe(a.status().fitId); // azonos időpont + azonos adat → azonos becslés-azonosító
  }, 300_000);

  it('az utóellenőrző SQL (docs/model-learning/xs-production/verify_0021.sql) minden pontja teljesül a migrált sémán', () => {
    const rows = must(VERIFY).split('\n').filter(Boolean).map((l) => l.split('|'));
    expect(rows.length).toBe(11);
    expect(rows.filter(([, ok]) => ok !== 't')).toEqual([]);
  });
});
