/**
 * Közösségi Feed (MVP) – bejegyzés, listázás, nézetek, lájk, törlés, jogosultságok, üres állapot.
 *
 * Valódi Express alkalmazás a VALÓDI `communityRouter` / `socialRouter` útvonalakkal, valódi
 * `CommunityService`, `SocialService` és valódi `Sqlite*Store` tárolókkal (a 0013 és a 0023
 * megfelelője a helyi tárolóban). Az egyetlen szimulált elem a `res.locals.plan` – ugyanaz a minta,
 * mint a meglévő social teszteknél. A megjelenítés az állapotmentes komponensek statikus
 * renderelésével tesztelt (DOM-alapú frontendteszt-infrastruktúra nincs).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteCommunityStore } from '../src/server/community/store';
import { CommunityService } from '../src/server/community/service';
import { communityRouter } from '../src/server/routes/community';
import { SqliteFollowStore } from '../src/server/social/store';
import { SqliteProgressionStore } from '../src/server/progression/store';
import { SqliteCompetitionStore } from '../src/server/competition/store';
import { SocialService } from '../src/server/social/service';
import { socialRouter } from '../src/server/routes/social';
import { InMemoryDisplayNameDirectory } from '../src/server/profile/displayNameDirectory';
import { FEED_PAGE_SIZE, POST_MAX_LENGTH, normalizePostBody, type FeedPost } from '../src/shared/community';
import { FeedEmpty, PostCard } from '../src/client/pages/Community';
import { PLAY } from '../src/client/components/Layout';
import { metaForPath, renderSeoHead } from '../src/shared/seo';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const NONAME = '55555555-5555-5555-5555-555555555555';
const NAME = { [A]: 'Martin23', [B]: 'Marci13', [C]: 'Kolbasz' } as const;
const MISSING = '99999999-9999-4999-8999-999999999999';

interface Harness {
  url: string;
  close: () => Promise<void>;
  db: InstanceType<typeof DatabaseSync>;
}

/**
 * `fastClock`: minden hívásnál 1 perccel előrébb jár → a bejegyzés-várakozás nem akad be a
 * tömeges létrehozásnál. A várakozási idő tesztje a valódi órát használja.
 */
async function startApp(fastClock = true): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const follows = new SqliteFollowStore(db);
  const community = new SqliteCommunityStore(db);
  const names = new InMemoryDisplayNameDirectory();
  for (const [id, n] of Object.entries(NAME)) await names.set(id, n);
  let k = 0;
  const svc = new CommunityService(community, names, async (ids) => new Map(ids.map((id) => [id, { avatar: { skin: 's1' }, borderKey: 'classic', titleKey: 'none' }])),
    fastClock ? () => Date.now() + (++k) * 60_000 : () => Date.now());
  const social = new SocialService(follows, names, new SqliteProgressionStore(db), new SqliteCompetitionStore(db));

  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    const id = req.header('x-test-user') ?? null;
    res.locals.plan = { enforced: true, user: id ? { id, email: 'titok@pelda.hu' } : null, pro: false, admin: false };
    next();
  });
  app.use('/api/community', communityRouter(svc));
  app.use('/api/social', socialRouter(social));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    db,
  };
}

let h: Harness;
beforeEach(async () => { h = await startApp(); });
afterEach(async () => { await h.close(); });

async function call(method: string, path: string, user?: string, body?: unknown) {
  const res = await fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  return { status: res.status, body: json };
}

const post = (user: string | undefined, body: unknown) => call('POST', '/api/community/posts', user, { body });
const feed = (view = 'all', user?: string, before?: string) =>
  call('GET', `/api/community/feed?view=${view}${before ? `&before=${encodeURIComponent(before)}` : ''}`, user);
const like = (user: string | undefined, id: string) => call('POST', `/api/community/posts/${id}/like`, user);
const unlike = (user: string | undefined, id: string) => call('DELETE', `/api/community/posts/${id}/like`, user);
const del = (user: string | undefined, id: string) => call('DELETE', `/api/community/posts/${id}`, user);
const follow = (user: string, name: string) => call('POST', `/api/social/follow/${encodeURIComponent(name)}`, user);
const count = (sql: string) => (h.db.prepare(sql).get() as { n: number }).n;

function deepKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) { for (const x of v) deepKeys(x, out); return out; }
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { out.add(k); deepKeys(val, out); }
  return out;
}
const PRIVATE_KEYS = ['userId', 'user_id', 'authorUserId', 'author_user_id', 'email', 'id_user'];

