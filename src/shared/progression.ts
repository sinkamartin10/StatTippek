/**
 * Tipster Progression – XP, szintek, achievementek és profil-kozmetikumok.
 *
 * EZ A MODUL AZ EGYETLEN KONFIGURÁCIÓS HELY: az XP-értékek, a szintgörbe, az achievementek
 * és a kozmetikumok listája kizárólag itt él. A szerver ezt használja mérvadóként,
 * a kliens pedig ugyanezt a katalógust jeleníti meg – számolni sosem a kliens számol.
 *
 * FONTOS: ez a réteg a Tippverseny pontozásától FÜGGETLEN. A verseny pontjai
 * (5 / 3 / 0) változatlanok; az XP ezekből SZÁRMAZTATOTT, külön rendszer.
 */

// ===========================================================================
// 1) XP szabályok
// ===========================================================================

/** Helyes 1X2 (a versenyben 3 pont), de nem pontos eredmény. */
export const XP_CORRECT_OUTCOME = 25;
/** Pontos eredmény (a versenyben 5 pont). NEM adódik hozzá a +25. */
export const XP_EXACT_SCORE = 50;
/** Egyszeri bónusz, amikor egy sorozat eléri az 5 helyes tippet. */
export const XP_STREAK_BONUS = 100;
/** Hányadik helyes tippnél jár a sorozat-bónusz. */
export const STREAK_BONUS_AT = 5;
/** Egyszeri bónusz a 10. összesített pontos eredményért. */
export const XP_EXACT_MILESTONE_BONUS = 250;
export const EXACT_MILESTONE_AT = 10;
/** Verseny-helyezésért járó egyszeri XP (csak a verseny végleges lezárásakor). */
export const PLACEMENT_XP: Record<number, number> = { 1: 1000, 2: 750, 3: 500 };

/**
 * Egy KIÉRTÉKELT tipp XP-je a verseny pontszámából.
 * 5 pont (pontos eredmény) → 50 XP · 3 pont (helyes 1X2) → 25 XP · 0 pont → 0 XP.
 */
export function xpForPredictionPoints(points: number | null): number {
  if (points === 5) return XP_EXACT_SCORE;
  if (points === 3) return XP_CORRECT_OUTCOME;
  return 0;
}

/** Helyes tipp-e (sorozatszámításhoz): a pontos eredmény és a helyes 1X2 egyaránt az. */
export const isCorrect = (points: number | null): boolean => points === 3 || points === 5;
export const isExact = (points: number | null): boolean => points === 5;

// ===========================================================================
// 2) Szintgörbe – egyetlen helyen állítható
// ===========================================================================

/** Az 1→2 szinthez szükséges XP. */
export const LEVEL_BASE_XP = 120;
/** Minden további szint ennyivel kerül többe. */
export const LEVEL_STEP_XP = 60;
export const MAX_LEVEL = 100;

/** Az n. szintről az (n+1). szintre lépéshez szükséges XP. */
export function xpForLevel(level: number): number {
  return LEVEL_BASE_XP + LEVEL_STEP_XP * (level - 1);
}

/** Összes XP, ami a megadott szint ELÉRÉSÉHEZ kell (level 1 = 0 XP). */
export function totalXpToReach(level: number): number {
  let sum = 0;
  for (let i = 1; i < level; i++) sum += xpForLevel(i);
  return sum;
}

export interface LevelState {
  level: number;
  /** a jelenlegi szinten belül megszerzett XP */
  xpIntoLevel: number;
  /** a következő szinthez szükséges XP (a max szinten 0) */
  xpForNextLevel: number;
  /** 0..1 arány a haladásjelzőhöz */
  progress: number;
  tier: string;
}

/** XP → szint. Tiszta függvény; a szerver ezt számolja, a kliens csak megjeleníti. */
export function levelFromXp(xp: number): LevelState {
  const safeXp = Math.max(0, Math.floor(xp));
  let level = 1;
  let remaining = safeXp;
  while (level < MAX_LEVEL && remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level++;
  }
  const needed = level >= MAX_LEVEL ? 0 : xpForLevel(level);
  return {
    level,
    xpIntoLevel: remaining,
    xpForNextLevel: needed,
    progress: needed ? Math.min(1, remaining / needed) : 1,
    tier: tierForLevel(level),
  };
}

