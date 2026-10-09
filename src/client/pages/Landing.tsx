/**
 * Nyitóoldal – ezt látja először a látogató. Önálló elrendezés (nincs app-navigáció);
 * bejelentkezett felhasználót a HomeGate a dashboardra irányítja.
 *
 * A cél, hogy öt másodperc alatt kiderüljön: a TippStats nem egy tipp-lista, hanem
 * verseny – tippelsz, pontot szerzel, 1v1-ben kiállsz másokkal és felmászol a ranglistán.
 *
 * KÉT SZABÁLY, AMI MINDEN SZÖVEGRE VONATKOZIK:
 *  1. Csak olyan állítás szerepelhet, ami a jelenlegi productionben IGAZ. A FREE/PRO
 *     bontás a tényleges szerveroldali kapukat tükrözi (kvóta, requirePro, XP-kapu),
 *     nem marketing-kívánságot.
 *  2. Nincs kitalált adat: se felhasználószám, se sikersztori, se álstatisztika. A
 *     termék-előnézet a VALÓDI, nyilvános Tippverseny-ranglistát mutatja, vagy ha
 *     nincs mit mutatni, egyszerűen nem jelenik meg.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Check, ChevronDown, Crown, LogIn, Menu, ShieldAlert, Swords, Trophy, UserPlus, X,
} from 'lucide-react';
import type { LeaderboardRow } from '@shared/competition';
import { POINTS_EXACT, POINTS_OUTCOME } from '@shared/competition';
import { BATTLE_MATCH_COUNT } from '@shared/battles';
import { FREE_DAILY_PREDICTION_LIMIT } from '@shared/freeQuota';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Layout';
import { Accordion } from '../components/ui';
import { LeaderboardList } from '../components/LeaderboardList';
import {
  PlannedPricingCards, PlannedPricingHeader, ReferralProgramCard,
} from '../components/PlannedPricing';
import { PRO_PRICE } from './Pro';

/** Hány sort mutatunk az élő ranglistából – rövid, hogy ne nyomja le a hajtást. */
const PREVIEW_ROWS = 5;
/** Hány versenyt nézünk át az előnézethez – kötött felső korlát, nincs N+1 robbanás. */
const PREVIEW_CANDIDATES = 3;

const FEATURES = [
  { emoji: '⚽', title: 'Tippelj', text: 'Add le a tippedet és nézd meg, hogyan teljesítesz hosszú távon.' },
  { emoji: '🏆', title: 'Versenyezz', text: 'Vegyél részt Tippversenyekben és mássz fel a ranglistán.' },
  { emoji: '⚔️', title: 'Hívd ki a többieket', text: 'Küzdj meg más PRO játékosokkal 1v1 Tippcsatában.' },
  { emoji: '📈', title: 'Fejlődj', text: 'Teljesíts küldetéseket, gyűjts XP-t és építsd fel a profilodat.' },
];

const STEPS = [
  { n: '01', title: 'Regisztrálj', text: 'Hozd létre a profilodat pár perc alatt.' },
  { n: '02', title: 'Tippelj', text: 'Válaszd ki a meccseket és add le a tippjeidet.' },
  { n: '03', title: 'Versenyezz', text: 'Szerezz pontokat, kövesd a helyezésedet és hívd ki a többieket.' },
];

/**
 * A FREE lista a TÉNYLEGES szerveroldali szabályokat írja le:
 * a napi kvótát (`FREE_DAILY_PREDICTION_LIMIT`), és azt, hogy a küldetés teljesítése
 * rögzül, de az XP-jutalom PRO-hoz kötött (`MissionService.claim`, `syncUser`).
 */
const FREE_FEATURES = [
  `Napi ${FREE_DAILY_PREDICTION_LIMIT} új Tippverseny-tipp`,
  'Pontszerzés és helyezés a ranglistán',
  'Saját statisztikák és tipp-előzmény',
  'Küldetések – a teljesítés rögzül',
  'Értesítések',
  'Coin-gyűjtés és Shop kozmetikumok',
  'Nyilvános játékosprofil',
];

