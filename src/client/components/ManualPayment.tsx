/**
 * PRO előfizetés igénylése kézi fizetéssel (banki átutalás / Revolut).
 *
 * A felület CSAK a fizetési adatokat mutatja és a „befizettem” jelzést küldi el.
 * A PRO-t a felület soha nem állítja be: a kérelem függő marad, amíg egy admin
 * a beérkezett összeg ellenőrzése után jóvá nem hagyja (szerveroldalon).
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink, Landmark, Send, Smartphone } from 'lucide-react';
import {
  INTERVAL_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, accountNumberDigits, formatAmount,
  type PaymentMethod, type PaymentRequestView, type ProPaymentInfo,
} from '@shared/manualPayment';
import { Note } from './ui';
import { copyText } from '../lib/clipboard';
import { api } from '../lib/api';
import { singleFlight } from '../lib/learningDashboard';
import { fmtDateTime } from '../lib/format';

/** Egy másolható adat: címke, érték, másolás gomb („Másolva” visszajelzéssel). */
export function CopyField({ label, value, copyValue, mono = true }: { label: string; value: string; copyValue?: string; mono?: boolean }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    const ok = await copyText(copyValue ?? value);
    setState(ok ? 'ok' : 'fail');
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <div className="rounded-xl border border-border bg-card-2 p-3">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className={`min-w-0 [overflow-wrap:anywhere] text-sm font-extrabold ${mono ? 'mono' : ''}`}>{value}</span>
        <button type="button" className="btn btn-sm shrink-0" onClick={copy} aria-label={`${label} másolása`}>
          {state === 'ok' ? <><Check className="h-3.5 w-3.5 text-success" /> Másolva</> : <><Copy className="h-3.5 w-3.5" /> {state === 'fail' ? 'Nem sikerült' : 'Másolás'}</>}
        </button>
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<PaymentRequestView['status'], string> = { pending: 'badge-yellow', approved: 'badge-green', rejected: 'badge-red' };

/** A felhasználó saját kérelmei (legújabb elöl). */
export function PaymentRequestList({ requests }: { requests: PaymentRequestView[] }) {
  if (!requests.length) return <p className="text-sm font-semibold text-text-muted">Még nem jeleztél befizetést.</p>;
  return (
    <ul className="divide-y divide-border">
      {requests.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm font-semibold">
          <span className="min-w-0">
            <span className="block font-extrabold">{formatAmount(r.amount, r.currency)} · {INTERVAL_LABEL[r.interval]} · {PAYMENT_METHOD_LABEL[r.method]}</span>
            <span className="block text-xs text-text-muted">
              Jelezve: {fmtDateTime(r.createdAt)}
              {r.status === 'approved' && r.activatedUntil && ` · PRO eddig: ${fmtDateTime(r.activatedUntil)}`}
              {r.status === 'rejected' && r.decisionNote && ` · Megjegyzés: ${r.decisionNote}`}
            </span>
          </span>
          <span className={`badge ${STATUS_BADGE[r.status]}`}>{PAYMENT_STATUS_LABEL[r.status]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A teljes igénylő szekció. `info` a szervertől jön (ár, kedvezményezett, saját
 * kérelmek, közlemény) – itt semmilyen összeg nincs beégetve.
 */
export function ManualPaymentSection({ info, loggedIn, onRequested, stripeManaged = false }: {
  info: ProPaymentInfo; loggedIn: boolean; onRequested: () => void; stripeManaged?: boolean;
}) {
  const { price, payee, requests, reference } = info;
  const amount = formatAmount(price.amount, price.currency);
  const pending = requests.find((r) => r.status === 'pending') ?? null;
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const sendRef = useRef<() => Promise<void>>(async () => {});
  sendRef.current = async () => {
    setBusy(true); setMsg(null);
    try {
      const { created } = await api.requestProPayment(method);
      setMsg({ tone: 'info', text: created
        ? 'Köszönjük! A befizetésedet ellenőrzésre jelöltük. A PRO hozzáférést a befizetés beérkezésének ellenőrzése után aktiváljuk – ez nem automatikus.'
        : 'Már van ellenőrzésre váró befizetésed – nem hoztunk létre újat.' });
      onRequested();
    } catch (e) {
      setMsg({ tone: 'warn', text: (e as Error).message || 'A jelzés nem sikerült. Próbáld újra.' });
    } finally { setBusy(false); }
  };
  const gate = useRef(singleFlight(() => sendRef.current()));

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold">
        A PRO hozzáférést banki átutalással vagy Revoluton keresztül tudod igényelni. A befizetést manuálisan ellenőrizzük, és jóváhagyás után aktiváljuk a hozzáférésedet.
      </p>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-black tracking-tight text-primary">{amount}</span>
        <span className="text-sm font-bold text-text-muted">PRO · {INTERVAL_LABEL[price.interval]} ({price.label})</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-2" aria-labelledby="fizetes-bank">
          <h3 id="fizetes-bank" className="flex items-center gap-2 text-base font-extrabold"><Landmark className="h-4 w-4 text-primary" /> Banki átutalás</h3>
          <CopyField label="Kedvezményezett" value={payee.bank.beneficiary} mono={false} />
          <CopyField label="Számlaszám" value={payee.bank.accountNumber} copyValue={accountNumberDigits(payee.bank.accountNumber)} />
          {reference
            ? <CopyField label="Közlemény (a fiókod e-mail-címe)" value={reference} mono={false} />
            : <div className="rounded-xl border border-border bg-card-2 p-3 text-sm font-semibold"><span className="block text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Közlemény</span>A TippStats-fiókod e-mail-címe – <Link to="/bejelentkezes" state={{ from: '/pro' }} className="text-primary">jelentkezz be</Link>, hogy itt lásd és másolhasd.</div>}
          <CopyField label="Összeg" value={amount} copyValue={String(price.amount)} />
        </section>

        <section className="space-y-2" aria-labelledby="fizetes-revolut">
          <h3 id="fizetes-revolut" className="flex items-center gap-2 text-base font-extrabold"><Smartphone className="h-4 w-4 text-primary" /> Revolut</h3>
          <CopyField label="Revolut-felhasználónév" value={payee.revolut.username} />
          <a className="btn w-full" href={payee.revolut.profileUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-4 w-4" /> Revolut-profil megnyitása
          </a>
          <CopyField label="Összeg" value={amount} copyValue={String(price.amount)} />
          <p className="text-xs font-semibold text-text-muted">A Revolut-utalás megjegyzésébe is a fiókod e-mail-címét írd{reference ? ` (${reference})` : ''}.</p>
        </section>
      </div>

      <Note tone="warn">
        <b>A fizetés manuális ellenőrzést igényel.</b> A PRO hozzáférés nem aktiválódik automatikusan: a befizetés beérkezése és ellenőrzése után kapcsoljuk be.
      </Note>

      <section className="space-y-2" aria-labelledby="fizetes-jelzes">
        <h3 id="fizetes-jelzes" className="text-base font-extrabold">Befizettél? Jelezd nekünk</h3>
        {!loggedIn ? (
          <p className="text-sm font-semibold">A befizetés jelzéséhez <Link to="/bejelentkezes" state={{ from: '/pro' }} className="text-primary">jelentkezz be</Link>.</p>
        ) : stripeManaged ? (
          <Note>Aktív Stripe-előfizetésed van – kézi befizetésre nincs szükség.</Note>
        ) : pending ? (
          <Note>Van ellenőrzésre váró befizetésed ({PAYMENT_METHOD_LABEL[pending.method]}, {formatAmount(pending.amount, pending.currency)}, {fmtDateTime(pending.createdAt)}). Amint ellenőriztük, aktiváljuk a PRO-t.</Note>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Fizetési mód">
              {(['bank_transfer', 'revolut'] as PaymentMethod[]).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} className={`chip ${method === m ? 'chip-active' : ''}`} onClick={() => setMethod(m)} disabled={busy}>
                  {PAYMENT_METHOD_LABEL[m]}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={() => { if (!busy) void gate.current(); }} disabled={busy}>
              <Send className="h-4 w-4" /> {busy ? 'Küldés…' : 'Befizetés elküldve ellenőrzésre'}
            </button>
            <p className="text-xs font-semibold text-text-muted">Csak a befizetés után kattints. A jelzés nem aktiválja a PRO-t – azt az ellenőrzés után mi kapcsoljuk be.</p>
          </div>
        )}
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
      </section>

      {loggedIn && (
        <section className="space-y-2" aria-labelledby="fizetes-allapot">
          <h3 id="fizetes-allapot" className="text-base font-extrabold">Fizetési kérelem állapota</h3>
          <PaymentRequestList requests={requests} />
        </section>
      )}
    </div>
  );
}
