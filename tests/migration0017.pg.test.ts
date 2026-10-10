/**
 * 0017 – `model_learning_events_kind` kiegészítése a 'shadow_evaluation'
 * típussal: valódi PostgreSQL 17 teszt egy HELYI, eldobható adatbázison.
 *
 * Két út:
 *  - FRISSÍTÉS (a production állapota): 0014 → a 0015 KORÁBBI változata
 *    (megszorítás 'shadow_evaluation' nélkül, meglévő eseményekkel) → 0016 → 0017 ×2
 *  - FRISS TELEPÍTÉS: 0014 → 0015 → 0016 → 0017 ×2 (a 0017-nek no-opnak kell lennie)
 * Mindkét úton a teljes releváns katalógust pillanatképezzük előtte és utána:
 * a 0017 semmi mást nem változtathat, mint az esemény-típus megszorítást.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut. A gép
 * kódba írva 127.0.0.1, az átirányító libpq-változók törölve, és a `beforeAll`
 * pozitívan ellenőrzi, hogy a szerver helyi – különben megszakít.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1';
const PSQL = process.env.PSQL || 'psql';
const DB = { upgrade: 'tippstats_v1_m0017_upgrade', fresh: 'tippstats_v1_m0017_fresh' };
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${n}`, import.meta.url)), 'utf8');
const M14 = '0014_model_tip_archive.sql';
const M15 = '0015_model_learning.sql';
const M16 = '0016_tip_archive_provenance.sql';
const M17 = '0017_model_learning_events_shadow_kind.sql';

/** A 0015 korábbi (production-ben futtatott) változata: ugyanaz, 'shadow_evaluation' nélkül. */
const OLD_0015 = () => {
  const src = mig(M15);
  const old = src.replace(", 'shadow_evaluation'))", '))');
  if (old === src || old.includes('shadow_evaluation')) throw new Error('a régi 0015 nem állítható elő a jelenlegiből');
  return old;
};

function psql(db: string, sql: string, opts: { role?: string; tx?: boolean } = {}): { ok: boolean; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: HOST, PGDATABASE: db, PGCLIENTENCODING: 'UTF8' };
  for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete env[k];
  try {
    const out = execFileSync(PSQL, ['-h', HOST, '-U', process.env.PGUSER || 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1',
      ...(opts.tx ? ['--single-transaction'] : [])], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env, input: opts.role ? `set role ${opts.role};\n${sql}` : sql,
    });
    return { ok: true, out: out.replace(/\r/g, '').trim(), err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(x.stdout ?? ''), err: String(x.stderr ?? '') };
  }
}
const must = (db: string, sql: string, role?: string) => { const r = psql(db, sql, { role }); if (!r.ok) throw new Error(r.err); return r.out; };
const apply = (db: string, sql: string, name: string) => { const r = psql(db, sql, { tx: true }); if (!r.ok) throw new Error(`${name}: ${r.err}`); };

