/**
 * Tippverseny tároló réteg – a meglévő AppStore mintáját követi, de ATTÓL FÜGGETLEN:
 * saját táblák, saját interfész. A jelenlegi predictions/slips/settings logikához nem nyúl.
 *
 *  - PostgresCompetitionStore : Supabase PostgreSQL service_role kulccsal (éles)
 *  - SqliteCompetitionStore   : helyi tartalék és teszt-tároló (node:sqlite)
 *
 * Minden felhasználóhoz kötött művelet KÖTELEZŐEN kéri a user azonosítóját, amit
 * kizárólag a hitelesített Supabase tokenből ad át az API-réteg. A pontszámot,
 * a helyezést és a jutalmakat a kliens soha nem írhatja.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Competition, CompetitionMatch, CompetitionMatchStatus, CompetitionReward, CompetitionStatus,
  RewardStatus, RewardType, UserPrediction,
} from '../../shared/competition';
import type { DayWindow } from '../../shared/freeQuota';

/** Mi történt a tippbeküldéskor. A 'limit_reached' esetben NEM keletkezett írás. */
export type PredictionSubmitOutcome = 'created' | 'updated' | 'limit_reached';

export interface PredictionSubmitResult {
  outcome: PredictionSubmitOutcome;
  /** a napi ablakban létrehozott tippek száma a művelet UTÁN */
  used: number;
  /** a mentett tipp; 'limit_reached' esetén null */
  prediction: UserPrediction | null;
}

export interface NewCompetition {
  name: string;
  leagueKey: string;
  leagueName: string;
  provider: string;
  startsAt: string;
  endsAt: string;
  status: CompetitionStatus;
}

/** Szinkronizálandó mérkőzés (a meccsadat-szolgáltatóból leképezve). */
export interface SyncMatch {
  externalMatchId: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  homeScore: number | null;
  awayScore: number | null;
  status: CompetitionMatchStatus;
}

export interface NewReward {
  competitionId: string;
  userId: string;
  placement: number;
  rewardType: RewardType;
  rewardLabel: string;
}

export interface CompetitionStore {
  readonly kind: 'postgres' | 'sqlite';
  healthCheck(): Promise<string[]>;

  // Versenyek
  createCompetition(c: NewCompetition): Promise<Competition>;
  listCompetitions(statuses?: CompetitionStatus[]): Promise<Competition[]>;
  getCompetition(id: string): Promise<Competition | null>;
  /**
   * Státuszváltás feltétellel: csak akkor ír, ha a jelenlegi státusz a `from` listában van.
   * Így a lezárt verseny nem módosítható, és a párhuzamos hívás sem írja felül.
   */
  setCompetitionStatus(id: string, to: CompetitionStatus, from: CompetitionStatus[]): Promise<Competition | null>;

  // Mérkőzések
  upsertMatches(competitionId: string, matches: SyncMatch[]): Promise<{ inserted: number; updated: number }>;
  listMatches(competitionId: string): Promise<CompetitionMatch[]>;
  getMatch(id: string): Promise<CompetitionMatch | null>;
  /**
   * Több mérkőzés EGY lekérdezéssel, azonosítók szerint. Kötegelt olvasó: a hívónak
   * nem kell meccsenként kérdeznie (nincs N+1). Csak olvas.
   */
  getMatchesByIds(ids: string[]): Promise<CompetitionMatch[]>;