// ===========================================================================
// 1) Bejegyzés létrehozása
// ===========================================================================

describe('Közösség – bejegyzés létrehozása', () => {
  it('K1. bejelentkezett felhasználó közzétehet; a válasz a nyilvános alak', async () => {
    const r = await post(A, '  Szerintem ma az Arsenal nyer.  ');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ body: 'Szerintem ma az Arsenal nyer.', likeCount: 0, likedByMe: false, mine: true, author: { displayName: 'Martin23' } });
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(r.body.createdAt))).toBe(true);
    expect(r.body.author.avatar).toEqual({ skin: 's1' });
  });

  it('K2. bejelentkezés nélkül 401, és nem jön létre sor', async () => {
    const r = await post(undefined, 'Szia');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
    expect(count('SELECT COUNT(*) AS n FROM community_posts')).toBe(0);
  });

  it('K3. más nevében nem lehet írni: a törzsben küldött azonosító figyelmen kívül marad', async () => {
    const r = await call('POST', '/api/community/posts', A, { body: 'Teszt', userId: B, authorUserId: B, author_user_id: B });
    expect(r.status).toBe(201);
    expect(r.body.author.displayName).toBe('Martin23');
    expect((h.db.prepare('SELECT author_user_id AS a FROM community_posts').get() as { a: string }).a).toBe(A);
  });

  it('K4. üres, csak szóköz, túl hosszú vagy nem szöveges törzs → 422', async () => {
    for (const body of ['', '   ', '\n\n', 'x'.repeat(POST_MAX_LENGTH + 1), 42, null, { a: 1 }, ['x']]) {
      const r = await post(A, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.code).toBe('INVALID_BODY');
    }
    expect((await post(A, 'é'.repeat(POST_MAX_LENGTH))).status).toBe(201);
    expect(count('SELECT COUNT(*) AS n FROM community_posts')).toBe(1);
  });

  it('K5. megjelenítési név nélkül nem lehet írni (a név a nyilvános identitás)', async () => {
    const r = await post(NONAME, 'Szia');
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('DISPLAY_NAME_REQUIRED');
  });

  it('K6. két bejegyzés között várakozási idő van (felhasználónként)', async () => {
    await h.close();
    h = await startApp(false);
    expect((await post(A, 'Első')).status).toBe(201);
    const second = await post(A, 'Második');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('POST_COOLDOWN');
    expect((await post(B, 'Másik felhasználó')).status).toBe(201);
  });

  it('K7. a HTML nem értelmeződik: a szöveg változatlanul, szövegként tárolódik', async () => {
    const r = await post(A, '<script>alert(1)</script> <b>vastag</b>');
    expect(r.body.body).toBe('<script>alert(1)</script> <b>vastag</b>');
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PostCard, { post: r.body, canLike: true })));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ===========================================================================
// 2) Listázás és nézetek
// ===========================================================================

