/** Bejelentkezés, regisztráció, elfelejtett jelszó, új jelszó – a meglévő kártya/űrlap stílusokkal. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LogIn, UserPlus, KeyRound } from 'lucide-react';
import { Card, Loading, Note } from '../components/ui';
import { useAuth } from './AuthContext';

function AuthShell({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md space-y-4 py-6">
      <div className="flex items-center gap-2"><span className="text-accent">{icon}</span><h1 className="text-2xl font-extrabold tracking-tight">{title}</h1></div>
      {children}
    </div>
  );
}

function NotConfigured() {
  return (
    <Note tone="warn">
      A hitelesítés nincs beállítva. Add meg a <code>VITE_SUPABASE_URL</code> és <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> értékeket a <code>.env</code> fájlban, majd indítsd újra a dev szervert.
    </Note>
  );
}

export function LoginPage() {
  const auth = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.loading) return <Loading />;
  if (auth.user) return <Navigate to={loc.state?.from ?? '/dashboard'} replace />; // bejelentkezett felhasználó → dashboard

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await auth.signIn(email.trim(), password); nav(loc.state?.from ?? '/dashboard', { replace: true }); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <AuthShell title="Bejelentkezés" icon={<LogIn className="h-6 w-6" />}>
      {!auth.configured ? <NotConfigured /> : (
        <Card>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-xs text-muted">E-mail-cím<input type="email" required autoComplete="email" className="input mt-1" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="block text-xs text-muted">Jelszó<input type="password" required autoComplete="current-password" className="input mt-1" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {error && <div className="text-sm text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>{busy ? 'Bejelentkezés…' : 'Bejelentkezés'}</button>
          </form>
          <div className="mt-4 flex flex-wrap justify-between gap-2 text-xs text-muted">
            <Link to="/elfelejtett-jelszo" className="hover:text-accent">Elfelejtett jelszó</Link>
            <span>Nincs fiókod? <Link to="/regisztracio" className="text-accent">Regisztráció</Link></span>
          </div>
        </Card>
      )}
    </AuthShell>
  );
}

export function RegisterPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.loading) return <Loading />;
  if (auth.user) return <Navigate to="/dashboard" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== password2) { setError('A két jelszó nem egyezik.'); return; }
    if (password.length < 6) { setError('A jelszó legalább 6 karakter legyen.'); return; }
    setBusy(true);
    try {
      const r = await auth.signUp(email.trim(), password);
      setDone(r.needsConfirmation ? 'Sikeres regisztráció! Küldtünk egy megerősítő e-mailt – kattints a benne lévő linkre, utána be tudsz jelentkezni.' : 'Sikeres regisztráció, be vagy jelentkezve.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <AuthShell title="Regisztráció" icon={<UserPlus className="h-6 w-6" />}>
      {!auth.configured ? <NotConfigured /> : done ? (
        <Card><Note>{done}</Note><Link to="/bejelentkezes" className="btn btn-primary mt-4">Bejelentkezés</Link></Card>
      ) : (
        <Card>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-xs text-muted">E-mail-cím<input type="email" required autoComplete="email" className="input mt-1" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="block text-xs text-muted">Jelszó (legalább 6 karakter)<input type="password" required minLength={6} autoComplete="new-password" className="input mt-1" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="block text-xs text-muted">Jelszó újra<input type="password" required autoComplete="new-password" className="input mt-1" value={password2} onChange={(e) => setPassword2(e.target.value)} /></label>
            {error && <div className="text-sm text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>{busy ? 'Regisztráció…' : 'Fiók létrehozása'}</button>
          </form>
          <div className="mt-4 text-xs text-muted">Van már fiókod? <Link to="/bejelentkezes" className="text-accent">Bejelentkezés</Link></div>
        </Card>
      )}
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await auth.resetPassword(email.trim()); setSent(true); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <AuthShell title="Elfelejtett jelszó" icon={<KeyRound className="h-6 w-6" />}>
      {!auth.configured ? <NotConfigured /> : sent ? (
        <Card><Note>Ha létezik fiók ezzel az e-mail-címmel, elküldtük a jelszó-visszaállító linket. Nyisd meg a levelet, és kattints a linkre.</Note><Link to="/bejelentkezes" className="btn mt-4">Vissza a bejelentkezéshez</Link></Card>
      ) : (
        <Card>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-xs text-muted">E-mail-cím<input type="email" required autoComplete="email" className="input mt-1" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            {error && <div className="text-sm text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>{busy ? 'Küldés…' : 'Visszaállító link küldése'}</button>
          </form>
          <div className="mt-4 text-xs text-muted"><Link to="/bejelentkezes" className="hover:text-accent">Vissza a bejelentkezéshez</Link></div>
        </Card>
      )}
    </AuthShell>
  );
}

/** A visszaállító linkről ide érkezik a felhasználó (recovery munkamenettel) – itt adja meg az új jelszót. */
export function NewPasswordPage() {
  const auth = useAuth();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => { if (ok) { const t = setTimeout(() => nav('/dashboard', { replace: true }), 1500); return () => clearTimeout(t); } }, [ok, nav]);

  if (auth.loading) return <Loading />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== password2) { setError('A két jelszó nem egyezik.'); return; }
    if (password.length < 6) { setError('A jelszó legalább 6 karakter legyen.'); return; }
    setBusy(true);
    try { await auth.updatePassword(password); setOk(true); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <AuthShell title="Új jelszó" icon={<KeyRound className="h-6 w-6" />}>
      {!auth.configured ? <NotConfigured /> : !auth.user ? (
        <Card><Note tone="warn">A visszaállító link érvénytelen vagy lejárt. Kérj újat az „Elfelejtett jelszó” oldalon.</Note><Link to="/elfelejtett-jelszo" className="btn mt-4">Új link kérése</Link></Card>
      ) : ok ? (
        <Card><Note>A jelszó frissítve. Átirányítás a dashboardra…</Note></Card>
      ) : (
        <Card>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-xs text-muted">Új jelszó<input type="password" required minLength={6} autoComplete="new-password" className="input mt-1" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="block text-xs text-muted">Új jelszó újra<input type="password" required autoComplete="new-password" className="input mt-1" value={password2} onChange={(e) => setPassword2(e.target.value)} /></label>
            {error && <div className="text-sm text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>{busy ? 'Mentés…' : 'Jelszó mentése'}</button>
          </form>
        </Card>
      )}
    </AuthShell>
  );
}

/** Védett útvonal: bejelentkezés nélkül a bejelentkező oldalra irányít (ha a hitelesítés be van állítva). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const loc = useLocation();
  if (!auth.configured) return <>{children}</>; // auth nélkül az app nyitott marad
  if (auth.loading) return <Loading text="Munkamenet ellenőrzése…" />;
  if (!auth.user) return <Navigate to="/bejelentkezes" replace state={{ from: loc.pathname + loc.search }} />;
  return <>{children}</>;
}