  // Tippek
  upsertPrediction(userId: string, competitionMatchId: string, home: number, away: number): Promise<UserPrediction>;
  /**
   * ATOMIKUS tipp-létrehozás vagy -módosítás napi kvótával.
   *
   *  - meglévő tipp (user + meccs) → 'updated', a kvóta NEM fogy, a submitted_at nem változik,
   *  - új tipp és `dailyLimit` elérve → 'limit_reached', írás NEM történik,
   *  - egyébként → 'created'.
   *
   * `dailyLimit = null` → nincs napi limit (PRO).
   * A feltétel és az írás nem választható szét: ugyanazon felhasználó párhuzamos
   * kérései sem tudják átlépni a limitet (lásd az implementációk megjegyzéseit).
   */
  createOrUpdatePrediction(
    userId: string, competitionMatchId: string, home: number, away: number,
    dailyLimit: number | null, window: DayWindow,
  ): Promise<PredictionSubmitResult>;
  /** A megadott napi ablakban LÉTREHOZOTT tippek száma (a submitted_at alapján). */
  countPredictionsCreatedIn(userId: string, window: DayWindow): Promise<number>;
  getPrediction(userId: string, competitionMatchId: string): Promise<UserPrediction | null>;
  listPredictionsForUser(userId: string, competitionId: string): Promise<UserPrediction[]>;
  listPredictionsForCompetition(competitionId: string): Promise<UserPrediction[]>;
  setPredictionPoints(id: string, points: number): Promise<void>;

  // Jutalmak
  createRewardIfAbsent(r: NewReward): Promise<boolean>;
  listRewards(competitionId: string): Promise<CompetitionReward[]>;
  setRewardStatus(competitionId: string, rewardId: string, status: RewardStatus): Promise<CompetitionReward | null>;
}

const iso = (v: string | Date): string => new Date(v).toISOString();

// ============================================================================
// Supabase PostgreSQL (éles)
// ============================================================================

type Row = Record<string, any>;

