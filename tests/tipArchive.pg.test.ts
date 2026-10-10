/**
 * 0014 – valódi PostgreSQL-ellenőrzés (DELETE / TRUNCATE / jogosultságok /
 * láthatóság) egy KÜLÖN, LOKÁLIS adatbázison.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA. Csak akkor fut, ha kifejezetten kérik:
 *   TIPARCHIVE_PG_TEST=1 PGPASSWORD=… [PSQL=/út/a/psql] [PGPORT=5432] npx vitest run tests/tipArchive.pg.test.ts
 *
 * BIZTONSÁG:
 *  - a gép KÓDBA ÉGETVE 127.0.0.1 (a PGHOST-ot és minden .env-et figyelmen
 *    kívül hagy – a tesztcsomag dotenv-et sem tölt be),
 *  - az adatbázis neve rögzített (`tippstats_0014_vitest`), a teszt eldobja és
 *    újra létrehozza; más adatbázishoz nem nyúl,
 *  - a Supabase-szerepeket (anon, authenticated, service_role) és a
 *    Supabase-szerű alapértelmezett jogosztást (ALL) helyben szimulálja.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1';
const DB = 'tippstats_0014_vitest';
const PSQL = process.env.PSQL || 'psql';
const MIGRATION = fileURLToPath(new URL('../supabase/migrations/0014_model_tip_archive.sql', import.meta.url));

interface Result { ok: boolean; out: string; err: string }

/**
 * A SQL-t a szabványos bemeneten adjuk át (nem `-c` argumentumként): Windowson
 * a parancssori argumentum a rendszer kódlapján megy át, és az ékezetes
 * értékek (pl. „mérsékelt”) elromlanának.
 */