describe('Közösség – listázás és nézetek', () => {
  it('K8. üres Feed: üres lista, nincs következő lap (kijelentkezve is)', async () => {
    const r = await feed('all');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ view: 'all', posts: [], hasMore: false, nextBefore: null });
  });

  it('K9. a „Mindenki” nézet nyilvános, legújabb elöl', async () => {
    await post(A, 'egy');
    await post(B, 'kettő');
    await post(C, 'három');
    const r = await feed('all');
    expect(r.body.posts.map((p: FeedPost) => p.body)).toEqual(['három', 'kettő', 'egy']);
    expect(r.body.posts.every((p: FeedPost) => !p.mine && !p.likedByMe)).toBe(true);
  });

  it('K10. lapozás: kötött lapméret, nincs duplikált vagy kimaradó elem', async () => {
    const total = FEED_PAGE_SIZE * 2 + 5;
    for (let i = 0; i < total; i++) expect((await post([A, B, C][i % 3], `#${i}`)).status).toBe(201);
    const seen: string[] = [];
    let before: string | undefined;
    for (let pageNo = 0; pageNo < 5; pageNo++) {
      const r = await feed('all', undefined, before);
      expect(r.body.posts.length).toBeLessThanOrEqual(FEED_PAGE_SIZE);
      seen.push(...r.body.posts.map((p: FeedPost) => p.body));
      if (!r.body.hasMore) { expect(r.body.nextBefore).toBeNull(); break; }
      before = r.body.nextBefore;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe(`#${total - 1}`);
    expect(seen[total - 1]).toBe('#0');
  });

  it('K11. „Követettek”: csak a követett szerzők bejegyzései (a saját és a nem követett nem)', async () => {
    await post(A, 'A saját');
    await post(B, 'B követett');
    await post(C, 'C nem követett');
    expect((await follow(A, 'Marci13')).status).toBe(200);
    const r = await feed('following', A);
    expect(r.status).toBe(200);
    expect(r.body.posts.map((p: FeedPost) => p.body)).toEqual(['B követett']);
    // ugyanez másik nézőnek üres (B senkit nem követ)
    expect((await feed('following', B)).body.posts).toEqual([]);
  });

  it('K12. „Követettek” bejelentkezés nélkül 401', async () => {
    const r = await feed('following');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('AUTH_REQUIRED');
  });

  it('K13. hibás nézet vagy kurzor → 400', async () => {
    expect((await feed('barmi')).status).toBe(400);
    for (const c of ['x', '2026-10-25_nem-uuid', `nemdatum_${A}`, "2026-10-25T10:00:00Z_' or 1=1 --"]) {
      expect((await feed('all', undefined, c)).status, c).toBe(400);
    }
  });

  it('K14. a válasz nem ad ki user_id-t, e-mailt vagy más privát mezőt', async () => {
    await post(A, 'Szia');
    const r = await feed('all', B);
    const keys = deepKeys(r.body);
    for (const k of PRIVATE_KEYS) expect(keys.has(k), k).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(A);
    expect(JSON.stringify(r.body)).not.toContain('titok@pelda.hu');
  });
});

// ===========================================================================
// 3) Lájk
// ===========================================================================

describe('Közösség – lájk', () => {
  it('K15. lájk és visszavonás: a számláló és a `likedByMe` nézőnként helyes', async () => {
    const id = (await post(A, 'Lájkold')).body.id;
    expect((await like(B, id)).body).toEqual({ liked: true, likeCount: 1 });
    expect((await like(C, id)).body).toEqual({ liked: true, likeCount: 2 });
    const asB = (await feed('all', B)).body.posts[0];
    expect(asB).toMatchObject({ likeCount: 2, likedByMe: true });
    const asA = (await feed('all', A)).body.posts[0];
    expect(asA).toMatchObject({ likeCount: 2, likedByMe: false, mine: true });
    expect((await unlike(B, id)).body).toEqual({ liked: false, likeCount: 1 });
    expect((await feed('all', B)).body.posts[0]).toMatchObject({ likeCount: 1, likedByMe: false });
  });

  it('K16. egy felhasználó egy bejegyzést csak egyszer lájkolhat (ismételt és párhuzamos kérésre is)', async () => {
    const id = (await post(A, 'Egyszer')).body.id;
    await like(B, id);
    expect((await like(B, id)).body).toEqual({ liked: true, likeCount: 1 });
    await Promise.all(Array.from({ length: 8 }, () => like(C, id)));
    expect(count('SELECT COUNT(*) AS n FROM community_post_likes')).toBe(2);
    // az adatbázis is tiltja a duplikált lájkot (végső garancia)
    expect(() => h.db.prepare("INSERT INTO community_post_likes (post_id, user_id, created_at) VALUES (?, ?, 'x')").run(id, B)).toThrow();
  });

  it('K17. a visszavonás idempotens; a saját bejegyzés is lájkolható', async () => {
    const id = (await post(A, 'Saját')).body.id;
    expect((await unlike(B, id)).body).toEqual({ liked: false, likeCount: 0 });
    expect((await like(A, id)).body).toEqual({ liked: true, likeCount: 1 });
  });

  it('K18. bejelentkezés nélkül 401; nem létező vagy hibás azonosító → 404', async () => {
    const id = (await post(A, 'Szia')).body.id;
    expect((await like(undefined, id)).status).toBe(401);
    expect((await unlike(undefined, id)).status).toBe(401);
    expect((await like(B, MISSING)).status).toBe(404);
    expect((await like(B, 'nem-uuid')).status).toBe(404);
    expect(count('SELECT COUNT(*) AS n FROM community_post_likes')).toBe(0);
  });
});

// ===========================================================================
// 4) Törlés
// ===========================================================================

