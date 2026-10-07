/**
 * Kozmetikumok VIZUÁLIS regisztere (V2).
 *
 * EGYETLEN hely, ahol az 53 shop item megjelenése le van írva. A katalógus
 * adatait (itemKey, kategória, ritkaság, ár, név) NEM ismétli meg és NEM írja
 * felül – azok továbbra is a szerverről jönnek. Itt kizárólag az él, hogy egy
 * adott kulcs MILYEN legyen: milyen keret-sziluett, milyen név-kezelés,
 * milyen embléma, milyen háttér-jelenet.
 *
 * ELVEK
 *  - Minden itemnek SAJÁT vizuális identitása van: nem 15 ugyanolyan karika
 *    más színnel, hanem eltérő sziluett (korona, pikkely, kristály, áramkör…).
 *  - A ritkaság vizuálisan is emelkedik: common letisztult, legendary a
 *    látvány központja – de a ritkaság ADATA változatlan.
 *  - Az animáció visszafogott, és `prefers-reduced-motion` esetén kikapcsol
 *    (lásd styles.css).
 *  - Ismeretlen kulcsra mindig van értelmes alapértelmezés, így a felület
 *    akkor sem törik, ha a katalógus később bővül.
 */
import type { Rarity } from '@shared/shop';

// ===========================================================================
// Keretek
// ===========================================================================

/** A keret szerkezete – ez adja a felismerhető sziluettet. */
export type FrameShape =
  | 'ring'       // letisztult, egyszerű gyűrű (common)
  | 'wave'       // hullámos, vizes perem
  | 'bolt'       // cikcakkos, elektromos
  | 'flame'      // lángnyelvek
  | 'crystal'    // kristály-szilánkok
  | 'facet'      // csiszolt, gyémánt-lapok
  | 'orbit'      // keringő égitestek
  | 'nebula'     // kozmikus örvény
  | 'crown'      // korona-ornamentika
  | 'scale'      // sárkánypikkely + tüskék
  | 'aura'       // rétegzett, lélegző aura
  | 'spectrum';  // folyamatos színspektrum

/** Apró részecskék a keret körül. */
export type ParticleKind = 'none' | 'ember' | 'spark' | 'bubble' | 'star' | 'frost' | 'shine';

export interface FrameVisual {
  shape: FrameShape;
  /** a gyűrű színei; több szín = színátmenet */
  colors: string[];
  particles: ParticleKind;
  /** hány részecske keringjen (0 = nincs) */
  particleCount: number;
  /** finom mozgás; a reduced-motion kikapcsolja */
  motion: 'none' | 'pulse' | 'rotate' | 'flicker' | 'sweep';
  /** a gyűrű vastagsága az avatar méretéhez képest */
  thickness: number;
}

