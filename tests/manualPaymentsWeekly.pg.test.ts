/**
 * 0022 – heti PRO (7 nap) a VALÓDI PostgreSQL 17-en (helyi, ELDOBHATÓ adatbázis): a 0020 utáni
 * állapotra, újrafuttatva is. ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut,
 * és pozitívan ellenőrzi, hogy a szerver 127.0.0.1.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SqlRest } from './helpers/sqlRest';
import { PostgresManualPaymentStore } from '../src/server/billing/manualPayments';
import { APP_WEEKLY_PRO_PRICE } from '../src/shared/manualPayment';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_pro_payments_weekly';
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
const insertSql = (user: string, interval: string, amount = 1490) => asService(`insert into public.pro_payment_requests (user_id, email, method, amount, currency, billing_interval, reference)
    values ('${user}', 'u@example.com', 'revolut', ${amount}, 'HUF', '${interval}', 'u@example.com') returning id;`);
const newRequest = (user: string, interval = 'week', amount = 1490) => must(insertSql(user, interval, amount)).split('\n').pop()!;
const setProfile = (user: string, status: string, end: string, stripe: string | null = null) =>
  must(`update public.profiles set subscription_status = '${status}', subscription_end = ${end}, stripe_subscription_id = ${stripe ? `'${stripe}'` : 'null'} where id = '${user}'`);
/** a lejárat és a mostani idő (vagy a megadott SQL-kifejezés) különbsége másodpercben */
const secondsFrom = (user: string, base = 'now()') => Number(must(`select round(extract(epoch from (subscription_end - ${base}))) from public.profiles where id = '${user}'`));

let weekBefore0022: { ok: boolean; err: string } = { ok: true, err: '' };