/** Szint-fokozatok (a profil „Level 18 · Analyst” felirata ebből jön). */
export const LEVEL_TIERS: { minLevel: number; name: string }[] = [
  { minLevel: 1, name: 'Rookie' },
  { minLevel: 5, name: 'Amateur' },
  { minLevel: 10, name: 'Tipster' },
  { minLevel: 20, name: 'Analyst' },
  { minLevel: 30, name: 'Expert' },
  { minLevel: 50, name: 'Master Tipster' },
  { minLevel: 100, name: 'Legend' },
];

export function tierForLevel(level: number): string {
  let name = LEVEL_TIERS[0].name;
  for (const t of LEVEL_TIERS) if (level >= t.minLevel) name = t.name;
  return name;
}

// ===========================================================================
// 3) Statisztika – minden achievement és kozmetikum feltétele ebből számol
// ===========================================================================

export interface ProgressionStats {
  /** kiértékelt (lezárt) tippek száma */
  settledPredictions: number;
  /** helyes tippek (3 vagy 5 pont) */
  correctPredictions: number;
  /** pontos eredmények (5 pont) */
  exactScores: number;
  /** a leghosszabb helyes sorozat */
  bestStreak: number;
  /** a jelenleg futó helyes sorozat */
  currentStreak: number;
  competitionsWon: number;
  runnerUps: number;
  thirdPlaces: number;
  /** hány különböző ligában van kiértékelt tippje */
  distinctLeagues: number;
  /** ligánkénti helyes tippek (liga-kulcs → darab) */
  correctByLeague: Record<string, number>;
  level: number;
}

export const EMPTY_STATS: ProgressionStats = {
  settledPredictions: 0, correctPredictions: 0, exactScores: 0,
  bestStreak: 0, currentStreak: 0, competitionsWon: 0, runnerUps: 0, thirdPlaces: 0,
  distinctLeagues: 0, correctByLeague: {}, level: 1,
};

/** Egy kiértékelt tipp a statisztikához (kezdési idő szerint rendezve érkezik). */
export interface SettledPrediction {
  predictionId: string;
  points: number;
  kickoff: string;
  leagueKey: string;
}

/**
 * Statisztika újraszámolása a NYERS adatokból. Determinisztikus és idempotens:
 * ugyanaz a bemenet mindig ugyanazt adja, ezért a többszöri futtatás ártalmatlan.
 * A sorozatot a mérkőzések kezdési ideje szerint számoljuk (nem a mentés sorrendje szerint).
 */
export function computeStats(
  settled: SettledPrediction[],
  placements: { placement: number }[],
  xp: number,
): ProgressionStats {
  const ordered = [...settled].sort((a, b) => (a.kickoff === b.kickoff ? a.predictionId.localeCompare(b.predictionId) : a.kickoff.localeCompare(b.kickoff)));
  const correctByLeague: Record<string, number> = {};
  const leagues = new Set<string>();
  let correct = 0, exact = 0, streak = 0, best = 0;

  for (const p of ordered) {
    leagues.add(p.leagueKey);
    if (isCorrect(p.points)) {
      correct++;
      streak++;
      if (streak > best) best = streak;
      correctByLeague[p.leagueKey] = (correctByLeague[p.leagueKey] ?? 0) + 1;
    } else {
      streak = 0;
    }
    if (isExact(p.points)) exact++;
  }

  return {
    settledPredictions: ordered.length,
    correctPredictions: correct,
    exactScores: exact,
    bestStreak: best,
    currentStreak: streak,
    competitionsWon: placements.filter((p) => p.placement === 1).length,
    runnerUps: placements.filter((p) => p.placement === 2).length,
    thirdPlaces: placements.filter((p) => p.placement === 3).length,
    distinctLeagues: leagues.size,
    correctByLeague,
    level: levelFromXp(xp).level,
  };
}

