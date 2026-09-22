/**
 * Adatbázis-homlokzat (hibrid architektúra).
 *
 *   Tartós, felhasználói adat  → AppStore  : Supabase PostgreSQL (service_role) vagy helyi SQLite tartalék
 *   Eldobható cache            → CacheDb   : helyi SQLite (http_cache, research_cache, sources)
 *
 * A hívók továbbra is `db.savePrediction(...)`, `db.listSlips(...)` stb. formában hívnak – a különbség,
 * hogy a tartós adat metódusai ASZINKRONOK (await), a cache metódusai szinkronok maradtak.
 *
 * A felhasználói adatot érintő metódusok KÖTELEZŐEN kérik a user azonosítóját; azt kizárólag a
 * hitelesített Supabase tokenből adja át az API-réteg (a kliens által küldött user_id-t soha nem fogadjuk el).
 */
import type { HistorySummary, MatchOdds, PredictionRecord, ResearchResult, SlipRecord, SourceRecord } from '../../shared/types';
import { CacheDb, type HttpCache } from './cacheDb';
import { PostgresAppStore, SqliteAppStore, type AppStore, type HistoryFilter, type NewPrediction, type NewSlip } from './appStore';

export type { HttpCache } from './cacheDb';
export type { HistoryFilter, NewPrediction, NewSlip } from './appStore';

export interface DatabaseOptions {
  /** SQLite fájl a cache-nek (és a tartalék tárolónak) */
  file: string;
  /** Supabase projekt URL – ha megvan a service_role kulccsal együtt, a tartós adat Postgresbe megy */
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
}

export class Database {
  private cacheDb: CacheDb;
  private store: AppStore;

  constructor(opts: DatabaseOptions) {
    this.cacheDb = new CacheDb(opts.file);
    this.store = opts.supabaseUrl && opts.supabaseServiceRoleKey
      ? new PostgresAppStore(opts.supabaseUrl, opts.supabaseServiceRoleKey)
      : new SqliteAppStore(this.cacheDb.handle());
  }

  /** 'postgres' (éles) vagy 'sqlite' (helyi tartalék) */
  get storeKind(): 'postgres' | 'sqlite' { return this.store.kind; }

  /** Indítási ellenőrzés: mely tartós táblák hiányoznak (pl. nem futott le a migráció). */
  healthCheck(): Promise<string[]> { return this.store.healthCheck(); }

  // ---------- Cache (helyi SQLite, szinkron) ----------

  httpCache(): HttpCache { return this.cacheDb.httpCache(); }
  saveResearch(r: ResearchResult): void { this.cacheDb.saveResearch(r); }
  getResearch(matchId: string, maxAgeMs: number): ResearchResult | null { return this.cacheDb.getResearch(matchId, maxAgeMs); }
  listSources(matchId?: string, origin?: string): SourceRecord[] { return this.cacheDb.listSources(matchId, origin); }
  pruneCache(maxAgeMs?: number): number { return this.cacheDb.prune(maxAgeMs); }

  // ---------- Tippek (tartós, felhasználóhoz kötött) ----------

  savePrediction(p: NewPrediction): Promise<PredictionRecord> { return this.store.savePrediction(p); }
  getPredictionByMarket(userId: string, matchId: string, market: string): Promise<PredictionRecord | null> { return this.store.getPredictionByMarket(userId, matchId, market); }
  listPredictions(userId: string, f: HistoryFilter = {}): Promise<PredictionRecord[]> { return this.store.listPredictions(userId, f); }
  pendingPredictions(userId?: string): Promise<PredictionRecord[]> { return this.store.pendingPredictions(userId); }
  settlePrediction(userId: string, id: string, homeGoals: number, awayGoals: number): Promise<PredictionRecord | null> { return this.store.settlePrediction(userId, id, homeGoals, awayGoals); }

  /** Van-e már ilyen tipp a felhasználónak erre a meccsre és piacra? */
  async hasPrediction(userId: string, matchId: string, market: string): Promise<boolean> {
    return !!(await this.store.getPredictionByMarket(userId, matchId, market));
  }

  // ---------- Szelvények ----------

  saveSlip(rec: NewSlip): Promise<void> { return this.store.saveSlip(rec); }
  listSlips(userId: string): Promise<SlipRecord[]> { return this.store.listSlips(userId); }

  // ---------- Globális beállítások és kézi odds (admin) ----------

  getSetting(key: string): Promise<string | null> { return this.store.getSetting(key); }
  setSetting(key: string, value: string): Promise<void> { return this.store.setSetting(key, value); }
  saveManualOdds(o: MatchOdds): Promise<void> { return this.store.saveManualOdds(o); }
  getManualOdds(matchId: string): Promise<MatchOdds | null> { return this.store.getManualOdds(matchId); }
  deleteManualOdds(matchId: string): Promise<void> { return this.store.deleteManualOdds(matchId); }

  // ---------- Stripe webhook idempotencia ----------

  /** true, ha ez a hívás kapta meg a feldolgozás jogát; false, ha az eseményt már feldolgozták. */
  claimStripeEvent(id: string, type: string): Promise<boolean> { return this.store.claimStripeEvent(id, type); }
  /** Feldolgozási hiba után felszabadítja az eseményt, hogy a Stripe újraküldése érvényesüljön. */
  releaseStripeEvent(id: string): Promise<void> { return this.store.releaseStripeEvent(id); }

  // ---------- Összesítés (tiszta függvény, nem érint adatbázist) ----------

  /** Átlátható összesítés – a vesztes tippek ugyanúgy számítanak, semmi nincs elrejtve. */
  summarize(list: PredictionRecord[]): HistorySummary {
    const settled = list.filter((p) => p.outcome !== 'függőben');
    const correct = settled.filter((p) => p.outcome === 'nyert').length;
    const incorrect = settled.filter((p) => p.outcome === 'vesztett').length;
    const voided = settled.filter((p) => p.outcome === 'érvénytelen').length;
    const decided = correct + incorrect;
    const withOdds = settled.filter((p) => p.odds != null);
    let stake = 0, ret = 0;
    for (const p of withOdds) {
      stake += 1;
      if (p.outcome === 'nyert') ret += p.odds!;
      else if (p.outcome === 'érvénytelen') ret += 1;
    }
    return {
      total: list.length,
      settled: settled.length,
      correct,
      incorrect,
      voided,
      pending: list.length - settled.length,
      hitRate: decided ? correct / decided : null,
      avgModelProb: list.length ? list.reduce((s, p) => s + p.modelProb, 0) / list.length : null,
      roi: stake ? (ret - stake) / stake : null,
      withOdds: withOdds.length,
    };
  }

  close(): void { this.cacheDb.close(); }
}
