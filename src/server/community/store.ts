/**
 * Közösségi Feed tárolója – a 0023 `community_posts` / `community_post_likes` tábláin.
 *
 *  - PostgresCommunityStore : éles; service_role kulccsal (a kliens kulcsoknak az RLS és a
 *    visszavont jogok miatt SEMMILYEN hozzáférése nincs),
 *  - SqliteCommunityStore   : helyi futtatás és tesztek, azonos szerződéssel.
 *
 * Adatbázis-szintű garanciák: a lájk egyediségét az összetett elsődleges kulcs adja (a lájkolás
 * IDEMPOTENS – két párhuzamos kérésből is pontosan egy sor lesz), a saját bejegyzés törlése EGY,
 * a szerzőre szűrt DELETE (más bejegyzését a feltétel miatt technikailag sem törölheti).
 * A „Követettek” nézet a 0013 `user_follows` tábláját CSAK OLVASSA.
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseSync } from 'node:sqlite';

export interface PostRow {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

export interface PostPage {
  rows: PostRow[];
  hasMore: boolean;
  /** a következő lap kurzora (`<created_at>_<id>`), vagy null */
  nextBefore: string | null;
}

export interface Cursor { at: string; id: string }

export interface PostStats { likeCount: number; likedByViewer: boolean }

export interface CommunityStore {
  createPost(authorUserId: string, body: string): Promise<PostRow>;
  getPost(id: string): Promise<PostRow | null>;
  /** A szerző legutóbbi bejegyzésének ideje (spamvédelemhez), vagy null. */
  lastPostAt(authorUserId: string): Promise<string | null>;
  /** Legújabb elöl. `followingOf`: csak az általa követett szerzők bejegyzései. */
  listPosts(limit: number, before: Cursor | null, followingOf: string | null): Promise<PostPage>;
  /** Csak a SAJÁT bejegyzés törlődik; `false`, ha nincs ilyen (vagy nem a szerzőé). */
  deleteOwnPost(id: string, authorUserId: string): Promise<boolean>;
  /** Lájk. `false`, ha már lájkolta (idempotens). */
  like(postId: string, userId: string): Promise<boolean>;
  /** Lájk visszavonása. `false`, ha nem is lájkolta (idempotens). */
  unlike(postId: string, userId: string): Promise<boolean>;
  /** Lájk-számok és a néző lájkjai egy lapnyi bejegyzésre – EGY lekérdezés. */
  stats(postIds: string[], viewerId: string | null): Promise<Map<string, PostStats>>;
}

const pageOf = (rows: PostRow[], limit: number): PostPage => {
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return { rows: slice, hasMore, nextBefore: hasMore && last ? `${last.createdAt}_${last.id}` : null };
};

// ===========================================================================
// PostgreSQL / PostgREST
// ===========================================================================

interface PgPost { id: string; author_user_id: string; body: string; created_at: string }
const fromPg = (r: PgPost): PostRow => ({ id: r.id, authorUserId: r.author_user_id, body: r.body, createdAt: r.created_at });

