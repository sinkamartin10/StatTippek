/**
 * 0024 – Ingyenes PRO próbaidőszak a VALÓDI PostgreSQL 17-en (helyi, ELDOBHATÓ adatbázis):
 * fiókonként egy igénylés (párhuzamosan is), jóváhagyás + pontosan 3 napos PRO egy tranzakcióban,
 * lejárat a meglévő is_pro() szerint, meglévő PRO védelme, őr-trigger, jogok.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut, és
 * pozitívan ellenőrzi, hogy a szerver 127.0.0.1 – különben nem ír semmit.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SqlRest } from './helpers/sqlRest';
import { PostgresProTrialStore } from '../src/server/billing/proTrial';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_pro_trial';
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${n}`, import.meta.url)), 'utf8');

function env(db: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, PGHOST: HOST, PGDATABASE: db, PGCLIENTENCODING: 'UTF8' };
  for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete e[k];
  return e;
}
const args = (db: string, extra: string[] = []) => ['-h', HOST, '-U', process.env.PGUSER || 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra];
function psql(db: string, sql: string, extra: string[] = []): { ok: boolean; out: string; err: string } {
  try {
    return { ok: true, out: execFileSync(PSQL, args(db, extra), { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'], env: env(db) }).replace(/\r/g, '').trim(), err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(x.stdout ?? ''), err: String(x.stderr ?? '') };
  }
}
const must = (sql: string, db = DB) => { const r = psql(db, sql); if (!r.ok) throw new Error(r.err); return r.out; };
const psqlAsync = (sql: string) => new Promise<{ ok: boolean; out: string }>((resolve) => {
  const p = execFile(PSQL, args(DB, ['-c', sql]), { encoding: 'utf8', env: env(DB) }, (err, out) => resolve({ ok: !err, out: String(out ?? '').replace(/\r/g, '').trim() }));
  p.stdin?.end();
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asService = (sql: string) => `set role service_role; ${sql}`;
const approveSql = (id: string) => asService(`select public.approve_pro_trial_request('${id}', 'admin-1');`);
const approve = (id: string) => JSON.parse(must(approveSql(id)));
const insertSql = (user: string) => asService(`insert into public.pro_trial_requests (user_id, email) values ('${user}', 'u@example.com') returning id;`);
const newTrial = (user: string) => must(insertSql(user)).split('\n').pop()!;
const profile = (user: string) => must(`select subscription_status || '|' || coalesce(subscription_end::text, 'null') from public.profiles where id = '${user}'`);
const setProfile = (user: string, status: string, end: string, stripe: string | null = null) =>
  must(`update public.profiles set subscription_status = '${status}', subscription_end = ${end}, stripe_subscription_id = ${stripe ? `'${stripe}'` : 'null'} where id = '${user}'`);
/** a 0001 is_pro() a felhasználó szemszögéből (auth.uid() helyett a tesztben felülírt függvény) */
const isPro = (user: string) => must(`create or replace function auth.uid() returns uuid language sql stable as $$ select '${user}'::uuid $$; select public.is_pro();`).split('\n').pop();

