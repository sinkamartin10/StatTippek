/**
 * Edge Radar – számítási alapok (1. fázis). TISZTA, determinisztikus függvények; semmilyen API-hoz,
 * felülethez, tipphez vagy archívumhoz NINCSENEK bekötve. A meglévő `computeValue` (nyers 1/odds és
 * százalékpontos különbség) változatlan.
 *
 * Elvek:
 *  - Érvénytelen bemenetből nincs „becsült” érték: az eredmény `{ ok: false, reason }`.
 *  - Árrésmentesítés CSAK egyetlen irodától, egyetlen megfigyelésből származó, TELJES kimenetelkészletre.
 *    Módszer: arányos (multiplikatív) normalizálás, p_i = (1/o_i) / Σ(1/o_j). Ez egy egyszerű,
 *    elterjedt közelítés – az eredmény NEM „a valódi piaci valószínűség”: a hosszú esélyű
 *    kimenetelek árrés-terhét (favourite–longshot torzítás) nem kezeli külön.
 *  - EV = p·o − 1 (egységnyi tétre) CSAK visszatérítés (push) nélküli piacokon. A DNB és az ázsiai
 *    hendikep visszatérítéses elszámolású, ezért általános EV-t nem kapnak.
 *  - A modell valószínűségének kalibrációja NEM igazolt; az EV itt csak számítási alap, nem állítás.
 */
import type { MatchOdds, MatchStatus } from '../types';

export type EdgeUnavailable = { ok: false; reason: EdgeReason };
export type EdgeReason =
  | 'invalid_odds' | 'invalid_probability' | 'missing_outcome' | 'mixed_bookmakers' | 'unknown_bookmaker'
  | 'mixed_observations' | 'unknown_observation' | 'overround_out_of_range' | 'line_mismatch'
  | 'market_not_supported' | 'not_prematch' | 'observed_in_play' | 'observed_after_kickoff'
  | 'kickoff_passed' | 'stale' | 'observed_in_future' | 'invalid_time';

/** Elfogadott tizedes odds: véges, > 1 és legfeljebb ennyi (az irreális értékek kiszűrésére). */
export const MAX_DECIMAL_ODDS = 1000;

/** Érvényes tizedes odds-e. */
export function validOdds(odds: unknown): odds is number {
  return typeof odds === 'number' && Number.isFinite(odds) && odds > 1 && odds <= MAX_DECIMAL_ODDS;
}

/** Nyers implikált valószínűség (1 / odds, árréssel együtt). Érvénytelen odds → null. */
export function rawImplied(odds: unknown): number | null {
  return validOdds(odds) ? 1 / odds : null;
}

/** Egy kimenetel ára a megfigyelés eredetével (iroda + megfigyelési idő). */
export interface OddsQuote {
  odds: number;
  /** a fogadóiroda azonosító neve; üres/hiányzó → nem igazolható */
  bookmaker: string | null | undefined;
  /** a forrás-megfigyelés ideje (ISO); hiányzó → nem igazolható */
  observedAt: string | null | undefined;
}

export interface DevigOptions {
  /** az elfogadott árrés (Σ 1/odds) alsó és felső határa – alapból 1,00 … 1,25 */
  minOverround?: number;
  maxOverround?: number;
}

export interface DevigResult<K extends string> {
  ok: true;
  method: 'proportional';
  /** Σ 1/odds (pl. 1,065 = 6,5% árrés) */
  overround: number;
  /** árrésmentesített valószínűségek (összegük 1) – közelítés, nem a „valódi” piaci valószínűség */
  probs: Record<K, number>;
  bookmaker: string;
  observedAt: string;
}

const DEFAULT_MIN_OVERROUND = 1.0;
const DEFAULT_MAX_OVERROUND = 1.25;