describe('Közösség – törlés', () => {
  it('K19. a saját bejegyzés törölhető; a lájkjai is törlődnek', async () => {
    const id = (await post(A, 'Törlendő')).body.id;
    await like(B, id);
    const r = await del(A, id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: true });
    expect((await feed('all')).body.posts).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM community_post_likes')).toBe(0);
    expect((await del(A, id)).status).toBe(404);
  });

  it('K20. más bejegyzését nem lehet törölni (403), és az megmarad', async () => {
    const id = (await post(A, 'Az enyém')).body.id;
    const r = await del(B, id);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_OWNER');
    expect((await feed('all')).body.posts.map((p: FeedPost) => p.id)).toEqual([id]);
  });

  it('K21. bejelentkezés nélkül 401; nem létező → 404; a `mine` csak a szerzőnél igaz', async () => {
    const id = (await post(A, 'Szia')).body.id;
    expect((await del(undefined, id)).status).toBe(401);
    expect((await del(A, MISSING)).status).toBe(404);
    expect((await feed('all', A)).body.posts[0].mine).toBe(true);
    expect((await feed('all', B)).body.posts[0].mine).toBe(false);
    expect((await feed('all')).body.posts[0].mine).toBe(false);
  });
});

// ===========================================================================
// 5) Szöveg-szabály, megjelenítés, SEO
// ===========================================================================

describe('Közösség – szöveg-szabály', () => {
  it('K22. normalizálás: trim, sortörés, vezérlőkarakterek, üres sorok, kódpont-alapú hossz', () => {
    expect(normalizePostBody('  a\r\nb  ')).toBe('a\nb');
    expect(normalizePostBody('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizePostBody(`a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c`)).toBe('abc');
    expect(normalizePostBody(`a${String.fromCharCode(0xa0)}\nb`)).toBe('a\nb');
    expect(normalizePostBody('⚽'.repeat(POST_MAX_LENGTH))).not.toBeNull();
    expect(normalizePostBody('⚽'.repeat(POST_MAX_LENGTH + 1))).toBeNull();
    expect(normalizePostBody(String.fromCharCode(0x200b))).toBeNull();
    expect(normalizePostBody(undefined)).toBeNull();
  });
});

describe('Közösség – megjelenítés', () => {
  const sample = (o: Partial<FeedPost> = {}): FeedPost => ({
    id: MISSING, author: { displayName: 'Martin23', avatar: {}, borderKey: 'classic', titleKey: 'none' },
    body: 'Első sor\nMásodik sor', createdAt: '2026-10-25T10:30:00.000Z', likeCount: 3, likedByMe: false, mine: false, ...o,
  });
  const html = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

  it('K23. a kártya: profil, név, dátum, szöveg, lájkszám és lájk gomb; törlés csak a sajátnál', () => {
    const out = html(createElement(PostCard, { post: sample(), canLike: true }));
    expect(out).toContain('Martin23');
    expect(out).toContain('href="/jatekos/Martin23"');
    expect(out).toContain('2026. 10. 25.');
    expect(out).toContain('Első sor\nMásodik sor');
    expect(out).toMatch(/aria-label="Lájkolás"[^>]*>.*3/);
    expect(out).not.toContain('Törlés');
    expect(html(createElement(PostCard, { post: sample({ mine: true }), canLike: true }))).toContain('Törlés');
  });

  it('K24. kijelentkezve a lájk gomb tiltott; lájkolt állapot jelölve', () => {
    expect(html(createElement(PostCard, { post: sample(), canLike: false }))).toMatch(/<button[^>]*disabled[^>]*aria-label="Lájkolás"|<button[^>]*aria-label="Lájkolás"[^>]*disabled/);
    expect(html(createElement(PostCard, { post: sample({ likedByMe: true }), canLike: true }))).toContain('aria-pressed="true"');
  });

  it('K25. üres állapot nézetenként', () => {
    expect(html(createElement(FeedEmpty, { view: 'all' }))).toContain('Még nincs bejegyzés');
    expect(html(createElement(FeedEmpty, { view: 'following' }))).toContain('követettjeidtől');
  });
});

describe('Közösség – navigáció és SEO', () => {
  it('K26. a „Játék” menüben elérhető; nyilvános, indexelhető oldal saját canonicallal', () => {
    expect(PLAY.map((i) => i.to)).toContain('/kozosseg');
    const m = metaForPath('/kozosseg');
    expect(m).toMatchObject({ status: 200, index: true, canonicalPath: '/kozosseg' });
    expect(renderSeoHead(m, true)).toContain('<meta name="robots" content="index, follow" />');
  });
});
