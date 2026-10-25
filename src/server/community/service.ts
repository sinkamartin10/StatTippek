/**
 * Közösségi Feed (MVP) – üzleti logika.
 *
 * ELVEK:
 *  - a szerzőt / lájkolót KIZÁRÓLAG a hitelesített token azonosítja (a route-réteg adja át);
 *    a kérés törzséből SOHA nem olvasunk felhasználó-azonosítót,
 *  - a válaszban nincs user_id: a szerző a megjelenítési nevével és a MEGLÉVŐ nyilvános
 *    kozmetikum-réteggel (`publicProfiles`) jelenik meg – nincs második profilrendszer,
 *  - bejegyzést csak beállított megjelenítési névvel lehet írni (a név a nyilvános identitás),
 *  - a Feed tisztán social: nem ad XP-t, coint, és semmilyen pontozást nem befolyásol.
 */
import {
  CURSOR_RE, FEED_PAGE_SIZE, POST_COOLDOWN_MS, POST_ID_RE, normalizePostBody,
  type FeedAuthor, type FeedPost, type FeedResponse, type FeedView, type LikeResponse,
} from '../../shared/community';
import type { PublicProfile } from '../../shared/competition';
import type { DisplayNameDirectory } from '../profile/displayNameDirectory';
import type { CommunityStore, Cursor, PostRow, PostStats } from './store';

/** Üzleti hiba, amiből a route-réteg HTTP státuszt képez (meglévő konvenció). */
export class CommunityError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

const DEFAULT_PROFILE: PublicProfile = { avatar: {}, borderKey: 'classic', titleKey: 'none' };
const NO_STATS: PostStats = { likeCount: 0, likedByViewer: false };

/** A lapozási kurzor ellenőrzése. Hiányzó → null; hibás → 400. */
export function parseCursor(raw: unknown): Cursor | null {
  if (raw == null || raw === '') return null;
  const m = typeof raw === 'string' && raw.length <= 80 ? CURSOR_RE.exec(raw) : null;
  if (!m || !Number.isFinite(Date.parse(m[1]))) throw new CommunityError('Érvénytelen lapozási kurzor.', 400, 'BAD_CURSOR');
  return { at: m[1], id: m[2].toLowerCase() };
}

export function parseView(raw: unknown): FeedView {
  if (raw == null || raw === '' || raw === 'all') return 'all';
  if (raw === 'following') return 'following';
  throw new CommunityError('Ismeretlen nézet (all | following).', 400, 'BAD_VIEW');
}

/** Ismeretlen alakú azonosító ugyanúgy 404, mint a nem létező – nem árulunk el többet. */
function postId(raw: unknown): string {
  if (typeof raw !== 'string' || !POST_ID_RE.test(raw)) throw new CommunityError('Nincs ilyen bejegyzés.', 404, 'POST_NOT_FOUND');
  return raw.toLowerCase();
}

export class CommunityService {
  constructor(
    private store: CommunityStore,
    private names: DisplayNameDirectory,
    /** a MEGLÉVŐ, szerver által ellenőrzött nyilvános kozmetikumok */
    private publicProfiles?: (userIds: string[]) => Promise<Map<string, PublicProfile>>,
    private now: () => number = () => Date.now(),
  ) {}

  private async profilesOf(userIds: string[]): Promise<Map<string, PublicProfile>> {
    if (!this.publicProfiles || !userIds.length) return new Map();
    // a kozmetikum csak díszítés: hibája nem akaszthatja meg a Feedet
    try { return await this.publicProfiles(userIds); } catch { return new Map(); }
  }

  /** Bejegyzések → nyilvános alak, kötegelt lekérdezésekkel (a lap méretétől független számú lekérdezés). */
  private async toFeedPosts(rows: PostRow[], viewerId: string | null): Promise<FeedPost[]> {
    if (!rows.length) return [];
    const authors = [...new Set(rows.map((r) => r.authorUserId))];
    const [names, profiles, stats] = await Promise.all([
      this.names.getMany(authors),
      this.profilesOf(authors),
      this.store.stats(rows.map((r) => r.id), viewerId),
    ]);
    return rows.map((r) => {
      const p = profiles.get(r.authorUserId) ?? DEFAULT_PROFILE;
      const author: FeedAuthor = {
        displayName: names.get(r.authorUserId) ?? null,
        avatar: p.avatar,
        borderKey: p.borderKey,
        titleKey: p.titleKey,
        ...(p.shop ? { shop: p.shop as Record<string, string | null> } : {}),
      };
      const s = stats.get(r.id) ?? NO_STATS;
      return {
        id: r.id,
        author,
        body: r.body,
        createdAt: new Date(r.createdAt).toISOString(),
        likeCount: s.likeCount,
        likedByMe: viewerId != null && s.likedByViewer,
        mine: viewerId != null && viewerId === r.authorUserId,
      };
    });
  }

