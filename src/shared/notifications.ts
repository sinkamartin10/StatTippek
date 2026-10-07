/**
 * In-app értesítések – EGYETLEN konfigurációs hely.
 *
 * Elv: a rendszer NEM Battle-specifikus. A típus-katalógus itt, kódban lakik
 * (ahogy a küldetéseknél és az achievementeknél), ezért új értesítés-típus
 * felvétele nem igényel migrációt. Az adatbázis csak annyit tud, hogy a `type`
 * egy rövid szöveg.
 *
 * Idempotencia: minden értesítésnek van `sourceKey`-e, és a `(user_id, source_key)`
 * pár EGYEDI. Ugyanaz az esemény ugyanannak a felhasználónak csak egyszer jelenik
 * meg, akárhányszor próbáljuk beszúrni – a `progression_events` bevált mintája.
 *
 * V1: kizárólag pull-alapú, in-app. Nincs e-mail, push, websocket, ütemező.
 */

// ===========================================================================
// 1) Lekérdezési korlátok (a HISTORY_* konvencióval azonos)
// ===========================================================================

export const NOTIFICATION_DEFAULT_LIMIT = 20;
export const NOTIFICATION_MAX_LIMIT = 50;
/** A fejléc legördülőjében ennyi elem látszik. */
export const NOTIFICATION_PREVIEW_LIMIT = 5;
/** A jelvény e fölött „9+”-t ír. */
export const UNREAD_BADGE_MAX = 9;

/** A jelvény szövege: 0 → nincs jelvény, 1–9 → pontos szám, 10+ → „9+”. */
export function badgeLabel(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : String(Math.floor(unread));
}

// ===========================================================================
// 2) Típus-katalógus
// ===========================================================================

export type NotificationType =
  | 'battle_challenge_received'
  | 'battle_challenge_accepted'
  | 'battle_challenge_declined'
  | 'battle_challenge_expired'
  | 'battle_won'
  | 'battle_lost'
  | 'battle_draw';

/** Mire mutat az értesítés – a felület ebből épít linket, típusonkénti ágazás nélkül. */
export type NotificationEntityType = 'battle';

export interface NotificationKind {
  type: NotificationType;
  icon: string;
  /** a részletező oldalon megjelenő rövid kategória */
  group: string;
}

/**
 * A V1 hét típusa. Szándékosan NINCS „kihívás visszavonva” értesítés: azt a
 * kihívó maga teszi, az ellenfél pedig olyan kihívásról kapna jelzést, amit
 * talán nem is látott – ez csak zajt termelne.
 */
export const NOTIFICATION_KINDS: NotificationKind[] = [
  { type: 'battle_challenge_received', icon: '⚔️', group: 'Tippcsata' },
  { type: 'battle_challenge_accepted', icon: '✅', group: 'Tippcsata' },
  { type: 'battle_challenge_declined', icon: '🚫', group: 'Tippcsata' },
  { type: 'battle_challenge_expired', icon: '⏳', group: 'Tippcsata' },
  { type: 'battle_won', icon: '🏆', group: 'Tippcsata' },
  { type: 'battle_lost', icon: '😔', group: 'Tippcsata' },
  { type: 'battle_draw', icon: '🤝', group: 'Tippcsata' },
];

export const NOTIFICATION_TYPES = new Set<string>(NOTIFICATION_KINDS.map((k) => k.type));
export const kindOf = (type: string): NotificationKind | undefined =>
  NOTIFICATION_KINDS.find((k) => k.type === type);
/** Ismeretlen típusnál sem törhet el a felület. */
export const iconOf = (type: string): string => kindOf(type)?.icon ?? '🔔';

// ===========================================================================
// 3) Idempotencia-kulcsok
// ===========================================================================

/**
 * Egy battle-esemény forráskulcsa.
 *
 * A LEZÁRÁS kulcsa SZÁNDÉKOSAN kimenet-független (`settled`, nem `won`/`lost`):
 * így egy utólagos eredmény-korrekció sem hozhat létre egy második, ellentmondó
 * értesítést ugyanarról a párbajról. Ugyanezért kapott a Phase 2-ben a
 * sorozat-bónusz is ordinális kulcsot.
 */
