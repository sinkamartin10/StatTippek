/**
 * Modell-tipp archívum – közös típusok és szabályok (szerver + kliens).
 *
 * A NYILVÁNOS adatforma (`TipArchiveEntry`) szándékosan szűk: csak a tipp
 * számszerű adatai, a közzétételi állapot és az elszámolás kerül bele. Belső
 * azonosító-láncot, tartalom-hash-t, indoklás-szöveget, kutatási forrást vagy
 * felhasználói adatot NEM ad ki.
 */
import type { DataOrigin, DataQualityLevel, TipCategory } from './types';

/** Elszámolási állapot. A függő, érvénytelen és nem elszámolható NEM vereség. */
export type SettlementStatus = 'pending' | 'won' | 'lost' | 'void' | 'unsupported';
export const SETTLEMENT_STATUSES: SettlementStatus[] = ['pending', 'won', 'lost', 'void', 'unsupported'];

/**
 * Elérhetőség a termékben.
 *  - `pro_on_request`: a tipp a mérkőzés elemzésének része volt, amelyet a
 *    PRO-előfizetők a mérkőzésoldalon és a Tippek listán megkaphattak. A FREE
 *    csomag napi kvótája napi szintű, ezért tippenként NEM állítjuk, hogy egy
 *    FREE felhasználó látta.
 *  - `not_published`: rögzített, de a termékben nem kínált tipp (jelenleg nem
 *    keletkezik ilyen – a mező a későbbi bővítéshez van fenntartva).
 */
export type TipAvailability = 'pro_on_request' | 'not_published';
export const TIP_AVAILABILITIES: TipAvailability[] = ['pro_on_request', 'not_published'];

export const SETTLEMENT_LABEL: Record<SettlementStatus, string> = {
  pending: 'Függőben',
  won: 'Nyert',
  lost: 'Vesztett',
  void: 'Érvénytelen (tét vissza)',
  unsupported: 'Nem elszámolható',
};

export const AVAILABILITY_LABEL: Record<TipAvailability, string> = {
  pro_on_request: 'PRO-ban elérhető volt',
  not_published: 'Nem publikált',
};

/** A meglévő `marketType()` kategóriái – szűrőhöz. */
export const ARCHIVE_MARKET_TYPES = [
  '1X2', 'dupla esély', 'gólszám', 'BTTS', 'csapat gólszám', 'pontos eredmény', 'hendikep', 'egyéb',
] as const;
export type ArchiveMarketType = (typeof ARCHIVE_MARKET_TYPES)[number];

export const ARCHIVE_PAGE_SIZE = 25;
export const ARCHIVE_PAGE_MAX = 50;
/** Az OFFSET felső korlátja – mély lapozás helyett szűrni kell. */
export const ARCHIVE_MAX_OFFSET = 5000;
export const ARCHIVE_SEARCH_MAX = 40;

/** Egy archív sor, ahogy a nyilvános API kiadja. */
export interface TipArchiveEntry {
  id: string;
  matchId: string;
  matchLabel: string;
  leagueId: string;
  leagueName: string;
  kickoff: string;
  market: string;
  marketLabel: string;
  marketType: string;
  category: TipCategory;
  /** 0..1 */
  modelProb: number;
  /** a generáláskor ismert odds (tájékoztató; a tippet nem befolyásolja) */
  odds: number | null;
  dataQuality: DataQualityLevel;
  sampleSize: number;
  engineVersion: string;
  versionNo: number;
  generatedAt: string;
  /** a generálás a (generáláskor ismert) kezdés előtt történt-e */
  preKickoff: boolean;
  /** ez a sor számít-e a teljesítmény-statisztikába (kezdés előtti utolsó verzió) */
  counted: boolean;
  availability: TipAvailability;
  status: SettlementStatus;
  homeGoals: number | null;
  awayGoals: number | null;
  settledAt: string | null;
}

/** Összesítés – UGYANARRA a szűrt adatkörre, mint a lista. */
export interface TipArchiveSummary {
  /** a szűrőnek megfelelő archív sorok (minden verzió) */
  records: number;
  /** a statisztikába számító sorok (mérkőzés + piac szerint a kezdés előtti utolsó) */
  counted: number;
  won: number;
  lost: number;
  void: number;
  pending: number;
  unsupported: number;
  /** nyert / (nyert + vesztett); null, ha még nincs lezárt tipp */
  hitRate: number | null;
}

export interface TipArchiveResponse {
  entries: TipArchiveEntry[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  summary: TipArchiveSummary;
  /** a legkorábbi rögzített tipp ideje – az archívum ennél régebbre nem nyúlik vissza */
  coverageStart: string | null;
  engineVersion: string;
  origin: DataOrigin;
}

/**
 * A tipp-kategóriák – a motor (`tips.ts`) által adott, az archívum sorában
 * tárolt és megváltoztathatatlan `category` értékek (`TipCategory`). A
 * feliratok megegyeznek a Tippek oldal szűrőjével.
 */
export const ARCHIVE_CATEGORIES: TipCategory[] = ['konzervatív', 'mérsékelt', 'magas variancia'];
export const CATEGORY_LABEL: Record<TipCategory, string> = {
  'konzervatív': 'Konzervatív',
  'mérsékelt': 'Mérsékelt',
  'magas variancia': 'Magas variancia',
};

/** Pontos egyezés a kanonikus kategóriákkal (Unicode-normalizálva); minden más → null. */
export function parseCategory(raw: unknown): TipCategory | null {
  if (typeof raw !== 'string') return null;
  const v = raw.normalize('NFC').trim();
  return (ARCHIVE_CATEGORIES as string[]).includes(v) ? (v as TipCategory) : null;
}

export interface TipArchiveQuery {
  from?: string;
  to?: string;
  leagueId?: string;
  marketType?: string;
  /** a tipp kategóriája (kanonikus érték, lásd ARCHIVE_CATEGORIES) */
  category?: string;
  status?: string;
  availability?: string;
  search?: string;
  scope?: 'all' | 'counted';
  page?: number;
}

/** Találati arány a lezárt (nyert/vesztett) tippekből. */
export function hitRateOf(won: number, lost: number): number | null {
  return won + lost > 0 ? won / (won + lost) : null;
}

/**
 * Csapatnév-keresés tisztítása: csak betű, szám, szóköz, pont, kötőjel és
 * aposztróf marad, hossz-korláttal. A `%`, `_`, `,`, `(` és `)` így sosem
 * jut a lekérdezésbe (LIKE-minta és PostgREST-szintaxis sem törhet).
 */
export function sanitizeSearch(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.normalize('NFC').replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, ARCHIVE_SEARCH_MAX);
  return s.length >= 2 ? s : undefined;
}
