/** Profil: fiók, csomag (FREE/PRO), előfizetés kezelése, kijelentkezés. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Crown, LogOut, Mail, ShieldCheck, Trophy } from 'lucide-react';
import { Card, Disclaimer, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { usePlan } from '../auth/PlanContext';
import { PlanBadge } from '../auth/ProfileCard';
import { STATUS_LABEL, daysUntilEnd, expiryText } from '../auth/useProfile';
import { fmtDateTime } from '../lib/format';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { DisplayNameEditor } from '../components/DisplayNameEditor';
import { ProgressionCard } from '../components/ProgressionCard';
import { ShopCosmeticsCard } from '../components/ShopCosmeticsCard';

export default function Profile() {
  const auth = useAuth();
  const { profile, loading, error, pro, reload, configured } = usePlan();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  // A megjelenítési nevet a szerver adja vissza (a meglévő profiles táblából)
  const me = useAsync(() => api.profileMe().catch(() => null), []);

  const openPortal = async () => {
    setBusy(true); setMsg(null);
    try { const { url } = await api.billingPortal(); window.location.assign(url); }
    catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.billingSync();
      await reload();
      setMsg(r.synced ? { tone: 'info', text: r.pro ? 'Szinkronizálva: az előfizetésed aktív (PRO).' : `Szinkronizálva: státusz „${r.status}”.` } : { tone: 'warn', text: r.reason ?? 'Nincs mit szinkronizálni.' });
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (!configured) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <PageHeader emoji="👤" title="Profil" />
        <Note tone="warn">A hitelesítés nincs beállítva ezen a példányon, így nincs fiók. Helyi módban minden funkció nyitott.</Note>
      </div>
    );
  }

  if (auth.loading) return <Loading text="Munkamenet ellenőrzése…" />;

  if (!auth.user) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <PageHeader emoji="👤" title="Profil" text="Jelentkezz be a fiókod és az előfizetésed megtekintéséhez." />
        <Card>
          <div className="flex flex-wrap gap-3">
            <Link to="/bejelentkezes" className="btn btn-primary">Bejelentkezés</Link>
            <Link to="/regisztracio" className="btn">Regisztráció</Link>
          </div>
        </Card>
      </div>
    );
  }

  const d = daysUntilEnd(profile);
  const soon = d != null && d >= 0 && d <= 7;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader emoji="👤" title="Profil" text="A fiókod, az előfizetésed és a Tipster profilod." right={<PlanBadge pro={pro} />} />

      <Card title="Fiók">
        {loading && !profile ? <Loading text="Profil betöltése…" /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card-2 p-3.5">
              <span aria-hidden className="icon-bubble bg-primary-soft text-primary-strong"><Mail className="h-5 w-5" /></span>
              <div className="min-w-0">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">E-mail-cím</div>
                <div className="truncate text-sm font-extrabold" title={auth.user.email ?? ''}>{auth.user.email}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card-2 p-3.5">
              <span aria-hidden className={`icon-bubble ${pro ? 'bg-secondary-soft text-[#a96b00]' : 'bg-surface text-text-muted'}`}>{pro ? <Crown className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Csomag</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <PlanBadge pro={pro} />
                  <span className="text-sm font-bold text-text-muted">{profile ? STATUS_LABEL[profile.subscription_status] : '–'}</span>
                </div>
                {profile && (pro || profile.subscription_end) && (
                  <div className={`mt-1 text-xs font-bold ${d != null && d < 0 ? 'text-danger' : soon ? 'text-warning' : 'text-text-muted'}`}>
                    {expiryText(profile, fmtDateTime)}{soon ? ' – hamarosan lejár' : ''}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-2"><Trophy className="h-5 w-5 text-warning" /> Megjelenítési név</span>}>
        <p className="mb-3 text-sm font-semibold text-text-muted">
          Ezt a nevet látják a többiek a <b className="text-text">Tippverseny ranglistáján</b>. Az e-mail-címed és a valódi neved sosem jelenik meg.
          A Tippversenyben való részvételhez kötelező beállítani.
        </p>
        {me.loading ? <Loading text="Név betöltése…" /> : (
          <DisplayNameEditor current={me.data?.displayName ?? null} onSaved={() => me.reload()} />
        )}
      </Card>

      {/* Tipster progression – külön modul, a meglévő profilfunkciókat nem érinti */}
      <ShopCosmeticsCard displayName={me.data?.displayName ?? null} />

      <ProgressionCard displayName={me.data?.displayName ?? null} />

      <Card title="Előfizetés kezelése">
        <div className="flex flex-wrap gap-2">
          {pro ? (
            profile?.stripe_customer_id
              ? <button className="btn btn-primary" onClick={openPortal} disabled={busy}>Számlák és lemondás</button>
              : <Link to="/pro" className="btn btn-primary"><Crown className="h-4 w-4" /> PRO részletek</Link>
          ) : (
            <Link to="/pro" className="btn btn-primary"><Crown className="h-4 w-4" /> PRO kipróbálása</Link>
          )}
          <button className="btn" onClick={syncNow} disabled={busy} title="Az előfizetés állapotának lekérése közvetlenül a Stripe-ból">Státusz frissítése</button>
          <Link to="/beallitasok" className="btn">Beállítások</Link>
        </div>
        {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}
        <p className="mt-3 text-xs font-semibold text-text-muted">Az előfizetés állapotát kizárólag a szerver (Stripe) írja – a felületről nem módosítható.</p>
      </Card>

      <Card title="Munkamenet">
        <button className="btn w-full sm:w-auto" onClick={() => auth.signOut().then(() => nav('/bejelentkezes'))}>
          <LogOut className="h-4 w-4" /> Kijelentkezés
        </button>
      </Card>

      <Disclaimer />
    </div>
  );
}
