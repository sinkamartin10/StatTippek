/**
 * Nyitóoldal – ezt látja először a látogató. Önálló elrendezés (nincs app-navigáció),
 * a cél, hogy azonnal érthető legyen: mit ad a platform, miért ajánl, mennyire megbízható,
 * mi az ingyenes és mi a PRO.
 * Bejelentkezett felhasználót a HomeGate a dashboardra irányítja.
 */
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Clock, Crown, LogIn, Lock, ShieldAlert, UserPlus, X } from 'lucide-react';
import { api } from '../lib/api';
import { todayKey, useAsync } from '../lib/format';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Layout';
import { ConfidenceMeter } from '../components/ui';
import { FREE_DAILY_TIPS } from '../auth/PlanContext';
import { PRO_PRICE } from './Pro';

const PILLARS = [
  { emoji: '📊', title: 'Valódi adat, nem sejtés', text: 'Mérkőzések, eredmények és oddsok nyilvános forrásokból; hírek és hiányzók valós idejű keresésből – minden tétel forrással és linkkel.' },
  { emoji: '🧠', title: 'Átlátható modell', text: 'Várható gól (xG-jellegű) és Poisson-modell. A képletek, a minta mérete és a bizonytalanság minden elemzésnél látszik. Nincs „fekete doboz”.' },
  { emoji: '🧾', title: 'Indoklás, nem ígéret', text: 'Minden tipp mellett ott van, mi szól mellette, mi ellene, mik a kockázatok. A vesztes tippek is bent maradnak az előzményekben.' },
];

const STEPS = [
  { emoji: '1️⃣', title: 'Válassz napot', text: 'A nap mérkőzései a top-ligákból, kupákból és a Nemzetek Ligájából.' },
  { emoji: '2️⃣', title: 'Nézd meg, miért', text: 'Modell-valószínűség, támogató mutatók, odds-összevetés és adatminőség – egy kártyán.' },
  { emoji: '3️⃣', title: 'Döntsd el te', text: 'A platform elemzést ad, nem utasítást. A döntés és a felelősség a tiéd.' },
];

const NOT = ['„Fix tipp”, „biztos szelvény”', 'Garantált nyereség vagy hozam', 'Kitalált statisztika, sérülés vagy odds', 'Tétemelésre buzdítás'];
const YES = ['Valószínűségi becslés mintanagysággal', 'Forrás minden külső információhoz', 'Modell vs. piaci odds összevetés', 'Őszinte előzmények: találati arány, ROI'];