function freshDb(db: string) {
  if (!/^tippstats_v1_m0017_[a-z]+$/.test(db)) throw new Error(`nem eldobható adatbázisnév: ${db}`);
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

/**
 * A teljes releváns katalógus determinisztikus szöveges pillanatképe (a
 * `public` séma minden táblája/nézete/függvénye). A megszorítások OID-ja is
 * benne van: így a „nem dobta el és hozta létre újra” is ellenőrizhető.
 */
const SNAPSHOT_SQL = `
  select 'constraint|' || conrelid::regclass::text || '|' || conname || '|' || contype::text || '|' || oid::text || '|' || convalidated::text || '|' || pg_get_constraintdef(oid)
    from pg_constraint where connamespace = 'public'::regnamespace
  union all
  select 'column|' || table_name::text || '|' || column_name::text || '|' || data_type::text || '|' || is_nullable::text || '|' || coalesce(column_default::text, '')
    from information_schema.columns where table_schema = 'public'
  union all
  select 'grant|' || grantee::text || '|' || table_name::text || '|' || privilege_type::text
    from information_schema.role_table_grants where table_schema = 'public'
  union all
  select 'trigger|' || tgrelid::regclass::text || '|' || tgname || '|' || tgenabled::text || '|' || tgfoid::regproc::text
    from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'auth.%'
  union all
  select 'view|' || c.relname || '|' || coalesce(array_to_string(c.reloptions, ','), '') || '|' || md5(pg_get_viewdef(c.oid))
    from pg_class c where c.relkind = 'v' and c.relnamespace = 'public'::regnamespace
  union all
  select 'function|' || p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(array_to_string(p.proacl, ','), '')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'rls|' || relname || '|' || relrowsecurity::text from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace
  order by 1;`;
const snapshot = (db: string) => must(db, SNAPSHOT_SQL).split('\n');
const kindLine = (lines: string[]) => lines.find((l) => l.startsWith('constraint|model_learning_events|model_learning_events_kind|'))!;
const withoutKind = (lines: string[]) => lines.filter((l) => !l.startsWith('constraint|model_learning_events|model_learning_events_kind|'));

const OLD_KINDS = ['evaluation', 'insufficient_data', 'candidate_rejected', 'candidate_eligible', 'promotion', 'promotion_refused', 'rollback', 'failure', 'fallback'];
const eventsDump = (db: string) => must(db, `select coalesce(string_agg(id::text || ':' || kind || ':' || coalesce(model_id, '') || ':' || details::text, ';' order by id), '') from model_learning_events`);
const insertKind = (db: string, kind: string) => psql(db, `insert into model_learning_events (kind, actor, details) values ('${kind}', 'teszt', '{}')`, { role: 'service_role' });

describe.skipIf(!ENABLED)('0017 – esemény-típus migráció (helyi, eldobható PostgreSQL 17)', () => {
  beforeAll(() => {
    const addr = must('postgres', `select inet_server_addr()::text`);
    if (!addr.startsWith('127.0.0.1') && !addr.startsWith('::1')) throw new Error(`nem helyi szerver: ${addr}`);
  });

  it('a migráció tartalma: feltételes (no-op, ha már engedi), és a típuslista pontosan a 0015 jelenlegi listája', () => {
    const list = (sql: string) => [...(sql.match(/kind in \(([\s\S]*?)\)\)/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(list(mig(M17))).toEqual(list(mig(M15)));
    expect(list(mig(M17))).toEqual([...OLD_KINDS, 'shadow_evaluation']);
    expect(mig(M17)).toMatch(/if not exists \([\s\S]*pg_get_constraintdef\(oid\) like '%''shadow_evaluation''%'/);
    const code = mig(M17).split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
    // csak az esemény-tábla megszorításához nyúl
    expect([...code.matchAll(/alter table ([a-z_.]+)/g)].map((m) => m[1])).toEqual(['public.model_learning_events', 'public.model_learning_events']);
    expect(code).not.toMatch(/\b(delete|update|truncate|grant|revoke|create (or replace )?(view|function|trigger|table))\b/i);
  });

  it('FRISSÍTÉS (production útja): régi 0015 + meglévő események → 0017 ×2: események megmaradnak, shadow_evaluation elfogadva, ismeretlen elutasítva, más nem változik', () => {
    const db = DB.upgrade;
    freshDb(db);
    apply(db, mig(M14), M14);
    apply(db, OLD_0015(), 'régi 0015');
    // meglévő audit-események a régi típusokkal (a production-ben jelenleg 0 van – a teszt szigorúbb)
    for (const k of OLD_KINDS) expect(insertKind(db, k).ok, k).toBe(true);
    apply(db, mig(M16), M16);
    expect(insertKind(db, 'shadow_evaluation').ok).toBe(false); // a hiba reprodukálva
    const before = snapshot(db);
    const eventsBefore = eventsDump(db);
    expect(kindLine(before)).not.toMatch(/shadow_evaluation/);

    apply(db, mig(M17), `${M17} #1`);
    const afterFirst = snapshot(db);
    apply(db, mig(M17), `${M17} #2`);
    const afterSecond = snapshot(db);

    // csak az esemény-típus megszorítás változott; minden más bitre azonos
    expect(withoutKind(afterFirst)).toEqual(withoutKind(before));
    expect(kindLine(afterFirst)).toMatch(/\|c\|\d+\|true\|CHECK .*'shadow_evaluation'::text/);
    for (const k of OLD_KINDS) expect(kindLine(afterFirst)).toContain(`'${k}'::text`);
    // a második futás valódi no-op (még a megszorítás OID-ja is azonos)
    expect(afterSecond).toEqual(afterFirst);
    // a meglévő események érintetlenek
    expect(eventsDump(db)).toBe(eventsBefore);
    expect(must(db, 'select count(*) from model_learning_events')).toBe(String(OLD_KINDS.length));
    // új típus elfogadva (service_role), ismeretlen elutasítva
    expect(insertKind(db, 'shadow_evaluation').ok).toBe(true);
    const bad = insertKind(db, 'nem_letezo_tipus');
    expect(bad.ok).toBe(false);
    expect(bad.err).toMatch(/model_learning_events_kind/);
  });

  it('FRISS TELEPÍTÉS: 0014 → 0015 → 0016 → 0017 ×2 – a 0017 teljes no-op (katalógus bitre azonos, megszorítás-OID változatlan)', () => {
    const db = DB.fresh;
    freshDb(db);
    for (const n of [M14, M15, M16]) apply(db, mig(n), n);
    insertKind(db, 'evaluation');
    const before = snapshot(db);
    const eventsBefore = eventsDump(db);
    apply(db, mig(M17), `${M17} #1`);
    apply(db, mig(M17), `${M17} #2`);
    expect(snapshot(db)).toEqual(before);
    expect(eventsDump(db)).toBe(eventsBefore);
    expect(insertKind(db, 'shadow_evaluation').ok).toBe(true);
    expect(insertKind(db, 'nem_letezo_tipus').ok).toBe(false);
  });

  it('a 0017 egy tranzakcióban fut: ha utána hiba lép fel, a megszorítás változatlan marad (nincs részleges állapot)', () => {
    const db = DB.upgrade;
    freshDb(db);
    apply(db, mig(M14), M14);
    apply(db, OLD_0015(), 'régi 0015');
    apply(db, mig(M16), M16);
    const before = snapshot(db);
    const r = psql(db, `${mig(M17)}\nselect 1/0;`, { tx: true });
    expect(r.ok).toBe(false);
    expect(snapshot(db)).toEqual(before);
    expect(insertKind(db, 'shadow_evaluation').ok).toBe(false);
  });
});
