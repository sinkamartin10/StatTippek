/**
 * Értesítés-tároló. A meglévő store-ok mintáját követi, de attól FÜGGETLEN:
 * saját tábla, saját interfész.
 *
 *  - PostgresNotificationStore : Supabase PostgreSQL service_role kulccsal (éles)
 *  - SqliteNotificationStore   : helyi tartalék és teszt-tároló (node:sqlite)
 *
 * IDEMPOTENCIA: a `(user_id, source_key)` egyedi index dönt, nem előzetes
 * ellenőrzés. A `create()` `true`-t ad, ha a sor MOST jött létre, és `false`-t,
 * ha már létezett – a `progression_events.claimEvent()` bevált mintája.
 *
 * Ez a réteg KIZÁRÓLAG a `notifications` táblát írja; semmilyen más tábláhez
 * nem nyúl.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NewNotification, NotificationRow } from '../../shared/notifications';

/** Egy lap a cursor-alapú lapozásból. */
export interface NotificationPage {
  rows: NotificationRow[];
  /** van-e még régebbi elem a kért limiten túl */
  hasMore: boolean;
}

export interface NotificationStore {
  readonly kind: 'postgres' | 'sqlite';
  healthCheck(): Promise<string[]>;

  /**
   * Értesítés létrehozása, ha még nincs. `true` = most jött létre,
   * `false` = ugyanezzel a forráskulccsal már létezik (nem duplikálunk).
   */
  create(n: NewNotification): Promise<boolean>;

  /** Egy lap a felhasználó értesítéseiből, `created_at desc` sorrendben. */
  list(userId: string, limit: number, before?: string): Promise<NotificationPage>;

  /** Az olvasatlanok száma (a jelvényhez). */
  unreadCount(userId: string): Promise<number>;

  /**
   * Egy értesítés olvasottra állítása. KIZÁRÓLAG a saját sorát – a `user_id`
   * a feltételes írás RÉSZE, nem előzetes ellenőrzés. `null` = nincs ilyen
   * saját értesítés. Már olvasott sornál a `read_at` NEM íródik újra.
   */
  markRead(userId: string, id: string, at: string): Promise<NotificationRow | null>;

  /** Minden olvasatlan megjelölése. A módosított sorok számát adja. */
  markAllRead(userId: string, at: string): Promise<number>;

  /**
   * A megadott forráskulcsok közül azok, amelyek MÁR léteznek a felhasználónál.
   * Kötegelt – az újraszármaztatás ebből tudja, mit kell pótolni (nincs N+1).
   */
  existingSourceKeys(userId: string, sourceKeys: string[]): Promise<Set<string>>;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
type Row = Record<string, any>;

function toNotification(r: Row): NotificationRow {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body ?? null,
    entityType: r.entity_type ?? null,
    entityId: r.entity_id ?? null,
    metadata: typeof r.metadata === 'string' ? safeJson(r.metadata) : (r.metadata ?? {}),
    readAt: r.read_at ? iso(r.read_at) : null,
    createdAt: iso(r.created_at),
  };
}

