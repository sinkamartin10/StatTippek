/**
 * NYILVÁNOS játékosprofil – adatalak és szerializáló.
 *
 * EZ A FÁJL AZ ENGEDÉLYEZŐ LISTA. A `toPublicProfile()` kizárólag az itt
 * felsorolt mezőket építi be a válaszba: nyers adatbázis-sor SOHA nem jut ki.
 * Ha a progression vagy a Tippverseny modul később új mezőt kap, az
 * automatikusan NEM válik nyilvánossá – ide kell felvenni, tudatosan.
 *
 * AMI SOHA NEM KERÜLHET BE:
 *   user_id, e-mail, hitelesítési adat, coin-egyenleg, coin-tranzakció,
 *   vásárlási előzmény és készlet, Stripe/előfizetési adat, privát
 *   beállítás, egyedi tippek részletei (ellenfél, kezdés, tippelt gólszám),
 *   XP-eseménynapló, belső adatbázis-azonosítók.
 */
import type { ShopEquips } from './shop';

/** Szint és XP – a MEGLÉVŐ progression számításából, nem új képletből. */
export interface PublicProgression {
  level: number;
  levelTier: string;
  /** összes XP – összesítő érték, nem eseménynapló */
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  /** 0–1 közötti haladás a következő szintig */
  progress: number;
}

/** A felvett kozmetikumok – kizárólag a FELVETT elemek, készlet nélkül. */
export interface PublicCosmetics {
  avatar: Record<string, string>;
  /** megszolgált keret kulcsa */
  borderKey: string;
  /** megszolgált cím kulcsa */
  titleKey: string;
  /** felvett shop kozmetikumok slotonként */
  shop: Partial<ShopEquips>;
}

/** Egy feloldott achievement – a meglévő katalógus megjelenítési adataival. */
export interface PublicAchievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  /** mikor oldotta fel (ISO), ha ismert */
  unlockedAt: string | null;
}

/** Összesített tipster-statisztika. Egyedi tipp SOHA nem szerepel benne. */
export interface PublicStatistics {
  totalPredictions: number;
  settledPredictions: number;
  correctPredictions: number;
  exactScores: number;
  /** helyes / kiértékelt – null, ha még nincs kiértékelt tipp */
  accuracy: number | null;
  /** pontos eredmény / összes tipp – null, ha még nincs tipp */
  exactHitRate: number | null;
  bestStreak: number;
  currentStreak: number;
  distinctLeagues: number;
  competitions: number;
  competitionWins: number;
  competitionPodiums: number;
  /** a legjobb ismert helyezés, vagy null, ha nincs rögzített helyezése */
  bestPlacement: number | null;
}

/** Egy verseny-szereplés. A verseny azonosítója amúgy is nyilvános (URL-ben). */
export interface PublicCompetitionEntry {
  competitionId: string;
  name: string;
  points: number;
  predictions: number;
  exactHits: number;
  /** csak akkor ismert, ha a versenyen rögzített helyezése van */
  placement: number | null;
}

/** Egy kiemelés a profil tetejére. A `kind` alapján a felület rajzol ikont. */
export interface PublicHighlight {
  kind: 'win' | 'podium' | 'exact' | 'streak' | 'level' | 'accuracy';
  label: string;
  value: string;
}

export interface PublicProfileResponse {
  displayName: string;
  progression: PublicProgression;
  cosmetics: PublicCosmetics;
  achievements: PublicAchievement[];
  statistics: PublicStatistics;
  competitions: PublicCompetitionEntry[];
  highlights: PublicHighlight[];
}

/** Hány versenyt mutatunk legfeljebb – kötött felső korlát. */
export const PUBLIC_COMPETITION_LIMIT = 10;

/** Biztonságos arány: nulla osztó esetén `null`, sosem NaN vagy Infinity. */
export const ratio = (part: number, whole: number): number | null =>
  (whole > 0 && Number.isFinite(part) && Number.isFinite(whole) ? part / whole : null);

/** Egész szám biztonságosan (NaN/Infinity/negatív → 0). */
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/** 0 és 1 közé szorított arány. */
const unit = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/**
 * A nyilvános válasz összeállítása. MINDEN mező explicit: a bemeneti
 * objektumokból csak az kerül át, ami itt szerepel.
 */
