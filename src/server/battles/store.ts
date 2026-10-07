/**
 * 1v1 Tipp Battle tároló réteg. A Tippverseny store mintáját követi, de ATTÓL
 * FÜGGETLEN: saját táblák, saját interfész.
 *
 *  - PostgresBattleStore : Supabase PostgreSQL service_role kulccsal (éles)
 *  - SqliteBattleStore   : helyi tartalék és teszt-tároló (node:sqlite)
 *
 * FONTOS: ez a réteg a `user_predictions` táblához SOHA nem nyúl. A battle tippek
 * kizárólag a `battle_predictions` táblában élnek – ez adja az izolációt a
 * Tippverseny-ranglistától, a FREE napi kvótától, a küldetésektől és a progression
 * XP-től, szűrők nélkül.
 *
 * Minden állapotátmenet FELTÉTELES írás (a meglévő setCompetitionStatus mintája):
 * a hívó megadja a megengedett kiinduló állapotokat, és `null` jön vissza, ha a
 * sor nem illeszkedett. Így két párhuzamos kérés közül pontosan egy ír.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BattlePredictionRow, BattleRow, BattleStatus } from '../../shared/battles';

export interface NewBattleInput {
  challengerId: string;
  opponentId: string;
  matchIds: string[];
  expiresAt: string;
  /** a kötelező mérkőzésszám (a megosztott konfigurációból) */
  matchCount: number;
  /** a nyitott kihívások felső korlátja, vagy null, ha nincs */
  maxPending: number | null;
  now: string;
}

export type CreateBattleOutcome = 'created' | 'pending_limit' | 'already_challenged';

export interface CreateBattleResult {
  outcome: CreateBattleOutcome;
  /** a kihívó nyitott kihívásainak száma a művelet után */
  pending: number;
  battle: BattleRow | null;
}

/** A lezáráskor beírandó végeredmény. */
export interface SettleBattleInput {
  challengerPoints: number;
  opponentPoints: number;
  /** null = döntetlen */
  winnerUserId: string | null;
  settledAt: string;
}

export interface BattleStore {
  readonly kind: 'postgres' | 'sqlite';
  healthCheck(): Promise<string[]>;

  /**
   * ATOMIKUS létrehozás: a battle és a PONTOSAN `matchCount` mérkőzése együtt jön
   * létre, a nyitott-kihívás korlát és a páros-duplikáció egyidejű ellenőrzésével.
   * A feltétel és az írás nem választható szét (lásd az implementációk megjegyzéseit).
   */
  createBattle(input: NewBattleInput): Promise<CreateBattleResult>;

  getBattle(id: string): Promise<BattleRow | null>;
  /** A felhasználó minden battle-je (kihívóként és kihívottként is). */
  listBattlesForUser(userId: string): Promise<BattleRow[]>;
  /** A megadott battle-ök mérkőzés-azonosítói, battle szerint csoportosítva. */
  matchIdsFor(battleIds: string[]): Promise<Map<string, string[]>>;

  /**
   * FELTÉTELES állapotátmenet. `expectOpponent` / `expectChallenger` megadásakor a
   * feltétel az írás RÉSZE, nem előzetes ellenőrzés. `notExpiredAt` esetén csak
   * akkor ír, ha a kihívás még nem járt le – így az elfogadás és a lejárat között
   * nincs rés.
   */
  transition(id: string, to: BattleStatus, from: BattleStatus[], guard?: {
    expectChallenger?: string;
    expectOpponent?: string;
    notExpiredAt?: string;
  }): Promise<BattleRow | null>;

  /** Lezárás: a végeredmény beírása, kizárólag `active` állapotból. */
  settle(id: string, result: SettleBattleInput): Promise<BattleRow | null>;

  // --- Tippek: KIZÁRÓLAG a battle_predictions táblában ---
  upsertPrediction(battleId: string, userId: string, competitionMatchId: string, home: number, away: number): Promise<BattlePredictionRow>;
  listPredictions(battleId: string): Promise<BattlePredictionRow[]>;
  /** Több battle tippjei egy lekérdezéssel (a lista nézethez – nincs N+1). */
  listPredictionsMany(battleIds: string[]): Promise<Map<string, BattlePredictionRow[]>>;
  /** A pont ÉRTÉKADÁSSAL íródik (nem növeléssel) – ezért a többszöri lezárás idempotens. */
  setPredictionPoints(id: string, points: number): Promise<void>;
}

