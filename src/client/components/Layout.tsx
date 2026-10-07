/** Alkalmazás-keret: felső navigációs sáv (mobilon hamburger), adatmód-szalag, tartalom. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, BookOpen, CalendarDays, ChartLine, ChevronDown, Crown, History, LayoutDashboard, Lightbulb, LogIn, Menu, Trophy,
  Search, Settings, Sparkles, Swords, Ticket, UserCircle2, UserPlus, X,
} from 'lucide-react';
import type { AppStatus } from '@shared/types';
import { api } from '../lib/api';
import { OriginBadge } from './ui';
import { useAuth } from '../auth/AuthContext';
import { usePlan } from '../auth/PlanContext';
import { PlanBadge } from '../auth/ProfileCard';

/** Elsődleges menü – mindig látszik (desktopon vízszintesen, mobilon a fiókban). */
const MAIN = [
  { to: '/tippek', label: 'Tippek', icon: Lightbulb },
  { to: '/elozmenyek', label: 'Előzmények', icon: History },
  { to: '/szelvenyek', label: 'Szelvény', icon: Ticket },
  { to: '/tippverseny', label: 'Tippverseny', icon: Trophy },
  { to: '/battles', label: '1v1 Battle', icon: Swords },
  { to: '/pro', label: 'PRO', icon: Crown },
];

/** Másodlagos menü – desktopon a „Továbbiak” legördülőben, mobilon a listában. */
const MORE = [
  { to: '/dashboard', label: 'Áttekintés', icon: LayoutDashboard },
  { to: '/statisztikaim', label: 'Statisztikáim', icon: ChartLine },
  { to: '/meccsek', label: 'Mai meccsek', icon: CalendarDays },
  { to: '/elemzes', label: 'Elemzés', icon: Sparkles },
  { to: '/statisztikak', label: 'Statisztikák', icon: BarChart3 },
  { to: '/forrasok', label: 'Források', icon: BookOpen },
  { to: '/beallitasok', label: 'Beállítások', icon: Settings },
];

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
  const [more, setMore] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [q, setQ] = useState('');
  const moreRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const loc = useLocation();
  const [pendingBattles, setPendingBattles] = useState(0);
  const auth = useAuth();
  const { pro } = usePlan();

  // Jelszó-visszaállító linkről érkezve az új jelszó oldalra visszük
  useEffect(() => { if (auth.passwordRecovery && loc.pathname !== '/uj-jelszo') nav('/uj-jelszo', { replace: true }); }, [auth.passwordRecovery, loc.pathname, nav]);

  useEffect(() => { api.status().then(setStatus).catch(() => setStatus(null)); }, []);
  // Nyitott 1v1 kihívások száma a menü jelvényéhez. Nincs külön értesítési
  // rendszer: a /battles végpontot kérdezzük meg egyszer, bejelentkezés esetén.
  useEffect(() => {
    if (!auth.user) { setPendingBattles(0); return; }
    api.battles().then((b) => setPendingBattles(b.pendingIncoming)).catch(() => setPendingBattles(0));
  }, [auth.user, loc.pathname === '/battles']);
  useEffect(() => { setOpen(false); setMore(false); }, [loc.pathname]);
  useEffect(() => { document.body.style.overflow = open ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [open]);

  // „Továbbiak” legördülő zárása kívülre kattintásra / Escape-re
  useEffect(() => {
    if (!more) return;
    const onDown = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMore(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [more]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length >= 2) { nav(`/kereses?q=${encodeURIComponent(q.trim())}`); setOpen(false); }
  };

  const logout = () => auth.signOut().then(() => { setOpen(false); nav('/bejelentkezes'); });

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ----------------------------- Felső sáv ----------------------------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 lg:px-8">
          <NavLink to="/" className="shrink-0" aria-label="TippStats – kezdőlap"><Logo /></NavLink>

          {/* Desktop menü */}
          <nav className="ml-2 hidden items-center gap-1 lg:flex">
            {MAIN.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                <n.icon className="h-4 w-4" /> {n.label}
                {n.to === '/battles' && pendingBattles > 0 && (
                  <span className="badge badge-blue ml-1" aria-label={`${pendingBattles} nyitott kihívás`}>{pendingBattles}</span>
                )}
              </NavLink>
            ))}
            <div className="relative" ref={moreRef}>
              <button type="button" className="nav-link" aria-expanded={more} aria-haspopup="menu" onClick={() => setMore(!more)}>
                Továbbiak <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${more ? 'rotate-180' : ''}`} />
              </button>
              {more && (
                <div role="menu" className="absolute left-0 top-full mt-2 w-56 overflow-hidden rounded-2xl border border-border bg-card p-2 shadow-lift">
                  {MORE.map((n) => (
                    <NavLink key={n.to} to={n.to} role="menuitem" className={({ isActive }) => `nav-link w-full !justify-start !rounded-xl ${isActive ? 'active' : ''}`}>
                      <n.icon className="h-4 w-4" /> {n.label}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          </nav>

          <div className="flex-1" />

          {/* Keresés – desktopon mindig látszik */}
          <form onSubmit={submit} className="relative hidden w-56 xl:block">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input className="input !py-2 pl-10" placeholder="Keresés…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Globális keresés" />
          </form>

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
                <NavLink to="/bejelentkezes" className="btn btn-sm"><LogIn className="h-3.5 w-3.5" /> Bejelentkezés</NavLink>
                <NavLink to="/regisztracio" className="btn btn-sm btn-primary"><UserPlus className="h-3.5 w-3.5" /> Regisztráció</NavLink>
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
            <nav className="space-y-1 p-4">
              {MAIN.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link-mobile ${isActive ? 'active' : ''}`}>
                  <n.icon className="h-5 w-5" /> {n.label}
                  {n.to === '/battles' && pendingBattles > 0 && (
                    <span className="badge badge-blue ml-auto">{pendingBattles}</span>
                  )}
                </NavLink>
              ))}
              <div className="my-2 border-t border-border" />
              {MORE.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-link-mobile ${isActive ? 'active' : ''}`}>
                  <n.icon className="h-5 w-5" /> {n.label}
                </NavLink>
              ))}
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
  );
}
