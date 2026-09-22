/**
 * Helyi (SQLite) CACHE réteg – node:sqlite, natív fordítás nélkül.
 *
 * Szándékosan CSAK eldobható adatot tárol:
 *   - http_cache      : külső API válaszok (ESPN, odds API) – perc/órás TTL
 *   - research_cache  : kutatási eredmény mérkőzésenként – 30 perc TTL
 *   - sources         : forrásnapló (a kutatásból származtatva, újragenerálható)
 *
 * NEM kerül ide felhasználói adat: a tippek, szelvények, beállítások, kézi odds és a Stripe
 * események a Supabase PostgreSQL-ben vannak (lásd appStore.ts). Ez a fájl újraindításkor
 * nyugodtan törölhető – az adat magától feltöltődik.
 *
 * Az interfész SZINKRON marad, mert a hívók (espnProvider, theOddsApi) szinkron cache-t várnak.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { ResearchResult, SourceRecord } from '../../shared/types';

export interface HttpCache {
  get(url: string, maxAgeMs: number): string | null;
  set(url: string, body: string): void;
}

export class CacheDb {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // A régi (migráció előtti) táblákat NEM bántjuk: ha léteznek, érintetlenül maradnak.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS research_cache (
        match_id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        performed_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        url TEXT,
        retrieved_at TEXT NOT NULL,
        published_at TEXT,
        type TEXT NOT NULL,
        extracted TEXT NOT NULL,
        method TEXT NOT NULL,
        origin TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sources_match ON sources(match_id);
      CREATE TABLE IF NOT EXISTS http_cache (
        url TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  /** A nyers SQLite kapcsolat – a helyi tartalék AppStore használja (Supabase nélküli futtatás). */
  handle(): DatabaseSync {
    return this.db;
  }

  // ---------- HTTP cache ----------

  httpCache(): HttpCache {
    const db = this.db;
    return {
      get(url, maxAgeMs) {
        const row = db.prepare(`SELECT fetched_at, body FROM http_cache WHERE url = ?`).get(url) as { fetched_at: number; body: string } | undefined;
        if (!row || Date.now() - row.fetched_at > maxAgeMs) return null;
        return row.body;
      },
      set(url, body) {
        db.prepare(`INSERT OR REPLACE INTO http_cache VALUES (?,?,?)`).run(url, Date.now(), body);
      },
    };
  }

  // ---------- Kutatás és források ----------

  saveResearch(r: ResearchResult): void {
    this.db.prepare(`INSERT OR REPLACE INTO research_cache VALUES (?,?,?,?)`).run(r.matchId, r.origin, r.performedAt, JSON.stringify(r));
    this.db.prepare(`DELETE FROM sources WHERE match_id = ?`).run(r.matchId);
    const ins = this.db.prepare(`INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const s of r.sources) ins.run(s.id, s.matchId, s.sourceName, s.url, s.retrievedAt, s.publishedAt ?? null, s.type, s.extracted, s.method, s.origin);
  }

  getResearch(matchId: string, maxAgeMs: number): ResearchResult | null {
    const row = this.db.prepare(`SELECT payload, performed_at FROM research_cache WHERE match_id = ?`).get(matchId) as { payload: string; performed_at: string } | undefined;
    if (!row) return null;
    if (Date.now() - new Date(row.performed_at).getTime() > maxAgeMs) return null;
    return JSON.parse(row.payload) as ResearchResult;
  }

  listSources(matchId?: string, origin?: string): SourceRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (matchId) { where.push('match_id = ?'); args.push(matchId); }
    if (origin) { where.push('origin = ?'); args.push(origin); }
    const sql = `SELECT * FROM sources ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY retrieved_at DESC LIMIT 500`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.prepare(sql).all(...args) as any[]).map((r) => ({
      id: r.id, matchId: r.match_id, sourceName: r.source_name, url: r.url, retrievedAt: r.retrieved_at, publishedAt: r.published_at,
      type: r.type, extracted: r.extracted, method: r.method, origin: r.origin,
    }));
  }

  /** Lejárt cache-sorok takarítása (indításkor, hogy a fájl ne hízzon korlátlanul). */
  prune(maxAgeMs = 7 * 24 * 3600_000): number {
    const cutoff = Date.now() - maxAgeMs;
    const a = this.db.prepare(`DELETE FROM http_cache WHERE fetched_at < ?`).run(cutoff);
    const b = this.db.prepare(`DELETE FROM research_cache WHERE performed_at < ?`).run(new Date(cutoff).toISOString());
    return Number(a.changes ?? 0) + Number(b.changes ?? 0);
  }

  close(): void { this.db.close(); }
}