/** A SQLite JSONB-t szövegként tárolja; hibás tartalom ne döntse el a listát. */
function safeJson(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

// ============================================================================
// Supabase PostgreSQL (éles)
// ============================================================================

export class PostgresNotificationStore implements NotificationStore {
  readonly kind = 'postgres' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[notifications] ${op}: ${error.message}`);
  }

  async healthCheck(): Promise<string[]> {
    const { error } = await this.db.from('notifications').select('*').limit(1);
    return error ? [`notifications (${error.message})`] : [];
  }

  async create(n: NewNotification): Promise<boolean> {
    // ON CONFLICT DO NOTHING: ugyanaz a forráskulcs sosem duplikálhat
    const { data, error } = await this.db.from('notifications')
      .upsert({
        user_id: n.userId,
        type: n.type,
        title: n.title,
        body: n.body ?? null,
        entity_type: n.entityType ?? null,
        entity_id: n.entityId ?? null,
        source_key: n.sourceKey,
        metadata: n.metadata ?? {},
      }, { onConflict: 'user_id,source_key', ignoreDuplicates: true })
      .select('id').maybeSingle();
    this.fail('create', error);
    return !!data;
  }

  async list(userId: string, limit: number, before?: string): Promise<NotificationPage> {
    // limit + 1 sort kérünk: a plusz egy mondja meg, hogy van-e még régebbi
    let qb = this.db.from('notifications').select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);
    if (before) qb = qb.lt('created_at', before);
    const { data, error } = await qb;
    this.fail('list', error);
    const all = (data ?? []).map(toNotification);
    return { rows: all.slice(0, limit), hasMore: all.length > limit };
  }

  async unreadCount(userId: string): Promise<number> {
    const { count, error } = await this.db.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).is('read_at', null);
    this.fail('unreadCount', error);
    return count ?? 0;
  }

  async markRead(userId: string, id: string, at: string): Promise<NotificationRow | null> {
    // A user_id a WHERE RÉSZE: idegen értesítést nem lehet olvasottra állítani.
    // A read_at is null feltétel miatt a már olvasott sor időbélyege nem íródik újra.
    const { data, error } = await this.db.from('notifications')
      .update({ read_at: at })
      .eq('id', id).eq('user_id', userId).is('read_at', null)
      .select('*').maybeSingle();
    this.fail('markRead', error);
    if (data) return toNotification(data);
    // Nem írt: vagy nem a hívóé, vagy már olvasott volt. Az utóbbit visszaadjuk.
    const { data: existing, error: readErr } = await this.db.from('notifications')
      .select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    this.fail('markRead/olvasás', readErr);
    return existing ? toNotification(existing) : null;
  }

  async markAllRead(userId: string, at: string): Promise<number> {
    const { data, error } = await this.db.from('notifications')
      .update({ read_at: at })
      .eq('user_id', userId).is('read_at', null)
      .select('id');
    this.fail('markAllRead', error);
    return (data ?? []).length;
  }

  async existingSourceKeys(userId: string, sourceKeys: string[]): Promise<Set<string>> {
    if (!sourceKeys.length) return new Set();
    const { data, error } = await this.db.from('notifications')
      .select('source_key').eq('user_id', userId).in('source_key', [...new Set(sourceKeys)]);
    this.fail('existingSourceKeys', error);
    return new Set((data ?? []).map((r: Row) => r.source_key as string));
  }
}

// ============================================================================
// Helyi SQLite (tartalék és teszt)
// ============================================================================

export class SqliteNotificationStore implements NotificationStore {
  readonly kind = 'sqlite' as const;

  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        entity_type TEXT,
        entity_id TEXT,
        source_key TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        read_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(user_id, source_key);
    `);
  }

  async healthCheck(): Promise<string[]> { return []; }

  async create(n: NewNotification): Promise<boolean> {
    // ATOMI: nincs „megnézem, aztán beszúrom” lépés – az egyedi index dönt,
    // a changes mondja meg, nyertünk-e.
    const r = this.db.prepare(`INSERT INTO notifications
      (id, user_id, type, title, body, entity_type, entity_id, source_key, metadata, read_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,NULL,?)
      ON CONFLICT (user_id, source_key) DO NOTHING`)
      .run(randomUUID(), n.userId, n.type, n.title, n.body ?? null,
        n.entityType ?? null, n.entityId ?? null, n.sourceKey,
        JSON.stringify(n.metadata ?? {}), new Date().toISOString());
    return Number(r.changes) > 0;
  }

  async list(userId: string, limit: number, before?: string): Promise<NotificationPage> {
    const rows = before
      ? this.db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND created_at < ?
          ORDER BY created_at DESC, id DESC LIMIT ?`).all(userId, before, limit + 1) as Row[]
      : this.db.prepare(`SELECT * FROM notifications WHERE user_id = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`).all(userId, limit + 1) as Row[];
    const all = rows.map(toNotification);
    return { rows: all.slice(0, limit), hasMore: all.length > limit };
  }

  async unreadCount(userId: string): Promise<number> {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(userId) as Row;
    return r.n as number;
  }

  async markRead(userId: string, id: string, at: string): Promise<NotificationRow | null> {
    // A user_id a WHERE része – idegen sort nem lehet olvasottra állítani
    this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
      .run(at, id, userId);
    const r = this.db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?')
      .get(id, userId) as Row | undefined;
    return r ? toNotification(r) : null;
  }

  async markAllRead(userId: string, at: string): Promise<number> {
    const r = this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(at, userId);
    return Number(r.changes);
  }

  async existingSourceKeys(userId: string, sourceKeys: string[]): Promise<Set<string>> {
    if (!sourceKeys.length) return new Set();
    const unique = [...new Set(sourceKeys)];
    const rows = this.db.prepare(
      `SELECT source_key FROM notifications WHERE user_id = ? AND source_key IN (${unique.map(() => '?').join(',')})`,
    ).all(userId, ...unique) as Row[];
    return new Set(rows.map((r) => r.source_key as string));
  }
}
