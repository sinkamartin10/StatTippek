/** PRO oldal (látogatóknak is): ár (a Stripe Price-ból), funkciók, „Előfizetek” → Stripe Checkout; PRO-nak ügyfélportál. */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Crown, Lock } from 'lucide-react';
import { Card, Disclaimer, ErrorBox, Loading, Note } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { STATUS_LABEL, expiryText } from '../auth/useProfile';
import { FREE_DAILY_TIPS, usePlan } from '../auth/PlanContext';
import { PlanBadge } from '../auth/ProfileCard';
import { fmtDateTime, useAsync } from '../lib/format';
import { api } from '../lib/api';

/** Tartalék ár-felirat, ha a Stripe nincs beállítva – élesben a Stripe Price adja az árat. */
export const PRO_PRICE = '2 990 Ft/hó';

const FEATURES: { label: string; free: string | null; pro: string }[] = [
  { label: 'Teljes tipplisták', free: `napi ${FREE_DAILY_TIPS} tipp`, pro: 'minden mérkőzés, minden piac' },
  { label: 'Részletes statisztikák', free: 'csak gyors áttekintés', pro: 'forma, hazai/idegen bontás, gólpiacok, egymás elleni, diagramok' },
  { label: 'Modell indoklásai', free: null, pro: 'tippenként mellette/ellene érvek, kockázatok, 1X2 tényezők' },
  { label: 'Történelmi eredmények', free: null, pro: 'előzmények, találati arány, kalibráció, ROI' },
  { label: 'Szelvényépítő', free: null, pro: 'kombinációk valódi oddsokkal, három stratégia' },
  { label: 'Odds és értékelemzés', free: 'alap odds', pro: 'modell vs. implikált valószínűség minden piacon' },
  { label: 'Mérkőzések, hírek, források', free: 'igen', pro: 'igen' },
];

