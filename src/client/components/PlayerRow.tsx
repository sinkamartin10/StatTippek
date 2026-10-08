/**
 * Egy játékos sora a social listákban (követettek, követők, keresés,
 * Top Tipsterek).
 *
 * A megjelenítést UGYANAZ a `CosmeticProfile` renderer adja, mint a profilon,
 * a Shopban és a ranglistán – nincs második kinézet-rendszer. A sor a
 * megjelenítési névre mutat, belső azonosítót nem ismer.
 */
import { Link } from 'react-router-dom';
import type { AvatarSlot } from '@shared/progression';
import type { ShopEquips } from '@shared/shop';
import type { PlayerCard } from '@shared/social';
import { CosmeticProfile } from './CosmeticProfile';

/** Arány százalékban. `null` → „–”, sosem NaN. */
const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);

export function PlayerRow({ player, right, compact = false }: {
  player: PlayerCard;
  right?: React.ReactNode;
  /** `true` esetén a saját szint/pontosság oszlop kimarad – ott, ahol a hívó
   *  már mutat egy mérőszámot (pl. Top Tipsterek), különben duplikálódna és
   *  keskeny kijelzőn kilógna. */
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <Link
        to={`/jatekos/${encodeURIComponent(player.displayName)}`}
        className="min-w-0 flex-1"
        aria-label={`${player.displayName} profilja`}
      >
        <CosmeticProfile
          displayName={player.displayName}
          avatar={player.avatar as Partial<Record<AvatarSlot, string>>}
          borderKey={player.borderKey}
          titleKey={player.titleKey}
          shop={player.shop as Partial<ShopEquips> | undefined}
          size={40}
          variant="row"
          className="min-w-0"
        />
      </Link>

      {!compact && (
        <span className="shrink-0 text-right">
          <span className="mono block text-sm font-extrabold">Szint {player.level}</span>
          <span className="block text-xs font-semibold text-text-muted">{pct(player.accuracy)} pontosság</span>
        </span>
      )}

      {right}
    </div>
  );
}
