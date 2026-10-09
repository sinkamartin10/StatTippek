/**
 * TERVEZETT árazás és ajánlói program – KIZÁRÓLAG VIZUÁLIS BEMUTATÓ.
 *
 * EZ AZ EGYETLEN HELY, ahol a javasolt árak szerepelnek. A nyitóoldal és a PRO
 * oldal is innen veszi őket, ezért a két felület nem tud szétcsúszni, és nem
 * mutathat egymásnak ellentmondó információt.
 *
 * BIZTONSÁG – ez a fájl SEMMILYEN fizetést nem érint:
 *  - a ténylegesen felszámított összeget a szerveroldali Stripe ár-azonosító
 *    (`STRIPE_PRICE_ID_PRO`) határozza meg, amit a kliens nem tud befolyásolni
 *    (`line_items: [{ price: priceId }]`),
 *  - itt egyetlen checkout-hívás sincs, és a gombok `disabled` állapotúak,
 *  - a MA ÉRVÉNYES árat továbbra is a `billingConfig()` adja, és azt mindkét
 *    oldal külön, „jelenlegi ár” felirattal jeleníti meg.
 *
 * Nincs ajánlói link, nincs kódgenerálás és nincs követés: a program még nem
 * indult el, ezt minden blokk külön ki is írja.
 */
import { Check, Crown, Gift, Users } from 'lucide-react';

/** A javasolt árak – EGYETLEN forrás mindkét oldalnak. */
export const PLANNED_PRICE = {
  pro: '3 490 Ft/hó',
  referrer: '2 990 Ft/hó',
  invitedFirst: '2 490 Ft',
  invitedLater: '3 490 Ft/hó',
};

/** A tervezett PRO-csomag tételei (a meglévő PRO funkciókra építve). */
const PLANNED_PRO_FEATURES = [
  'Minden PRO-ban elérhető mérkőzés',
  'AI-alapú mérkőzés-elemzés',
  'Futball-statisztikák és a további PRO funkciók',
];

/**
 * Fejléc a tervezett árazáshoz: cím + „Tervezett árazás” jelvény + az a
 * mondat, ami elválasztja a javaslatot a ma érvényes ártól.
 */
export function PlannedPricingHeader({ title }: { title: string }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-black tracking-tight md:text-3xl">{title}</h2>
        <span className="badge badge-yellow">Tervezett árazás</span>
      </div>
      <p className="mt-2 max-w-2xl text-sm font-semibold text-text-muted">
        Az alábbi három csomag <strong className="text-text">javaslat</strong>, és még nem él.
        A jelenleg érvényes előfizetési díjat külön, „jelenlegi ár” felirattal jelezzük.
      </p>
    </>
  );
}

/** A három tervezett csomag kártyája. A gombjaik szándékosan nem működnek. */
export function PlannedPricingCards() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <PlanCard
        icon={<Crown className="h-5 w-5 text-secondary" />}
        title="PRO"
        price={PLANNED_PRICE.pro}
        items={PLANNED_PRO_FEATURES}
      />
      <PlanCard
        featured
        icon={<Users className="h-5 w-5 text-primary" />}
        title="PRO ajánlóval"
        price={PLANNED_PRICE.referrer}
        note="Akkor jár, ha legalább egy általad meghívott barátod aktív, fizető előfizető."
        items={[
          'Minden PRO funkció, ugyanúgy',
          'Az ár akkor is ennyi marad, ha több barátod fizet elő',
          'A kedvezmények nem adódnak össze',
        ]}
      />
      <PlanCard
        icon={<Gift className="h-5 w-5 text-success" />}
        title="Hívj meg egy barátot"
        price={PLANNED_PRICE.invitedFirst}
        priceSuffix="az első hónap"
        note={`A meghívott barátod ára az első hónap után ${PLANNED_PRICE.invitedLater}.`}
        items={[
          'A barátod az ajánlói linkkel fizet elő',
          `Első hónap: ${PLANNED_PRICE.invitedFirst}`,
          `Utána: ${PLANNED_PRICE.invitedLater}`,
        ]}
      />
    </div>
  );
}

/**
 * Az ajánlói program bemutatója.
 *
 * NINCS benne ajánlói link és nincs kódgenerálás – a program még nem indult el,
 * és a felület ezt több helyen is kimondja.
 */
export function ReferralProgramCard() {
  return (
    <div className="card border-primary/30 p-6 md:p-10">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-black tracking-tight md:text-3xl">
          Hívd meg a barátaidat, és mindketten jól jártok!
        </h2>
        <span className="badge badge-yellow">Tervezett ajánlói program · Hamarosan</span>
      </div>

      <p className="mt-4 max-w-3xl text-base font-semibold text-text-muted">
        Hívd meg egy futballrajongó ismerősödet! Ha előfizet a TippStats PRO-ra, ő
        kedvezményesen kezdhet, te pedig {PLANNED_PRICE.referrer} áron használhatod a PRO-t,
        amíg legalább egy általad meghívott felhasználó aktív, fizető előfizető.
      </p>

      <div className="mt-7">
        <ol className="space-y-3.5">
          {[
            ['01', 'Megosztod a linked', 'Minden PRO-felhasználó saját ajánlói linket kapna.'],
            ['02', 'A barátod előfizet', `Az első hónapja ${PLANNED_PRICE.invitedFirst}, utána ${PLANNED_PRICE.invitedLater}.`],
            ['03', 'Te kedvezményes áron maradsz', `${PLANNED_PRICE.referrer}, amíg legalább egy meghívottad aktív, fizető előfizető.`],
          ].map(([n, title, text]) => (
            <li key={n} className="flex gap-3">
              <span className="mono shrink-0 text-2xl font-black text-primary/30">{n}</span>
              <span className="min-w-0">
                <span className="block text-base font-extrabold">{title}</span>
                <span className="block text-sm font-semibold text-text-muted">{text}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-6 text-xs font-semibold text-text-muted">
        A kedvezmények nem adódnak össze: több aktív meghívott esetén is {PLANNED_PRICE.referrer} az ár.
        Az ajánlói program még nem indult el – ez a felület kizárólag bemutató.
      </p>
    </div>
  );
}

/**
 * Egy TERVEZETT csomag kártyája.
 *
 * A gombja SZÁNDÉKOSAN nem működik (`disabled`): ez bemutató, és semmilyen
 * fizetési folyamatot nem indíthat. A ma érvényes előfizetés mindkét oldalon
 * külön, a „jelenlegi ár” kártyáról érhető el.
 */
function PlanCard({ icon, title, price, priceSuffix, note, items, featured }: {
  icon: React.ReactNode;
  title: string;
  price: string;
  priceSuffix?: string;
  note?: string;
  items: string[];
  featured?: boolean;
}) {
  return (
    <div className={`card card-lift flex flex-col p-6 ${featured ? 'border-primary/40 shadow-lift' : ''}`}>
      <h3 className="flex items-center gap-2 text-lg font-extrabold">{icon} {title}</h3>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-2xl font-black tracking-tight text-primary">{price}</span>
        {priceSuffix && <span className="text-sm font-bold text-text-muted">{priceSuffix}</span>}
      </div>
      {note && <p className="mt-1.5 text-xs font-semibold text-text-muted">{note}</p>}
      <ul className="mt-4 space-y-2.5 text-sm font-semibold">
        {items.map((t) => (
          <li key={t} className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {t}
          </li>
        ))}
      </ul>
      <button type="button" disabled aria-disabled="true" className="btn mt-6 w-full">
        Hamarosan
      </button>
    </div>
  );
}