/**
 * A sorozat-bónuszt kiváltó tippek azonosítói: azok, amelyeknél a futó sorozat
 * ÉPPEN eléri az 5-öt. Minden sorozat legfeljebb egyszer ad bónuszt.
 */
export function streakBonusPredictionIds(settled: SettledPrediction[]): string[] {
  const ordered = [...settled].sort((a, b) => (a.kickoff === b.kickoff ? a.predictionId.localeCompare(b.predictionId) : a.kickoff.localeCompare(b.kickoff)));
  const ids: string[] = [];
  let streak = 0;
  for (const p of ordered) {
    if (isCorrect(p.points)) {
      streak++;
      if (streak === STREAK_BONUS_AT) ids.push(p.predictionId);
    } else {
      streak = 0;
    }
  }
  return ids;
}

// ===========================================================================
// 4) Achievementek
// ===========================================================================

export type AchievementCategory = 'prediction' | 'competition' | 'progression' | 'exploration';

export interface Achievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: AchievementCategory;
  /** A feltétel KIZÁRÓLAG szerveroldalon értékelődik ki. */
  condition: (s: ProgressionStats) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { key: 'first_hit', name: 'Első találat', description: 'Az első helyes tipped a Tippversenyben.', icon: '🎯', category: 'prediction', condition: (s) => s.correctPredictions >= 1 },
  { key: 'bullseye', name: 'Telitalálat', description: 'Az első pontos eredményed.', icon: '🎯', category: 'prediction', condition: (s) => s.exactScores >= 1 },
  { key: 'on_fire', name: 'Lendületben', description: '5 egymást követő helyes tipp.', icon: '🔥', category: 'prediction', condition: (s) => s.bestStreak >= STREAK_BONUS_AT },
  { key: 'tipster', name: 'Tippmester', description: '50 helyes tipp.', icon: '🧠', category: 'prediction', condition: (s) => s.correctPredictions >= 50 },
  { key: 'sharpshooter', name: 'Mesterlövész', description: '10 pontos eredmény.', icon: '🎯', category: 'prediction', condition: (s) => s.exactScores >= 10 },
  { key: 'champion', name: 'Bajnok', description: 'Tippverseny megnyerése.', icon: '🏆', category: 'competition', condition: (s) => s.competitionsWon >= 1 },
  { key: 'runner_up', name: 'Döntős', description: '2. hely egy Tippversenyben.', icon: '🥈', category: 'competition', condition: (s) => s.runnerUps >= 1 },
  { key: 'podium', name: 'Dobogós', description: 'Tippverseny 3. hely.', icon: '🥉', category: 'competition', condition: (s) => s.thirdPlaces >= 1 },
  { key: 'rising_star', name: 'Feltörekvő', description: 'A 10. szint elérése.', icon: '📈', category: 'progression', condition: (s) => s.level >= 10 },
  { key: 'legend', name: 'Legenda', description: 'Az 50. szint elérése.', icon: '👑', category: 'progression', condition: (s) => s.level >= 50 },
  { key: 'globe_trotter', name: 'Világjáró', description: 'Tipp legalább 5 különböző ligában.', icon: '🌍', category: 'exploration', condition: (s) => s.distinctLeagues >= 5 },
  { key: 'premier_predictor', name: 'Premier League szakértő', description: '10 helyes tipp Premier League tippversenyben.', icon: '⚽', category: 'exploration', condition: (s) => (s.correctByLeague['eng-pl'] ?? 0) >= 10 },
  { key: 'la_liga_expert', name: 'LaLiga szakértő', description: '10 helyes tipp LaLiga tippversenyben.', icon: '🇪🇸', category: 'exploration', condition: (s) => (s.correctByLeague['esp-ll'] ?? 0) >= 10 },
];

export const ACHIEVEMENT_KEYS = new Set(ACHIEVEMENTS.map((a) => a.key));
export const achievementByKey = (key: string): Achievement | undefined => ACHIEVEMENTS.find((a) => a.key === key);

