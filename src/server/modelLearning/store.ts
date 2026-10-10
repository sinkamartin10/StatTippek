/**
 * Modell-kalibráció tárolója – a 0015 tábláin; a tanító adatot a 0014
 * archívum „statisztikába számító” nézetéből CSAK OLVASSA.
 *
 *  - PostgresModelLearningStore : éles; service_role kulccsal,
 *  - SqliteModelLearningStore   : helyi futtatás és tesztek, azonos szerződéssel.
 *    FELTÉTEL: ugyanazon a SQLite-kapcsolaton a SqliteTipArchiveStore már
 *    létrehozta az archívum tábláit és nézeteit.
 *
 * Atomikusság: a futás-zár megszerzése és az aktív mutató cseréje EGYETLEN
 * feltételes UPDATE (compare-and-set) – több szerverpéldány sem tud egyszerre
 * zárat szerezni vagy ütköző aktív verziót beállítani.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CalibrationStatus, LearningRunSummary } from '../../shared/modelLearning';

/** Egy archív sor a tanításhoz (a „statisztikába számító” nézetből). */
export interface ArchiveTrainingRow {
  id: string;
  matchId: string;
  market: string;
  marketType: string;
  leagueId: string;
  generatedAt: string;
  kickoff: string;
  resultKickoff: string | null;
  modelProb: number;
  settlementStatus: string;
  engineVersion: string;
  origin: string;
  preKickoff: boolean;
  homeGoals: number | null;
  awayGoals: number | null;
  /** 0016: a valószínűség eredete; 'recorded' sorban a kiszolgált érték és modell */
  provenance: string;
  servedProb: number | null;
  servedModel: string | null;
}

export interface VersionRow {
  id: string;
  baseEngineVersion: string;
  method: string;
  params: unknown;
  dataFingerprint: string;
  trainingWindow: unknown;
  metrics: unknown;
  gateResult: unknown;
  status: CalibrationStatus;
  statusReason: string | null;
  createdAt: string;
  statusChangedAt: string;
}

export type NewVersion = Omit<VersionRow, 'createdAt' | 'statusChangedAt'>;

export interface LearningStateRow {
  activeModelId: string | null;
  previousModelId: string | null;
  stateVersion: number;
  lockOwner: string | null;
  lockUntil: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastRunSummary: LearningRunSummary | null;
}

export interface LearningEvent {
  at: string;
  kind: string;
  modelId: string | null;
  actor: string | null;
  details: unknown;
}

export interface ModelLearningStore {
  /** A „statisztikába számító” archív sorok (alap motor, élő adat), időrendben, kötött számban. */
  loadArchive(baseEngineVersion: string, maxRows: number): Promise<ArchiveTrainingRow[]>;
  getState(): Promise<LearningStateRow>;
  /** Futás-zár (lease): csak ha nincs érvényes zár. Atomikus. */
  tryAcquireLock(owner: string, nowIso: string, untilIso: string): Promise<boolean>;
  /** A futás lezárása és a zár elengedése – csak a zár tulajdonosa teheti. */
  finishRun(owner: string, finishedAt: string, status: string, error: string | null, summary: LearningRunSummary | null): Promise<boolean>;
  /** Új jelölt; azonos azonosítójú (azonos adat + paraméter) jelölt esetén nem ír. */
  insertVersion(v: NewVersion): Promise<boolean>;
  getVersion(id: string): Promise<VersionRow | null>;
  listVersions(limit: number): Promise<VersionRow[]>;
  /** Állapotváltás, csak ha a jelenlegi állapot a megengedettek között van. */
  setVersionStatus(id: string, status: CalibrationStatus, reason: string | null, from: CalibrationStatus[], at: string): Promise<boolean>;
  /** Aktív mutató cseréje, csak ha a `state_version` még a várt érték. */
  casActive(expectedStateVersion: number, activeId: string | null, previousId: string | null, at: string): Promise<boolean>;
  appendEvent(e: Omit<LearningEvent, 'at'> & { at?: string }): Promise<void>;
  listEvents(limit: number): Promise<LearningEvent[]>;
  /** Egy modell adott típusú legutolsó eseménye (pl. az utolsó árnyék-kiértékelés). */
  latestEvent(modelId: string, kind: string): Promise<LearningEvent | null>;
}

