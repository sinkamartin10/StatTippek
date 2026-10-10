/**
 * PostgREST-SZERZŐDÉS – a VALÓDI `PostgresTipArchiveStore` és
 * `PostgresModelLearningStore` kódja fut, a supabase-js lekérdezés-építőjét a
 * `SqlRest` helyettesíti (tests/helpers/sqlRest.ts): minden hívást a PostgREST
 * SQL-megfelelőjére fordít, és `service_role` szerepben, a migrált sémán futtat.
 * Így a forrás és a séma közti szerződést a tényleges kódút ellenőrzi (oszlopok,
 * típusok, megszorítások, jogok, RLS, RPC), nem szöveg-illesztés.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut, és a
 * `beforeAll` POZITÍVAN ellenőrzi, hogy a szerver 127.0.0.1, az adatbázisok
 * nevei eldobhatók – különben megszakít, mielőtt bármit írna.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqlRest, tagged, type RecordedOp } from './helpers/sqlRest';
import { PostgresTipArchiveStore, type ArchiveDraft } from '../src/server/tipArchive/store';
import { PostgresModelLearningStore } from '../src/server/modelLearning/store';
import { TipArchiveService, contentHash } from '../src/server/tipArchive/service';
import { ModelLearningService } from '../src/server/modelLearning/service';
import { AnalysisService } from '../src/server/services/analysisService';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import { CALIBRATION_METHOD } from '../src/shared/modelLearning';
import type { Container } from '../src/server/container';
import type { Match, MatchAnalysis } from '../src/shared/types';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = { main: 'tippstats_v1_contract', pre16: 'tippstats_v1_contract_pre16', mut: 'tippstats_v1_contract_mut', tx: 'tippstats_v1_contract_tx' };
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${n}`, import.meta.url)), 'utf8');
const M14 = '0014_model_tip_archive.sql';
const M15 = '0015_model_learning.sql';
const M16 = '0016_tip_archive_provenance.sql';
const M17 = '0017_model_learning_events_shadow_kind.sql';

/** Tulajdonosi (beállító) SQL – csak a helyi, eldobható adatbázisokon. */
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
const apply = (db: string, name: string) => { const r = admin(db, mig(name), ['--single-transaction']); if (!r.ok) throw new Error(`${name}: ${r.err}`); };

