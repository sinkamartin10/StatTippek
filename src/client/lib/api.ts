/**
 * API kliens. Minden hívás a szerver /api végpontjaira megy; a frontend nem tartalmaz és nem is kap API kulcsot.
 */
import type { DailyQuota } from '@shared/freeQuota';
import type { TipArchiveQuery, TipArchiveResponse } from '@shared/tipArchive';
import type {
  BattleListResponse, BattleView, EligibleMatch, EligibleOpponent,
} from '@shared/battles';
import type { NotificationListResponse, NotificationRow } from '@shared/notifications';
import type {
  AppStatus, HistorySummary, League, Match, MatchAnalysis, MatchOdds, PredictionRecord, SourceRecord, Team, TipListEntry, SlipBuildResponse, SlipRecord, SlipStrategy,
  FormSummary, StandingRow, LeagueAverages, MatchResult,
} from '@shared/types';
import type {
  AdminLeaderboardRow, Competition, CompetitionMatch, CompetitionMatchView, CompetitionReward,
  LeaderboardRow, RewardStatus, UserPrediction,
} from '@shared/competition';
import type { HistoryEntry, ProfileSettings, TipsterStats } from '@shared/progression';
import type { PublicProfileResponse } from '@shared/publicProfile';
import type {
  FollowListResponse, FollowStatus, PlayerSearchResponse, TopTipstersResponse,
} from '@shared/social';
import type { MissionPeriodView, MissionView } from '@shared/missions';
import type {
  CoinBalance, CoinHistoryPage, CoinTransactionType, ProfileSlot, ShopCatalogResponse,
  ShopEquips, ShopInventoryResponse, ShopPurchaseResponse,
} from '@shared/shop';
import { supabase } from './supabase';

export interface MatchWithTeams extends Match {
  homeTeam: Team | null;
  awayTeam: Team | null;
  league: League | null;
}

export interface StandingsResponse {
  league: League;
  averages: LeagueAverages;
  origin: 'demo' | 'live';
  standings: (StandingRow & { team: Team | null; form: string })[];
}

export interface TeamResponse {
  team: Team;
  league: League | null;
  origin: 'demo' | 'live';
  last10: FormSummary;
  home: FormSummary;
  away: FormSummary;
  upcoming: MatchWithTeams[];
  recent: (MatchResult & { homeTeam?: Team; awayTeam?: Team; league?: League })[];
}

export interface ProfileMe { displayName: string | null; hasDisplayName: boolean; rules: string[]; min: number; max: number }

/** A szerver által számolt progression-állapot (a kliens SOHA nem számol XP-t vagy szintet). */
export interface ProgressionProfileResponse {
  pro: boolean;
  xp: number;
  level: number;
  levelTier: string;
  xpIntoLevel: number;
  xpForNextLevel: number;
  progress: number;
  stats: {
    settledPredictions: number; correctPredictions: number; exactScores: number;
    bestStreak: number; currentStreak: number; competitionsWon: number;
    runnerUps: number; thirdPlaces: number; distinctLeagues: number;
    correctByLeague: Record<string, number>; level: number;
  };
  achievements: { key: string; name: string; description: string; icon: string; category: string; unlocked: boolean; unlockedAt: string | null }[];
  settings: ProfileSettings;
  catalog: {
    avatar: Record<string, { key: string; name: string; value?: string; animation?: string; unlocked: boolean; requirementLabel: string }[]>;
    borders: { key: string; name: string; value?: string; animation?: string; unlocked: boolean; requirementLabel: string }[];
    titles: { key: string; name: string; unlocked: boolean; requirementLabel: string }[];
    maxShowcase: number;
  };
}

export interface MissionsResponse { pro: boolean; daily: MissionPeriodView; weekly: MissionPeriodView; claimedTotal: number }
export interface MissionClaimResponse { mission: MissionView; xpAwarded: number; alreadyClaimed: boolean }

export interface PredictionHistoryResponse { entries: HistoryEntry[]; total: number; limit: number }

