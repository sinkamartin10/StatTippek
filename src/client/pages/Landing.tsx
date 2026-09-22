/**
 * Nyitóoldal (landing) – ezt látja először a látogató. Önálló, oldalsáv nélküli elrendezés a meglévő dizájn-tokenekkel.
 * Bejelentkezett felhasználót a HomeGate a dashboardra irányítja.
 */
import { Link } from 'react-router-dom';
import {
  ArrowRight, BarChart3, BookOpen, CheckCircle2, Crown, Database, LogIn, Newspaper, ShieldAlert, Sigma, Ticket, UserPlus, XCircle,
} from 'lucide-react';
import { api } from '../lib/api';
import { todayKey, useAsync } from '../lib/format';
import { useAuth } from '../auth/AuthContext';
import { PRO_PRICE } from './Pro';

const PILLARS = [
  { icon: Database, title: 'Valódi adatok', text: 'Mérkőzések, eredmények és oddsok nyilvános forrásokból; hírek és hiányzók valós idejű keresésből – minden tétel forrással és linkkel.' },
  { icon: Sigma, title: 'Átlátható modell', text: 'Várható gól (xG-jellegű) és Poisson-modell: a képletek és a minta mérete minden elemzésnél látszanak. Nincs „fekete doboz”.' },
  { icon: BookOpen, title: 'Indoklás, nem ígéret', text: 'Minden tipp mellett a mellette és ellene szóló mutatók, a kockázatok és az adatminőség. A vesztes tippek is bent maradnak az előzményekben.' },
];

const STEPS = [
  ['1', 'Válassz mérkőzést', 'A nap meccsei a top-ligákból, kupákból és a Nemzetek Ligájából.'],
  ['2', 'Nézd meg az elemzést', 'Forma, hazai/idegen bontás, egymás elleni, hírek, külső tippek és a modell becslése.'],
  ['3', 'Döntsd el te', 'A modell valószínűséget és odds-összevetést ad – a döntés és a felelősség a tiéd.'],
];

const NOT = ['„Fix tipp”, „biztos szelvény”', 'Garantált nyereség vagy hozam', 'Kitalált statisztika, sérülés vagy odds', 'Tétemelésre buzdítás'];
const YES = ['Valószínűségi becslés, mintanagysággal', 'Forrás minden külső információhoz', 'Modell vs. piaci odds összevetés', 'Őszinte előzmények: találati arány, ROI'];

