/**
 * 0019 – `submit_competition_predictions_batch()` a VALÓDI PostgreSQL 17-en
 * (helyi, ELDOBHATÓ adatbázis): atomicitás, napi keret, tételes elutasítás,
 * párhuzamos kérések (advisory lock), jogosultságok.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA; csak `TIPARCHIVE_PG_TEST=1` mellett fut, és
 * pozitívan ellenőrzi, hogy a szerver 127.0.0.1 – különben nem ír semmit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1' as const;
const PSQL = process.env.PSQL || 'psql';
const DB = 'tippstats_v1_comp_batch';
const mig = (n: string) => readFileSync(fileURLToPath(new URL(`../supabase/migrations/${n}`, import.meta.url)), 'utf8');

function env(db: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, PGHOST: HOST, PGDATABASE: db, PGCLIENTENCODING: 'UTF8' };
  for (const k of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete e[k];
  return e;
}
const args = (db: string, extra: string[] = []) => ['-h', HOST, '-U', process.env.PGUSER || 'postgres', '-d', db, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', ...extra];

function psql(db: string, sql: string, extra: string[] = []): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync(PSQL, args(db, extra), { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'], env: env(db) });
    return { ok: true, out: out.replace(/\r/g, '').trim(), err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(x.stdout ?? ''), err: String(x.stderr ?? '') };
  }
}
const must = (sql: string, db = DB) => { const r = psql(db, sql); if (!r.ok) throw new Error(r.err); return r.out; };
/** Aszinkron hívás – a párhuzamos kérések szimulálásához. */
const psqlAsync = (sql: string) => new Promise<string>((resolve, reject) => {
  const p = execFile(PSQL, args(DB, ['-c', sql]), { encoding: 'utf8', env: env(DB) }, (err, out) => (err ? reject(err) : resolve(out.replace(/\r/g, '').trim())));
  p.stdin?.end();
});

