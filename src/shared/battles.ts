/**
 * 1v1 Tipp Battle – megosztott modell és szabályok. EGYETLEN konfigurációs hely.
 *
 * Architektúra (C hibrid modell):
 *   competition_matches
 *         ├── Tippverseny → user_predictions      (változatlan rendszer)
 *         └── 1v1 Battle  → battle_matches → battle_predictions
 *
 * A battle a meglévő mérkőzés-rekordokat HIVATKOZZA (nem másolja), de saját
 * életciklusa, saját tipptáblája és saját pontszáma van. A battle állapota NEM
 * függ a szülő verseny állapotától: kizárólag a MÉRKŐZÉS szintű szabályok
 * (status = 'scheduled', kickoff még nem volt) és a battle saját állapota számít.
 *
 * A pontozás a Tippverseny MEGLÉVŐ `scorePrediction()` függvényét használja
 * változtatás nélkül – nincs második pontozási rendszer.
 */
import { scorePrediction } from './competition';

// ===========================================================================
// 1) Fix szabályok
// ===========================================================================

/** Egy battle PONTOSAN ennyi mérkőzésből áll. Se több, se kevesebb. */
export const BATTLE_MATCH_COUNT = 3;

/** A kihívás ennyi idő után lejár (lusta kiértékelés, nincs ütemező). */
export const INVITE_TTL_HOURS = 24;
export const INVITE_TTL_MS = INVITE_TTL_HOURS * 3600_000;

/** Egy felhasználónak legfeljebb ennyi nyitott (pending) kihívása lehet kezdeményezőként. */
export const MAX_PENDING_BATTLES = 5;

/** Battle XP a V1-ben: NINCS. Sem győzelemért, sem vereségért, sem döntetlenért. */
export const BATTLE_XP = 0;

export const inviteExpiryFrom = (at: Date = new Date()): string =>
  new Date(at.getTime() + INVITE_TTL_MS).toISOString();

// ===========================================================================
// 2) Életciklus
// ===========================================================================

export type BattleStatus = 'pending' | 'active' | 'settled' | 'declined' | 'cancelled' | 'expired';

export const BATTLE_STATUSES: BattleStatus[] = ['pending', 'active', 'settled', 'declined', 'cancelled', 'expired'];

export const BATTLE_STATUS_LABEL: Record<BattleStatus, string> = {
  pending: 'Elfogadásra vár',
  active: 'Folyamatban',
  settled: 'Lezárva',
  declined: 'Elutasítva',
  cancelled: 'Visszavonva',
  expired: 'Lejárt',
};

/**
 * Megengedett kiinduló állapotok művelet szerint. Minden átmenet FELTÉTELES
 * UPDATE-ként fut (a meglévő setCompetitionStatus mintája), ezért két párhuzamos
 * kérés közül pontosan egy írhat.
 */
export const BATTLE_TRANSITIONS = {
  accept: { from: ['pending'] as BattleStatus[], to: 'active' as BattleStatus },
  decline: { from: ['pending'] as BattleStatus[], to: 'declined' as BattleStatus },
  cancel: { from: ['pending'] as BattleStatus[], to: 'cancelled' as BattleStatus },
  expire: { from: ['pending'] as BattleStatus[], to: 'expired' as BattleStatus },
  settle: { from: ['active'] as BattleStatus[], to: 'settled' as BattleStatus },
};

/** A battle már nem változik: sem tipp, sem állapotátmenet. */
export const isBattleClosed = (s: BattleStatus): boolean =>
  s === 'settled' || s === 'declined' || s === 'cancelled' || s === 'expired';

/** Lejárt-e a kihívás? SZÁMÍTOTT érték – a tárolt állapot lustán követi. */
export const isInviteExpired = (b: { status: BattleStatus; inviteExpiresAt: string }, now: Date = new Date()): boolean =>
  b.status === 'pending' && new Date(b.inviteExpiresAt).getTime() <= now.getTime();

/** A megjelenítendő állapot: a lejárt kihívás már akkor is 'expired', ha a sor még 'pending'. */
export const effectiveStatus = (b: { status: BattleStatus; inviteExpiresAt: string }, now: Date = new Date()): BattleStatus =>
  (isInviteExpired(b, now) ? 'expired' : b.status);