const ARCHIVE_COLUMNS = 'id, match_id, market, market_type, league_id, generated_at, kickoff, result_kickoff, model_prob, settlement_status, engine_version, origin, pre_kickoff, home_goals, away_goals, provenance, served_prob, served_model';
const PAGE = 1000;

// ===========================================================================
// PostgreSQL / PostgREST
// ===========================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const iso = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

function toArchive(r: Row): ArchiveTrainingRow {
  return {
    id: String(r.id), matchId: String(r.match_id), market: String(r.market), marketType: String(r.market_type),
    leagueId: String(r.league_id), generatedAt: iso(r.generated_at)!, kickoff: iso(r.kickoff)!, resultKickoff: iso(r.result_kickoff),
    modelProb: Number(r.model_prob), settlementStatus: String(r.settlement_status), engineVersion: String(r.engine_version),
    origin: String(r.origin), preKickoff: r.pre_kickoff === true || Number(r.pre_kickoff) === 1,
    homeGoals: r.home_goals == null ? null : Number(r.home_goals), awayGoals: r.away_goals == null ? null : Number(r.away_goals),
    provenance: String(r.provenance), servedProb: r.served_prob == null ? null : Number(r.served_prob),
    servedModel: r.served_model == null ? null : String(r.served_model),
  };
}

const parseJson = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

function toVersion(r: Row): VersionRow {
  return {
    id: String(r.id), baseEngineVersion: String(r.base_engine_version), method: String(r.method),
    params: parseJson(r.params), dataFingerprint: String(r.data_fingerprint), trainingWindow: parseJson(r.training_window),
    metrics: parseJson(r.metrics), gateResult: parseJson(r.gate_result), status: r.status,
    statusReason: r.status_reason ?? null, createdAt: iso(r.created_at)!, statusChangedAt: iso(r.status_changed_at)!,
  };
}

function toState(r: Row | undefined): LearningStateRow {
  if (!r) throw new Error('[model-learning] hiányzik az állapotsor (0015 migráció?)');
  return {
    activeModelId: r.active_model_id ?? null, previousModelId: r.previous_model_id ?? null,
    stateVersion: Number(r.state_version), lockOwner: r.lock_owner ?? null, lockUntil: iso(r.lock_until),
    lastRunStartedAt: iso(r.last_run_started_at), lastRunFinishedAt: iso(r.last_run_finished_at),
    lastRunStatus: r.last_run_status ?? null, lastRunError: r.last_run_error ?? null,
    lastRunSummary: r.last_run_summary == null ? null : parseJson(r.last_run_summary),
  };
}