function toCompetition(r: Row): Competition {
  return {
    id: r.id, name: r.name, leagueKey: r.league_key, leagueName: r.league_name, provider: r.provider,
    startsAt: iso(r.starts_at), endsAt: iso(r.ends_at), status: r.status as CompetitionStatus,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

function toMatch(r: Row): CompetitionMatch {
  return {
    id: r.id, competitionId: r.competition_id, externalMatchId: r.external_match_id,
    homeTeam: r.home_team, awayTeam: r.away_team, kickoff: iso(r.kickoff),
    homeScore: r.home_score ?? null, awayScore: r.away_score ?? null, status: r.status as CompetitionMatchStatus,
  };
}

function toPrediction(r: Row): UserPrediction {
  return {
    id: r.id, competitionMatchId: r.competition_match_id, userId: r.user_id,
    predictedHomeScore: r.predicted_home_score, predictedAwayScore: r.predicted_away_score,
    points: r.points ?? null, submittedAt: iso(r.submitted_at), updatedAt: iso(r.updated_at),
  };
}

function toReward(r: Row): CompetitionReward {
  return {
    id: r.id, competitionId: r.competition_id, userId: r.user_id, displayName: '',
    placement: r.placement, rewardType: r.reward_type as RewardType, rewardLabel: r.reward_label,
    status: r.status as RewardStatus, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

export class PostgresCompetitionStore implements CompetitionStore {
  readonly kind = 'postgres' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[competition] ${op}: ${error.message}`);
  }

  async healthCheck(): Promise<string[]> {
    const missing: string[] = [];
    for (const t of ['competition_rounds', 'competition_matches', 'user_predictions', 'competition_rewards']) {
      const { error } = await this.db.from(t).select('*').limit(1);
      if (error) missing.push(`${t} (${error.message})`);
    }
    // A 0008 migráció függvénye: szándékosan érvénytelen időablakkal hívjuk, így a
    // függvény az ELSŐ ellenőrzésén elbukik, és egyetlen sort sem ír. Ha hiányzik,
    // a PostgREST 'PGRST202' (nincs ilyen függvény) hibát ad – ezt jelezzük.
    const probe = await this.db.rpc('submit_competition_prediction', {
      p_user_id: '00000000-0000-0000-0000-000000000000',
      p_match_id: '00000000-0000-0000-0000-000000000000',
      p_home: 0, p_away: 0, p_daily_limit: null,
      p_day_start: new Date(0).toISOString(), p_day_end: new Date(0).toISOString(),
    });
    if (probe.error && (probe.error as { code?: string }).code === 'PGRST202') {
      missing.push('submit_competition_prediction() függvény (0008_free_daily_quota.sql)');
    }
    return missing;
  }

  async createCompetition(c: NewCompetition): Promise<Competition> {
    const { data, error } = await this.db.from('competition_rounds').insert({
      name: c.name, league_key: c.leagueKey, league_name: c.leagueName, provider: c.provider,
      starts_at: c.startsAt, ends_at: c.endsAt, status: c.status,
    }).select('*').single();
    this.fail('createCompetition', error);
    return toCompetition(data!);
  }

  async listCompetitions(statuses?: CompetitionStatus[]): Promise<Competition[]> {
    let qb = this.db.from('competition_rounds').select('*').order('starts_at', { ascending: false });
    if (statuses?.length) qb = qb.in('status', statuses);
    const { data, error } = await qb;
    this.fail('listCompetitions', error);
    return (data ?? []).map(toCompetition);
  }

  async getCompetition(id: string): Promise<Competition | null> {
    const { data, error } = await this.db.from('competition_rounds').select('*').eq('id', id).maybeSingle();
    this.fail('getCompetition', error);
    return data ? toCompetition(data) : null;
  }

  async setCompetitionStatus(id: string, to: CompetitionStatus, from: CompetitionStatus[]): Promise<Competition | null> {
    // Feltételes UPDATE: a lezárt/érvénytelenített verseny nem illeszkedik a `from` listára, ezért nem íródik felül
    const { data, error } = await this.db.from('competition_rounds')
      .update({ status: to }).eq('id', id).in('status', from).select('*').maybeSingle();
    this.fail('setCompetitionStatus', error);
    return data ? toCompetition(data) : null;
  }

  async upsertMatches(competitionId: string, matches: SyncMatch[]): Promise<{ inserted: number; updated: number }> {
    if (!matches.length) return { inserted: 0, updated: 0 };
    const existing = await this.listMatches(competitionId);
    const known = new Set(existing.map((m) => m.externalMatchId));
    const rows = matches.map((m) => ({
      competition_id: competitionId, external_match_id: m.externalMatchId,
      home_team: m.homeTeam, away_team: m.awayTeam, kickoff: m.kickoff,
      home_score: m.homeScore, away_score: m.awayScore, status: m.status, updated_at: new Date().toISOString(),
    }));
    // (competition_id, external_match_id) egyedi → ugyanaz a sync többször is futtatható duplikáció nélkül
    const { error } = await this.db.from('competition_matches').upsert(rows, { onConflict: 'competition_id,external_match_id' });
    this.fail('upsertMatches', error);
    const inserted = matches.filter((m) => !known.has(m.externalMatchId)).length;
    return { inserted, updated: matches.length - inserted };
  }

  async listMatches(competitionId: string): Promise<CompetitionMatch[]> {
    const { data, error } = await this.db.from('competition_matches').select('*')
      .eq('competition_id', competitionId).order('kickoff', { ascending: true });
    this.fail('listMatches', error);
    return (data ?? []).map(toMatch);
  }

  async getMatch(id: string): Promise<CompetitionMatch | null> {
    const { data, error } = await this.db.from('competition_matches').select('*').eq('id', id).maybeSingle();
    this.fail('getMatch', error);
    return data ? toMatch(data) : null;
  }

  async getMatchesByIds(ids: string[]): Promise<CompetitionMatch[]> {
    if (!ids.length) return [];
    const { data, error } = await this.db.from('competition_matches').select('*')
      .in('id', [...new Set(ids)]).order('kickoff', { ascending: true });
    this.fail('getMatchesByIds', error);
    return (data ?? []).map(toMatch);
  }

  async upsertPrediction(userId: string, competitionMatchId: string, home: number, away: number): Promise<UserPrediction> {
    const { data, error } = await this.db.from('user_predictions').upsert({
      user_id: userId, competition_match_id: competitionMatchId,
      predicted_home_score: home, predicted_away_score: away, updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,competition_match_id' }).select('*').single();
    this.fail('upsertPrediction', error);
    return toPrediction(data!);
  }

  /**
   * Atomikus beküldés a 0008 migrációban létrehozott SQL-függvénnyel.
   * A függvénytörzs egy tranzakcióban fut és user-szintű advisory lockot fog,
   * ezért a párhuzamos kérések nem tudják átlépni a napi limitet.
   * A limitet és a napablakot MI adjuk be – az üzleti szabály nem az adatbázisban lakik.
   */
  async createOrUpdatePrediction(
    userId: string, competitionMatchId: string, home: number, away: number,
    dailyLimit: number | null, window: DayWindow,
  ): Promise<PredictionSubmitResult> {
    const { data, error } = await this.db.rpc('submit_competition_prediction', {
      p_user_id: userId,
      p_match_id: competitionMatchId,
      p_home: home,
      p_away: away,
      p_daily_limit: dailyLimit,
      p_day_start: window.start,
      p_day_end: window.end,
    });
    this.fail('createOrUpdatePrediction', error);
    const r = (data ?? {}) as { outcome?: string; used?: number; prediction?: Row | null };
    if (r.outcome !== 'created' && r.outcome !== 'updated' && r.outcome !== 'limit_reached') {
      throw new Error(`[competition] createOrUpdatePrediction: váratlan válasz (${JSON.stringify(data)})`);
    }
    return {
      outcome: r.outcome,
      used: r.used ?? 0,
      prediction: r.prediction ? toPrediction(r.prediction) : null,
    };
  }

  async countPredictionsCreatedIn(userId: string, window: DayWindow): Promise<number> {
    const { count, error } = await this.db.from('user_predictions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('submitted_at', window.start)
      .lt('submitted_at', window.end);
    this.fail('countPredictionsCreatedIn', error);
    return count ?? 0;
  }

  async getPrediction(userId: string, competitionMatchId: string): Promise<UserPrediction | null> {
    const { data, error } = await this.db.from('user_predictions').select('*')
      .eq('user_id', userId).eq('competition_match_id', competitionMatchId).maybeSingle();
    this.fail('getPrediction', error);
    return data ? toPrediction(data) : null;
  }

  async listPredictionsForUser(userId: string, competitionId: string): Promise<UserPrediction[]> {
    const ids = (await this.listMatches(competitionId)).map((m) => m.id);
    if (!ids.length) return [];
    const { data, error } = await this.db.from('user_predictions').select('*')
      .eq('user_id', userId).in('competition_match_id', ids);
    this.fail('listPredictionsForUser', error);
    return (data ?? []).map(toPrediction);
  }

  async listPredictionsForCompetition(competitionId: string): Promise<UserPrediction[]> {
    const ids = (await this.listMatches(competitionId)).map((m) => m.id);
    if (!ids.length) return [];
    const { data, error } = await this.db.from('user_predictions').select('*').in('competition_match_id', ids);
    this.fail('listPredictionsForCompetition', error);
    return (data ?? []).map(toPrediction);
  }

  async setPredictionPoints(id: string, points: number): Promise<void> {
    const { error } = await this.db.from('user_predictions').update({ points }).eq('id', id);
    this.fail('setPredictionPoints', error);
  }

  async createRewardIfAbsent(r: NewReward): Promise<boolean> {
    // (competition_id, placement) egyedi → a lezárás többszöri hívása sem hoz létre dupla jutalmat
    const { data, error } = await this.db.from('competition_rewards')
      .upsert({
        competition_id: r.competitionId, user_id: r.userId, placement: r.placement,
        reward_type: r.rewardType, reward_label: r.rewardLabel, status: 'pending',
      }, { onConflict: 'competition_id,placement', ignoreDuplicates: true })
      .select('id').maybeSingle();
    this.fail('createRewardIfAbsent', error);
    return !!data;
  }

  async listRewards(competitionId: string): Promise<CompetitionReward[]> {
    const { data, error } = await this.db.from('competition_rewards').select('*')
      .eq('competition_id', competitionId).order('placement', { ascending: true });
    this.fail('listRewards', error);
    return (data ?? []).map(toReward);
  }

  async setRewardStatus(competitionId: string, rewardId: string, status: RewardStatus): Promise<CompetitionReward | null> {
    const { data, error } = await this.db.from('competition_rewards').update({ status })
      .eq('id', rewardId).eq('competition_id', competitionId).select('*').maybeSingle();
    this.fail('setRewardStatus', error);
    return data ? toReward(data) : null;
  }
}

// ============================================================================
// SQLite (helyi fejlesztés / tesztek)
// ============================================================================

export class SqliteCompetitionStore implements CompetitionStore {
  readonly kind = 'sqlite' as const;

  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS competition_rounds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        league_key TEXT NOT NULL,
        league_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS competition_matches (
        id TEXT PRIMARY KEY,
        competition_id TEXT NOT NULL,
        external_match_id TEXT NOT NULL,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        kickoff TEXT NOT NULL,
        home_score INTEGER,
        away_score INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (competition_id, external_match_id)
      );
      CREATE INDEX IF NOT EXISTS idx_comp_matches ON competition_matches(competition_id, kickoff);
      CREATE TABLE IF NOT EXISTS user_predictions (
        id TEXT PRIMARY KEY,
        competition_match_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        predicted_home_score INTEGER NOT NULL,
        predicted_away_score INTEGER NOT NULL,
        points INTEGER,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, competition_match_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_pred_match ON user_predictions(competition_match_id);
      CREATE TABLE IF NOT EXISTS competition_rewards (
        id TEXT PRIMARY KEY,
        competition_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        placement INTEGER NOT NULL,
        reward_type TEXT NOT NULL,
        reward_label TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (competition_id, placement),
        UNIQUE (competition_id, user_id)
      );
    `);
  }

  async healthCheck(): Promise<string[]> { return []; }

  async createCompetition(c: NewCompetition): Promise<Competition> {
    const now = new Date().toISOString();
    const row: Competition = {
      id: randomUUID(), name: c.name, leagueKey: c.leagueKey, leagueName: c.leagueName, provider: c.provider,
      startsAt: iso(c.startsAt), endsAt: iso(c.endsAt), status: c.status, createdAt: now, updatedAt: now,
    };
    this.db.prepare(`INSERT INTO competition_rounds
      (id, name, league_key, league_name, provider, starts_at, ends_at, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.name, row.leagueKey, row.leagueName, row.provider, row.startsAt, row.endsAt, row.status, now, now);
    return row;
  }

  async listCompetitions(statuses?: CompetitionStatus[]): Promise<Competition[]> {
    const rows = statuses?.length
      ? this.db.prepare(`SELECT * FROM competition_rounds WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY starts_at DESC`).all(...statuses) as Row[]
      : this.db.prepare('SELECT * FROM competition_rounds ORDER BY starts_at DESC').all() as Row[];
    return rows.map(toCompetition);
  }

  async getCompetition(id: string): Promise<Competition | null> {
    const r = this.db.prepare('SELECT * FROM competition_rounds WHERE id = ?').get(id) as Row | undefined;
    return r ? toCompetition(r) : null;
  }

  async setCompetitionStatus(id: string, to: CompetitionStatus, from: CompetitionStatus[]): Promise<Competition | null> {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE competition_rounds SET status = ?, updated_at = ?
      WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).run(to, now, id, ...from);
    const fresh = await this.getCompetition(id);
    return fresh && fresh.status === to ? fresh : null;
  }

  async upsertMatches(competitionId: string, matches: SyncMatch[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0, updated = 0;
    const now = new Date().toISOString();
    for (const m of matches) {
      const existing = this.db.prepare('SELECT id FROM competition_matches WHERE competition_id = ? AND external_match_id = ?')
        .get(competitionId, m.externalMatchId) as Row | undefined;
      if (existing) {
        this.db.prepare(`UPDATE competition_matches
          SET home_team = ?, away_team = ?, kickoff = ?, home_score = ?, away_score = ?, status = ?, updated_at = ?
          WHERE id = ?`)
          .run(m.homeTeam, m.awayTeam, iso(m.kickoff), m.homeScore, m.awayScore, m.status, now, existing.id);
        updated++;
      } else {
        this.db.prepare(`INSERT INTO competition_matches
          (id, competition_id, external_match_id, home_team, away_team, kickoff, home_score, away_score, status, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(randomUUID(), competitionId, m.externalMatchId, m.homeTeam, m.awayTeam, iso(m.kickoff), m.homeScore, m.awayScore, m.status, now, now);
        inserted++;
      }
    }
    return { inserted, updated };
  }

  async listMatches(competitionId: string): Promise<CompetitionMatch[]> {
    const rows = this.db.prepare('SELECT * FROM competition_matches WHERE competition_id = ? ORDER BY kickoff ASC').all(competitionId) as Row[];
    return rows.map(toMatch);
  }

  async getMatch(id: string): Promise<CompetitionMatch | null> {
    const r = this.db.prepare('SELECT * FROM competition_matches WHERE id = ?').get(id) as Row | undefined;
    return r ? toMatch(r) : null;
  }

  async upsertPrediction(userId: string, competitionMatchId: string, home: number, away: number): Promise<UserPrediction> {
    const now = new Date().toISOString();
    // ON CONFLICT: egy felhasználónak egy meccsre egy tippje van – a második beküldés MÓDOSÍT, nem duplikál
    this.db.prepare(`INSERT INTO user_predictions
      (id, competition_match_id, user_id, predicted_home_score, predicted_away_score, points, submitted_at, updated_at)
      VALUES (?,?,?,?,?,NULL,?,?)
      ON CONFLICT (user_id, competition_match_id) DO UPDATE SET
        predicted_home_score = excluded.predicted_home_score,
        predicted_away_score = excluded.predicted_away_score,
        updated_at = excluded.updated_at`)
      .run(randomUUID(), competitionMatchId, userId, home, away, now, now);
    const fresh = await this.getPrediction(userId, competitionMatchId);
    return fresh!;
  }

  async getMatchesByIds(ids: string[]): Promise<CompetitionMatch[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    const rows = this.db.prepare(
      `SELECT * FROM competition_matches WHERE id IN (${unique.map(() => '?').join(',')}) ORDER BY kickoff ASC`,
    ).all(...unique) as Row[];
    return rows.map(toMatch);
  }

  /**
   * Atomikus beküldés helyi tárolón.
   *
   * MIÉRT ATOMIKUS: a `node:sqlite` API szinkron, és ebben a metódusban a döntés és
   * az írás között NINCS await-pont, ezért az egyprocesszes Node eseményciklusa nem
   * tud közéfűzni másik kérést. A beszúrás ráadásul EGYETLEN utasítás, amelynek
   * WHERE feltétele maga a kvóta-ellenőrzés, így a számlálás és az írás elválaszthatatlan.
   * Ugyanarra a mérkőzésre a (user_id, competition_match_id) UNIQUE index zárja ki a duplikációt.
   */
  async createOrUpdatePrediction(
    userId: string, competitionMatchId: string, home: number, away: number,
    dailyLimit: number | null, window: DayWindow,
  ): Promise<PredictionSubmitResult> {
    const countToday = (): number => (this.db
      .prepare('SELECT COUNT(*) AS n FROM user_predictions WHERE user_id = ? AND submitted_at >= ? AND submitted_at < ?')
      .get(userId, window.start, window.end) as Row).n as number;

    const existing = this.db
      .prepare('SELECT id FROM user_predictions WHERE user_id = ? AND competition_match_id = ?')
      .get(userId, competitionMatchId) as Row | undefined;

    // 1) Módosítás – a kvóta nem fogy, a submitted_at és a points érintetlen
    if (existing) {
      this.db.prepare(`UPDATE user_predictions
          SET predicted_home_score = ?, predicted_away_score = ?, updated_at = ?
        WHERE id = ?`)
        .run(home, away, new Date().toISOString(), existing.id as string);
      return { outcome: 'updated', used: countToday(), prediction: await this.getPrediction(userId, competitionMatchId) };
    }

    // 2) Új tipp – a kvóta-ellenőrzés a beszúrás WHERE feltétele (egyetlen utasítás)
    const now = new Date().toISOString();
    const limit = dailyLimit ?? Number.MAX_SAFE_INTEGER;
    const res = this.db.prepare(`INSERT INTO user_predictions
        (id, competition_match_id, user_id, predicted_home_score, predicted_away_score, points, submitted_at, updated_at)
      SELECT ?, ?, ?, ?, ?, NULL, ?, ?
       WHERE (SELECT COUNT(*) FROM user_predictions
               WHERE user_id = ? AND submitted_at >= ? AND submitted_at < ?) < ?`)
      .run(randomUUID(), competitionMatchId, userId, home, away, now, now,
           userId, window.start, window.end, limit);

    if (res.changes === 0) return { outcome: 'limit_reached', used: countToday(), prediction: null };
    return { outcome: 'created', used: countToday(), prediction: await this.getPrediction(userId, competitionMatchId) };
  }

  async countPredictionsCreatedIn(userId: string, window: DayWindow): Promise<number> {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM user_predictions WHERE user_id = ? AND submitted_at >= ? AND submitted_at < ?')
      .get(userId, window.start, window.end) as Row;
    return r.n as number;
  }

  async getPrediction(userId: string, competitionMatchId: string): Promise<UserPrediction | null> {
    const r = this.db.prepare('SELECT * FROM user_predictions WHERE user_id = ? AND competition_match_id = ?')
      .get(userId, competitionMatchId) as Row | undefined;
    return r ? toPrediction(r) : null;
  }

  async listPredictionsForUser(userId: string, competitionId: string): Promise<UserPrediction[]> {
    const rows = this.db.prepare(`SELECT p.* FROM user_predictions p
      JOIN competition_matches m ON m.id = p.competition_match_id
      WHERE p.user_id = ? AND m.competition_id = ?`).all(userId, competitionId) as Row[];
    return rows.map(toPrediction);
  }

  async listPredictionsForCompetition(competitionId: string): Promise<UserPrediction[]> {
    const rows = this.db.prepare(`SELECT p.* FROM user_predictions p
      JOIN competition_matches m ON m.id = p.competition_match_id
      WHERE m.competition_id = ?`).all(competitionId) as Row[];
    return rows.map(toPrediction);
  }

  async setPredictionPoints(id: string, points: number): Promise<void> {
    this.db.prepare('UPDATE user_predictions SET points = ?, updated_at = ? WHERE id = ?')
      .run(points, new Date().toISOString(), id);
  }

  async createRewardIfAbsent(r: NewReward): Promise<boolean> {
    const existing = this.db.prepare('SELECT id FROM competition_rewards WHERE competition_id = ? AND (placement = ? OR user_id = ?)')
      .get(r.competitionId, r.placement, r.userId) as Row | undefined;
    if (existing) return false;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO competition_rewards
      (id, competition_id, user_id, placement, reward_type, reward_label, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), r.competitionId, r.userId, r.placement, r.rewardType, r.rewardLabel, 'pending', now, now);
    return true;
  }

  async listRewards(competitionId: string): Promise<CompetitionReward[]> {
    const rows = this.db.prepare('SELECT * FROM competition_rewards WHERE competition_id = ? ORDER BY placement ASC').all(competitionId) as Row[];
    return rows.map(toReward);
  }

  async setRewardStatus(competitionId: string, rewardId: string, status: RewardStatus): Promise<CompetitionReward | null> {
    this.db.prepare('UPDATE competition_rewards SET status = ?, updated_at = ? WHERE id = ? AND competition_id = ?')
      .run(status, new Date().toISOString(), rewardId, competitionId);
    const r = this.db.prepare('SELECT * FROM competition_rewards WHERE id = ? AND competition_id = ?')
      .get(rewardId, competitionId) as Row | undefined;
    return r ? toReward(r) : null;
  }
}