export interface CompetitionDetail { competition: Competition; scoring: { label: string; points: number; text: string }[]; tieBreak: string[] }
export interface CompetitionMyStats {
  rank: number | null; points: number; predictions: number; exactHits: number;
  participants: number; displayName: string | null; canPredict: boolean;
  /** FREE napi tippkeret – PRO esetén null. A SZERVER számolja; a kliens csak megjeleníti. */
  dailyQuota: DailyQuota | null;
}
export interface CompetitionLeague { leagueKey: string; leagueName: string; country: string; provider: string }
export interface CompetitionSyncResult { inserted: number; updated: number; total: number; scoredPredictions: number }
export interface CompetitionFinishResult { competition: Competition; rewards: CompetitionReward[]; createdRewards: number; warnings: string[] }
export interface AdminCompetitionDetail { competition: Competition; matches: CompetitionMatch[]; rewards: CompetitionReward[] }

export interface SearchResponse { teams: Team[]; leagues: League[]; matches: MatchWithTeams[] }
export interface HistoryResponse { predictions: PredictionRecord[]; summary: HistorySummary; origin: 'demo' | 'live' }

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** A szerver gépi hibakódja (pl. PRO_REQUIRED, CHALLENGE_EXPIRED) – a felület erre ágazhat. */
    public code?: string,
    /** A hibaválasz további, szerver által számolt mezői (pl. kvóta-állapot). */
    public details?: Record<string, unknown>,
  ) { super(message); }
}

/** A bejelentkezett felhasználó access tokenje (a szerver ebből azonosít; a PRO/FREE állapotot a szerver dönti el). */
async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ? { authorization: `Bearer ${data.session.access_token}` } : {};
}

/**
 * Az API alapcíme.
 *  - Fejlesztésben és közös hoszton: üres → relatív `/api/...` (a Vite dev szerver proxyzza a 3001-es portra).
 *  - Külön API-hoszton (pl. frontend Cloudflare Pages, backend Render): VITE_API_URL=https://api.pelda.hu
 * A záró perjelet levágjuk, hogy a `${API_BASE}/api/...` mindig helyes legyen.
 */
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/+$/, '') ?? '';

