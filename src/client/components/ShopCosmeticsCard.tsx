/**
 * A profil oldal shop-kozmetikum kártyája.
 *
 * A MEGLÉVŐ megjelenítőt (CosmeticProfile) használja, nincs külön „shop
 * profil" állapot: a megszolgált megjelenés a progression végpontról, a
 * felvett shop itemek a `/api/profile/customization`-ről jönnek.
 *
 * A két rendszer külön látszik: ha shop-cím is fel van véve, a kártya
 * MINDKETTŐT megnevezi, hogy egyértelmű legyen, melyik az aktív.
 */
import { Link } from 'react-router-dom';
import { Coins, ShoppingBag } from 'lucide-react';
import { TITLES } from '@shared/progression';
import { CATEGORY_LABEL, EMPTY_EQUIPS, PROFILE_SLOTS, PROFILE_SLOT_LABEL, SLOT_TO_CATEGORY, type ProfileSlot } from '@shared/shop';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { Card, Loading } from './ui';
import { CosmeticProfile, seedLookup } from './CosmeticProfile';
import { useCoins } from './CoinsProvider';
import { formatCoins } from '../lib/shopView';

export function ShopCosmeticsCard({ displayName }: { displayName: string | null }) {
  const { balance } = useCoins();
  const custom = useAsync(() => api.customization().catch(() => null), []);
  const prog = useAsync(() => api.progressionMe().catch(() => null), []);

  const shop = custom.data?.shop ?? { ...EMPTY_EQUIPS };
  const settings = prog.data?.settings;
  const equipped = (Object.entries(shop) as [ProfileSlot, string | null][]).filter(([, v]) => !!v);

  const earnedTitle = settings?.title && settings.title !== 'none'
    ? (TITLES.find((t) => t.key === settings.title)?.name ?? null)
    : null;
  const shopTitleName = shop.title ? (seedLookup(shop.title)?.name ?? shop.title) : null;

  return (
    <Card
      title={<span className="flex items-center gap-2"><ShoppingBag className="h-4 w-4" aria-hidden /> Kozmetikumok</span>}
      right={
        <span className="flex items-center gap-2">
          <span className="coin-price" aria-label={`Egyenleged: ${formatCoins(balance ?? 0)} coin`}>
            <Coins className="h-3.5 w-3.5" aria-hidden /> <span className="mono tabular-nums">{formatCoins(balance ?? 0)}</span>
          </span>
          <Link to="/shop" className="btn btn-sm btn-primary">Shop</Link>
        </span>
      }
    >
      {custom.loading || prog.loading ? (
        <Loading text="Megjelenés betöltése…" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
          <CosmeticProfile
            displayName={displayName ?? 'Te'}
            avatar={settings?.avatar}
            borderKey={settings?.border}
            titleKey={settings?.title}
            shop={shop}
            size={104}
          />

          <div className="min-w-0 space-y-2">
            {equipped.length === 0 ? (
              <p className="text-sm font-semibold text-text-muted">
                Még nincs felvett kozmetikumod. A Shopban coinból vásárolhatsz keretet, névszínt, címet és profil-hátteret.
              </p>
            ) : (
              <dl className="space-y-1.5">
                {PROFILE_SLOTS.filter((s) => shop[s]).map((slot) => (
                  <div key={slot} className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs font-bold text-text-muted">{PROFILE_SLOT_LABEL[slot]}</dt>
                    <dd className="min-w-0 truncate text-sm font-extrabold">
                      {seedLookup(shop[slot]!)?.name ?? shop[slot]}
                      <span className="ml-1.5 text-xs font-bold text-text-muted">{CATEGORY_LABEL[SLOT_TO_CATEGORY[slot]]}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {/* A két címrendszer szándékosan külön – itt egyértelműsítjük, melyik az aktív */}
            {shopTitleName && earnedTitle && (
              <p className="rounded-xl border border-border bg-card-2 p-2.5 text-xs font-semibold text-text-muted">
                Aktív cím: <strong className="text-text">{shopTitleName}</strong> (Shop).
                A megszolgált címed (<strong className="text-text">{earnedTitle}</strong>) megmarad – a Shop-cím levétele után újra ez látszik.
              </p>
            )}

            <p className="text-xs font-semibold text-text-muted">
              A kozmetikumok csak a megjelenést változtatják: nincs hatásuk a tippekre, az XP-re, a pontozásra és a ranglista sorrendjére.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
