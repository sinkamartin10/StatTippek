/**
 * Napi és heti küldetések kártya.
 *
 * A haladást, a teljesítést és a jutalmat a SZERVER adja – a kliens csak megjelenít,
 * és az „átvétel" gombbal kérést indít. FREE felhasználónál a küldetés teljesíthető,
 * de XP nem jár érte (ezt a kártya egyértelműen jelzi).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown } from 'lucide-react';
import type { MissionPeriodView, MissionView } from '@shared/missions';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { Card, ErrorBox, Loading, Note } from './ui';

/** Hátralévő idő a periódus végéig, rövid alakban. */
function remaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'hamarosan új';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} nap ${h} óra`;
  if (h > 0) return `${h} óra ${m} perc`;
  return `${m} perc`;
}

export function MissionsCard() {
  const data = useAsync(() => api.missions(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const claim = async (m: MissionView) => {
    setBusy(m.key); setMsg(null);
    try {
      const r = await api.claimMission(m.key);
      setMsg(r.alreadyClaimed
        ? { tone: 'warn', text: 'Ezt a jutalmat már átvetted ebben az időszakban.' }
        : { tone: 'info', text: r.xpAwarded > 0 ? `Jutalom átvéve: +${r.xpAwarded} XP` : 'Küldetés teljesítve!' });
      data.reload();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(null); }
  };

  if (data.loading) return <Card title="🎯 Küldetések"><Loading text="Küldetések betöltése…" /></Card>;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!data.data) return null;

  return (
    <Card
      title="🎯 Küldetések"
      right={<span className="text-xs font-bold text-text-muted">{data.data.daily.completed}/{data.data.daily.total} ma · {data.data.weekly.completed}/{data.data.weekly.total} a héten</span>}
    >
      {!data.data.pro && (
        <div className="mb-4">
          <Note>
            A küldetéseket FREE csomagban is teljesítheted, de <b>XP csak PRO előfizetéssel jár</b> értük.
            <Link to="/pro" className="btn btn-sm btn-primary ml-2 mt-2 sm:mt-0"><Crown className="h-3.5 w-3.5" /> PRO megtekintése</Link>
          </Note>
        </div>
      )}

      <div className="space-y-5">
        <PeriodBlock title="Mai küldetések" view={data.data.daily} onClaim={claim} busy={busy} />
        <PeriodBlock title="Heti küldetések" view={data.data.weekly} onClaim={claim} busy={busy} />
      </div>

      {msg && <div className="mt-4"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </Card>
  );
}

function PeriodBlock({ title, view, onClaim, busy }: {
  title: string;
  view: MissionPeriodView;
  onClaim: (m: MissionView) => void;
  busy: string | null;
}) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-extrabold">{title}</h3>
        <span className="text-xs font-semibold text-text-muted">Megújul: {remaining(view.resetsAt)}</span>
      </div>
      <ul className="space-y-2">
        {view.missions.map((m) => <MissionRow key={m.key} m={m} onClaim={onClaim} busy={busy} />)}
      </ul>
    </section>
  );
}

function MissionRow({ m, onClaim, busy }: { m: MissionView; onClaim: (m: MissionView) => void; busy: string | null }) {
  const ratio = m.target ? Math.min(1, m.progress / m.target) : 0;
  return (
    <li className={`rounded-xl border p-3 ${m.claimed ? 'border-border bg-card-2 opacity-75' : m.completed ? 'border-success/30 bg-success-soft' : 'border-border bg-card-2'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="text-lg">{m.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-extrabold">{m.name}</div>
          <div className="truncate text-xs font-semibold text-text-muted">{m.description}</div>
        </div>
        <span className="mono shrink-0 text-sm font-extrabold">{m.progress} / {m.target}</span>
        {m.claimed ? (
          <span className="badge badge-muted shrink-0">Átvéve{m.xpAwarded ? ` · +${m.xpAwarded} XP` : ''}</span>
        ) : m.completed ? (
          <button className="btn btn-sm btn-primary shrink-0" onClick={() => onClaim(m)} disabled={busy === m.key}>
            {busy === m.key ? 'Átvétel…' : m.xpReward > 0 ? `Átvétel · +${m.xpReward} XP` : 'Átvétel'}
          </button>
        ) : (
          <span className="badge badge-muted shrink-0">{m.xpReward > 0 ? `+${m.xpReward} XP` : 'Folyamatban'}</span>
        )}
      </div>
      {!m.claimed && (
        <div className="meter mt-2">
          <div className={`meter-fill ${m.completed ? 'bg-success' : 'bg-primary'}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
    </li>
  );
}
