/**
 * Napi és heti küldetések – EGYETLEN konfigurációs hely.
 *
 * Elv (azonos a progression modullal): a HALADÁS nem tárolt adat, hanem a már meglévő
 * Tippverseny-tippekből SZÁMÍTOTT érték. Az adatbázisban csak az kerül rögzítésre,
 * ami nem számítható: a jutalom átvételének ténye (idempotenciához és a számlálóhoz).
 *
 * A kliens sem haladást, sem jutalmat nem állíthat be – minden értéket a szerver ad.
 */

export const MISSION_TZ = 'Europe/Budapest';

// ===========================================================================
// 1) Periódus-kulcsok (Europe/Budapest szerint)
//
//    Szándékosan KULCS-EGYEZÉSSEL dolgozunk, nem időintervallumokkal: így a
//    nyári/téli időszámítás váltása sem tud elcsúszást okozni.
// ===========================================================================

const BUDAPEST_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: MISSION_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** A megadott pillanat budapesti naptári dátuma: YYYY-MM-DD. */
export function dayKey(at: Date = new Date()): string {
  return BUDAPEST_YMD.format(at);
}

/** Budapesti naptári dátum számokra bontva. */
function budapestParts(at: Date): { y: number; m: number; d: number } {
  const [y, m, d] = dayKey(at).split('-').map(Number);
  return { y, m, d };
}

/** ISO 8601 hét kulcsa budapesti idő szerint: YYYY-Www (a hét hétfővel kezdődik). */
export function weekKey(at: Date = new Date()): string {
  const { y, m, d } = budapestParts(at);
  // UTC-ben számolunk a naptári dátummal, hogy az időzóna ne zavarjon bele
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = (date.getUTCDay() + 6) % 7; // hétfő = 0
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 3); // az adott ISO hét csütörtöke
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export type MissionPeriod = 'daily' | 'weekly';

export const periodKeyFor = (period: MissionPeriod, at: Date = new Date()): string =>
  (period === 'daily' ? dayKey(at) : weekKey(at));

/**
 * A futó periódus vége (az első pillanat, amikor már új kulcs érvényes).
 * Bináris kereséssel, percre pontosan – így a téli/nyári időszámítás váltását is követi.
 */
export function periodEndsAt(period: MissionPeriod, at: Date = new Date()): string {
  const key = periodKeyFor(period, at);
  let lo = at.getTime();
  let hi = lo + (period === 'daily' ? 2 : 9) * 86400000;
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2);
    if (periodKeyFor(period, new Date(mid)) === key) lo = mid; else hi = mid;
  }
  return new Date(hi).toISOString();
}

// ===========================================================================
// 2) Küldetés-katalógus
//
//    Deklaratív: a `metric` + `target` páros írja le a feladatot, nincs
//    küldetésenkénti külön kód. Új küldetés felvétele = egy új sor itt.
// ===========================================================================

/**
 * Mit mérünk?
 *  - 'predictions' : a periódusban LEADOTT tippek (a beküldés ideje alapján)
 *  - 'correct'     : helyes tipp olyan mérkőzésre, amely a periódusban KEZDŐDÖTT
 *  - 'exact'       : pontos eredmény olyan mérkőzésre, amely a periódusban KEZDŐDÖTT
 *  - 'leagues'     : hány különböző ligában adott le tippet a periódusban
 *
 * A kétféle időalap szándékos: a „adj le tippet" a felhasználó tettéhez kötődik,
 * a „találj el" pedig a lejátszott mérkőzésekhez.
 */
export type MissionMetric = 'predictions' | 'correct' | 'exact' | 'leagues';

export interface Mission {
  key: string;
  period: MissionPeriod;
  icon: string;
  name: string;
  description: string;
  metric: MissionMetric;
  target: number;
  /** PRO felhasználónak járó XP. FREE felhasználó 0 XP-t kap (üzleti szabály). */
  xpReward: number;
}