const FRAMES: Record<string, FrameVisual> = {
  // --- COMMON: letisztult, egy réteg, nincs részecske ---------------------
  frame_green:  { shape: 'ring', colors: ['#17b877'], particles: 'none', particleCount: 0, motion: 'none', thickness: 0.055 },
  frame_blue:   { shape: 'ring', colors: ['#4f6ef7'], particles: 'none', particleCount: 0, motion: 'none', thickness: 0.055 },
  frame_purple: { shape: 'ring', colors: ['#8b5cf6'], particles: 'none', particleCount: 0, motion: 'none', thickness: 0.055 },

  // --- RARE: saját sziluett + finom mozgás --------------------------------
  frame_fire:      { shape: 'flame',    colors: ['#f5533d', '#f0b429'],            particles: 'ember',  particleCount: 5, motion: 'flicker', thickness: 0.075 },
  frame_lightning: { shape: 'bolt',     colors: ['#38bdf8', '#e8f4ff'],            particles: 'spark',  particleCount: 4, motion: 'pulse',   thickness: 0.07 },
  frame_aqua:      { shape: 'wave',     colors: ['#22d3ee', '#0ea5e9'],            particles: 'bubble', particleCount: 5, motion: 'rotate',  thickness: 0.07 },
  frame_rainbow:   { shape: 'spectrum', colors: ['#f5533d', '#f0b429', '#17b877', '#4f6ef7', '#8b5cf6'], particles: 'none', particleCount: 0, motion: 'rotate', thickness: 0.075 },

  // --- EPIC: összetett geometria + részecskék ------------------------------
  frame_ice:     { shape: 'crystal', colors: ['#e0f2fe', '#7dd3fc', '#38bdf8'], particles: 'frost', particleCount: 6, motion: 'pulse',  thickness: 0.085 },
  frame_diamond: { shape: 'facet',   colors: ['#ffffff', '#a5c9ff', '#e8f4ff'], particles: 'shine', particleCount: 4, motion: 'sweep',  thickness: 0.085 },
  frame_galaxy:  { shape: 'orbit',   colors: ['#4c1d95', '#7c3aed', '#c4b5fd'], particles: 'star',  particleCount: 7, motion: 'rotate', thickness: 0.08 },
  frame_cosmic:  { shape: 'nebula',  colors: ['#312e81', '#db2777', '#f59e0b'], particles: 'star',  particleCount: 6, motion: 'rotate', thickness: 0.09 },

  // --- LEGENDARY: a látvány központja -------------------------------------
  frame_golden_crown:     { shape: 'crown', colors: ['#f0b429', '#fde68a', '#b45309'], particles: 'shine', particleCount: 5, motion: 'sweep',   thickness: 0.1 },
  frame_dragon:           { shape: 'scale', colors: ['#7f1d1d', '#f5533d', '#f0b429'], particles: 'ember', particleCount: 6, motion: 'flicker', thickness: 0.1 },
  frame_legendary_aura:   { shape: 'aura',  colors: ['#f0b429', '#fde68a'],            particles: 'shine', particleCount: 6, motion: 'pulse',   thickness: 0.095 },
  frame_animated_diamond: { shape: 'facet', colors: ['#ffffff', '#a5c9ff', '#8b5cf6'], particles: 'shine', particleCount: 8, motion: 'sweep',   thickness: 0.105 },
};

const DEFAULT_FRAME: FrameVisual = { shape: 'ring', colors: ['#cdd5ea'], particles: 'none', particleCount: 0, motion: 'none', thickness: 0.055 };

export const frameVisual = (itemKey: string | null | undefined): FrameVisual | null =>
  (itemKey ? FRAMES[itemKey] ?? DEFAULT_FRAME : null);

// ===========================================================================
// Névszínek
// ===========================================================================

export interface NameVisual {
  /** egy szín = tömör, több = színátmenet a szövegen */
  colors: string[];
  /** fémes csillanás fut végig a szövegen */
  sheen?: boolean;
  /** karakterenként váltakozó szín (szivárvány) */
  perCharacter?: boolean;
  /** a szöveg kontúrja sötét háttéren is olvasható marad */
  outline?: string;
}

const NAME_COLORS: Record<string, NameVisual> = {
  // COMMON – tömör, tiszta szín
  name_green:  { colors: ['#0f9d63'] },
  name_blue:   { colors: ['#3b57df'] },
  name_purple: { colors: ['#7c3aed'] },
  name_red:    { colors: ['#dc2f45'] },
  // RARE – színátmenet, az aranynál fémes csillanással
  name_gold:   { colors: ['#b45309', '#f0b429', '#fde68a'], sheen: true },
  name_cyan:   { colors: ['#0891b2', '#22d3ee'] },
  name_pink:   { colors: ['#db2777', '#f472b6', '#fb923c'] },
  // EPIC – prizmás / teljes spektrum
  name_diamond: { colors: ['#a5c9ff', '#ffffff', '#c4b5fd'], sheen: true },
  name_rainbow: { colors: ['#f5533d', '#f0b429', '#17b877', '#4f6ef7', '#8b5cf6'], perCharacter: true },
};

