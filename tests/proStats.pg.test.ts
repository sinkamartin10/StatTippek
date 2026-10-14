/**
 * Nyilvános PRO-szám a VALÓDI PostgreSQL 17-en (helyi, ELDOBHATÓ adatbázis):
 *  - a `supabaseActiveProCounter` PostgREST-lekérdezése (a SqlRest utánzattal,
 *    service_role szerepben) ugyanazt számolja, mint a 0001 `is_pro()` szabálya,
 *  - a darabszám nem ír a profiles táblába,
 *  - a beállítás a VALÓDI PostgresAppStore-on át az app_settings táblában tartós.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut, és
 * pozitívan ellenőrzi, hogy a szerver 127.0.0.1 – különben nem ír semmit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SqlRest } from './helpers/sqlRest';
import { supabaseActiveProCounter } from '../src/server/billing/proStats';
import { PostgresAppStore } from '../src/server/db/appStore';
import { PRO_COUNTER_SETTING_KEY } from '../src/shared/proStats';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_pro_stats';
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${n}`, import.meta.url)), 'utf8');

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
const rest = () => new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role' });

describe.skipIf(!ENABLED)('Nyilvános PRO-szám – valódi PostgreSQL 17 (helyi, eldobható DB)', () => {
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
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
    for (const n of ['0001_profiles.sql', '0003_app_data.sql']) {
      const r = psql(DB, mig(n), ['--single-transaction']);
      if (!r.ok) throw new Error(`${n}: ${r.err}`);
    }
    must(`insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@example.com' from generate_series(1, 8) g;
      update public.profiles set subscription_status = v.s, subscription_end = v.e from (values
        (1, 'pro', null::timestamptz), (2, 'pro', now() + interval '10 days'), (3, 'pro', now() + interval '1 hour'),
        (4, 'pro', now() - interval '1 day'), (5, 'past_due', now() + interval '5 days'), (6, 'canceled', null), (7, 'free', null), (8, 'free', null)
      ) as v(n, s, e) where id = ('00000000-0000-4000-8000-' || lpad(v.n::text, 12, '0'))::uuid;`);
  });

  it('a darabszám ugyanazt adja, mint a jogosultság szabálya (is_pro: pro és nincs/jövőbeli lejárat), és nem ír', async () => {
    const reference = Number(must(`select count(*) from public.profiles where subscription_status = 'pro' and (subscription_end is null or subscription_end > now())`));
    expect(reference).toBe(3);
    const before = must(`select md5(string_agg(id || subscription_status || coalesce(subscription_end::text, ''), ',' order by id)) from public.profiles`);
    const count = await supabaseActiveProCounter(rest() as unknown as SupabaseClient)();
    expect(count).toBe(reference);
    expect(must(`select md5(string_agg(id || subscription_status || coalesce(subscription_end::text, ''), ',' order by id)) from public.profiles`)).toBe(before);
  });

  it('a megjelenítési beállítás az app_settings-ben tartós: a valódi PostgresAppStore új példánya is visszaolvassa', async () => {
    const make = () => { const s = new PostgresAppStore('http://127.0.0.1:9', 'helyi-teszt-kulcs-nem-titok'); (s as unknown as { db: unknown }).db = rest(); return s; };
    // A meglévő setSetting upsert(onConflict: key) – a SqlRest utánzat ezt (ignoreDuplicates nélkül) nem
    // emulálja, ezért az írás itt ugyanazzal a szemantikával SQL-ben történik; az OLVASÁS a valódi tárolón át.
    const write = (v: string) => must(`set role service_role; insert into public.app_settings (key, value) values ('${PRO_COUNTER_SETTING_KEY}', '${v}')
      on conflict (key) do update set value = excluded.value, updated_at = now();`);
    write(JSON.stringify({ showPublic: true, updatedAt: '2026-10-14T11:00:00.000Z', updatedBy: 'admin-1' }));
    const value = JSON.stringify({ showPublic: false, updatedAt: '2026-10-14T12:00:00.000Z', updatedBy: 'admin-1' });
    write(value);
    expect(await make().getSetting(PRO_COUNTER_SETTING_KEY)).toBe(value);
    expect(must(`select count(*) from public.app_settings where key = '${PRO_COUNTER_SETTING_KEY}'`)).toBe('1');
    // anon/authenticated nem fér hozzá (0003): a beállítást csak a szerver írhatja
    for (const role of ['anon', 'authenticated']) {
      expect(psql(DB, `set role ${role}; update public.app_settings set value = 'x';`).err).toMatch(/permission denied/);
    }
  });
});
