/**
 * Admin: PRO kézi befizetések (banki átutalás / Revolut) ellenőrzése.
 *
 * A jóváhagyás a SZERVEREN aktiválja a PRO-t (egy tranzakcióban a kérelem
 * lezárásával); az elutasítás csak lezárja a kérelmet. Ugyanazt a kérelmet a
 * szerver nem engedi kétszer feldolgozni. Az admin jogot a szerver dönti el
 * (ADMIN_EMAILS) – ez az oldal nem admin fióknak 403-at kap.
 *
 * Ugyanitt: az ingyenes, 3 napos PRO próbaidőszak igénylései (jóváhagyás = PRO pontosan
 * 3 napra a szerveren; elutasítás = végleges, a fiók többé nem igényelhet).
 */
import { useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import {
  INTERVAL_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, formatAmount,
  type AdminPaymentRequestView, type PaymentRequestStatus,
} from '@shared/manualPayment';
import { api } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { singleFlight } from '../lib/learningDashboard';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { TRIAL_STATUS_LABEL, type AdminTrialRequestView, type TrialRequestStatus } from '@shared/proTrial';

type Filter = PaymentRequestStatus | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Függőben' }, { key: 'approved', label: 'Elfogadva' }, { key: 'rejected', label: 'Elutasítva' }, { key: 'all', label: 'Mind' },
];
const STATUS_BADGE: Record<PaymentRequestStatus, string> = { pending: 'badge-yellow', approved: 'badge-green', rejected: 'badge-red' };
const PROFILE_LABEL: Record<string, string> = { free: 'Ingyenes', pro: 'PRO', past_due: 'Fizetés elmaradva', canceled: 'Lemondva' };

export default function AdminProPayments() {
  const [filter, setFilter] = useState<Filter>('pending');
  const list = useAsync(() => api.adminProPayments(filter), [filter]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader emoji="💳" title="PRO befizetések" text="Kézi (banki átutalás / Revolut) befizetések ellenőrzése, jóváhagyása vagy elutasítása." />
      <Note tone="warn">Jóváhagyás előtt ellenőrizd a bankszámlán vagy a Revolutban, hogy az összeg a megadott közleménnyel (a fiók e-mail-címével) valóban beérkezett. A jóváhagyás azonnal aktiválja vagy meghosszabbítja a PRO-t.</Note>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Állapot szerinti szűrés">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`chip ${filter === f.key ? 'chip-active' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>
      {list.loading && !list.data ? <Card><Loading /></Card>
        : list.error ? <ErrorBox message={list.error} onRetry={list.reload} />
          : !list.data?.length ? <EmptyState emoji="📭" title="Nincs ilyen kérelem" />
            : <div className="space-y-3">{list.data.map((r) => <AdminPaymentCard key={r.id} r={r} onDone={list.reload} />)}</div>}

      <AdminTrialSection />
    </div>
  );
}

/** Ingyenes PRO próbaidőszak igénylések – ugyanazokkal a szűrőkkel, mint a befizetések. */
function AdminTrialSection() {
  const [filter, setFilter] = useState<TrialRequestStatus | 'all'>('pending');
  const list = useAsync(() => api.adminProTrials(filter), [filter]);
  return (
    <section className="space-y-3 border-t border-border pt-6" aria-labelledby="pro-trial-requests">
      <h2 id="pro-trial-requests" className="text-xl font-black tracking-tight">Ingyenes PRO próbaidőszak igénylések</h2>
      <p className="text-sm font-semibold text-text-muted">A jóváhagyás azonnal, pontosan 3 napra aktiválja a PRO-t (fizetés nélkül); a lejárat után a fiók magától FREE. Az elutasítás végleges – a fiók többé nem igényelhet.</p>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Próbaidőszak-igénylések szűrése">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={`chip ${filter === f.key ? 'chip-active' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>
      {list.loading && !list.data ? <Card><Loading /></Card>
        : list.error ? <ErrorBox message={list.error} onRetry={list.reload} />
          : !list.data?.length ? <EmptyState emoji="📭" title="Nincs ilyen igénylés" />
            : <div className="space-y-3">{list.data.map((r) => <AdminTrialCard key={r.id} r={r} onDone={list.reload} />)}</div>}
    </section>
  );
}