/** Mely achievementek teljesülnek a megadott statisztikával? (Szerveroldali kiértékelés.) */
export function earnedAchievementKeys(stats: ProgressionStats): string[] {
  return ACHIEVEMENTS.filter((a) => a.condition(stats)).map((a) => a.key);
}

// ===========================================================================
// 5) Kozmetikumok – feloldási feltételek
// ===========================================================================

export type Requirement =
  | { kind: 'default' }
  | { kind: 'level'; level: number }
  | { kind: 'achievement'; key: string }
  | { kind: 'exactScores'; min: number }
  | { kind: 'bestStreak'; min: number }
  | { kind: 'competitionsWon'; min: number };

export function requirementLabel(r: Requirement): string {
  switch (r.kind) {
    case 'default': return 'Alapból elérhető';
    case 'level': return `Level ${r.level}`;
    case 'achievement': return `${achievementByKey(r.key)?.name ?? r.key} achievement`;
    case 'exactScores': return `${r.min} pontos eredmény`;
    case 'bestStreak': return `${r.min} helyes tipp egymás után`;
    case 'competitionsWon': return `${r.min} megnyert Tippverseny`;
  }
}

/** Teljesül-e a feltétel? KIZÁRÓLAG szerveroldali adatból számol. */
export function meetsRequirement(r: Requirement, stats: ProgressionStats, unlocked: Set<string>): boolean {
  switch (r.kind) {
    case 'default': return true;
    case 'level': return stats.level >= r.level;
    case 'achievement': return unlocked.has(r.key);
    case 'exactScores': return stats.exactScores >= r.min;
    case 'bestStreak': return stats.bestStreak >= r.min;
    case 'competitionsWon': return stats.competitionsWon >= r.min;
  }
}

export interface CosmeticOption {
  key: string;
  name: string;
  requirement: Requirement;
  /** megjelenítési segédérték (szín, minta azonosító) */
  value?: string;
  /** finom animáció a keretekhez */
  animation?: 'glow' | 'flame' | 'pulse' | 'sweep';
}

export type AvatarSlot = 'skin' | 'hair' | 'hairColor' | 'shirt' | 'shirtColor' | 'accessory' | 'background';

/** Avatar-elemek. Nincs feltöltött profilkép: csak ezekből az elemekből lehet választani. */
export const AVATAR_PARTS: Record<AvatarSlot, CosmeticOption[]> = {
  skin: [
    { key: 'light', name: 'Világos', value: '#f2c6a0', requirement: { kind: 'default' } },
    { key: 'medium', name: 'Közepes', value: '#e0a878', requirement: { kind: 'default' } },
    { key: 'tan', name: 'Barna', value: '#c08552', requirement: { kind: 'default' } },
    { key: 'deep', name: 'Sötét', value: '#8d5524', requirement: { kind: 'default' } },
  ],
  hair: [
    { key: 'short', name: 'Rövid', requirement: { kind: 'default' } },
    { key: 'buzz', name: 'Borotvált', requirement: { kind: 'default' } },
    { key: 'curly', name: 'Göndör', requirement: { kind: 'default' } },
    { key: 'long', name: 'Hosszú', requirement: { kind: 'default' } },
    { key: 'bald', name: 'Kopasz', requirement: { kind: 'default' } },
    { key: 'mohawk', name: 'Taréj', requirement: { kind: 'level', level: 10 } },
  ],
  hairColor: [
    { key: 'black', name: 'Fekete', value: '#2b2b33', requirement: { kind: 'default' } },
    { key: 'brown', name: 'Barna', value: '#6b4423', requirement: { kind: 'default' } },
    { key: 'blonde', name: 'Szőke', value: '#e3c16f', requirement: { kind: 'default' } },
    { key: 'red', name: 'Vörös', value: '#b5462f', requirement: { kind: 'default' } },
    { key: 'grey', name: 'Ősz', value: '#9aa3b2', requirement: { kind: 'default' } },
    { key: 'gold', name: 'Arany', value: '#f0b429', requirement: { kind: 'level', level: 20 } },
  ],
  shirt: [
    { key: 'plain', name: 'Egyszínű', requirement: { kind: 'default' } },
    { key: 'stripes', name: 'Csíkos', requirement: { kind: 'default' } },
    { key: 'hoops', name: 'Vízszintes csíkos', requirement: { kind: 'level', level: 5 } },
    { key: 'sash', name: 'Átlós sáv', requirement: { kind: 'achievement', key: 'champion' } },
  ],
  shirtColor: [
    { key: 'blue', name: 'Kék', value: '#4f6ef7', requirement: { kind: 'default' } },
    { key: 'red', name: 'Piros', value: '#e23d4b', requirement: { kind: 'default' } },
    { key: 'green', name: 'Zöld', value: '#17b877', requirement: { kind: 'default' } },
    { key: 'white', name: 'Fehér', value: '#f2f4fa', requirement: { kind: 'default' } },
    { key: 'black', name: 'Fekete', value: '#2b3245', requirement: { kind: 'default' } },
    { key: 'purple', name: 'Lila', value: '#8b5cf6', requirement: { kind: 'level', level: 15 } },
    { key: 'gold', name: 'Arany', value: '#f0b429', requirement: { kind: 'level', level: 30 } },
  ],
  accessory: [
    { key: 'none', name: 'Nincs', requirement: { kind: 'default' } },
    { key: 'headband', name: 'Fejpánt', requirement: { kind: 'default' } },
    { key: 'shades', name: 'Napszemüveg', requirement: { kind: 'achievement', key: 'sharpshooter' } },
    { key: 'captain', name: 'Csapatkapitányi szalag', requirement: { kind: 'achievement', key: 'champion' } },
  ],
  background: [
    { key: 'solid', name: 'Egyszínű', requirement: { kind: 'default' } },
    { key: 'rays', name: 'Sugarak', requirement: { kind: 'level', level: 5 } },
    { key: 'pitch', name: 'Pálya', requirement: { kind: 'level', level: 15 } },
    { key: 'confetti', name: 'Konfetti', requirement: { kind: 'achievement', key: 'champion' } },
  ],
};