describe.skipIf(!ENABLED)('0022 heti PRO – valódi PostgreSQL 17 (helyi, eldobható DB)', () => {
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
    for (const n of ['0001_profiles.sql', '0020_pro_payment_requests.sql']) {
      const r = psql(DB, mig(n), ['--single-transaction']);
      if (!r.ok) throw new Error(`${n}: ${r.err}`);
    }
    must(`insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@example.com' from generate_series(1, 9) g`);
    // a 0022 ELŐTT a heti kérelem nem rögzíthető (ezt a szerver 503 PLAN_UNAVAILABLE-ként kezeli)
    const r = psql(DB, insertSql(U(9), 'week'));
    weekBefore0022 = { ok: r.ok, err: r.err };
    // 0022 – kétszer (újrafuttathatóság)
    for (const n of ['0022_pro_payment_weekly.sql', '0022_pro_payment_weekly.sql']) {
      const m = psql(DB, mig(n), ['--single-transaction']);
      if (!m.ok) throw new Error(`${n}: ${m.err}`);
    }
  });

  beforeEach(() => {
    must(`alter table public.pro_payment_requests disable trigger pro_payment_requests_guard; delete from public.pro_payment_requests;
      alter table public.pro_payment_requests enable trigger pro_payment_requests_guard;
      update public.profiles set subscription_status = 'free', subscription_end = null, stripe_subscription_id = null;`);
  });

  it('a 0022 előtt a heti sort a megszorítás elutasítja; utána (kétszer futtatva is) elfogadja; érvénytelen időtartam továbbra sem', () => {
    expect(weekBefore0022.ok).toBe(false);
    expect(weekBefore0022.err).toMatch(/pro_payment_requests_billing_interval_check/);
    expect(newRequest(U(1))).toMatch(/^[0-9a-f-]{36}$/);
    expect(psql(DB, insertSql(U(2), 'day')).ok).toBe(false);
    expect(must(`select count(*) from pg_constraint where conname = 'pro_payment_requests_billing_interval_check'`)).toBe('1');
  });

  it('heti jóváhagyás: pontosan 7 nap, egy tranzakcióban; a kérelem önmagában nem aktivál; másodszor already_processed', () => {
    const id = newRequest(U(1));
    expect(must(`select subscription_status from public.profiles where id = '${U(1)}'`)).toBe('free');
    const r = approve(id);
    expect(r.outcome).toBe('approved');
    expect(r.request).toMatchObject({ status: 'approved', billing_interval: 'week', decided_by: 'admin-1' });
    const s = secondsFrom(U(1));
    expect(s).toBeGreaterThan(7 * 86400 - 30);
    expect(s).toBeLessThanOrEqual(7 * 86400);
    const end = must(`select subscription_end from public.profiles where id = '${U(1)}'`);
    expect(approve(id).outcome).toBe('already_processed');
    expect(must(`select subscription_end from public.profiles where id = '${U(1)}'`)).toBe(end);
  });

  it('az adatbázisfüggvény NEM tiltja a saját kérelmet (p_admin = a kérelmező): az alkalmazással azonosan jóváhagy, 7 napra', () => {
    const id = newRequest(U(6));
    const r = JSON.parse(must(asService(`select public.approve_pro_payment_request('${id}', '${U(6)}');`)));
    expect(r.outcome).toBe('approved');
    expect(r.request).toMatchObject({ user_id: U(6), decided_by: U(6), status: 'approved' });
    expect(secondsFrom(U(6))).toBeGreaterThan(7 * 86400 - 30);
    expect(JSON.parse(must(asService(`select public.approve_pro_payment_request('${id}', '${U(6)}');`))).outcome).toBe('already_processed');
  });

  it('párhuzamos heti jóváhagyások: pontosan egy aktivál', async () => {
    const id = newRequest(U(2));
    const outs = (await Promise.all([1, 2, 3, 4].map(() => psqlAsync(approveSql(id))))).map((o) => JSON.parse(o.split('\n').pop()!).outcome);
    expect(outs.filter((o) => o === 'approved')).toHaveLength(1);
    expect(secondsFrom(U(2))).toBeLessThanOrEqual(7 * 86400);
  });

  it('pontosan 168 óra akkor is, ha a 7 nap átnyúlik az óraátállításon (a session időzónájától függetlenül)', () => {
    setProfile(U(9), 'pro', `timestamptz '2026-10-20 10:00:00+00'`);
    // a lejárat még a jövőben legyen: a teszt idejétől függetlenül egy jövőbeli, DST-t átívelő napot használunk
    must(`update public.profiles set subscription_end = timestamptz '2099-10-22 10:00:00+00' where id = '${U(9)}'`);
    for (const tz of ['Europe/Budapest', 'UTC']) {
      must(`alter database ${DB} set timezone = '${tz}'`);
      const id = newRequest(U(9));
      const before = must(`select subscription_end from public.profiles where id = '${U(9)}'`);
      expect(approve(id).outcome).toBe('approved');
      expect(Number(must(`select extract(epoch from (subscription_end - timestamptz '${before}')) from public.profiles where id = '${U(9)}'`)), tz).toBe(168 * 3600);
    }
    must(`alter database ${DB} reset timezone`);
  });

  it('meghosszabbítás és a meglévő szabályok: érvényes PRO + 7 nap a lejárattól; korlátlan nem rövidül; havi 1 hónap, éves 1 év változatlan', () => {
    setProfile(U(3), 'pro', `timestamptz '2099-01-10 12:00:00+00'`);
    approve(newRequest(U(3)));
    expect(must(`select subscription_end = timestamptz '2099-01-17 12:00:00+00' from public.profiles where id = '${U(3)}'`)).toBe('t');
    setProfile(U(4), 'pro', 'null');
    expect(approve(newRequest(U(4))).request.activated_until).toBeNull();
    approve(newRequest(U(5), 'month', 2990));
    expect(must(`select (subscription_end - now()) between interval '27 days' and interval '32 days' from public.profiles where id = '${U(5)}'`)).toBe('t');
    approve(newRequest(U(6), 'year', 2990));
    expect(must(`select (subscription_end - now()) > interval '364 days' from public.profiles where id = '${U(6)}'`)).toBe('t');
  });

  it('élő Stripe-előfizetés: stripe_conflict a heti kérelemre is, a profil érintetlen', () => {
    setProfile(U(7), 'pro', `now() + interval '20 days'`, 'sub_123');
    const r = approve(newRequest(U(7)));
    expect(r.outcome).toBe('stripe_conflict');
    expect(must(`select status from public.pro_payment_requests where user_id = '${U(7)}'`)).toBe('pending');
  });

  it('őr és jogok változatlanok: a kérelem időtartama nem írható át; anon/authenticated nem hívhatja a függvényt', () => {
    const id = newRequest(U(8));
    expect(psql(DB, asService(`update public.pro_payment_requests set billing_interval = 'year' where id = '${id}'`)).err).toMatch(/nem módosíthatók/);
    for (const role of ['anon', 'authenticated']) {
      expect(psql(DB, `set role ${role}; select public.approve_pro_payment_request('${id}', 'x');`).err, role).toMatch(/permission denied/);
    }
    expect(must(`select has_function_privilege('service_role', 'public.approve_pro_payment_request(uuid, text)', 'execute')`)).toBe('t');
  });

  it('a VALÓDI PostgresManualPaymentStore a migrált sémán: heti kérelem 1 490 Ft-tal és lekérdezés; jóváhagyás ugyanazzal az SQL-függvénnyel 7 napra', async () => {
    const store = new PostgresManualPaymentStore(new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role' }) as unknown as SupabaseClient);
    const out = await store.createPending({ userId: U(1), email: 'u1@example.com', method: 'bank_transfer', price: APP_WEEKLY_PRO_PRICE, reference: 'u1@example.com' });
    expect(out.created).toBe(true);
    expect(out.request).toMatchObject({ amount: 1490, currency: 'HUF', interval: 'week', status: 'pending' });
    expect(await store.get(out.request.id)).toMatchObject({ id: out.request.id, userId: U(1), interval: 'week' });
    expect(await store.get('11111111-1111-4111-8111-111111111111')).toBeNull();
    // a teszt-segéd (SqlRest) rpc-je a függvény eredményét nem adja vissza – a jóváhagyás ugyanazzal a
    // függvénnyel, közvetlenül fut (élesben a tároló a PostgREST rpc-n át ugyanezt hívja)
    expect(approve(out.request.id).outcome).toBe('approved');
    expect((await store.get(out.request.id))!.status).toBe('approved');
    expect(secondsFrom(U(1))).toBeGreaterThan(7 * 86400 - 60);
  });
});
