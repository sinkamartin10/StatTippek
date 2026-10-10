/**
 * Modell-tipp archívum tárolója – a 0014 `model_tip_archive` és
 * `model_tip_archive_match_state` tábláján.
 *
 *  - PostgresTipArchiveStore : éles; service_role kulccsal (a kliens kulcsoknak
 *    az RLS és a visszavont jogok miatt semmilyen hozzáférése nincs),
 *  - SqliteTipArchiveStore   : helyi futtatás és tesztek, azonos szerződéssel
 *    (ugyanazok a megszorítások, triggerek és nézetek SQLite-megfelelője).
 *
 * A verziók egyediségét a (match_id, market, version_no) UNIQUE kulcs adja, a
 * beszúrás `on conflict do nothing` – két párhuzamos számolásból sem lesz
 * ugyanazzal a sorszámmal két sor. Az elszámolás feltételes (`where
 * settlement_status = 'pending'`), ezért az ismételt futás nem ír át semmit.
 *
 * NYILVÁNOSSÁG: a lista és az összesítés KIZÁRÓLAG a `*_listing` nézeteken át
 * olvas, amelyek a meccs AKTUÁLIS megfigyelt állapotát is hozzák (inner join).
 * A láthatósági feltétel (`match_status in (live, finished)` és
 * `current_kickoff < most`) minden ilyen lekérdezésre ugyanabban a függvényben
 * kerül rá – külön útvonal nem kerülheti meg.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { DataOrigin, DataQualityLevel, TipCategory } from '../../shared/types';
import type { SettlementStatus, TipAvailability } from '../../shared/tipArchive';

/** Beszúrandó verzió – a tipp a generálás pillanatában. */
export interface ArchiveDraft {
  matchId: string;
  market: string;
  versionNo: number;
  contentHash: string;
  engineVersion: string;
  generatedAt: string;
  origin: DataOrigin;
  matchLabel: string;
  leagueId: string;
  leagueName: string;
  /** a GENERÁLÁSKOR ismert kezdés – audit, nyilvánosan nem adjuk ki */
  kickoff: string;
  marketLabel: string;
  marketType: string;
  category: TipCategory;
  modelProb: number;
  odds: number | null;
  impliedProb: number | null;
  dataQuality: DataQualityLevel;
  sampleSize: number;
  supportingIndicators: number;
  preKickoff: boolean;
  availability: TipAvailability;
  /**
   * A felhasználónak TÉNYLEGESEN kiszolgált valószínűség és az azt előállító
   * modell (0016). Az alap motor kiszolgálásakor `servedModel` = engine_version
   * és `servedProb` = `modelProb` (a DB is kikényszeríti). Az új sorok
   * provenance-a mindig 'recorded'.
   */
  servedProb: number;
  servedModel: string;
}

/** A valószínűség eredete: rögzített, vagy a rögzítés bevezetése előtti (régi) sor. */
export type Provenance = 'recorded' | 'legacy_baseline';

/** A meccs megfigyelt állapota. */
export type ObservedStatus = 'scheduled' | 'live' | 'finished' | 'postponed';

/** Tárolt sor (belső forma – a nyilvános API ennél szűkebbet ad ki). */
export interface ArchiveRow extends Omit<ArchiveDraft, 'servedProb' | 'servedModel'> {
  provenance: Provenance | null;
  servedProb: number | null;
  servedModel: string | null;
  id: string;
  archiveVisible: boolean;
  status: SettlementStatus;
  homeGoals: number | null;
  awayGoals: number | null;
  resultKickoff: string | null;
  settledAt: string | null;
  /** a meccs AKTUÁLIS, hitelesen megfigyelt kezdése (a listázó nézetekből) */
  currentKickoff: string;
  matchStatus: ObservedStatus;
}

/** Egy piac legutolsó (legnagyobb sorszámú) verziója. */
export interface LatestVersion {
  versionNo: number;
  contentHash: string;
  generatedAt: string;
}

export interface MatchObservation {
  matchId: string;
  kickoff: string;
  status: ObservedStatus;
  observedAt: string;
}

/** Szűrés – a lista és az összesítés UGYANEZT kapja. */
export interface ArchiveFilter {
  origin: DataOrigin;
  /**
   * Láthatósági határ (a szerver órája). Csak azok a meccsek jelennek meg,
   * amelyek AKTUÁLIS állapota live/finished ÉS aktuális kezdése ennél korábbi.
   */
  visibleBefore: string;
  /** aktuális kezdés >= from (ISO) */
  from?: string;
  /** aktuális kezdés < to (ISO, kizáró) */
  to?: string;
  leagueId?: string;
  marketType?: string;
  status?: SettlementStatus;
  availability?: TipAvailability;
  /** tisztított csapatnév-töredék */
  search?: string;
}

export type ArchiveScope = 'all' | 'counted';

export interface StatusCounts {
  won: number; lost: number; void: number; pending: number; unsupported: number;
}