export type BattleNotificationEvent = 'challenge' | 'accepted' | 'declined' | 'expired' | 'settled';

export const battleSourceKey = (battleId: string, event: BattleNotificationEvent): string =>
  `battle:${battleId}:${event}`;

// ===========================================================================
// 4) Adatalakok
// ===========================================================================

/** Egy értesítés sora. A `metadata` a megjelenítéshez szükséges extrákat hordozza. */
export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** Új értesítés – a `userId`-t KIZÁRÓLAG a szerver állítja be. */
export interface NewNotification {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: NotificationEntityType | null;
  entityId?: string | null;
  sourceKey: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationListResponse {
  notifications: NotificationRow[];
  /** olvasatlanok száma – ugyanebben a válaszban, nincs külön count-kérés */
  unreadCount: number;
  /** van-e még régebbi elem (cursor-alapú lapozás) */
  hasMore: boolean;
  /** a következő laphoz átadandó cursor (a legutolsó elem createdAt-je), vagy null */
  nextBefore: string | null;
}

/**
 * Hova navigáljon a kattintás. A felület ebből épít útvonalat, típusonkénti
 * ágazás nélkül – ezért van külön `entityType`/`entityId` oszlop a sorban.
 */
export function targetPath(n: Pick<NotificationRow, 'entityType' | 'entityId'>): string | null {
  if (n.entityType === 'battle' && n.entityId) return `/battles/${n.entityId}`;
  return null;
}

/** Rövid, magyar relatív idő. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'most';
  if (min < 60) return `${min} perce`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} órája`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} napja`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} hete`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo} hónapja` : `${Math.floor(d / 365)} éve`;
}

// ===========================================================================
// 5) Battle-értesítések szövegei – egy helyen, hogy a service ne fogalmazzon
// ===========================================================================

export interface BattleNotificationText {
  type: NotificationType;
  title: string;
  body: string;
}

/** `opponentName` = a MÁSIK játékos megjelenítési neve (soha nem e-mail vagy azonosító). */
export function battleChallengeReceived(opponentName: string): BattleNotificationText {
  return {
    type: 'battle_challenge_received',
    title: `${opponentName} kihívott egy Tippcsatára`,
    body: 'Fogadd el, és add le a tippjeidet a 3 mérkőzésre.',
  };
}

export function battleChallengeAccepted(opponentName: string): BattleNotificationText {
  return {
    type: 'battle_challenge_accepted',
    title: `${opponentName} elfogadta a kihívásodat`,
    body: 'Indulhat a párbaj – add le a tippjeidet a mérkőzések kezdése előtt.',
  };
}

export function battleChallengeDeclined(opponentName: string): BattleNotificationText {
  return {
    type: 'battle_challenge_declined',
    title: `${opponentName} elutasította a kihívásodat`,
    body: 'Hívj ki másik játékost a Tippcsata oldalon.',
  };
}

export function battleChallengeExpired(opponentName: string): BattleNotificationText {
  return {
    type: 'battle_challenge_expired',
    title: 'A kihívásod lejárt',
    body: `${opponentName} nem válaszolt 24 órán belül. Ha szeretnéd, hívd ki újra.`,
  };
}

export function battleSettled(
  outcome: 'win' | 'loss' | 'draw',
  opponentName: string,
  myPoints: number,
  theirPoints: number,
): BattleNotificationText {
  const score = `${myPoints} : ${theirPoints}`;
  if (outcome === 'win') {
    return { type: 'battle_won', title: 'Megnyerted a Tippcsatát!', body: `${opponentName} ellen ${score} – szép munka.` };
  }
  if (outcome === 'loss') {
    return { type: 'battle_lost', title: 'Elvesztetted a Tippcsatát', body: `${opponentName} ellen ${score}. Jöhet a visszavágó.` };
  }
  return { type: 'battle_draw', title: 'Döntetlen a Tippcsatában', body: `${opponentName} ellen ${score} – senki nem tudott nyerni.` };
}
