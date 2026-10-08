/** Alkalmazás-keret: felső navigációs sáv (mobilon hamburger), adatmód-szalag, tartalom. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, BookOpen, CalendarDays, ChartLine, ChevronDown, Crown, History, LayoutDashboard, Lightbulb, LogIn, Menu, Trophy,
  Bell, Search, Settings, ShoppingBag, Sparkles, Swords, Ticket, UserCircle2, UserPlus, UserSearch, Users, X,
  type LucideIcon,
} from 'lucide-react';
import type { AppStatus } from '@shared/types';
import { api } from '../lib/api';
import { OriginBadge } from './ui';
import { useAuth } from '../auth/AuthContext';
import { usePlan } from '../auth/PlanContext';
import { PlanBadge } from '../auth/ProfileCard';
import { NotificationBell } from './NotificationBell';
import { CoinBalancePill, CoinsProvider } from './CoinsProvider';

/**
 * Navigáció – CSOPORTOSÍTVA, hogy a sáv ne legyen zsúfolt.
 *
 * Három elsődleges célpont marad kint; minden más két témacsoportba kerül.
 * EGYETLEN útvonal sem veszett el: ami korábban a sávban volt, az itt a
 * megfelelő csoportban szerepel, és mobilon továbbra is mind látszik.
 */
const PRIMARY = [
  { to: '/tippek', label: 'Tippek', icon: Lightbulb },
  { to: '/tippverseny', label: 'Tippverseny', icon: Trophy },
  { to: '/shop', label: 'Shop', icon: ShoppingBag },
];

/** „Játék” – amit a felhasználó SAJÁT magáról és a játékmenetről néz. */
const PLAY = [
  { to: '/dashboard', label: 'Áttekintés', icon: LayoutDashboard },
  { to: '/battles', label: '1v1 Battle', icon: Swords },
  { to: '/statisztikaim', label: 'Statisztikáim', icon: ChartLine },
  { to: '/elozmenyek', label: 'Előzmények', icon: History },
  { to: '/szelvenyek', label: 'Szelvény', icon: Ticket },
  { to: '/kovetes', label: 'Követés', icon: Users },
];

/** „Felfedezés” – adat, elemzés, beállítások. */
const EXPLORE = [
  { to: '/felfedezes', label: 'Játékosok', icon: UserSearch },
  { to: '/meccsek', label: 'Mai meccsek', icon: CalendarDays },
  { to: '/elemzes', label: 'Elemzés', icon: Sparkles },
  { to: '/statisztikak', label: 'Statisztikák', icon: BarChart3 },
  { to: '/forrasok', label: 'Források', icon: BookOpen },
  { to: '/beallitasok', label: 'Beállítások', icon: Settings },
];

/** A mobil fiók teljes listája – minden útvonal egy helyen. */
const MOBILE_GROUPS: { label: string; items: typeof PRIMARY }[] = [
  { label: 'Fő', items: PRIMARY },
  { label: 'Játék', items: PLAY },
  { label: 'Felfedezés', items: EXPLORE },
];

/**
 * Csoportosító legördülő a navigációban. Billentyűzetről is használható:
 * a gomb `aria-expanded`/`aria-haspopup` jelzésű, a menü Escape-re zár, és a
 * fókusz a gombon marad.
 */
