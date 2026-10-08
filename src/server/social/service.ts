/**
 * Social üzleti logika – követés, játékos-keresés, Top Tipsterek.
 *
 * ELVEK:
 *  - a hívót KIZÁRÓLAG a hitelesített token azonosítja; a kérésből SOHA nem
 *    olvasunk ki `follower_user_id` / `userId` mezőt,
 *  - a célszemélyt a MEGJELENÍTÉSI NEVE azonosítja, ezért a nyilvános
 *    felületre nem kerül ki belső azonosító,
 *  - nincs második statisztika-számítás: a Top Tipsterek a MEGLÉVŐ
 *    `computeStats()`-ot és a meglévő kötegelt tároló-metódusokat használják,
 *  - a követés tisztán social: nem ad XP-t, coint, kozmetikumot, és semmilyen
 *    pontozást vagy ranglistát nem befolyásol.
 */
import { computeStats, levelFromXp } from '../../shared/progression';
import {
  MIN_PREDICTIONS_FOR_EXACT, MIN_SETTLED_FOR_ACCURACY, MIN_STREAK_FOR_FORM,
  TOP_CANDIDATE_LIMIT, TOP_CATEGORY_LABEL, TOP_COMPETITION_LIMIT, TOP_LIST_SIZE,
  tierForRank, toPlayerCard,
  type PlayerCard, type TopCategory, type TopTipsterEntry, type TopTipstersResponse,
} from '../../shared/social';
import type { PublicProfile } from '../../shared/competition';
import type { DisplayNameDirectory } from '../profile/displayNameDirectory';
import type { ProgressionStore } from '../progression/store';
import type { CompetitionStore } from '../competition/store';
import type { FollowStore } from './store';

/** Üzleti hiba, amiből a route-réteg HTTP státuszt képez (meglévő konvenció). */
export class SocialError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

const DEFAULT_PROFILE: PublicProfile = { avatar: {}, borderKey: 'classic', titleKey: 'none' };

export class SocialService {
  constructor(
    private follows: FollowStore,
    private names: DisplayNameDirectory,
    private progression: ProgressionStore,
    private competitions: CompetitionStore,
    /** Opcionális: a szerver által ellenőrzött kozmetikumok (ranglista-réteg). */
    private publicProfiles?: (userIds: string[]) => Promise<Map<string, PublicProfile>>,
  ) {}

  // -------------------------------------------------------------------------
  // Segédek
  // -------------------------------------------------------------------------

  /** Név → felhasználó. Ismeretlen név esetén egységes 404. */
  private async resolve(displayName: string): Promise<{ userId: string; displayName: string }> {
    const found = await this.names.findByName(displayName);
    if (!found) throw new SocialError('Nincs ilyen játékos.', 404, 'PLAYER_NOT_FOUND');
    return found;
  }

  private async profilesOf(userIds: string[]): Promise<Map<string, PublicProfile>> {
    if (!this.publicProfiles || !userIds.length) return new Map();
    try { return await this.publicProfiles(userIds); } catch { return new Map(); }
  }

  /**
   * Játékos-kártyák EGY menetben, kötegelt lekérdezésekkel. A lekérdezések
   * száma független a felhasználók számától – nincs N+1.
   */
  private async cardsFor(userIds: string[]): Promise<PlayerCard[]> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return [];

    const [names, xp, settled, profiles] = await Promise.all([
      this.names.getMany(unique),
      this.progression.totalXpMany(unique),
      this.progression.settledPredictionsMany(unique),
      this.profilesOf(unique),
    ]);

