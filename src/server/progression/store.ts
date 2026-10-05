/**
 * Progression tároló réteg – a Tippverseny tárolótól FÜGGETLEN, saját táblákkal.
 * A meglévő competition/appStore logikához nem nyúl, csak OLVASSA a már meglévő
 * user_predictions és competition_rewards adatokat a statisztikákhoz (nincs duplikáció).
 *
 *  - PostgresProgressionStore : Supabase PostgreSQL service_role kulccsal (éles)
 *  - SqliteProgressionStore   : helyi tartalék és teszt-tároló (node:sqlite)
 *
 * Idempotencia: az XP-eseményeket az (user_id, type, source_key) egyediség védi,
 * az achievementeket az (user_id, achievement_key) egyediség – mindkettő adatbázis szintű.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ProfileSettings, SettledPrediction } from '../../shared/progression';

export type ProgressionEventType = 'prediction' | 'streak_bonus' | 'exact_milestone' | 'placement';

export interface UnlockedAchievement { key: string; unlockedAt: string }
export interface Placement { competitionId: string; placement: number }

export interface ProgressionStore {
  readonly kind: 'postgres' | 'sqlite';
  healthCheck(): Promise<string[]>;

  /** A felhasználó összes XP-je (az események összege – egyetlen forrás). */
  totalXp(userId: string): Promise<number>;
  /**
   * XP-esemény rögzítése, ha még nincs. true = most jött létre (XP járt),
   * false = már létezett (ismételt kiértékelés – nem jár újra XP).
   */
  claimEvent(userId: string, type: ProgressionEventType, sourceKey: string, xp: number): Promise<boolean>;

  listAchievements(userId: string): Promise<UnlockedAchievement[]>;
  /** true = most oldódott fel; false = már megvolt. */
  unlockAchievement(userId: string, key: string): Promise<boolean>;

  getSettings(userId: string): Promise<ProfileSettings | null>;
  saveSettings(userId: string, settings: ProfileSettings): Promise<void>;

  /** A felhasználó KIÉRTÉKELT tippjei a liga-kulccsal és a kezdési idővel (statisztikához). */
  settledPredictions(userId: string): Promise<SettledPrediction[]>;
  /** A felhasználó dobogós helyezései a már meglévő competition_rewards táblából. */
  placements(userId: string): Promise<Placement[]>;
}

type Row = Record<string, any>;

// ============================================================================
// Supabase PostgreSQL (éles)
// ============================================================================