/**
 * Egy piac ára a MatchOdds-ból. Irodát és megfigyelési időt CSAK akkor ad, ha az odds igazoltan
 * egyetlen iroda egyetlen megfigyeléséből származik (`observation.singleBook`) – a kézi, az
 * összefésült („legjobb odds”) és az eredet nélküli oddsnál ezek üresek, így az árrésmentesítés
 * `unavailable` lesz. Nincs ilyen piac → null.
 */
export function quoteFrom(odds: MatchOdds | null | undefined, market: string): OddsQuote | null {
  const o = odds?.markets?.[market];
  if (o == null || !odds) return null;
  const obs = odds.observation;
  // az ár egyazon megfigyelés AKTUÁLIS vonalából jön-e: ahol a forrás közli a vonal fajtáját
  // (ESPN: priceKind), csak 'close' fogadható el; ESPN-forrásnál a jelölés hiánya sem elég
  const lineOk = obs?.priceKind ? obs.priceKind[market] === 'close' : !(obs?.via ?? '').startsWith('espn');
  const verified = obs?.singleBook === true && lineOk;
  return { odds: o, bookmaker: verified ? odds.bookmakers?.[market] ?? odds.bookmaker ?? null : null, observedAt: verified ? odds.observedAt ?? null : null };
}

/** Közös ellenőrzés: teljes készlet, érvényes odds, egy iroda, egy megfigyelés, elfogadható árrés. */
function devig<K extends string>(quotes: Record<K, OddsQuote | null | undefined>, opts: DevigOptions): DevigResult<K> | EdgeUnavailable {
  const keys = Object.keys(quotes) as K[];
  const list = keys.map((k) => quotes[k]);
  if (list.some((q) => !q)) return { ok: false, reason: 'missing_outcome' };
  const qs = list as OddsQuote[];
  if (qs.some((q) => !validOdds(q.odds))) return { ok: false, reason: 'invalid_odds' };
  const books = qs.map((q) => (typeof q.bookmaker === 'string' ? q.bookmaker.trim() : ''));
  if (books.some((b) => !b)) return { ok: false, reason: 'unknown_bookmaker' };
  if (new Set(books).size !== 1) return { ok: false, reason: 'mixed_bookmakers' };
  const times = qs.map((q) => (typeof q.observedAt === 'string' ? Date.parse(q.observedAt) : NaN));
  if (times.some((t) => !Number.isFinite(t))) return { ok: false, reason: 'unknown_observation' };
  if (new Set(times).size !== 1) return { ok: false, reason: 'mixed_observations' };
  const inv = qs.map((q) => 1 / q.odds);
  const overround = inv.reduce((a, b) => a + b, 0);
  const min = opts.minOverround ?? DEFAULT_MIN_OVERROUND, max = opts.maxOverround ?? DEFAULT_MAX_OVERROUND;
  if (!(overround >= min && overround <= max)) return { ok: false, reason: 'overround_out_of_range' };
  const probs = Object.fromEntries(keys.map((k, i) => [k, inv[i] / overround])) as Record<K, number>;
  return { ok: true, method: 'proportional', overround, probs, bookmaker: books[0], observedAt: new Date(times[0]).toISOString() };
}

/** 1X2 árrésmentesítés – csak egyetlen iroda, egyetlen megfigyelés, mindhárom kimenetel. */
export function devig1x2(q: { home?: OddsQuote | null; draw?: OddsQuote | null; away?: OddsQuote | null }, opts: DevigOptions = {}): DevigResult<'home' | 'draw' | 'away'> | EdgeUnavailable {
  return devig({ home: q.home, draw: q.draw, away: q.away }, opts);
}

/** Gólszám (O/U) árrésmentesítés – ugyanaz a vonal, egy iroda, egy megfigyelés, mindkét oldal. */
export function devigTwoWay(q: { over?: (OddsQuote & { line: number }) | null; under?: (OddsQuote & { line: number }) | null }, opts: DevigOptions = {}): DevigResult<'over' | 'under'> | EdgeUnavailable {
  if (q.over && q.under && !(Number.isFinite(q.over.line) && q.over.line === q.under.line)) return { ok: false, reason: 'line_mismatch' };
  return devig({ over: q.over, under: q.under }, opts);
}

