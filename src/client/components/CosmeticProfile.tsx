/**
 * Kozmetikum-megjelenítő: EGY renderer, amit a shop előnézete, a profil oldal
 * és a ranglista egyaránt használ. Nincs külön „shop renderer".
 *
 * RÉTEGSORREND (hátulról előre):
 *   profil-háttér (shop)  →  avatar (a MEGSZOLGÁLT kompozícióval, benne az
 *   avatar saját háttere)  →  keret (shop vagy megszolgált)  →  név (shop
 *   névszín + név-effekt)  →  cím (shop vagy megszolgált)
 *
 * A két rendszer KÜLÖN marad:
 *   - a megszolgált keret (`borderKey`) és cím (`titleKey`) a progression
 *     katalógusából jön, és a PRO-szabályai változatlanok,
 *   - a shop kozmetikum a `shop` rétegből jön, és FREE felhasználónál is látszik.
 * Ha mindkettő adott, a SHOP item az aktív megjelenítés – a megszolgált adatot
 * viszont nem írjuk felül, és a felület jelezheti mindkettőt.
 */
import { TITLES, type AvatarSlot } from '@shared/progression';
import { SHOP_SEED, type ShopEquips, type ShopItem } from '@shared/shop';
import { Avatar } from './Avatar';

/** A megjelenítéshez szükséges item-adat. A metadata opcionális: a vetőmag
 *  egyes elemein (pl. címeken) nincs megjelenítési kiegészítő. */
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

const meta = (i: VisualItem | undefined) => (i?.metadata ?? {}) as {
  color?: string; gradient?: string[]; animation?: string; effect?: string;
  emblem?: string; perCharacter?: boolean; crown?: boolean;
};

/** A megszolgált cím megjelenítendő neve; `none`/ismeretlen esetén nincs cím. */
function earnedTitleName(key: string | undefined): string | null {
  if (!key || key === 'none') return null;
  return TITLES.find((t) => t.key === key)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Részek
// ---------------------------------------------------------------------------

/** Shop keret: színes/gradiens gyűrű az avatar körül. */
function ShopFrame({ item, size, children }: { item: VisualItem | undefined; size: number; children: React.ReactNode }) {
  const m = meta(item);
  if (!item) return <>{children}</>;
  const ring = m.gradient?.length
    ? `conic-gradient(from 0deg, ${[...m.gradient, m.gradient[0]].join(', ')})`
    : (m.color ?? 'var(--color-border-strong)');
  const anim = m.animation ? `shop-frame-${m.animation}` : '';
  return (
    <span
      className={`shop-frame ${anim}`}
      style={{ width: size + 10, height: size + 10, ['--shop-ring' as string]: ring }}
      aria-hidden
    >
      {children}
    </span>
  );
}

/** Shop avatar-embléma: kis jelvény az avatar jobb alsó sarkában. */
function Emblem({ item, size }: { item: VisualItem | undefined; size: number }) {
  if (!item) return null;
  const GLYPH: Record<string, string> = {
    football: '⚽', tipster: '🎯', brain: '🧠', fire: '🔥',
    ai: '🤖', diamond: '💎', champion: '🏆', goat: '🐐',
  };
  const glyph = GLYPH[meta(item).emblem ?? ''] ?? '★';
  return (
    <span className="shop-emblem" style={{ fontSize: Math.max(10, Math.round(size * 0.26)) }} title={item.name}>
      {glyph}
    </span>
  );
}

/** A név a shop névszínével és név-effektjével. */
function Name({
  children, color, effect,
}: { children: string; color: VisualItem | undefined; effect: VisualItem | undefined }) {
  const c = meta(color);
  const e = meta(effect);
  const style: React.CSSProperties = {};
  let className = 'shop-name';

  if (c.gradient?.length) {
    style.backgroundImage = `linear-gradient(90deg, ${c.gradient.join(', ')})`;
    className += ' shop-name-gradient';
  } else if (c.color) {
    style.color = c.color;
  }
  if (e.effect) className += ` shop-effect-${e.effect}`;
  // Az effekt derengése a névszínt követi (vagy az alapértelmezett szöveget)
  if (e.effect) {
    (style as Record<string, string>)['--shop-name-glow'] = c.color ?? (c.gradient?.[0] ?? 'var(--color-primary)');
  }

  return <span className={className} style={style}>{children}</span>;
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
  className?: string;
}

export function CosmeticProfile({
  displayName, avatar, borderKey = 'classic', titleKey, shop, lookup = seedLookup,
  size = 96, variant = 'card', className = '',
}: CosmeticProfileProps) {
  const frame = shop?.frame ? lookup(shop.frame) : undefined;
  const nameColor = shop?.nameColor ? lookup(shop.nameColor) : undefined;
  const nameEffect = shop?.nameEffect ? lookup(shop.nameEffect) : undefined;
  const shopTitle = shop?.title ? lookup(shop.title) : undefined;
  const emblem = shop?.avatar ? lookup(shop.avatar) : undefined;
  const background = shop?.profileBackground ? lookup(shop.profileBackground) : undefined;

  // A shop cím elsőbbséget kap a MEGJELENÍTÉSBEN, de a megszolgált adat marad
  const title = shopTitle?.name ?? earnedTitleName(titleKey);
  const bg = meta(background);
  const bgStyle: React.CSSProperties = bg.gradient?.length
    ? { backgroundImage: `linear-gradient(150deg, ${bg.gradient.join(', ')})` }
    : {};

  // Shop keret esetén a megszolgált keretet nem rajzoljuk kétszer
  const avatarBorder = frame ? 'none' : borderKey;

  const figure = (
    <span className="relative inline-flex shrink-0">
      <ShopFrame item={frame} size={size}>
        <Avatar avatar={avatar} border={avatarBorder} size={size} />
      </ShopFrame>
      <Emblem item={emblem} size={size} />
    </span>
  );

  if (variant === 'row') {
    return (
      <span className={`flex min-w-0 items-center gap-3 ${className}`}>
        {figure}
        <span className="min-w-0">
          <span className="block truncate text-sm font-extrabold">
            <Name color={nameColor} effect={nameEffect}>{displayName}</Name>
          </span>
          {title && <span className="block truncate text-xs font-bold text-text-muted">{title}</span>}
        </span>
      </span>
    );
  }

  return (
    <div
      className={`shop-profile-card ${background ? 'shop-profile-card-bg' : ''} ${className}`}
      style={bgStyle}
    >
      {figure}
      <div className="mt-3 text-center">
        <div className="text-base font-extrabold">
          <Name color={nameColor} effect={nameEffect}>{displayName}</Name>
        </div>
        <div className="mt-0.5 text-xs font-bold text-text-muted">{title ?? 'Nincs cím'}</div>
      </div>
    </div>
  );
}
