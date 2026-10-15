/**
 * Az `xs-strength-1` tartós tanítóadata és becslésnaplója (0021).
 *  - PostgresXsStore : Supabase (service_role) – éles
 *  - SqliteXsStore   : helyi tartalék és tesztek, azonos szerződéssel és megszorításokkal
 */
import type { DatabaseSync } from 'node:sqlite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ScoreboardResult } from '../data/scoreboardResults';

export interface FitRecord {
  fitId: string;
  modelId: 'xs-strength-1';
  cutoff: string;
  closedHours: number;
  params: Record<string, number>;
  datasetSha256: string;
  trainedMatches: number;
  sweeps: number;
}

export interface XsTrainingStore {
  /** a már eltárolt (sorozat|hónap) kulcsok és lezártságuk */
  months(): Promise<Map<string, boolean>>;
  /** egy hónap meccseinek mentése (meccsenként egyszer – azonosító szerint felülír) + a hónap-jelölő */
  saveMonth(competitionId: string, month: string, closed: boolean, rows: ScoreboardResult[]): Promise<void>;
  /** a `fromIso` óta kezdődött eltárolt meccsek */
  loadMatches(fromIso: string): Promise<ScoreboardResult[]>;
  /** becslésnapló (idempotens: azonos fitId-nál nem ír) */
  recordFit(f: FitRecord): Promise<void>;
}

type Row = Record<string, unknown>;
const PAGE = 1000;
const toResult = (r: Row): ScoreboardResult => ({
  id: String(r.id), competitionId: String(r.competition_id), date: new Date(String(r.match_date)).toISOString(),
  homeTeamId: String(r.home_team_id), awayTeamId: String(r.away_team_id), homeGoals: Number(r.home_goals), awayGoals: Number(r.away_goals),
  regulation: r.regulation === true || Number(r.regulation) === 1,
});
const toRow = (r: ScoreboardResult, month: string) => ({
  id: r.id, competition_id: r.competitionId, match_date: r.date, home_team_id: r.homeTeamId, away_team_id: r.awayTeamId,
  home_goals: r.homeGoals, away_goals: r.awayGoals, regulation: r.regulation, source_month: month,
});

export class PostgresXsStore implements XsTrainingStore {
  private db: SupabaseClient;
  constructor(url: string, key: string) { this.db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }); }
  private fail(op: string, e: { message: string } | null) { if (e) throw new Error(`[xs-store] ${op}: ${e.message}`); }

  async months(): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    // lapozás az ÜRES lapig: a PostgREST `max-rows` korlátja a kértnél kisebb lapot is adhat
    for (let from = 0; ;) {
      const { data, error } = await this.db.from('xs_training_months').select('competition_id, month, closed').order('competition_id').order('month').range(from, from + PAGE - 1);
      this.fail('months', error);
      const rows = (data ?? []) as Row[];
      if (!rows.length) return out;
      for (const r of rows) out.set(`${r.competition_id}|${r.month}`, r.closed === true);
      from += rows.length;
    }
  }

  async saveMonth(competitionId: string, month: string, closed: boolean, rows: ScoreboardResult[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await this.db.from('xs_training_matches').upsert(rows.slice(i, i + 500).map((r) => toRow(r, month)), { onConflict: 'id' });
      this.fail('saveMonth/matches', error);
    }
    const { error } = await this.db.from('xs_training_months').upsert({ competition_id: competitionId, month, closed, match_count: rows.length, fetched_at: new Date().toISOString() }, { onConflict: 'competition_id,month' });
    this.fail('saveMonth/month', error);
  }

  async loadMatches(fromIso: string): Promise<ScoreboardResult[]> {
    const out: ScoreboardResult[] = [];
    for (let from = 0; ;) {
      const { data, error } = await this.db.from('xs_training_matches').select('*').gte('match_date', fromIso).order('id').range(from, from + PAGE - 1);
      this.fail('loadMatches', error);
      const rows = (data ?? []) as Row[];
      if (!rows.length) return out;
      out.push(...rows.map(toResult));
      from += rows.length;
    }
  }

  async recordFit(f: FitRecord): Promise<void> {
    const { error } = await this.db.from('xs_model_fits').upsert({
      fit_id: f.fitId, model_id: f.modelId, cutoff: f.cutoff, closed_hours: f.closedHours, params: f.params,
      dataset_sha256: f.datasetSha256, trained_matches: f.trainedMatches, sweeps: f.sweeps,
    }, { onConflict: 'fit_id', ignoreDuplicates: true });
    this.fail('recordFit', error);
  }
}