    const out: PlayerCard[] = [];
    for (const id of unique) {
      const displayName = names.get(id);
      if (!displayName) continue; // név nélküli felhasználó nem jelenik meg
      const rows = settled.get(id) ?? [];
      const correct = rows.filter((r) => r.points > 0).length;
      const level = levelFromXp(xp.get(id) ?? 0);
      const p = profiles.get(id) ?? DEFAULT_PROFILE;
      out.push(toPlayerCard({
        displayName,
        level: level.level,
        levelTier: level.tier,
        accuracy: rows.length ? correct / rows.length : null,
        avatar: p.avatar as Record<string, string>,
        borderKey: p.borderKey,
        titleKey: p.titleKey,
        shop: p.shop as Record<string, string | null> | undefined,
      }));
    }
    // A hívó sorrendjét megtartjuk (lapozás / rangsor)
    const byName = new Map(out.map((c) => [c.displayName, c]));
    const ordered: PlayerCard[] = [];
    for (const id of unique) {
      const n = names.get(id);
      const c = n && byName.get(n);
      if (c) ordered.push(c);
    }
    return ordered;
  }

  // -------------------------------------------------------------------------
  // Keresés
  // -------------------------------------------------------------------------

  /**
   * Játékos-keresés névtöredékre. A bemenet alaki ellenőrzése a tárolóban,
   * MÉG a lekérdezés előtt megtörténik; a találatszám kötött.
   */
  async searchPlayers(query: string, limit: number): Promise<PlayerCard[]> {
    const hits = await this.names.searchByName(query, limit);
    if (!hits.length) return [];
    return this.cardsFor(hits.map((h) => h.userId));
  }

  // -------------------------------------------------------------------------
  // Követés
  // -------------------------------------------------------------------------

  /** Követés. A követő MINDIG a hitelesített felhasználó. Idempotens. */
  async follow(userId: string, displayName: string): Promise<{ following: true; created: boolean }> {
    const target = await this.resolve(displayName);
    if (target.userId === userId) {
      throw new SocialError('Magadat nem követheted.', 422, 'SELF_FOLLOW');
    }
    const created = await this.follows.follow(userId, target.userId);
    return { following: true, created };
  }

  /** Követés megszüntetése. Idempotens: nem létező kapcsolat sem hiba. */
  async unfollow(userId: string, displayName: string): Promise<{ following: false; removed: boolean }> {
    const target = await this.resolve(displayName);
    const removed = await this.follows.unfollow(userId, target.userId);
    return { following: false, removed };
  }

  /** Követési állapot + a célszemély számlálói. */
  async status(userId: string | null, displayName: string) {
    const target = await this.resolve(displayName);
    const [following, counts] = await Promise.all([
      userId && userId !== target.userId ? this.follows.isFollowing(userId, target.userId) : Promise.resolve(false),
      this.follows.counts(target.userId),
    ]);
    return {
      displayName: target.displayName,
      following,
      followerCount: counts.followers,
      followingCount: counts.following,
    };
  }

  /** A nyilvános profil social rétege – KÉT count és egy létezés-ellenőrzés. */
  async profileSocial(targetUserId: string, viewerUserId: string | null) {
    const [counts, following] = await Promise.all([
      this.follows.counts(targetUserId),
      viewerUserId && viewerUserId !== targetUserId
        ? this.follows.isFollowing(viewerUserId, targetUserId)
        : Promise.resolve(false),
    ]);
    return { followerCount: counts.followers, followingCount: counts.following, isFollowing: following };
  }

  async listFollowing(userId: string, limit: number, before?: string) {
    const page = await this.follows.listFollowing(userId, limit, before);
    return { players: await this.cardsFor(page.userIds), hasMore: page.hasMore, nextBefore: page.nextBefore };
  }

  async listFollowers(userId: string, limit: number, before?: string) {
    const page = await this.follows.listFollowers(userId, limit, before);
    return { players: await this.cardsFor(page.userIds), hasMore: page.hasMore, nextBefore: page.nextBefore };
  }

  // -------------------------------------------------------------------------
  // Top Tipsterek
  // -------------------------------------------------------------------------

  /**
   * A jelöltkör: a Tippverseny MEGLÉVŐ résztvevői. Nem pásztázzuk végig az
   * `auth.users` táblát.
   *
   * KÖLTSÉG: a versenyek száma szerint egy-egy lekérdezés (a meglévő
   * `eligibleOpponents` mintája), ezért a versenyek száma KÖTÖTT
   * (`TOP_COMPETITION_LIMIT`), és a jelöltek száma is (`TOP_CANDIDATE_LIMIT`).
   * A felhasználónkénti statisztika utána HÁROM kötegelt lekérdezés – a
   * felhasználók számától független, tehát nincs N+1.
   */
  private async candidates(): Promise<string[]> {
    const comps = (await this.competitions.listCompetitions(['scheduled', 'active', 'finished']))
      .slice(0, TOP_COMPETITION_LIMIT);
    const ids = new Set<string>();
    for (const c of comps) {
      for (const p of await this.competitions.listPredictionsForCompetition(c.id)) {
        if (ids.size >= TOP_CANDIDATE_LIMIT) break;
        ids.add(p.userId);
      }
      if (ids.size >= TOP_CANDIDATE_LIMIT) break;
    }
    return [...ids];
  }

  async topTipsters(): Promise<TopTipstersResponse> {
    const pool = await this.candidates();
    if (!pool.length) return { categories: [], poolSize: 0 };

    const [names, xp, settled, placements, profiles] = await Promise.all([
      this.names.getMany(pool),
      this.progression.totalXpMany(pool),
      this.progression.settledPredictionsMany(pool),
      this.progression.placementsMany(pool),
      this.profilesOf(pool),
    ]);

    /** Egy jelölt összes számolt mérőszáma – a MEGLÉVŐ computeStats-ból. */
    const rows = pool
      .filter((id) => !!names.get(id))
      .map((id) => {
        const list = settled.get(id) ?? [];
        const stats = computeStats(list, placements.get(id) ?? [], xp.get(id) ?? 0);
        const level = levelFromXp(xp.get(id) ?? 0);
        const p = profiles.get(id) ?? DEFAULT_PROFILE;
        const card = toPlayerCard({
          displayName: names.get(id)!,
          level: level.level,
          levelTier: level.tier,
          accuracy: stats.settledPredictions ? stats.correctPredictions / stats.settledPredictions : null,
          avatar: p.avatar as Record<string, string>,
          borderKey: p.borderKey,
          titleKey: p.titleKey,
          shop: p.shop as Record<string, string | null> | undefined,
        });
        return { card, stats };
      });

    type Row = (typeof rows)[number];

    /**
     * Rangsor építése. Determinisztikus: az elsődleges mérőszám után a
     * megjelenítési név dönt, ezért azonos értékeknél is STABIL a sorrend.
     */
    const build = (
      key: TopCategory,
      eligible: (r: Row) => boolean,
      score: (r: Row) => number,
      value: (r: Row) => string,
      sample: (r: Row) => string,
    ) => {
      const entries: TopTipsterEntry[] = rows
        .filter(eligible)
        .sort((a, b) => (score(b) - score(a)) || a.card.displayName.localeCompare(b.card.displayName, 'hu'))
        .slice(0, TOP_LIST_SIZE)
        .map((r, i) => ({
          rank: i + 1, tier: tierForRank(i + 1), player: r.card, value: value(r), sample: sample(r),
        }));
      return entries.length ? { key, label: TOP_CATEGORY_LABEL[key], entries } : null;
    };

    const pct = (v: number) => `${Math.round(v * 100)}%`;

    const categories = [
      // 🔥 Forma – a MEGLÉVŐ sorozat-metrika, nem új képlet
      build('form',
        (r) => r.stats.currentStreak >= MIN_STREAK_FOR_FORM,
        (r) => r.stats.currentStreak,
        (r) => `${r.stats.currentStreak} tipp sorozat`,
        (r) => `${r.stats.settledPredictions} lezárt tipp`),

      // 🎯 Pontosság – minimum mintamérettel, hogy ne legyen félrevezető
      build('accuracy',
        (r) => r.stats.settledPredictions >= MIN_SETTLED_FOR_ACCURACY,
        (r) => r.stats.correctPredictions / r.stats.settledPredictions,
        (r) => pct(r.stats.correctPredictions / r.stats.settledPredictions),
        (r) => `${r.stats.settledPredictions} lezárt tipp`),

      // 💎 Exact Score – szintén minimum mintával
      build('exactScore',
        (r) => r.stats.settledPredictions >= MIN_PREDICTIONS_FOR_EXACT && r.stats.exactScores > 0,
        (r) => r.stats.exactScores,
        (r) => `${r.stats.exactScores} pontos eredmény`,
        (r) => `${r.stats.settledPredictions} lezárt tipp`),

      // 🏆 Tippverseny – a MEGLÉVŐ helyezés-adatból
      build('competition',
        (r) => r.stats.competitionsWon + r.stats.runnerUps + r.stats.thirdPlaces > 0,
        (r) => r.stats.competitionsWon * 3 + r.stats.runnerUps * 2 + r.stats.thirdPlaces,
        (r) => `${r.stats.competitionsWon} győzelem`,
        (r) => `${r.stats.competitionsWon + r.stats.runnerUps + r.stats.thirdPlaces} dobogó`),
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    return { categories, poolSize: rows.length };
  }
}