describe.skipIf(!ENABLED)('0024 PRO próbaidőszak – valódi PostgreSQL 17 (helyi, eldobható DB)', () => {
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
      create schema auth; create table auth.users (id uuid primary key, email text);
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      grant usage on schema public, auth to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
    // a 0024 kétszer: újrafuttathatónak kell lennie
    for (const n of ['0001_profiles.sql', '0024_pro_trial_requests.sql', '0024_pro_trial_requests.sql']) {
      const r = psql(DB, mig(n), ['--single-transaction']);
      if (!r.ok) throw new Error(`${n}: ${r.err}`);
    }
    must(`insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@example.com' from generate_series(1, 9) g`);
  });

  beforeEach(() => {
    // az igénylések nem törölhetők (őr) – a teszt tulajdonosként, az őrt ideiglenesen kikapcsolva takarít
    must(`alter table public.pro_trial_requests disable trigger pro_trial_requests_guard; delete from public.pro_trial_requests;
      alter table public.pro_trial_requests enable trigger pro_trial_requests_guard;
      update public.profiles set subscription_status = 'free', subscription_end = null, stripe_subscription_id = null;`);
  });

  it('jóváhagyás: PRO pontosan 3 napra, kezdet/vég mentve, egy tranzakcióban; másodszor already_processed', () => {
    const id = newTrial(U(1));
    expect(profile(U(1))).toBe('free|null'); // az igénylés önmagában nem aktivál
    const r = approve(id);
    expect(r.outcome).toBe('approved');
    expect(r.request).toMatchObject({ status: 'approved', decided_by: 'admin-1' });
    expect(must(`select extract(epoch from (trial_end - trial_start))::text from public.pro_trial_requests where id = '${id}'`)).toBe('259200.000000'); // 72 óra
    expect(must(`select (p.subscription_end = t.trial_end)::text from public.profiles p join public.pro_trial_requests t on t.user_id = p.id where t.id = '${id}'`)).toBe('true');
    expect(must(`select round(extract(epoch from (subscription_end - now())) / 3600) from public.profiles where id = '${U(1)}'`)).toBe('72');
    const end = profile(U(1));
    expect(approve(id).outcome).toBe('already_processed');
    expect(profile(U(1))).toBe(end);
    expect(approve('11111111-1111-4111-8111-111111111111').outcome).toBe('not_found');
  });

  it('lejárat: a meglévő is_pro() a 3 nap alatt igaz, utána magától hamis (ütemező nélkül)', () => {
    approve(newTrial(U(2)));
    expect(isPro(U(2))).toBe('t');
    must(`update public.profiles set subscription_end = now() - interval '1 second' where id = '${U(2)}'`); // „eltelt a 3 nap”
    expect(isPro(U(2))).toBe('f');
  });

  it('fiókonként egy igénylés örökre: második beszúrás ütközik – elutasítás után is; párhuzamosan pontosan egy jön létre', async () => {
    const id = newTrial(U(3));
    expect(psql(DB, insertSql(U(3))).err).toMatch(/duplicate key|unique/);
    must(asService(`update public.pro_trial_requests set status = 'rejected', decided_at = now(), decided_by = 'admin-1' where id = '${id}'`));
    expect(psql(DB, insertSql(U(3))).err).toMatch(/duplicate key|unique/);
    const outs = await Promise.all(Array.from({ length: 6 }, () => psqlAsync(insertSql(U(4)))));
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(must(`select count(*) from public.pro_trial_requests where user_id = '${U(4)}'`)).toBe('1');
  });

  it('párhuzamos jóváhagyások: a zár miatt pontosan egy aktivál', async () => {
    const id = newTrial(U(5));
    const outs = (await Promise.all([1, 2, 3, 4].map(() => psqlAsync(approveSql(id))))).map((o) => JSON.parse(o.out.split('\n').pop()!).outcome);
    expect(outs.filter((o) => o === 'approved')).toHaveLength(1);
    expect(outs.filter((o) => o === 'already_processed')).toHaveLength(3);
  });

  it('meglévő PRO védelme: fizetős / korlátlan PRO → already_pro, Stripe → stripe_conflict; a profil és az igénylés érintetlen', () => {
    const id = newTrial(U(6));
    setProfile(U(6), 'pro', `'2099-01-01T00:00:00Z'`);
    const before = profile(U(6));
    expect(approve(id).outcome).toBe('already_pro');
    setProfile(U(6), 'pro', 'null');
    expect(approve(id).outcome).toBe('already_pro');
    setProfile(U(6), 'past_due', 'null', 'sub_1');
    expect(approve(id).outcome).toBe('stripe_conflict');
    expect(must(`select status from public.pro_trial_requests where id = '${id}'`)).toBe('pending');
    // lejárt fizetős PRO után a próbaidőszak aktiválható
    setProfile(U(6), 'pro', `now() - interval '1 day'`);
    expect(approve(id).outcome).toBe('approved');
    expect(before).toMatch(/^pro\|2099/);
  });

  it('őr: a lezárt igénylés végleges, nem törölhető, a kérelmező nem írható át; a 3 napos vég kényszer', () => {
    const id = newTrial(U(7));
    expect(psql(DB, asService(`update public.pro_trial_requests set user_id = '${U(8)}' where id = '${id}'`)).err).toMatch(/nem módosíthatók/);
    expect(psql(DB, asService(`update public.pro_trial_requests set status = 'approved', decided_at = now(), decided_by = 'x', trial_start = now(), trial_end = now() + interval '30 days' where id = '${id}'`)).err).toMatch(/decision/);
    approve(id);
    expect(psql(DB, asService(`update public.pro_trial_requests set trial_end = now() + interval '30 days' where id = '${id}'`)).err).toMatch(/lezárt/);
    expect(psql(DB, `delete from public.pro_trial_requests where id = '${id}'`).err).toMatch(/nem törölhetők/);
  });

  it('a VALÓDI Postgres-tároló hívásai a migrált sémán (service_role): létrehozás, ismétlés, lekérés, lista, jóváhagyás, elutasítás', async () => {
    const rest = new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role' });
    const store = new PostgresProTrialStore(rest as unknown as SupabaseClient);
    const a = await store.create(U(1), 'u1@example.com');
    expect(a.created).toBe(true);
    expect(a.request).toMatchObject({ userId: U(1), email: 'u1@example.com', status: 'pending', trialEnd: null });
    expect(await store.create(U(1), 'u1@example.com')).toEqual({ created: false, request: a.request });
    expect(await store.forUser(U(1))).toEqual(a.request);
    expect((await store.list('pending', 10)).map((x) => x.id)).toEqual([a.request.id]);
    // a teszt-PostgREST rpc-je nem ad vissza adatot → a VALÓDI SQL-függvény JSON-válaszát adjuk a tároló értelmezőjének
    const rpcStore = new PostgresProTrialStore({ rpc: async (_fn: string, x: { p_request_id: string }) => ({ data: approve(x.p_request_id), error: null }) } as unknown as SupabaseClient);
    const ok = await rpcStore.approve(a.request.id, 'admin-1');
    expect(ok.outcome).toBe('approved');
    expect(await store.get(a.request.id)).toEqual(ok.outcome === 'approved' ? ok.request : null);
    if (ok.outcome !== 'approved') throw new Error('nem aktivált');
    expect(new Date(ok.request.trialEnd!).getTime() - new Date(ok.request.trialStart!).getTime()).toBe(3 * 86_400_000);
    expect((await store.profileStates([U(1)])).get(U(1))).toEqual({ status: 'pro', subscriptionEnd: ok.request.trialEnd, stripeSubscriptionId: null });
    const b = await store.create(U(2), 'u2@example.com');
    expect(await store.reject(b.request.id, 'admin-1')).toMatchObject({ outcome: 'rejected', request: { status: 'rejected', decidedBy: 'admin-1' } });
    expect(await store.reject(b.request.id, 'admin-1')).toMatchObject({ outcome: 'already_processed' });
    expect(await store.reject('11111111-1111-4111-8111-111111111111', 'admin-1')).toEqual({ outcome: 'not_found' });
    expect(profile(U(2))).toBe('free|null');
  });

  it('jogok: anon/authenticated sem a táblát, sem a függvényt nem éri el (a saját státuszát sem írhatja); a service_role nem törölhet', () => {
    const id = newTrial(U(9));
    for (const role of ['anon', 'authenticated']) {
      expect(psql(DB, `set role ${role}; select 1 from public.pro_trial_requests limit 1;`).err).toMatch(/permission denied/);
      expect(psql(DB, `set role ${role}; update public.pro_trial_requests set status = 'approved';`).err).toMatch(/permission denied/);
      expect(psql(DB, `set role ${role}; insert into public.pro_trial_requests (user_id, email) values ('${U(8)}', 'x');`).err).toMatch(/permission denied/);
      expect(psql(DB, `set role ${role}; select public.approve_pro_trial_request('${id}', 'x');`).err).toMatch(/permission denied/);
    }
    expect(psql(DB, asService(`delete from public.pro_trial_requests where id = '${id}';`)).err).toMatch(/permission denied/);
    expect(must(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where table_name = 'pro_trial_requests' and grantee = 'service_role'`)).toBe('INSERT,SELECT,UPDATE');
    expect(must(`select relrowsecurity from pg_class where relname = 'pro_trial_requests'`)).toBe('t');
    expect(psql(DB, `set role authenticated; update public.profiles set subscription_status = 'pro';`).ok).toBe(false);
  });
});