function NavMenu({
  label, items, openKey, current, onToggle,
}: {
  label: string;
  items: { to: string; label: string; icon: LucideIcon }[];
  openKey: string;
  current: string | null;
  onToggle: (key: string | null) => void;
}) {
  const open = current === openKey;
  const active = items.some((i) => location.pathname.startsWith(i.to));
  return (
    <div className="relative">
      <button
        type="button"
        className={`nav-link ${active ? 'active' : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onToggle(open ? null : openKey)}
      >
        {label}
        <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div role="menu" aria-label={label} className="nav-menu">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} role="menuitem" className={({ isActive }) => `nav-menu-item ${isActive ? 'active' : ''}`}>
              <n.icon className="h-4 w-4 shrink-0" aria-hidden /> {n.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-lg font-black text-white shadow-[0_2px_0_var(--color-primary-strong)]">⚽</span>
      <span className="text-lg font-black tracking-tight">Tipp<span className="text-primary">Stats</span></span>
    </span>
  );
}

export default function Layout() {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [q, setQ] = useState('');
  const navRef = useRef<HTMLElement>(null);
  const nav = useNavigate();
  const loc = useLocation();
  const auth = useAuth();
  const { pro } = usePlan();

  // Jelszó-visszaállító linkről érkezve az új jelszó oldalra visszük
  useEffect(() => { if (auth.passwordRecovery && loc.pathname !== '/uj-jelszo') nav('/uj-jelszo', { replace: true }); }, [auth.passwordRecovery, loc.pathname, nav]);

  useEffect(() => { api.status().then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(() => { setOpen(false); setMenu(null); }, [loc.pathname]);
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]);

  // Legördülő zárása kívülre kattintásra / Escape-re
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (navRef.current && !navRef.current.contains(e.target as Node)) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length >= 2) { nav(`/kereses?q=${encodeURIComponent(q.trim())}`); setOpen(false); }
  };

  const logout = () => auth.signOut().then(() => { setOpen(false); nav('/bejelentkezes'); });

  return (
    // A coin-egyenleg a fejlécben ÉS a Shop oldalon ugyanazt a szerverállapotot látja
    <CoinsProvider>
    <div className="flex min-h-screen flex-col bg-background">
      {/* ----------------------------- Felső sáv ----------------------------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 lg:px-8">
          <NavLink to="/" className="shrink-0" aria-label="TippStats – kezdőlap"><Logo /></NavLink>

          {/* Desktop menü */}
          {/* Elsődleges célpontok + két csoportosított legördülő.
              Így lg-től is kényelmesen elfér, levegősebben. */}
          <nav ref={navRef} className="ml-3 hidden items-center gap-1 lg:flex" aria-label="Fő navigáció">
            {PRIMARY.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                <n.icon className="h-4 w-4" aria-hidden /> {n.label}
              </NavLink>
            ))}
            <span className="mx-1.5 h-5 w-px bg-border" aria-hidden />
            <NavMenu label="Játék" items={PLAY} openKey="play" current={menu} onToggle={setMenu} />
            <NavMenu label="Felfedezés" items={EXPLORE} openKey="explore" current={menu} onToggle={setMenu} />
          </nav>

          <div className="flex-1" />

          {/* Keresés – desktopon mindig látszik */}
          <form onSubmit={submit} className="relative hidden w-52 xl:block">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input className="input !py-2 pl-10" placeholder="Keresés…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Globális keresés" />
          </form>

          {/* PRO – kiemelt, de nem a menüsorban foglal helyet */}
          <NavLink to="/pro" className="btn btn-sm hidden lg:inline-flex" aria-label="PRO előfizetés">
            <Crown className="h-3.5 w-3.5" aria-hidden /> PRO
          </NavLink>

          {/* Coin egyenleg – az érték MINDIG a szerverről jön (nincs kliens-authority) */}
          {(auth.user || !auth.configured) && <CoinBalancePill />}

          {/* Értesítések – egyetlen GET szolgálja ki a jelvényt és a legördülőt */}
          {auth.user && <NotificationBell />}

          {/* Fiók */}
          {!auth.loading && (
            auth.user ? (
              <NavLink to="/profil" className="hidden items-center gap-2 lg:inline-flex">
                {({ isActive }) => (
                  <span className={`nav-link ${isActive ? 'active' : ''}`}>
                    <UserCircle2 className="h-4 w-4" /> Profil <PlanBadge pro={pro} />
                  </span>
                )}
              </NavLink>
            ) : (
              <div className="hidden items-center gap-2 lg:flex">
                {/* 1024–1280 között egyetlen kompakt gomb: a két teljes gomb
                    ebben a sávban túlcsordulást okozna. A regisztráció a
                    bejelentkező oldalról és a mobil menüből is elérhető. */}
                <NavLink to="/bejelentkezes" className="btn btn-sm btn-primary xl:hidden">
                  <LogIn className="h-3.5 w-3.5" aria-hidden /> Belépés
                </NavLink>
                <NavLink to="/bejelentkezes" className="btn btn-sm hidden xl:inline-flex">
                  <LogIn className="h-3.5 w-3.5" aria-hidden /> Bejelentkezés
                </NavLink>
                <NavLink to="/regisztracio" className="btn btn-sm btn-primary hidden xl:inline-flex">
                  <UserPlus className="h-3.5 w-3.5" aria-hidden /> Regisztráció
                </NavLink>
              </div>
            )
          )}

          {/* Hamburger – mobilon */}
          <button className="btn btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label="Menü megnyitása" aria-expanded={open}>
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* ----------------------------- Mobil fiók ----------------------------- */}
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-[#1d2539]/40 lg:hidden" onClick={() => setOpen(false)} />
          <div className="fixed inset-y-0 right-0 z-50 flex w-[85%] max-w-sm flex-col overflow-y-auto border-l border-border bg-card lg:hidden">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
              <Logo />
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} aria-label="Menü bezárása"><X className="h-5 w-5" /></button>
            </div>
            <form onSubmit={submit} className="relative px-4 pt-4">
              <Search className="pointer-events-none absolute left-7 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input className="input pl-10" placeholder="Keresés: csapat, meccs, bajnokság…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Globális keresés" />
            </form>
            <nav className="space-y-4 p-4" aria-label="Mobil navigáció">
              {MOBILE_GROUPS.map((group) => (
                <div key={group.label} className="space-y-1">
                  <p className="px-2 text-[11px] font-extrabold uppercase tracking-wide text-text-muted">{group.label}</p>
                  {group.items.map((n) => (
                    <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link-mobile ${isActive ? 'active' : ''}`}>
                      <n.icon className="h-5 w-5" aria-hidden /> {n.label}
                    </NavLink>
                  ))}
                </div>
              ))}
              <div className="space-y-1">
                <NavLink to="/pro" className={({ isActive }) => `nav-link-mobile ${isActive ? 'active' : ''}`}>
                  <Crown className="h-5 w-5" aria-hidden /> PRO
                </NavLink>
              </div>
            </nav>
            <div className="mt-auto space-y-3 border-t border-border p-4">
              {!auth.loading && (auth.user ? (
                <>
                  <NavLink to="/profil" className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card-2 p-3">
                    <span className="min-w-0">
                      <span className="block text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Fiók</span>
                      <span className="block truncate text-sm font-bold">{auth.user.email}</span>
                    </span>
                    <PlanBadge pro={pro} />
                  </NavLink>
                  <button className="btn w-full" onClick={logout}>Kijelentkezés</button>
                </>
              ) : (
                <>
                  <NavLink to="/bejelentkezes" className="btn w-full"><LogIn className="h-4 w-4" /> Bejelentkezés</NavLink>
                  <NavLink to="/regisztracio" className="btn btn-primary w-full"><UserPlus className="h-4 w-4" /> Regisztráció</NavLink>
                </>
              ))}
              {status && <div className="flex items-center justify-center"><OriginBadge origin={status.dataMode} small /></div>}
            </div>
          </div>
        </>
      )}

      {/* ----------------------------- Szalagok ----------------------------- */}
      {status?.dataMode === 'demo' && (
        <div className="border-b border-warning/30 bg-warning-soft px-4 py-2.5 text-xs font-semibold text-[#a96b00] lg:px-8">
          <div className="mx-auto max-w-7xl">
            <strong>DEMO ADAT MÓD.</strong> Minden mérkőzés, statisztika, hír és külső tipp beépített, szemléltető adat – nem valós esemény. Élő adathoz állítsd be az API kulcsokat (.env), lásd Beállítások.
          </div>
        </div>
      )}
      {status?.warnings.filter((w) => !w.startsWith('DEMO')).map((w) => (
        <div key={w} className="border-b border-primary/20 bg-primary-soft px-4 py-2.5 text-xs font-semibold text-primary-strong lg:px-8">
          <div className="mx-auto max-w-7xl">{w}</div>
        </div>
      ))}

      {/* ----------------------------- Tartalom ----------------------------- */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs font-semibold text-text-muted lg:px-8">
          <span>© {new Date().getFullYear()} TippStats – elemző és kutató eszköz. Nem fogadóiroda, nem ad fogadási tanácsot.</span>
          <span className="flex items-center gap-3">
            {status && <OriginBadge origin={status.dataMode} small />}
            <NavLink to="/forrasok" className="transition hover:text-primary">Források</NavLink>
            <NavLink to="/pro" className="transition hover:text-primary">PRO</NavLink>
          </span>
        </div>
      </footer>
    </div>
    </CoinsProvider>
  );
}
