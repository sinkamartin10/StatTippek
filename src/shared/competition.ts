/**
 * Tippverseny (Prediction League) – közös típusok és TISZTA üzleti logika.
 *
 * Ez a modul szándékosan függőségmentes: ugyanazt a pontozást és rangsorolást
 * használja a szerver (mérvadó számítás) és a kliens (megjelenítés, magyarázat).
 * A pontot és a helyezést MINDIG a szerver írja az adatbázisba – a kliens
 * ugyanezt a kódot csak kiszámolt értékek megjelenítésére használhatja.
 */

// ---------------------------------------------------------------------------
// Típusok
// ---------------------------------------------------------------------------

export type CompetitionStatus = 'draft' | 'scheduled' | 'active' | 'finished' | 'cancelled';
export type CompetitionMatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
export type RewardType = 'free_pro_1_month' | 'free_pro_2_weeks' | 'free_pro_1_week';
export type RewardStatus = 'pending' | 'granted' | 'used' | 'cancelled';

export interface Competition {
  id: string;
  name: string;
  /** strukturált liga-azonosító a meccsadat-szolgáltatótól (pl. 'eng-pl') */
  leagueKey: string;
  leagueName: string;
  provider: string;
  /** ISO 8601 UTC */
  startsAt: string;
  endsAt: string;
  status: CompetitionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CompetitionMatch {
  id: string;
  competitionId: string;
  externalMatchId: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  homeScore: number | null;
  awayScore: number | null;
  status: CompetitionMatchStatus;
}

export interface UserPrediction {
  id: string;
  competitionMatchId: string;
  userId: string;
  predictedHomeScore: number;
  predictedAwayScore: number;
  /** null = még nincs kiértékelve; a szerver tölti ki */
  points: number | null;
  submittedAt: string;
  updatedAt: string;
}

/**
 * A ranglistán megjelenített profil: a SZERVER által ellenőrzött megjelenés.
 * Kizárólag megjelenítési kulcsokat tartalmaz – nincs benne user_id, e-mail,
 * előfizetési adat vagy XP. A fel nem oldott elemek helyén már az alapértelmezés áll.
 */
export interface PublicProfile {
  avatar: Record<string, string>;
  borderKey: string;
  titleKey: string;
  /**
   * A felvett SHOP kozmetikumok slotonként (keret, névszín, név-effekt, cím,
   * avatar-embléma, profil-háttér), vagy `undefined`, ha nincs ilyen.
   *
   * KÜLÖN RÉTEG a megszolgált `borderKey` / `titleKey` / `avatar` mezőktől:
   * egyik sem írja felül a másikat. Szándékosan opcionális, hogy a korábbi
   * ranglista-válaszalak változatlan maradjon.
   */
  shop?: Partial<Record<'frame' | 'nameColor' | 'nameEffect' | 'title' | 'avatar' | 'profileBackground', string | null>>;
}

/** Nyilvános ranglista-sor. SZÁNDÉKOSAN nem tartalmaz e-mailt és user_id-t. */
export interface LeaderboardRow {
  rank: number;
  displayName: string;
  points: number;
  predictions: number;
  exactHits: number;
  /** true, ha ez a bejelentkezett felhasználó sora */
  isMe: boolean;
  /** A szerver által validált megjelenés (avatar, keret, cím). */
  profile?: PublicProfile;
}

/** Admin ranglista-sor: a jutalmazáshoz szükséges user_id is szerepel benne. */
export interface AdminLeaderboardRow extends Omit<LeaderboardRow, 'isMe'> {
  userId: string;
}

export interface CompetitionReward {
  id: string;
  competitionId: string;
  userId: string;
  displayName: string;
  placement: number;
  rewardType: RewardType;
  rewardLabel: string;
  status: RewardStatus;
  createdAt: string;
  updatedAt: string;
}

/** Egy sorban: meccs + (ha van) a bejelentkezett felhasználó saját tippje. */
export interface CompetitionMatchView extends CompetitionMatch {
  myPrediction: { predictedHomeScore: number; predictedAwayScore: number; points: number | null } | null;
  /** szerveroldalon eldöntve: lehet-e MOST tippelni erre a meccsre */
  locked: boolean;
  lockReason: string | null;
}

// ---------------------------------------------------------------------------
// Pontozás
// ---------------------------------------------------------------------------

export const POINTS_EXACT = 5;
export const POINTS_OUTCOME = 3;
export const POINTS_MISS = 0;

export const SCORING_RULES = [
  { label: 'Pontos eredmény', points: POINTS_EXACT, text: 'A tippelt gólarány megegyezik a végeredménnyel (pl. tipp 2–1, eredmény 2–1).' },
  { label: 'Helyes kimenetel (1X2)', points: POINTS_OUTCOME, text: 'Nem a pontos eredmény, de a győztes (vagy a döntetlen) eltalálva (pl. tipp 2–1, eredmény 1–0).' },
  { label: 'Nem talált', points: POINTS_MISS, text: 'Sem a pontos eredmény, sem a kimenetel nem egyezik.' },
];

/** 1X2 kimenetel egy gólarányból. */
export function outcomeOf(home: number, away: number): '1' | 'X' | '2' {
  return home > away ? '1' : home < away ? '2' : 'X';
}

/**
 * Egy tipp pontszáma. TISZTA függvény – ugyanaz a bemenet mindig ugyanazt adja,
 * ezért a kiértékelés újrafuttatása (settlement) idempotens: a pont felülíródik,
 * nem hozzáadódik.
 */
export function scorePrediction(
  predictedHome: number,
  predictedAway: number,
  actualHome: number,
  actualAway: number,
): number {
  if (predictedHome === actualHome && predictedAway === actualAway) return POINTS_EXACT;
  if (outcomeOf(predictedHome, predictedAway) === outcomeOf(actualHome, actualAway)) return POINTS_OUTCOME;
  return POINTS_MISS;
}

// ---------------------------------------------------------------------------
// Ranglista
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  userId: string;
  points: number;
  predictions: number;
  exactHits: number;
  /** a felhasználó LEGUTOLSÓ tippjének beküldési ideje (ISO) – determinisztikus holtverseny-döntő */
  lastSubmittedAt: string;
}