export class PostgresProgressionStore implements ProgressionStore {
  readonly kind = 'postgres' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`[progression] ${op}: ${error.message}`);
  }

  async healthCheck(): Promise<string[]> {
    const missing: string[] = [];
    for (const t of ['progression_events', 'user_achievements', 'user_profile_settings']) {
      const { error } = await this.db.from(t).select('*').limit(1);
      if (error) missing.push(`${t} (${error.message})`);
    }
    return missing;
  }

  async totalXp(userId: string): Promise<number> {
    const { data, error } = await this.db.from('progression_events').select('xp').eq('user_id', userId);
    this.fail('totalXp', error);
    return (data ?? []).reduce((a: number, r: Row) => a + (r.xp ?? 0), 0);
  }

  async claimEvent(userId: string, type: ProgressionEventType, sourceKey: string, xp: number): Promise<boolean> {
    // ON CONFLICT DO NOTHING: ugyanaz a forrás sosem adhat XP-t kétszer
    const { data, error } = await this.db.from('progression_events')
      .upsert({ user_id: userId, type, source_key: sourceKey, xp }, { onConflict: 'user_id,type,source_key', ignoreDuplicates: true })
      .select('id').maybeSingle();
    this.fail('claimEvent', error);
    return !!data;
  }

  async listAchievements(userId: string): Promise<UnlockedAchievement[]> {
    const { data, error } = await this.db.from('user_achievements')
      .select('achievement_key, unlocked_at').eq('user_id', userId).order('unlocked_at', { ascending: true });
    this.fail('listAchievements', error);
    return (data ?? []).map((r: Row) => ({ key: r.achievement_key, unlockedAt: new Date(r.unlocked_at).toISOString() }));
  }

  async unlockAchievement(userId: string, key: string): Promise<boolean> {
    const { data, error } = await this.db.from('user_achievements')
      .upsert({ user_id: userId, achievement_key: key }, { onConflict: 'user_id,achievement_key', ignoreDuplicates: true })
      .select('id').maybeSingle();
    this.fail('unlockAchievement', error);
    return !!data;
  }

  async getSettings(userId: string): Promise<ProfileSettings | null> {
    const { data, error } = await this.db.from('user_profile_settings')
      .select('avatar, border_key, title_key, showcase').eq('user_id', userId).maybeSingle();
    this.fail('getSettings', error);
    if (!data) return null;
    return {
      avatar: (data.avatar ?? {}) as ProfileSettings['avatar'],
      border: data.border_key, title: data.title_key, showcase: data.showcase ?? [],
    };
  }

  async saveSettings(userId: string, s: ProfileSettings): Promise<void> {
    const { error } = await this.db.from('user_profile_settings').upsert({
      user_id: userId, avatar: s.avatar, border_key: s.border, title_key: s.title, showcase: s.showcase,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    this.fail('saveSettings', error);
  }

  async settledPredictions(userId: string): Promise<SettledPrediction[]> {
    // A liga-kulcs a versenyből jön: user_predictions → competition_matches → competition_rounds
    const { data, error } = await this.db.from('user_predictions')
      .select('id, points, competition_matches!inner(kickoff, competition_rounds!inner(league_key))')
      .eq('user_id', userId).not('points', 'is', null);
    this.fail('settledPredictions', error);
    return (data ?? []).map((r: Row) => {
      const m = Array.isArray(r.competition_matches) ? r.competition_matches[0] : r.competition_matches;
      const c = Array.isArray(m?.competition_rounds) ? m.competition_rounds[0] : m?.competition_rounds;
      return {
        predictionId: r.id as string,
        points: r.points as number,
        kickoff: new Date(m?.kickoff ?? 0).toISOString(),
        leagueKey: (c?.league_key ?? '') as string,
      };
    });
  }

  async placements(userId: string): Promise<Placement[]> {
    const { data, error } = await this.db.from('competition_rewards')
      .select('competition_id, placement').eq('user_id', userId);
    this.fail('placements', error);
    return (data ?? []).map((r: Row) => ({ competitionId: r.competition_id, placement: r.placement }));
  }
}

// ============================================================================
// SQLite (helyi fejlesztés / tesztek)
// ============================================================================

export class SqliteProgressionStore implements ProgressionStore {
  readonly kind = 'sqlite' as const;

  constructor(private db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS progression_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        source_key TEXT NOT NULL,
        xp INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, type, source_key)
      );
      CREATE INDEX IF NOT EXISTS idx_prog_events_user ON progression_events(user_id);
      CREATE TABLE IF NOT EXISTS user_achievements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        achievement_key TEXT NOT NULL,
        unlocked_at TEXT NOT NULL,
        UNIQUE (user_id, achievement_key)
      );
      CREATE TABLE IF NOT EXISTS user_profile_settings (
        user_id TEXT PRIMARY KEY,
        avatar TEXT NOT NULL,
        border_key TEXT NOT NULL,
        title_key TEXT NOT NULL,
        showcase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async healthCheck(): Promise<string[]> { return []; }

  async totalXp(userId: string): Promise<number> {
    const r = this.db.prepare('SELECT COALESCE(SUM(xp), 0) AS total FROM progression_events WHERE user_id = ?').get(userId) as Row;
    return Number(r?.total ?? 0);
  }

  async claimEvent(userId: string, type: ProgressionEventType, sourceKey: string, xp: number): Promise<boolean> {
    // ATOMI: nincs „megnézem, aztán beszúrom" lépés – az egyedi index dönt, a changes mondja meg, nyertünk-e
    const r = this.db.prepare(`INSERT INTO progression_events (id, user_id, type, source_key, xp, created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT (user_id, type, source_key) DO NOTHING`)
      .run(randomUUID(), userId, type, sourceKey, xp, new Date().toISOString());
    return Number(r.changes) > 0;
  }

  async listAchievements(userId: string): Promise<UnlockedAchievement[]> {
    const rows = this.db.prepare('SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id = ? ORDER BY unlocked_at ASC').all(userId) as Row[];
    return rows.map((r) => ({ key: r.achievement_key, unlockedAt: r.unlocked_at }));
  }

  async unlockAchievement(userId: string, key: string): Promise<boolean> {
    // ATOMI: az (user_id, achievement_key) egyedi index zárja ki a duplikátumot
    const r = this.db.prepare(`INSERT INTO user_achievements (id, user_id, achievement_key, unlocked_at)
      VALUES (?,?,?,?) ON CONFLICT (user_id, achievement_key) DO NOTHING`)
      .run(randomUUID(), userId, key, new Date().toISOString());
    return Number(r.changes) > 0;
  }

  async getSettings(userId: string): Promise<ProfileSettings | null> {
    const r = this.db.prepare('SELECT avatar, border_key, title_key, showcase FROM user_profile_settings WHERE user_id = ?').get(userId) as Row | undefined;
    if (!r) return null;
    return {
      avatar: JSON.parse(r.avatar || '{}'),
      border: r.border_key,
      title: r.title_key,
      showcase: JSON.parse(r.showcase || '[]'),
    };
  }

  async saveSettings(userId: string, s: ProfileSettings): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO user_profile_settings (user_id, avatar, border_key, title_key, showcase, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (user_id) DO UPDATE SET
        avatar = excluded.avatar, border_key = excluded.border_key,
        title_key = excluded.title_key, showcase = excluded.showcase, updated_at = excluded.updated_at`)
      .run(userId, JSON.stringify(s.avatar), s.border, s.title, JSON.stringify(s.showcase), now, now);
  }

  async settledPredictions(userId: string): Promise<SettledPrediction[]> {
    const rows = this.db.prepare(`
      SELECT p.id AS id, p.points AS points, m.kickoff AS kickoff, c.league_key AS league_key
      FROM user_predictions p
      JOIN competition_matches m ON m.id = p.competition_match_id
      JOIN competition_rounds c ON c.id = m.competition_id
      WHERE p.user_id = ? AND p.points IS NOT NULL`).all(userId) as Row[];
    return rows.map((r) => ({ predictionId: r.id, points: Number(r.points), kickoff: r.kickoff, leagueKey: r.league_key }));
  }

  async placements(userId: string): Promise<Placement[]> {
    const rows = this.db.prepare('SELECT competition_id, placement FROM competition_rewards WHERE user_id = ?').all(userId) as Row[];
    return rows.map((r) => ({ competitionId: r.competition_id, placement: Number(r.placement) }));
  }
}
