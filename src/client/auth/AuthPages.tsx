/** Bejelentkezés, regisztráció, elfelejtett jelszó, új jelszó – nagy, könnyen használható űrlapok mobilon is. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Card, Loading, Note } from '../components/ui';
import { useAuth } from './AuthContext';

function AuthShell({ title, emoji, text, children }: { title: string; emoji: string; text?: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md space-y-5 py-4 sm:py-8">
      <div className="text-center">
        <span aria-hidden className="inline-flex h-16 w-16 items-center justify-center rounded-3xl bg-primary-soft text-3xl shadow-soft">{emoji}</span>
        <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">{title}</h1>
        {text && <p className="mt-1.5 text-sm font-semibold text-text-muted">{text}</p>}
      </div>
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
    <AuthShell title="Üdv újra! 👋" emoji="⚽" text="Jelentkezz be, és nézd meg a mai elemzéseket.">
      {!auth.configured ? <NotConfigured /> : (
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <label className="field-label">E-mail-cím<input type="email" required autoComplete="email" className="input input-lg mt-1.5" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field-label">Jelszó<input type="password" required autoComplete="current-password" className="input input-lg mt-1.5" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {error && <div className="rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm font-bold text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>{busy ? 'Bejelentkezés…' : 'Bejelentkezés'}</button>
          </form>
          <div className="mt-5 flex flex-wrap justify-between gap-2 text-xs font-bold text-text-muted">
            <Link to="/elfelejtett-jelszo" className="transition hover:text-primary">Elfelejtett jelszó</Link>
            <span>Nincs fiókod? <Link to="/regisztracio" className="text-primary">Regisztráció</Link></span>
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
    <AuthShell title="Hozz létre fiókot 🎯" emoji="📈" text="Ingyenes, és azonnal láthatod a napi tippeket.">
      {!auth.configured ? <NotConfigured /> : done ? (
        <Card><Note>{done}</Note><Link to="/bejelentkezes" className="btn btn-primary mt-4 w-full">Bejelentkezés</Link></Card>
      ) : (
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <label className="field-label">E-mail-cím<input type="email" required autoComplete="email" className="input input-lg mt-1.5" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field-label">Jelszó (legalább 6 karakter)<input type="password" required minLength={6} autoComplete="new-password" className="input input-lg mt-1.5" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="field-label">Jelszó újra<input type="password" required autoComplete="new-password" className="input input-lg mt-1.5" value={password2} onChange={(e) => setPassword2(e.target.value)} /></label>
            {error && <div className="rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm font-bold text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>{busy ? 'Regisztráció…' : 'Fiók létrehozása'}</button>
          </form>
          <div className="mt-5 text-xs font-bold text-text-muted">Van már fiókod? <Link to="/bejelentkezes" className="text-primary">Bejelentkezés</Link></div>
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
    <AuthShell title="Elfelejtett jelszó 🔑" emoji="🔑" text="Megküldjük a visszaállító linket e-mailben.">
      {!auth.configured ? <NotConfigured /> : sent ? (
        <Card><Note>Ha létezik fiók ezzel az e-mail-címmel, elküldtük a jelszó-visszaállító linket. Nyisd meg a levelet, és kattints a linkre.</Note><Link to="/bejelentkezes" className="btn mt-4 w-full">Vissza a bejelentkezéshez</Link></Card>
      ) : (
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <label className="field-label">E-mail-cím<input type="email" required autoComplete="email" className="input input-lg mt-1.5" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            {error && <div className="rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm font-bold text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>{busy ? 'Küldés…' : 'Visszaállító link küldése'}</button>
          </form>
          <div className="mt-5 text-xs font-bold text-text-muted"><Link to="/bejelentkezes" className="transition hover:text-primary">Vissza a bejelentkezéshez</Link></div>
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
    <AuthShell title="Új jelszó 🔒" emoji="🔒" text="Adj meg egy új jelszót a fiókodhoz.">
      {!auth.configured ? <NotConfigured /> : !auth.user ? (
        <Card><Note tone="warn">A visszaállító link érvénytelen vagy lejárt. Kérj újat az „Elfelejtett jelszó” oldalon.</Note><Link to="/elfelejtett-jelszo" className="btn mt-4 w-full">Új link kérése</Link></Card>
      ) : ok ? (
        <Card><Note>A jelszó frissítve. Átirányítás a dashboardra…</Note></Card>
      ) : (
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <label className="field-label">Új jelszó<input type="password" required minLength={6} autoComplete="new-password" className="input input-lg mt-1.5" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="field-label">Új jelszó újra<input type="password" required autoComplete="new-password" className="input input-lg mt-1.5" value={password2} onChange={(e) => setPassword2(e.target.value)} /></label>
            {error && <div className="rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm font-bold text-danger">{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg w-full" disabled={busy}>{busy ? 'Mentés…' : 'Jelszó mentése'}</button>
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