/**
 * Holtverseny-szabály (determinisztikus, dokumentált sorrend):
 *   1. több összpont
 *   2. több pontos eredmény (5 pontos találat)
 *   3. több leadott tipp
 *   4. korábbi utolsó tippbeküldés (aki hamarabb véglegesítette a tippjeit)
 *   5. user_id szerinti növekvő sorrend – végső, mindig eldöntő tartalék
 * Az 5. lépés garantálja, hogy a sorrend futtatástól függetlenül mindig ugyanaz.
 */
export const TIE_BREAK_RULES = [
  'több összpont',
  'több pontos eredmény (5 pontos találat)',
  'több leadott tipp',
  'korábbi utolsó tippbeküldés',
  'azonosító szerinti állandó sorrend (végső tartalék)',
];

export function compareLeaderboard(a: LeaderboardEntry, b: LeaderboardEntry): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.exactHits !== a.exactHits) return b.exactHits - a.exactHits;
  if (b.predictions !== a.predictions) return b.predictions - a.predictions;
  if (a.lastSubmittedAt !== b.lastSubmittedAt) return a.lastSubmittedAt < b.lastSubmittedAt ? -1 : 1;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/** Rendezés + helyezés kiosztása. A helyezés szigorúan 1..n (a holtversenyt a fenti szabály dönti el). */
export function rankEntries(entries: LeaderboardEntry[]): (LeaderboardEntry & { rank: number })[] {
  return [...entries].sort(compareLeaderboard).map((e, i) => ({ ...e, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Megjelenítendő név – SOHA nem e-mail
// ---------------------------------------------------------------------------

/**
 * Álnév a ranglistához: determinisztikus, a felhasználó azonosítójából számolva.
 * Nem tartalmaz személyes adatot, de ugyanaz a felhasználó mindig ugyanazt a nevet kapja.
 * (FNV-1a hash → 4 hexa karakter.)
 */
export function displayNameFor(userId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `Tippelő #${h.toString(16).toUpperCase().padStart(8, '0').slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Jutalmak (CSAK nyilvántartás – a PRO-t az admin manuálisan adja oda)
// ---------------------------------------------------------------------------

export const REWARD_TIERS: { placement: number; rewardType: RewardType; rewardLabel: string; medal: string }[] = [
  { placement: 1, rewardType: 'free_pro_1_month', rewardLabel: '1 hónap PRO', medal: '🥇' },
  { placement: 2, rewardType: 'free_pro_2_weeks', rewardLabel: '2 hét PRO', medal: '🥈' },
  { placement: 3, rewardType: 'free_pro_1_week', rewardLabel: '1 hét PRO', medal: '🥉' },
];

export const REWARD_STATUS_LABEL: Record<RewardStatus, string> = {
  pending: 'Kiosztásra vár',
  granted: 'Odaadva',
  used: 'Felhasználva',
  cancelled: 'Visszavonva',
};

export const COMPETITION_STATUS_LABEL: Record<CompetitionStatus, string> = {
  draft: 'Piszkozat',
  scheduled: 'Ütemezve',
  active: 'Aktív',
  finished: 'Lezárva',
  cancelled: 'Érvénytelenítve',
};

/** A lezárt és az érvénytelenített verseny nem módosítható tovább. */
export function isImmutable(status: CompetitionStatus): boolean {
  return status === 'finished' || status === 'cancelled';
}

/**
 * Tippelhető-e MOST a megadott meccs? A szerver ezt használja mérvadóként,
 * a kliens pedig ugyanezt a választ jeleníti meg (a backend minden esetben újra ellenőrzi).
 */
export function predictionWindow(
  competition: Pick<Competition, 'status' | 'startsAt' | 'endsAt'>,
  match: Pick<CompetitionMatch, 'kickoff' | 'status'>,
  now: Date = new Date(),
): { open: true } | { open: false; reason: string } {
  const t = now.getTime();
  if (competition.status !== 'active') return { open: false, reason: 'A verseny jelenleg nem aktív.' };
  if (t < new Date(competition.startsAt).getTime()) return { open: false, reason: 'A verseny még nem kezdődött el.' };
  if (t >= new Date(competition.endsAt).getTime()) return { open: false, reason: 'A verseny tippelési időszaka lezárult.' };
  if (match.status !== 'scheduled') return { open: false, reason: 'A mérkőzés már elkezdődött vagy lezárult.' };
  if (t >= new Date(match.kickoff).getTime()) return { open: false, reason: 'A mérkőzés kezdése után már nem lehet tippelni.' };
  return { open: true };
}
