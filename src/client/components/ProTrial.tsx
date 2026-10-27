/**
 * Ingyenes, 3 napos PRO próbaidőszak kártyája – a PRO oldalon és a bejelentkezés utáni
 * nyitóoldalon (Áttekintés) ugyanez a komponens. Az állapotot a SZERVER számolja
 * (GET /api/pro-trial); a felület csak megjeleníti, PRO-t soha nem állít be.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Crown, Gift } from 'lucide-react';
import { PRO_TRIAL_DAYS, TRIAL_TEXT, type ProTrialStatus } from '@shared/proTrial';
import { api } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { singleFlight } from '../lib/learningDashboard';
import { usePlan } from '../auth/PlanContext';
import { Note } from './ui';

interface ViewProps {
  status: ProTrialStatus | null;
  loggedIn: boolean;
  /** a kliens jogosultság-nézete (usePlan) – a „Már PRO tag” szöveghez a szerverállapot mellett */
  pro: boolean;
  busy?: boolean;
  msg?: string | null;
  onRequest?: () => void;
  className?: string;
}

/** Tisztán megjelenítő nézet (tesztelhető). Nincs mit mutatni → null. */
export function ProTrialView({ status, loggedIn, pro, busy = false, msg = null, onRequest, className = '' }: ViewProps) {
  if (!status || status.state === 'unavailable') return null;
  const wrap = (body: ReactNode, tone: 'primary' | 'muted' = 'primary') => (
    <section className={`card p-4 ${tone === 'primary' ? 'border-primary/40' : ''} ${className}`} data-trial-state={status.state} aria-label="Ingyenes PRO próbaidőszak">
      {body}
      {msg && <div className="mt-3"><Note tone="warn">{msg}</Note></div>}
    </section>
  );

  if (status.state === 'active') {
    return wrap(
      <div className="flex items-start gap-3">
        <Crown className="mt-0.5 h-5 w-5 shrink-0 text-secondary" />
        <div>
          <h2 className="text-base font-extrabold tracking-tight">{TRIAL_TEXT.active}</h2>
          {status.trialEnd && <p className="mt-1 text-sm font-semibold text-text-muted">Lejárat: <b className="text-text">{fmtDateTime(status.trialEnd)}</b></p>}
        </div>
      </div>,
    );
  }
  if (status.state === 'pro_member' || pro) {
    return wrap(<p className="flex items-center gap-2 text-sm font-extrabold"><Crown className="h-4 w-4 shrink-0 text-secondary" /> {TRIAL_TEXT.proMember}</p>, 'muted');
  }
  if (status.state === 'pending') return wrap(<p className="text-sm font-semibold">{TRIAL_TEXT.pending}</p>, 'muted');
  if (status.state === 'rejected') return wrap(<p className="text-sm font-semibold">{TRIAL_TEXT.rejected}</p>, 'muted');
  // lejárt próbaidőszak: újra nem igényelhető, és nincs mit mondani róla
  if (status.state === 'used') return null;

  return wrap(
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <Gift className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 className="text-base font-extrabold tracking-tight">{TRIAL_TEXT.title}</h2>
          <p className="mt-1 text-sm font-semibold text-text-muted">{TRIAL_TEXT.description}</p>
        </div>
      </div>
      {loggedIn
        ? <button type="button" className="btn btn-primary" onClick={onRequest} disabled={busy}>{busy ? 'Küldés…' : TRIAL_TEXT.button}</button>
        : <Link to="/bejelentkezes" className="btn btn-primary">{TRIAL_TEXT.button}</Link>}
    </div>,
  );
}

/** Adatkezelő változat: lekéri az állapotot, és elküldi az igénylést (dupla kattintás ellen egyszerre egyet). */
export function ProTrialCard({ className = '' }: { className?: string }) {
  const { configured, loggedIn, pro, profile, loading } = usePlan();
  const status = useAsync(() => api.proTrial(), [loggedIn, pro]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const send = useRef(singleFlight(async () => {
    setBusy(true); setMsg(null);
    try { await api.requestProTrial(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); status.reload(); }
  }));

  if (loading) return null;
  // Amíg a szerver válasza úton van: a 3 napnál tovább érvényes (vagy lejárat nélküli) PRO biztosan
  // nem próbaidőszak → a köszönet azonnal látszik. Minden más esetben a szerverállapotra várunk.
  const surelyPaid = configured && loggedIn && pro && (!profile?.subscription_end
    || new Date(profile.subscription_end).getTime() > Date.now() + PRO_TRIAL_DAYS * 86_400_000);
  const shown = status.data ?? (surelyPaid ? { state: 'pro_member' as const, requestedAt: null, trialEnd: null } : null);
  return <ProTrialView status={shown} loggedIn={loggedIn} pro={pro} busy={busy} msg={msg} onRequest={() => { if (!busy) void send.current(); }} className={className} />;
}