function psql(db: string, args: string[], input?: string): Result {
  // A kapcsolatot átirányítani képes libpq-változók törölve: a PGHOSTADDR (vagy egy
  // PGSERVICE-ből jövő hostaddr) felülírná a `-h 127.0.0.1`-et.
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: HOST, PGDATABASE: db, PGCLIENTENCODING: 'UTF8' };
  for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete env[k];
  try {
    const out = execFileSync(PSQL, ['-h', HOST, '-U', process.env.PGUSER || 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8', input: input ?? '', stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(x.stdout ?? '').trim(), err: String(x.stderr ?? '') };
  }
}

const sql = (q: string, role?: string) => psql(DB, [], role ? `set role ${role};\n${q}` : q);

const H64 = 'a'.repeat(64);
const insertRow = (matchId: string, kickoff: string, generatedAt: string) => `
  insert into public.model_tip_archive (match_id, market, version_no, content_hash, engine_version, generated_at, origin,
    match_label, league_id, league_name, kickoff, market_label, market_type, category, model_prob, data_quality,
    sample_size, supporting_indicators, pre_kickoff)
  values ('${matchId}', 'O2.5', 1, '${H64}', 'v', '${generatedAt}', 'live', 'A – B', 'L1', 'Liga', '${kickoff}',
    'x', 'gólszám', 'mérsékelt', 0.61, 'magas', 1, 1, '${generatedAt}'::timestamptz < '${kickoff}'::timestamptz);`;

describe.skipIf(!ENABLED)('0014 PostgreSQL – megőrzés és jogosultságok (lokális, izolált DB)', () => {
  beforeAll(() => {
    const admin = (q: string) => {
      const r = psql('postgres', ['-c', q]); // csak ASCII (drop/create database)
      if (!r.ok) throw new Error(r.err);
    };
    admin(`drop database if exists ${DB}`);
    admin(`create database ${DB}`);
    const setup = sql(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema auth;
      create table auth.users (id uuid primary key);
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
    if (!setup.ok) throw new Error(setup.err);
  });

  it('a migráció kétszer egymás után hibátlanul lefut', () => {
    for (let i = 0; i < 2; i++) {
      const r = psql(DB, ['-f', MIGRATION]);
      expect(r.ok, r.err).toBe(true);
    }
  });

  it('service_role: csak SELECT/INSERT/UPDATE marad (a Supabase-szerű ALL alapjog szűkítve)', () => {
    for (const t of ['model_tip_archive', 'model_tip_archive_match_state']) {
      const r = sql(`select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
                     where table_schema = 'public' and table_name = '${t}' and grantee = 'service_role'`);
      expect(r.out, t).toBe('INSERT,SELECT,UPDATE');
    }
  });

  it('service_role NEM tud törölni és NEM tud TRUNCATE-olni (egyik táblán sem)', () => {
    expect(sql(insertRow('m1', '2026-10-01T13:00Z', '2026-10-01T11:00Z')).ok).toBe(true);
    expect(sql(`select public.model_tip_archive_observe('m1', '2026-10-01T13:00Z', 'live', '2026-10-01T13:05Z')`).ok).toBe(true);
    for (const q of ['delete from public.model_tip_archive', 'truncate public.model_tip_archive',
      'delete from public.model_tip_archive_match_state', 'truncate public.model_tip_archive_match_state']) {
      const r = sql(q, 'service_role');
      expect(r.ok, q).toBe(false);
      expect(r.err, q).toMatch(/permission denied/);
    }
    expect(sql('select count(*) from public.model_tip_archive').out).toBe('1');
  });

  it('a tulajdonos sem tud törölni / TRUNCATE-olni: a DELETE- és a KÜLÖN TRUNCATE-trigger is megállítja (CASCADE-del is)', () => {
    for (const q of ['delete from public.model_tip_archive', 'truncate public.model_tip_archive',
      'truncate public.model_tip_archive cascade', 'delete from public.model_tip_archive_match_state',
      'truncate public.model_tip_archive_match_state']) {
      const r = sql(q);
      expect(r.ok, q).toBe(false);
      expect(r.err, q).toMatch(/nem törölhetők \((DELETE|TRUNCATE)\)/);
    }
    expect(sql('select count(*) from public.model_tip_archive').out).toBe('1');
    expect(sql('select count(*) from public.model_tip_archive_match_state').out).toBe('1');
  });

  it('service_role nem kapcsolhatja ki a védő triggert (tulajdonjog kell)', () => {
    const r = sql('alter table public.model_tip_archive disable trigger model_tip_archive_no_delete', 'service_role');
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/must be owner/);
  });

  it('a dokumentált adminisztratív helyreállítás csak tulajdonosként, tranzakcióban működik', () => {
    const r = sql(`begin;
      alter table public.model_tip_archive disable trigger model_tip_archive_no_delete;
      delete from public.model_tip_archive;
      rollback;`);
    expect(r.ok, r.err).toBe(true);
    expect(sql('select count(*) from public.model_tip_archive').out).toBe('1');
  });

  it('service_role: a tipp-mezők nem írhatók át, az elszámolás egyszer írható', () => {
    const upd = sql('update public.model_tip_archive set model_prob = 0.9', 'service_role');
    expect(upd.ok).toBe(false);
    expect(upd.err).toMatch(/nem módosítható/);
    expect(sql(`update public.model_tip_archive set settlement_status = 'won', home_goals = 1, away_goals = 0,
      settled_at = now(), result_kickoff = '2026-10-01T13:00Z' where settlement_status = 'pending'`, 'service_role').ok).toBe(true);
    const again = sql(`update public.model_tip_archive set settlement_status = 'lost'`, 'service_role');
    expect(again.ok).toBe(false);
    expect(again.err).toMatch(/nem írható át/);
  });

  it('láthatóság: a régi kezdés elmúlt, de az AKTUÁLIS kezdés jövőbeli → a listázó nézet szűrésén nem jut át', () => {
    expect(sql(insertRow('pp', '2026-10-01T13:00Z', '2026-10-01T11:00Z')).ok).toBe(true);
    expect(sql(`select public.model_tip_archive_observe('pp', '2026-10-03T12:00Z', 'scheduled', '2026-10-01T14:00Z')`, 'service_role').ok).toBe(true);
    // régebbi megfigyelés nem írhatja vissza „live”-ra
    expect(sql(`select public.model_tip_archive_observe('pp', '2026-10-01T13:00Z', 'live', '2026-10-01T13:30Z')`, 'service_role').ok).toBe(true);
    const visible = (view: string) => sql(`select count(*) from public.${view} where match_id = 'pp'
      and match_status in ('live', 'finished') and current_kickoff < '2026-10-01T14:00Z'`, 'service_role').out;
    expect(visible('model_tip_archive_listing')).toBe('0');
    expect(visible('model_tip_archive_counted_listing')).toBe('0');
    // állapot nélküli meccs: az inner join miatt egyáltalán nincs a listázó nézetben
    expect(sql(insertRow('nostate', '2026-09-01T13:00Z', '2026-09-01T11:00Z')).ok).toBe(true);
    expect(sql(`select count(*) from public.model_tip_archive_listing where match_id = 'nostate'`, 'service_role').out).toBe('0');
  });

  it('a kliens szerepek semmit nem olvashatnak és nem hívhatnak', () => {
    for (const role of ['anon', 'authenticated']) {
      for (const q of ['select count(*) from public.model_tip_archive', 'select count(*) from public.model_tip_archive_match_state',
        'select count(*) from public.model_tip_archive_listing', 'select count(*) from public.model_tip_archive_counted_listing',
        `select public.model_tip_archive_observe('x', now(), 'live', now())`]) {
        const r = sql(q, role);
        expect(r.ok, `${role}: ${q}`).toBe(false);
        expect(r.err).toMatch(/permission denied/);
      }
    }
  });

  it('PG 15+ esetén a nézetek security_invoker opcióval jönnek létre', () => {
    const v = Number(sql('show server_version_num').out);
    const r = sql(`select string_agg(relname || '=' || coalesce(array_to_string(reloptions, ','), 'none'), ';' order by relname)
                   from pg_class where relkind = 'v' and relname like 'model_tip_archive%'`);
    if (v >= 150000) expect(r.out.split(';').every((x) => x.endsWith('security_invoker=true'))).toBe(true);
    else expect(r.out).not.toContain('security_invoker');
  });
});
