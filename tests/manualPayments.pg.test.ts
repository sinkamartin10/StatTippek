/**
 * 0020 – PRO kézi fizetés a VALÓDI PostgreSQL 17-en (helyi, ELDOBHATÓ adatbázis):
 * a jóváhagyás + PRO-aktiválás egy tranzakcióban, kettős/párhuzamos feldolgozás,
 * Stripe-ütközés, meglévő jogosultságok megőrzése, őr-trigger, jogok.
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
import { PostgresManualPaymentStore } from '../src/server/billing/manualPayments';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_pro_payments';
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
const psqlAsync = (sql: string) => new Promise<string>((resolve, reject) => {
  const p = execFile(PSQL, args(DB, ['-c', sql]), { encoding: 'utf8', env: env(DB) }, (err, out) => (err ? reject(err) : resolve(out.replace(/\r/g, '').trim())));
  p.stdin?.end();
});

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asService = (sql: string) => `set role service_role; ${sql}`;
const approveSql = (id: string) => asService(`select public.approve_pro_payment_request('${id}', 'admin-1');`);
const approve = (id: string) => JSON.parse(must(approveSql(id)));
const newRequest = (user: string, interval = 'month') =>
  must(asService(`insert into public.pro_payment_requests (user_id, email, method, amount, currency, billing_interval, reference)
    values ('${user}', 'u@example.com', 'bank_transfer', 2990, 'HUF', '${interval}', 'u@example.com') returning id;`)).split('\n').pop()!;
const profile = (user: string) => must(`select subscription_status || '|' || coalesce(subscription_end::text, 'null') || '|' || coalesce(stripe_subscription_id, 'null') from public.profiles where id = '${user}'`);
const setProfile = (user: string, status: string, end: string, stripe: string | null = null) =>
  must(`update public.profiles set subscription_status = '${status}', subscription_end = ${end}, stripe_subscription_id = ${stripe ? `'${stripe}'` : 'null'} where id = '${user}'`);
const months = (user: string) => Number(must(`select round(extract(epoch from (subscription_end - now())) / 86400) from public.profiles where id = '${user}'`));

describe.skipIf(!ENABLED)('0020 PRO kézi fizetés – valódi PostgreSQL 17 (helyi, eldobható DB)', () => {
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
    for (const n of ['0001_profiles.sql', '0020_pro_payment_requests.sql', '0020_pro_payment_requests.sql']) {
      const r = psql(DB, mig(n), ['--single-transaction']);
      if (!r.ok) throw new Error(`${n}: ${r.err}`);
    }
    // a profilokat a 0001 triggere hozza létre a felhasználókkal együtt
    must(`insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@example.com' from generate_series(1, 9) g`);
  });

  beforeEach(() => {
    // a kérelmek nem törölhetők (őr) – a teszt tulajdonosként, az őrt ideiglenesen kikapcsolva takarít
    must(`alter table public.pro_payment_requests disable trigger pro_payment_requests_guard; delete from public.pro_payment_requests;
      alter table public.pro_payment_requests enable trigger pro_payment_requests_guard;
      update public.profiles set subscription_status = 'free', subscription_end = null, stripe_subscription_id = null;`);
  });

  it('jóváhagyás: kérelem lezárva + PRO aktiválva 1 hónapra, egy tranzakcióban; másodszor already_processed', () => {
    const id = newRequest(U(1));
    expect(profile(U(1))).toBe('free|null|null'); // a kérelem önmagában nem aktivál
    const r = approve(id);
    expect(r.outcome).toBe('approved');
    expect(r.request).toMatchObject({ status: 'approved', decided_by: 'admin-1' });
    expect(profile(U(1))).toMatch(/^pro\|\d{4}-.*\|null$/);
    expect(months(U(1))).toBeGreaterThanOrEqual(28);
    expect(months(U(1))).toBeLessThanOrEqual(31);
    const end = profile(U(1));
    expect(approve(id).outcome).toBe('already_processed');
    expect(profile(U(1))).toBe(end);
    expect(approve('11111111-1111-4111-8111-111111111111').outcome).toBe('not_found');
  });

  it('párhuzamos jóváhagyások: a zár miatt pontosan egy aktivál, a lejárat egyszer hosszabbodik', async () => {
    const id = newRequest(U(2));
    const outs = (await Promise.all([1, 2, 3, 4].map(() => psqlAsync(approveSql(id))))).map((o) => JSON.parse(o.split('\n').pop()!).outcome);
    expect(outs.filter((o) => o === 'approved')).toHaveLength(1);
    expect(outs.filter((o) => o === 'already_processed')).toHaveLength(3);
    expect(months(U(2))).toBeLessThanOrEqual(31);
  });

  it('meglévő jogosultságok: érvényes PRO a lejárattól hosszabbodik; korlátlan PRO nem rövidül; évesnél 1 év', () => {
    setProfile(U(3), 'pro', `now() + interval '10 days'`);
    approve(newRequest(U(3)));
    expect(months(U(3))).toBeGreaterThanOrEqual(38);

    setProfile(U(4), 'pro', 'null');
    const r = approve(newRequest(U(4)));
    expect(r.outcome).toBe('approved');
    expect(r.request.activated_until).toBeNull();
    expect(profile(U(4))).toBe('pro|null|null');

    approve(newRequest(U(5), 'year'));
    expect(months(U(5))).toBeGreaterThanOrEqual(364);
  });

  it('élő Stripe-előfizetés (pro vagy past_due): stripe_conflict, a profil és a kérelem érintetlen; lejárt Stripe-os fiók aktiválható', () => {
    setProfile(U(6), 'pro', `now() + interval '20 days'`, 'sub_live');
    const before = profile(U(6));
    const id = newRequest(U(6));
    expect(approve(id).outcome).toBe('stripe_conflict');
    expect(profile(U(6))).toBe(before);
    expect(must(`select status from public.pro_payment_requests where id = '${id}'`)).toBe('pending');
    setProfile(U(6), 'past_due', 'null', 'sub_live');
    expect(approve(id).outcome).toBe('stripe_conflict');

    setProfile(U(7), 'canceled', `now() - interval '1 day'`, 'sub_old');
    expect(approve(newRequest(U(7))).outcome).toBe('approved');
    expect(profile(U(7))).toMatch(/^pro\|.*\|sub_old$/); // a Stripe-azonosítóhoz nem nyúl
  });

  it('felhasználónként egy függő kérelem; elutasítás után nem fogadható el; a lezárt kérelem végleges, nem törölhető', () => {
    const id = newRequest(U(8));
    expect(psql(DB, asService(`insert into public.pro_payment_requests (user_id, email, method, amount, currency, billing_interval, reference)
      values ('${U(8)}', 'u@example.com', 'revolut', 2990, 'HUF', 'month', 'u@example.com');`)).err).toMatch(/uq_pro_payment_requests_one_pending/);
    expect(must(asService(`update public.pro_payment_requests set status = 'rejected', decided_at = now(), decided_by = 'admin-1', decision_note = 'nem jött meg'
      where id = '${id}' and status = 'pending' returning id;`)).split('\n').pop()).toBe(id);
    expect(approve(id).outcome).toBe('already_processed');
    expect(profile(U(8))).toBe('free|null|null');
    expect(psql(DB, asService(`update public.pro_payment_requests set status = 'approved' where id = '${id}';`)).err).toMatch(/lezárt kérelem nem módosítható/);
    expect(psql(DB, `delete from public.pro_payment_requests where id = '${id}';`).err).toMatch(/nem törölhetők/);
    const id2 = newRequest(U(8)); // a lezárt mellett új függő kérelem már lehet
    expect(psql(DB, asService(`update public.pro_payment_requests set amount = 1 where id = '${id2}';`)).err).toMatch(/adatai nem módosíthatók/);
    expect(psql(DB, asService(`insert into public.pro_payment_requests (user_id, email, method, amount, currency, billing_interval, reference, status)
      values ('${U(9)}', 'u@example.com', 'bank_transfer', 2990, 'HUF', 'month', 'u@example.com', 'approved');`)).err).toMatch(/decision/);
  });

  it('a VALÓDI Postgres-tároló PostgREST-hívásai a migrált sémán (service_role): létrehozás, ismétlés, lista, profilállapot, elutasítás', async () => {
    const rest = new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role' });
    const store = new PostgresManualPaymentStore(rest as unknown as SupabaseClient);
    const price = { amount: 2990, currency: 'HUF', interval: 'month' as const, label: '2 990 Ft/hó', source: 'app' as const };
    const a = await store.createPending({ userId: U(1), email: 'u1@example.com', method: 'revolut', price, reference: 'u1@example.com' });
    expect(a.created).toBe(true);
    expect(a.request).toMatchObject({ userId: U(1), method: 'revolut', amount: 2990, currency: 'HUF', interval: 'month', status: 'pending', decidedAt: null });
    const again = await store.createPending({ userId: U(1), email: 'u1@example.com', method: 'bank_transfer', price, reference: 'u1@example.com' });
    expect(again).toEqual({ created: false, request: a.request });
    expect((await store.listForUser(U(1), 10)).map((x) => x.id)).toEqual([a.request.id]);
    expect((await store.list('pending', 10)).map((x) => x.id)).toEqual([a.request.id]);
    setProfile(U(1), 'pro', `now() + interval '3 days'`, 'sub_x');
    expect((await store.profileStates([U(1)])).get(U(1))).toMatchObject({ status: 'pro', stripeSubscriptionId: 'sub_x' });
    const rej = await store.reject(a.request.id, 'admin-1', 'nem jött meg');
    expect(rej).toMatchObject({ outcome: 'rejected', request: { status: 'rejected', decisionNote: 'nem jött meg', decidedBy: 'admin-1' } });
    expect(await store.reject(a.request.id, 'admin-1', null)).toMatchObject({ outcome: 'already_processed' });
    expect(await store.reject('11111111-1111-4111-8111-111111111111', 'admin-1', null)).toEqual({ outcome: 'not_found' });
    expect(profile(U(1))).toMatch(/^pro\|.*\|sub_x$/); // az elutasítás a profilhoz nem nyúl
  });

  it('jogok: anon/authenticated sem a táblát, sem a függvényt nem éri el; a service_role nem törölhet', () => {
    const id = newRequest(U(1));
    for (const role of ['anon', 'authenticated']) {
      expect(psql(DB, `set role ${role}; select 1 from public.pro_payment_requests limit 1;`).err).toMatch(/permission denied/);
      expect(psql(DB, `set role ${role}; select public.approve_pro_payment_request('${id}', 'x');`).err).toMatch(/permission denied/);
    }
    expect(psql(DB, asService(`delete from public.pro_payment_requests where id = '${id}';`)).err).toMatch(/permission denied/);
    expect(must(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
      where table_name = 'pro_payment_requests' and grantee = 'service_role'`)).toBe('INSERT,SELECT,UPDATE');
    expect(must(`select relrowsecurity from pg_class where relname = 'pro_payment_requests'`)).toBe('t');
    // a profiles tábla védelme (0001) változatlan: felhasználói szerepkör nem írhat előfizetési mezőt
    expect(psql(DB, `set role authenticated; update public.profiles set subscription_status = 'pro';`).ok).toBe(false);
  });
});
