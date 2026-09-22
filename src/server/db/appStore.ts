/**
 * Tartós alkalmazásadat-réteg (predictions, slips, settings, manual_odds, stripe_events).
 *
 *  - PostgresAppStore : Supabase PostgreSQL, service_role kulccsal (éles). A kulcs sosem hagyja el a szervert.
 *  - SqliteAppStore   : helyi tartalék, ha nincs Supabase service_role kulcs (offline fejlesztés, demo mód).
 *
 * Mindkettő ASZINKRON – a hívók await-elnek. A felhasználói adatok MINDIG user_id-vel szűrve
 * érkeznek/íródnak; a user_id kizárólag a hitelesített tokenből származhat (lásd routes/api.ts).
 *
 * Konkurencia:
 *  - savePrediction  : INSERT … ON CONFLICT (user_id, match_id, market) DO NOTHING → nincs check-then-insert verseny
 *  - settlePrediction: UPDATE … WHERE outcome='függőben' RETURNING * → lezárt rekordot nem ír felül
 *  - claimStripeEvent: INSERT … ON CONFLICT DO NOTHING RETURNING id → atomi „ki dolgozza fel” döntés
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { MatchOdds, PredictionOutcome, PredictionRecord, SlipRecord, SlipStrategy } from '../../shared/types';
import { evaluateMarket } from '../../shared/engine/markets';

export interface HistoryFilter {
  leagueId?: string;
  market?: string;
  from?: string;
  to?: string;
  minProb?: number;
  maxProb?: number;
  origin?: string;
}

/** Új tipp adatai (id-t és a kimenetet a tároló adja). */
export type NewPrediction = Omit<PredictionRecord, 'id' | 'outcome' | 'homeGoals' | 'awayGoals' | 'settledAt'>;
export type NewSlip = Omit<SlipRecord, 'legs' | 'outcome'>;

export interface AppStore {
  readonly kind: 'postgres' | 'sqlite';

  /** Indítási ellenőrzés: mely táblák hiányoznak/nem érhetők el. Üres tömb = minden rendben. */
  healthCheck(): Promise<string[]>;

  // Tippek – minden művelet felhasználóhoz kötött
  savePrediction(p: NewPrediction): Promise<PredictionRecord>;
  getPredictionByMarket(userId: string, matchId: string, market: string): Promise<PredictionRecord | null>;
  getPredictions(userId: string, ids: string[]): Promise<PredictionRecord[]>;
  listPredictions(userId: string, f?: HistoryFilter): Promise<PredictionRecord[]>;
  pendingPredictions(userId?: string): Promise<PredictionRecord[]>;
  settlePrediction(userId: string, id: string, homeGoals: number, awayGoals: number): Promise<PredictionRecord | null>;

  // Szelvények
  saveSlip(rec: NewSlip): Promise<void>;
  listSlips(userId: string): Promise<SlipRecord[]>;

  // Globális (admin) adatok
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  saveManualOdds(o: MatchOdds): Promise<void>;
  getManualOdds(matchId: string): Promise<MatchOdds | null>;
  deleteManualOdds(matchId: string): Promise<void>;

  // Stripe webhook idempotencia
  claimStripeEvent(id: string, type: string): Promise<boolean>;
  releaseStripeEvent(id: string): Promise<void>;
}

/** A szelvény kimenete a lábakból: egy vesztes láb = vesztett; érvénytelen láb kiesik. */
export function outcomeFromLegs(legs: PredictionRecord[]): PredictionOutcome {
  if (legs.some((l) => l.outcome === 'vesztett')) return 'vesztett';
  if (legs.length && legs.every((l) => l.outcome !== 'függőben')) return legs.some((l) => l.outcome === 'nyert') ? 'nyert' : 'érvénytelen';
  return 'függőben';
}

function settledOutcome(market: string, hg: number, ag: number): PredictionOutcome {
  const res = evaluateMarket(market, hg, ag);
  return res === 'win' ? 'nyert' : res === 'loss' ? 'vesztett' : 'érvénytelen';
}