const iso = (v: string | Date): string => new Date(v).toISOString();
type Row = Record<string, any>;

function toBattle(r: Row): BattleRow {
  return {
    id: r.id,
    challengerId: r.challenger_id,
    opponentId: r.opponent_id,
    status: r.status as BattleStatus,
    inviteExpiresAt: iso(r.invite_expires_at),
    winnerUserId: r.winner_user_id ?? null,
    challengerPoints: r.challenger_points ?? null,
    opponentPoints: r.opponent_points ?? null,
    settledAt: r.settled_at ? iso(r.settled_at) : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toPrediction(r: Row): BattlePredictionRow {
  return {
    id: r.id,
    battleId: r.battle_id,
    userId: r.user_id,
    competitionMatchId: r.competition_match_id,
    predictedHomeScore: r.predicted_home_score,
    predictedAwayScore: r.predicted_away_score,
    points: r.points ?? null,
    submittedAt: iso(r.submitted_at),
    updatedAt: iso(r.updated_at),
  };
}

const groupBy = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
};

// ============================================================================
// Supabase PostgreSQL (éles)
// ============================================================================

export class PostgresBattleStore implements BattleStore {
  readonly kind = 'postgres' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[battles] ${op}: ${error.message}`);
  }

  async healthCheck(): Promise<string[]> {
    const missing: string[] = [];
    for (const t of ['battles', 'battle_matches', 'battle_predictions']) {
      const { error } = await this.db.from(t).select('*').limit(1);
      if (error) missing.push(`${t} (${error.message})`);
    }
    // A 0009 függvénye: szándékosan érvénytelen hívással (azonos két fél), így a
    // függvény az ELSŐ ellenőrzésén elbukik, és egyetlen sort sem ír.
    const probe = await this.db.rpc('create_battle', {
      p_challenger_id: '00000000-0000-0000-0000-000000000000',
      p_opponent_id: '00000000-0000-0000-0000-000000000000',
      p_match_ids: [], p_expires_at: new Date(0).toISOString(),
      p_match_count: 3, p_max_pending: 5, p_now: new Date(0).toISOString(),
    });
    if (probe.error && (probe.error as { code?: string }).code === 'PGRST202') {
      missing.push('create_battle() függvény (0009_battles.sql)');
    }
    return missing;
  }

  /** A `create_battle()` SQL-függvény: egy tranzakció, a kihívóra vett advisory lockkal. */
  async createBattle(input: NewBattleInput): Promise<CreateBattleResult> {
    const { data, error } = await this.db.rpc('create_battle', {
      p_challenger_id: input.challengerId,
      p_opponent_id: input.opponentId,
      p_match_ids: input.matchIds,
      p_expires_at: input.expiresAt,
      p_match_count: input.matchCount,
      p_max_pending: input.maxPending,
      p_now: input.now,
    });
    this.fail('createBattle', error);
    const r = (data ?? {}) as { outcome?: string; pending?: number; battle?: Row | null };
    if (r.outcome !== 'created' && r.outcome !== 'pending_limit' && r.outcome !== 'already_challenged') {
      throw new Error(`[battles] createBattle: váratlan válasz (${JSON.stringify(data)})`);
    }
    return { outcome: r.outcome, pending: r.pending ?? 0, battle: r.battle ? toBattle(r.battle) : null };
  }

  async getBattle(id: string): Promise<BattleRow | null> {
    const { data, error } = await this.db.from('battles').select('*').eq('id', id).maybeSingle();
    this.fail('getBattle', error);
    return data ? toBattle(data) : null;
  }

  async listBattlesForUser(userId: string): Promise<BattleRow[]> {
    const { data, error } = await this.db.from('battles').select('*')
      .or(`challenger_id.eq.${userId},opponent_id.eq.${userId}`)
      .order('created_at', { ascending: false });
    this.fail('listBattlesForUser', error);
    return (data ?? []).map(toBattle);
  }

  async matchIdsFor(battleIds: string[]): Promise<Map<string, string[]>> {
    if (!battleIds.length) return new Map();
    const { data, error } = await this.db.from('battle_matches')
      .select('battle_id, competition_match_id').in('battle_id', battleIds)
      // Determinisztikus sorrend (a végső, kickoff szerinti rendezést a service végzi)
      .order('competition_match_id', { ascending: true });
    this.fail('matchIdsFor', error);
    const grouped = groupBy(data ?? [], (r: Row) => r.battle_id);
    return new Map([...grouped].map(([k, rows]) => [k, rows.map((r: Row) => r.competition_match_id as string)]));
  }

  async transition(id: string, to: BattleStatus, from: BattleStatus[], guard: {
    expectChallenger?: string; expectOpponent?: string; notExpiredAt?: string;
  } = {}): Promise<BattleRow | null> {
    // Feltételes UPDATE: minden feltétel az ÍRÁS része. Nincs "select → ellenőrzés
    // → később update" minta, ezért a lejárat és az elfogadás között nincs rés.
    let qb = this.db.from('battles').update({ status: to }).eq('id', id).in('status', from);
    if (guard.expectChallenger) qb = qb.eq('challenger_id', guard.expectChallenger);
    if (guard.expectOpponent) qb = qb.eq('opponent_id', guard.expectOpponent);
    if (guard.notExpiredAt) qb = qb.gt('invite_expires_at', guard.notExpiredAt);
    const { data, error } = await qb.select('*').maybeSingle();
    this.fail('transition', error);
    return data ? toBattle(data) : null;
  }

  async settle(id: string, result: SettleBattleInput): Promise<BattleRow | null> {
    const { data, error } = await this.db.from('battles').update({
      status: 'settled',
      challenger_points: result.challengerPoints,
      opponent_points: result.opponentPoints,
      winner_user_id: result.winnerUserId,
      settled_at: result.settledAt,
    }).eq('id', id).eq('status', 'active').select('*').maybeSingle();
    this.fail('settle', error);
    return data ? toBattle(data) : null;
  }

  async upsertPrediction(battleId: string, userId: string, competitionMatchId: string, home: number, away: number): Promise<BattlePredictionRow> {
    // A (battle_id, user_id, competition_match_id) egyedi → a második beküldés
    // MÓDOSÍT, nem duplikál. A submitted_at (a létrehozás ideje) érintetlen marad.
    const { data, error } = await this.db.from('battle_predictions').upsert({
      battle_id: battleId, user_id: userId, competition_match_id: competitionMatchId,
      predicted_home_score: home, predicted_away_score: away,
    }, { onConflict: 'battle_id,user_id,competition_match_id' }).select('*').single();
    this.fail('upsertPrediction', error);
    return toPrediction(data!);
  }

  async listPredictions(battleId: string): Promise<BattlePredictionRow[]> {
    const { data, error } = await this.db.from('battle_predictions').select('*').eq('battle_id', battleId);
    this.fail('listPredictions', error);
    return (data ?? []).map(toPrediction);
  }

  async listPredictionsMany(battleIds: string[]): Promise<Map<string, BattlePredictionRow[]>> {
    if (!battleIds.length) return new Map();
    const { data, error } = await this.db.from('battle_predictions').select('*').in('battle_id', battleIds);
    this.fail('listPredictionsMany', error);
    return groupBy((data ?? []).map(toPrediction), (p) => p.battleId);
  }

  async setPredictionPoints(id: string, points: number): Promise<void> {
    const { error } = await this.db.from('battle_predictions').update({ points }).eq('id', id);
    this.fail('setPredictionPoints', error);
  }
}

// ============================================================================
// Helyi SQLite (tartalék és teszt)
// ============================================================================

export class SqliteBattleStore implements BattleStore {
  readonly kind = 'sqlite' as const;

  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS battles (
        id TEXT PRIMARY KEY,
        challenger_id TEXT NOT NULL,
        opponent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        invite_expires_at TEXT NOT NULL,
        winner_user_id TEXT,
        challenger_points INTEGER,
        opponent_points INTEGER,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (challenger_id <> opponent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_battles_challenger ON battles(challenger_id, status);
      CREATE INDEX IF NOT EXISTS idx_battles_opponent ON battles(opponent_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_battles_one_pending_pair
        ON battles(challenger_id, opponent_id) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS battle_matches (
        id TEXT PRIMARY KEY,
        battle_id TEXT NOT NULL,
        competition_match_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (battle_id, competition_match_id)
      );
      CREATE INDEX IF NOT EXISTS idx_battle_matches_battle ON battle_matches(battle_id);
      CREATE TABLE IF NOT EXISTS battle_predictions (
        id TEXT PRIMARY KEY,
        battle_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        competition_match_id TEXT NOT NULL,
        predicted_home_score INTEGER NOT NULL,
        predicted_away_score INTEGER NOT NULL,
        points INTEGER,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (battle_id, user_id, competition_match_id)
      );
      CREATE INDEX IF NOT EXISTS idx_battle_predictions_battle ON battle_predictions(battle_id);
      CREATE INDEX IF NOT EXISTS idx_battle_predictions_user ON battle_predictions(user_id);
    `);
  }

  async healthCheck(): Promise<string[]> { return []; }

  /**
   * MIÉRT ATOMIKUS: a `node:sqlite` API szinkron, és ebben a metódusban a döntés és
   * az írás között NINCS await-pont, ezért az egyprocesszes Node eseményciklusa nem
   * tud közéfűzni másik kérést. A nyitott kihívás darabszámát és a páros-duplikációt
   * ugyanabban a szinkron blokkban ellenőrizzük, amelyben be is szúrunk.
   */
  async createBattle(input: NewBattleInput): Promise<CreateBattleResult> {
    const ids = [...new Set(input.matchIds)];
    if (ids.length !== input.matchCount) {
      throw new Error(`[battles] createBattle: pontosan ${input.matchCount} különböző mérkőzés kell`);
    }
    const placeholders = ids.map(() => '?').join(',');
    const valid = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM competition_matches
        WHERE id IN (${placeholders}) AND status = 'scheduled' AND kickoff > ?`,
    ).get(...ids, input.now) as Row).n as number;
    if (valid !== input.matchCount) throw new Error('[battles] createBattle: nem minden mérkőzés tippelhető');

    // A kihívó LEJÁRT, de még 'pending' kihívásainak utánvezetése – azonos a
    // 0009 create_battle() függvényének viselkedésével. Enélkül egy lejárt sor
    // véglegesen blokkolná ugyanannak az ellenfélnek az újbóli kihívását.
    this.db.prepare(
      "UPDATE battles SET status = 'expired', updated_at = ? WHERE challenger_id = ? AND status = 'pending' AND invite_expires_at <= ?",
    ).run(input.now, input.challengerId, input.now);

    const pending = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM battles
        WHERE challenger_id = ? AND status = 'pending' AND invite_expires_at > ?`,
    ).get(input.challengerId, input.now) as Row).n as number;
    if (input.maxPending != null && pending >= input.maxPending) {
      return { outcome: 'pending_limit', pending, battle: null };
    }

    const dup = this.db.prepare(
      "SELECT id FROM battles WHERE challenger_id = ? AND opponent_id = ? AND status = 'pending'",
    ).get(input.challengerId, input.opponentId) as Row | undefined;
    if (dup) return { outcome: 'already_challenged', pending, battle: null };

    const id = randomUUID();
    const now = input.now;
    this.db.prepare(`INSERT INTO battles
      (id, challenger_id, opponent_id, status, invite_expires_at, winner_user_id,
       challenger_points, opponent_points, settled_at, created_at, updated_at)
      VALUES (?,?,?,'pending',?,NULL,NULL,NULL,NULL,?,?)`)
      .run(id, input.challengerId, input.opponentId, input.expiresAt, now, now);
    for (const m of ids) {
      this.db.prepare('INSERT INTO battle_matches (id, battle_id, competition_match_id, created_at) VALUES (?,?,?,?)')
        .run(randomUUID(), id, m, now);
    }
    return { outcome: 'created', pending: pending + 1, battle: (await this.getBattle(id))! };
  }

  async getBattle(id: string): Promise<BattleRow | null> {
    const r = this.db.prepare('SELECT * FROM battles WHERE id = ?').get(id) as Row | undefined;
    return r ? toBattle(r) : null;
  }

  async listBattlesForUser(userId: string): Promise<BattleRow[]> {
    const rows = this.db.prepare(
      'SELECT * FROM battles WHERE challenger_id = ? OR opponent_id = ? ORDER BY created_at DESC',
    ).all(userId, userId) as Row[];
    return rows.map(toBattle);
  }

  async matchIdsFor(battleIds: string[]): Promise<Map<string, string[]>> {
    if (!battleIds.length) return new Map();
    const rows = this.db.prepare(
      `SELECT battle_id, competition_match_id FROM battle_matches
        WHERE battle_id IN (${battleIds.map(() => '?').join(',')})
        ORDER BY competition_match_id ASC`,
    ).all(...battleIds) as Row[];
    const grouped = groupBy(rows, (r) => r.battle_id as string);
    return new Map([...grouped].map(([k, rs]) => [k, rs.map((r) => r.competition_match_id as string)]));
  }

  async transition(id: string, to: BattleStatus, from: BattleStatus[], guard: {
    expectChallenger?: string; expectOpponent?: string; notExpiredAt?: string;
  } = {}): Promise<BattleRow | null> {
    // Egyetlen UPDATE, minden feltétel a WHERE-ben → nincs "select, majd update" rés
    const cond: string[] = [`status IN (${from.map(() => '?').join(',')})`];
    const args: unknown[] = [to, new Date().toISOString(), id, ...from];
    if (guard.expectChallenger) { cond.push('challenger_id = ?'); args.push(guard.expectChallenger); }
    if (guard.expectOpponent) { cond.push('opponent_id = ?'); args.push(guard.expectOpponent); }
    if (guard.notExpiredAt) { cond.push('invite_expires_at > ?'); args.push(guard.notExpiredAt); }
    const res = this.db.prepare(
      `UPDATE battles SET status = ?, updated_at = ? WHERE id = ? AND ${cond.join(' AND ')}`,
    ).run(...(args as any[]));
    if (Number(res.changes) === 0) return null;
    return this.getBattle(id);
  }

  async settle(id: string, result: SettleBattleInput): Promise<BattleRow | null> {
    const res = this.db.prepare(`UPDATE battles
        SET status = 'settled', challenger_points = ?, opponent_points = ?,
            winner_user_id = ?, settled_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'`)
      .run(result.challengerPoints, result.opponentPoints, result.winnerUserId,
        result.settledAt, new Date().toISOString(), id);
    if (Number(res.changes) === 0) return null;
    return this.getBattle(id);
  }

  async upsertPrediction(battleId: string, userId: string, competitionMatchId: string, home: number, away: number): Promise<BattlePredictionRow> {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO battle_predictions
      (id, battle_id, user_id, competition_match_id, predicted_home_score, predicted_away_score, points, submitted_at, updated_at)
      VALUES (?,?,?,?,?,?,NULL,?,?)
      ON CONFLICT (battle_id, user_id, competition_match_id) DO UPDATE SET
        predicted_home_score = excluded.predicted_home_score,
        predicted_away_score = excluded.predicted_away_score,
        updated_at = excluded.updated_at`)
      .run(randomUUID(), battleId, userId, competitionMatchId, home, away, now, now);
    const r = this.db.prepare(
      'SELECT * FROM battle_predictions WHERE battle_id = ? AND user_id = ? AND competition_match_id = ?',
    ).get(battleId, userId, competitionMatchId) as Row;
    return toPrediction(r);
  }

  async listPredictions(battleId: string): Promise<BattlePredictionRow[]> {
    const rows = this.db.prepare('SELECT * FROM battle_predictions WHERE battle_id = ?').all(battleId) as Row[];
    return rows.map(toPrediction);
  }

  async listPredictionsMany(battleIds: string[]): Promise<Map<string, BattlePredictionRow[]>> {
    if (!battleIds.length) return new Map();
    const rows = this.db.prepare(
      `SELECT * FROM battle_predictions WHERE battle_id IN (${battleIds.map(() => '?').join(',')})`,
    ).all(...battleIds) as Row[];
    return groupBy(rows.map(toPrediction), (p) => p.battleId);
  }

  async setPredictionPoints(id: string, points: number): Promise<void> {
    this.db.prepare('UPDATE battle_predictions SET points = ?, updated_at = ? WHERE id = ?')
      .run(points, new Date().toISOString(), id);
  }
}
