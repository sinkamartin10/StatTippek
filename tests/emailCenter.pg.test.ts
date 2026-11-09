/**
 * 0025 – Email Center a VALÓDI PostgreSQL 17-en (helyi, ELDOBHATÓ adatbázis): a meglévő felhasználók nem válnak
 * hozzájárulóvá, a regisztrációs hozzájárulás a regisztráció tranzakciójában és a Supabase regisztrációs idejével
 * rögzül (trigger), a hozzájárulás auditálható naplója, no-op ismétlés, őrök, egyediség (duplikált küldés ellen),
 * csak megerősített címre küldés, jogok, valamint a PostgresEmailStore PostgREST-hívásai a migrált sémán.
 *
 * Az auth.users itt a valódi Supabase-tábla releváns oszlopaival készül (raw_user_meta_data, created_at,
 * email_confirmed_at) – a Supabase Auth ezeket tölti a regisztrációkor.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut, és
 * pozitívan ellenőrzi, hogy a szerver 127.0.0.1 – különben nem ír semmit.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SqlRest } from './helpers/sqlRest';
import { PostgresEmailStore } from '../src/server/email/store';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_email_center';
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
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asService = (sql: string) => `set role service_role; ${sql}`;
const setConsent = (n: number, granted: boolean, source = 'profile') =>
  JSON.parse(must(asService(`select public.set_marketing_consent('${U(n)}', ${granted}, '${source}', 'v1');`)).split('\n').pop()!);
const newCampaign = (kind = 'marketing', audience = 'all') =>
  must(asService(`insert into public.email_campaigns (kind, audience, subject, html, created_by) values ('${kind}', '${audience}', 'T', '<p>x</p>', 'admin') returning id;`)).split('\n').pop()!;

describe.skipIf(!ENABLED)('0025 Email Center – valódi PostgreSQL 17 (helyi, eldobható DB)', () => {
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
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, created_at timestamptz default now(), email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      grant usage on schema public, auth to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
    let r = psql(DB, mig('0001_profiles.sql'), ['--single-transaction']);
    if (!r.ok) throw new Error(`0001: ${r.err}`);
    // a MEGLÉVŐ felhasználók a 0025 előtt jönnek létre (a profilt a 0001 triggere hozza létre)
    must(`insert into auth.users (id, email, email_confirmed_at) select ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@example.com', now() from generate_series(1, 9) g`);
    for (let i = 0; i < 2; i++) { // a 0025 kétszer: újrafuttathatónak kell lennie
      r = psql(DB, mig('0025_email_center.sql'), ['--single-transaction']);
      if (!r.ok) throw new Error(`0025: ${r.err}`);
    }
  });

  beforeEach(() => {
    must(`alter table public.email_consent_events disable trigger email_consent_events_guard;
      alter table public.email_campaigns disable trigger email_campaigns_guard;
      delete from public.email_deliveries; delete from public.email_campaigns; delete from public.email_consent_events; delete from public.email_marketing_consents;
      alter table public.email_consent_events enable trigger email_consent_events_guard;
      alter table public.email_campaigns enable trigger email_campaigns_guard;
      update public.profiles set subscription_status = 'free', subscription_end = null;`);
  });

  it('a meglévő felhasználók NEM váltak hozzájárulóvá (a migráció egy sort sem tölt fel)', () => {
    // a beforeEach előtti állapotot a migráció után közvetlenül nem látjuk, ezért a táblát egy friss migráció-futás után nézzük
    must(`alter table public.email_consent_events disable trigger email_consent_events_guard; delete from public.email_consent_events; alter table public.email_consent_events enable trigger email_consent_events_guard;`);
    const r = psql(DB, mig('0025_email_center.sql'), ['--single-transaction']);
    expect(r.ok).toBe(true);
    expect(must('select count(*) from public.email_marketing_consents')).toBe('0');
    expect(must('select count(*) from public.email_consent_events')).toBe('0');
  });

  it('hozzájárulás: megadás naplózva (idő, forrás, szövegverzió); ismétlés no-op; visszavonás; leiratkozó forrással nem adható', () => {
    const a = setConsent(1, true);
    expect(a.changed).toBe(true);
    expect(a.state).toMatchObject({ consented: true, consent_source: 'profile' });
    expect(setConsent(1, true).changed).toBe(false);
    expect(setConsent(1, false, 'unsubscribe_link').state).toMatchObject({ consented: false, revoke_source: 'unsubscribe_link', consent_source: 'profile' });
    expect(setConsent(1, false, 'one_click').changed).toBe(false);
    expect(must(`select string_agg(granted || ':' || source || ':' || text_version, ',' order by id) from public.email_consent_events where user_id = '${U(1)}'`))
      .toBe('true:profile:v1,false:unsubscribe_link:v1');
    expect(psql(DB, asService(`select public.set_marketing_consent('${U(2)}', true, 'unsubscribe_link', 'v1');`)).err).toMatch(/csak a profilban/);
    expect(psql(DB, asService(`select public.set_marketing_consent('${U(2)}', true, 'ismeretlen', 'v1');`)).ok).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Regisztrációs hozzájárulás (trigger az auth.users beszúrásán)
  // ---------------------------------------------------------------------------
  let seq = 100;
  /** regisztráció úgy, ahogy a Supabase Auth végzi: egy auth.users sor a kérés metaadataival és a szerver idejével */
  const register = (meta: string | null, createdAt = '2026-11-01 10:00:00+00') => {
    const id = U(++seq);
    must(`insert into auth.users (id, email, raw_user_meta_data, created_at) values ('${id}', 'r${seq}@example.com', ${meta === null ? 'null' : `'${meta}'::jsonb`}, '${createdAt}')`);
    return id;
  };
  const consentRow = (id: string) => must(`select coalesce(consented::text, 'nincs') || '|' || coalesce(consent_source, '-') || '|' || coalesce(to_char(consented_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-') from public.email_marketing_consents where user_id = '${id}'`) || 'nincs sor';
  const events = (id: string) => must(`select coalesce(string_agg(granted || ':' || source || ':' || text_version || ':' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), ',' order by id), '') from public.email_consent_events where user_id = '${id}'`);

  it('regisztrációs időbélyeg: a hozzájárulás ideje a Supabase regisztrációs ideje (auth.users.created_at), forrása registration', () => {
    const id = register('{"marketing_opt_in": true, "marketing_opt_in_version": "v1"}', '2026-11-01 10:00:00+00');
    expect(consentRow(id)).toBe('true|registration|2026-11-01 10:00:00');
    expect(events(id)).toBe('true:registration:v1:2026-11-01 10:00:00');
  });

  it('rögzítés a regisztrációkor, bejelentkezés nélkül: a megerősítés / első bejelentkezés semmit nem ír át és nem naplóz', () => {
    const id = register('{"marketing_opt_in": true}');
    // a Supabase a megerősítéskor / bejelentkezéskor az auth.users sort frissíti – ez nem hozzájárulási esemény
    must(`update auth.users set email_confirmed_at = '2026-11-03 08:00:00+00' where id = '${id}'`);
    expect(consentRow(id)).toBe('true|registration|2026-11-01 10:00:00');
    expect(events(id).split(',')).toHaveLength(1);
  });

  it('manipulált kliensadat: kliens-időbélyeget nem fogad el, csak a JSON true számít, érvénytelen verzió → v1', () => {
    const at = register('{"marketing_opt_in": true, "marketing_opt_in_at": "2000-01-01T00:00:00Z", "marketing_opt_in_version": "v1; drop table x"}', '2026-11-02 12:30:00+00');
    expect(consentRow(at)).toBe('true|registration|2026-11-02 12:30:00');
    expect(events(at)).toBe('true:registration:v1:2026-11-02 12:30:00');
    for (const meta of ['{"marketing_opt_in": "true"}', '{"marketing_opt_in": 1}', '{"marketing_opt_in": false}', '{}', null]) {
      expect(consentRow(register(meta)), String(meta)).toBe('nincs sor');
    }
  });

  it('a metaadat későbbi módosítása soha nem ad hozzájárulást (nincs visszadátumozás); leiratkozás után sem iratkoztat fel', () => {
    const later = register('{}');
    must(`update auth.users set raw_user_meta_data = '{"marketing_opt_in": true}' where id = '${later}'`);
    expect(consentRow(later)).toBe('nincs sor');
    const unsub = register('{"marketing_opt_in": true}');
    must(asService(`select public.set_marketing_consent('${unsub}', false, 'unsubscribe_link', 'v1');`));
    must(`update auth.users set raw_user_meta_data = '{"marketing_opt_in": true, "x": 1}' where id = '${unsub}'`);
    expect(consentRow(unsub)).toMatch(/^false\|registration\|/);
    expect(events(unsub).split(',').map((e) => e.split(':').slice(0, 2).join(':'))).toEqual(['true:registration', 'false:unsubscribe_link']);
  });

  it('regisztrációs hozzájárulás API-n át nem hamisítható; profilban a felhasználó maga újra feliratkozhat', () => {
    expect(psql(DB, asService(`select public.set_marketing_consent('${U(2)}', true, 'registration', 'v1');`)).err).toMatch(/csak a profilban/);
    expect(psql(DB, asService(`select public.set_marketing_consent('${U(2)}', false, 'registration', 'v1');`)).err).toMatch(/csak a regisztráció/);
    const id = register('{"marketing_opt_in": true}');
    must(asService(`select public.set_marketing_consent('${id}', false, 'unsubscribe_link', 'v1');`));
    expect(JSON.parse(must(asService(`select public.set_marketing_consent('${id}', true, 'profile', 'v1');`)).split('\n').pop()!).changed).toBe(true);
  });

  it('a hozzájárulás rögzítésének hibája nem akasztja meg a regisztrációt', () => {
    must(`alter table public.email_consent_events add constraint tmp_fail check (false) not valid`);
    try {
      const id = register('{"marketing_opt_in": true}');
      expect(must(`select count(*) from auth.users where id = '${id}'`)).toBe('1');
      expect(consentRow(id)).toBe('nincs sor');
    } finally { must(`alter table public.email_consent_events drop constraint tmp_fail`); }
  });

  it('a regisztrációs napló is csak hozzáfűzhető: nem módosítható, nem törölhető', () => {
    const id = register('{"marketing_opt_in": true}');
    expect(psql(DB, `update public.email_consent_events set created_at = now() where user_id = '${id}'`).err).toMatch(/nem módosítható/);
    expect(psql(DB, `delete from public.email_consent_events where user_id = '${id}'`).err).toMatch(/nem módosítható/);
    expect(events(id).split(',')).toHaveLength(1);
  });

  it('a hozzájárulási napló nem módosítható és nem törölhető', () => {
    setConsent(3, true);
    expect(psql(DB, `update public.email_consent_events set granted = false`).err).toMatch(/nem módosítható/);
    expect(psql(DB, `delete from public.email_consent_events`).err).toMatch(/nem módosítható/);
  });

  it('kampány: rendszerüzenet nem célozhat hozzájárulókat; nyilatkozat nélkül nem küldhető; elküldve a tartalom zárolt; nem törölhető', () => {
    expect(psql(DB, asService(`insert into public.email_campaigns (kind, audience, subject, html, created_by) values ('system', 'marketing_consent', 'T', 'x', 'a')`)).err).toMatch(/system_audience/);
    const sys = newCampaign('system', 'all');
    expect(psql(DB, asService(`update public.email_campaigns set status = 'sending' where id = '${sys}'`)).err).toMatch(/system_attested/);
    must(asService(`update public.email_campaigns set status = 'sending', system_attested = true where id = '${sys}'`));
    expect(psql(DB, asService(`update public.email_campaigns set subject = 'más' where id = '${sys}'`)).err).toMatch(/nem módosítható/);
    expect(psql(DB, asService(`update public.email_campaigns set status = 'draft' where id = '${sys}'`)).err).toMatch(/piszkozatra/);
    must(asService(`update public.email_campaigns set status = 'sent', sent_count = 9 where id = '${sys}'`)); // a statisztika írható
    expect(psql(DB, `delete from public.email_campaigns where id = '${sys}'`).err).toMatch(/nem törölhetők/);
  });

  it('küldési napló: egy kampányban egy fiók és egy cím (kis-nagybetűtől függetlenül) legfeljebb egyszer', () => {
    const c = newCampaign();
    must(asService(`insert into public.email_deliveries (campaign_id, user_id, email) values ('${c}', '${U(1)}', 'u1@example.com')`));
    expect(psql(DB, asService(`insert into public.email_deliveries (campaign_id, user_id, email) values ('${c}', '${U(1)}', 'x@example.com')`)).err).toMatch(/email_deliveries_once/);
    expect(psql(DB, asService(`insert into public.email_deliveries (campaign_id, user_id, email) values ('${c}', '${U(2)}', 'U1@Example.com')`)).err).toMatch(/uq_email_deliveries_campaign_email/);
  });

  it('jogok: anon/authenticated sem a táblákat, sem a függvényt nem éri el; a service_role nem törölhet', () => {
    for (const role of ['anon', 'authenticated']) {
      for (const t of ['email_marketing_consents', 'email_consent_events', 'email_campaigns', 'email_deliveries']) {
        expect(psql(DB, `set role ${role}; select 1 from public.${t} limit 1;`).err, `${role} ${t}`).toMatch(/permission denied/);
      }
      expect(psql(DB, `set role ${role}; select public.set_marketing_consent('${U(1)}', true, 'profile', 'v1');`).err).toMatch(/permission denied/);
      // a megerősítettséget (auth.users) is mutató címzett-nézet sem olvasható
      expect(psql(DB, `set role ${role}; select 1 from public.email_recipients limit 1;`).err, `${role} email_recipients`).toMatch(/permission denied/);
    }
    const c = newCampaign();
    expect(psql(DB, asService(`delete from public.email_campaigns where id = '${c}'`)).err).toMatch(/permission denied/);
    for (const t of ['email_marketing_consents', 'email_campaigns', 'email_deliveries']) {
      expect(must(`select relrowsecurity from pg_class where relname = '${t}'`)).toBe('t');
    }
  });

  it('a VALÓDI Postgres-tároló hívásai a migrált sémán (service_role)', async () => {
    const store = new PostgresEmailStore(new SqlRest({ host: HOST, db: DB, psql: PSQL, role: 'service_role' }) as unknown as SupabaseClient);
    must(`update public.profiles set subscription_status = 'pro', subscription_end = null where id = '${U(5)}';
      update public.profiles set subscription_status = 'pro', subscription_end = now() - interval '1 day' where id = '${U(6)}';
      update public.profiles set email = null where id = '${U(9)}';
      update auth.users set email_confirmed_at = null where id = '${U(8)}';`); // U8: meg nem erősített cím
    setConsent(1, true); setConsent(5, true);
    const rec = await store.listRecipients();
    // csak megerősített cím: az U8 (meg nem erősített) és a regisztrációs tesztek meg nem erősített fiókjai kimaradnak;
    // a regisztrációs tesztben megerősített fiók (r102) címzett
    expect(rec.filter((r) => r.email.startsWith('u')).map((r) => r.userId).sort()).toEqual([1, 2, 3, 4, 5, 6, 7].map(U));
    expect(rec.filter((r) => r.email.startsWith('r')).map((r) => r.email)).toEqual(['r102@example.com']);
    expect(rec.find((r) => r.userId === U(5))).toMatchObject({ pro: true, consented: true, email: 'u5@example.com' });
    expect(rec.find((r) => r.userId === U(6))).toMatchObject({ pro: false, consented: false });
    expect([...(await store.consentedAmong([U(1), U(2), U(5)]))].sort()).toEqual([U(1), U(5)]);
    expect(await store.countConsented()).toBe(2);
    expect(await store.getConsent(U(1))).toMatchObject({ consented: true, consentSource: 'profile' });
    expect(await store.getConsent(U(2))).toEqual({ consented: false, consentedAt: null, consentSource: null, revokedAt: null });

    const c = await store.createCampaign({ kind: 'marketing', audience: 'all', subject: 'Hír', html: '<p>x</p>', createdBy: 'admin@example.com' });
    expect(c).toMatchObject({ status: 'draft', kind: 'marketing', recipientCount: 0 });
    expect((await store.updateDraft(c.id, { subject: 'Hírek' }))?.subject).toBe('Hírek');
    expect(await store.claimCampaign(c.id, ['draft'], { admin: 'admin@example.com', attested: false, recipientCount: 2 })).toMatchObject({ status: 'sending', recipientCount: 2 });
    expect(await store.claimCampaign(c.id, ['draft'])).toBeNull(); // második megerősítés: nincs mit átvenni
    expect(await store.updateDraft(c.id, { subject: 'más' })).toBeNull();

    const two = rec.filter((r) => r.consented);
    expect(await store.addDeliveries(c.id, two)).toBe(2);
    expect(await store.addDeliveries(c.id, two)).toBe(0); // duplikáció kizárva
    const todo = await store.deliveriesToSend(c.id, ['pending'], 3, 10);
    expect(todo.map((d) => d.email).sort()).toEqual(['u1@example.com', 'u5@example.com']);
    await store.updateDeliveries([todo[0].id], { status: 'sent', attempts: 1, providerMessageId: 'msg-1', sentAt: new Date().toISOString() });
    await store.updateDeliveries([todo[1].id], { status: 'failed', attempts: 3, lastError: 'x'.repeat(900) });
    expect(await store.deliveriesToSend(c.id, ['pending', 'failed'], 3, 10)).toEqual([]); // a kísérletkorlát elérve
    const stats = await store.deliveryStats(c.id);
    expect(stats).toEqual({ pending: 0, sending: 0, sent: 1, failed: 1, skipped: 0 });
    expect(must(`select char_length(last_error) from public.email_deliveries where id = '${todo[1].id}'`)).toBe('500');
    await store.finishCampaign(c.id, 'partial', stats);
    expect(await store.getCampaign(c.id)).toMatchObject({ status: 'partial', sentCount: 1, failedCount: 1 });
    expect((await store.listCampaigns(10)).map((x) => x.id)).toEqual([c.id]);
  });
});