const USER = '11111111-1111-1111-1111-111111111111';
const COMP = 'c0000000-0000-0000-0000-000000000001';
const OTHER = 'c0000000-0000-0000-0000-000000000002';
const M = (n: number) => `a0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const DAY = `now() - interval '1 hour', now() + interval '23 hours'`;
const item = (n: number, h: number, a: number) => ({ competitionMatchId: M(n), home: h, away: a });
/** service_role-ként hívja a függvényt; a jsonb választ adja vissza. */
const callSql = (items: unknown, limit: number | null = null, comp = COMP) =>
  `set role service_role; select public.submit_competition_predictions_batch('${USER}', '${comp}', '${JSON.stringify(items)}'::jsonb, ${limit ?? 'null'}, ${DAY});`;
const submit = (items: unknown, limit: number | null = null, comp = COMP) => JSON.parse(must(callSql(items, limit, comp)));
const count = () => Number(must(`select count(*) from public.user_predictions where user_id = '${USER}'`));
const reset = () => must(`delete from public.user_predictions`);

describe.skipIf(!ENABLED)('0019 tömeges tippbeküldés – valódi PostgreSQL 17 (helyi, eldobható DB)', () => {
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
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      grant usage on schema public, auth to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
    for (const n of ['0004_prediction_league.sql', '0008_free_daily_quota.sql', '0019_competition_prediction_batch.sql', '0019_competition_prediction_batch.sql']) {
      const r = psql(DB, mig(n), ['--single-transaction']);
      if (!r.ok) throw new Error(`${n}: ${r.err}`);
    }
    // a szerver (service_role) a 0004 szerint teljes táblajogot kap – itt a default privileges adja
    must(`
      insert into auth.users values ('${USER}');
      insert into public.competition_rounds (id, name, league_key, league_name, provider, starts_at, ends_at, status) values
        ('${COMP}', 'PL', 'eng-pl', 'Premier League', 'teszt', now() - interval '1 day', now() + interval '2 days', 'active'),
        ('${OTHER}', 'LL', 'esp-ll', 'La Liga', 'teszt', now() - interval '1 day', now() + interval '2 days', 'active');
      insert into public.competition_matches (id, competition_id, external_match_id, home_team, away_team, kickoff, status) values
        ('${M(1)}', '${COMP}', 'e1', 'A', 'B', now() + interval '3 hours', 'scheduled'),
        ('${M(2)}', '${COMP}', 'e2', 'C', 'D', now() + interval '4 hours', 'scheduled'),
        ('${M(3)}', '${COMP}', 'e3', 'E', 'F', now() + interval '5 hours', 'scheduled'),
        ('${M(4)}', '${COMP}', 'e4', 'G', 'H', now() + interval '6 hours', 'scheduled'),
        ('${M(5)}', '${COMP}', 'e5', 'I', 'J', now() - interval '10 minutes', 'scheduled'),
        ('${M(6)}', '${OTHER}', 'x1', 'K', 'L', now() + interval '3 hours', 'scheduled');`);
  });

  it('több tipp egy tranzakcióban; ismétléskor unchanged; módosításnál submitted_at és points marad', () => {
    reset();
    const a = submit([item(1, 2, 1), item(2, 0, 0)], 3);
    expect(a.outcome).toBe('saved');
    expect(a.used).toBe(2);
    expect(a.results.map((r: any) => r.outcome)).toEqual(['created', 'created']);
    const sub = must(`select submitted_at from public.user_predictions where competition_match_id = '${M(1)}'`);
    must(`update public.user_predictions set points = 5 where competition_match_id = '${M(1)}'`);
    const b = submit([item(1, 3, 1), item(2, 0, 0)], 3);
    expect(b.results.map((r: any) => r.outcome)).toEqual(['updated', 'unchanged']);
    expect(b.used).toBe(2); // a módosítás és az ismétlés nem fogyaszt
    expect(must(`select submitted_at || '|' || points || '|' || predicted_home_score from public.user_predictions where competition_match_id = '${M(1)}'`)).toBe(`${sub}|5|3`);
    expect(count()).toBe(2);
  });

  it('napi keret: a csomag új tippjei együtt nem léphetik túl – ilyenkor SEMMI nem íródik (a módosítás sem)', () => {
    reset();
    submit([item(1, 1, 0)], 3);
    const over = submit([item(1, 9, 9), item(2, 1, 1), item(3, 1, 1), item(4, 1, 1)], 3);
    expect(over).toEqual({ outcome: 'limit_reached', used: 1, newCount: 3 });
    expect(count()).toBe(1);
    expect(must(`select predicted_home_score from public.user_predictions where competition_match_id = '${M(1)}'`)).toBe('1');
    expect(submit([item(2, 1, 1), item(3, 1, 1)], 3).outcome).toBe('saved');
    expect(submit([item(4, 1, 1)], null).outcome).toBe('saved'); // PRO: nincs limit
  });

  it('tételes elutasítás: másik verseny meccse és már elkezdődött meccs → rejected, semmi nem íródik', () => {
    reset();
    const r = submit([item(1, 1, 0), item(6, 1, 0), item(5, 2, 2)], null);
    expect(r.outcome).toBe('rejected');
    expect(r.errors.map((e: any) => [e.competitionMatchId, e.code])).toEqual([[M(6), 'MATCH_NOT_FOUND'], [M(5), 'PREDICTION_CLOSED']]);
    expect(count()).toBe(0);
    must(`update public.competition_rounds set status = 'finished' where id = '${OTHER}'`);
    expect(submit([item(6, 1, 0)], null, OTHER).errors[0].code).toBe('COMPETITION_CLOSED');
    expect(submit([item(1, 1, 0)], null, '00000000-0000-0000-0000-00000000dead').errors[0].code).toBe('COMPETITION_NOT_FOUND');
  });

  it('formai hiba (duplikált meccs, rossz gólszám, üres csomag) → kivétel, a tranzakció visszagörgetődik', () => {
    reset();
    for (const bad of [[item(1, 1, 0), item(1, 2, 0)], [item(1, 100, 0)], [item(1, 1.5, 0)], [{ competitionMatchId: M(1), home: '1', away: 0 }], []]) {
      const r = psql(DB, callSql(bad, null));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.err).toMatch(/csomag|tipp|egy tipp/i);
    }
    expect(count()).toBe(0);
  });

  it('írás közbeni hiba → a már beírt tételek is visszagörgetődnek', () => {
    reset();
    submit([item(1, 1, 0)], null);
    must(`create function public.fail_77() returns trigger language plpgsql as $$ begin raise exception 'szimulált írási hiba'; end $$;
      create trigger fail_77 before insert on public.user_predictions for each row when (new.predicted_home_score = 77) execute function public.fail_77();`);
    const r = psql(DB, callSql([item(1, 4, 4), item(2, 3, 0), item(3, 77, 0)], null));
    must(`drop trigger fail_77 on public.user_predictions; drop function public.fail_77();`);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/szimulált írási hiba/);
    expect(count()).toBe(1);
    expect(must(`select predicted_home_score from public.user_predictions where competition_match_id = '${M(1)}'`)).toBe('1');
  });

  it('párhuzamos kérések (dupla kattintás, két lap): a zár miatt a napi keret nem léphető át, duplikáció nincs', async () => {
    reset();
    const a = [item(1, 1, 0), item(2, 1, 0)];
    const b = [item(3, 1, 0), item(4, 1, 0)];
    const outs = (await Promise.all([psqlAsync(callSql(a, 3)), psqlAsync(callSql(b, 3)), psqlAsync(callSql(a, 3))]))
      .map((o) => JSON.parse(o.split('\n').pop()!).outcome);
    // A zár sorosít: az elsőként futó 2-es csomag mentődik, a másik 2-es nem fér el (2 + 2 > 3).
    // Sorrendtől függően az „a” ismétlése vagy unchanged (saved), vagy szintén limit_reached.
    expect(outs).toContain('saved');
    expect(outs).toContain('limit_reached');
    expect(count()).toBe(2);
    expect(Number(must(`select count(*) from (select competition_match_id from public.user_predictions group by 1 having count(*) > 1) d`))).toBe(0);
  });

  it('jogosultság: csak a service_role hívhatja; a 0008 függvény változatlanul működik', () => {
    for (const role of ['anon', 'authenticated']) {
      expect(psql(DB, `set role ${role}; select public.submit_competition_predictions_batch('${USER}', '${COMP}', '[]'::jsonb, null, ${DAY});`).err).toMatch(/permission denied/);
    }
    expect(must(`select string_agg(grantee, ',' order by grantee) from information_schema.routine_privileges
      where routine_name = 'submit_competition_predictions_batch' and privilege_type = 'EXECUTE' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')`)).toBe('service_role');
    reset();
    const single = JSON.parse(must(`set role service_role; select public.submit_competition_prediction('${USER}', '${M(1)}', 2, 1, 3, ${DAY});`));
    expect(single.outcome).toBe('created');
  });
});
