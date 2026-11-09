/**
 * Marketing-hozzájárulás a profilban – jól látható kártya, egy kattintással fel- és leiratkozás.
 * Alapból KI: a hozzájárulást a felhasználó maga adja meg (a szerver a megadás idejét, forrását és a szöveg
 * verzióját naplózza), és bármikor visszavonhatja. A szolgáltatási (rendszer-) üzenetekre nincs hatása.
 */
import { useState } from 'react';
import { BellOff, Mail, MailCheck } from 'lucide-react';
import type { MarketingConsentView } from '@shared/email';
import { api } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { ErrorBox, Loading, Note } from './ui';

/** tisztán megjelenítő nézet (tesztelhető) */
export function MarketingConsentView({ consent, text, busy = false, msg = null, onToggle }: {
  consent: MarketingConsentView; text: string; busy?: boolean; msg?: { tone: 'info' | 'warn'; text: string } | null; onToggle?: (next: boolean) => void;
}) {
  const on = consent.consented;
  return (
    <section className={`card p-5 ${on ? '' : 'border-primary/40 bg-primary-soft/40'}`} aria-label="Marketing emailek" data-consented={on}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {on ? <MailCheck className="mt-0.5 h-6 w-6 shrink-0 text-success" /> : <Mail className="mt-0.5 h-6 w-6 shrink-0 text-primary" />}
          <div className="min-w-0">
            <h2 className="text-base font-extrabold tracking-tight">{on ? 'Feliratkoztál a TippStats emailekre' : 'Iratkozz fel a TippStats emailekre!'}</h2>
            <p className="mt-1 text-sm font-semibold text-text-muted">{text}</p>
            <p className="mt-1 text-xs font-semibold text-text-muted">
              {on && consent.consentedAt ? `Feliratkozva: ${fmtDateTime(consent.consentedAt)}. ` : ''}
              A fiókoddal kapcsolatos szolgáltatási és biztonsági üzeneteket ettől függetlenül megkapod.
            </p>
          </div>
        </div>
        {on
          ? <button type="button" className="btn" disabled={busy} onClick={() => onToggle?.(false)}><BellOff className="h-4 w-4" /> {busy ? 'Mentés…' : 'Leiratkozás'}</button>
          : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onToggle?.(true)}><Mail className="h-4 w-4" /> {busy ? 'Mentés…' : 'Feliratkozás'}</button>}
      </div>
      {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </section>
  );
}

export function MarketingConsentCard() {
  const consent = useAsync(() => api.emailConsent(), []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      await api.setEmailConsent(next);
      setMsg({ tone: 'info', text: next ? 'Feliratkoztál a marketing emailekre.' : 'Leiratkoztál a marketing emailekről – azonnal érvényes.' });
      consent.reload();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (consent.loading && !consent.data) return <section className="card p-5"><Loading /></section>;
  if (consent.error || !consent.data) return <ErrorBox message={consent.error ?? 'Az email-beállítás nem tölthető be.'} onRetry={consent.reload} />;
  return <MarketingConsentView consent={consent.data} text={consent.data.text} busy={busy} msg={msg} onToggle={(n) => void toggle(n)} />;
}
