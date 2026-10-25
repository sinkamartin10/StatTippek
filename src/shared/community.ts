/**
 * Közösségi Feed (MVP) – közös típusok, korlátok és a bejegyzés-szöveg szabálya (szerver + kliens).
 *
 * A válaszok ENGEDÉLYEZŐ LISTÁval épülnek (lásd a szerver `toFeedPost`): a szerző a megjelenítési
 * nevével és a nyilvános kozmetikumaival jelenik meg – user_id, e-mail vagy más privát mező nem
 * kerül ki. A `mine` / `likedByMe` a NÉZŐHÖZ viszonyított, szerver által számolt jelző.
 */

/** A bejegyzés szövegének legnagyobb hossza (karakterben). */
export const POST_MAX_LENGTH = 500;
/** Egy lapon ennyi bejegyzés jön (a lapozás kulcsalapú, korlátlan lekérdezés nincs). */
export const FEED_PAGE_SIZE = 20;
/** Két bejegyzés között legalább ennyi időnek el kell telnie (felhasználónként) – egyszerű spamvédelem. */
export const POST_COOLDOWN_MS = 15_000;

export type FeedView = 'all' | 'following';
export const FEED_VIEWS: FeedView[] = ['all', 'following'];

export interface FeedAuthor {
  /** null, ha a szerzőnek (már) nincs megjelenítési neve */
  displayName: string | null;
  avatar: Record<string, string>;
  borderKey: string;
  titleKey: string;
  shop?: Record<string, string | null>;
}

export interface FeedPost {
  id: string;
  author: FeedAuthor;
  body: string;
  createdAt: string;
  likeCount: number;
  /** a néző lájkolta-e (kijelentkezve mindig false) */
  likedByMe: boolean;
  /** a néző saját bejegyzése-e (csak ekkor törölhető) */
  mine: boolean;
}

export interface FeedResponse {
  view: FeedView;
  posts: FeedPost[];
  hasMore: boolean;
  /** a következő lap kurzora, vagy null */
  nextBefore: string | null;
}

export interface LikeResponse {
  liked: boolean;
  likeCount: number;
}

/**
 * A bejegyzés szövegének normalizálása. Érvénytelen bemenetre (nem szöveg, üres, túl hosszú) null.
 *  - Unicode NFC, egységes sortörés (\n),
 *  - a vezérlőkarakterek törlése (a sortörés és a tabulátor kivételével; a tabulátor szóközzé válik),
 *  - legfeljebb egy üres sor egymás után, a sorvégi szóközök nélkül,
 *  - a szöveg elején és végén nincs szóköz / üres sor.
 * A hosszt Unicode-karakterben (kódpontban) mérjük, ahogy az adatbázis `char_length`-e is.
 */
export function normalizePostBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // vezérlő-, nulla szélességű és irányváltó karakterek törlése (a sortörés kivételével)
    .replace(new RegExp('[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]', 'g'), '')
    .replace(new RegExp('[ \u00A0]+\\n', 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const len = [...s].length;
  return len >= 1 && len <= POST_MAX_LENGTH ? s : null;
}

/** A Feed lapozási kurzora: `<created_at>_<uuid>` – a szerver adja, a kliens változatlanul visszaküldi. */
export const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const POST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