function freshDb(db: string) {
  if (!/^tippstats_v1_contract(_[a-z0-9]+)?$/.test(db)) throw new Error(`nem eldobható adatbázisnév: ${db}`);
  must('postgres', `drop database if exists ${db}`);
  must('postgres', `create database ${db}`);
  must(db, `
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    create schema auth; create table auth.users (id uuid primary key);
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
}

/** Valódi Postgres-tárolók, a supabase-js helyett a helyi SQL-utánzattal. */
function stores(db: string, maxRows?: number) {
  const rest = new SqlRest({ host: HOST, db, psql: PSQL, role: 'service_role', maxRows });
  // a kliens csak létrejön (hálózati hívás nincs), utána azonnal lecseréljük
  const a = new PostgresTipArchiveStore('http://127.0.0.1:9', 'helyi-teszt-kulcs-nem-titok');
  const l = new PostgresModelLearningStore('http://127.0.0.1:9', 'helyi-teszt-kulcs-nem-titok');
  (a as unknown as { db: unknown }).db = rest;
  (l as unknown as { db: unknown }).db = rest;
  return { rest, archive: tagged(a, rest), learning: tagged(l, rest) };
}

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function draft(over: Partial<ArchiveDraft> = {}): ArchiveDraft {
  const d = {
    matchId: 'c1', market: 'O2.5', versionNo: 1, contentHash: 'c'.repeat(64), engineVersion: ENGINE_VERSION,
    generatedAt: iso(T0 - 5 * H), origin: 'live' as const, matchLabel: 'Hazai FC – Vendég SC', leagueId: 'L1', leagueName: 'Liga',
    kickoff: iso(T0 - 2 * H), marketLabel: 'Gólok 2,5 felett', marketType: 'gólszám', category: 'mérsékelt' as const, modelProb: 0.61,
    odds: 1.85, impliedProb: 0.5405, dataQuality: 'magas' as const, sampleSize: 20, supportingIndicators: 3, preKickoff: true,
    availability: 'pro_on_request' as const, ...over,
  };
  return { ...d, servedProb: over.servedProb ?? d.modelProb, servedModel: over.servedModel ?? d.engineVersion };
}

function analysis(m: Match, tips: { market: string; prob: number }[], generatedAt: string): MatchAnalysis {
  return {
    match: m, league: { id: m.leagueId, name: 'Liga' }, homeTeam: { id: 'H', name: 'Hazai FC' }, awayTeam: { id: 'A', name: 'Vendég SC' },
    origin: 'live', generatedAt, poisson: {}, dataQuality: { level: 'magas', score: 80, factors: [] },
    tips: tips.map((t, i) => ({ id: `t${i}`, category: 'mérsékelt', market: t.market, label: t.market, modelProb: t.prob, odds: null, impliedProb: null,
      diffPoints: null, supportingStats: [], reasonsFor: [], reasonsAgainst: [], risks: [], supportingIndicators: 3, sampleSize: 20 })),
  } as unknown as MatchAnalysis;
}
const match = (id: string, kickoff: string, extra: Partial<Match> = {}) =>
  ({ id, leagueId: 'L1', homeTeamId: 'H', awayTeamId: 'A', kickoff, status: 'scheduled', origin: 'live', ...extra }) as Match;

const inventory: RecordedOp[] = [];

describe.skipIf(!ENABLED)('PostgREST-szerződés: valódi Postgres-tárolók a helyi, eldobható PostgreSQL 17-en', () => {
  beforeAll(() => {
    // POZITÍV izoláció-ellenőrzés: bármilyen eltérésnél megszakítunk, mielőtt írnánk
    const who = must('postgres', `select inet_server_addr()::text || '|' || current_setting('server_version_num')`);
    const [addr, ver] = who.split('|');
    if (!addr.startsWith('127.0.0.1') && !addr.startsWith('::1')) throw new Error(`nem helyi szerver: ${addr}`);
    if (Number(ver) < 170000) throw new Error(`PostgreSQL 17 kell, ez: ${ver}`);

    // FŐ adatbázis: 0014 → régi sémájú sorok (régi hash-képlettel) → 0015 → 0016, majd 0015/0016 újrafuttatása
    freshDb(DB.main);
    apply(DB.main, M14);
    must(DB.main, `
      insert into public.model_tip_archive (match_id, market, version_no, content_hash, engine_version, generated_at, origin, match_label,
        league_id, league_name, kickoff, market_label, market_type, category, model_prob, data_quality, sample_size, supporting_indicators, pre_kickoff)
      values ('legacy1', 'O2.5', 1, '${contentHash('legacy1', 'O2.5', 'mérsékelt', 0.61)}', '${ENGINE_VERSION}', '${iso(T0 - 30 * H)}', 'live', 'Hazai FC – Vendég SC',
        'L1', 'Liga', '${iso(T0 - 24 * H)}', 'O2.5', 'gólszám', 'mérsékelt', 0.61, 'magas', 20, 3, true);
      update public.model_tip_archive set settlement_status = 'won', home_goals = 3, away_goals = 1, settled_at = now(),
        result_kickoff = '${iso(T0 - 24 * H)}' where match_id = 'legacy1';`);
    for (const n of [M15, M16, M17, M15, M16, M17]) apply(DB.main, n);

    // 0016 NÉLKÜLI adatbázis (az egészség-ellenőrzéshez)
    freshDb(DB.pre16);
    apply(DB.pre16, M14);
    apply(DB.pre16, M15);

    // SZÁNDÉKOSAN ELTÉRŐ séma (az eltérés-észlelés igazolására)
    freshDb(DB.mut);
    for (const n of [M14, M15, M16, M17]) apply(DB.mut, n);
    must(DB.mut, `
      alter table public.model_tip_archive rename column served_model to served_model_x;
      revoke update on public.model_learning_state from service_role;
      drop function public.model_tip_archive_observe(text, timestamptz, text, timestamptz);`);
  });

  afterAll(() => {
    if (process.env.PRINT_INVENTORY === '1') {
      const rows = [...new Map(inventory.map((o) => [`${o.tag}|${o.method}|${o.resource}|${o.kind}`, o])).values()];
      console.log(JSON.stringify(rows.map((o) => ({
        tag: o.tag, method: o.method, resource: o.resource, kind: o.kind, columns: o.columns, payloadKeys: o.payloadKeys,
        filters: o.filters, order: o.order, range: o.range, returning: o.returning, count: o.count, single: o.single, onConflict: o.onConflict,
      })), null, 1));
    }
  });

  it('szerep: a műveletek service_role-ként futnak (nem tulajdonos, nem superuser)', () => {
    const { rest } = stores(DB.main);
    const r = rest.run(`select current_user || '|' || (select rolsuper from pg_roles where rolname = current_user) || '|' || (select rolbypassrls from pg_roles where rolname = current_user)`);
    expect(r).toEqual({ ok: true, out: 'service_role|false|true' });
  });

  it('ARCHÍVUM-TÁROLÓ: minden művelet a valódi sémán, helyes típusokkal és kardinalitással', async () => {
    const { rest, archive } = stores(DB.main);
    // provenance-beszúrás (ütközés-kezeléssel) és a duplikátum
    expect(await archive.insertVersions([draft()])).toEqual(['O2.5']);
    expect(await archive.insertVersions([draft()])).toEqual([]);
    // inkonzisztens eredet: a TELJES köteg elbukik, nem marad részleges sor
    await expect(archive.insertVersions([draft({ matchId: 'c2' }), draft({ matchId: 'c2', market: '1X', servedProb: 0.7 })])).rejects.toThrow(/model_tip_archive_provenance/);
    expect(must(DB.main, `select count(*) from model_tip_archive where match_id = 'c2'`)).toBe('0');
    // kalibrált eredet (jövőbeli képesség) elfogadott
    expect(await archive.insertVersions([draft({ matchId: 'c3', servedProb: 0.58, servedModel: `${ENGINE_VERSION}+cal-0123456789ab` })])).toEqual(['O2.5']);

    const lv = await archive.latestVersions('c1');
    expect(lv.get('O2.5')).toEqual({ versionNo: 1, contentHash: 'c'.repeat(64), generatedAt: iso(T0 - 5 * H) });
    expect(await archive.matchState('c1')).toBeNull();
    expect(await archive.orphanMatchIds(iso(T0), iso(T0 - 30 * 24 * H), 10)).toEqual(expect.arrayContaining(['c1', 'legacy1']));

    // RPC: újabb megfigyelés ír, régebbi nem
    await archive.observeMatch({ matchId: 'c1', kickoff: iso(T0 - 2 * H), status: 'live', observedAt: iso(T0 - H) });
    await archive.observeMatch({ matchId: 'c1', kickoff: iso(T0 - 2 * H), status: 'scheduled', observedAt: iso(T0 - 3 * H) });
    expect(await archive.matchState('c1')).toEqual({ matchId: 'c1', kickoff: iso(T0 - 2 * H), status: 'live', observedAt: iso(T0 - H) });
    expect(await archive.dueMatchIds(iso(T0), iso(T0 - 30 * 24 * H), 10, 0)).toEqual(['c1']);
    expect(await archive.pendingMarkets('c1')).toEqual(['O2.5']);
    expect(await archive.settle({ matchId: 'c1', homeGoals: 2, awayGoals: 1, resultKickoff: iso(T0 - 2 * H), settledAt: iso(T0), outcomes: [{ market: 'O2.5', status: 'won' }] })).toBe(1);
    expect(await archive.settle({ matchId: 'c1', homeGoals: 0, awayGoals: 0, resultKickoff: iso(T0 - 2 * H), settledAt: iso(T0), outcomes: [{ market: 'O2.5', status: 'lost' }] })).toBe(0);

    // listázó nézetek: láthatóság, szűrők, rendezés, lapozás, darabszám
    const filter = { origin: 'live' as const, visibleBefore: iso(T0) };
    const all = await archive.list(filter, 'all', 0, 50);
    expect(all.total).toBe(1);
    expect(all.rows[0]).toMatchObject({ matchId: 'c1', modelProb: 0.61, odds: 1.85, status: 'won', homeGoals: 2, currentKickoff: iso(T0 - 2 * H), matchStatus: 'live' });
    const filtered = await archive.list({ ...filter, from: iso(T0 - 3 * H), to: iso(T0), leagueId: 'L1', marketType: 'gólszám', status: 'won', availability: 'pro_on_request', search: 'hazai' }, 'counted', 0, 1);
    expect(filtered.total).toBe(1);
    expect(await archive.countedIds(['c1'])).toEqual(new Set([all.rows[0].id]));
    expect(await archive.summary(filter)).toEqual({ records: 1, counted: { won: 1, lost: 0, void: 0, pending: 0, unsupported: 0 } });
    expect(await archive.coverageStart('live')).toBe(iso(T0 - 30 * H));
    expect(await archive.healthCheck()).toEqual([]);
    // üres eredmények
    expect(await archive.latestVersions('nincs')).toEqual(new Map());
    expect(await archive.list({ ...filter, leagueId: 'NINCS' }, 'all', 0, 10)).toEqual({ rows: [], total: 0 });
    inventory.push(...rest.log);
  });

  it('TANULÁSI TÁROLÓ: minden művelet a valódi sémán (zár, CAS, jelölt, állapot, esemény, tanító olvasás)', async () => {
    const { rest, learning } = stores(DB.main);
    const rows = await learning.loadArchive(ENGINE_VERSION, 100);
    const legacy = rows.find((r) => r.matchId === 'legacy1')!;
    expect(legacy).toMatchObject({ provenance: 'legacy_baseline', servedProb: null, servedModel: null, modelProb: 0.61, settlementStatus: 'won', preKickoff: true });
    expect(rows.find((r) => r.matchId === 'c1')).toMatchObject({ provenance: 'recorded', servedProb: 0.61, servedModel: ENGINE_VERSION });

    const st0 = await learning.getState();
    expect(st0).toMatchObject({ activeModelId: null, stateVersion: 0, lockOwner: null });
    const now = iso(T0);
    expect(await learning.tryAcquireLock('o1', now, iso(T0 + 600_000))).toBe(true);
    expect(await learning.tryAcquireLock('o2', now, iso(T0 + 600_000))).toBe(false);
    expect(await learning.tryAcquireLock('o2', iso(T0 + 600_001), iso(T0 + 1_200_000))).toBe(true);   // lejárt lease → átvehető
    expect(await learning.finishRun('o1', now, 'succeeded', null, null)).toBe(false);                   // a régi tulajdonos már nem zárhat
    expect(await learning.finishRun('o2', now, 'failed', 'hiba', { validObservations: 1, validMatches: 1, excluded: {}, windows: {}, outcome: 'failed', reasons: ['x'] })).toBe(true);
    expect((await learning.getState()).lastRunSummary).toMatchObject({ outcome: 'failed' });

    const v = { id: 'cal-abcdefabcdef', baseEngineVersion: ENGINE_VERSION, method: CALIBRATION_METHOD,
      params: { global: { a: 0.01, b: 0.9 }, byMarketType: {}, lambda: 8 }, dataFingerprint: 'f'.repeat(64), trainingWindow: { train: [now, now] },
      metrics: { holdout: { logLoss: 0.6 } }, gateResult: { passed: true, reasons: [] }, status: 'shadow' as const, statusReason: 'árnyék' };
    expect(await learning.insertVersion(v)).toBe(true);
    expect(await learning.insertVersion(v)).toBe(false);
    expect(await learning.getVersion(v.id)).toMatchObject({ params: v.params, metrics: v.metrics, gateResult: v.gateResult, status: 'shadow' });
    expect(await learning.setVersionStatus(v.id, 'eligible', 'ok', ['shadow'], now)).toBe(true);
    expect(await learning.setVersionStatus(v.id, 'active', 'x', ['shadow'], now)).toBe(false);
    expect((await learning.listVersions(5)).map((x) => x.id)).toEqual([v.id]);
    expect(await learning.casActive(0, v.id, null, now)).toBe(true);
    expect(await learning.casActive(0, null, null, now)).toBe(false);
    expect(await learning.casActive(1, null, null, now)).toBe(true);
    await learning.appendEvent({ kind: 'shadow_evaluation', modelId: v.id, actor: 'u1', details: { outcome: 'passed' } });
    expect(await learning.latestEvent(v.id, 'shadow_evaluation')).toMatchObject({ kind: 'shadow_evaluation', details: { outcome: 'passed' } });
    expect(await learning.latestEvent(v.id, 'promotion')).toBeNull();
    expect((await learning.listEvents(5))[0]).toMatchObject({ kind: 'shadow_evaluation', modelId: v.id });
    await expect(learning.appendEvent({ kind: 'nem-letezo', modelId: null, actor: null, details: {} })).rejects.toThrow(/model_learning_events_kind/);
    inventory.push(...rest.log);
  });

  it('SZOLGÁLTATÁS-FOLYAMATOK a Postgres-tárolókkal: eredet, régi hash-kompatibilitás, nyilvános API, RPC-frissítés', async () => {
    const { archive } = stores(DB.main);
    const svc = new TipArchiveService(archive, { origin: 'live', getMatch: async (id: string) =>
      (id === 'legacy1' ? match('legacy1', iso(T0 - 24 * H), { status: 'finished', homeGoals: 3, awayGoals: 1 }) : null) }, { now: () => new Date(T0), settleWaitMs: 5_000 });
    // a régi (legacy) sor azonos tartalmú újraszámolása NEM hoz új verziót, és a régi sort nem írja át
    expect(await svc.record(analysis(match('legacy1', iso(T0 - 24 * H), { status: 'finished', homeGoals: 3, awayGoals: 1 }), [{ market: 'O2.5', prob: 0.61 }], iso(T0 - 30 * H + 1000)))).toBe(0);
    expect(must(DB.main, `select count(*) || '|' || min(provenance) from model_tip_archive where match_id = 'legacy1'`)).toBe('1|legacy_baseline');
    // új alap-motor sor: rögzített eredet
    expect(await svc.record(analysis(match('s1', iso(T0 + 6 * H)), [{ market: 'BTTS_Y', prob: 0.4321 }], iso(T0)))).toBe(1);
    expect(must(DB.main, `select provenance || '|' || served_model || '|' || (served_prob = model_prob) from model_tip_archive where match_id = 's1'`)).toBe(`recorded|${ENGINE_VERSION}|true`);
    // nyilvános API: a kiszolgált modell az alap motor → a megjelenített valószínűség a nyers = kiszolgált
    const q = await svc.query({});
    // c1 (előző teszt: megfigyelt, lezárt) és legacy1 (most megfigyelve, lejátszott) – aktuális kezdés szerint csökkenő
    expect(q.entries.map((e) => [e.matchId, e.modelProb])).toEqual([['c1', 0.61], ['legacy1', 0.61]]);
    expect(Object.keys(q.entries[0]).sort()).toEqual(['availability', 'awayGoals', 'category', 'counted', 'dataQuality', 'engineVersion', 'generatedAt', 'homeGoals',
      'id', 'kickoff', 'leagueId', 'leagueName', 'market', 'marketLabel', 'marketType', 'matchId', 'matchLabel', 'modelProb', 'odds', 'preKickoff', 'sampleSize',
      'settledAt', 'status', 'versionNo']);
  });

  it('TANULÁS-FOLYAMATOK: elégtelen adat, árnyék-kapu, tiltott/engedélyezett aktiválás, visszaállítás, visszaesés – Postgres-tárolókkal', async () => {
    const { rest, learning } = stores(DB.main);
    const t = { t: T0 + 2 * H };
    const prod = new ModelLearningService(learning, { now: () => new Date(t.t), allowPromotion: false });
    expect((await prod.evaluate('admin')).status).toBe('insufficient_data');
    const v = { id: 'cal-111111111111', baseEngineVersion: ENGINE_VERSION, method: CALIBRATION_METHOD,
      params: { global: { a: 0, b: 0.8 }, byMarketType: {}, lambda: 8 }, dataFingerprint: 'e'.repeat(64), trainingWindow: {},
      metrics: {}, gateResult: { passed: true, reasons: [] }, status: 'eligible' as const, statusReason: null };
    await learning.insertVersion(v);
    expect((await prod.evaluateShadow(v.id, 'admin')).status).toBe('insufficient_data');
    expect((await prod.promote(v.id, 'admin')).code).toBe('PROMOTION_DISABLED');
    const testOnly = new ModelLearningService(learning, { now: () => new Date(t.t), allowPromotion: true });
    expect((await testOnly.promote(v.id, 'admin')).code).toBe('SHADOW_NOT_PASSED');
    await learning.appendEvent({ kind: 'shadow_evaluation', modelId: v.id, actor: 'teszt', details: { outcome: 'passed' } });
    expect((await testOnly.promote(v.id, 'admin')).ok).toBe(true);
    expect(await testOnly.resolveActive()).toMatchObject({ kind: 'calibrated', modelId: v.id });
    expect((await testOnly.rollback('admin')).activeModelId).toBeNull();
    expect(await new ModelLearningService(learning, { now: () => new Date(t.t) }).resolveActive()).toMatchObject({ kind: 'baseline' });
    // sérült aktív konfiguráció (pl. kézi beavatkozás) → visszaesés az alap motorra
    const st = await learning.getState();
    must(DB.main, `insert into model_calibration_versions (id, base_engine_version, method, params, data_fingerprint, training_window, metrics, gate_result, status)
      values ('cal-badbadbadbad', '${ENGINE_VERSION}', '${CALIBRATION_METHOD}', '{"global":{"a":"x"}}', repeat('d',64), '{}', '{}', '{"passed":true}', 'active');
      update model_learning_state set active_model_id = 'cal-badbadbadbad', state_version = state_version + 1 where id = 1;`);
    const r = await new ModelLearningService(learning, { now: () => new Date(t.t) }).resolveActive();
    expect(r).toMatchObject({ kind: 'baseline' });
    expect(st.stateVersion).toBeGreaterThan(0);
    const status = await prod.status();
    expect(status).toMatchObject({ servedModel: ENGINE_VERSION, promotionEnabled: false });
    must(DB.main, `update model_learning_state set active_model_id = null, state_version = state_version + 1 where id = 1;`);
    inventory.push(...rest.log);
  });

  it('PÁRHUZAMOSSÁG: két példány aktivál egyszerre → pontosan egy nyer; két kiértékelés → az egyik zárolt', async () => {
    const { learning } = stores(DB.main);
    for (const id of ['cal-aaaaaaaaaaa1', 'cal-aaaaaaaaaaa2']) {
      await learning.insertVersion({ id, baseEngineVersion: ENGINE_VERSION, method: CALIBRATION_METHOD, params: { global: { a: 0, b: 0.9 }, byMarketType: {}, lambda: 8 },
        dataFingerprint: 'a'.repeat(64), trainingWindow: {}, metrics: {}, gateResult: { passed: true, reasons: [] }, status: 'eligible', statusReason: null });
      await learning.appendEvent({ kind: 'shadow_evaluation', modelId: id, actor: 'teszt', details: { outcome: 'passed' } });
    }
    const mk = () => new ModelLearningService(learning, { now: () => new Date(T0 + 3 * H), allowPromotion: true });
    const [a, b] = await Promise.all([mk().promote('cal-aaaaaaaaaaa1', 'a'), mk().promote('cal-aaaaaaaaaaa2', 'b')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a.code, b.code]).toContain('CONFLICT');
    await mk().rollback('teszt');
    const [e1, e2] = await Promise.all([mk().evaluate('a'), mk().evaluate('b')]);
    expect([e1.status, e2.status].sort()).toEqual(['insufficient_data', 'locked']);
  });

  it('RPC érvénytelen argumentumokkal: ismeretlen paraméter, rossz típus, rossz állapot, hiányzó azonosító → hiba, írás nélkül', async () => {
    const { rest } = stores(DB.main);
    const call = (args: Record<string, unknown>) => new Promise<{ error: { message: string } | null }>((res) => rest.rpc('model_tip_archive_observe', args).then(res));
    expect((await call({ p_match: 'x', p_kickoff: iso(T0), p_status: 'live', p_observed_at: iso(T0) })).error?.message).toMatch(/Could not find the function/);
    expect((await call({ p_match_id: 'x', p_kickoff: 'nem-datum', p_status: 'live', p_observed_at: iso(T0) })).error?.message).toMatch(/invalid input syntax/);
    expect((await call({ p_match_id: 'x', p_kickoff: iso(T0), p_status: 'furcsa', p_observed_at: iso(T0) })).error?.message).toMatch(/match_state_status/);
    expect((await call({ p_match_id: null, p_kickoff: iso(T0), p_status: 'live', p_observed_at: iso(T0) })).error?.message).toMatch(/null value/);
    expect(must(DB.main, `select count(*) from model_tip_archive_match_state where match_id = 'x'`)).toBe('0');
  });

  it('KATALÓGUS: pontos jogok, RLS, policy-k, megszorítások, triggerek, nézet-oszlopok és -opciók', () => {
    const grants = must(DB.main, `select grantee || ':' || table_name || ':' || string_agg(privilege_type, ',' order by privilege_type)
      from information_schema.role_table_grants where table_schema = 'public' and grantee in ('service_role', 'anon', 'authenticated')
      group by grantee, table_name order by 1`).split('\n');
    expect(grants).toEqual([
      'service_role:model_calibration_versions:INSERT,SELECT,UPDATE',
      'service_role:model_learning_events:INSERT,SELECT',
      'service_role:model_learning_state:SELECT,UPDATE',
      'service_role:model_tip_archive:INSERT,SELECT,UPDATE',
      'service_role:model_tip_archive_counted:SELECT',
      'service_role:model_tip_archive_counted_listing:SELECT',
      'service_role:model_tip_archive_listing:SELECT',
      'service_role:model_tip_archive_match_state:INSERT,SELECT,UPDATE',
    ]);
    expect(must(DB.main, `select string_agg(p.proname || ':' || has_function_privilege(r, p.oid, 'EXECUTE'), ',' order by p.proname, r)
      from pg_proc p, unnest(array['anon','authenticated','service_role']) r where p.pronamespace = 'public'::regnamespace and p.proname like 'model_%'
      and p.proname = 'model_tip_archive_observe'`)).toBe('model_tip_archive_observe:false,model_tip_archive_observe:false,model_tip_archive_observe:true');
    expect(must(DB.main, `select string_agg(relname || '=' || relrowsecurity, ',' order by relname) from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and relname like 'model_%'`))
      .toBe('model_calibration_versions=true,model_learning_events=true,model_learning_state=true,model_tip_archive=true,model_tip_archive_match_state=true');
    expect(must(DB.main, `select count(*) from pg_policies where schemaname = 'public'`)).toBe('0');
    expect(must(DB.main, `select string_agg(relname || '=' || coalesce(array_to_string(reloptions, ','), 'none'), ',' order by relname) from pg_class where relkind = 'v' and relname like 'model_%'`))
      .toBe('model_tip_archive_counted=security_invoker=true,model_tip_archive_counted_listing=security_invoker=true,model_tip_archive_listing=security_invoker=true');
    // megszorítások típus szerint
    expect(must(DB.main, `select conrelid::regclass::text || ':' || contype::text || ':' || conname from pg_constraint where connamespace = 'public'::regnamespace
      and conname in ('model_tip_archive_provenance', 'model_tip_archive_version_uniq', 'model_learning_state_active_model_id_fkey', 'model_learning_state_singleton', 'model_calibration_versions_id')
      order by 1`).split('\n')).toEqual([
      'model_calibration_versions:c:model_calibration_versions_id',
      'model_learning_state:c:model_learning_state_singleton',
      'model_learning_state:f:model_learning_state_active_model_id_fkey',
      'model_tip_archive:c:model_tip_archive_provenance',
      'model_tip_archive:u:model_tip_archive_version_uniq',
    ]);
    expect(must(DB.main, `select string_agg(tgname, ',' order by tgname) from pg_trigger where not tgisinternal and tgrelid::regclass::text like 'model_%'`)).toBe([
      'model_calibration_versions_guard', 'model_calibration_versions_no_delete', 'model_calibration_versions_no_truncate', 'model_learning_events_guard',
      'model_learning_events_no_delete', 'model_learning_events_no_truncate', 'model_learning_state_no_delete', 'model_learning_state_no_truncate',
      'model_tip_archive_guard', 'model_tip_archive_match_state_no_delete', 'model_tip_archive_match_state_no_truncate', 'model_tip_archive_no_delete',
      'model_tip_archive_no_truncate'].join(','));
    // a 0016 nem bővítette a (belső) listázó nézeteket; a statisztikai nézet viszont tartalmazza az eredetet
    expect(must(DB.main, `select count(*) from information_schema.columns where table_name in ('model_tip_archive_listing','model_tip_archive_counted_listing') and column_name in ('provenance','served_prob','served_model')`)).toBe('0');
    expect(must(DB.main, `select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'model_tip_archive_counted' and column_name in ('provenance','served_prob','served_model')`)).toBe('provenance,served_model,served_prob');
    // a kliens szerepek semmit nem olvashatnak
    for (const role of ['anon', 'authenticated']) {
      for (const rel of ['model_tip_archive', 'model_tip_archive_counted', 'model_tip_archive_listing', 'model_calibration_versions', 'model_learning_state', 'model_learning_events']) {
        const r = admin(DB.main, `set role ${role}; select 1 from public.${rel} limit 1;`);
        expect(r.ok, `${role} ${rel}`).toBe(false);
      }
    }
  });

  it('EGÉSZSÉG-ELLENŐRZÉS: hiányzó 0016 → az archívum és a tanulási réteg sem „kész”', async () => {
    const { archive, learning } = stores(DB.pre16);
    expect(await archive.healthCheck()).toEqual(['model_tip_archive.provenance (0016)']);
    const svc = new ModelLearningService(learning);
    expect(await svc.healthCheck()).toEqual(expect.arrayContaining([expect.stringMatching(/0016/)]));
    // a 0016 megléte esetén üres
    expect(await new ModelLearningService(stores(DB.main).learning).healthCheck()).toEqual([]);
  });

  it('ELTÉRÉS-ÉSZLELÉS (szándékosan hibás séma): oszlop, jog és RPC hiánya hibát ad – csendes rossz írás nincs; a felhasználói elemzés nem sérül', async () => {
    const { archive, learning } = stores(DB.mut);
    await expect(archive.insertVersions([draft({ matchId: 'm1' })])).rejects.toThrow(/served_model/);
    await expect(archive.observeMatch({ matchId: 'm1', kickoff: iso(T0), status: 'live', observedAt: iso(T0) })).rejects.toThrow(/Could not find the function/);
    await expect(learning.casActive(0, null, null, iso(T0))).rejects.toThrow(/permission denied/);
    expect(await archive.healthCheck()).toEqual(['model_tip_archive.provenance (0016)']);
    expect(must(DB.mut, `select count(*) from model_tip_archive`)).toBe('0');
    // élő út: az elemzés visszaadódik, a hiba naplózva és számolva
    const demo = new DemoMatchDataProvider();
    const svc = new AnalysisService({
      data: demo, research: new DemoResearchProvider(demo), oddsApi: null,
      db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
    } as unknown as Container, new TipArchiveService(archive, demo));
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    try {
      const a = await svc.analyze((await demo.getMatches({ status: 'scheduled' }))[0].id);
      await svc.archiveIdle();
      expect(a!.tips.length).toBeGreaterThan(0);
      expect(svc.archiveFailureStats().total).toBe(1);
      expect(logged.some((l) => l.includes('[tip-archive]'))).toBe(true);
    } finally { console.error = orig; }
  });

  it('LAPOZÁS: a tanító olvasás a db-max-rows korláttól függetlenül minden sort visszaad (500 / 1000 / nincs)', async () => {
    must(DB.main, `
      insert into model_tip_archive (match_id, market, version_no, content_hash, engine_version, generated_at, origin, match_label, league_id, league_name,
        kickoff, market_label, market_type, category, model_prob, data_quality, sample_size, supporting_indicators, pre_kickoff, provenance, served_prob, served_model)
      select 'bulk' || lpad(i::text, 5, '0'), 'O2.5', 1, repeat('b', 64), '${ENGINE_VERSION}', timestamptz '2026-01-01' + i * interval '6 hours' - interval '5 hours', 'live',
        'x', 'L1', 'Liga', timestamptz '2026-01-01' + i * interval '6 hours', 'x', 'gólszám', 'mérsékelt', 0.5, 'magas', 1, 1, true, 'recorded', 0.5, '${ENGINE_VERSION}'
      from generate_series(1, 1250) i;`);
    const expected = Number(must(DB.main, `select count(*) from model_tip_archive_counted where engine_version = '${ENGINE_VERSION}' and origin = 'live'`));
    expect(expected).toBeGreaterThan(1250);
    for (const cap of [500, 1000, undefined]) {
      const rows = await stores(DB.main, cap).learning.loadArchive(ENGINE_VERSION, 100_000);
      expect(rows.length, `max-rows=${cap}`).toBe(expected);
      expect(new Set(rows.map((r) => r.id)).size, `max-rows=${cap} (nincs duplikátum)`).toBe(expected);
    }
    // a hívó korlátja tiszteletben tartva
    expect((await stores(DB.main, 500).learning.loadArchive(ENGINE_VERSION, 700)).length).toBe(700);
  });

  it('ÁTMENETI HIBA a kiértékelés közben: „failed”, a zár felszabadul, auditált', async () => {
    const { rest, learning } = stores(DB.main);
    rest.failOn = (op) => op.tag === 'loadArchive';
    const r = await new ModelLearningService(learning, { now: () => new Date(T0 + 5 * H) }).evaluate('admin');
    expect(r.status).toBe('failed');
    rest.failOn = null;
    expect(await learning.getState()).toMatchObject({ lockOwner: null, lastRunStatus: 'failed' });
    expect((await learning.listEvents(1))[0]).toMatchObject({ kind: 'failure' });
  });

  it('MIGRÁCIÓ: elbukó 0016 egy tranzakcióban mindent visszagörget; utána tisztán alkalmazható', () => {
    freshDb(DB.tx);
    apply(DB.tx, M14);
    apply(DB.tx, M15);
    const failing = admin(DB.tx, `${mig(M16)}\nselect 1/0;`, ['--single-transaction']);
    expect(failing.ok).toBe(false);
    expect(must(DB.tx, `select count(*) from information_schema.columns where table_name = 'model_tip_archive' and column_name in ('provenance','served_prob','served_model')`)).toBe('0');
    expect(must(DB.tx, `select position('served_model' in prosrc) > 0 from pg_proc where proname = 'model_tip_archive_guard'`)).toBe('f');
    apply(DB.tx, M16);
    expect(must(DB.tx, `select count(*) from information_schema.columns where table_name = 'model_tip_archive' and column_name in ('provenance','served_prob','served_model')`)).toBe('3');
    // a 0014 újrafuttatása a 0016 után: egy tranzakcióban elbukik, az őr érintetlen marad
    const rerun = admin(DB.tx, mig(M14), ['--single-transaction']);
    expect(rerun.ok).toBe(false);
    expect(rerun.err).toMatch(/cannot change name of view column/);
    expect(must(DB.tx, `select position('served_model' in prosrc) > 0 from pg_proc where proname = 'model_tip_archive_guard'`)).toBe('t');
  });
});