export const nameVisual = (itemKey: string | null | undefined): NameVisual | null =>
  (itemKey ? NAME_COLORS[itemKey] ?? null : null);

// ===========================================================================
// Név-effektek
// ===========================================================================

export type NameEffectKind = 'glow' | 'sparkle' | 'burning' | 'frost' | 'electric' | 'rainbow';

export interface EffectVisual {
  kind: NameEffectKind;
  /** a derengés alapszíne; ha nincs, a névszínt követi */
  color?: string;
  /** apró jelek a név körül */
  particles: number;
}

const NAME_EFFECTS: Record<string, EffectVisual> = {
  effect_glow:     { kind: 'glow',     particles: 0 },
  effect_shimmer:  { kind: 'sparkle',  particles: 3 },
  effect_fire:     { kind: 'burning',  color: '#f5533d', particles: 4 },
  effect_ice:      { kind: 'frost',    color: '#7dd3fc', particles: 4 },
  effect_electric: { kind: 'electric', color: '#38bdf8', particles: 3 },
  effect_rainbow:  { kind: 'rainbow',  particles: 5 },
};

export const effectVisual = (itemKey: string | null | undefined): EffectVisual | null =>
  (itemKey ? NAME_EFFECTS[itemKey] ?? null : null);

// ===========================================================================
// Címek
// ===========================================================================

/** A cím megjelenési fokozata – a ritkaságot követi, de a felület dönti el. */
export type TitleTier = 'plain' | 'badge' | 'plate' | 'elite';

export interface TitleVisual {
  tier: TitleTier;
  colors: string[];
  /** lucide ikon neve a cím előtt (a meglévő ikonkészletből) */
  icon?: 'sparkles' | 'flame' | 'target' | 'zap' | 'brain' | 'crown' | 'trophy' | 'star';
}

const TITLES: Record<string, TitleVisual> = {
  title_predictor:    { tier: 'plain', colors: ['#6d7894'], icon: 'target' },
  title_rising_star:  { tier: 'badge', colors: ['#4f6ef7', '#22d3ee'], icon: 'star' },
  title_hot_hand:     { tier: 'badge', colors: ['#f5533d', '#f0b429'], icon: 'flame' },
  title_risk_taker:   { tier: 'badge', colors: ['#8b5cf6', '#db2777'], icon: 'zap' },
  title_clutch:       { tier: 'plate', colors: ['#0891b2', '#22d3ee'], icon: 'sparkles' },
  title_streak_hunter:{ tier: 'plate', colors: ['#f0b429', '#f5533d'], icon: 'flame' },
  title_mastermind:   { tier: 'plate', colors: ['#7c3aed', '#c4b5fd'], icon: 'brain' },
  title_goat:         { tier: 'elite', colors: ['#b45309', '#f0b429', '#fde68a'], icon: 'crown' },
};

export const titleVisual = (itemKey: string | null | undefined): TitleVisual | null =>
  (itemKey ? TITLES[itemKey] ?? null : null);

// ===========================================================================
// Avatar-emblémák
// ===========================================================================

/** A meglévő lucide ikonkészletből – nincs emoji és nincs új ikonfüggőség. */
export type EmblemIcon =
  | 'football' | 'target' | 'brain' | 'flame' | 'bot' | 'gem' | 'trophy' | 'crown';

export interface EmblemVisual {
  icon: EmblemIcon;
  /** a jelvény háttere */
  colors: string[];
  /** a jelvény kerete kiemelt-e (magasabb ritkaság) */
  elevated: boolean;
}

