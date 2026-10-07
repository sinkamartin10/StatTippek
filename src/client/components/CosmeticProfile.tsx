/**
 * Kozmetikum-megjelenítő – EGY renderer az egész alkalmazásban.
 *
 * Használja: a Shop előnézete és kártyái, a profil oldal, a nyilvános
 * játékosprofil és a ranglista. Nincs külön „shop renderer”.
 *
 * RÉTEGSORREND (hátulról előre):
 *   profil-háttér (shop)  →  avatar (a MEGSZOLGÁLT kompozícióval, benne az
 *   avatar saját háttere)  →  keret (shop vagy megszolgált)  →  embléma  →
 *   név (shop névszín + név-effekt)  →  cím (shop vagy megszolgált)
 *
 * A két rendszer KÜLÖN marad:
 *   - a megszolgált keret (`borderKey`) és cím (`titleKey`) a progression
 *     katalógusából jön, és a PRO-szabályai változatlanok,
 *   - a shop kozmetikum a `shop` rétegből jön, és FREE felhasználónál is látszik.
 * Ha mindkettő adott, a SHOP item az aktív megjelenítés – a megszolgált adatot
 * viszont nem írjuk felül, és a felület jelezheti mindkettőt.
 *
 * A konkrét látvány (sziluett, részecskék, jelenet) a `lib/cosmeticVisuals.ts`
 * regiszteréből jön; a katalógus adatait ez a komponens sem módosítja.
 */
import { Bot, Brain, CircleDot, Crown, Flame, Gem, Target, Trophy, type LucideIcon } from 'lucide-react';
import { TITLES, type AvatarSlot } from '@shared/progression';
import { SHOP_SEED, type ShopEquips, type ShopItem } from '@shared/shop';
import {
  backgroundVisual, effectVisual, emblemVisual, frameVisual, nameVisual, titleVisual,
  type EmblemIcon,
} from '../lib/cosmeticVisuals';
import { Avatar } from './Avatar';
import { FrameRing } from './cosmetics/FrameRing';
import { BackgroundScene } from './cosmetics/BackgroundScene';

/** A megjelenítéshez szükséges item-adat. */
type VisualItem = Pick<ShopItem, 'itemKey' | 'category' | 'name'> & { metadata?: Record<string, unknown> };

/**
 * Item-feloldó. Elsődlegesen a SZERVERTŐL kapott katalógusból, mert az az
 * authority; ha egy kulcs nincs a betöltött listában (pl. a ranglistán egy
 * olyan item, ami épp ki van vonva az aktív katalógusból), a vetőmag
 * MEGJELENÍTÉSI adatára esünk vissza. Ár és birtoklás ebből SOHA nem jön.
 */
export type ItemLookup = (itemKey: string) => VisualItem | undefined;

const SEED_BY_KEY = new Map<string, VisualItem>(SHOP_SEED.map((i) => [i.itemKey, i]));
export const seedLookup: ItemLookup = (key) => SEED_BY_KEY.get(key);

export function makeLookup(items: VisualItem[]): ItemLookup {
  const map = new Map(items.map((i) => [i.itemKey, i]));
  return (key) => map.get(key) ?? SEED_BY_KEY.get(key);
}

const EMBLEM_ICON: Record<EmblemIcon, LucideIcon> = {
  football: CircleDot, target: Target, brain: Brain, flame: Flame,
  bot: Bot, gem: Gem, trophy: Trophy, crown: Crown,
};