async function request<T>(path: string, init?: RequestInit, prefix = '/api'): Promise<T> {
  const auth = await authHeader();
  const res = await fetch(`${API_BASE}${prefix}${path}`, { ...init, headers: { 'content-type': 'application/json', ...auth, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; code?: string } & Record<string, unknown>;
    const msg = b.error ?? `Hiba (${res.status})`;
    const { error: _e, code, ...rest } = b;
    throw new ApiError(msg, res.status, code, rest);
  }
  return body as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  status: () => request<AppStatus>('/status'),
  leagues: () => request<League[]>('/leagues'),
  matches: (params: Record<string, string | undefined>) => request<MatchWithTeams[]>(`/matches${qs(params)}`),
  match: (id: string) => request<MatchWithTeams>(`/matches/${encodeURIComponent(id)}`),
  analysis: (id: string, refresh = false) => request<MatchAnalysis>(`/matches/${encodeURIComponent(id)}/analysis${refresh ? '?refresh=1' : ''}`),
  saveOdds: (id: string, markets: Record<string, string>, bookmaker?: string) =>
    request<MatchOdds>(`/matches/${encodeURIComponent(id)}/odds`, { method: 'POST', body: JSON.stringify({ markets, bookmaker }) }),
  deleteOdds: (id: string) => request<{ ok: true }>(`/matches/${encodeURIComponent(id)}/odds`, { method: 'DELETE' }),
  savePrediction: (id: string, market: string) => request<PredictionRecord>(`/matches/${encodeURIComponent(id)}/predictions`, { method: 'POST', body: JSON.stringify({ market }) }),
  tips: (date?: string) => request<TipListEntry[]>(`/tips${qs({ date })}`),
  standings: (leagueId: string) => request<StandingsResponse>(`/standings/${encodeURIComponent(leagueId)}`),
  team: (id: string) => request<TeamResponse>(`/teams/${encodeURIComponent(id)}`),
  search: (q: string) => request<SearchResponse>(`/search${qs({ q })}`),
  history: (params: Record<string, string | undefined>) => request<HistoryResponse>(`/history${qs(params)}`),
  sources: (params: Record<string, string | undefined>) => request<SourceRecord[]>(`/sources${qs(params)}`),
  slips: (params: Record<string, string | undefined>) => request<SlipBuildResponse>(`/slips${qs(params)}`),
  savedSlips: () => request<SlipRecord[]>('/slips/saved'),
  saveSlip: (strategy: SlipStrategy, label: string, legs: { matchId: string; market: string }[]) => request<SlipRecord>('/slips', { method: 'POST', body: JSON.stringify({ strategy, label, legs }) }),
  billingConfig: () => request<{ configured: boolean; supabase: boolean; productName?: string; amount?: number; currency?: string; interval?: string; label?: string; error?: string }>('/billing/config'),
  billingMe: () => request<{ userId: string; email: string | null; pro: boolean }>('/billing/me'),
  checkout: () => request<{ url: string }>('/billing/checkout', { method: 'POST', body: '{}' }),
  billingPortal: () => request<{ url: string }>('/billing/portal', { method: 'POST', body: '{}' }),
  billingSync: () => request<{ synced: boolean; pro?: boolean; status?: string; reason?: string }>('/billing/sync', { method: 'POST', body: '{}' }),
  // ---------- Profil: megjelenítési név (a meglévő profiles táblán) ----------
  profileMe: () => request<ProfileMe>('/me', {}, '/api/profile'),
  /** A nevet mindig a hitelesített felhasználóhoz menti; a törzsben user_id-t nem küldünk. */
  saveDisplayName: (displayName: string) =>
    request<{ displayName: string; hasDisplayName: boolean }>('/display-name', { method: 'PUT', body: JSON.stringify({ displayName }) }, '/api/profile'),
  /**
   * Egy JÁTÉKOS nyilvános profilja a megjelenítési neve alapján.
   * Hitelesítés nélkül is hívható; a válasz csak nyilvános mezőket tartalmaz
   * (nincs benne user_id, coin-egyenleg, vásárlás vagy fiókadat).
   */
  publicProfile: (displayName: string) =>
    request<PublicProfileResponse>(`/public/${encodeURIComponent(displayName)}`, {}, '/api/profile'),

  // ---------- Social: keresés, követés, Top Tipsterek ----------
  // A követő azonosítóját a SZERVER veszi a tokenből; a törzsben sosem küldünk ilyet.
  playerSearch: (q: string) =>
    request<PlayerSearchResponse>(`/players/search?q=${encodeURIComponent(q)}`, {}, '/api/social'),
  followStatus: (displayName: string) =>
    request<FollowStatus>(`/follow/status/${encodeURIComponent(displayName)}`, {}, '/api/social'),
  follow: (displayName: string) =>
    request<{ following: true; created: boolean }>(`/follow/${encodeURIComponent(displayName)}`, { method: 'POST' }, '/api/social'),
  unfollow: (displayName: string) =>
    request<{ following: false; removed: boolean }>(`/follow/${encodeURIComponent(displayName)}`, { method: 'DELETE' }, '/api/social'),
  following: (limit?: number, before?: string) =>
    request<FollowListResponse>(`/following${qs({ limit, before })}`, {}, '/api/social'),
  followers: (limit?: number, before?: string) =>
    request<FollowListResponse>(`/followers${qs({ limit, before })}`, {}, '/api/social'),
  topTipsters: () => request<TopTipstersResponse>('/top-tipsters', {}, '/api/social'),
  /** Modell-tipp archívum – nyilvános, csak elkezdődött meccsek. */
  tipArchive: (q: TipArchiveQuery) =>
    request<TipArchiveResponse>(qs({ ...q }), {}, '/api/tip-archive'),
  /** Achievement-kiemelés mentése – FREE és PRO egyaránt. */
  saveShowcase: (showcase: string[]) =>
    request<{ settings: ProfileSettings; rejected: string[] }>('/showcase', {
      method: 'PUT', body: JSON.stringify({ showcase }),
    }, '/api/progression'),

  // ---------- Tipster progression (XP, achievement, testreszabás) ----------
  progressionMe: () => request<ProgressionProfileResponse>('/me', {}, '/api/progression'),
  /** Csak a VÁLASZTÁST küldjük; XP-t, szintet és feloldást a szerver sosem fogad el a klienstől. */
  saveProgressionSettings: (settings: Partial<ProfileSettings>) =>
    request<{ settings: ProfileSettings; rejected: string[] }>('/settings', { method: 'PUT', body: JSON.stringify(settings) }, '/api/progression'),

  /** Saját tipster statisztika – minden értéket a szerver számol. */
  progressionStats: () => request<TipsterStats>('/stats', {}, '/api/progression'),
  /** Saját tipp-előzmény, legfrissebb elöl; a limitet a szerver korlátozza. */
  progressionHistory: (limit?: number) =>
    request<PredictionHistoryResponse>(`/history${limit ? `?limit=${limit}` : ''}`, {}, '/api/progression'),

  // ---------- Küldetések (a haladást és a jutalmat a szerver számolja) ----------
  missions: () => request<MissionsResponse>('', {}, '/api/missions'),

  // --- 1v1 Tipp Battle. A 3. argumentum a TELJES mount-prefix: az útvonal
  //     NEM tartalmazhatja újra a 'battles' szegmenst (lásd tests/apiUrls.test.ts).
  battles: () => request<BattleListResponse>('', {}, '/api/battles'),
  battle: (id: string) => request<BattleView>(`/${encodeURIComponent(id)}`, {}, '/api/battles'),
  battleEligibleOpponents: () => request<EligibleOpponent[]>('/eligible-opponents', {}, '/api/battles'),
  battleEligibleMatches: () => request<EligibleMatch[]>('/eligible-matches', {}, '/api/battles'),
  createBattle: (opponentId: string, competitionMatchIds: string[]) =>
    request<BattleView>('', { method: 'POST', body: JSON.stringify({ opponentId, competitionMatchIds }) }, '/api/battles'),
  acceptBattle: (id: string) =>
    request<BattleView>(`/${encodeURIComponent(id)}/accept`, { method: 'POST' }, '/api/battles'),
  declineBattle: (id: string) =>
    request<BattleView>(`/${encodeURIComponent(id)}/decline`, { method: 'POST' }, '/api/battles'),
  cancelBattle: (id: string) =>
    request<BattleView>(`/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, '/api/battles'),
  submitBattlePrediction: (id: string, competitionMatchId: string, predictedHomeScore: number, predictedAwayScore: number) =>
    request<BattleView>(`/${encodeURIComponent(id)}/predictions`, {
      method: 'POST',
      body: JSON.stringify({ competitionMatchId, predictedHomeScore, predictedAwayScore }),
    }, '/api/battles'),
  claimMission: (key: string) =>
    request<MissionClaimResponse>(`/${encodeURIComponent(key)}/claim`, { method: 'POST' }, '/api/missions'),

  // --- Értesítések. A 3. argumentum a TELJES mount-prefix: az útvonal NEM
  //     tartalmazhatja újra a 'notifications' szegmenst (lásd tests/apiUrls.test.ts).
  notifications: (opts: { limit?: number; before?: string } = {}) =>
    request<NotificationListResponse>(qs({
      limit: opts.limit != null ? String(opts.limit) : undefined,
      before: opts.before,
    }), {}, '/api/notifications'),
  markNotificationRead: (id: string) =>
    request<{ notification: NotificationRow }>(`/${encodeURIComponent(id)}/read`, { method: 'POST' }, '/api/notifications'),
  markAllNotificationsRead: () =>
    request<{ updated: number }>('/read-all', { method: 'POST' }, '/api/notifications'),

  // ---------- Tippverseny (külön modul; a meglévő végpontokat nem érinti) ----------
  // FIGYELEM: a harmadik paraméter a TELJES mount-prefix, a path pedig csak az azon belüli rész –
  // a '/competition' szegmens ezért itt NEM ismételhető meg (lásd tests/apiUrls.test.ts).
  competitions: () => request<Competition[]>('', {}, '/api/competition'),
  competition: (id: string) => request<CompetitionDetail>(`/${encodeURIComponent(id)}`, {}, '/api/competition'),
  competitionMatches: (id: string) => request<CompetitionMatchView[]>(`/${encodeURIComponent(id)}/matches`, {}, '/api/competition'),
  competitionLeaderboard: (id: string) => request<LeaderboardRow[]>(`/${encodeURIComponent(id)}/leaderboard`, {}, '/api/competition'),
  competitionMyPredictions: (id: string) => request<UserPrediction[]>(`/${encodeURIComponent(id)}/my-predictions`, {}, '/api/competition'),
  competitionMyStats: (id: string) => request<CompetitionMyStats>(`/${encodeURIComponent(id)}/me`, {}, '/api/competition'),
  /** Tipp leadása/módosítása – a pontot mindig a szerver számolja. */
  submitCompetitionPrediction: (id: string, competitionMatchId: string, predictedHomeScore: number, predictedAwayScore: number) =>
    request<UserPrediction>(`/${encodeURIComponent(id)}/predictions`, {
      method: 'POST', body: JSON.stringify({ competitionMatchId, predictedHomeScore, predictedAwayScore }),
    }, '/api/competition'),

  // ---------- Tippverseny – admin (a szerver ADMIN_EMAILS alapján engedi) ----------
  adminCompetitions: () => request<Competition[]>('', {}, '/api/admin/competition'),
  adminCompetitionLeagues: () => request<CompetitionLeague[]>('/leagues', {}, '/api/admin/competition'),
  adminCompetition: (id: string) => request<AdminCompetitionDetail>(`/${encodeURIComponent(id)}`, {}, '/api/admin/competition'),
  adminCreateCompetition: (body: { name: string; leagueKey: string; startsAt: string; endsAt: string }) =>
    request<Competition>('', { method: 'POST', body: JSON.stringify(body) }, '/api/admin/competition'),
  adminCompetitionAction: (id: string, action: 'activate' | 'schedule' | 'cancel') =>
    request<Competition>(`/${encodeURIComponent(id)}/${action}`, { method: 'POST' }, '/api/admin/competition'),
  adminCompetitionSync: (id: string) => request<CompetitionSyncResult>(`/${encodeURIComponent(id)}/sync`, { method: 'POST' }, '/api/admin/competition'),
  adminCompetitionFinish: (id: string) => request<CompetitionFinishResult>(`/${encodeURIComponent(id)}/finish`, { method: 'POST' }, '/api/admin/competition'),
  adminCompetitionLeaderboard: (id: string) => request<AdminLeaderboardRow[]>(`/${encodeURIComponent(id)}/leaderboard`, {}, '/api/admin/competition'),
  adminCompetitionRewards: (id: string) => request<CompetitionReward[]>(`/${encodeURIComponent(id)}/rewards`, {}, '/api/admin/competition'),
  adminSetRewardStatus: (id: string, rewardId: string, status: RewardStatus) =>
    request<CompetitionReward>(`/${encodeURIComponent(id)}/rewards/${encodeURIComponent(rewardId)}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    }, '/api/admin/competition'),

  // ---------- Coin + Shop ----------
  // FIGYELEM: a harmadik paraméter a TELJES mount-prefix, az útvonal pedig csak
  // az azon belüli rész – a 'coins' / 'shop' szegmens itt NEM ismételhető meg
  // (lásd tests/apiUrls.test.ts).

  /** A hitelesített felhasználó egyenlege. A DB az authority; a kliens csak megjeleníti. */
  coinBalance: () => request<CoinBalance>('/balance', {}, '/api/coins'),
  /** Tranzakciós napló lapozva; a limitet a szerver korlátozza. */
  coinHistory: (opts: { limit?: number; before?: string; type?: CoinTransactionType[] } = {}) =>
    request<CoinHistoryPage>(`/history${qs({
      limit: opts.limit, before: opts.before,
      type: opts.type?.length ? opts.type.join(',') : undefined,
    })}`, {}, '/api/coins'),

  /** Az aktív katalógus. Az ÁR, a ritkaság és a birtoklás mind a szerverről jön. */
  shopItems: () => request<ShopCatalogResponse>('/items', {}, '/api/shop'),
  /** A saját készlet (kötegelt – elemenként nincs külön kérés). */
  shopInventory: () => request<ShopInventoryResponse>('/inventory', {}, '/api/shop'),
  /** Vásárlás. A törzsben KIZÁRÓLAG az item kulcsát küldjük – árat sosem. */
  purchaseShopItem: (itemKey: string) =>
    request<ShopPurchaseResponse>('/purchase', { method: 'POST', body: JSON.stringify({ itemKey }) }, '/api/shop'),

  /** A felvett shop kozmetikumok. */
  customization: () => request<{ shop: ShopEquips; slots: ProfileSlot[] }>('/customization', {}, '/api/profile'),
  /** Felvétel / levétel (`itemKey: null`). A szerver ellenőrzi a birtoklást és a slotot. */
  equipShopItem: (slot: ProfileSlot, itemKey: string | null) =>
    request<{ shop: ShopEquips; slot: ProfileSlot }>('/customization', {
      method: 'PUT', body: JSON.stringify({ slot, itemKey }),
    }, '/api/profile'),

  settings: () => request<{ shrinkageK: number; status: AppStatus }>('/settings'),
  saveSettings: (shrinkageK: number) => request<{ shrinkageK: number }>('/settings', { method: 'POST', body: JSON.stringify({ shrinkageK }) }),
};
