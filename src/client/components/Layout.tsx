/** Alkalmazás-keret: oldalsáv navigáció, felső sáv globális kereséssel, adatmód-szalag. */
import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BarChart3, BookOpen, CalendarDays, Crown, History, LayoutDashboard, Lightbulb, LogIn, LogOut, Menu, Search, Settings, Sparkles, Ticket, UserPlus, X,
} from 'lucide-react';
import type { AppStatus } from '@shared/types';
import { api } from '../lib/api';
import { OriginBadge } from './ui';
import { useAuth } from '../auth/AuthContext';
import { usePlan } from '../auth/PlanContext';
import { PlanBadge } from '../auth/ProfileCard';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/meccsek', label: 'Mai meccsek', icon: CalendarDays },
  { to: '/elemzes', label: 'Elemzés', icon: Sparkles },
  { to: '/tippek', label: 'Tippek', icon: Lightbulb },
  { to: '/szelvenyek', label: 'Szelvények', icon: Ticket },
  { to: '/pro', label: 'PRO', icon: Crown },
  { to: '/statisztikak', label: 'Statisztikák', icon: BarChart3 },
  { to: '/elozmenyek', label: 'Előzmények', icon: History },
  { to: '/forrasok', label: 'Források', icon: BookOpen },
  { to: '/beallitasok', label: 'Beállítások', icon: Settings },
];

export default function Layout() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const loc = useLocation();
  const auth = useAuth();
  const { pro } = usePlan();

  // Jelszó-visszaállító linkről érkezve az új jelszó oldalra visszük
  useEffect(() => { if (auth.passwordRecovery && loc.pathname !== '/uj-jelszo') nav('/uj-jelszo', { replace: true }); }, [auth.passwordRecovery, loc.pathname, nav]);

  useEffect(() => { api.status().then(setStatus).catch(() => setStatus(null)); }, []);
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length >= 2) nav(`/kereses?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="flex min-h-screen">
      {/* Oldalsáv */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-64 shrink-0 transform border-r border-border bg-bg-2 transition lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex h-16 items-center justify-between border-b border-border px-5">
          <NavLink to="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-black text-black">T</span>
            <span className="text-base font-extrabold tracking-tight">TIPPMIX <span className="text-accent">AI</span></span>
          </NavLink>
          <button className="lg:hidden" onClick={() => setOpen(false)} aria-label="Bezárás"><X className="h-5 w-5" /></button>
        </div>
        <nav className="space-y-1 p-3">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <n.icon className="h-4 w-4" /> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-border p-4 text-xs text-muted">
          {status ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2"><OriginBadge origin={status.dataMode} small /></div>
              <div>Meccsadat: {status.matchProvider}</div>
              <div>Kutatás: {status.researchProvider}</div>
              {auth.configured && auth.user && <div className="truncate" title={auth.user.email ?? ''}>Bejelentkezve: {auth.user.email}</div>}
            </div>
          ) : 'Kapcsolódás a szerverhez…'}
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Tartalom */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-bg px-4 lg:px-8">
          <button className="btn btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label="Menü"><Menu className="h-4 w-4" /></button>
          <form onSubmit={submit} className="relative flex-1 max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input className="input pl-9" placeholder="Keresés: csapat, mérkőzés, bajnokság, ország…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Globális keresés" />
          </form>
          {status && <OriginBadge origin={status.dataMode} />}
          {!auth.loading && (
            auth.user ? (
              <div className="flex items-center gap-2">
                <PlanBadge pro={pro} />
                <span className="hidden max-w-[220px] truncate text-xs text-muted sm:inline" title={auth.user.email ?? ''}>{auth.user.email}</span>
                <button className="btn btn-sm" onClick={() => auth.signOut().then(() => nav('/bejelentkezes'))} title="Kijelentkezés"><LogOut className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Kijelentkezés</span></button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <NavLink to="/bejelentkezes" className="btn btn-sm"><LogIn className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Bejelentkezés</span></NavLink>
                <NavLink to="/regisztracio" className="btn btn-sm btn-primary"><UserPlus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Regisztráció</span></NavLink>
              </div>
            )
          )}
        </header>

        {status?.dataMode === 'demo' && (
          <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn lg:px-8">
            <strong>DEMO ADAT MÓD.</strong> Minden mérkőzés, statisztika, hír és külső tipp beépített, szemléltető adat – nem valós esemény. Élő adathoz állítsd be az API kulcsokat (.env), lásd Beállítások.
          </div>
        )}
        {status?.warnings.filter((w) => !w.startsWith('DEMO')).map((w) => (
          <div key={w} className="border-b border-info/30 bg-info/10 px-4 py-2 text-xs text-info lg:px-8">{w}</div>
        ))}

        <main className="flex-1 px-4 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
