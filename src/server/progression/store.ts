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
import type { PredictionRecordRow, ProfileSettings, SettledPrediction } from '../../shared/progression';
import { EMPTY_EQUIPS, PROFILE_SLOTS, type ProfileSlot, type ShopEquips } from '../../shared/shop';

export type ProgressionEventType = 'prediction' | 'streak_bonus' | 'exact_milestone' | 'placement' | 'mission';

export interface UnlockedAchievement { key: string; unlockedAt: string }

export interface MissionClaim { missionKey: string; periodKey: string; progress: number; xpAwarded: number; claimedAt: string }
export interface NewMissionClaim { userId: string; missionKey: string; periodKey: string; periodType: 'daily' | 'weekly'; progress: number; xpAwarded: number }
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

  /**
   * A felhasználó ÖSSZES tippje (a még ki nem értékeltekkel együtt), a mérkőzés és a
   * liga adataival – a statisztika és az előzmény ebből áll elő, EGY lekérdezéssel.
   */
  allPredictions(userId: string): Promise<PredictionRecordRow[]>;
  /** Tippenként ténylegesen jóváírt XP az XP-naplóból (prediction típusú események). */
  predictionXp(userId: string): Promise<Map<string, number>>;

  // --- Küldetések: CSAK a jutalom átvételének ténye tárolódik (a haladás számított) ---
  /** A megadott periódus-kulcsokhoz tartozó átvételek (mission_key → rekord). */
  missionClaims(userId: string, periodKeys: string[]): Promise<Map<string, MissionClaim>>;
  /**
   * Jutalom átvételének rögzítése, ha még nincs. true = most jött létre,
   * false = már átvette (ismételt kérés – nem jár újra jutalom).
   */
  claimMission(c: NewMissionClaim): Promise<boolean>;

  // --- Kötegelt olvasások: a ranglista EGYSZER kéri le az összes résztvevő adatát.
  //     Így a megjelenítendő profilok száma nem növeli a lekérdezések számát (nincs N+1).
  getSettingsMany(userIds: string[]): Promise<Map<string, ProfileSettings>>;

  // --- Shop-kozmetikumok FELVÉTELE (0012) ---------------------------------
  // KÜLÖN oszlopok a megszolgált testreszabástól: a shop sosem írja felül a
  // `border_key`, `title_key` vagy `avatar` mezőt, és fordítva sem.

  /** A felhasználó felvett shop itemei slotonként (nincs sor → minden null). */
  getShopEquips(userId: string): Promise<ShopEquips>;
  /** Kötegelt olvasás a ranglistához (nincs N+1). */
  getShopEquipsMany(userIds: string[]): Promise<Map<string, ShopEquips>>;
  /**
   * A felvett shop itemek mentése EGY írással. A megszolgált testreszabás
   * mezőihez nem nyúl – ha a felhasználónak még nincs sora, az alapértelmezett
   * megszolgált értékekkel jön létre.
   */
  saveShopEquips(userId: string, equips: ShopEquips): Promise<void>;
  listAchievementsMany(userIds: string[]): Promise<Map<string, string[]>>;
  totalXpMany(userIds: string[]): Promise<Map<string, number>>;
  settledPredictionsMany(userIds: string[]): Promise<Map<string, SettledPrediction[]>>;
  placementsMany(userIds: string[]): Promise<Map<string, Placement[]>>;
}

/**
 * A hat shop-equip oszlop és a slotok megfeleltetése. A MEGSZOLGÁLT
 * kozmetikumok oszlopait (avatar, border_key, title_key, showcase) ez a
 * leképezés nem érinti – a két rendszer szándékosan külön oszlopokban él.
 */
const EQUIP_COLUMN: Record<ProfileSlot, string> = {
  frame: 'shop_frame_key',
  nameColor: 'shop_name_color_key',
  nameEffect: 'shop_name_effect_key',
  title: 'shop_title_key',
  avatar: 'shop_avatar_key',
  profileBackground: 'shop_profile_background_key',
};

const EQUIP_COLUMNS = Object.values(EQUIP_COLUMN);

/** Egy sor shop-oszlopaiból `ShopEquips` (ismeretlen/üres érték → null). */
function toEquips(r: Row | null | undefined): ShopEquips {
  const out: ShopEquips = { ...EMPTY_EQUIPS };
  if (!r) return out;
  for (const slot of PROFILE_SLOTS) {
    const v = r[EQUIP_COLUMN[slot]];
    out[slot] = typeof v === 'string' && v ? v : null;
  }
  return out;
}