export class PostgresCommunityStore implements CommunityStore {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[community] ${op}: ${error.message}`);
  }

  async createPost(authorUserId: string, body: string): Promise<PostRow> {
    const { data, error } = await this.db.from('community_posts')
      .insert({ author_user_id: authorUserId, body })
      .select('id, author_user_id, body, created_at').single();
    this.fail('createPost', error);
    return fromPg(data as PgPost);
  }

  async getPost(id: string): Promise<PostRow | null> {
    const { data, error } = await this.db.from('community_posts')
      .select('id, author_user_id, body, created_at').eq('id', id).maybeSingle();
    this.fail('getPost', error);
    return data ? fromPg(data as PgPost) : null;
  }

  async lastPostAt(authorUserId: string): Promise<string | null> {
    const { data, error } = await this.db.from('community_posts')
      .select('created_at').eq('author_user_id', authorUserId)
      .order('created_at', { ascending: false }).limit(1);
    this.fail('lastPostAt', error);
    return (data as { created_at: string }[] | null)?.[0]?.created_at ?? null;
  }

  async listPosts(limit: number, before: Cursor | null, followingOf: string | null): Promise<PostPage> {
    // limit + 1 sor: a plusz sor CSAK azt dönti el, van-e még lap
    const { data, error } = await this.db.rpc('community_feed', {
      p_viewer: followingOf,
      p_following_only: followingOf != null,
      p_before_at: before?.at ?? null,
      p_before_id: before?.id ?? null,
      p_limit: limit + 1,
    });
    this.fail('listPosts', error);
    return pageOf(((data ?? []) as PgPost[]).map(fromPg), limit);
  }

  async deleteOwnPost(id: string, authorUserId: string): Promise<boolean> {
    // a tulajdon ellenőrzése és a törlés UGYANAZ az utasítás
    const { data, error } = await this.db.from('community_posts').delete()
      .eq('id', id).eq('author_user_id', authorUserId).select('id');
    this.fail('deleteOwnPost', error);
    return (data ?? []).length > 0;
  }

  async like(postId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.db.from('community_post_likes')
      .upsert({ post_id: postId, user_id: userId }, { onConflict: 'post_id,user_id', ignoreDuplicates: true })
      .select('post_id');
    this.fail('like', error);
    return (data ?? []).length > 0;
  }

  async unlike(postId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.db.from('community_post_likes').delete()
      .eq('post_id', postId).eq('user_id', userId).select('post_id');
    this.fail('unlike', error);
    return (data ?? []).length > 0;
  }

  async stats(postIds: string[], viewerId: string | null): Promise<Map<string, PostStats>> {
    const out = new Map<string, PostStats>();
    if (!postIds.length) return out;
    const { data, error } = await this.db.rpc('community_post_stats', { p_post_ids: postIds, p_viewer: viewerId });
    this.fail('stats', error);
    for (const r of (data ?? []) as { post_id: string; like_count: number | string; liked_by_viewer: boolean }[]) {
      out.set(r.post_id, { likeCount: Number(r.like_count), likedByViewer: !!r.liked_by_viewer });
    }
    return out;
  }
}

// ===========================================================================
// SQLite (helyi fejlesztés / tesztek)
// ===========================================================================

export class SqliteCommunityStore implements CommunityStore {
  constructor(private db: DatabaseSync) {
    // A 0023 megfelelője: hossz-CHECK, összetett elsődleges kulcs a lájkon, azonos indexek.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS community_posts (
        id TEXT PRIMARY KEY,
        author_user_id TEXT NOT NULL,
        body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500 AND body = trim(body, ' ')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_community_posts_created ON community_posts(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_community_posts_author ON community_posts(author_user_id, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS community_post_likes (
        post_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (post_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_community_post_likes_user ON community_post_likes(user_id);
      CREATE TABLE IF NOT EXISTS user_follows (
        follower_user_id TEXT NOT NULL,
        followed_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (follower_user_id, followed_user_id),
        CHECK (follower_user_id <> followed_user_id)
      );
    `);
  }

  async createPost(authorUserId: string, body: string): Promise<PostRow> {
    const row: PostRow = { id: randomUUID(), authorUserId, body, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO community_posts (id, author_user_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(row.id, row.authorUserId, row.body, row.createdAt);
    return row;
  }

  async getPost(id: string): Promise<PostRow | null> {
    const r = this.db.prepare('SELECT id, author_user_id, body, created_at FROM community_posts WHERE id = ?').get(id) as PgPost | undefined;
    return r ? fromPg(r) : null;
  }

  async lastPostAt(authorUserId: string): Promise<string | null> {
    const r = this.db.prepare('SELECT max(created_at) AS at FROM community_posts WHERE author_user_id = ?').get(authorUserId) as { at: string | null };
    return r.at ?? null;
  }

  async listPosts(limit: number, before: Cursor | null, followingOf: string | null): Promise<PostPage> {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (before) { where.push('(p.created_at, p.id) < (?, ?)'); args.push(before.at, before.id); }
    if (followingOf != null) {
      where.push('EXISTS (SELECT 1 FROM user_follows f WHERE f.follower_user_id = ? AND f.followed_user_id = p.author_user_id)');
      args.push(followingOf);
    }
    const rows = this.db.prepare(
      `SELECT p.id, p.author_user_id, p.body, p.created_at FROM community_posts p
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    ).all(...args, limit + 1) as unknown as PgPost[];
    return pageOf(rows.map(fromPg), limit);
  }

  async deleteOwnPost(id: string, authorUserId: string): Promise<boolean> {
    // A Postgresben az `on delete cascade` törli a lájkokat; itt ugyanez egy tranzakcióban
    this.db.exec('BEGIN');
    try {
      const r = this.db.prepare('DELETE FROM community_posts WHERE id = ? AND author_user_id = ?').run(id, authorUserId);
      if (Number(r.changes) > 0) this.db.prepare('DELETE FROM community_post_likes WHERE post_id = ?').run(id);
      this.db.exec('COMMIT');
      return Number(r.changes) > 0;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async like(postId: string, userId: string): Promise<boolean> {
    // Csak létező bejegyzésre (a Postgresben ezt az idegen kulcs garantálja)
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO community_post_likes (post_id, user_id, created_at)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM community_posts WHERE id = ?)`,
    ).run(postId, userId, new Date().toISOString(), postId);
    return Number(r.changes) > 0;
  }

  async unlike(postId: string, userId: string): Promise<boolean> {
    const r = this.db.prepare('DELETE FROM community_post_likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
    return Number(r.changes) > 0;
  }

  async stats(postIds: string[], viewerId: string | null): Promise<Map<string, PostStats>> {
    const out = new Map<string, PostStats>();
    if (!postIds.length) return out;
    const marks = postIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT post_id, COUNT(*) AS n, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
       FROM community_post_likes WHERE post_id IN (${marks}) GROUP BY post_id`,
    ).all(viewerId ?? '', ...postIds) as { post_id: string; n: number; mine: number }[];
    for (const r of rows) out.set(r.post_id, { likeCount: Number(r.n), likedByViewer: Number(r.mine) === 1 });
    return out;
  }
}