/**
 * A küldetések listája. ITT, egy helyen szerkeszthető.
 * A kulcs, a cél és az XP a termékspecifikáció szerint rögzített.
 */
export const MISSIONS: Mission[] = [
  // --- Napi ---
  { key: 'daily_prediction_1', period: 'daily', icon: '🎯', name: 'Első tipped', description: 'Adj le 1 tippet a mai napon.', metric: 'predictions', target: 1, xpReward: 25 },
  { key: 'daily_prediction_3', period: 'daily', icon: '🔥', name: 'Napi forma', description: 'Adj le 3 tippet a mai napon.', metric: 'predictions', target: 3, xpReward: 50 },
  // --- Heti ---
  { key: 'weekly_prediction_10', period: 'weekly', icon: '📝', name: 'Heti forma', description: 'Adj le 10 tippet a héten.', metric: 'predictions', target: 10, xpReward: 150 },
  { key: 'weekly_exact_2', period: 'weekly', icon: '🎯', name: 'Pontos kéz', description: 'Találd el 2 mérkőzés pontos eredményét a héten.', metric: 'exact', target: 2, xpReward: 200 },
];

export const MISSION_KEYS = new Set(MISSIONS.map((m) => m.key));
export const missionByKey = (key: string): Mission | undefined => MISSIONS.find((m) => m.key === key);
export const missionsFor = (period: MissionPeriod): Mission[] => MISSIONS.filter((m) => m.period === period);

// ===========================================================================
// 3) Haladás számítása
// ===========================================================================

/** A küldetésekhez szükséges minimális tipp-adat (a meglévő táblákból). */
export interface MissionPredictionRow {
  predictionId: string;
  submittedAt: string;
  kickoff: string;
  leagueKey: string;
  points: number | null;
}

const isCorrectPoints = (p: number | null) => p === 3 || p === 5;

/**
 * Egy küldetés aktuális állása. TISZTA függvény: ugyanaz a bemenet mindig ugyanazt adja,
 * ezért a többszöri kiszámítás ártalmatlan, és a kliens nem tudja befolyásolni.
 */
export function missionProgress(mission: Mission, rows: MissionPredictionRow[], at: Date = new Date()): number {
  const key = periodKeyFor(mission.period, at);
  const inPeriodBySubmission = (r: MissionPredictionRow) => periodKeyFor(mission.period, new Date(r.submittedAt)) === key;
  const inPeriodByKickoff = (r: MissionPredictionRow) => periodKeyFor(mission.period, new Date(r.kickoff)) === key;

  switch (mission.metric) {
    case 'predictions':
      return rows.filter(inPeriodBySubmission).length;
    case 'correct':
      return rows.filter((r) => inPeriodByKickoff(r) && isCorrectPoints(r.points)).length;
    case 'exact':
      return rows.filter((r) => inPeriodByKickoff(r) && r.points === 5).length;
    case 'leagues':
      return new Set(rows.filter(inPeriodBySubmission).map((r) => r.leagueKey)).size;
  }
}

export const isMissionComplete = (mission: Mission, progress: number): boolean => progress >= mission.target;

/** Egy küldetés megjelenítendő állapota (a szerver állítja elő). */
export interface MissionView {
  key: string;
  period: MissionPeriod;
  icon: string;
  name: string;
  description: string;
  metric: MissionMetric;
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  claimedAt: string | null;
  /** a ténylegesen járó XP: PRO-nak a katalógus értéke, FREE-nek 0 */
  xpReward: number;
  /** a már jóváírt XP (0, ha még nem vette át, vagy FREE) */
  xpAwarded: number;
}

export interface MissionPeriodView {
  period: MissionPeriod;
  periodKey: string;
  /** mikor fordul át a periódus (ISO) */
  resetsAt: string;
  missions: MissionView[];
  completed: number;
  total: number;
}

/** A jutalom XP-eseményének forráskulcsa – ez adja az idempotenciát. */
export const missionSourceKey = (missionKey: string, periodKey: string): string => `mission:${missionKey}:${periodKey}`;
