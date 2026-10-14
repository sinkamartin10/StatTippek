/**
 * 0018 – diagnosztikai előzmények: a VALÓDI `PostgresModelLearningStore`
 * (a supabase-js helyett a `SqlRest` PostgREST-utánzattal, `service_role`
 * szerepben) a migrált sémán, helyi, ELDOBHATÓ PostgreSQL 17-en.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut, és
 * pozitívan ellenőrzi, hogy a szerver 127.0.0.1 – különben nem ír semmit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqlRest } from './helpers/sqlRest';
import { PostgresModelLearningStore } from '../src/server/modelLearning/store';
import { ModelLearningService } from '../src/server/modelLearning/service';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import type { DiagnosticRun } from '../src/shared/modelLearning';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_history';
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${n}`, import.meta.url)), 'utf8');

function admin(db: string, sql: string, extra: string[] = []): { ok: boolean; out: string; err: string } {
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
const must = (db: string, sql: string) => { const r = admin(db, sql); if (!r.ok) throw new Error(r.err); return r.out; };
const apply = (name: string) => { const r = admin(DB, mig(name), ['--single-transaction']); if (!r.ok) throw new Error(`${name}: ${r.err}`); };

function store() {
  const rest = new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role' });
  const l = new PostgresModelLearningStore('http://127.0.0.1:9', 'helyi-teszt-kulcs-nem-titok');
  (l as unknown as { db: unknown }).db = rest;
  return l;
}

const RUN: Omit<DiagnosticRun, 'id'> = {
  createdAt: '2026-10-14T10:00:00.000Z', status: 'succeeded', baseEngineVersion: ENGINE_VERSION, method: 'diagnostics-v1',
  dataFingerprint: 'a'.repeat(64), observations: 1219, matches: 109,
  period: { firstKickoff: '2026-10-10T11:00:00.000Z', lastKickoff: '2026-10-13T19:00:00.000Z', distinctKickoffDays: 4 },
  logLoss: 0.5616714404111794, brier: 0.1902549985413701, ece: 0.03207959062416773,
  naive: { coveredMatches: 31, coveredObservations: 317, modelLogLoss: 0.5491, baselineLogLoss: 0.5251, modelBrier: 0.18, baselineBrier: 0.17,
    modelLogLossAdvantage: -0.024, modelLogLossAdvantageCi: [-0.07233, 0.02548], modelBrierAdvantage: -0.00952 },
  enoughForConclusions: false, notes: ['Kevés mérkőzés: 109 (következtetéshez legalább 150).'],
};

describe.skipIf(!ENABLED)('0018 diagnosztikai előzmények – valódi Postgres-tároló, helyi eldobható PostgreSQL 17', () => {
  beforeAll(() => {
    const who = must('postgres', `select inet_server_addr()::text || '|' || current_setting('server_version_num')`);
    const [addr, ver] = who.split('|');
    if (!addr.startsWith('127.0.0.1') && !addr.startsWith('::1')) throw new Error(`nem helyi szerver: ${addr}`);
    if (Number(ver) < 170000) throw new Error(`PostgreSQL 17 kell, ez: ${ver}`);
    must('postgres', `drop database if exists ${DB}`);
    must('postgres', `create database ${DB}`);
    must(DB, `
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema auth; create table auth.users (id uuid primary key);
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
    for (const n of ['0014_model_tip_archive.sql', '0015_model_learning.sql', '0016_tip_archive_provenance.sql', '0017_model_learning_events_shadow_kind.sql',
      '0018_model_learning_diagnostic_runs.sql', '0018_model_learning_diagnostic_runs.sql']) apply(n); // a 0018 újrafuttatható
  });

  it('rögzítés + idempotencia + lekérdezés a valódi Postgres-tárolóval (minden mező oda-vissza)', async () => {
    const s = store();
    const a = await s.insertDiagnosticRun({ idempotencyKey: 'pg-kulcs-0001', actor: 'admin1', excluded: { void: 36 }, run: RUN });
    expect(a.created).toBe(true);
    expect(a.run).toEqual({ ...RUN, id: a.run.id });
    const again = await s.insertDiagnosticRun({ idempotencyKey: 'pg-kulcs-0001', actor: 'admin1', excluded: {}, run: { ...RUN, logLoss: 0.1 } });
    expect(again).toEqual({ created: false, run: a.run }); // ugyanaz a futás, a második tartalom NEM írt
    const b = await s.insertDiagnosticRun({ idempotencyKey: 'pg-kulcs-0002', actor: null, excluded: {},
      run: { ...RUN, createdAt: '2026-10-15T10:00:00.000Z', period: null, naive: null, logLoss: null, brier: null, ece: null, observations: 0, matches: 0, notes: [] } });
    expect(b.run).toMatchObject({ period: null, naive: null, logLoss: null, observations: 0 });
    expect((await s.listDiagnosticRuns(10)).map((r) => r.id)).toEqual([b.run.id, a.run.id]);
    expect((await s.listDiagnosticRuns(1)).map((r) => r.id)).toEqual([b.run.id]);
    expect(await s.getDiagnosticRunByKey('nincs-ilyen-kulcs')).toBeNull();
    expect(must(DB, `select count(*) from public.model_learning_diagnostic_runs`)).toBe('2');
  });

  it('a szolgáltatás rögzítése a Postgres-tárolón (üres archívum: null mutatók, CHECK-ek teljesülnek)', async () => {
    const svc = new ModelLearningService(store(), { now: () => new Date('2026-10-16T10:00:00.000Z'), allowPromotion: false });
    const out = await svc.snapshotDiagnostics('admin1', 'pg-kulcs-svc-0001');
    expect(out).toMatchObject({ replayed: false, run: { observations: 0, matches: 0, logLoss: null, naive: null, enoughForConclusions: false } });
    expect((await svc.snapshotDiagnostics('admin1', 'pg-kulcs-svc-0001')).replayed).toBe(true);
    expect((await svc.diagnosticHistory(1))[0].id).toBe(out.run.id);
  });

  it('APPEND-ONLY és legszűkebb jog: service_role csak SELECT/INSERT; a tulajdonos sem módosíthat/törölhet', () => {
    const grants = must(DB, `select grantee || ':' || string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where table_name = 'model_learning_diagnostic_runs' and grantee in ('service_role', 'anon', 'authenticated') group by grantee order by 1`);
    expect(grants).toBe('service_role:INSERT,SELECT');
    expect(must(DB, `select relrowsecurity from pg_class where relname = 'model_learning_diagnostic_runs'`)).toBe('t');
    for (const role of ['anon', 'authenticated']) expect(admin(DB, `set role ${role}; select 1 from public.model_learning_diagnostic_runs limit 1;`).ok, role).toBe(false);
    expect(admin(DB, `set role service_role; update public.model_learning_diagnostic_runs set log_loss = 0;`).err).toMatch(/permission denied/);
    expect(admin(DB, `update public.model_learning_diagnostic_runs set log_loss = 0;`).err).toMatch(/nem módosítható/);
    expect(admin(DB, `delete from public.model_learning_diagnostic_runs;`).err).toMatch(/nem törölhetők/);
    expect(admin(DB, `truncate public.model_learning_diagnostic_runs;`).err).toMatch(/nem törölhetők/);
    expect(must(DB, `select count(*) from public.model_learning_diagnostic_runs`)).toBe('3');
  });

  it('megszorítások: érvénytelen kulcs, fordított CI, hiányos időszak, rossz ujjlenyomat elutasítva', async () => {
    const s = store();
    await expect(s.insertDiagnosticRun({ idempotencyKey: 'rossz kulcs!', actor: null, excluded: {}, run: RUN })).rejects.toThrow(/key_fmt/);
    await expect(s.insertDiagnosticRun({ idempotencyKey: 'pg-kulcs-ci-01', actor: null, excluded: {}, run: { ...RUN, naive: { ...RUN.naive!, modelLogLossAdvantageCi: [0.1, -0.1] } } })).rejects.toThrow(/_ci/);
    await expect(s.insertDiagnosticRun({ idempotencyKey: 'pg-kulcs-per-01', actor: null, excluded: {}, run: { ...RUN, period: { ...RUN.period!, distinctKickoffDays: 0 } } })).rejects.toThrow(/_period/);
    await expect(s.insertDiagnosticRun({ idempotencyKey: 'pg-kulcs-fp-001', actor: null, excluded: {}, run: { ...RUN, dataFingerprint: 'rövid' } })).rejects.toThrow(/_fp/);
    expect(must(DB, `select count(*) from public.model_learning_diagnostic_runs`)).toBe('3');
  });

  it('a 0018 nem érint meglévő objektumot: a 0015 táblák jogai és triggerei változatlanok', () => {
    expect(must(DB, `select grantee || ':' || table_name || ':' || string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where table_name in ('model_calibration_versions', 'model_learning_events', 'model_learning_state') and grantee = 'service_role' group by grantee, table_name order by 1`).split('\n'))
      .toEqual(['service_role:model_calibration_versions:INSERT,SELECT,UPDATE', 'service_role:model_learning_events:INSERT,SELECT', 'service_role:model_learning_state:SELECT,UPDATE']);
  });
});