/** `ShopEquips` → adatbázis-oszlopok. */
function fromEquips(e: ShopEquips): Record<string, string | null> {
  const row: Record<string, string | null> = {};
  for (const slot of PROFILE_SLOTS) row[EQUIP_COLUMN[slot]] = e[slot];
  return row;
}

/** Üres kötegelt eredmény – üres bemenetre felesleges lekérdezni. */
const emptyMap = <T>(): Map<string, T> => new Map<string, T>();

/** Sorok csoportosítása felhasználónként. */
function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
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
    for (const t of ['progression_events', 'user_achievements', 'user_profile_settings', 'mission_claims']) {
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

  async getShopEquips(userId: string): Promise<ShopEquips> {
    const { data, error } = await this.db.from('user_profile_settings')
      .select(EQUIP_COLUMNS.join(', ')).eq('user_id', userId).maybeSingle();
    this.fail('getShopEquips', error);
    return toEquips(data as Row | null);
  }

  async getShopEquipsMany(userIds: string[]): Promise<Map<string, ShopEquips>> {
    if (!userIds.length) return emptyMap();
    const { data, error } = await this.db.from('user_profile_settings')
      .select(['user_id', ...EQUIP_COLUMNS].join(', ')).in('user_id', userIds);
    this.fail('getShopEquipsMany', error);
    const out = new Map<string, ShopEquips>();
    for (const r of (data ?? []) as Row[]) out.set(r.user_id, toEquips(r));
    return out;
  }

  async saveShopEquips(userId: string, equips: ShopEquips): Promise<void> {
    // A megszolgált mezőket NEM adjuk meg: ha a sor már létezik, változatlanok
    // maradnak; ha most jön létre, a tábla alapértelmezéseit kapják.
    const { error } = await this.db.from('user_profile_settings').upsert({
      user_id: userId, ...fromEquips(equips), updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    this.fail('saveShopEquips', error);
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

  async allPredictions(userId: string): Promise<PredictionRecordRow[]> {
    // Egyetlen lekérdezés, beágyazott kapcsolatokkal: tipp → meccs → verseny
    const { data, error } = await this.db.from('user_predictions')
      .select(`id, points, predicted_home_score, predicted_away_score, submitted_at,
        competition_matches!inner(id, home_team, away_team, kickoff, home_score, away_score, status,
          competition_rounds!inner(id, name, league_key, league_name))`)
      .eq('user_id', userId);
    this.fail('allPredictions', error);
    return (data ?? []).map((r: Row) => {
      const m = Array.isArray(r.competition_matches) ? r.competition_matches[0] : r.competition_matches;
      const c = Array.isArray(m?.competition_rounds) ? m.competition_rounds[0] : m?.competition_rounds;
      return {
        predictionId: r.id as string,
        competitionId: (c?.id ?? '') as string,
        competitionName: (c?.name ?? '') as string,
        leagueKey: (c?.league_key ?? '') as string,
        leagueName: (c?.league_name ?? '') as string,
        homeTeam: (m?.home_team ?? '') as string,
        awayTeam: (m?.away_team ?? '') as string,
        kickoff: new Date(m?.kickoff ?? 0).toISOString(),
        matchStatus: (m?.status ?? 'scheduled') as string,
        predictedHome: r.predicted_home_score as number,
        predictedAway: r.predicted_away_score as number,
        actualHome: m?.home_score ?? null,
        actualAway: m?.away_score ?? null,
        points: r.points ?? null,
        submittedAt: new Date(r.submitted_at).toISOString(),
      };
    });
  }

  async predictionXp(userId: string): Promise<Map<string, number>> {
    const { data, error } = await this.db.from('progression_events')
      .select('source_key, xp').eq('user_id', userId).eq('type', 'prediction');
    this.fail('predictionXp', error);
    const out = new Map<string, number>();
    for (const r of (data ?? []) as Row[]) out.set(r.source_key, (out.get(r.source_key) ?? 0) + (r.xp ?? 0));
    return out;
  }

  async missionClaims(userId: string, periodKeys: string[]): Promise<Map<string, MissionClaim>> {
    const out = new Map<string, MissionClaim>();
    if (!periodKeys.length) return out;
    const { data, error } = await this.db.from('mission_claims')
      .select('mission_key, period_key, progress, xp_awarded, claimed_at')
      .eq('user_id', userId).in('period_key', periodKeys);
    this.fail('missionClaims', error);
    for (const r of (data ?? []) as Row[]) {
      out.set(r.mission_key, {
        missionKey: r.mission_key, periodKey: r.period_key, progress: r.progress,
        xpAwarded: r.xp_awarded, claimedAt: new Date(r.claimed_at).toISOString(),
      });
    }
    return out;
  }

  async claimMission(c: NewMissionClaim): Promise<boolean> {
    // ON CONFLICT DO NOTHING: ugyanaz a küldetés ugyanabban a periódusban csak egyszer jutalmaz
    const { data, error } = await this.db.from('mission_claims')
      .upsert({
        user_id: c.userId, mission_key: c.missionKey, period_key: c.periodKey,
        period_type: c.periodType, progress: c.progress, xp_awarded: c.xpAwarded,
      }, { onConflict: 'user_id,mission_key,period_key', ignoreDuplicates: true })
      .select('id').maybeSingle();
    this.fail('claimMission', error);
    return !!data;
  }

  // ---------- Kötegelt olvasások (ranglista) ----------

  async getSettingsMany(userIds: string[]): Promise<Map<string, ProfileSettings>> {
    if (!userIds.length) return emptyMap();
    const { data, error } = await this.db.from('user_profile_settings')
      .select('user_id, avatar, border_key, title_key, showcase').in('user_id', userIds);
    this.fail('getSettingsMany', error);
    const out = new Map<string, ProfileSettings>();
    for (const r of (data ?? []) as Row[]) {
      out.set(r.user_id, { avatar: (r.avatar ?? {}) as ProfileSettings['avatar'], border: r.border_key, title: r.title_key, showcase: r.showcase ?? [] });
    }
    return out;
  }

  async listAchievementsMany(userIds: string[]): Promise<Map<string, string[]>> {
    if (!userIds.length) return emptyMap();
    const { data, error } = await this.db.from('user_achievements')
      .select('user_id, achievement_key').in('user_id', userIds);
    this.fail('listAchievementsMany', error);
    const out = new Map<string, string[]>();
    for (const r of (data ?? []) as Row[]) {
      const list = out.get(r.user_id);
      if (list) list.push(r.achievement_key); else out.set(r.user_id, [r.achievement_key]);
    }
    return out;
  }

  async totalXpMany(userIds: string[]): Promise<Map<string, number>> {
    if (!userIds.length) return emptyMap();
    const { data, error } = await this.db.from('progression_events').select('user_id, xp').in('user_id', userIds);
    this.fail('totalXpMany', error);
    const out = new Map<string, number>();
    for (const r of (data ?? []) as Row[]) out.set(r.user_id, (out.get(r.user_id) ?? 0) + (r.xp ?? 0));
    return out;
  }

  async settledPredictionsMany(userIds: string[]): Promise<Map<string, SettledPrediction[]>> {
    if (!userIds.length) return emptyMap();
    const { data, error } = await this.db.from('user_predictions')
      .select('id, user_id, points, competition_matches!inner(kickoff, competition_rounds!inner(league_key))')
      .in('user_id', userIds).not('points', 'is', null);
    this.fail('settledPredictionsMany', error);
    const rows = (data ?? []).map((r: Row) => {
      const m = Array.isArray(r.competition_matches) ? r.competition_matches[0] : r.competition_matches;
      const c = Array.isArray(m?.competition_rounds) ? m.competition_rounds[0] : m?.competition_rounds;
      return {
        userId: r.user_id as string,
        predictionId: r.id as string,
        points: r.points as number,
        kickoff: new Date(m?.kickoff ?? 0).toISOString(),
        leagueKey: (c?.league_key ?? '') as string,
      };
    });
    const grouped = groupBy(rows, (r) => r.userId);
    const out = new Map<string, SettledPrediction[]>();
    for (const [uid, list] of grouped) out.set(uid, list.map(({ userId, ...rest }) => rest));
    return out;
  }

  async placementsMany(userIds: string[]): Promise<Map<string, Placement[]>> {
    if (!userIds.length) return emptyMap();
    const { data, error } = await this.db.from('competition_rewards')
      .select('user_id, competition_id, placement').in('user_id', userIds);
    this.fail('placementsMany', error);
    const grouped = groupBy((data ?? []) as Row[], (r) => r.user_id);
    const out = new Map<string, Placement[]>();
    for (const [uid, list] of grouped) out.set(uid, list.map((r) => ({ competitionId: r.competition_id, placement: Number(r.placement) })));
    return out;
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
      CREATE TABLE IF NOT EXISTS mission_claims (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        mission_key TEXT NOT NULL,
        period_key TEXT NOT NULL,
        period_type TEXT NOT NULL,
        progress INTEGER NOT NULL,
        xp_awarded INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT NOT NULL,
        UNIQUE (user_id, mission_key, period_key)
      );
      CREATE TABLE IF NOT EXISTS user_profile_settings (
        user_id TEXT PRIMARY KEY,
        avatar TEXT NOT NULL,
        border_key TEXT NOT NULL,
        title_key TEXT NOT NULL,
        showcase TEXT NOT NULL,
        -- A 0012 migracio hat shop-oszlopa. NULL = ebben a slotban nincs
        -- felvett shop item. KULON a megszolgalt mezoktol.
        shop_frame_key TEXT,
        shop_name_color_key TEXT,
        shop_name_effect_key TEXT,
        shop_title_key TEXT,
        shop_avatar_key TEXT,
        shop_profile_background_key TEXT,
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

  async getShopEquips(userId: string): Promise<ShopEquips> {
    const r = this.db.prepare(
      `SELECT ${EQUIP_COLUMNS.join(', ')} FROM user_profile_settings WHERE user_id = ?`,
    ).get(userId) as Row | undefined;
    return toEquips(r);
  }

  async getShopEquipsMany(userIds: string[]): Promise<Map<string, ShopEquips>> {
    if (!userIds.length) return emptyMap();
    const rows = this.db.prepare(
      `SELECT user_id, ${EQUIP_COLUMNS.join(', ')} FROM user_profile_settings
        WHERE user_id IN (${this.marks(userIds.length)})`,
    ).all(...userIds) as Row[];
    const out = new Map<string, ShopEquips>();
    for (const r of rows) out.set(r.user_id as string, toEquips(r));
    return out;
  }

  async saveShopEquips(userId: string, equips: ShopEquips): Promise<void> {
    const now = new Date().toISOString();
    const cols = EQUIP_COLUMNS;
    const values = PROFILE_SLOTS.map((slot) => equips[slot]);
    // A megszolgalt mezoket NEM irjuk at: uj sornal az alapertelmezes kerul be,
    // letezo sornal csak a shop-oszlopok frissulnek.
    this.db.prepare(`INSERT INTO user_profile_settings
      (user_id, avatar, border_key, title_key, showcase, ${cols.join(', ')}, created_at, updated_at)
      VALUES (?, '{}', 'classic', 'none', '[]', ${cols.map(() => '?').join(', ')}, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`)
      .run(userId, ...values as never[], now, now);
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

  async allPredictions(userId: string): Promise<PredictionRecordRow[]> {
    const rows = this.db.prepare(`
      SELECT p.id AS id, p.points AS points, p.predicted_home_score AS ph, p.predicted_away_score AS pa,
             p.submitted_at AS submitted_at,
             m.home_team AS home_team, m.away_team AS away_team, m.kickoff AS kickoff,
             m.home_score AS home_score, m.away_score AS away_score, m.status AS match_status,
             c.id AS competition_id, c.name AS competition_name, c.league_key AS league_key, c.league_name AS league_name
      FROM user_predictions p
      JOIN competition_matches m ON m.id = p.competition_match_id
      JOIN competition_rounds c ON c.id = m.competition_id
      WHERE p.user_id = ?`).all(userId) as Row[];
    return rows.map((r) => ({
      predictionId: r.id,
      competitionId: r.competition_id,
      competitionName: r.competition_name,
      leagueKey: r.league_key,
      leagueName: r.league_name,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      kickoff: r.kickoff,
      matchStatus: r.match_status,
      predictedHome: Number(r.ph),
      predictedAway: Number(r.pa),
      actualHome: r.home_score == null ? null : Number(r.home_score),
      actualAway: r.away_score == null ? null : Number(r.away_score),
      points: r.points == null ? null : Number(r.points),
      submittedAt: r.submitted_at,
    }));
  }

  async predictionXp(userId: string): Promise<Map<string, number>> {
    const rows = this.db.prepare(
      "SELECT source_key, xp FROM progression_events WHERE user_id = ? AND type = 'prediction'").all(userId) as Row[];
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.source_key, (out.get(r.source_key) ?? 0) + Number(r.xp ?? 0));
    return out;
  }

  async missionClaims(userId: string, periodKeys: string[]): Promise<Map<string, MissionClaim>> {
    const out = new Map<string, MissionClaim>();
    if (!periodKeys.length) return out;
    const rows = this.db.prepare(`SELECT mission_key, period_key, progress, xp_awarded, claimed_at
      FROM mission_claims WHERE user_id = ? AND period_key IN (${periodKeys.map(() => '?').join(',')})`)
      .all(userId, ...periodKeys) as Row[];
    for (const r of rows) {
      out.set(r.mission_key, {
        missionKey: r.mission_key, periodKey: r.period_key, progress: Number(r.progress),
        xpAwarded: Number(r.xp_awarded), claimedAt: r.claimed_at,
      });
    }
    return out;
  }

  async claimMission(c: NewMissionClaim): Promise<boolean> {
    // ATOMI: az egyedi index dönt, a changes mondja meg, most jött-e létre
    const r = this.db.prepare(`INSERT INTO mission_claims
      (id, user_id, mission_key, period_key, period_type, progress, xp_awarded, claimed_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (user_id, mission_key, period_key) DO NOTHING`)
      .run(randomUUID(), c.userId, c.missionKey, c.periodKey, c.periodType, c.progress, c.xpAwarded, new Date().toISOString());
    return Number(r.changes) > 0;
  }

  // ---------- Kötegelt olvasások (ranglista) ----------

  /** Paraméter-helyőrzők az IN (…) listához. */
  private marks(n: number): string { return new Array(n).fill('?').join(','); }

  async getSettingsMany(userIds: string[]): Promise<Map<string, ProfileSettings>> {
    if (!userIds.length) return emptyMap();
    const rows = this.db.prepare(`SELECT user_id, avatar, border_key, title_key, showcase
      FROM user_profile_settings WHERE user_id IN (${this.marks(userIds.length)})`).all(...userIds) as Row[];
    const out = new Map<string, ProfileSettings>();
    for (const r of rows) {
      out.set(r.user_id, { avatar: JSON.parse(r.avatar || '{}'), border: r.border_key, title: r.title_key, showcase: JSON.parse(r.showcase || '[]') });
    }
    return out;
  }

  async listAchievementsMany(userIds: string[]): Promise<Map<string, string[]>> {
    if (!userIds.length) return emptyMap();
    const rows = this.db.prepare(`SELECT user_id, achievement_key FROM user_achievements
      WHERE user_id IN (${this.marks(userIds.length)})`).all(...userIds) as Row[];
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.user_id);
      if (list) list.push(r.achievement_key); else out.set(r.user_id, [r.achievement_key]);
    }
    return out;
  }

  async totalXpMany(userIds: string[]): Promise<Map<string, number>> {
    if (!userIds.length) return emptyMap();
    const rows = this.db.prepare(`SELECT user_id, COALESCE(SUM(xp), 0) AS total FROM progression_events
      WHERE user_id IN (${this.marks(userIds.length)}) GROUP BY user_id`).all(...userIds) as Row[];
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.user_id, Number(r.total ?? 0));
    return out;
  }

  async settledPredictionsMany(userIds: string[]): Promise<Map<string, SettledPrediction[]>> {
    if (!userIds.length) return emptyMap();
    const rows = this.db.prepare(`
      SELECT p.user_id AS user_id, p.id AS id, p.points AS points, m.kickoff AS kickoff, c.league_key AS league_key
      FROM user_predictions p
      JOIN competition_matches m ON m.id = p.competition_match_id
      JOIN competition_rounds c ON c.id = m.competition_id
      WHERE p.user_id IN (${this.marks(userIds.length)}) AND p.points IS NOT NULL`).all(...userIds) as Row[];
    const out = new Map<string, SettledPrediction[]>();
    for (const r of rows) {
      const item = { predictionId: r.id, points: Number(r.points), kickoff: r.kickoff, leagueKey: r.league_key };
      const list = out.get(r.user_id);
      if (list) list.push(item); else out.set(r.user_id, [item]);
    }
    return out;
  }

  async placementsMany(userIds: string[]): Promise<Map<string, Placement[]>> {
    if (!userIds.length) return emptyMap();
    const rows = this.db.prepare(`SELECT user_id, competition_id, placement FROM competition_rewards
      WHERE user_id IN (${this.marks(userIds.length)})`).all(...userIds) as Row[];
    const out = new Map<string, Placement[]>();
    for (const r of rows) {
      const item = { competitionId: r.competition_id, placement: Number(r.placement) };
      const list = out.get(r.user_id);
      if (list) list.push(item); else out.set(r.user_id, [item]);
    }
    return out;
  }
}