export default function Landing() {
  const { configured } = useAuth();
  const today = useAsync(() => api.matches({ date: todayKey() }).catch(() => []), []);
  const billing = useAsync(() => api.billingConfig().catch(() => null), []);
  const price = billing.data?.label ?? PRO_PRICE;
  const count = today.data?.length ?? null;

  return (
    <div className="min-h-screen bg-bg text-text">
      {/* Fejléc */}
      <header className="sticky top-0 z-20 border-b border-border bg-bg/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 lg:px-8">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-black text-black">T</span>
            <span className="text-base font-extrabold tracking-tight">TIPPMIX <span className="text-accent">AI</span></span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link to="/meccsek" className="btn btn-sm hidden sm:inline-flex">Mai meccsek</Link>
            <Link to="/pro" className="btn btn-sm hidden sm:inline-flex"><Crown className="h-3.5 w-3.5 text-accent" /> PRO</Link>
            {configured ? (
              <>
                <Link to="/bejelentkezes" className="btn btn-sm"><LogIn className="h-3.5 w-3.5" /> Bejelentkezés</Link>
                <Link to="/regisztracio" className="btn btn-sm btn-primary"><UserPlus className="h-3.5 w-3.5" /> Regisztráció</Link>
              </>
            ) : (
              <Link to="/dashboard" className="btn btn-sm btn-primary">Belépés az alkalmazásba <ArrowRight className="h-3.5 w-3.5" /></Link>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,197,94,0.14),transparent_60%)]" />
        <div className="mx-auto max-w-6xl px-4 py-16 lg:px-8 lg:py-24">
          <span className="badge badge-green">Labdarúgás-elemző platform</span>
          <h1 className="mt-4 max-w-3xl text-4xl font-black leading-tight tracking-tight md:text-6xl">
            Nem garantált nyereség.<br />
            Nem „fix tippek”.<br />
            <span className="text-accent">Adatalapú elemzés.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted">
            A TIPPMIX AI valódi mérkőzésadatokból, oddsokból és friss hírekből épít átlátható statisztikai modellt, és minden becslés mellé odateszi az indoklást, a mintát és a forrást. Kutatóeszköz – a döntés a tiéd.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {configured ? (
              <Link to="/regisztracio" className="btn btn-primary px-6 py-3 text-base"><UserPlus className="h-5 w-5" /> Ingyenes regisztráció</Link>
            ) : (
              <Link to="/dashboard" className="btn btn-primary px-6 py-3 text-base">Megnyitás <ArrowRight className="h-5 w-5" /></Link>
            )}
            <Link to="/meccsek" className="btn px-6 py-3 text-base">Mai meccsek megtekintése</Link>
          </div>
          <div className="mt-10 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat value={count == null ? '…' : String(count)} label="mérkőzés ma" />
            <Stat value="17" label="sorozat (ligák, kupák, NL)" />
            <Stat value="2" label="modell (xG + Poisson)" />
            <Stat value="100%" label="forrással jelölt információ" />
          </div>
        </div>
      </section>

      {/* Pillérek */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-8">
        <div className="grid gap-4 md:grid-cols-3">
          {PILLARS.map((p) => (
            <div key={p.title} className="card p-5">
              <p.icon className="h-6 w-6 text-accent" />
              <h3 className="mt-3 text-lg font-bold">{p.title}</h3>
              <p className="mt-2 text-sm text-muted">{p.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Mit igen / mit nem */}
      <section className="mx-auto max-w-6xl px-4 py-8 lg:px-8">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="card p-5">
            <h3 className="flex items-center gap-2 text-lg font-bold"><XCircle className="h-5 w-5 text-danger" /> Amit NEM kapsz</h3>
            <ul className="mt-3 space-y-2 text-sm">{NOT.map((t) => <li key={t} className="flex items-start gap-2"><XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> {t}</li>)}</ul>
          </div>
          <div className="card p-5">
            <h3 className="flex items-center gap-2 text-lg font-bold"><CheckCircle2 className="h-5 w-5 text-accent" /> Amit kapsz</h3>
            <ul className="mt-3 space-y-2 text-sm">{YES.map((t) => <li key={t} className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> {t}</li>)}</ul>
          </div>
        </div>
      </section>

      {/* Hogyan működik */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">Hogyan működik?</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map(([n, t, d]) => (
            <div key={n} className="rounded-xl border border-border bg-card-2/60 p-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 font-black text-accent">{n}</div>
              <h3 className="mt-3 font-bold">{t}</h3>
              <p className="mt-1 text-sm text-muted">{d}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 grid gap-3 text-sm text-muted sm:grid-cols-3">
          <div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-accent" /> Forma, gólpiacok, tabella, egymás elleni</div>
          <div className="flex items-center gap-2"><Newspaper className="h-4 w-4 text-accent" /> Hírek, hiányzók, külső tippek – forrással</div>
          <div className="flex items-center gap-2"><Ticket className="h-4 w-4 text-accent" /> Szelvényépítő valódi oddsokkal (PRO)</div>
        </div>
      </section>

      {/* PRO */}
      <section className="mx-auto max-w-6xl px-4 py-12 lg:px-8">
        <div className="card overflow-hidden">
          <div className="grid gap-6 bg-gradient-to-r from-accent/15 via-transparent to-warn/10 p-6 md:grid-cols-[1fr_auto] md:items-center md:p-8">
            <div>
              <div className="flex items-center gap-2"><Crown className="h-6 w-6 text-accent" /><h2 className="text-2xl font-extrabold tracking-tight">FREE és PRO</h2></div>
              <p className="mt-2 max-w-2xl text-sm text-muted">Ingyen: mai meccsek, gyors áttekintés, napi néhány tipp, hírek és források. PRO-val: teljes tipplisták, részletes statisztikák, a modell indoklásai, történelmi eredmények és a szelvényépítő.</p>
            </div>
            <div className="text-left md:text-right">
              <div className="text-3xl font-black text-accent">{price}</div>
              <Link to="/pro" className="btn btn-primary mt-3">PRO részletek <ArrowRight className="h-4 w-4" /></Link>
            </div>
          </div>
        </div>
      </section>

      {/* Felelős játék */}
      <section className="mx-auto max-w-6xl px-4 py-8 lg:px-8">
        <div className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          <div>
            <b>Felelős játék.</b> Egyetlen előrejelzés sem garantált; a megjelenített valószínűségek statisztikai becslések, nem ígéretek. A szerencsejáték függőséget okozhat és anyagi veszteséggel járhat – soha ne tegyél fel olyan összeget, amelynek elvesztését nem engedheted meg magadnak. Csak 18 éven felülieknek. Segítség: Játékosvédelmi vonal (ingyenes): 06 80 205 305.
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted lg:px-8">
          <span>© {new Date().getFullYear()} TIPPMIX AI – elemző és kutató eszköz. Nem fogadóiroda, nem ad fogadási tanácsot.</span>
          <div className="flex gap-4">
            <Link to="/meccsek" className="hover:text-accent">Mai meccsek</Link>
            <Link to="/pro" className="hover:text-accent">PRO</Link>
            <Link to="/forrasok" className="hover:text-accent">Források</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/70 p-3">
      <div className="mono text-2xl font-bold text-accent">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
