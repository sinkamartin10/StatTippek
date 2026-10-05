/** PRO oldal: ár (a Stripe Price-ból), előnyök, „PRO aktiválása” → Stripe Checkout; PRO-nak ügyfélportál. */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Crown, Lock } from 'lucide-react';
import { Card, Disclaimer, ErrorBox, Loading, Note } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { STATUS_LABEL, expiryText } from '../auth/useProfile';
import { FREE_DAILY_TIPS, usePlan } from '../auth/PlanContext';
import { PlanBadge } from '../auth/ProfileCard';
import { fmtDateTime, useAsync } from '../lib/format';
import { api } from '../lib/api';

/** Tartalék ár-felirat, ha a Stripe nincs beállítva – élesben a Stripe Price adja az árat. */
export const PRO_PRICE = '2 990 Ft/hó';

const BENEFITS = [
  'Minden mérkőzés, minden piac – nem csak napi 3 tipp',
  'A modell indoklásai: mellette és ellene szóló mutatók, kockázatok',
  'Részletes statisztikák: forma, hazai/idegen bontás, gólpiacok, diagramok',
  'Előzmények: találati arány, kalibráció, nyereség/veszteség',
  'Szelvényépítő valódi oddsokkal, három stratégiával',
  'Odds- és értékelemzés: modell vs. odds szerinti esély minden piacon',
];

const FREE_LIST = [
  `Napi ${FREE_DAILY_TIPS} tipp`,
  'A nap első néhány mérkőzésének elemzése',
  'Liga-átlagok és gyors áttekintés',
  'Hírek és források linkekkel',
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
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Fejléc */}
      <div className="text-center">
        <span className="badge badge-yellow"><Crown className="h-3.5 w-3.5" /> TippStats PRO</span>
        <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Többet szeretnél látni? 👀</h1>
        <p className="mx-auto mt-2 max-w-xl text-sm font-semibold text-text-muted">
          A FREE csomagban naponta {FREE_DAILY_TIPS} tippet látsz. PRO-val megnyílik minden mérkőzés, minden piac és a modell teljes indoklása.
        </p>
      </div>

      {/* Csomagok */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* FREE */}
        <Card className="h-full" title="FREE" right={<span className="badge badge-muted">0 Ft</span>}>
          <ul className="space-y-2.5">
            {FREE_LIST.map((t) => (
              <li key={t} className="flex items-start gap-2 text-sm font-semibold"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {t}</li>
            ))}
            <li className="flex items-start gap-2 text-sm font-semibold text-text-muted"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-warning" /> Indoklás, előzmények és szelvényépítő: zárva</li>
          </ul>
        </Card>

        {/* PRO */}
        <section className="card relative overflow-hidden border-primary/40 p-5 shadow-lift">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight"><Crown className="h-5 w-5 text-secondary" /> PRO</h2>
            {configured && loggedIn && <PlanBadge pro={pro} />}
          </div>
          <div className="mt-1 text-3xl font-black tracking-tight text-primary">{price}</div>
          <p className="mt-1 text-xs font-semibold text-text-muted">Bármikor lemondható. Biztonságos fizetés Stripe-on keresztül – a kártyaadatok nem kerülnek a mi szerverünkre.</p>

          <ul className="mt-4 space-y-2.5">
            {BENEFITS.map((t) => (
              <li key={t} className="flex items-start gap-2 text-sm font-semibold"><Check className="mt-0.5 h-4 w-4 shrink-0 text-success" /> {t}</li>
            ))}
          </ul>

          <div className="mt-5 space-y-2">
            {pro && configured ? (
              <>
                <Note>Aktív PRO előfizetésed van – köszönjük!</Note>
                {profile?.stripe_customer_id && <button className="btn w-full" onClick={openPortal} disabled={busy}>Előfizetés kezelése (számlák, lemondás)</button>}
              </>
            ) : (
              <button className="btn btn-primary btn-lg w-full" onClick={subscribe} disabled={busy || (billing.data ? !billing.data.configured : false)}>
                <Crown className="h-5 w-5" /> {busy ? 'Átirányítás a fizetéshez…' : 'PRO aktiválása'}
              </button>
            )}
            {!loggedIn && configured && <p className="text-center text-xs font-semibold text-text-muted">Nincs még fiókod? <Link to="/regisztracio" className="text-primary">Regisztrálj ingyen</Link></p>}
            {billing.data && !billing.data.configured && <p className="text-center text-xs font-semibold text-warning">A fizetés még nincs beállítva a szerveren (Stripe kulcsok) – lásd README.</p>}
            {loggedIn && billing.data?.configured && <button className="btn btn-sm btn-ghost w-full" onClick={syncNow} disabled={busy} title="Az előfizetés állapotának lekérése közvetlenül a Stripe-ból">Státusz frissítése</button>}
          </div>
          {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}
        </section>
      </div>

      {/* Az előfizetésed */}
      {configured && loggedIn && (
        <Card title="Az előfizetésed">
          {loading && !profile ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-card-2 p-3"><div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Fiók</div><div className="mt-1 truncate text-sm font-extrabold">{user?.email}</div></div>
              <div className="rounded-xl border border-border bg-card-2 p-3"><div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Státusz</div><div className="mt-1 text-sm font-extrabold">{profile ? STATUS_LABEL[profile.subscription_status] : '–'}</div></div>
              <div className="rounded-xl border border-border bg-card-2 p-3"><div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Lejárat</div><div className="mt-1 text-sm font-extrabold">{expiryText(profile, fmtDateTime)}</div></div>
            </div>
          )}
        </Card>
      )}

      <Note>A TippStats elemző eszköz – egyetlen csomag sem ígér nyereséget. Az előfizetés státuszát csak a szerver módosíthatja; a felületről nem állítható át.</Note>
      <Disclaimer />
    </div>
  );
}