export default function Landing() {
  const { configured } = useAuth();
  const today = useAsync(() => api.matches({ date: todayKey() }).catch(() => []), []);
  const billing = useAsync(() => api.billingConfig().catch(() => null), []);
  const price = billing.data?.label ?? PRO_PRICE;
  const count = today.data?.length ?? null;

  return (
    <div className="min-h-screen bg-background text-text">
      {/* ----------------------------- Fejléc ----------------------------- */}
      <header className="sticky top-0 z-20 border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 lg:px-8">
          <Link to="/" aria-label="TippStats – kezdőlap"><Logo /></Link>
          <nav className="flex items-center gap-2">
            <Link to="/meccsek" className="nav-link hidden sm:inline-flex">Mai meccsek</Link>
            <Link to="/pro" className="nav-link hidden sm:inline-flex"><Crown className="h-4 w-4 text-secondary" /> PRO</Link>
            {configured ? (
              <>
                <Link to="/bejelentkezes" className="btn btn-sm"><LogIn className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Bejelentkezés</span></Link>
                <Link to="/regisztracio" className="btn btn-sm btn-primary"><UserPlus className="h-3.5 w-3.5" /> Regisztráció</Link>
              </>
            ) : (
              <Link to="/dashboard" className="btn btn-sm btn-primary">Belépés <ArrowRight className="h-3.5 w-3.5" /></Link>
            )}
          </nav>
        </div>
      </header>

      {/* ----------------------------- Hero ----------------------------- */}
      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-14 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:px-8 lg:py-20">
        <div>
          <span className="badge badge-blue">⚽ Labdarúgás-elemző platform</span>
          <h1 className="mt-4 text-4xl font-black leading-[1.1] tracking-tight md:text-5xl">
            Nem garantált nyereség.<br />
            Nem „fix tippek”.<br />
            <span className="text-primary">Adatalapú elemzés.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base font-semibold text-text-muted">
            A TippStats valódi mérkőzésadatokból, oddsokból és friss hírekből épít átlátható statisztikai modellt, és minden becslés mellé odateszi az indoklást, a mintát és a forrást. Kutatóeszköz – a döntés a tiéd.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            {configured ? (
              <Link to="/regisztracio" className="btn btn-primary btn-lg"><UserPlus className="h-5 w-5" /> Ingyenes kezdés</Link>
            ) : (
              <Link to="/dashboard" className="btn btn-primary btn-lg">Megnyitás <ArrowRight className="h-5 w-5" /></Link>
            )}
            <Link to="/meccsek" className="btn btn-lg">Mai meccsek</Link>
          </div>
          <dl className="mt-9 grid max-w-lg grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [count == null ? '…' : String(count), 'mérkőzés ma'],
              ['17', 'sorozat'],
              ['2', 'modell'],
              ['100%', 'forrásolt infó'],
            ].map(([v, l]) => (
              <div key={l} className="rounded-2xl border border-border bg-card p-3 shadow-soft">
                <dt className="mono text-2xl font-extrabold text-primary">{v}</dt>
                <dd className="text-xs font-bold text-text-muted">{l}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Példa tipp-kártya (illusztráció) */}
        <div className="relative">
          <div className="card p-5 shadow-lift">
            <div className="flex items-center justify-between text-xs font-bold text-text-muted">
              <span>Példa bajnokság</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1"><Clock className="h-3.5 w-3.5" /> 20:00</span>
            </div>
            <div className="mt-3">
              <div className="text-lg font-extrabold">Csapat A</div>
              <div className="my-0.5 text-[11px] font-extrabold uppercase tracking-widest text-text-muted">vs</div>
              <div className="text-lg font-extrabold">Csapat B</div>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="col-span-2 rounded-xl border border-primary/20 bg-primary-soft p-3">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-primary-strong">🎯 Tipp</div>
                <div className="mt-0.5 text-base font-extrabold">Over 2.5</div>
              </div>
              <div className="rounded-xl border border-border bg-card-2 p-3 text-center">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">💰 Odds</div>
                <div className="mono mt-0.5 text-xl font-extrabold">1,72</div>
              </div>
            </div>
            <div className="mt-4"><ConfidenceMeter value={0.78} /></div>
            <div className="mt-4 rounded-xl border border-border bg-card-2 px-4 py-3 text-sm font-bold text-text-muted">Miért ezt választotta? ↓</div>
            <p className="mt-3 text-[11px] font-bold uppercase tracking-wide text-text-muted">Illusztráció – nem valós mérkőzés és nem valós odds</p>
          </div>
        </div>
      </section>

      {/* ----------------------------- Pillérek ----------------------------- */}
      <section className="mx-auto max-w-6xl px-4 pb-4 lg:px-8">
        <div className="grid gap-4 md:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.title} className="card card-lift p-5">
              <span aria-hidden className="icon-bubble bg-primary-soft">{p.emoji}</span>
              <h3 className="mt-3 text-lg font-extrabold tracking-tight">{p.title}</h3>
              <p className="mt-1.5 text-sm font-semibold text-text-muted">{p.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------- Hogyan működik ----------------------------- */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-8">
        <h2 className="text-2xl font-black tracking-tight">Hogyan működik?</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.title} className="rounded-[var(--radius-card)] border border-border bg-card p-5 shadow-soft">
              <span aria-hidden className="text-2xl">{s.emoji}</span>
              <h3 className="mt-2 text-base font-extrabold">{s.title}</h3>
              <p className="mt-1 text-sm font-semibold text-text-muted">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------- Mit igen / mit nem ----------------------------- */}
      <section className="mx-auto max-w-6xl px-4 pb-4 lg:px-8">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="card p-5">
            <h3 className="flex items-center gap-2 text-lg font-extrabold"><X className="h-5 w-5 text-danger" /> Amit NEM kapsz</h3>
            <ul className="mt-3 space-y-2">{NOT.map((t) => <li key={t} className="flex items-start gap-2 text-sm font-semibold"><X className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> {t}</li>)}</ul>
          </div>
          <div className="card p-5">
            <h3 className="flex items-center gap-2 text-lg font-extrabold"><Check className="h-5 w-5 text-success" /> Amit kapsz</h3>
            <ul className="mt-3 space-y-2">{YES.map((t) => <li key={t} className="flex items-start gap-2 text-sm font-semibold"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {t}</li>)}</ul>
          </div>
        </div>
      </section>

      {/* ----------------------------- FREE és PRO ----------------------------- */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-8">
        <h2 className="text-2xl font-black tracking-tight">Mi az ingyenes, és mi a PRO?</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="card p-5">
            <div className="flex items-center justify-between"><h3 className="text-lg font-extrabold">FREE</h3><span className="badge badge-muted">0 Ft</span></div>
            <ul className="mt-3 space-y-2 text-sm font-semibold">
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Napi {FREE_DAILY_TIPS} tipp</li>
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> A nap első néhány mérkőzésének elemzése</li>
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Liga-átlagok, hírek, források</li>
              <li className="flex items-start gap-2 text-text-muted"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> Indoklás, előzmények, szelvényépítő: zárva</li>
            </ul>
          </div>
          <div className="card border-primary/40 p-5 shadow-lift">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-lg font-extrabold"><Crown className="h-5 w-5 text-secondary" /> PRO</h3>
              <span className="text-xl font-black text-primary">{price}</span>
            </div>
            <ul className="mt-3 space-y-2 text-sm font-semibold">
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Minden mérkőzés, minden piac</li>
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> A modell teljes indoklása és kockázatai</li>
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Előzmények: találati arány, kalibráció, ROI</li>
              <li className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> Szelvényépítő valódi oddsokkal</li>
            </ul>
            <Link to="/pro" className="btn btn-primary mt-4 w-full">PRO részletek <ArrowRight className="h-4 w-4" /></Link>
          </div>
        </div>
      </section>

      {/* ----------------------------- Felelős játék ----------------------------- */}
      <section className="mx-auto max-w-6xl px-4 pb-12 lg:px-8">
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-warning/30 bg-warning-soft p-5 text-sm font-semibold">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div>
            <b>Felelős játék.</b> Egyetlen előrejelzés sem garantált; a megjelenített valószínűségek statisztikai becslések, nem ígéretek. A szerencsejáték függőséget okozhat és anyagi veszteséggel járhat – soha ne tegyél fel olyan összeget, amelynek elvesztését nem engedheted meg magadnak. Csak 18 éven felülieknek. Segítség: Játékosvédelmi vonal (ingyenes): 06 80 205 305.
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs font-semibold text-text-muted lg:px-8">
          <span>© {new Date().getFullYear()} TippStats – elemző és kutató eszköz. Nem fogadóiroda, nem ad fogadási tanácsot.</span>
          <div className="flex gap-4">
            <Link to="/meccsek" className="transition hover:text-primary">Mai meccsek</Link>
            <Link to="/pro" className="transition hover:text-primary">PRO</Link>
            <Link to="/forrasok" className="transition hover:text-primary">Források</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
