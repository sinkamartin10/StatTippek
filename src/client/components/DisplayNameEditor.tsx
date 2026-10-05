/**
 * Megjelenítési név szerkesztő – a Profil oldal és a Tippverseny is ezt használja.
 * A kliensoldali ellenőrzés CSAK azonnali visszajelzés; a mentést a szerver újra ellenőrzi
 * (hossz, karakterek, tiltólista, egyediség), és az övé a végső szó.
 */
import { useState, type FormEvent } from 'react';
import { Check, UserCircle2 } from 'lucide-react';
import { DISPLAY_NAME_MAX, DISPLAY_NAME_RULES, validateDisplayName } from '@shared/displayName';
import { api } from '../lib/api';
import { Note } from './ui';

export function DisplayNameEditor({ current, onSaved, compact }: {
  current: string | null;
  onSaved: (name: string) => void;
  compact?: boolean;
}) {
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local = validateDisplayName(value);
    if (!local.ok) { setMsg({ tone: 'warn', text: local.message! }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api.saveDisplayName(value);
      setValue(r.displayName);
      setMsg({ tone: 'info', text: 'A megjelenítési név elmentve.' });
      onSaved(r.displayName);
    } catch (err) {
      setMsg({ tone: 'warn', text: (err as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="field-label">Megjelenítési név
        <div className="mt-1.5 flex flex-wrap gap-2">
          <input
            className="input flex-1"
            value={value}
            maxLength={DISPLAY_NAME_MAX}
            placeholder="pl. Martin23"
            onChange={(e) => { setValue(e.target.value); setMsg(null); }}
            aria-describedby="display-name-rules"
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
            {busy ? 'Mentés…' : current ? 'Módosítás' : 'Mentés'}
          </button>
        </div>
      </label>

      {!compact && (
        <p id="display-name-rules" className="flex items-start gap-2 text-xs font-semibold text-text-muted">
          <UserCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Ezt a nevet látják a többiek a <b>Tippverseny ranglistáján</b>. Az e-mail-címed sosem jelenik meg.
            <span className="mt-1 block">Szabályok: {DISPLAY_NAME_RULES.join(' · ')}.</span>
          </span>
        </p>
      )}

      {current && !msg && (
        <p className="flex items-center gap-1.5 text-xs font-bold text-success"><Check className="h-3.5 w-3.5" /> Jelenlegi név: {current}</p>
      )}
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
    </form>
  );
}
