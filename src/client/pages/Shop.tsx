/**
 * Shop – kozmetikumok coinból.
 *
 * ELVEK
 *  - A katalógus, az ÁR, a ritkaság, a birtoklás és a felvett állapot MIND a
 *    szerverről jön (`GET /api/shop/items`, `GET /api/profile/customization`).
 *    A felületen egyetlen hardcode-olt item sincs.
 *  - A szűrés és a rendezés a MÁR betöltött katalógusból, kliensoldalon megy –
 *    kattintásonként nincs újabb szerverkérés.
 *  - Az élő előnézet kizárólag lokális állapot: nem vásárol, nem ír, nem küld
 *    kérést.
 *  - A vásárlás és a felvétel a szerver döntése; a felület csak megjelenít és
 *    a szerverválaszból frissít.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Coins, PackageOpen, RotateCcw, Sparkles, Store } from 'lucide-react';
import type { ProfileSlot, ShopCategory, ShopEquips, ShopItem, ShopItemView } from '@shared/shop';
import { CATEGORY_LABEL, EMPTY_EQUIPS, RARITY_LABEL } from '@shared/shop';
import { api, ApiError } from '../lib/api';
import {
  ACTION_LABEL, CATEGORY_FILTERS, SORT_OPTIONS, actionFor, blockedText, catalogSummary,
  filterByCategory, formatCoins, groupByCategory, isEquipped, previewEquips, purchaseErrorText,
  rarityClass, slotOf, sortItems, stateBadge,
  type CategoryFilter, type SortKey,
} from '../lib/shopView';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { CosmeticProfile, makeLookup } from '../components/CosmeticProfile';
import { useCoins } from '../components/CoinsProvider';

type View = 'shop' | 'mine';

interface Flash { tone: 'ok' | 'err'; text: string }

export default function Shop() {
  const { balance, applyServerBalance } = useCoins();

  const [items, setItems] = useState<ShopItemView[] | null>(null);
  const [equips, setEquips] = useState<ShopEquips>({ ...EMPTY_EQUIPS });
  const [displayName, setDisplayName] = useState('Te');
  const [earned, setEarned] = useState<{ avatar?: Record<string, string>; borderKey?: string; titleKey?: string }>({});

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [view, setView] = useState<View>('shop');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [sort, setSort] = useState<SortKey>('recommended');

  /** Kipróbált item – KIZÁRÓLAG lokális előnézet. */
  const [tried, setTried] = useState<ShopItem | null>(null);
  /** Folyamatban lévő művelet item-kulcsa – ez a kérés-zár a dupla kattintás ellen. */
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * A zár SZINKRON változata. A `busy` állapot csak a következő renderben
   * látszik, ezért két, ugyanabban a tickben induló kattintás átcsúszhatna
   * rajta; a ref azonnal zár. (A végső védelem így is az adatbázis.)
   */
  const lock = useRef(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  // ---------------------------------------------------------------- betöltés
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Három kötegelt kérés – item-enként egyetlen plusz hívás sincs
      const [catalog, custom, profile] = await Promise.all([
        api.shopItems(),
        api.customization(),
        api.profileMe().catch(() => null),
      ]);
      setItems(catalog.items);
      applyServerBalance(catalog.balance);
      setEquips(custom.shop);
      if (profile?.displayName) setDisplayName(profile.displayName);
      // A megszolgált megjelenés a meglévő progression végpontról (nem kötelező)
      const prog = await api.progressionMe().catch(() => null);
      if (prog) setEarned({ avatar: prog.settings.avatar, borderKey: prog.settings.border, titleKey: prog.settings.title });
    } catch (e) {
      setLoadError(e instanceof ApiError && e.status === 401
        ? 'Jelentkezz be a Shop használatához.'
        : 'A Shop most nem tölthető be.');
    } finally {
      setLoading(false);
    }
  }, [applyServerBalance]);

  useEffect(() => { void load(); }, [load]);

  // ------------------------------------------------------------- levezetések
  const lookup = useMemo(() => makeLookup(items ?? []), [items]);
  const summary = useMemo(() => catalogSummary(items ?? []), [items]);

  const visible = useMemo(() => {
    const base = view === 'mine' ? (items ?? []).filter((i) => i.owned) : (items ?? []);
    return sortItems(filterByCategory(base, category), sort);
  }, [items, view, category, sort]);

  const groups = useMemo(() => (category === 'all' ? groupByCategory(visible) : null), [visible, category]);

  /** Az előnézet állapota: a felvett kozmetikumok + a kipróbált item. */
  const preview = useMemo(() => previewEquips(equips, tried), [equips, tried]);

  // ------------------------------------------------------------------ műveletek
  const purchase = async (item: ShopItemView) => {
    if (lock.current) return;              // kérés-zár: egyszerre egy művelet
    lock.current = true;
    setBusy(item.itemKey);
    setFlash(null);
    try {
      const res = await api.purchaseShopItem(item.itemKey);
      applyServerBalance(res.balance);     // az egyenleg a SZERVER válaszából
      setItems((prev) => (prev ?? []).map((i) => (i.itemKey === item.itemKey
        ? { ...i, owned: true, purchasable: false, blockedReason: 'owned' as const }
        : { ...i, purchasable: i.owned ? false : i.purchasable && res.balance >= i.priceCoins,
            blockedReason: i.owned ? ('owned' as const)
              : res.balance >= i.priceCoins ? i.blockedReason : ('insufficient_coins' as const) })));
      setFlash({ tone: 'ok', text: `${item.name} megvásárolva.` });
    } catch (e) {
      const err = e as ApiError;
      setFlash({ tone: 'err', text: purchaseErrorText(err) });
      if (err.code === 'ITEM_ALREADY_OWNED') void load();   // elcsúszott állapot – újratöltés
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const equip = async (slot: ProfileSlot, itemKey: string | null, name: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(itemKey ?? `unequip:${slot}`);
    setFlash(null);
    try {
      const res = await api.equipShopItem(slot, itemKey);
      setEquips(res.shop);                 // a felvett állapot a SZERVER válaszából
      setTried(null);
      setFlash({ tone: 'ok', text: itemKey ? `${name} felvéve.` : `${name} levéve.` });
    } catch (e) {
      setFlash({ tone: 'err', text: purchaseErrorText(e as ApiError) });
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  // --------------------------------------------------------------- állapotok
  if (loading && !items) {
    return (
      <div className="space-y-5">
        <PageHeader emoji="🛍️" title="Shop" text="Kozmetikumok coinból – a játékmenetre nincs hatásuk." />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="shop-grid" aria-busy>
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="shop-skeleton" />)}
          </div>
          <div className="shop-skeleton h-72" />
        </div>
        <Loading text="Shop betöltése…" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader emoji="🛍️" title="Shop" />
        <ErrorBox message={loadError} onRetry={() => void load()} />
      </div>
    );
  }

  const all = items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        emoji="🛍️"
        title="Shop"
        text="Kozmetikumok coinból. Nincs hatásuk a tippekre, a pontozásra és a ranglista sorrendjére."
        right={
          <span className="coin-pill coin-pill-lg" aria-label={`Egyenleged: ${formatCoins(balance ?? 0)} coin`}>
            <Coins className="h-4 w-4" aria-hidden /> <span className="mono tabular-nums">{formatCoins(balance ?? 0)}</span>
          </span>
        }
      />

      {/* --------------------------- nézet + szűrők --------------------------- */}
      <div className="space-y-3">
        <div role="tablist" aria-label="Shop nézet" className="flex gap-2">
          {([['shop', 'Shop', Store], ['mine', 'Saját elemeim', PackageOpen]] as const).map(([v, label, Icon]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={`btn btn-sm ${view === v ? 'btn-primary' : ''}`}
              onClick={() => setView(v)}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
              {v === 'mine' && <span className="badge badge-muted ml-1">{summary.owned}</span>}
            </button>
          ))}
        </div>

        <div className="shop-toolbar">
          <div className="shop-filters" role="group" aria-label="Kategória szűrő">
            {CATEGORY_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                aria-pressed={category === f.value}
                className={`chip ${category === f.value ? 'chip-active' : ''}`}
                onClick={() => setCategory(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <label className="shop-sort">
            <span className="sr-only">Rendezés</span>
            <select className="input !py-2" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Rendezés">
              {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
      </div>

      {flash && (
        <div role="status" aria-live="polite">
          <Note tone={flash.tone === 'ok' ? 'info' : 'warn'}>{flash.text}</Note>
        </div>
      )}

      {/* --------------------------- tartalom + előnézet --------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-6">
          {visible.length === 0 ? (
            view === 'mine' ? (
              <EmptyState
                emoji="🎁"
                title="Még nincs kozmetikumod"
                text="Tippelj, teljesítsd a küldetéseket, és a megszerzett coinból vásárolj."
                action={<button type="button" className="btn btn-primary" onClick={() => { setView('shop'); setCategory('all'); }}>Böngészem a Shopot</button>}
              />
            ) : (
              <EmptyState emoji="🔍" title="Nincs találat" text="Ebben a kategóriában most nincs elérhető elem." />
            )
          ) : groups ? (
            groups.map((g) => (
              <section key={g.category} aria-labelledby={`cat-${g.category}`}>
                <h2 id={`cat-${g.category}`} className="mb-2 text-sm font-extrabold uppercase tracking-wide text-text-muted">
                  {g.label} <span className="font-bold normal-case">· {g.items.length}</span>
                </h2>
                <ItemGrid items={g.items} />
              </section>
            ))
          ) : (
            <ItemGrid items={visible} />
          )}
        </div>

        {/* Élő előnézet – csak lokális állapot, nem ír semmit */}
        <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4" aria-hidden /> Élő előnézet</span>} className="lg:sticky lg:top-20">
          <CosmeticProfile
            displayName={displayName}
            avatar={earned.avatar}
            borderKey={earned.borderKey}
            titleKey={earned.titleKey}
            shop={preview}
            lookup={lookup}
            size={104}
          />
          <p className="mt-3 text-xs font-semibold text-text-muted">
            {tried
              ? 'Előnézet – csak nálad, a profilod még nem változott.'
              : 'Vidd az egeret egy elemre (vagy fókuszáld), és itt megjelenik.'}
          </p>
          {tried && (
            <button type="button" className="btn btn-sm mt-2" onClick={() => setTried(null)}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Előnézet vissza
            </button>
          )}
          <EquippedList equips={equips} lookup={lookup} busy={busy} onUnequip={equip} />
        </Card>
      </div>

      <p className="text-xs font-semibold text-text-muted">
        A Shop {summary.total} elemet kínál, ebből {summary.owned} már a tiéd. Az árakat és a ritkaságot a szerver adja.
      </p>
    </div>
  );

  // ------------------------------------------------------------------ részek
  function ItemGrid({ items: list }: { items: ShopItemView[] }) {
    return (
      <ul className="shop-grid">
        {list.map((item) => {
          const equipped = isEquipped(equips, item);
          const action = actionFor(item, equipped);
          const badge = stateBadge(item, equipped);
          const blocked = blockedText(item, balance ?? 0);
          const working = busy === item.itemKey;
          return (
            <li key={item.itemKey}>
              <article
                className={`shop-card ${rarityClass(item.rarity)} ${equipped ? 'shop-card-equipped' : ''}`}
                onMouseEnter={() => setTried(item)}
                onFocus={() => setTried(item)}
              >
                <div className="shop-card-preview" aria-hidden>
                  <ItemPreview item={item} />
                </div>

                <div className="mt-2 min-w-0">
                  <h3 className="truncate text-sm font-extrabold" title={item.name}>{item.name}</h3>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className={`rarity-badge ${rarityClass(item.rarity)}`}>{RARITY_LABEL[item.rarity]}</span>
                    {badge && <span className={`badge ${badge.tone === 'equipped' ? 'badge-blue' : badge.tone === 'owned' ? 'badge-green' : 'badge-muted'}`}>{badge.label}</span>}
                  </div>
                  {item.description && <p className="mt-1.5 line-clamp-2 text-xs font-semibold text-text-muted">{item.description}</p>}
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  {item.owned ? (
                    <span className="text-xs font-bold text-text-muted">{CATEGORY_LABEL[item.category]}</span>
                  ) : (
                    <span className="coin-price" aria-label={`Ár: ${formatCoins(item.priceCoins)} coin`}>
                      <Coins className="h-3.5 w-3.5" aria-hidden /> <span className="mono tabular-nums">{formatCoins(item.priceCoins)}</span>
                    </span>
                  )}

                  {action === 'buy' && (
                    <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} aria-busy={working} onClick={() => void purchase(item)}>
                      {working ? 'Vásárlás…' : ACTION_LABEL.buy}
                    </button>
                  )}
                  {action === 'equip' && (
                    <button type="button" className="btn btn-sm" disabled={!!busy} aria-busy={working} onClick={() => void equip(slotOf(item), item.itemKey, item.name)}>
                      {working ? 'Felvétel…' : ACTION_LABEL.equip}
                    </button>
                  )}
                  {action === 'unequip' && (
                    <button type="button" className="btn btn-sm btn-ghost" disabled={!!busy} aria-busy={working} onClick={() => void equip(slotOf(item), null, item.name)}>
                      {working ? 'Levétel…' : ACTION_LABEL.unequip}
                    </button>
                  )}
                  {action === 'blocked' && (
                    <button type="button" className="btn btn-sm" disabled title={blocked ?? undefined}>{ACTION_LABEL.blocked}</button>
                  )}
                </div>

                {!item.owned && blocked && item.blockedReason === 'insufficient_coins' && (
                  <p className="mt-1.5 text-xs font-bold text-warning">{blocked}</p>
                )}
              </article>
            </li>
          );
        })}
      </ul>
    );
  }

  /**
   * Kategória-tudatos előnézet – a MEGLÉVŐ rendererrel, nincs külön rendszer.
   * Keret/avatar/háttér: figura; névszín/effekt/cím: a név kezelése.
   */
  function ItemPreview({ item }: { item: ShopItemView }) {
    const one: Partial<ShopEquips> = { [slotOf(item)]: item.itemKey };

    if (item.category === 'profile_background') {
      return (
        <CosmeticProfile
          displayName={displayName}
          avatar={earned.avatar}
          borderKey={earned.borderKey}
          shop={one}
          lookup={lookup}
          size={46}
          className="h-full w-full !rounded-xl !border-0"
        />
      );
    }

    if (item.category === 'name_color' || item.category === 'name_effect' || item.category === 'title') {
      return (
        <CosmeticProfile
          displayName={displayName}
          shop={one}
          lookup={lookup}
          size={0}
          variant="row"
          className="justify-center px-2 text-center"
        />
      );
    }

    return (
      <CosmeticProfile
        displayName={displayName}
        avatar={earned.avatar}
        borderKey={item.category === 'frame' ? 'none' : earned.borderKey}
        shop={one}
        lookup={lookup}
        size={60}
        figureOnly
      />
    );
  }
}

/** A felvett kozmetikumok listája levétel-gombbal. */
function EquippedList({
  equips, lookup, busy, onUnequip,
}: {
  equips: ShopEquips;
  lookup: ReturnType<typeof makeLookup>;
  busy: string | null;
  onUnequip: (slot: ProfileSlot, itemKey: null, name: string) => Promise<void>;
}) {
  const rows = (Object.entries(equips) as [ProfileSlot, string | null][]).filter(([, key]) => !!key);
  if (!rows.length) {
    return <p className="mt-4 border-t border-border pt-3 text-xs font-semibold text-text-muted">Még nincs felvett kozmetikumod.</p>;
  }
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h4 className="mb-2 text-xs font-extrabold uppercase tracking-wide text-text-muted">Felvéve</h4>
      <ul className="space-y-1.5">
        {rows.map(([slot, key]) => {
          const item = lookup(key!);
          const working = busy === `unequip:${slot}`;
          return (
            <li key={slot} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-bold">{item?.name ?? key}</span>
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                disabled={!!busy}
                aria-busy={working}
                onClick={() => void onUnequip(slot, null, item?.name ?? 'Elem')}
              >
                {working ? '…' : 'Leveszem'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