export interface SettleInput {
  matchId: string;
  homeGoals: number;
  awayGoals: number;
  resultKickoff: string;
  settledAt: string;
  /** piaconkénti kimenet – a meglévő evaluateMarket() eredményéből */
  outcomes: { market: string; status: Exclude<SettlementStatus, 'pending'> }[];
}

/** A nyilvánosan látható meccs-állapotok. */
export const VISIBLE_STATUSES: ObservedStatus[] = ['live', 'finished'];

export interface TipArchiveStore {
  /** Piaconként a legutolsó verzió sorszáma és tartalom-hash-e. */
  latestVersions(matchId: string): Promise<Map<string, LatestVersion>>;
  /** A meccs jelenleg tárolt (megfigyelt) állapota, ha van. */
  matchState(matchId: string): Promise<MatchObservation | null>;
  /**
   * Archivált, de ÁLLAPOT NÉLKÜLI meccsek (pl. régebbi kód vagy félbemaradt
   * írás nyoma), a generáláskori kezdés szerint legfrissebb elöl, korlátozott
   * számban – a frissítési kör ezeket is újrapróbálja.
   */
  orphanMatchIds(kickoffBefore: string, kickoffAfter: string, limit: number, offset?: number): Promise<string[]>;
  /** Verziók beszúrása; a már létező (match, piac, sorszám) kimarad. Visszaadja a TÉNYLEGESEN beszúrt piacokat. */
  insertVersions(rows: ArchiveDraft[]): Promise<string[]>;
  /** A meccs megfigyelt állapotának rögzítése; régebbi megfigyelés nem írja felül az újabbat. */
  observeMatch(o: MatchObservation): Promise<void>;
  /**
   * Frissítendő meccsek: még nem `finished`, és az aktuális kezdés már elmúlt.
   * A LEGRÉGEBBEN megfigyelt elöl (stabil másodlagos kulccsal), lapozhatóan –
   * így a régóta nem ellenőrzött meccs nem szorulhat ki tartósan.
   */
  dueMatchIds(kickoffBefore: string, kickoffAfter: string, limit: number, offset?: number): Promise<string[]>;
  /** Egy meccs függő piacai. */
  pendingMarkets(matchId: string): Promise<string[]>;
  /** Feltételes lezárás: csak a még függő sorokat írja. Visszaadja a lezárt sorok számát. */
  settle(input: SettleInput): Promise<number>;
  /** Lapozott lista, stabil sorrendben – csak a látható meccsekből. */
  list(filter: ArchiveFilter, scope: ArchiveScope, offset: number, limit: number): Promise<{ rows: ArchiveRow[]; total: number }>;
  /** A megadott meccsek statisztikába számító sorainak azonosítói. */
  countedIds(matchIds: string[]): Promise<Set<string>>;
  /** Archív sorok száma (minden verzió) + a számító sorok állapot szerinti bontása – csak a látható meccsekből. */
  summary(filter: ArchiveFilter): Promise<{ records: number; counted: StatusCounts }>;
  /** A legkorábbi rögzített tipp ideje. */
  coverageStart(origin: DataOrigin): Promise<string | null>;
  healthCheck(): Promise<string[]>;
}

const STATUSES: SettlementStatus[] = ['won', 'lost', 'void', 'pending', 'unsupported'];

// ===========================================================================
// PostgreSQL / PostgREST
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgRow = any;

const TABLE = 'model_tip_archive';
const STATE = 'model_tip_archive_match_state';
const COUNTED = 'model_tip_archive_counted';
const LISTING = 'model_tip_archive_listing';
const COUNTED_LISTING = 'model_tip_archive_counted_listing';

function pgToRow(r: PgRow): ArchiveRow {
  return {
    id: r.id,
    matchId: r.match_id,
    market: r.market,
    versionNo: Number(r.version_no),
    contentHash: r.content_hash,
    engineVersion: r.engine_version,
    generatedAt: new Date(r.generated_at).toISOString(),
    origin: r.origin,
    matchLabel: r.match_label,
    leagueId: r.league_id,
    leagueName: r.league_name,
    kickoff: new Date(r.kickoff).toISOString(),
    marketLabel: r.market_label,
    marketType: r.market_type,
    category: r.category,
    modelProb: Number(r.model_prob),
    odds: r.odds_at_generation == null ? null : Number(r.odds_at_generation),
    impliedProb: r.implied_prob == null ? null : Number(r.implied_prob),
    dataQuality: r.data_quality,
    sampleSize: Number(r.sample_size),
    supportingIndicators: Number(r.supporting_indicators),
    preKickoff: !!r.pre_kickoff,
    availability: r.availability,
    archiveVisible: !!r.archive_visible,
    status: r.settlement_status,
    homeGoals: r.home_goals == null ? null : Number(r.home_goals),
    awayGoals: r.away_goals == null ? null : Number(r.away_goals),
    resultKickoff: r.result_kickoff ? new Date(r.result_kickoff).toISOString() : null,
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    currentKickoff: new Date(r.current_kickoff).toISOString(),
    matchStatus: r.match_status,
    // a listázó nézetek (0014) nem tartalmazzák – ott null
    provenance: r.provenance ?? null,
    servedProb: r.served_prob == null ? null : Number(r.served_prob),
    servedModel: r.served_model ?? null,
  };
}