export class SqliteXsStore implements XsTrainingStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS xs_training_matches (
        id TEXT PRIMARY KEY, competition_id TEXT NOT NULL, match_date TEXT NOT NULL,
        home_team_id TEXT NOT NULL, away_team_id TEXT NOT NULL,
        home_goals INTEGER NOT NULL CHECK (home_goals >= 0), away_goals INTEGER NOT NULL CHECK (away_goals >= 0),
        regulation INTEGER NOT NULL CHECK (regulation IN (0, 1)), source_month TEXT NOT NULL, fetched_at TEXT NOT NULL,
        CHECK (home_team_id <> away_team_id)
      );
      CREATE INDEX IF NOT EXISTS idx_xs_training_matches_date ON xs_training_matches (match_date);
      CREATE TABLE IF NOT EXISTS xs_training_months (
        competition_id TEXT NOT NULL, month TEXT NOT NULL, closed INTEGER NOT NULL, match_count INTEGER NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (competition_id, month)
      );
      CREATE TABLE IF NOT EXISTS xs_model_fits (
        fit_id TEXT PRIMARY KEY, model_id TEXT NOT NULL CHECK (model_id = 'xs-strength-1'), created_at TEXT NOT NULL, cutoff TEXT NOT NULL,
        closed_hours INTEGER NOT NULL, params TEXT NOT NULL, dataset_sha256 TEXT NOT NULL, trained_matches INTEGER NOT NULL, sweeps INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS xs_model_fits_guard BEFORE UPDATE ON xs_model_fits BEGIN SELECT RAISE(ABORT, 'xs_model_fits: a becslésnapló sorai nem módosíthatók'); END;
      CREATE TRIGGER IF NOT EXISTS xs_model_fits_no_delete BEFORE DELETE ON xs_model_fits BEGIN SELECT RAISE(ABORT, 'xs_model_fits: a sorok nem törölhetők'); END;
    `);
  }

  async months(): Promise<Map<string, boolean>> {
    const rows = this.db.prepare('SELECT competition_id, month, closed FROM xs_training_months').all() as Row[];
    return new Map(rows.map((r) => [`${r.competition_id}|${r.month}`, Number(r.closed) === 1]));
  }

  async saveMonth(competitionId: string, month: string, closed: boolean, rows: ScoreboardResult[]): Promise<void> {
    const now = new Date().toISOString();
    const ins = this.db.prepare(`INSERT INTO xs_training_matches (id, competition_id, match_date, home_team_id, away_team_id, home_goals, away_goals, regulation, source_month, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET match_date = excluded.match_date, home_goals = excluded.home_goals, away_goals = excluded.away_goals, regulation = excluded.regulation, fetched_at = excluded.fetched_at`);
    this.db.exec('BEGIN');
    try {
      for (const r of rows) ins.run(r.id, r.competitionId, r.date, r.homeTeamId, r.awayTeamId, r.homeGoals, r.awayGoals, r.regulation ? 1 : 0, month, now);
      this.db.prepare(`INSERT INTO xs_training_months VALUES (?,?,?,?,?) ON CONFLICT(competition_id, month) DO UPDATE SET closed = excluded.closed, match_count = excluded.match_count, fetched_at = excluded.fetched_at`)
        .run(competitionId, month, closed ? 1 : 0, rows.length, now);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  async loadMatches(fromIso: string): Promise<ScoreboardResult[]> {
    return (this.db.prepare('SELECT * FROM xs_training_matches WHERE match_date >= ? ORDER BY id').all(fromIso) as Row[]).map(toResult);
  }

  async recordFit(f: FitRecord): Promise<void> {
    this.db.prepare('INSERT OR IGNORE INTO xs_model_fits VALUES (?,?,?,?,?,?,?,?,?)')
      .run(f.fitId, f.modelId, new Date().toISOString(), f.cutoff, f.closedHours, JSON.stringify(f.params), f.datasetSha256, f.trainedMatches, f.sweeps);
  }
}
