/**
 * 0023 – valódi PostgreSQL-ellenőrzés (jogosultságok, egyediség, CHECK, cascade, Feed-függvények)
 * egy KÜLÖN, LOKÁLIS adatbázison.
 *
 * ALAPÉRTELMEZÉSBEN KIHAGYVA. Csak akkor fut, ha kifejezetten kérik:
 *   TIPARCHIVE_PG_TEST=1 PGPASSWORD=… [PSQL=/út/a/psql] npx vitest run tests/communityFeed.pg.test.ts
 *
 * BIZTONSÁG:
 *  - a gép KÓDBA ÉGETVE 127.0.0.1 (a PGHOST-ot és minden .env-et figyelmen kívül hagy),
 *  - az adatbázis neve rögzített (`tippstats_0023_vitest`), a teszt eldobja és újra létrehozza;
 *    más adatbázishoz nem nyúl,
 *  - a Supabase-szerepeket (anon, authenticated, service_role) és a Supabase-szerű alapértelmezett
 *    jogosztást (ALL) helyben szimulálja; a 0013-at (user_follows) is lefuttatja, mert a Feed olvassa.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENABLED = process.env.TIPARCHIVE_PG_TEST === '1';
const HOST = '127.0.0.1';
const DB = 'tippstats_0023_vitest';
const PSQL = process.env.PSQL || 'psql';
const M0013 = fileURLToPath(new URL('../supabase/migrations/0013_social_follows.sql', import.meta.url));
const M0023 = fileURLToPath(new URL('../supabase/migrations/0023_community_feed.sql', import.meta.url));

interface Result { ok: boolean; out: string; err: string }

function psql(db: string, args: string[], input?: string): Result {
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
const must = (q: string) => { const r = sql(q); if (!r.ok) throw new Error(r.err); return r.out; };

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const U3 = '00000000-0000-4000-8000-000000000003';
const P = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!ENABLED)('0023 PostgreSQL – Közösségi Feed (lokális, izolált DB)', () => {
  beforeAll(() => {
    const admin = (q: string) => { const r = psql('postgres', ['-c', q]); if (!r.ok) throw new Error(r.err); };
    admin(`drop database if exists ${DB}`);
    admin(`create database ${DB}`);
    must(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      insert into auth.users values ('${U1}'), ('${U2}'), ('${U3}');`);
    const f = psql(DB, ['-f', M0013]);
    if (!f.ok) throw new Error(f.err);
  });

  it('a migráció kétszer egymás után hibátlanul lefut', () => {
    for (let i = 0; i < 2; i++) {
      const r = psql(DB, ['-f', M0023]);
      expect(r.ok, r.err).toBe(true);
    }
  });

  it('a kliens kulcsok (anon, authenticated) semmit nem olvashatnak, írhatnak és nem hívhatnak', () => {
    must(`insert into public.community_posts (id, author_user_id, body) values ('${P(1)}', '${U1}', 'Szia')`);
    for (const role of ['anon', 'authenticated']) {
      for (const q of [
        'select count(*) from public.community_posts',
        'select count(*) from public.community_post_likes',
        `insert into public.community_posts (author_user_id, body) values ('${U2}', 'Hamis')`,
        `insert into public.community_post_likes (post_id, user_id) values ('${P(1)}', '${U2}')`,
        `delete from public.community_posts where id = '${P(1)}'`,
        `select * from public.community_feed(null, false, null, null, 20)`,
        `select * from public.community_post_stats(array['${P(1)}']::uuid[], null)`,
      ]) {
        const r = sql(q, role);
        expect(r.ok, `${role}: ${q}`).toBe(false);
        expect(r.err, `${role}: ${q}`).toMatch(/permission denied/);
      }
    }
    expect(must('select count(*) from public.community_posts')).toBe('1');
  });

  it('service_role: ír, olvas és hívja a Feed-függvényeket', () => {
    expect(sql(`insert into public.community_posts (id, author_user_id, body) values ('${P(2)}', '${U2}', 'Második')`, 'service_role').ok).toBe(true);
    expect(sql(`select count(*) from public.community_feed(null, false, null, null, 20)`, 'service_role').out).toBe('2');
  });

  it('a szöveg-CHECK: üres, csak szóköz, szélén szóköz vagy 500 karakternél hosszabb szöveg elutasítva', () => {
    for (const body of ["''", "'   '", "' a'", "'a '", `repeat('x', 501)`]) {
      const r = sql(`insert into public.community_posts (author_user_id, body) values ('${U1}', ${body})`);
      expect(r.ok, body).toBe(false);
      expect(r.err).toMatch(/community_posts_body_len/);
    }
    expect(sql(`insert into public.community_posts (author_user_id, body) values ('${U3}', repeat('é', 500))`).ok).toBe(true);
  });

  it('nem létező szerző nem írhat (idegen kulcs)', () => {
    const r = sql(`insert into public.community_posts (author_user_id, body) values ('00000000-0000-4000-8000-0000000000ff', 'x')`);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/foreign key/);
  });

  it('egy felhasználó egy bejegyzést csak egyszer lájkolhat; nem létező bejegyzés nem lájkolható', () => {
    must(`insert into public.community_post_likes (post_id, user_id) values ('${P(1)}', '${U2}')`);
    const dup = sql(`insert into public.community_post_likes (post_id, user_id) values ('${P(1)}', '${U2}')`);
    expect(dup.ok).toBe(false);
    expect(dup.err).toMatch(/community_post_likes_pkey/);
    expect(sql(`insert into public.community_post_likes (post_id, user_id) values ('${P(99)}', '${U2}')`).err).toMatch(/foreign key/);
    must(`insert into public.community_post_likes (post_id, user_id) values ('${P(1)}', '${U3}')`);
    expect(must(`select like_count || ':' || liked_by_viewer from public.community_post_stats(array['${P(1)}', '${P(2)}']::uuid[], '${U2}')`)).toBe('2:true');
    expect(must(`select like_count || ':' || liked_by_viewer from public.community_post_stats(array['${P(1)}']::uuid[], '${U1}')`)).toBe('2:false');
  });

  it('a szerzőre szűrt törlés csak a saját bejegyzést törli; a lájkok kaszkádolva törlődnek', () => {
    expect(must(`with d as (delete from public.community_posts where id = '${P(1)}' and author_user_id = '${U2}' returning 1) select count(*) from d`)).toBe('0');
    expect(must(`with d as (delete from public.community_posts where id = '${P(1)}' and author_user_id = '${U1}' returning 1) select count(*) from d`)).toBe('1');
    expect(must(`select count(*) from public.community_post_likes where post_id = '${P(1)}'`)).toBe('0');
  });

  it('Feed: legújabb elöl, kulcsalapú lapozás duplikáció és kimaradás nélkül (azonos időbélyegnél is)', () => {
    must('delete from public.community_posts');
    must(`insert into public.community_posts (id, author_user_id, body, created_at)
          select ('20000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, '${U1}', 'p' || g,
                 timestamptz '2026-10-25 10:00:00+00' + ((g / 3) * interval '1 minute')
          from generate_series(1, 25) g`);
    const seen: string[] = [];
    let at = 'null', id = 'null';
    for (let i = 0; i < 10; i++) {
      const rows = must(`select id || '|' || created_at || '|' || body from public.community_feed(null, false, ${at}, ${id}, 7)`)
        .split(/\r?\n/).filter(Boolean).map((l) => l.split('|'));
      if (!rows.length) break;
      seen.push(...rows.map((r) => r[2]));
      const last = rows[rows.length - 1];
      at = `'${last[1]}'`; id = `'${last[0]}'`;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    // p24 és p25 időbélyege azonos (g / 3 = 8) → az azonosító dönt, csökkenő sorrendben
    expect(seen.slice(0, 3)).toEqual(['p25', 'p24', 'p23']);
    expect(seen[24]).toBe('p1');
  });

  it('Feed „Követettek”: csak a néző által követett szerzők; a limit kötött', () => {
    must('delete from public.community_posts');
    must(`insert into public.community_posts (author_user_id, body) values ('${U1}', 'u1'), ('${U2}', 'u2'), ('${U3}', 'u3')`);
    must(`insert into public.user_follows (follower_user_id, followed_user_id) values ('${U1}', '${U2}')`);
    expect(must(`select string_agg(body, ',') from public.community_feed('${U1}', true, null, null, 20)`)).toBe('u2');
    expect(must(`select count(*) from public.community_feed('${U3}', true, null, null, 20)`)).toBe('0');
    expect(must(`select count(*) from public.community_feed(null, false, null, null, 2)`)).toBe('2');
    must(`insert into public.community_posts (author_user_id, body) select '${U1}', 'tömeg' || g from generate_series(1, 80) g`);
    expect(must(`select count(*) from public.community_feed(null, false, null, null, 100000)`)).toBe('51');
  });

  it('a fiók törlése kaszkádolva törli a bejegyzéseit és a lájkjait', () => {
    must('delete from public.community_posts');
    must(`insert into public.community_posts (id, author_user_id, body) values ('${P(5)}', '${U3}', 'törlődik'), ('${P(6)}', '${U1}', 'marad')`);
    must(`insert into public.community_post_likes (post_id, user_id) values ('${P(6)}', '${U3}')`);
    must(`delete from auth.users where id = '${U3}'`);
    expect(must('select string_agg(body, \',\') from public.community_posts')).toBe('marad');
    expect(must('select count(*) from public.community_post_likes')).toBe('0');
  });
});