function draftToPg(d: ArchiveDraft): PgRow {
  return {
    match_id: d.matchId,
    market: d.market,
    version_no: d.versionNo,
    content_hash: d.contentHash,
    engine_version: d.engineVersion,
    generated_at: d.generatedAt,
    origin: d.origin,
    match_label: d.matchLabel,
    league_id: d.leagueId,
    league_name: d.leagueName,
    kickoff: d.kickoff,
    market_label: d.marketLabel,
    market_type: d.marketType,
    category: d.category,
    model_prob: d.modelProb,
    odds_at_generation: d.odds,
    implied_prob: d.impliedProb,
    data_quality: d.dataQuality,
    sample_size: d.sampleSize,
    supporting_indicators: d.supportingIndicators,
    pre_kickoff: d.preKickoff,
    availability: d.availability,
    provenance: 'recorded',
    served_prob: d.servedProb,
    served_model: d.servedModel,
  };
}

export class PostgresTipArchiveStore implements TipArchiveStore {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[tip-archive] ${op}: ${error.message}`);
  }

  /** A PostgREST hiányzó táblára `count: null`-t ad hiba nélkül – ezt hibának vesszük. */
  private countOf(op: string, count: number | null): number {
    if (count == null) throw new Error(`[tip-archive] ${op}: a számlálás nem adott eredményt (hiányzó tábla vagy séma-hiba?)`);
    return count;
  }

  /**
   * A nyilvános szűrés – a láthatósági feltétel itt, MINDEN listázó és
   * összesítő lekérdezésre kötelezően rákerül.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyFilter<Q extends { eq: any; lt: any; gte: any; ilike: any; in: any }>(q: Q, f: ArchiveFilter): Q {
    let x = q.eq('origin', f.origin).eq('archive_visible', true)
      .in('match_status', VISIBLE_STATUSES).lt('current_kickoff', f.visibleBefore);
    if (f.from) x = x.gte('current_kickoff', f.from);
    if (f.to) x = x.lt('current_kickoff', f.to);
    if (f.leagueId) x = x.eq('league_id', f.leagueId);
    if (f.marketType) x = x.eq('market_type', f.marketType);
    if (f.status) x = x.eq('settlement_status', f.status);
    if (f.availability) x = x.eq('availability', f.availability);
    // a keresés tisztított (nincs benne % _ , ( ) karakter) – lásd sanitizeSearch
    if (f.search) x = x.ilike('match_label', `%${f.search}%`);
    return x;
  }

  async latestVersions(matchId: string) {
    const { data, error } = await this.db.from(TABLE).select('market, version_no, content_hash, generated_at')
      .eq('match_id', matchId).order('version_no', { ascending: false }).limit(1000);
    this.fail('latestVersions', error);
    const out = new Map<string, LatestVersion>();
    for (const r of (data ?? []) as PgRow[]) {
      if (!out.has(r.market)) {
        out.set(r.market, {
          versionNo: Number(r.version_no), contentHash: r.content_hash, generatedAt: new Date(r.generated_at).toISOString(),
        });
      }
    }
    return out;
  }

  async matchState(matchId: string): Promise<MatchObservation | null> {
    const { data, error } = await this.db.from(STATE).select('current_kickoff, match_status, observed_at')
      .eq('match_id', matchId).maybeSingle();
    this.fail('matchState', error);
    if (!data) return null;
    const r = data as PgRow;
    return {
      matchId,
      kickoff: new Date(r.current_kickoff).toISOString(),
      status: r.match_status,
      observedAt: new Date(r.observed_at).toISOString(),
    };
  }

  async orphanMatchIds(kickoffBefore: string, kickoffAfter: string, limit: number, offset = 0): Promise<string[]> {
    // PostgREST-ben nincs anti-join: a legfrissebb, kötött számú archív sor
    // meccseit vetjük össze az állapottáblával (2 kötött lekérdezés).
    const { data, error } = await this.db.from(TABLE).select('match_id')
      .lt('kickoff', kickoffBefore).gte('kickoff', kickoffAfter)
      .order('kickoff', { ascending: false }).order('match_id', { ascending: true }).limit(1000);
    this.fail('orphanMatchIds', error);
    const ids = [...new Set(((data ?? []) as PgRow[]).map((r) => String(r.match_id)))];
    if (!ids.length) return [];
    const st = await this.db.from(STATE).select('match_id').in('match_id', ids);
    this.fail('orphanMatchIds.state', st.error);
    const known = new Set(((st.data ?? []) as PgRow[]).map((r) => String(r.match_id)));
    return ids.filter((id) => !known.has(id)).slice(offset, offset + limit);
  }

  async insertVersions(rows: ArchiveDraft[]): Promise<string[]> {
    if (!rows.length) return [];
    const { data, error } = await this.db.from(TABLE)
      .upsert(rows.map(draftToPg), { onConflict: 'match_id,market,version_no', ignoreDuplicates: true })
      .select('market');
    this.fail('insertVersions', error);
    return ((data ?? []) as PgRow[]).map((r) => String(r.market));
  }

  async observeMatch(o: MatchObservation): Promise<void> {
    const { error } = await this.db.rpc('model_tip_archive_observe', {
      p_match_id: o.matchId, p_kickoff: o.kickoff, p_status: o.status, p_observed_at: o.observedAt,
    });
    this.fail('observeMatch', error);
  }

  async dueMatchIds(kickoffBefore: string, kickoffAfter: string, limit: number, offset = 0): Promise<string[]> {
    const { data, error } = await this.db.from(STATE).select('match_id')
      .neq('match_status', 'finished').lt('current_kickoff', kickoffBefore).gte('current_kickoff', kickoffAfter)
      .order('observed_at', { ascending: true }).order('match_id', { ascending: true })
      .range(offset, offset + limit - 1);
    this.fail('dueMatchIds', error);
    return ((data ?? []) as PgRow[]).map((r) => String(r.match_id));
  }

  async pendingMarkets(matchId: string): Promise<string[]> {
    const { data, error } = await this.db.from(TABLE).select('market')
      .eq('match_id', matchId).eq('settlement_status', 'pending').limit(1000);
    this.fail('pendingMarkets', error);
    return [...new Set(((data ?? []) as PgRow[]).map((r) => r.market as string))];
  }

  async settle(input: SettleInput): Promise<number> {
    let n = 0;
    // Kimenet szerint csoportosítva: legfeljebb 4 feltételes UPDATE meccsenként
    const groups = new Map<string, string[]>();
    for (const o of input.outcomes) groups.set(o.status, [...(groups.get(o.status) ?? []), o.market]);
    for (const [status, markets] of groups) {
      const { data, error } = await this.db.from(TABLE).update({
        settlement_status: status,
        home_goals: input.homeGoals,
        away_goals: input.awayGoals,
        result_kickoff: input.resultKickoff,
        settled_at: input.settledAt,
      }).eq('match_id', input.matchId).eq('settlement_status', 'pending').in('market', markets).select('id');
      this.fail('settle', error);
      n += (data ?? []).length;
    }
    return n;
  }

  async list(filter: ArchiveFilter, scope: ArchiveScope, offset: number, limit: number) {
    const q = this.applyFilter(this.db.from(scope === 'counted' ? COUNTED_LISTING : LISTING).select('*', { count: 'exact' }), filter)
      // Stabil sorrend: (match_id, market, version_no) egyedi → determinisztikus
      .order('current_kickoff', { ascending: false })
      .order('match_id', { ascending: true })
      .order('market', { ascending: true })
      .order('version_no', { ascending: false })
      .range(offset, offset + limit - 1);
    const { data, error, count } = await q;
    this.fail('list', error);
    return { rows: ((data ?? []) as PgRow[]).map(pgToRow), total: this.countOf('list', count) };
  }

  async countedIds(matchIds: string[]): Promise<Set<string>> {
    if (!matchIds.length) return new Set();
    // match_id a DISTINCT ON kulcs része, így a szűrés a nézet alá is lejut
    const { data, error } = await this.db.from(COUNTED).select('id').in('match_id', matchIds);
    this.fail('countedIds', error);
    return new Set(((data ?? []) as PgRow[]).map((r) => r.id as string));
  }

  async summary(filter: ArchiveFilter) {
    const head = (from: string, f: ArchiveFilter) =>
      this.applyFilter(this.db.from(from).select('id', { count: 'exact', head: true }), f);
    const [records, ...byStatus] = await Promise.all([
      head(LISTING, filter),
      // Az állapotszűrő a nézetre is ugyanúgy vonatkozik: a nem egyező állapot 0 lesz
      ...STATUSES.map((s) => (filter.status && filter.status !== s
        ? Promise.resolve({ count: 0, error: null })
        : head(COUNTED_LISTING, { ...filter, status: s }))),
    ]);
    this.fail('summary.records', records.error);
    const counted = {} as StatusCounts;
    STATUSES.forEach((s, i) => {
      this.fail(`summary.${s}`, byStatus[i].error);
      counted[s] = this.countOf(`summary.${s}`, byStatus[i].count);
    });
    return { records: this.countOf('summary.records', records.count), counted };
  }

  async coverageStart(origin: DataOrigin): Promise<string | null> {
    const { data, error } = await this.db.from(TABLE).select('generated_at')
      .eq('origin', origin).order('generated_at', { ascending: true }).limit(1);
    this.fail('coverageStart', error);
    const r = (data ?? [])[0] as PgRow | undefined;
    return r ? new Date(r.generated_at).toISOString() : null;
  }

  async healthCheck(): Promise<string[]> {
    const missing: string[] = [];
    for (const [t, col] of [[TABLE, 'id'], [STATE, 'match_id'], [COUNTED, 'id'], [LISTING, 'id'], [COUNTED_LISTING, 'id']]) {
      const { error, count } = await this.db.from(t).select(col, { count: 'exact', head: true }).limit(1);
      if (error || count == null) missing.push(t);
    }
    // 0016: az eredet-oszlopok nélkül minden új rögzítés elbukna – külön jelezzük
    const prov = await this.db.from(TABLE).select('provenance, served_prob, served_model', { count: 'exact', head: true }).limit(1);
    if (prov.error || prov.count == null) missing.push('model_tip_archive.provenance (0016)');
    return missing;
  }
}

// ===========================================================================
// SQLite (helyi fejlesztés / tesztek)
// ===========================================================================

type SqlRow = Record<string, unknown>;

function sqlToRow(r: SqlRow): ArchiveRow {
  return {
    id: String(r.id),
    matchId: String(r.match_id),
    market: String(r.market),
    versionNo: Number(r.version_no),
    contentHash: String(r.content_hash),
    engineVersion: String(r.engine_version),
    generatedAt: String(r.generated_at),
    origin: r.origin as DataOrigin,
    matchLabel: String(r.match_label),
    leagueId: String(r.league_id),
    leagueName: String(r.league_name),
    kickoff: String(r.kickoff),
    marketLabel: String(r.market_label),
    marketType: String(r.market_type),
    category: r.category as TipCategory,
    modelProb: Number(r.model_prob),
    odds: r.odds_at_generation == null ? null : Number(r.odds_at_generation),
    impliedProb: r.implied_prob == null ? null : Number(r.implied_prob),
    dataQuality: r.data_quality as DataQualityLevel,
    sampleSize: Number(r.sample_size),
    supportingIndicators: Number(r.supporting_indicators),
    preKickoff: Number(r.pre_kickoff) === 1,
    availability: r.availability as TipAvailability,
    archiveVisible: Number(r.archive_visible) === 1,
    status: r.settlement_status as SettlementStatus,
    homeGoals: r.home_goals == null ? null : Number(r.home_goals),
    awayGoals: r.away_goals == null ? null : Number(r.away_goals),
    resultKickoff: r.result_kickoff == null ? null : String(r.result_kickoff),
    settledAt: r.settled_at == null ? null : String(r.settled_at),
    currentKickoff: String(r.current_kickoff),
    matchStatus: r.match_status as ObservedStatus,
    provenance: (r.provenance as Provenance | undefined) ?? null,
    servedProb: r.served_prob == null ? null : Number(r.served_prob),
    servedModel: r.served_model == null ? null : String(r.served_model),
  };
}

/** A tipp-mezők – ezeket a trigger védi a felülírástól (a 0014 megfelelője). */
const IMMUTABLE = [
  'id', 'match_id', 'market', 'version_no', 'content_hash', 'engine_version', 'generated_at', 'origin',
  'match_label', 'league_id', 'league_name', 'kickoff', 'market_label', 'market_type', 'category',
  'model_prob', 'odds_at_generation', 'implied_prob', 'data_quality', 'sample_size',
  'supporting_indicators', 'pre_kickoff',
  // 0016: a valószínűség eredete is megváltoztathatatlan
  'provenance', 'served_prob', 'served_model',
];

/** A 0016 provenance-szabálya (a PostgreSQL CHECK megfelelője). */
const PROVENANCE_RULE = `(
  (new.provenance = 'legacy_baseline' AND new.served_prob IS NULL AND new.served_model IS NULL)
  OR (new.provenance = 'recorded'
      AND new.served_prob IS NOT NULL AND new.served_prob >= 0 AND new.served_prob <= 1
      AND new.served_model IS NOT NULL
      AND (new.served_model = new.engine_version
           OR (substr(new.served_model, 1, length(new.engine_version) + 5) = new.engine_version || '+cal-'
               AND length(new.served_model) = length(new.engine_version) + 17
               AND substr(new.served_model, length(new.engine_version) + 6) GLOB '${'[0-9a-f]'.repeat(12)}'))
      AND (new.served_model <> new.engine_version OR new.served_prob = new.model_prob))
)`;
const SETTLEMENT = ['settlement_status', 'home_goals', 'away_goals', 'result_kickoff', 'settled_at'];

export class SqliteTipArchiveStore implements TipArchiveStore {
  constructor(private db: DatabaseSync) {
    this.upgradeLegacyTable();
    // A 0014 + 0016 megfelelője: azonos megszorítások, triggerek és nézetek.
    // Az időpontok mindig `toISOString()` alakúak, így a szöveges összevetés időrendi.
    // SQLite-ban nincs TRUNCATE: a feltétel nélküli DELETE is a sor-triggeren akad el.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_tip_archive (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        market TEXT NOT NULL,
        version_no INTEGER NOT NULL CHECK (version_no >= 1),
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        engine_version TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('demo', 'live')),
        match_label TEXT NOT NULL,
        league_id TEXT NOT NULL,
        league_name TEXT NOT NULL,
        kickoff TEXT NOT NULL,
        market_label TEXT NOT NULL,
        market_type TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('konzervatív', 'mérsékelt', 'magas variancia')),
        model_prob REAL NOT NULL CHECK (model_prob >= 0 AND model_prob <= 1),
        odds_at_generation REAL CHECK (odds_at_generation IS NULL OR odds_at_generation > 1),
        implied_prob REAL CHECK (implied_prob IS NULL OR (implied_prob >= 0 AND implied_prob <= 1)),
        data_quality TEXT NOT NULL CHECK (data_quality IN ('magas', 'közepes', 'kevés')),
        sample_size INTEGER NOT NULL CHECK (sample_size >= 0),
        supporting_indicators INTEGER NOT NULL CHECK (supporting_indicators >= 0),
        pre_kickoff INTEGER NOT NULL CHECK (pre_kickoff = (generated_at < kickoff)),
        availability TEXT NOT NULL DEFAULT 'pro_on_request' CHECK (availability IN ('pro_on_request', 'not_published')),
        archive_visible INTEGER NOT NULL DEFAULT 1,
        settlement_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (settlement_status IN ('pending', 'won', 'lost', 'void', 'unsupported')),
        home_goals INTEGER,
        away_goals INTEGER,
        result_kickoff TEXT,
        settled_at TEXT,
        provenance TEXT NOT NULL DEFAULT 'legacy_baseline' CHECK (provenance IN ('legacy_baseline', 'recorded')),
        served_prob REAL,
        served_model TEXT,
        UNIQUE (match_id, market, version_no),
        CHECK (
          (settlement_status = 'pending' AND home_goals IS NULL AND away_goals IS NULL AND settled_at IS NULL AND result_kickoff IS NULL)
          OR (settlement_status <> 'pending' AND home_goals IS NOT NULL AND away_goals IS NOT NULL AND settled_at IS NOT NULL
              AND home_goals >= 0 AND away_goals >= 0)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_model_tip_archive_kickoff ON model_tip_archive(kickoff DESC, match_id, market, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_model_tip_archive_match_market ON model_tip_archive(match_id, market, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_model_tip_archive_pending ON model_tip_archive(kickoff) WHERE settlement_status = 'pending';

      CREATE TABLE IF NOT EXISTS model_tip_archive_match_state (
        match_id TEXT PRIMARY KEY,
        current_kickoff TEXT NOT NULL,
        match_status TEXT NOT NULL CHECK (match_status IN ('scheduled', 'live', 'finished', 'postponed')),
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_tip_archive_match_state_due
        ON model_tip_archive_match_state(current_kickoff DESC) WHERE match_status <> 'finished';

      DROP TRIGGER IF EXISTS model_tip_archive_guard_tip;
      CREATE TRIGGER model_tip_archive_guard_tip
      BEFORE UPDATE ON model_tip_archive
      WHEN ${IMMUTABLE.map((c) => `old.${c} IS NOT new.${c}`).join(' OR ')}
      BEGIN SELECT RAISE(ABORT, 'model_tip_archive: a rögzített tipp nem módosítható'); END;

      CREATE TRIGGER IF NOT EXISTS model_tip_archive_provenance_check
      BEFORE INSERT ON model_tip_archive
      WHEN NOT ${PROVENANCE_RULE}
      BEGIN SELECT RAISE(ABORT, 'model_tip_archive: érvénytelen valószínűség-eredet (provenance)'); END;

      CREATE TRIGGER IF NOT EXISTS model_tip_archive_guard_settled
      BEFORE UPDATE ON model_tip_archive
      WHEN old.settlement_status <> 'pending' AND (${SETTLEMENT.map((c) => `old.${c} IS NOT new.${c}`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT, 'model_tip_archive: a lezárt tipp eredménye nem írható át'); END;

      CREATE TRIGGER IF NOT EXISTS model_tip_archive_no_delete
      BEFORE DELETE ON model_tip_archive
      BEGIN SELECT RAISE(ABORT, 'model_tip_archive: az archívum sorai nem törölhetők (DELETE)'); END;

      CREATE TRIGGER IF NOT EXISTS model_tip_archive_match_state_no_delete
      BEFORE DELETE ON model_tip_archive_match_state
      BEGIN SELECT RAISE(ABORT, 'model_tip_archive: az archívum sorai nem törölhetők (DELETE)'); END;

      CREATE VIEW IF NOT EXISTS model_tip_archive_counted AS
      SELECT * FROM (
        SELECT a.*, ROW_NUMBER() OVER (
          PARTITION BY match_id, market ORDER BY generated_at DESC, version_no DESC
        ) AS rn
        FROM model_tip_archive a
        WHERE pre_kickoff = 1 AND (result_kickoff IS NULL OR generated_at < result_kickoff)
      ) WHERE rn = 1;

      CREATE VIEW IF NOT EXISTS model_tip_archive_listing AS
      SELECT a.*, s.current_kickoff, s.match_status
      FROM model_tip_archive a JOIN model_tip_archive_match_state s ON s.match_id = a.match_id;

      CREATE VIEW IF NOT EXISTS model_tip_archive_counted_listing AS
      SELECT c.*, s.current_kickoff, s.match_status
      FROM model_tip_archive_counted c JOIN model_tip_archive_match_state s ON s.match_id = c.match_id;
    `);
  }

  /**
   * Egy korábbi (0014-es sémájú) helyi tábla bővítése a 0016 oszlopaival. A
   * meglévő sorok 'legacy_baseline' jelölést kapnak, kiszolgált érték nélkül –
   * semmit nem találunk ki és semmit nem írunk át.
   */
  private upgradeLegacyTable(): void {
    const exists = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'model_tip_archive'").get();
    if (!exists) return;
    const cols = new Set((this.db.prepare('PRAGMA table_info(model_tip_archive)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('provenance')) {
      this.db.exec("ALTER TABLE model_tip_archive ADD COLUMN provenance TEXT NOT NULL DEFAULT 'legacy_baseline' CHECK (provenance IN ('legacy_baseline', 'recorded'))");
    }
    if (!cols.has('served_prob')) this.db.exec('ALTER TABLE model_tip_archive ADD COLUMN served_prob REAL');
    if (!cols.has('served_model')) this.db.exec('ALTER TABLE model_tip_archive ADD COLUMN served_model TEXT');
  }

  /** A nyilvános szűrés – a láthatósági feltétel itt kötelezően rákerül. */
  private where(f: ArchiveFilter): { sql: string; args: SQLInputValue[] } {
    const parts = [
      'origin = ?', 'archive_visible = 1',
      `match_status IN (${VISIBLE_STATUSES.map(() => '?').join(', ')})`, 'current_kickoff < ?',
    ];
    const args: SQLInputValue[] = [f.origin, ...VISIBLE_STATUSES, f.visibleBefore];
    if (f.from) { parts.push('current_kickoff >= ?'); args.push(f.from); }
    if (f.to) { parts.push('current_kickoff < ?'); args.push(f.to); }
    if (f.leagueId) { parts.push('league_id = ?'); args.push(f.leagueId); }
    if (f.marketType) { parts.push('market_type = ?'); args.push(f.marketType); }
    if (f.status) { parts.push('settlement_status = ?'); args.push(f.status); }
    if (f.availability) { parts.push('availability = ?'); args.push(f.availability); }
    if (f.search) { parts.push("lower(match_label) LIKE ? ESCAPE '\\'"); args.push(`%${f.search.toLowerCase()}%`); }
    return { sql: parts.join(' AND '), args };
  }

  async latestVersions(matchId: string) {
    const rows = this.db.prepare(
      `SELECT market, version_no, content_hash, generated_at FROM model_tip_archive a
       WHERE match_id = ? AND version_no = (SELECT MAX(version_no) FROM model_tip_archive b WHERE b.match_id = a.match_id AND b.market = a.market)`,
    ).all(matchId) as SqlRow[];
    return new Map<string, LatestVersion>(rows.map((r) => [String(r.market), {
      versionNo: Number(r.version_no), contentHash: String(r.content_hash), generatedAt: String(r.generated_at),
    }]));
  }

  async matchState(matchId: string): Promise<MatchObservation | null> {
    const r = this.db.prepare(
      'SELECT current_kickoff, match_status, observed_at FROM model_tip_archive_match_state WHERE match_id = ?',
    ).get(matchId) as SqlRow | undefined;
    if (!r) return null;
    return {
      matchId, kickoff: String(r.current_kickoff), status: r.match_status as ObservedStatus, observedAt: String(r.observed_at),
    };
  }

  async orphanMatchIds(kickoffBefore: string, kickoffAfter: string, limit: number, offset = 0): Promise<string[]> {
    const rows = this.db.prepare(
      `SELECT a.match_id, MAX(a.kickoff) AS k FROM model_tip_archive a
       WHERE a.kickoff < ? AND a.kickoff >= ?
         AND NOT EXISTS (SELECT 1 FROM model_tip_archive_match_state s WHERE s.match_id = a.match_id)
       GROUP BY a.match_id ORDER BY k DESC, a.match_id LIMIT ? OFFSET ?`,
    ).all(kickoffBefore, kickoffAfter, limit, offset) as SqlRow[];
    return rows.map((r) => String(r.match_id));
  }

  async insertVersions(rows: ArchiveDraft[]): Promise<string[]> {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO model_tip_archive (id, match_id, market, version_no, content_hash, engine_version, generated_at,
        origin, match_label, league_id, league_name, kickoff, market_label, market_type, category, model_prob,
        odds_at_generation, implied_prob, data_quality, sample_size, supporting_indicators, pre_kickoff, availability,
        provenance, served_prob, served_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)`,
    );
    const inserted: string[] = [];
    for (const d of rows) {
      const r = stmt.run(
        randomUUID(), d.matchId, d.market, d.versionNo, d.contentHash, d.engineVersion, d.generatedAt,
        d.origin, d.matchLabel, d.leagueId, d.leagueName, d.kickoff, d.marketLabel, d.marketType, d.category, d.modelProb,
        d.odds, d.impliedProb, d.dataQuality, d.sampleSize, d.supportingIndicators, d.preKickoff ? 1 : 0, d.availability,
        d.servedProb, d.servedModel,
      );
      if (Number(r.changes) > 0) inserted.push(d.market);
    }
    return inserted;
  }

  async observeMatch(o: MatchObservation): Promise<void> {
    this.db.prepare(
      `INSERT INTO model_tip_archive_match_state (match_id, current_kickoff, match_status, observed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (match_id) DO UPDATE SET
         current_kickoff = excluded.current_kickoff,
         match_status = excluded.match_status,
         observed_at = excluded.observed_at
       WHERE model_tip_archive_match_state.observed_at <= excluded.observed_at`,
    ).run(o.matchId, o.kickoff, o.status, o.observedAt);
  }

  async dueMatchIds(kickoffBefore: string, kickoffAfter: string, limit: number, offset = 0): Promise<string[]> {
    const rows = this.db.prepare(
      `SELECT match_id FROM model_tip_archive_match_state
       WHERE match_status <> 'finished' AND current_kickoff < ? AND current_kickoff >= ?
       ORDER BY observed_at ASC, match_id LIMIT ? OFFSET ?`,
    ).all(kickoffBefore, kickoffAfter, limit, offset) as SqlRow[];
    return rows.map((r) => String(r.match_id));
  }

  async pendingMarkets(matchId: string): Promise<string[]> {
    const rows = this.db.prepare(
      "SELECT DISTINCT market FROM model_tip_archive WHERE match_id = ? AND settlement_status = 'pending'",
    ).all(matchId) as SqlRow[];
    return rows.map((r) => String(r.market));
  }

  async settle(input: SettleInput): Promise<number> {
    const stmt = this.db.prepare(
      `UPDATE model_tip_archive SET settlement_status = ?, home_goals = ?, away_goals = ?, result_kickoff = ?, settled_at = ?
       WHERE match_id = ? AND market = ? AND settlement_status = 'pending'`,
    );
    let n = 0;
    for (const o of input.outcomes) {
      n += Number(stmt.run(o.status, input.homeGoals, input.awayGoals, input.resultKickoff, input.settledAt, input.matchId, o.market).changes);
    }
    return n;
  }

  async list(filter: ArchiveFilter, scope: ArchiveScope, offset: number, limit: number) {
    const from = scope === 'counted' ? 'model_tip_archive_counted_listing' : 'model_tip_archive_listing';
    const w = this.where(filter);
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${w.sql}`).get(...w.args) as { n: number };
    const rows = this.db.prepare(
      `SELECT * FROM ${from} WHERE ${w.sql}
       ORDER BY current_kickoff DESC, match_id ASC, market ASC, version_no DESC LIMIT ? OFFSET ?`,
    ).all(...w.args, limit, offset) as SqlRow[];
    return { rows: rows.map(sqlToRow), total: Number(total.n) };
  }

  async countedIds(matchIds: string[]): Promise<Set<string>> {
    if (!matchIds.length) return new Set();
    const rows = this.db.prepare(
      `SELECT id FROM model_tip_archive_counted WHERE match_id IN (${matchIds.map(() => '?').join(',')})`,
    ).all(...matchIds) as SqlRow[];
    return new Set(rows.map((r) => String(r.id)));
  }

  async summary(filter: ArchiveFilter) {
    const w = this.where(filter);
    const records = this.db.prepare(`SELECT COUNT(*) AS n FROM model_tip_archive_listing WHERE ${w.sql}`).get(...w.args) as { n: number };
    const rows = this.db.prepare(
      `SELECT settlement_status AS s, COUNT(*) AS n FROM model_tip_archive_counted_listing WHERE ${w.sql} GROUP BY settlement_status`,
    ).all(...w.args) as SqlRow[];
    const counted: StatusCounts = { won: 0, lost: 0, void: 0, pending: 0, unsupported: 0 };
    for (const r of rows) counted[r.s as keyof StatusCounts] = Number(r.n);
    return { records: Number(records.n), counted };
  }

  async coverageStart(origin: DataOrigin): Promise<string | null> {
    const r = this.db.prepare('SELECT MIN(generated_at) AS t FROM model_tip_archive WHERE origin = ?').get(origin) as { t: string | null };
    return r?.t ?? null;
  }

  async healthCheck(): Promise<string[]> { return []; }
}