  /** Feed: legújabb elöl. A „Követettek” nézethez bejelentkezés kell. */
  async feed(viewerId: string | null, viewRaw: unknown, beforeRaw: unknown): Promise<FeedResponse> {
    const view = parseView(viewRaw);
    const before = parseCursor(beforeRaw);
    if (view === 'following' && !viewerId) throw new CommunityError('Bejelentkezés szükséges.', 401, 'AUTH_REQUIRED');
    const page = await this.store.listPosts(FEED_PAGE_SIZE, before, view === 'following' ? viewerId : null);
    return { view, posts: await this.toFeedPosts(page.rows, viewerId), hasMore: page.hasMore, nextBefore: page.nextBefore };
  }

  /** Új bejegyzés. A szerző MINDIG a hitelesített felhasználó. */
  async createPost(userId: string, bodyRaw: unknown): Promise<FeedPost> {
    const body = normalizePostBody(bodyRaw);
    if (!body) throw new CommunityError('A bejegyzés 1–500 karakter hosszú szöveg lehet.', 422, 'INVALID_BODY');
    if (!(await this.names.get(userId))) {
      throw new CommunityError('Bejegyzés írása előtt állíts be megjelenítési nevet a profilodban.', 422, 'DISPLAY_NAME_REQUIRED');
    }
    const last = await this.store.lastPostAt(userId);
    if (last && this.now() - Date.parse(last) < POST_COOLDOWN_MS) {
      throw new CommunityError('Túl gyorsan – várj néhány másodpercet a következő bejegyzés előtt.', 429, 'POST_COOLDOWN');
    }
    const row = await this.store.createPost(userId, body);
    const [post] = await this.toFeedPosts([row], userId);
    return post;
  }

  /** Csak a SAJÁT bejegyzés törölhető; másé 403, nem létező 404. */
  async deletePost(userId: string, idRaw: unknown): Promise<{ deleted: true }> {
    const id = postId(idRaw);
    if (await this.store.deleteOwnPost(id, userId)) return { deleted: true };
    const exists = await this.store.getPost(id);
    if (exists) throw new CommunityError('Csak a saját bejegyzésedet törölheted.', 403, 'NOT_OWNER');
    throw new CommunityError('Nincs ilyen bejegyzés.', 404, 'POST_NOT_FOUND');
  }

  private async likeState(id: string, userId: string): Promise<LikeResponse> {
    const s = (await this.store.stats([id], userId)).get(id) ?? NO_STATS;
    return { liked: s.likedByViewer, likeCount: s.likeCount };
  }

  /** Lájk – idempotens: ismételt lájk nem hoz létre második sort. */
  async like(userId: string, idRaw: unknown): Promise<LikeResponse> {
    const id = postId(idRaw);
    if (!(await this.store.getPost(id))) throw new CommunityError('Nincs ilyen bejegyzés.', 404, 'POST_NOT_FOUND');
    try {
      await this.store.like(id, userId);
    } catch (e) {
      // a bejegyzést közben törölték (idegen kulcs) → ugyanaz, mint a nem létező
      if (!(await this.store.getPost(id))) throw new CommunityError('Nincs ilyen bejegyzés.', 404, 'POST_NOT_FOUND');
      throw e;
    }
    return this.likeState(id, userId);
  }

  /** Lájk visszavonása – idempotens. */
  async unlike(userId: string, idRaw: unknown): Promise<LikeResponse> {
    const id = postId(idRaw);
    if (!(await this.store.getPost(id))) throw new CommunityError('Nincs ilyen bejegyzés.', 404, 'POST_NOT_FOUND');
    await this.store.unlike(id, userId);
    return this.likeState(id, userId);
  }
}