export function toPublicProfile(input: {
  displayName: string;
  stats: {
    level: number; levelTier: string; totalXp: number; xpIntoLevel: number;
    xpForNextLevel: number; progress: number;
    totalPredictions: number; settledPredictions: number; correctPredictions: number;
    exactScores: number; accuracy: number | null; bestStreak: number; currentStreak: number;
    distinctLeagues: number; competitionWins: number; competitionPodiums: number;
  };
  cosmetics: { avatar: Record<string, string>; borderKey: string; titleKey: string; shop?: Partial<ShopEquips> };
  achievements: PublicAchievement[];
  competitions: PublicCompetitionEntry[];
}): PublicProfileResponse {
  const s = input.stats;

  const statistics: PublicStatistics = {
    totalPredictions: int(s.totalPredictions),
    settledPredictions: int(s.settledPredictions),
    correctPredictions: int(s.correctPredictions),
    exactScores: int(s.exactScores),
    accuracy: s.accuracy == null ? null : unit(s.accuracy),
    exactHitRate: ratio(int(s.exactScores), int(s.totalPredictions)),
    bestStreak: int(s.bestStreak),
    currentStreak: int(s.currentStreak),
    distinctLeagues: int(s.distinctLeagues),
    competitions: input.competitions.length,
    competitionWins: int(s.competitionWins),
    competitionPodiums: int(s.competitionPodiums),
    bestPlacement: input.competitions.reduce<number | null>(
      (best, c) => (c.placement != null && (best == null || c.placement < best) ? c.placement : best),
      null,
    ),
  };

  return {
    displayName: input.displayName,
    progression: {
      level: int(s.level) || 1,
      levelTier: String(s.levelTier ?? ''),
      xp: int(s.totalXp),
      xpIntoLevel: int(s.xpIntoLevel),
      xpForNextLevel: int(s.xpForNextLevel),
      progress: unit(s.progress),
    },
    cosmetics: {
      avatar: { ...input.cosmetics.avatar },
      borderKey: input.cosmetics.borderKey,
      titleKey: input.cosmetics.titleKey,
      shop: { ...(input.cosmetics.shop ?? {}) },
    },
    achievements: input.achievements.map((a) => ({
      key: a.key, name: a.name, description: a.description,
      icon: a.icon, category: a.category, unlockedAt: a.unlockedAt,
    })),
    statistics,
    competitions: input.competitions.slice(0, PUBLIC_COMPETITION_LIMIT).map((c) => ({
      competitionId: c.competitionId, name: c.name, points: c.points,
      predictions: c.predictions, exactHits: c.exactHits, placement: c.placement,
    })),
    highlights: buildHighlights(statistics, int(s.level), String(s.levelTier ?? '')),
  };
}

/**
 * Kiemelések – KIZÁRÓLAG a már kiszámolt, valós adatból. Amit nem lehet
 * biztonságosan levezetni, az kimarad; semmit nem találunk ki.
 */
export function buildHighlights(s: PublicStatistics, level: number, levelTier: string): PublicHighlight[] {
  const out: PublicHighlight[] = [];
  if (s.competitionWins > 0) {
    out.push({ kind: 'win', label: 'Verseny-győzelem', value: String(s.competitionWins) });
  } else if (s.competitionPodiums > 0) {
    out.push({ kind: 'podium', label: 'Dobogós helyezés', value: String(s.competitionPodiums) });
  }
  if (s.exactScores > 0) {
    out.push({ kind: 'exact', label: 'Pontos eredmény', value: String(s.exactScores) });
  }
  if (s.bestStreak >= 3) {
    out.push({ kind: 'streak', label: 'Leghosszabb sorozat', value: `${s.bestStreak} tipp` });
  }
  if (level > 1) {
    out.push({ kind: 'level', label: levelTier || 'Szint', value: `Szint ${level}` });
  }
  if (s.accuracy != null && s.settledPredictions >= 10) {
    out.push({ kind: 'accuracy', label: 'Találati arány', value: `${Math.round(s.accuracy * 100)}%` });
  }
  return out;
}