export const AVATAR_SLOTS: AvatarSlot[] = ['skin', 'hair', 'hairColor', 'shirt', 'shirtColor', 'accessory', 'background'];

export const AVATAR_SLOT_LABEL: Record<AvatarSlot, string> = {
  skin: 'Bőrszín', hair: 'Frizura', hairColor: 'Hajszín',
  shirt: 'Mez', shirtColor: 'Mezszín', accessory: 'Kiegészítő', background: 'Háttér',
};

/** Profilkép-keretek. Néhány visszafogott animációval. */
export const BORDERS: CosmeticOption[] = [
  { key: 'none', name: 'Nincs keret', requirement: { kind: 'default' } },
  { key: 'classic', name: 'Klasszikus', value: '#cdd5ea', requirement: { kind: 'default' } },
  { key: 'sharp_shooter', name: 'Mesterlövész keret', value: '#4f6ef7', requirement: { kind: 'exactScores', min: 5 } },
  { key: 'goal_hunter', name: 'Góllövő keret', value: '#17b877', requirement: { kind: 'exactScores', min: 10 }, animation: 'glow' },
  { key: 'elite_tipster', name: 'Elit tippmester keret', value: '#8b5cf6', requirement: { kind: 'exactScores', min: 25 }, animation: 'sweep' },
  { key: 'flame', name: 'Lángoló keret', value: '#f5a524', requirement: { kind: 'bestStreak', min: 5 }, animation: 'flame' },
  { key: 'champion', name: 'Bajnok keret', value: '#f0b429', requirement: { kind: 'competitionsWon', min: 1 }, animation: 'pulse' },
  { key: 'legend', name: 'Legenda keret', value: '#e23d4b', requirement: { kind: 'level', level: 50 }, animation: 'sweep' },
];