// ============================================================================
// PostgreSQL (Supabase, service_role)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function pgToPrediction(r: Row): PredictionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    createdAt: new Date(r.created_at).toISOString(),
    matchId: r.match_id,
    matchLabel: r.match_label,
    kickoff: new Date(r.kickoff).toISOString(),
    leagueId: r.league_id,
    leagueName: r.league_name,
    market: r.market,
    marketLabel: r.market_label,
    modelProb: r.model_prob,
    odds: r.odds,
    category: r.category,
    predictionType: r.prediction_type,
    outcome: r.outcome,
    homeGoals: r.home_goals,
    awayGoals: r.away_goals,
    settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    origin: r.origin,
  };
}

function predictionToPg(p: NewPrediction) {
  return {
    user_id: p.userId,
    created_at: p.createdAt,
    match_id: p.matchId,
    match_label: p.matchLabel,
    kickoff: p.kickoff,
    league_id: p.leagueId,
    league_name: p.leagueName,
    market: p.market,
    market_label: p.marketLabel,
    model_prob: p.modelProb,
    odds: p.odds,
    category: p.category,
    prediction_type: p.predictionType,
    origin: p.origin,
  };
}

export class PostgresAppStore implements AppStore {
  readonly kind = 'postgres' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[postgres] ${op}: ${error.message}`);
  }

  async healthCheck(): Promise<string[]> {
    const tables = ['predictions', 'slips', 'app_settings', 'manual_odds', 'stripe_events'];
    const missing: string[] = [];
    for (const t of tables) {
      // Fontos: valódi SELECT kell – a head:true + count:'exact' nem jelzi a hiányzó táblát
      const { error } = await this.db.from(t).select('*').limit(1);
      if (error) missing.push(`${t} (${error.message})`);
    }
    return missing;
  }

  async savePrediction(p: NewPrediction): Promise<PredictionRecord> {
    // ON CONFLICT DO NOTHING: párhuzamos mentésnél nem keletkezik duplikátum
    const { data, error } = await this.db
      .from('predictions')
      .upsert(predictionToPg(p), { onConflict: 'user_id,match_id,market', ignoreDuplicates: true })
      .select()
      .maybeSingle();
    this.fail('savePrediction', error);
    if (data) return pgToPrediction(data);
    // Ütközés volt – a meglévő sort adjuk vissza
    const existing = await this.getPredictionByMarket(p.userId, p.matchId, p.market);
    if (!existing) throw new Error('[postgres] savePrediction: a rekord nem menthető és nem is található');
    return existing;
  }

  async getPredictionByMarket(userId: string, matchId: string, market: string): Promise<PredictionRecord | null> {
    const { data, error } = await this.db.from('predictions').select('*')
      .eq('user_id', userId).eq('match_id', matchId).eq('market', market).maybeSingle();
    this.fail('getPredictionByMarket', error);
    return data ? pgToPrediction(data) : null;
  }

  async getPredictions(userId: string, ids: string[]): Promise<PredictionRecord[]> {
    if (!ids.length) return [];
    const { data, error } = await this.db.from('predictions').select('*').eq('user_id', userId).in('id', ids);
    this.fail('getPredictions', error);
    return (data ?? []).map(pgToPrediction);
  }

  async listPredictions(userId: string, f: HistoryFilter = {}): Promise<PredictionRecord[]> {
    let q = this.db.from('predictions').select('*').eq('user_id', userId);
    if (f.leagueId) q = q.eq('league_id', f.leagueId);
    if (f.market) q = q.eq('market', f.market);
    if (f.from) q = q.gte('kickoff', f.from);
    if (f.to) q = q.lte('kickoff', `${f.to}T23:59:59.999Z`);
    if (f.minProb != null) q = q.gte('model_prob', f.minProb);
    if (f.maxProb != null) q = q.lte('model_prob', f.maxProb);
    if (f.origin) q = q.eq('origin', f.origin);
    const { data, error } = await q.order('kickoff', { ascending: false }).order('created_at', { ascending: false }).limit(2000);
    this.fail('listPredictions', error);
    return (data ?? []).map(pgToPrediction);
  }

  async pendingPredictions(userId?: string): Promise<PredictionRecord[]> {
    let q = this.db.from('predictions').select('*').eq('outcome', 'függőben');
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q.limit(2000);
    this.fail('pendingPredictions', error);
    return (data ?? []).map(pgToPrediction);
  }

  async settlePrediction(userId: string, id: string, homeGoals: number, awayGoals: number): Promise<PredictionRecord | null> {
    const current = await this.db.from('predictions').select('market').eq('id', id).eq('user_id', userId).maybeSingle();
    this.fail('settlePrediction/olvasás', current.error);
    if (!current.data) return null;
    const outcome = settledOutcome(current.data.market, homeGoals, awayGoals);
    // Atomi: csak akkor ír, ha még függőben van
    const { data, error } = await this.db.from('predictions')
      .update({ outcome, home_goals: homeGoals, away_goals: awayGoals, settled_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', userId).eq('outcome', 'függőben')
      .select().maybeSingle();
    this.fail('settlePrediction', error);
    return data ? pgToPrediction(data) : null;
  }

  async saveSlip(rec: NewSlip): Promise<void> {
    const { error } = await this.db.from('slips').insert({
      id: rec.id,
      user_id: rec.userId,
      created_at: rec.createdAt,
      strategy: rec.strategy,
      label: rec.label,
      leg_prediction_ids: rec.legPredictionIds,
      total_odds: rec.totalOdds,
      joint_prob: rec.jointProb,
      origin: rec.origin,
    });
    this.fail('saveSlip', error);
  }

  async listSlips(userId: string): Promise<SlipRecord[]> {
    const { data, error } = await this.db.from('slips').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(500);
    this.fail('listSlips', error);
    const slips = data ?? [];
    // A lábak EGY lekérdezéssel (nincs N+1 hálózati kör)
    const allIds = [...new Set(slips.flatMap((s: Row) => s.leg_prediction_ids as string[]))];
    const legs = await this.getPredictions(userId, allIds);
    const byId = new Map(legs.map((l) => [l.id, l]));
    return slips.map((s: Row) => {
      const ids = s.leg_prediction_ids as string[];
      const rows = ids.map((id) => byId.get(id)).filter((p): p is PredictionRecord => !!p);
      return {
        id: s.id, userId: s.user_id, createdAt: new Date(s.created_at).toISOString(), strategy: s.strategy as SlipStrategy,
        label: s.label, legPredictionIds: ids, totalOdds: s.total_odds, jointProb: s.joint_prob, origin: s.origin,
        outcome: outcomeFromLegs(rows), legs: rows,
      };
    });
  }

  async getSetting(key: string): Promise<string | null> {
    const { data, error } = await this.db.from('app_settings').select('value').eq('key', key).maybeSingle();
    this.fail('getSetting', error);
    return data?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    const { error } = await this.db.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    this.fail('setSetting', error);
  }

  async saveManualOdds(o: MatchOdds): Promise<void> {
    const { error } = await this.db.from('manual_odds').upsert({ match_id: o.matchId, payload: o, updated_at: new Date().toISOString() }, { onConflict: 'match_id' });
    this.fail('saveManualOdds', error);
  }

  async getManualOdds(matchId: string): Promise<MatchOdds | null> {
    const { data, error } = await this.db.from('manual_odds').select('payload').eq('match_id', matchId).maybeSingle();
    this.fail('getManualOdds', error);
    return (data?.payload as MatchOdds | undefined) ?? null;
  }

  async deleteManualOdds(matchId: string): Promise<void> {
    const { error } = await this.db.from('manual_odds').delete().eq('match_id', matchId);
    this.fail('deleteManualOdds', error);
  }

  /** true, ha MI kaptuk meg a feldolgozás jogát; false, ha az eseményt már feldolgozták. */
  async claimStripeEvent(id: string, type: string): Promise<boolean> {
    const { data, error } = await this.db.from('stripe_events')
      .upsert({ id, type, received_at: new Date().toISOString() }, { onConflict: 'id', ignoreDuplicates: true })
      .select('id').maybeSingle();
    this.fail('claimStripeEvent', error);
    return !!data;
  }

  async releaseStripeEvent(id: string): Promise<void> {
    const { error } = await this.db.from('stripe_events').delete().eq('id', id);
    if (error) console.error('[postgres] releaseStripeEvent:', error.message);
  }
}

// ============================================================================
// SQLite tartalék (helyi fejlesztés Supabase service_role kulcs nélkül)
// ============================================================================

function sqliteToPrediction(r: Row): PredictionRecord {
  return {
    id: r.id, userId: r.user_id, createdAt: r.created_at, matchId: r.match_id, matchLabel: r.match_label, kickoff: r.kickoff,
    leagueId: r.league_id, leagueName: r.league_name, market: r.market, marketLabel: r.market_label,
    modelProb: r.model_prob, odds: r.odds, category: r.category, predictionType: r.prediction_type,
    outcome: r.outcome, homeGoals: r.home_goals, awayGoals: r.away_goals, settledAt: r.settled_at, origin: r.origin,
  };
}

export class SqliteAppStore implements AppStore {
  readonly kind = 'sqlite' as const;

  /**
   * ÚJ táblanevek (app_*) – a régi, migráció előtti táblákat (predictions, slips, …) nem bántjuk,
   * így a korábbi helyi adat érintetlenül megmarad, de nem keveredik az új, user_id-s sémával.
   */
  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_predictions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        match_id TEXT NOT NULL,
        match_label TEXT NOT NULL,
        kickoff TEXT NOT NULL,
        league_id TEXT NOT NULL,
        league_name TEXT NOT NULL,
        market TEXT NOT NULL,
        market_label TEXT NOT NULL,
        model_prob REAL NOT NULL,
        odds REAL,
        category TEXT NOT NULL,
        prediction_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        home_goals INTEGER,
        away_goals INTEGER,
        settled_at TEXT,
        origin TEXT NOT NULL,
        UNIQUE (user_id, match_id, market)
      );
      CREATE INDEX IF NOT EXISTS idx_app_pred_user ON app_predictions(user_id, kickoff DESC);
      CREATE TABLE IF NOT EXISTS app_slips (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        strategy TEXT NOT NULL,
        label TEXT NOT NULL,
        leg_ids TEXT NOT NULL,
        total_odds REAL NOT NULL,
        joint_prob REAL NOT NULL,
        origin TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_slips_user ON app_slips(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_manual_odds (
        match_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_stripe_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `);
  }

  async healthCheck(): Promise<string[]> { return []; }

  async savePrediction(p: NewPrediction): Promise<PredictionRecord> {
    const existing = await this.getPredictionByMarket(p.userId, p.matchId, p.market);
    if (existing) return existing;
    const rec: PredictionRecord = { ...p, id: randomUUID(), outcome: 'függőben', homeGoals: null, awayGoals: null, settledAt: null };
    this.db.prepare(`INSERT OR IGNORE INTO app_predictions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rec.id, rec.userId, rec.createdAt, rec.matchId, rec.matchLabel, rec.kickoff, rec.leagueId, rec.leagueName,
      rec.market, rec.marketLabel, rec.modelProb, rec.odds, rec.category, rec.predictionType, rec.outcome,
      rec.homeGoals, rec.awayGoals, rec.settledAt, rec.origin,
    );
    return (await this.getPredictionByMarket(p.userId, p.matchId, p.market)) ?? rec;
  }

  async getPredictionByMarket(userId: string, matchId: string, market: string): Promise<PredictionRecord | null> {
    const row = this.db.prepare(`SELECT * FROM app_predictions WHERE user_id = ? AND match_id = ? AND market = ?`).get(userId, matchId, market);
    return row ? sqliteToPrediction(row) : null;
  }

  async getPredictions(userId: string, ids: string[]): Promise<PredictionRecord[]> {
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM app_predictions WHERE user_id = ? AND id IN (${ph})`).all(userId, ...ids) as Row[]).map(sqliteToPrediction);
  }

  async listPredictions(userId: string, f: HistoryFilter = {}): Promise<PredictionRecord[]> {
    const where = ['user_id = ?'];
    const args: (string | number)[] = [userId];
    if (f.leagueId) { where.push('league_id = ?'); args.push(f.leagueId); }
    if (f.market) { where.push('market = ?'); args.push(f.market); }
    if (f.from) { where.push('kickoff >= ?'); args.push(f.from); }
    if (f.to) { where.push('kickoff <= ?'); args.push(f.to + 'T23:59:59'); }
    if (f.minProb != null) { where.push('model_prob >= ?'); args.push(f.minProb); }
    if (f.maxProb != null) { where.push('model_prob <= ?'); args.push(f.maxProb); }
    if (f.origin) { where.push('origin = ?'); args.push(f.origin); }
    const sql = `SELECT * FROM app_predictions WHERE ${where.join(' AND ')} ORDER BY kickoff DESC, created_at DESC LIMIT 2000`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(sqliteToPrediction);
  }

  async pendingPredictions(userId?: string): Promise<PredictionRecord[]> {
    const sql = userId
      ? `SELECT * FROM app_predictions WHERE outcome = 'függőben' AND user_id = ? LIMIT 2000`
      : `SELECT * FROM app_predictions WHERE outcome = 'függőben' LIMIT 2000`;
    const rows = (userId ? this.db.prepare(sql).all(userId) : this.db.prepare(sql).all()) as Row[];
    return rows.map(sqliteToPrediction);
  }

  async settlePrediction(userId: string, id: string, homeGoals: number, awayGoals: number): Promise<PredictionRecord | null> {
    const row = this.db.prepare(`SELECT * FROM app_predictions WHERE id = ? AND user_id = ? AND outcome = 'függőben'`).get(id, userId);
    if (!row) return null;
    const p = sqliteToPrediction(row);
    const outcome = settledOutcome(p.market, homeGoals, awayGoals);
    const settledAt = new Date().toISOString();
    this.db.prepare(`UPDATE app_predictions SET outcome = ?, home_goals = ?, away_goals = ?, settled_at = ? WHERE id = ? AND user_id = ? AND outcome = 'függőben'`)
      .run(outcome, homeGoals, awayGoals, settledAt, id, userId);
    return { ...p, outcome, homeGoals, awayGoals, settledAt };
  }

  async saveSlip(rec: NewSlip): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO app_slips VALUES (?,?,?,?,?,?,?,?,?)`).run(
      rec.id, rec.userId, rec.createdAt, rec.strategy, rec.label, JSON.stringify(rec.legPredictionIds), rec.totalOdds, rec.jointProb, rec.origin,
    );
  }

  async listSlips(userId: string): Promise<SlipRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM app_slips WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`).all(userId) as Row[];
    const allIds = [...new Set(rows.flatMap((r) => JSON.parse(r.leg_ids) as string[]))];
    const legs = await this.getPredictions(userId, allIds);
    const byId = new Map(legs.map((l) => [l.id, l]));
    return rows.map((r) => {
      const ids = JSON.parse(r.leg_ids) as string[];
      const legRows = ids.map((id) => byId.get(id)).filter((p): p is PredictionRecord => !!p);
      return {
        id: r.id, userId: r.user_id, createdAt: r.created_at, strategy: r.strategy as SlipStrategy, label: r.label,
        legPredictionIds: ids, totalOdds: r.total_odds, jointProb: r.joint_prob, origin: r.origin,
        outcome: outcomeFromLegs(legRows), legs: legRows,
      };
    });
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO app_settings VALUES (?,?,?)`).run(key, value, new Date().toISOString());
  }

  async saveManualOdds(o: MatchOdds): Promise<void> {
    this.db.prepare(`INSERT OR REPLACE INTO app_manual_odds VALUES (?,?,?)`).run(o.matchId, JSON.stringify(o), new Date().toISOString());
  }

  async getManualOdds(matchId: string): Promise<MatchOdds | null> {
    const row = this.db.prepare(`SELECT payload FROM app_manual_odds WHERE match_id = ?`).get(matchId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as MatchOdds) : null;
  }

  async deleteManualOdds(matchId: string): Promise<void> {
    this.db.prepare(`DELETE FROM app_manual_odds WHERE match_id = ?`).run(matchId);
  }

  async claimStripeEvent(id: string, type: string): Promise<boolean> {
    const r = this.db.prepare(`INSERT OR IGNORE INTO app_stripe_events VALUES (?,?,?)`).run(id, type, new Date().toISOString());
    return Number(r.changes ?? 0) > 0;
  }

  async releaseStripeEvent(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM app_stripe_events WHERE id = ?`).run(id);
  }
}
