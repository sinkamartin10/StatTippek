/**
 * Követés tárolója – a 0013 `user_follows` tábláján.
 *
 *  - PostgresFollowStore : éles; service_role kulccsal ír (a kliensnek az RLS
 *    miatt NINCS írási joga, csak a saját kapcsolatait olvashatja),
 *  - SqliteFollowStore   : helyi futtatás és tesztek, azonos szerződéssel.
 *
 * Az egyediséget az adatbázis ÖSSZETETT ELSŐDLEGES KULCSA garantálja, az
 * önkövetést pedig a `user_follows_no_self` CHECK – a kódbeli ellenőrzés csak
 * szebb hibaüzenetet ad. A követés létrehozása IDEMPOTENS (`on conflict do
 * nothing`), ezért két párhuzamos kérésből is pontosan egy sor lesz.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseSync } from 'node:sqlite';

export interface FollowPage {
  /** a kapcsolat másik felének azonosítója, legfrissebb elöl */
  userIds: string[];
  hasMore: boolean;
  /** a következő lap kurzora (a legrégebbi visszaadott `created_at`) */
  nextBefore: string | null;
}

export interface FollowStore {
  /** Követés létrehozása. `false`, ha már létezett (idempotens). */
  follow(followerId: string, followedId: string): Promise<boolean>;
  /** Követés megszüntetése. `false`, ha nem is létezett (idempotens). */
  unfollow(followerId: string, followedId: string): Promise<boolean>;
  /** Követi-e A a B-t? */
  isFollowing(followerId: string, followedId: string): Promise<boolean>;
  /** Hány követője van / hány embert követ – EGY-EGY count lekérdezés. */
  counts(userId: string): Promise<{ followers: number; following: number }>;
  /** Több felhasználó követő-száma egyszerre (nincs N+1). */
  followerCounts(userIds: string[]): Promise<Map<string, number>>;
  /** Akiket a felhasználó követ, lapozva. */
  listFollowing(userId: string, limit: number, before?: string): Promise<FollowPage>;
  /** Akik a felhasználót követik, lapozva. */
  listFollowers(userId: string, limit: number, before?: string): Promise<FollowPage>;
}

// ===========================================================================
// PostgreSQL / PostgREST
// ===========================================================================