/** Egy próbaidőszak-igénylés kártyája; döntés csak függő igénylésnél. */
export function AdminTrialCard({ r, onDone }: { r: AdminTrialRequestView; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const actRef = useRef<(kind: 'approve' | 'reject') => Promise<void>>(async () => {});
  actRef.current = async (kind) => {
    setBusy(true); setMsg(null);
    try {
      if (kind === 'approve') {
        const out = await api.adminApproveProTrial(r.id);
        setMsg({ tone: 'info', text: `Jóváhagyva – PRO próbaidőszak eddig: ${out.request.trialEnd ? fmtDateTime(out.request.trialEnd) : '–'}.` });
      } else {
        await api.adminRejectProTrial(r.id);
        setMsg({ tone: 'info', text: 'Elutasítva.' });
      }
      onDone();
    } catch (e) {
      setMsg({ tone: 'warn', text: (e as Error).message });
    } finally { setBusy(false); }
  };
  const approveGate = useRef(singleFlight(() => actRef.current('approve')));
  const rejectGate = useRef(singleFlight(() => actRef.current('reject')));

  return (
    <div className="card p-4" data-status={r.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-base font-extrabold">{r.displayName ?? 'Nincs felhasználónév'}</div>
          <div className="truncate text-sm font-semibold text-text-muted">{r.email}</div>
        </div>
        <span className={`badge ${STATUS_BADGE[r.status]}`}>{TRIAL_STATUS_LABEL[r.status]}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm font-semibold sm:grid-cols-3">
        <div><dt className="text-[11px] font-extrabold uppercase text-text-muted">Igényelve</dt><dd>{fmtDateTime(r.createdAt)}</dd></div>
        {r.decidedAt && <div><dt className="text-[11px] font-extrabold uppercase text-text-muted">Döntés</dt><dd>{fmtDateTime(r.decidedAt)}</dd></div>}
        {r.trialEnd && <div><dt className="text-[11px] font-extrabold uppercase text-text-muted">Próbaidőszak</dt><dd>{r.trialStart ? fmtDateTime(r.trialStart) : '–'} – {fmtDateTime(r.trialEnd)}</dd></div>}
      </dl>
      <p className="mt-2 text-xs font-semibold text-text-muted">
        Jelenlegi profil: {r.profile ? `${PROFILE_LABEL[r.profile.status] ?? r.profile.status}${r.profile.subscriptionEnd ? ` (lejár: ${fmtDateTime(r.profile.subscriptionEnd)})` : r.profile.status === 'pro' ? ' (lejárat nélkül)' : ''}` : 'nincs profil'}
      </p>
      {r.status === 'pending' && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <button type="button" className="btn btn-primary" onClick={() => { if (!busy) void approveGate.current(); }} disabled={busy}><Check className="h-4 w-4" /> {busy ? 'Feldolgozás…' : 'Elfogadás'}</button>
          <button type="button" className="btn" onClick={() => { if (!busy) void rejectGate.current(); }} disabled={busy}><X className="h-4 w-4" /> Elutasítás</button>
        </div>
      )}
      {msg && <div className="mt-2"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </div>
  );
}

/** Egy kérelem kártyája a döntési lehetőségekkel (csak függő kérelemnél). */
export function AdminPaymentCard({ r, onDone }: { r: AdminPaymentRequestView; onDone: () => void }) {
  const [step, setStep] = useState<'idle' | 'confirm-approve' | 'confirm-reject'>('idle');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const actRef = useRef<(kind: 'approve' | 'reject') => Promise<void>>(async () => {});
  actRef.current = async (kind) => {
    setBusy(true); setMsg(null);
    try {
      if (kind === 'approve') {
        // a megerősítő lépésben jóváhagyott összeg/mód megy a szerverhez, ami összeveti a kérelemmel
        const out = await api.adminApproveProPayment(r.id, { amount: r.amount, currency: r.currency, method: r.method });
        setMsg({ tone: 'info', text: out.request.activatedUntil ? `Jóváhagyva – PRO eddig: ${fmtDateTime(out.request.activatedUntil)}.` : 'Jóváhagyva (a fiók már korlátlan PRO volt, a lejárat nem változott).' });
      } else {
        await api.adminRejectProPayment(r.id, note.trim() || null);
        setMsg({ tone: 'info', text: 'Elutasítva.' });
      }
      setStep('idle');
      onDone();
    } catch (e) {
      setMsg({ tone: 'warn', text: (e as Error).message });
    } finally { setBusy(false); }
  };
  const approveGate = useRef(singleFlight(() => actRef.current('approve')));
  const rejectGate = useRef(singleFlight(() => actRef.current('reject')));

  return (
    <div className="card p-4" data-status={r.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-base font-extrabold">{r.email}</div>
          <div className="mono truncate text-[11px] font-semibold text-text-muted" title="Felhasználó-azonosító">{r.userId}</div>
        </div>
        <span className={`badge ${STATUS_BADGE[r.status]}`}>{PAYMENT_STATUS_LABEL[r.status]}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm font-semibold sm:grid-cols-4">
        <div><dt className="text-[11px] font-extrabold uppercase text-text-muted">Mód</dt><dd>{PAYMENT_METHOD_LABEL[r.method]}</dd></div>
        <div><dt className="text-[11px] font-extrabold uppercase text-text-muted">Csomag / összeg</dt><dd>PRO · {formatAmount(r.amount, r.currency)} · {INTERVAL_LABEL[r.interval]}</dd></div>
        <div><dt className="text-[11px] font-extrabold uppercase text-text-muted">Közlemény</dt><dd className="break-all">{r.reference}</dd></div>
        <div><dt className="text-[11px] font-extrabold uppercase text-text-muted">Jelezve</dt><dd>{fmtDateTime(r.createdAt)}</dd></div>
      </dl>
      <p className="mt-2 text-xs font-semibold text-text-muted">
        Jelenlegi profil: {r.profile ? `${PROFILE_LABEL[r.profile.status] ?? r.profile.status}${r.profile.subscriptionEnd ? ` (lejár: ${fmtDateTime(r.profile.subscriptionEnd)})` : r.profile.status === 'pro' ? ' (lejárat nélkül)' : ''}` : 'nincs profil'}
        {r.decidedAt && ` · Döntés: ${fmtDateTime(r.decidedAt)}`}
        {r.activatedUntil && ` · PRO eddig: ${fmtDateTime(r.activatedUntil)}`}
        {r.decisionNote && ` · Megjegyzés: ${r.decisionNote}`}
      </p>
      {r.profile?.stripeManaged && r.status === 'pending' && (
        <div className="mt-2"><Note tone="warn">Ennek a fióknak élő Stripe-előfizetése van – a szerver nem engedi a kézi aktiválást, amíg a Stripe-előfizetés él.</Note></div>
      )}

      {r.status === 'pending' && (
        <div className="mt-3 border-t border-border pt-3">
          {step === 'idle' && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={() => setStep('confirm-approve')} disabled={busy}><Check className="h-4 w-4" /> Elfogadás</button>
              <button type="button" className="btn" onClick={() => setStep('confirm-reject')} disabled={busy}><X className="h-4 w-4" /> Elutasítás</button>
            </div>
          )}
          {step === 'confirm-approve' && (
            <div className="space-y-2">
              <p className="text-sm font-bold">Biztosan beérkezett {formatAmount(r.amount, r.currency)} ({PAYMENT_METHOD_LABEL[r.method]}) a(z) „{r.reference}” közleménnyel? A jóváhagyás aktiválja a PRO-t ({INTERVAL_LABEL[r.interval]}).</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary" onClick={() => { if (!busy) void approveGate.current(); }} disabled={busy}>{busy ? 'Feldolgozás…' : 'Igen, beérkezett – PRO aktiválása'}</button>
                <button type="button" className="btn" onClick={() => setStep('idle')} disabled={busy}>Mégse</button>
              </div>
            </div>
          )}
          {step === 'confirm-reject' && (
            <div className="space-y-2">
              <label className="field-label" htmlFor={`note-${r.id}`}>Megjegyzés a felhasználónak (nem kötelező)</label>
              <input id={`note-${r.id}`} className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="pl. nem érkezett meg az utalás" disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn" onClick={() => { if (!busy) void rejectGate.current(); }} disabled={busy}>{busy ? 'Feldolgozás…' : 'Elutasítás megerősítése'}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setStep('idle')} disabled={busy}>Mégse</button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <div className="mt-2"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </div>
  );
}