/** A megszolgált cím megjelenítendő neve; `none`/ismeretlen esetén nincs cím. */
function earnedTitleName(key: string | undefined): string | null {
  if (!key || key === 'none') return null;
  return TITLES.find((t) => t.key === key)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Név: shop névszín + név-effekt
// ---------------------------------------------------------------------------

function Name({
  children, colorKey, effectKey, onDark,
}: { children: string; colorKey?: string | null; effectKey?: string | null; onDark: boolean }) {
  const color = nameVisual(colorKey);
  const effect = effectVisual(effectKey);

  const style: React.CSSProperties = {};
  const set = (k: string, v: string) => { (style as Record<string, string>)[k] = v; };
  let cls = 'cos-name';

  if (color?.perCharacter) {
    cls += ' cos-name-spectrum';
  } else if (color && color.colors.length > 1) {
    style.backgroundImage = `linear-gradient(100deg, ${color.colors.join(', ')})`;
    cls += ' cos-name-gradient';
    if (color.sheen) cls += ' cos-name-sheen';
  } else if (color) {
    style.color = color.colors[0];
  } else if (onDark) {
    style.color = '#ffffff';
  }

  if (effect) {
    cls += ` cos-effect-${effect.kind}`;
    set('--cos-glow', effect.color ?? color?.colors[0] ?? 'var(--color-primary)');
  }

  // Szivárvány: karakterenkénti szín, de szóközöket épségben hagyva
  if (color?.perCharacter) {
    const chars = [...children];
    return (
      <span className={cls} style={style}>
        {chars.map((ch, i) => (
          <span key={i} style={{ color: color.colors[i % color.colors.length] }}>{ch}</span>
        ))}
      </span>
    );
  }

  return <span className={cls} style={style}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Cím: shop plakett vagy megszolgált szöveg
// ---------------------------------------------------------------------------

function TitleLine({
  shopKey, earnedKey, lookup, onDark,
}: { shopKey?: string | null; earnedKey?: string; lookup: ItemLookup; onDark: boolean }) {
  const visual = titleVisual(shopKey);
  const shopName = shopKey ? lookup(shopKey)?.name ?? shopKey : null;
  const earned = earnedTitleName(earnedKey);
  const label = shopName ?? earned;
  if (!label) return null;

  if (!visual) {
    return <span className={`cos-title ${onDark ? 'cos-on-dark' : ''}`}>{label}</span>;
  }

  const Icon = visual.icon ? EMBLEM_ICON[
    visual.icon === 'sparkles' ? 'gem'
      : visual.icon === 'star' ? 'trophy'
      : visual.icon === 'zap' ? 'flame'
      : visual.icon === 'target' ? 'target'
      : visual.icon === 'brain' ? 'brain'
      : visual.icon === 'crown' ? 'crown'
      : visual.icon === 'trophy' ? 'trophy'
      : 'flame'
  ] : null;

  const style: React.CSSProperties = {};
  (style as Record<string, string>)['--cos-title-a'] = visual.colors[0];
  (style as Record<string, string>)['--cos-title-b'] = visual.colors[visual.colors.length - 1];

  return (
    <span className={`cos-title cos-title-${visual.tier} ${onDark ? 'cos-on-dark' : ''}`} style={style}>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Fő komponens
// ---------------------------------------------------------------------------

export interface CosmeticProfileProps {
  displayName: string;
  /** a MEGSZOLGÁLT avatar-kompozíció (benne az avatar saját háttere) */
  avatar?: Partial<Record<AvatarSlot, string>>;
  /** a MEGSZOLGÁLT keret kulcsa */
  borderKey?: string;
  /** a MEGSZOLGÁLT cím kulcsa */
  titleKey?: string;
  /** a FELVETT shop kozmetikumok */
  shop?: Partial<ShopEquips>;
  /** item-feloldó (alapértelmezésben a vetőmag megjelenítési adatai) */
  lookup?: ItemLookup;
  size?: number;
  /** `card` = profilkártya háttérrel, `row` = kompakt sor (ranglista) */
  variant?: 'card' | 'row';
  /** csak a figurát rajzolja (shop kártya-előnézet) */
  figureOnly?: boolean;
  className?: string;
}

export function CosmeticProfile({
  displayName, avatar, borderKey = 'classic', titleKey, shop, lookup = seedLookup,
  size = 96, variant = 'card', figureOnly = false, className = '',
}: CosmeticProfileProps) {
  const frame = frameVisual(shop?.frame);
  const emblem = emblemVisual(shop?.avatar);
  const background = backgroundVisual(shop?.profileBackground);
  const onDark = variant === 'card' && !!background;

  // Shop keret esetén a megszolgált keretet nem rajzoljuk kétszer
  const avatarBorder = frame ? 'none' : borderKey;
  const EmblemIconCmp = emblem ? EMBLEM_ICON[emblem.icon] : null;

  const figure = size > 0 ? (
    <span className="cos-figure" style={{ width: size, height: size }}>
      <Avatar avatar={avatar} border={avatarBorder} size={size} />
      {frame && (
        <span className="cos-figure-frame">
          <FrameRing visual={frame} size={size * 1.22} />
        </span>
      )}
      {emblem && EmblemIconCmp && (
        <span
          className={`cos-emblem ${emblem.elevated ? 'cos-emblem-elevated' : ''}`}
          style={{
            width: Math.max(18, size * 0.34),
            height: Math.max(18, size * 0.34),
            background: `linear-gradient(140deg, ${emblem.colors[0]}, ${emblem.colors[1] ?? emblem.colors[0]})`,
          }}
          title={lookup(shop!.avatar!)?.name}
        >
          <EmblemIconCmp
            style={{ width: '58%', height: '58%' }}
            strokeWidth={2.4}
            color={emblem.elevated ? '#1d2539' : '#2b3245'}
            aria-hidden
          />
        </span>
      )}
    </span>
  ) : null;

  if (figureOnly) {
    return <span className={`inline-flex ${className}`}>{figure}</span>;
  }

  if (variant === 'row') {
    return (
      <span className={`flex min-w-0 items-center gap-3 ${className}`}>
        {figure}
        <span className="min-w-0">
          <span className="block truncate text-sm font-extrabold">
            <Name colorKey={shop?.nameColor} effectKey={shop?.nameEffect} onDark={false}>{displayName}</Name>
          </span>
          <span className="block truncate">
            <TitleLine shopKey={shop?.title} earnedKey={titleKey} lookup={lookup} onDark={false} />
          </span>
        </span>
      </span>
    );
  }

  return (
    <div className={`cos-card ${onDark ? 'cos-card-dark' : ''} ${className}`}>
      {background && <BackgroundScene visual={background} />}
      <div className="cos-card-body">
        {figure}
        <div className="mt-3 text-center">
          <div className="text-base font-extrabold">
            <Name colorKey={shop?.nameColor} effectKey={shop?.nameEffect} onDark={onDark}>{displayName}</Name>
          </div>
          <div className="mt-1 flex justify-center">
            <TitleLine shopKey={shop?.title} earnedKey={titleKey} lookup={lookup} onDark={onDark} />
          </div>
        </div>
      </div>
    </div>
  );
}