export class PostgresFollowStore implements FollowStore {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[follow] ${op}: ${error.message}`);
  }

  /**
   * A count-lekérdezés eredménye.
   *
   * FONTOS: a PostgREST `head: true` + `count: 'exact'` kérés HIÁNYZÓ táblára
   * `error: null`-t ÉS `count: null`-t ad – hiba nélkül. Ha ilyenkor 0-t
   * adnánk vissza, egy sémahiba csendben „nulla követő"-ként jelenne meg.
   * Ezért a null számot hibának tekintjük, és nem találgatunk.
   */
  private countOf(op: string, count: number | null): number {
    if (count == null) throw new Error(`[follow] ${op}: a számlálás nem adott eredményt (hiányzó tábla vagy séma-hiba?)`);
    return count;
  }

  async follow(followerId: string, followedId: string): Promise<boolean> {
    // A `select()` miatt a válasz megmondja, keletkezett-e ÚJ sor.
    const { data, error } = await this.db.from('user_follows')
      .upsert({ follower_user_id: followerId, followed_user_id: followedId },
        { onConflict: 'follower_user_id,followed_user_id', ignoreDuplicates: true })
      .select('follower_user_id');
    this.fail('follow', error);
    return (data ?? []).length > 0;
  }

  async unfollow(followerId: string, followedId: string): Promise<boolean> {
    const { data, error } = await this.db.from('user_follows').delete()
      .eq('follower_user_id', followerId).eq('followed_user_id', followedId)
      .select('follower_user_id');
    this.fail('unfollow', error);
    return (data ?? []).length > 0;
  }

  async isFollowing(followerId: string, followedId: string): Promise<boolean> {
    const { count, error } = await this.db.from('user_follows')
      .select('follower_user_id', { count: 'exact', head: true })
      .eq('follower_user_id', followerId).eq('followed_user_id', followedId);
    this.fail('isFollowing', error);
    return this.countOf('isFollowing', count) > 0;
  }

  async counts(userId: string): Promise<{ followers: number; following: number }> {
    // Két COUNT lekérdezés – a sorokat SOHA nem töltjük be a memóriába.
    const [a, b] = await Promise.all([
      this.db.from('user_follows').select('follower_user_id', { count: 'exact', head: true })
        .eq('followed_user_id', userId),
      this.db.from('user_follows').select('followed_user_id', { count: 'exact', head: true })
        .eq('follower_user_id', userId),
    ]);
    this.fail('counts.followers', a.error);
    this.fail('counts.following', b.error);
    return {
      followers: this.countOf('counts.followers', a.count),
      following: this.countOf('counts.following', b.count),
    };
  }

  async followerCounts(userIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!userIds.length) return out;
    // EGY lekérdezés N felhasználóra; csak az azonosító oszlopot kérjük le.
    const { data, error } = await this.db.from('user_follows')
      .select('followed_user_id').in('followed_user_id', userIds);
    this.fail('followerCounts', error);
    for (const r of (data ?? []) as { followed_user_id: string }[]) {
      out.set(r.followed_user_id, (out.get(r.followed_user_id) ?? 0) + 1);
    }
    return out;
  }

  private async page(
    column: 'follower_user_id' | 'followed_user_id',
    pick: 'follower_user_id' | 'followed_user_id',
    userId: string, limit: number, before?: string,
  ): Promise<FollowPage> {
    // limit + 1 sort kérünk: a plusz sor CSAK azt dönti el, van-e még lap.
    let q = this.db.from('user_follows').select(`${pick}, created_at`)
      .eq(column, userId).order('created_at', { ascending: false }).limit(limit + 1);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    this.fail('page', error);

    const rows = (data ?? []) as Record<string, string>[];
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      userIds: slice.map((r) => r[pick]),
      hasMore,
      nextBefore: slice.length ? slice[slice.length - 1].created_at : null,
    };
  }

  listFollowing(userId: string, limit: number, before?: string): Promise<FollowPage> {
    return this.page('follower_user_id', 'followed_user_id', userId, limit, before);
  }

  listFollowers(userId: string, limit: number, before?: string): Promise<FollowPage> {
    return this.page('followed_user_id', 'follower_user_id', userId, limit, before);
  }
}

// ===========================================================================
// SQLite (helyi fejlesztés / tesztek)
// ===========================================================================

export class SqliteFollowStore implements FollowStore {
  constructor(private db: DatabaseSync) {
    // A 0013 megfelelője: összetett elsődleges kulcs + önkövetés tiltása.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_follows (
        follower_user_id TEXT NOT NULL,
        followed_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (follower_user_id, followed_user_id),
        CHECK (follower_user_id <> followed_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_follows_followed ON user_follows(followed_user_id, created_at DESC);
    `);
  }

  async follow(followerId: string, followedId: string): Promise<boolean> {
    const r = this.db.prepare(
      'INSERT OR IGNORE INTO user_follows (follower_user_id, followed_user_id, created_at) VALUES (?, ?, ?)',
    ).run(followerId, followedId, new Date().toISOString());
    return Number(r.changes) > 0;
  }

  async unfollow(followerId: string, followedId: string): Promise<boolean> {
    const r = this.db.prepare(
      'DELETE FROM user_follows WHERE follower_user_id = ? AND followed_user_id = ?',
    ).run(followerId, followedId);
    return Number(r.changes) > 0;
  }

  async isFollowing(followerId: string, followedId: string): Promise<boolean> {
    const row = this.db.prepare(
      'SELECT 1 AS hit FROM user_follows WHERE follower_user_id = ? AND followed_user_id = ?',
    ).get(followerId, followedId);
    return !!row;
  }

  async counts(userId: string): Promise<{ followers: number; following: number }> {
    const f = this.db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE followed_user_id = ?').get(userId) as { n: number };
    const g = this.db.prepare('SELECT COUNT(*) AS n FROM user_follows WHERE follower_user_id = ?').get(userId) as { n: number };
    return { followers: Number(f.n), following: Number(g.n) };
  }

  async followerCounts(userIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!userIds.length) return out;
    const marks = userIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT followed_user_id AS id, COUNT(*) AS n FROM user_follows
       WHERE followed_user_id IN (${marks}) GROUP BY followed_user_id`,
    ).all(...userIds) as { id: string; n: number }[];
    for (const r of rows) out.set(r.id, Number(r.n));
    return out;
  }

  private pageQuery(column: string, pick: string, userId: string, limit: number, before?: string): FollowPage {
    const rows = (before
      ? this.db.prepare(
        `SELECT ${pick} AS id, created_at FROM user_follows
         WHERE ${column} = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
      ).all(userId, before, limit + 1)
      : this.db.prepare(
        `SELECT ${pick} AS id, created_at FROM user_follows
         WHERE ${column} = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(userId, limit + 1)) as { id: string; created_at: string }[];

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      userIds: slice.map((r) => r.id),
      hasMore,
      nextBefore: slice.length ? slice[slice.length - 1].created_at : null,
    };
  }

  async listFollowing(userId: string, limit: number, before?: string): Promise<FollowPage> {
    return this.pageQuery('follower_user_id', 'followed_user_id', userId, limit, before);
  }

  async listFollowers(userId: string, limit: number, before?: string): Promise<FollowPage> {
    return this.pageQuery('followed_user_id', 'follower_user_id', userId, limit, before);
  }
}