export class PostgresModelLearningStore implements ModelLearningStore {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[model-learning] ${op}: ${error.message}`);
  }

  async loadArchive(baseEngineVersion: string, maxRows: number): Promise<ArchiveTrainingRow[]> {
    const out: ArchiveTrainingRow[] = [];
    // A PostgREST `db-max-rows` korlátja egy lapon KEVESEBB sort is adhat, mint amennyit kértünk –
    // ez NEM jelenti az adat végét. Ezért a ténylegesen kapott sorszámmal lépünk tovább, és csak
    // üres lapnál állunk meg (egy plusz lekérdezés), különben a korlát csendben adatot hagyna ki.
    while (out.length < maxRows) {
      const want = Math.min(PAGE, maxRows - out.length);
      const { data, error } = await this.db.from('model_tip_archive_counted').select(ARCHIVE_COLUMNS)
        .eq('engine_version', baseEngineVersion).eq('origin', 'live')
        .order('kickoff', { ascending: true }).order('id', { ascending: true })
        .range(out.length, out.length + want - 1);
      this.fail('loadArchive', error);
      const rows = (data ?? []) as Row[];
      if (!rows.length) break;
      out.push(...rows.map(toArchive));
    }
    return out;
  }

  async getState(): Promise<LearningStateRow> {
    const { data, error } = await this.db.from('model_learning_state').select('*').eq('id', 1).maybeSingle();
    this.fail('getState', error);
    return toState(data ?? undefined);
  }

  async tryAcquireLock(owner: string, nowIso: string, untilIso: string): Promise<boolean> {
    const { data, error } = await this.db.from('model_learning_state').update({
      lock_owner: owner, lock_until: untilIso, last_run_started_at: nowIso, last_run_status: 'running', last_run_error: null, updated_at: nowIso,
    }).eq('id', 1).or(`lock_until.is.null,lock_until.lt."${nowIso}"`).select('id');
    this.fail('tryAcquireLock', error);
    return (data ?? []).length === 1;
  }

  async finishRun(owner: string, finishedAt: string, status: string, err: string | null, summary: LearningRunSummary | null): Promise<boolean> {
    const { data, error } = await this.db.from('model_learning_state').update({
      lock_owner: null, lock_until: null, last_run_finished_at: finishedAt, last_run_status: status,
      last_run_error: err, last_run_summary: summary, updated_at: finishedAt,
    }).eq('id', 1).eq('lock_owner', owner).select('id');
    this.fail('finishRun', error);
    return (data ?? []).length === 1;
  }

  async insertVersion(v: NewVersion): Promise<boolean> {
    const { data, error } = await this.db.from('model_calibration_versions').upsert({
      id: v.id, base_engine_version: v.baseEngineVersion, method: v.method, params: v.params, data_fingerprint: v.dataFingerprint,
      training_window: v.trainingWindow, metrics: v.metrics, gate_result: v.gateResult, status: v.status, status_reason: v.statusReason,
    }, { onConflict: 'id', ignoreDuplicates: true }).select('id');
    this.fail('insertVersion', error);
    return (data ?? []).length === 1;
  }

  async getVersion(id: string): Promise<VersionRow | null> {
    const { data, error } = await this.db.from('model_calibration_versions').select('*').eq('id', id).maybeSingle();
    this.fail('getVersion', error);
    return data ? toVersion(data) : null;
  }

  async listVersions(limit: number): Promise<VersionRow[]> {
    const { data, error } = await this.db.from('model_calibration_versions').select('*')
      .order('created_at', { ascending: false }).order('id', { ascending: true }).limit(limit);
    this.fail('listVersions', error);
    return ((data ?? []) as Row[]).map(toVersion);
  }

  async setVersionStatus(id: string, status: CalibrationStatus, reason: string | null, from: CalibrationStatus[], at: string): Promise<boolean> {
    const { data, error } = await this.db.from('model_calibration_versions')
      .update({ status, status_reason: reason, status_changed_at: at }).eq('id', id).in('status', from).select('id');
    this.fail('setVersionStatus', error);
    return (data ?? []).length === 1;
  }

  async casActive(expected: number, activeId: string | null, previousId: string | null, at: string): Promise<boolean> {
    const { data, error } = await this.db.from('model_learning_state').update({
      active_model_id: activeId, previous_model_id: previousId, state_version: expected + 1, updated_at: at,
    }).eq('id', 1).eq('state_version', expected).select('id');
    this.fail('casActive', error);
    return (data ?? []).length === 1;
  }

  async appendEvent(e: Omit<LearningEvent, 'at'> & { at?: string }): Promise<void> {
    const { error } = await this.db.from('model_learning_events').insert({
      ...(e.at ? { at: e.at } : {}), kind: e.kind, model_id: e.modelId, actor: e.actor, details: e.details ?? {},
    });
    this.fail('appendEvent', error);
  }

  async listEvents(limit: number): Promise<LearningEvent[]> {
    const { data, error } = await this.db.from('model_learning_events').select('at, kind, model_id, actor, details')
      .order('at', { ascending: false }).limit(limit);
    this.fail('listEvents', error);
    return ((data ?? []) as Row[]).map((r) => ({ at: iso(r.at)!, kind: r.kind, modelId: r.model_id ?? null, actor: r.actor ?? null, details: r.details }));
  }

  async latestEvent(modelId: string, kind: string): Promise<LearningEvent | null> {
    const { data, error } = await this.db.from('model_learning_events').select('at, kind, model_id, actor, details')
      .eq('model_id', modelId).eq('kind', kind).order('at', { ascending: false }).limit(1);
    this.fail('latestEvent', error);
    const r = (data ?? [])[0] as Row | undefined;
    return r ? { at: iso(r.at)!, kind: r.kind, modelId: r.model_id ?? null, actor: r.actor ?? null, details: r.details } : null;
  }
}

// ===========================================================================
// SQLite (helyi fejlesztés / tesztek)
// ===========================================================================

const VERSION_IMMUTABLE = ['id', 'base_engine_version', 'method', 'params', 'data_fingerprint', 'training_window', 'metrics', 'gate_result', 'created_at'];

export class SqliteModelLearningStore implements ModelLearningStore {
  constructor(private db: DatabaseSync) {
    // A 0015 megfelelője: azonos megszorítások és triggerek.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_calibration_versions (
        id TEXT PRIMARY KEY CHECK (id GLOB 'cal-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
        base_engine_version TEXT NOT NULL,
        method TEXT NOT NULL,
        params TEXT NOT NULL,
        data_fingerprint TEXT NOT NULL CHECK (length(data_fingerprint) = 64),
        training_window TEXT NOT NULL,
        metrics TEXT NOT NULL,
        gate_result TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('shadow', 'eligible', 'active', 'rejected', 'rolled_back', 'retired')),
        status_reason TEXT,
        created_at TEXT NOT NULL,
        status_changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_learning_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_model_id TEXT REFERENCES model_calibration_versions(id),
        previous_model_id TEXT REFERENCES model_calibration_versions(id),
        state_version INTEGER NOT NULL DEFAULT 0,
        lock_owner TEXT,
        lock_until TEXT,
        last_run_started_at TEXT,
        last_run_finished_at TEXT,
        last_run_status TEXT CHECK (last_run_status IS NULL OR last_run_status IN ('running', 'succeeded', 'failed', 'insufficient_data')),
        last_run_error TEXT,
        last_run_summary TEXT,
        updated_at TEXT NOT NULL DEFAULT ''
      );
      INSERT OR IGNORE INTO model_learning_state (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS model_learning_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('evaluation', 'insufficient_data', 'candidate_rejected', 'candidate_eligible',
          'promotion', 'promotion_refused', 'rollback', 'failure', 'fallback', 'shadow_evaluation')),
        model_id TEXT,
        actor TEXT,
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TRIGGER IF NOT EXISTS model_calibration_versions_guard
      BEFORE UPDATE ON model_calibration_versions
      WHEN ${VERSION_IMMUTABLE.map((c) => `old.${c} IS NOT new.${c}`).join(' OR ')}
      BEGIN SELECT RAISE(ABORT, 'model_calibration_versions: a jelölt tartalma nem módosítható'); END;
      CREATE TRIGGER IF NOT EXISTS model_learning_events_guard
      BEFORE UPDATE ON model_learning_events
      BEGIN SELECT RAISE(ABORT, 'model_learning_events: az audit-napló nem módosítható'); END;
      CREATE TRIGGER IF NOT EXISTS model_calibration_versions_no_delete BEFORE DELETE ON model_calibration_versions
      BEGIN SELECT RAISE(ABORT, 'model_learning: a sorok nem törölhetők (DELETE)'); END;
      CREATE TRIGGER IF NOT EXISTS model_learning_state_no_delete BEFORE DELETE ON model_learning_state
      BEGIN SELECT RAISE(ABORT, 'model_learning: a sorok nem törölhetők (DELETE)'); END;
      CREATE TRIGGER IF NOT EXISTS model_learning_events_no_delete BEFORE DELETE ON model_learning_events
      BEGIN SELECT RAISE(ABORT, 'model_learning: a sorok nem törölhetők (DELETE)'); END;
    `);
  }

  async loadArchive(baseEngineVersion: string, maxRows: number): Promise<ArchiveTrainingRow[]> {
    const rows = this.db.prepare(
      `SELECT ${ARCHIVE_COLUMNS} FROM model_tip_archive_counted
       WHERE engine_version = ? AND origin = 'live' ORDER BY kickoff ASC, id ASC LIMIT ?`,
    ).all(baseEngineVersion, maxRows) as Row[];
    return rows.map(toArchive);
  }

  async getState(): Promise<LearningStateRow> {
    return toState(this.db.prepare('SELECT * FROM model_learning_state WHERE id = 1').get() as Row);
  }

  async tryAcquireLock(owner: string, nowIso: string, untilIso: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE model_learning_state SET lock_owner = ?, lock_until = ?, last_run_started_at = ?, last_run_status = 'running',
         last_run_error = NULL, updated_at = ?
       WHERE id = 1 AND (lock_until IS NULL OR lock_until < ?)`,
    ).run(owner, untilIso, nowIso, nowIso, nowIso);
    return Number(r.changes) === 1;
  }

  async finishRun(owner: string, finishedAt: string, status: string, err: string | null, summary: LearningRunSummary | null): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE model_learning_state SET lock_owner = NULL, lock_until = NULL, last_run_finished_at = ?, last_run_status = ?,
         last_run_error = ?, last_run_summary = ?, updated_at = ?
       WHERE id = 1 AND lock_owner = ?`,
    ).run(finishedAt, status, err, summary == null ? null : JSON.stringify(summary), finishedAt, owner);
    return Number(r.changes) === 1;
  }

  async insertVersion(v: NewVersion): Promise<boolean> {
    const now = new Date().toISOString();
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO model_calibration_versions (id, base_engine_version, method, params, data_fingerprint, training_window,
         metrics, gate_result, status, status_reason, created_at, status_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(v.id, v.baseEngineVersion, v.method, JSON.stringify(v.params), v.dataFingerprint, JSON.stringify(v.trainingWindow),
      JSON.stringify(v.metrics), JSON.stringify(v.gateResult), v.status, v.statusReason, now, now);
    return Number(r.changes) === 1;
  }

  async getVersion(id: string): Promise<VersionRow | null> {
    const r = this.db.prepare('SELECT * FROM model_calibration_versions WHERE id = ?').get(id) as Row | undefined;
    return r ? toVersion(r) : null;
  }

  async listVersions(limit: number): Promise<VersionRow[]> {
    return (this.db.prepare('SELECT * FROM model_calibration_versions ORDER BY created_at DESC, id ASC LIMIT ?').all(limit) as Row[]).map(toVersion);
  }

  async setVersionStatus(id: string, status: CalibrationStatus, reason: string | null, from: CalibrationStatus[], at: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE model_calibration_versions SET status = ?, status_reason = ?, status_changed_at = ?
       WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
    ).run(status, reason, at, id, ...from);
    return Number(r.changes) === 1;
  }

  async casActive(expected: number, activeId: string | null, previousId: string | null, at: string): Promise<boolean> {
    const r = this.db.prepare(
      `UPDATE model_learning_state SET active_model_id = ?, previous_model_id = ?, state_version = ?, updated_at = ?
       WHERE id = 1 AND state_version = ?`,
    ).run(activeId, previousId, expected + 1, at, expected);
    return Number(r.changes) === 1;
  }

  async appendEvent(e: Omit<LearningEvent, 'at'> & { at?: string }): Promise<void> {
    this.db.prepare('INSERT INTO model_learning_events (id, at, kind, model_id, actor, details) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), e.at ?? new Date().toISOString(), e.kind, e.modelId, e.actor, JSON.stringify(e.details ?? {}));
  }

  async listEvents(limit: number): Promise<LearningEvent[]> {
    return (this.db.prepare('SELECT at, kind, model_id, actor, details FROM model_learning_events ORDER BY at DESC, id ASC LIMIT ?').all(limit) as Row[])
      .map((r) => ({ at: String(r.at), kind: String(r.kind), modelId: r.model_id ?? null, actor: r.actor ?? null, details: parseJson(r.details) }));
  }

  async latestEvent(modelId: string, kind: string): Promise<LearningEvent | null> {
    const r = this.db.prepare('SELECT at, kind, model_id, actor, details FROM model_learning_events WHERE model_id = ? AND kind = ? ORDER BY at DESC, rowid DESC LIMIT 1')
      .get(modelId, kind) as Row | undefined;
    return r ? { at: String(r.at), kind: String(r.kind), modelId: r.model_id ?? null, actor: r.actor ?? null, details: parseJson(r.details) } : null;
  }
}