/** A PRO lista csak olyan tételt tartalmaz, ami ma is `requirePro` vagy PRO-kapus. */
const PRO_FEATURES = [
  'Korlátlan Tippverseny-tipp (nincs napi limit)',
  `1v1 Tippcsaták – ${BATTLE_MATCH_COUNT} meccs, PRO ellenfelek`,
  'XP, szintek és achievementek',
  'Küldetések XP-jutalma',
  'Megszolgált profil-kozmetikumok',
  'Teljes elemzés, előzmények és szelvényépítő',
];

export default function Landing() {
  const { configured } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const howRef = useRef<HTMLElement>(null);

  const billing = useAsync(() => api.billingConfig().catch(() => null), []);
  const price = billing.data?.label ?? PRO_PRICE;

  /**
   * Termék-előnézet: a VALÓDI, nyilvános ranglista. Két nyilvános kérés, és csak
   * akkor jelenik meg, ha tényleg van mit mutatni – kitalált sor sosem kerül ide.
   * A hibát elnyeljük: a nyitóoldal ettől soha nem törhet el.
   */
  const preview = useAsync(async () => {
    const comps = await api.competitions();
    const candidates = comps
      .filter((c) => c.status === 'active' || c.status === 'finished')
      .slice(0, PREVIEW_CANDIDATES);
    if (!candidates.length) return null;

    const boards = await Promise.all(candidates.map(async (c) => {
      try { return { name: c.name, rows: await api.competitionLeaderboard(c.id) }; }
      catch { return { name: c.name, rows: [] as LeaderboardRow[] }; }
    }));

    // A legnépesebb ranglista a legbeszédesebb előnézet
    const best = boards.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    return best.rows.length ? { name: best.name, rows: best.rows.slice(0, PREVIEW_ROWS) } : null;
  }, []);

  const scrollToHow = () => howRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  /** A fő CTA: hitelesítés nélküli példányon a dashboardra visz, nem sehova. */
  const startHref = configured ? '/regisztracio' : '/dashboard';
  const startLabel = configured ? 'Kezdés ingyen' : 'Megnyitás';

  return (
    <div className="min-h-screen bg-background text-text">
      {/* ----------------------------- Fejléc ----------------------------- */}
      <header className="sticky top-0 z-20 border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 lg:px-8">
          <Link to="/" aria-label="TippStats – kezdőlap"><Logo /></Link>

          {/* Asztali navigáció */}
          <nav className="hidden items-center gap-1 md:flex" aria-label="Fő navigáció">
            <button type="button" onClick={scrollToHow} className="nav-link">Hogyan működik?</button>
            <a href="#funkciok" className="nav-link">Funkciók</a>
            <a href="#gyik" className="nav-link">GYIK</a>
          </nav>

          <div className="flex items-center gap-2">
            {configured && (
              <Link to="/bejelentkezes" className="btn btn-sm hidden sm:inline-flex">
                <LogIn className="h-3.5 w-3.5" /> Bejelentkezés
              </Link>
            )}
            <Link to={startHref} className="btn btn-sm btn-primary">
              {configured && <UserPlus className="h-3.5 w-3.5" />} {startLabel}
            </Link>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-label={menuOpen ? 'Menü bezárása' : 'Menü megnyitása'}
              className="btn btn-sm md:hidden"
            >
              {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Mobil menü */}
        {menuOpen && (
          <nav className="border-t border-border bg-card px-4 py-2 md:hidden" aria-label="Mobil navigáció">
            <button
              type="button"
              className="nav-link-mobile w-full text-left"
              onClick={() => { setMenuOpen(false); scrollToHow(); }}
            >
              Hogyan működik?
            </button>
            <a href="#funkciok" className="nav-link-mobile" onClick={() => setMenuOpen(false)}>Funkciók</a>
            <a href="#gyik" className="nav-link-mobile" onClick={() => setMenuOpen(false)}>GYIK</a>
            {configured && (
              <Link to="/bejelentkezes" className="nav-link-mobile" onClick={() => setMenuOpen(false)}>Bejelentkezés</Link>
            )}
          </nav>
        )}
      </header>

      {/* ----------------------------- Hero ----------------------------- */}
      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-14 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:px-8 lg:py-20">
        <div>
          <span className="text-xs font-extrabold uppercase tracking-[0.2em] text-primary">TippStats</span>
          <h1 className="mt-3 text-4xl font-black leading-[1.08] tracking-tight md:text-5xl lg:text-6xl">
            Ne csak tippelj.<br /><span className="text-primary">Versenyezz is.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base font-semibold text-text-muted md:text-lg">
            Tippelj meccsekre, szerezz pontokat, küzdj meg másokkal 1v1-ben, és mássz fel a ranglistán.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link to={startHref} className="btn btn-primary btn-lg">
              {configured && <UserPlus className="h-5 w-5" />} {startLabel}
            </Link>
            <button type="button" onClick={scrollToHow} className="btn btn-lg">
              Megnézem, hogyan működik <ChevronDown className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-5 text-sm font-semibold text-text-muted">
            Ingyenesen kezdhető · Bankkártya nélkül · Napi {FREE_DAILY_PREDICTION_LIMIT} tipp a FREE csomagban
          </p>
        </div>

        {/* Termék-előnézet: VALÓDI ranglista, valódi játékosokkal és kinézettel */}
        {preview.data && (
          <div className="card p-5 shadow-lift">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-text-muted">
                <Trophy className="h-3.5 w-3.5 text-secondary" /> Élő ranglista
              </span>
              <span className="badge badge-blue">a TippStatsból</span>
            </div>
            <h2 className="mt-2 truncate text-base font-extrabold">{preview.data.name}</h2>
            <div className="mt-3">
              <LeaderboardList rows={preview.data.rows as LeaderboardRow[]} />
            </div>
            <p className="mt-3 text-xs font-semibold text-text-muted">
              Valódi, nyilvános ranglista – a keretek és címek a játékosok megszerzett kinézetét mutatják.
            </p>
          </div>
        )}
      </section>

      {/* ----------------------------- Mi ez? ----------------------------- */}
      <section className="mx-auto max-w-3xl px-4 pb-6 text-center lg:px-8">
        <h2 className="text-2xl font-black tracking-tight md:text-3xl">Egy hely, ahol a tippjeid számítanak.</h2>
        <p className="mt-4 text-base font-semibold text-text-muted">
          A TippStats segítségével meccsekre tippelhetsz, követheted a teljesítményedet,
          versenyezhetsz más játékosokkal és fejlődhetsz minden jó tipp után.
        </p>
        <p className="mt-3 text-base font-semibold text-text-muted">
          A tippjeid nem tűnnek el egy listában: pontot érnek, helyezést adnak, és ott maradnak
          a statisztikádban – a jók és a rosszak egyaránt.
        </p>
      </section>

      {/* ----------------------------- Funkciók ----------------------------- */}
      <section id="funkciok" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 lg:px-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="card card-lift p-5">
              <span aria-hidden className="icon-bubble bg-primary-soft">{f.emoji}</span>
              <h3 className="mt-3 text-lg font-extrabold tracking-tight">{f.title}</h3>
              <p className="mt-1.5 text-sm font-semibold text-text-muted">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------- Hogyan működik ----------------------------- */}
      <section ref={howRef} id="hogyan-mukodik" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 lg:px-8">
        <h2 className="text-2xl font-black tracking-tight md:text-3xl">Hogyan működik?</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="card card-lift p-5">
              <span className="mono text-3xl font-black text-primary/30">{s.n}</span>
              <h3 className="mt-1 text-lg font-extrabold">{s.title}</h3>
              <p className="mt-1.5 text-sm font-semibold text-text-muted">{s.text}</p>
            </div>
          ))}
        </div>
        <p className="mt-5 text-sm font-semibold text-text-muted">
          A pontozás egyszerű: <strong className="text-text">{POINTS_EXACT} pont</strong> a pontos
          végeredményért, <strong className="text-text">{POINTS_OUTCOME} pont</strong> az eltalált kimenetelért.
        </p>
      </section>

      {/* --------------------- Tervezett árazás (BEMUTATÓ) ---------------------
          FIGYELEM: ez a szekció JAVASOLT árakat mutat, nem élőket. Egyetlen
          gombja sem indít fizetést, és a ténylegesen felszámított összeget nem
          befolyásolja – azt a Stripe ár-azonosítója határozza meg. A ma
          érvényes árat a szekció alján, külön kártyán írjuk ki.           */}
      <section id="csomagok" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 lg:px-8">
        <PlannedPricingHeader title="Több meccs. Több statisztika. Mélyebb AI-elemzés." />
        <div className="mt-6">
          <PlannedPricingCards />
        </div>

        {/* A MA ÉRVÉNYES csomagok – ez a rész valós, nem terv */}
        <h3 className="mt-10 text-lg font-extrabold tracking-tight">Ami ma érvényes</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="card p-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-extrabold">FREE</h3>
              <span className="badge badge-muted">0 Ft</span>
            </div>
            <ul className="mt-4 space-y-2.5 text-sm font-semibold">
              {FREE_FEATURES.map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {t}
                </li>
              ))}
            </ul>
            <Link to={startHref} className="btn mt-5 w-full">{startLabel}</Link>
          </div>

          <div className="card border-primary/40 p-6 shadow-lift">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-lg font-extrabold">
                <Crown className="h-5 w-5 text-secondary" /> PRO – jelenlegi ár
              </h3>
              <span className="text-xl font-black text-primary">{price}</span>
            </div>
            <ul className="mt-4 space-y-2.5 text-sm font-semibold">
              {PRO_FEATURES.map((t) => (
                <li key={t} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {t}
                </li>
              ))}
            </ul>
            <Link to="/pro" className="btn btn-primary mt-5 w-full">PRO részletek <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
      </section>

      {/* ------------------ Ajánlói program (BEMUTATÓ) ------------------
          A program MÉG NEM INDULT EL: nincs ajánlói link, nincs kódgenerálás
          és nincs követés. A tartalom a közös PlannedPricing komponensből jön,
          hogy a PRO oldallal ne csúszhasson szét.                        */}
      <section id="ajanlo" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 lg:px-8">
        <ReferralProgramCard />
      </section>

      {/* ----------------------------- GYIK ----------------------------- */}
      <section id="gyik" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-12 lg:px-8">
        <h2 className="text-2xl font-black tracking-tight md:text-3xl">Gyakori kérdések</h2>
        <div className="mt-6 space-y-2.5">
          <Accordion label="Mi az a TippStats?" defaultOpen>
            <p className="text-sm font-semibold text-text-muted">
              Egy labdarúgás-tippelő platform, ahol a tippjeid pontot érnek. Tippversenyeken
              veszel részt, helyezést szerzel a ranglistán, követed a saját statisztikádat, és
              PRO-ként 1v1 Tippcsatában állhatsz ki más játékosok ellen. Nem fogadóiroda: itt
              nem pénzben játszol.
            </p>
          </Accordion>

          <Accordion label="Ingyenesen használható?">
            <p className="text-sm font-semibold text-text-muted">
              Igen. FREE felhasználóként naponta {FREE_DAILY_PREDICTION_LIMIT} új Tippverseny-tippet
              adhatsz le, a pontjaid ugyanúgy számítanak a ranglistán, és elérhető a saját
              statisztikád, a tipp-előzményed, a küldetések, az értesítések, a coin-gyűjtés és a
              Shop kozmetikumai is. Meglévő tipp módosítása nem fogyasztja a napi keretet.
            </p>
          </Accordion>

          <Accordion label="Mi az 1v1 Tippcsata?" icon={<Swords className="h-4 w-4 text-primary" />}>
            <p className="text-sm font-semibold text-text-muted">
              Kiválasztasz {BATTLE_MATCH_COUNT} mérkőzést és kihívsz egy másik játékost. Mindketten
              tippeltek ugyanarra a {BATTLE_MATCH_COUNT} meccsre, és a párbaj végén a
              {' '}{BATTLE_MATCH_COUNT} meccs összesített eredménye dönti el, ki nyert. A Tippcsata
              PRO funkció: ellenfelet a Tippverseny ranglistáján szereplő PRO játékosok közül
              választhatsz.
            </p>
          </Accordion>

          <Accordion label="Kell PRO a használathoz?">
            <p className="text-sm font-semibold text-text-muted">
              Nem. A Tippverseny, a ranglista, a statisztikáid és a Shop FREE csomaggal is
              elérhető – csak a napi {FREE_DAILY_PREDICTION_LIMIT} új tipp a korlát. PRO-val
              megszűnik ez a limit, és feloldódnak az 1v1 Tippcsaták, az XP és a szintek, az
              achievementek, a küldetések XP-jutalma, a megszolgált profil-kozmetikumok, valamint
              a teljes elemzés, az előzmények és a szelvényépítő.
            </p>
          </Accordion>

          <Accordion label="Kapok garantált nyereményt?">
            <p className="text-sm font-semibold text-text-muted">
              Nem. A TippStats nem garantál nyereséget vagy biztos tippeket. A platform elemzést
              és versenyt ad, a döntés és a felelősség a tiéd.
            </p>
          </Accordion>
        </div>
      </section>

      {/* ----------------------------- Záró CTA ----------------------------- */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-8">
        <div className="card border-primary/30 p-8 text-center shadow-lift md:p-12">
          <h2 className="text-2xl font-black tracking-tight md:text-3xl">Készen állsz az első tippedre?</h2>
          <p className="mx-auto mt-3 max-w-xl text-base font-semibold text-text-muted">
            Regisztrálj ingyen, add le az első tippedet, és kezdd el építeni a helyed a ranglistán.
          </p>
          <Link to={startHref} className="btn btn-primary btn-lg mt-7">
            {configured && <UserPlus className="h-5 w-5" />} {startLabel}
          </Link>
        </div>
      </section>

      {/* ----------------------------- Felelős játék ----------------------------- */}
      <section className="mx-auto max-w-6xl px-4 pb-12 lg:px-8">
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-warning/30 bg-warning-soft p-5 text-sm font-semibold">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div>
            <b>Felelős játék.</b> Egyetlen előrejelzés sem garantált; a megjelenített valószínűségek
            statisztikai becslések, nem ígéretek. A szerencsejáték függőséget okozhat és anyagi
            veszteséggel járhat – soha ne tegyél fel olyan összeget, amelynek elvesztését nem
            engedheted meg magadnak. Csak 18 éven felülieknek. Segítség: Játékosvédelmi vonal
            (ingyenes): 06 80 205 305.
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs font-semibold text-text-muted lg:px-8">
          <span>© {new Date().getFullYear()} TippStats – elemző és kutató eszköz. Nem fogadóiroda, nem ad fogadási tanácsot.</span>
          <div className="flex gap-4">
            <Link to="/tippverseny" className="transition hover:text-primary">Tippverseny</Link>
            <Link to="/meccsek" className="transition hover:text-primary">Meccsek</Link>
            <Link to="/pro" className="transition hover:text-primary">PRO</Link>
            <Link to="/forrasok" className="transition hover:text-primary">Források</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
