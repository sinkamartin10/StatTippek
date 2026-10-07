/**
 * Értesítés-szolgáltatás. SZÁNDÉKOSAN ÁLTALÁNOS: nem ismeri a Battle-t.
 *
 * A „mit kellene még látnia a felhasználónak" kérdést az injektált
 * újraszármaztatók (reconcilers) válaszolják meg – így a Battle-logika a
 * battle modulban marad, és egy későbbi forrás (pl. Tippverseny) ugyanígy
 * beilleszthető, a szolgáltatás módosítása nélkül.
 *
 * ÚJRASZÁRMAZTATÁS (D2): a lista lekérésekor megkérdezzük az összes
 * újraszármaztatótól, milyen értesítések tartoznának a felhasználóhoz, majd
 * EGY kötegelt lekérdezéssel megnézzük, melyik forráskulcs létezik már, és csak
 * a hiányzókat szúrjuk be. Ha egy esemény értesítése ritka hiba miatt elmaradt,
 * a következő listázás pótolja. Duplikáció kizárt: `(user_id, source_key)`
 * egyedi + `on conflict do nothing`.
 *
 * A felhasználót KIZÁRÓLAG a hívó réteg azonosítja a hitelesített tokenből;
 * a kliens által küldött user_id / type / title / read_at értéket soha nem
 * olvassuk ki.
 */
import {
  NOTIFICATION_DEFAULT_LIMIT, NOTIFICATION_MAX_LIMIT,
  type NewNotification, type NotificationListResponse, type NotificationRow,
} from '../../shared/notifications';
import type { NotificationStore } from './store';

/** Üzleti hiba, amiből a route-réteg HTTP státuszt képez. */
export class NotificationError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

/**
 * Egy értesítés-forrás: megadja, milyen értesítések tartoznának a felhasználóhoz
 * a rendszer JELENLEGI állapota szerint. Tisztán olvasó, mellékhatás nélkül.
 */
export type NotificationReconciler = (userId: string) => Promise<NewNotification[]>;

export class NotificationService {
  constructor(
    private store: NotificationStore,
    /** Opcionális újraszármaztatók. Hiányukban a szolgáltatás csak kiszolgál. */
    private reconcilers: NotificationReconciler[] = [],
  ) {}

  /**
   * Értesítés kibocsátása. SOHA NEM DOB: az értesítés mellékes a kiváltó
   * művelethez képest, ezért egy hiba nem bukhat vissza a hívóra (pl. nem
   * törheti meg egy battle állapotátmenetét). `true` = most jött létre.
   */
  async emit(n: NewNotification): Promise<boolean> {
    try {
      return await this.store.create(n);
    } catch (e) {
      console.error('[notifications] kibocsátás sikertelen:', n.sourceKey, (e as Error).message);
      return false;
    }
  }

  /** Több értesítés kibocsátása. Egyik hibája sem akadályozza a többit. */
  async emitMany(list: NewNotification[]): Promise<number> {
    let created = 0;
    for (const n of list) if (await this.emit(n)) created++;
    return created;
  }

  /**
   * A hiányzó értesítések pótlása a jelenlegi rendszerállapotból.
   * KÖTEGELT: egy lekérdezés a létező forráskulcsokra, utána csak a hiányzók
   * beszúrása – nincs N+1. Hibája nem akadályozza a listázást.
   */
  private async reconcile(userId: string): Promise<void> {
    if (!this.reconcilers.length) return;
    try {
      const candidates: NewNotification[] = [];
      for (const r of this.reconcilers) {
        try { candidates.push(...await r(userId)); }
        catch (e) { console.error('[notifications] újraszármaztató hiba:', (e as Error).message); }
      }
      if (!candidates.length) return;
      // A jelölt csak a HÍVÓ saját értesítése lehet – védőháló a forrás hibája ellen
      const own = candidates.filter((c) => c.userId === userId);
      const existing = await this.store.existingSourceKeys(userId, own.map((c) => c.sourceKey));
      const missing = own.filter((c) => !existing.has(c.sourceKey));
      if (missing.length) await this.emitMany(missing);
    } catch (e) {
      console.error('[notifications] újraszármaztatás sikertelen:', (e as Error).message);
    }
  }

  /**
   * Egy lap az értesítésekből + az olvasatlanok száma UGYANEBBEN a válaszban
   * (nincs külön count-kérés). A listázás előtt lefut az újraszármaztatás.
   */
  async list(userId: string, opts: { limit?: number; before?: string } = {}): Promise<NotificationListResponse> {
    await this.reconcile(userId);

    const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.min(opts.limit as number, NOTIFICATION_MAX_LIMIT)
      : NOTIFICATION_DEFAULT_LIMIT;

    const [page, unreadCount] = await Promise.all([
      this.store.list(userId, limit, opts.before),
      this.store.unreadCount(userId),
    ]);

    return {
      notifications: page.rows,
      unreadCount,
      hasMore: page.hasMore,
      nextBefore: page.hasMore && page.rows.length ? page.rows[page.rows.length - 1].createdAt : null,
    };
  }

  /**
   * Egy értesítés olvasottra állítása. A tulajdonos-ellenőrzés a feltételes
   * írás RÉSZE (a tároló a user_id-t is a WHERE-be teszi), ezért idegen
   * értesítést nem lehet megjelölni.
   */
  async markRead(userId: string, id: string): Promise<NotificationRow> {
    const row = await this.store.markRead(userId, id, new Date().toISOString());
    if (!row) throw new NotificationError('Az értesítés nem található.', 404, 'NOTIFICATION_NOT_FOUND');
    return row;
  }

  /** Minden olvasatlan megjelölése. A módosított sorok számát adja. */
  async markAllRead(userId: string): Promise<number> {
    return this.store.markAllRead(userId, new Date().toISOString());
  }

  /** Csak az olvasatlanok száma – a fejléc jelvényéhez, ha a lista nem kell. */
  unreadCount(userId: string): Promise<number> {
    return this.store.unreadCount(userId);
  }
}