export default function Pro() {
  const { user } = useAuth();
  const { configured, loggedIn, pro, profile, loading, error, reload } = usePlan();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const billing = useAsync(() => api.billingConfig(), []);
  const price = billing.data?.label ?? PRO_PRICE;
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Visszatérés a Stripe Checkoutból: a státuszt a webhook írja – néhány másodpercig újratöltjük a profilt
  const checkoutResult = sp.get('checkout');
  useEffect(() => {
    if (!checkoutResult) return;
    if (checkoutResult === 'success') {
      setMsg({ tone: 'info', text: 'Sikeres fizetés! Az előfizetés státuszát frissítjük…' });
      // 1) azonnali szinkron a Stripe-ból (webhook nélkül is), 2) utána néhány újratöltés a webhookra várva
      void api.billingSync().then(() => reload()).catch(() => undefined);
      let tries = 0;
      const t = setInterval(() => { void reload(); if (++tries >= 10) clearInterval(t); }, 2000);
      return () => clearInterval(t);
    }
    if (checkoutResult === 'cancel') setMsg({ tone: 'warn', text: 'A fizetést megszakítottad – nem történt terhelés.' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutResult]);
  useEffect(() => { if (checkoutResult === 'success' && pro) { setMsg({ tone: 'info', text: 'Az előfizetésed aktív – köszönjük! Minden PRO funkció elérhető.' }); setSp({}, { replace: true }); } }, [pro, checkoutResult, setSp]);

  const subscribe = async () => {
    if (!loggedIn) { nav('/bejelentkezes', { state: { from: '/pro' } }); return; }
    setBusy(true); setMsg(null);
    try {
      const { url } = await api.checkout();
      window.location.assign(url); // Stripe Checkout (a titkos kulcs a szerveren marad)
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.billingSync();
      await reload();
      setMsg(r.synced ? { tone: 'info', text: r.pro ? 'Szinkronizálva: az előfizetésed aktív (PRO).' : `Szinkronizálva: státusz „${r.status}”.` } : { tone: 'warn', text: r.reason ?? 'Nincs mit szinkronizálni.' });
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const openPortal = async () => {
    setBusy(true); setMsg(null);
    try { const { url } = await api.billingPortal(); window.location.assign(url); }
    catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div className="card overflow-hidden">
        <div className="bg-gradient-to-r from-accent/15 via-transparent to-warn/10 p-6 md:p-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="flex items-center gap-2 text-3xl font-extrabold tracking-tight"><Crown className="h-7 w-7 text-accent" /> TIPPMIX AI PRO</h1>
            {configured && loggedIn && <PlanBadge pro={pro} />}
          </div>
          <div className="mt-2 text-4xl font-black tracking-tight text-accent">{price}</div>
          <p className="mt-2 max-w-2xl text-sm text-muted">Teljes hozzáférés az elemzésekhez: minden tipp, részletes statisztikák, a modell indoklásai és a történelmi eredmények. Bármikor lemondható.</p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {['Teljes tipplisták', 'Részletes statisztikák', 'Modell indoklásai', 'Történelmi eredmények', 'Szelvényépítő', 'Odds- és értékelemzés'].map((f) => (
              <li key={f} className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 shrink-0 text-accent" /> {f}</li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {pro && configured ? (
              <>
                <Note>Aktív PRO előfizetésed van – köszönjük!</Note>
                {profile?.stripe_customer_id && <button className="btn" onClick={openPortal} disabled={busy}>Előfizetés kezelése (számlák, lemondás)</button>}
              </>
            ) : (
              <button className="btn btn-primary px-6 py-3 text-base" onClick={subscribe} disabled={busy || (billing.data ? !billing.data.configured : false)}><Crown className="h-5 w-5" /> {busy ? 'Átirányítás a fizetéshez…' : 'Előfizetek'}</button>
            )}
            {!loggedIn && configured && <span className="text-xs text-muted">Nincs még fiókod? <Link to="/regisztracio" className="text-accent">Regisztrálj ingyen</Link></span>}
            {billing.data && !billing.data.configured && <span className="text-xs text-warn">A fizetés még nincs beállítva a szerveren (Stripe kulcsok) – lásd README.</span>}
            {loggedIn && billing.data?.configured && <button className="btn btn-sm" onClick={syncNow} disabled={busy} title="Az előfizetés állapotának lekérése közvetlenül a Stripe-ból">Státusz frissítése</button>}
          </div>
          {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}
          <div className="mt-3 text-[11px] text-muted">Biztonságos fizetés a Stripe-on keresztül; a kártyaadatok nem kerülnek a mi szerverünkre.</div>
        </div>
      </div>

      {configured && loggedIn && (
        <Card title="Az előfizetésed">
          {loading && !profile ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-bg-2/60 p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Fiók</div><div className="mt-1 truncate text-sm font-semibold">{user?.email}</div></div>
              <div className="rounded-lg border border-border bg-bg-2/60 p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Státusz</div><div className="mt-1 text-sm font-semibold">{profile ? STATUS_LABEL[profile.subscription_status] : '–'}</div></div>
              <div className="rounded-lg border border-border bg-bg-2/60 p-3"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Lejárat</div><div className="mt-1 text-sm font-semibold">{expiryText(profile, fmtDateTime)}</div></div>
            </div>
          )}
        </Card>
      )}

      <Card title="FREE és PRO összehasonlítás">
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Funkció</th><th>FREE</th><th>PRO – {price}</th></tr></thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr key={f.label}>
                  <td className="font-medium">{f.label}</td>
                  <td className="text-sm">{f.free ? <span className="text-muted">{f.free}</span> : <span className="inline-flex items-center gap-1 text-warn"><Lock className="h-3.5 w-3.5" /> zárva</span>}</td>
                  <td className="text-sm"><span className="inline-flex items-center gap-1"><CheckCircle2 className="h-4 w-4 text-accent" /> {f.pro}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Note>A TIPPMIX AI elemző eszköz – egyetlen csomag sem ígér nyereséget. Az előfizetés státuszát csak a szerver módosíthatja; a felületről nem állítható át.</Note>
      <Disclaimer />
    </div>
  );
}