/**
 * Általános EV-t kapó (visszatérítés nélküli) piacok – explicit lista. NEM szerepel: DNB_1/DNB_2
 * (döntetlennél visszajár a tét; a modell DNB-valószínűsége ráadásul feltételes) és az ázsiai
 * hendikep (AH_*: egész vonalon visszatérítés).
 */
const EV_FIXED = new Set(['1', 'X', '2', '1X', 'X2', '12', 'BTTS_Y', 'BTTS_N', 'HOME_O0.5', 'HOME_O1.5', 'AWAY_O0.5', 'AWAY_O1.5']);
export function evSupported(market: string): boolean {
  return EV_FIXED.has(market) || /^[OU]\d\.5$/.test(market);
}

/** Várható nettó hozam egységnyi tétre: p·o − 1. Csak támogatott piacon, érvényes p-vel és odds-szal. */
export function ev(p: unknown, odds: unknown, market: string): { ok: true; ev: number } | EdgeUnavailable {
  if (!evSupported(market)) return { ok: false, reason: 'market_not_supported' };
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return { ok: false, reason: 'invalid_probability' };
  if (!validOdds(odds)) return { ok: false, reason: 'invalid_odds' };
  return { ok: true, ev: p * odds - 1 };
}

export interface FreshnessInput {
  /** a forrás-megfigyelés ideje (MatchOdds.observedAt); hiányzik → nem igazolható */
  observedAt: string | null | undefined;
  /** a mérkőzés állapota a megfigyeléskor (MatchOdds.observation.matchStatus); hiányzik → nem igazolható */
  observedStatus: MatchStatus | null | undefined;
  /** a mérkőzés JELENLEGI állapota és kezdése */
  matchStatus: MatchStatus;
  kickoff: string;
  /** „most” (determinisztikus tesztekhez kívülről) */
  now: string | number | Date;
  /** a megfigyelés legnagyobb elfogadott kora (alapból 60 perc) */
  maxAgeMs?: number;
}

/**
 * Pre-match frissesség: a meccs még nem kezdődött el és tervezett; az oddsot tervezett állapotban,
 * a kezdés ELŐTT figyeltük meg; és a megfigyelés nem régebbi `maxAgeMs`-nál. A megfigyelési idő a
 * SAJÁT forrás-lekérésünk ideje – azt igazolja, hogy az odds legkésőbb ekkor így állt, nem azt, hogy
 * mikor változott.
 */
export function checkFreshness(i: FreshnessInput): { ok: true; ageMs: number } | EdgeUnavailable {
  const now = i.now instanceof Date ? i.now.getTime() : typeof i.now === 'number' ? i.now : Date.parse(i.now);
  const kickoff = Date.parse(i.kickoff);
  if (!Number.isFinite(now) || !Number.isFinite(kickoff)) return { ok: false, reason: 'invalid_time' };
  if (i.matchStatus !== 'scheduled') return { ok: false, reason: 'not_prematch' };
  if (now >= kickoff) return { ok: false, reason: 'kickoff_passed' };
  if (typeof i.observedAt !== 'string') return { ok: false, reason: 'unknown_observation' };
  const observed = Date.parse(i.observedAt);
  if (!Number.isFinite(observed)) return { ok: false, reason: 'unknown_observation' };
  if (!i.observedStatus) return { ok: false, reason: 'unknown_observation' };
  if (i.observedStatus !== 'scheduled') return { ok: false, reason: 'observed_in_play' };
  if (observed >= kickoff) return { ok: false, reason: 'observed_after_kickoff' };
  if (observed > now) return { ok: false, reason: 'observed_in_future' };
  const ageMs = now - observed;
  if (ageMs > (i.maxAgeMs ?? 60 * 60_000)) return { ok: false, reason: 'stale' };
  return { ok: true, ageMs };
}