// ===========================================================================
// 3) Adatalakok
// ===========================================================================

/** A `battles` tábla egy sora. */
export interface BattleRow {
  id: string;
  challengerId: string;
  opponentId: string;
  status: BattleStatus;
  inviteExpiresAt: string;
  /** null = döntetlen VAGY még nincs lezárva (a status dönti el, melyik) */
  winnerUserId: string | null;
  challengerPoints: number | null;
  opponentPoints: number | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A `battle_predictions` tábla egy sora. */
export interface BattlePredictionRow {
  id: string;
  battleId: string;
  userId: string;
  competitionMatchId: string;
  predictedHomeScore: number;
  predictedAwayScore: number;
  /** KIZÁRÓLAG a szerver írja, a lezáráskor */
  points: number | null;
  submittedAt: string;
  updatedAt: string;
}

/** A battle-ben szereplő mérkőzés – a competition_matches adataiból. */
export interface BattleMatchInfo {
  competitionMatchId: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
}

/** Egy tipp megjelenítésre szánt alakja. */
export interface PredictionView {
  predictedHomeScore: number;
  predictedAwayScore: number;
  points: number | null;
}

/** Egy mérkőzés a battle nézetében. */
export interface BattleMatchView extends BattleMatchInfo {
  /** adható/módosítható-e most tipp erre a mérkőzésre */
  open: boolean;
  lockReason: string | null;
  /** véget ért-e (eredménnyel), azaz pontozható-e */
  finished: boolean;
  myPrediction: PredictionView | null;
  /**
   * Az ellenfél tippje – kickoff ELŐTT mindig null (a szerver takarja ki),
   * utána látható. A `opponentHasPredicted` ettől függetlenül mindig igaz/hamis.
   */
  opponentPrediction: PredictionView | null;
  opponentHasPredicted: boolean;
}

/** A felhasználó megjelenítendő adatai – SOHA nem tartalmaz e-mailt vagy azonosítót. */
export interface BattleParticipant {
  displayName: string;
  avatar: Record<string, string>;
  borderKey: string;
  titleKey: string;
  /** leadott tippek száma ebben a battle-ben */
  predictions: number;
  /** összpont (csak lezárás után, egyébként null) */
  points: number | null;
}

export type BattleOutcome = 'win' | 'loss' | 'draw' | null;

/** Egy battle teljes, megjelenítésre szánt nézete. */
export interface BattleView {
  id: string;
  status: BattleStatus;
  statusLabel: string;
  inviteExpiresAt: string;
  settledAt: string | null;
  createdAt: string;
  /** a bejelentkezett felhasználó a kihívó-e */
  iAmChallenger: boolean;
  /** a bejelentkezett felhasználó léphet-e (accept/decline, ill. cancel) */
  canAccept: boolean;
  canDecline: boolean;
  canCancel: boolean;
  challenger: BattleParticipant;
  opponent: BattleParticipant;
  /** a BEJELENTKEZETT felhasználó szempontjából; null, ha még nincs lezárva */
  myOutcome: BattleOutcome;
  matches: BattleMatchView[];
}

export interface BattleListResponse {
  incoming: BattleView[];
  outgoing: BattleView[];
  active: BattleView[];
  settled: BattleView[];
  /** a nyitott kihívások száma a felhasználó felé (jelvényhez) */
  pendingIncoming: number;
  limits: { maxPending: number; matchCount: number; inviteTtlHours: number };
}

/** Kihívható ellenfél – kizárólag a Tippverseny ranglistán már látható PRO résztvevők közül. */
export interface EligibleOpponent {
  /** a kihíváshoz szükséges azonosító; csak a már ranglistán szereplő résztvevők köre */
  userId: string;
  displayName: string;
  avatar: Record<string, string>;
  borderKey: string;
  titleKey: string;
}

/** Battle-be választható mérkőzés. */
export interface EligibleMatch {
  competitionMatchId: string;
  competitionName: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
}

// ===========================================================================
// 4) Pontozás és győztes
// ===========================================================================

/**
 * Egy battle-tipp pontja. A MEGLÉVŐ `scorePrediction()`-t hívja változtatás nélkül:
 * 5 = pontos eredmény, 3 = helyes 1X2, 0 = nem talált.
 */
export function scoreBattlePrediction(
  p: Pick<BattlePredictionRow, 'predictedHomeScore' | 'predictedAwayScore'>,
  actualHome: number,
  actualAway: number,
): number {
  return scorePrediction(p.predictedHomeScore, p.predictedAwayScore, actualHome, actualAway);
}

/** Pontozható-e a mérkőzés: lezárult ÉS van eredménye. */
export const matchIsScorable = (m: Pick<BattleMatchInfo, 'status' | 'homeScore' | 'awayScore'>): boolean =>
  m.status === 'finished' && m.homeScore != null && m.awayScore != null;

/**
 * A battle győztese a két összpontból.
 *
 * SZÁNDÉKOSAN NEM a ranglista holtverseny-szabályát használja: ott az 5. szint a
 * user_id szerint rendez, ami 1v1-ben önkényes győztest adna. Itt valódi
 * döntetlen van, amit a `winnerUserId = null` jelöl.
 */
export function battleWinner(
  challengerId: string,
  opponentId: string,
  challengerPoints: number,
  opponentPoints: number,
): string | null {
  if (challengerPoints > opponentPoints) return challengerId;
  if (opponentPoints > challengerPoints) return opponentId;
  return null; // döntetlen
}

/** A bejelentkezett felhasználó eredménye egy LEZÁRT battle-ben. */
export function outcomeFor(b: Pick<BattleRow, 'status' | 'winnerUserId'>, userId: string): BattleOutcome {
  if (b.status !== 'settled') return null;
  if (b.winnerUserId == null) return 'draw';
  return b.winnerUserId === userId ? 'win' : 'loss';
}

export const BATTLE_OUTCOME_LABEL: Record<Exclude<BattleOutcome, null>, string> = {
  win: 'Győzelem',
  loss: 'Vereség',
  draw: 'Döntetlen',
};

// ===========================================================================
// 5) Tippelési ablak – KIZÁRÓLAG mérkőzés- és battle-szintű feltételek
// ===========================================================================

/**
 * Adható-e most tipp erre a mérkőzésre ebben a battle-ben?
 *
 * A Tippverseny `predictionWindow()`-ját SZÁNDÉKOSAN nem használjuk: annak öt
 * feltételéből három a VERSENYRE vonatkozik (status = 'active', startsAt, endsAt).
 * Ha az admin lezárná vagy érvénytelenítené a versenyt, a futó battle-ök
 * visszamenőleg lezárnának – ezt a C modell kifejezetten elkerüli.
 */
export function battlePredictionWindow(
  battleStatus: BattleStatus,
  match: Pick<BattleMatchInfo, 'kickoff' | 'status'>,
  now: Date = new Date(),
): { open: true } | { open: false; reason: string } {
  if (battleStatus === 'pending') return { open: false, reason: 'A battle még nincs elfogadva.' };
  if (battleStatus !== 'active') {
    return { open: false, reason: `A battle állapota „${BATTLE_STATUS_LABEL[battleStatus]}" – tipp már nem adható le.` };
  }
  if (match.status !== 'scheduled') return { open: false, reason: 'A mérkőzés már elkezdődött vagy lezárult.' };
  if (now.getTime() >= new Date(match.kickoff).getTime()) {
    return { open: false, reason: 'A mérkőzés kezdése után már nem lehet tippelni.' };
  }
  return { open: true };
}

/** Battle-be választható-e a mérkőzés? (létrehozáskor mindháromra teljesülnie kell) */
export const matchSelectable = (m: Pick<BattleMatchInfo, 'kickoff' | 'status'>, now: Date = new Date()): boolean =>
  m.status === 'scheduled' && new Date(m.kickoff).getTime() > now.getTime();

/**
 * Látható-e az ELLENFÉL tippje? Kickoff előtt soha. A szerver ezt kényszeríti ki;
 * a felület csak megjeleníti, amit kap.
 */
export const opponentPredictionVisible = (
  m: Pick<BattleMatchInfo, 'kickoff'>,
  battleStatus: BattleStatus,
  now: Date = new Date(),
): boolean => battleStatus === 'settled' || now.getTime() >= new Date(m.kickoff).getTime();

/** Gólszám-ellenőrzés – azonos a Tippverseny korlátjával. */
export const validScore = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 99;
