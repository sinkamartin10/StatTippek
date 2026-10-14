/**
 * Admin: nyilvános PRO-felhasználószám.
 *
 * A nyilvános oldalakon megjelenő szám MINDIG a ténylegesen aktív PRO-előfizetők
 * száma – kézzel nem írható át. Az admin csak azt dönti el, hogy a szám
 * megjelenjen-e a nyitóoldalon és a főoldalon. Az admin jogot a szerver
 * dönti el (ADMIN_EMAILS); nem admin fiók 403-at kap.
 */
import { useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { formatProUsers, type AdminProStats as Stats } from '@shared/proStats';
import { api } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { singleFlight } from '../lib/learningDashboard';
import { Card, ErrorBox, Loading, Note, PageHeader } from '../components/ui';

export default function AdminProStats() {
  const stats = useAsync(() => api.adminProStats(), []);
  const [saved, setSaved] = useState<Stats | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const toggleRef = useRef<(show: boolean) => Promise<void>>(async () => {});
  toggleRef.current = async (show) => {
    setBusy(true); setMsg(null);
    try {
      const out = await api.adminSetProStatsVisibility(show);
      setSaved(out); // a szerver által visszaolvasott, mentett állapot
      setMsg({ tone: 'info', text: out.showPublic ? 'Mentve: a szám megjelenik a nyitóoldalon és a főoldalon.' : 'Mentve: a szám el van rejtve a nyilvános oldalakon.' });
    } catch (e) {
      setMsg({ tone: 'warn', text: `A beállítás nem mentődött: ${(e as Error).message}` });
    } finally { setBusy(false); }
  };
  const showGate = useRef(singleFlight(() => toggleRef.current(true)));
  const hideGate = useRef(singleFlight(() => toggleRef.current(false)));

  const d = saved ?? stats.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader emoji="👑" title="PRO-statisztika" text="A nyitóoldalon és a főoldalon megjelenő „X PRO-felhasználó” jelvény." />
      {stats.loading && !d ? <Card><Loading /></Card>
        : stats.error && !d ? <ErrorBox message={stats.error} onRetry={stats.reload} />
          : d && <AdminProStatsView d={d} busy={busy} onShow={() => { if (!busy) void showGate.current(); }} onHide={() => { if (!busy) void hideGate.current(); }} />}
      {msg && <Note tone={msg.tone}>{msg.text}</Note>}
    </div>
  );
}

/** Tiszta megjelenítés (tesztelhető). */
export function AdminProStatsView({ d, busy, onShow, onHide }: { d: Stats; busy: boolean; onShow: () => void; onHide: () => void }) {
  const visible = d.showPublic && d.activeProCount != null && d.activeProCount > 0;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card-2 p-3">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Ténylegesen aktív PRO</div>
          <div className="mt-1 text-2xl font-black">{d.activeProCount ?? '–'}</div>
        </div>
        <div className="rounded-xl border border-border bg-card-2 p-3">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Nyilvánosan</div>
          <div className="mt-1 text-sm font-extrabold">
            {visible ? formatProUsers(d.activeProCount!)
              : !d.showPublic ? 'Rejtve'
                : d.activeProCount == null ? 'Rejtve (a szám nem számolható – nincs adatbázis)' : 'Rejtve (0 aktív PRO)'}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card-2 p-3">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Utolsó módosítás</div>
          <div className="mt-1 text-sm font-extrabold">{d.updatedAt ? fmtDateTime(d.updatedAt) : 'még nem módosították (alapértelmezés)'}</div>
        </div>
      </div>

      <Card title="Megjelenítés a nyilvános oldalakon">
        <p className="text-sm font-semibold">
          A nyilvános szám <b>mindig a ténylegesen aktív PRO-előfizetők száma</b>, kézzel nem írható át – így a kiírt érték nem lehet félrevezető.
          Itt csak azt döntheted el, hogy megjelenjen-e.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={`btn ${d.showPublic ? 'btn-primary' : ''}`} onClick={onShow} disabled={busy || d.showPublic} aria-pressed={d.showPublic}>
            <Eye className="h-4 w-4" /> Megjelenítés
          </button>
          <button type="button" className={`btn ${!d.showPublic ? 'btn-primary' : ''}`} onClick={onHide} disabled={busy || !d.showPublic} aria-pressed={!d.showPublic}>
            <EyeOff className="h-4 w-4" /> Elrejtés
          </button>
        </div>
        <p className="mt-3 text-xs font-semibold text-text-muted">Számítás: {d.definition}. A nyilvános oldalak legfeljebb 1 perc késéssel követik a változást.</p>
      </Card>
    </>
  );
}