/** Címek. A szint-fokozatok automatikusan nyílnak, a többi teljesítményhez kötött. */
export const TITLES: CosmeticOption[] = [
  { key: 'none', name: 'Nincs cím', requirement: { kind: 'default' } },
  ...LEVEL_TIERS.map((t) => ({ key: `tier_${t.name.toLowerCase().replace(/\s+/g, '_')}`, name: t.name, requirement: { kind: 'level', level: t.minLevel } as Requirement })),
  { key: 'champion', name: 'Champion', requirement: { kind: 'achievement', key: 'champion' } },
  { key: 'sharpshooter', name: 'Sharpshooter', requirement: { kind: 'achievement', key: 'sharpshooter' } },
  { key: 'on_fire', name: 'On Fire', requirement: { kind: 'achievement', key: 'on_fire' } },
];

export const MAX_SHOWCASE = 3;

/** A profil beállításai (a felhasználó választása – a szerver minden elemét ellenőrzi). */
export interface ProfileSettings {
  avatar: Record<AvatarSlot, string>;
  border: string;
  title: string;
  showcase: string[];
}

export const DEFAULT_SETTINGS: ProfileSettings = {
  avatar: { skin: 'light', hair: 'short', hairColor: 'black', shirt: 'plain', shirtColor: 'blue', accessory: 'none', background: 'solid' },
  border: 'classic',
  title: 'none',
  showcase: [],
};

/** Egy slot/keret/cím elérhető-e a felhasználónak? */
export function isCosmeticUnlocked(option: CosmeticOption, stats: ProgressionStats, unlockedAchievements: Set<string>): boolean {
  return meetsRequirement(option.requirement, stats, unlockedAchievements);
}

/**
 * A beküldött beállítás ellenőrzése és „megtisztítása”: minden nem létező vagy
 * fel nem oldott elem helyére az alapértelmezés kerül. A szerver ezt menti el.
 */
export function sanitizeSettings(
  input: Partial<ProfileSettings> | null | undefined,
  stats: ProgressionStats,
  unlockedAchievements: Set<string>,
): { settings: ProfileSettings; rejected: string[] } {
  const rejected: string[] = [];
  const avatar = { ...DEFAULT_SETTINGS.avatar };

  for (const slot of AVATAR_SLOTS) {
    const wanted = input?.avatar?.[slot];
    if (wanted == null) continue;
    const opt = AVATAR_PARTS[slot].find((o) => o.key === wanted);
    if (!opt) { rejected.push(`avatar.${slot}:${wanted}`); continue; }
    if (!isCosmeticUnlocked(opt, stats, unlockedAchievements)) { rejected.push(`avatar.${slot}:${wanted}`); continue; }
    avatar[slot] = opt.key;
  }

  let border = DEFAULT_SETTINGS.border;
  if (input?.border != null) {
    const opt = BORDERS.find((o) => o.key === input.border);
    if (opt && isCosmeticUnlocked(opt, stats, unlockedAchievements)) border = opt.key;
    else rejected.push(`border:${input.border}`);
  }

  let title = DEFAULT_SETTINGS.title;
  if (input?.title != null) {
    const opt = TITLES.find((o) => o.key === input.title);
    if (opt && isCosmeticUnlocked(opt, stats, unlockedAchievements)) title = opt.key;
    else rejected.push(`title:${input.title}`);
  }

  const showcase: string[] = [];
  for (const key of input?.showcase ?? []) {
    if (showcase.length >= MAX_SHOWCASE) { rejected.push(`showcase:${key}`); continue; }
    // Csak létező ÉS már feloldott achievement kerülhet a kiemelésbe
    if (!ACHIEVEMENT_KEYS.has(key) || !unlockedAchievements.has(key) || showcase.includes(key)) { rejected.push(`showcase:${key}`); continue; }
    showcase.push(key);
  }

  return { settings: { avatar, border, title, showcase }, rejected };
}

/** A felületen mutatott, feloldott/zárolt bontású katalógus. */
export interface CosmeticView extends CosmeticOption {
  unlocked: boolean;
  requirementLabel: string;
}

export function viewCosmetics(options: CosmeticOption[], stats: ProgressionStats, unlocked: Set<string>): CosmeticView[] {
  return options.map((o) => ({ ...o, unlocked: isCosmeticUnlocked(o, stats, unlocked), requirementLabel: requirementLabel(o.requirement) }));
}