const EMBLEMS: Record<string, EmblemVisual> = {
  avatar_football: { icon: 'football', colors: ['#f4f6fc', '#cdd5ea'], elevated: false },
  avatar_tipster:  { icon: 'target',   colors: ['#e8edfe', '#4f6ef7'], elevated: false },
  avatar_brain:    { icon: 'brain',    colors: ['#f3e8ff', '#8b5cf6'], elevated: false },
  avatar_fire:     { icon: 'flame',    colors: ['#fee8ec', '#f5533d'], elevated: false },
  avatar_ai:       { icon: 'bot',      colors: ['#e0f2fe', '#0891b2'], elevated: true },
  avatar_diamond:  { icon: 'gem',      colors: ['#e8f4ff', '#a5c9ff'], elevated: true },
  avatar_champion: { icon: 'trophy',   colors: ['#fff4e2', '#f0b429'], elevated: true },
  avatar_goat:     { icon: 'crown',    colors: ['#fde68a', '#b45309'], elevated: true },
};

export const emblemVisual = (itemKey: string | null | undefined): EmblemVisual | null =>
  (itemKey ? EMBLEMS[itemKey] ?? null : null);

// ===========================================================================
// Profil-hátterek
// ===========================================================================

/** A háttér jelenete – mindegyik külön SVG-kompozíciót kap. */
export type SceneKind = 'stadium' | 'pitch' | 'galaxy' | 'volcano' | 'frost' | 'sunrise' | 'void';

export interface BackgroundVisual {
  scene: SceneKind;
  /** a kompozíció alap-színátmenete */
  colors: string[];
  /** a rajta megjelenő szöveg színe */
  ink: 'light' | 'dark';
}

const BACKGROUNDS: Record<string, BackgroundVisual> = {
  bg_stadium: { scene: 'stadium', colors: ['#0f172a', '#1e293b', '#334155'], ink: 'light' },
  bg_pitch:   { scene: 'pitch',   colors: ['#064e3b', '#059669', '#17b877'], ink: 'light' },
  bg_galaxy:  { scene: 'galaxy',  colors: ['#1e1b4b', '#4c1d95', '#7c3aed'], ink: 'light' },
  bg_fire:    { scene: 'volcano', colors: ['#7f1d1d', '#dc2626', '#f59e0b'], ink: 'light' },
  bg_ice:     { scene: 'frost',   colors: ['#0c4a6e', '#0ea5e9', '#7dd3fc'], ink: 'light' },
  bg_gold:    { scene: 'sunrise', colors: ['#78350f', '#d97706', '#fbbf24'], ink: 'light' },
  bg_cosmic:  { scene: 'void',    colors: ['#0b1021', '#312e81', '#db2777'], ink: 'light' },
};

export const backgroundVisual = (itemKey: string | null | undefined): BackgroundVisual | null =>
  (itemKey ? BACKGROUNDS[itemKey] ?? null : null);

// ===========================================================================
// Ritkaság-hierarchia
// ===========================================================================

/**
 * A ritkaság vizuális súlya. A ritkaság ADATA a szerverről jön – ez csak a
 * megjelenítés erősségét szabályozza (hány réteg, mekkora kiemelés).
 */
export const RARITY_WEIGHT: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

/** Van-e az itemnek saját vizuális leírása? (teszthez és fejlesztéshez) */
export function hasVisual(itemKey: string, category: string): boolean {
  switch (category) {
    case 'frame': return itemKey in FRAMES;
    case 'name_color': return itemKey in NAME_COLORS;
    case 'name_effect': return itemKey in NAME_EFFECTS;
    case 'title': return itemKey in TITLES;
    case 'avatar': return itemKey in EMBLEMS;
    case 'profile_background': return itemKey in BACKGROUNDS;
    default: return false;
  }
}

/** A regiszter teljes kulcskészlete – a tesztek ebből ellenőriznek. */
export const VISUAL_KEYS = {
  frame: Object.keys(FRAMES),
  name_color: Object.keys(NAME_COLORS),
  name_effect: Object.keys(NAME_EFFECTS),
  title: Object.keys(TITLES),
  avatar: Object.keys(EMBLEMS),
  profile_background: Object.keys(BACKGROUNDS),
};
