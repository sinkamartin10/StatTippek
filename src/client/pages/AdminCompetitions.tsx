/**
 * Tippverseny – adminisztráció.
 * A felületi védelem CSAK kényelmi: a valódi jogosultság-ellenőrzés a szerveren történik
 * (ADMIN_EMAILS alapján), és minden admin végpont 401/403-mal válaszol jogosulatlan hívásra.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  COMPETITION_STATUS_LABEL, REWARD_STATUS_LABEL, isImmutable,
  type Competition, type CompetitionReward, type RewardStatus,
} from '@shared/competition';
import { api, ApiError } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { CompetitionStatusBadge } from './Competitions';

const REWARD_STATUSES: RewardStatus[] = ['pending', 'granted', 'used', 'cancelled'];

/** Helyi idő „YYYY-MM-DDTHH:mm” alakban (datetime-local mezőhöz). */
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function AdminCompetitions() {
  const list = useAsync(() => api.adminCompetitions(), []);
  const leagues = useAsync(() => api.adminCompetitionLeagues().catch(() => []), []);
  const [selected, setSelected] = useState<string | null>(null);

  if (list.loading) return <Loading text="Jogosultság ellenőrzése…" />;
  if (list.error) {
    const forbidden = /jogosultság|Bejelentkezés/i.test(list.error);
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <PageHeader emoji="🔒" title="Tippverseny – admin" />
        <ErrorBox message={list.error} onRetry={list.reload} />
        {forbidden && <Note tone="warn">Ehhez az oldalhoz adminisztrátori fiók szükséges. Az adminisztrátorokat a szerver <code>ADMIN_EMAILS</code> beállítása határozza meg.</Note>}
        <Link to="/tippverseny" className="btn">Vissza a tippversenyekhez</Link>
      </div>
    );
  }

  const competitions = list.data ?? [];
  const active = competitions.filter((c) => !isImmutable(c.status));
  const closed = competitions.filter((c) => isImmutable(c.status));

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🛠️"
        title="Tippverseny – admin"
        text="Versenyek létrehozása, aktiválása, meccsek szinkronizálása, lezárás és jutalmak kezelése."
        right={<Link to="/tippverseny" className="btn btn-sm">Nyilvános nézet</Link>}
      />

      <CreateForm leagues={leagues.data ?? []} onCreated={list.reload} />

      <section className="space-y-3">
        <h2 className="section-title mb-0">Folyamatban ({active.length})</h2>
        {!active.length ? <EmptyState emoji="🗂️" title="Nincs folyamatban lévő verseny" text="Hozz létre egyet a fenti űrlappal." />
          : active.map((c) => <CompetitionAdminCard key={c.id} c={c} open={selected === c.id} onToggle={() => setSelected(selected === c.id ? null : c.id)} onChanged={list.reload} />)}
      </section>

      {closed.length > 0 && (
        <section className="space-y-3">
          <h2 className="section-title mb-0">Lezárt és érvénytelenített ({closed.length})</h2>
          {closed.map((c) => <CompetitionAdminCard key={c.id} c={c} open={selected === c.id} onToggle={() => setSelected(selected === c.id ? null : c.id)} onChanged={list.reload} />)}
        </section>
      )}

      <Note>A jutalom csak nyilvántartás: a rendszer nem módosít előfizetést és nem ad automatikusan PRO hozzáférést – azt kézzel kell odaadni.</Note>
      <Disclaimer />
    </div>
  );
}

function CreateForm({ leagues, onCreated }: { leagues: { leagueKey: string; leagueName: string; country: string }[]; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [leagueKey, setLeagueKey] = useState('');
  const [startsAt, setStartsAt] = useState(localInput(new Date()));
  const [endsAt, setEndsAt] = useState(localInput(new Date(Date.now() + 14 * 86400000)));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.adminCreateCompetition({
        name,
        leagueKey,
        // A helyi időt UTC-re váltva küldjük; az adatbázisban UTC időbélyeg van
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
      });
      setMsg({ tone: 'info', text: 'A verseny létrejött piszkozatként. Aktiváld, majd szinkronizáld a meccseket.' });
      setName('');
      onCreated();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  return (
    <Card title="Új tippverseny">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="field-label md:col-span-2">Név
          <input className="input mt-1.5" placeholder="pl. Premier League Tippverseny" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field-label">Liga
          <select className="input mt-1.5" value={leagueKey} onChange={(e) => setLeagueKey(e.target.value)}>
            <option value="">Válassz ligát…</option>
            {leagues.map((l) => <option key={l.leagueKey} value={l.leagueKey}>{l.leagueName} ({l.country})</option>)}
          </select>
        </label>
        <label className="field-label">Kezdés
          <input type="datetime-local" className="input mt-1.5" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </label>
        <label className="field-label">Befejezés
          <input type="datetime-local" className="input mt-1.5" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" onClick={submit} disabled={busy || !name.trim() || !leagueKey}>{busy ? 'Létrehozás…' : 'Verseny létrehozása'}</button>
        <span className="text-xs font-semibold text-text-muted">Csak a szolgáltatóból ténylegesen elérhető ligák választhatók.</span>
      </div>
      {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </Card>
  );
}

function CompetitionAdminCard({ c, open, onToggle, onChanged }: { c: Competition; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const board = useAsync(() => (open ? api.adminCompetitionLeaderboard(c.id) : Promise.resolve([])), [open, c.id]);
  const rewards = useAsync(() => (open ? api.adminCompetitionRewards(c.id) : Promise.resolve([])), [open, c.id]);
  const detail = useAsync(() => (open ? api.adminCompetition(c.id) : Promise.resolve(null)), [open, c.id]);

  const run = async (fn: () => Promise<unknown>, okText: (r: any) => string) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: 'info', text: okText(r) });
      onChanged(); board.reload(); rewards.reload(); detail.reload();
    } catch (e) {
      setMsg({ tone: 'warn', text: e instanceof ApiError ? e.message : (e as Error).message });
    } finally { setBusy(false); }
  };

  const locked = isImmutable(c.status);

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-extrabold tracking-tight">{c.name}</h3>
            <CompetitionStatusBadge status={c.status} />
          </div>
          <p className="mt-1 text-xs font-semibold text-text-muted">
            {c.leagueName} · {c.provider} · {fmtDateTime(c.startsAt)} – {fmtDateTime(c.endsAt)}
          </p>
        </div>
        <button className="btn btn-sm" onClick={onToggle}>{open ? 'Bezárás' : 'Részletek'}</button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button className="btn btn-sm" disabled={busy || locked || c.status === 'active'} onClick={() => run(() => api.adminCompetitionAction(c.id, 'activate'), () => 'A verseny aktív – a felhasználók tippelhetnek.')}>Aktiválás</button>
        <button className="btn btn-sm" disabled={busy || locked || c.status === 'active'} onClick={() => run(() => api.adminCompetitionAction(c.id, 'schedule'), () => 'A verseny ütemezve.')}>Ütemezés</button>
        <button className="btn btn-sm" disabled={busy || locked} onClick={() => run(() => api.adminCompetitionSync(c.id), (r) => `Szinkronizálva: ${r.inserted} új, ${r.updated} frissített meccs (összesen ${r.total}).`)}>
          <RefreshCw className="h-3.5 w-3.5" /> Meccsek szinkronizálása
        </button>
        <button className="btn btn-sm btn-primary" disabled={busy || c.status === 'finished' || c.status === 'cancelled'} onClick={() => run(() => api.adminCompetitionFinish(c.id), (r) => `Lezárva. Új jutalom: ${r.createdRewards}.${r.warnings.length ? ' ' + r.warnings.join(' ') : ''}`)}>Lezárás</button>
        <button className="btn btn-sm" disabled={busy || locked} onClick={() => run(() => api.adminCompetitionAction(c.id, 'cancel'), () => 'A verseny érvénytelenítve (az adatok megmaradnak).')}>Érvénytelenítés</button>
      </div>
      {locked && <p className="mt-2 text-xs font-semibold text-text-muted">A „{COMPETITION_STATUS_LABEL[c.status]}” állapotú verseny már nem módosítható.</p>}
      {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}

      {open && (
        <div className="mt-5 space-y-4 border-t border-border pt-4">
          <div>
            <h4 className="mb-2 text-sm font-extrabold">Mérkőzések ({detail.data?.matches.length ?? 0})</h4>
            {detail.loading ? <Loading /> : !detail.data?.matches.length ? <p className="text-sm font-semibold text-text-muted">Még nincs szinkronizált mérkőzés.</p> : (
              <ul className="divide-y divide-border text-sm">
                {detail.data.matches.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 truncate font-bold">{m.homeTeam} – {m.awayTeam}</span>
                    <span className="mono text-xs font-semibold text-text-muted">{fmtDateTime(m.kickoff)}</span>
                    <span className="mono w-14 text-center font-extrabold">{m.homeScore != null ? `${m.homeScore}–${m.awayScore}` : '–'}</span>
                    <span className="badge badge-muted">{m.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-sm font-extrabold">Ranglista</h4>
            {board.loading ? <Loading /> : !board.data?.length ? <p className="text-sm font-semibold text-text-muted">Még nincs leadott tipp.</p> : (
              <ol className="divide-y divide-border text-sm">
                {board.data.slice(0, 20).map((row) => (
                  <li key={row.userId} className="flex items-center gap-3 py-2">
                    <span className="mono w-7 font-extrabold text-text-muted">{row.rank}.</span>
                    <span className="min-w-0 flex-1 truncate font-bold">{row.displayName}</span>
                    <span className="text-xs font-semibold text-text-muted">{row.predictions} tipp · {row.exactHits} pontos</span>
                    <span className="mono font-extrabold">{row.points} pont</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-sm font-extrabold">Jutalmak</h4>
            {rewards.loading ? <Loading /> : !rewards.data?.length ? <p className="text-sm font-semibold text-text-muted">Jutalom a verseny lezárásakor keletkezik.</p> : (
              <ul className="space-y-2">
                {rewards.data.map((r) => <RewardRow key={r.id} competitionId={c.id} r={r} onChanged={rewards.reload} />)}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RewardRow({ competitionId, r, onChanged }: { competitionId: string; r: CompetitionReward; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const medal = r.placement === 1 ? '🥇' : r.placement === 2 ? '🥈' : '🥉';

  const setStatus = async (status: RewardStatus) => {
    setBusy(true);
    try { await api.adminSetRewardStatus(competitionId, r.id, status); onChanged(); } finally { setBusy(false); }
  };

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card-2 p-3">
      <span aria-hidden className="text-lg">{medal}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-extrabold">{r.displayName}</span>
        <span className="block text-xs font-semibold text-text-muted">{r.rewardLabel} – manuálisan kiosztandó</span>
      </span>
      <select className="input !w-auto !py-1.5 text-xs" value={r.status} disabled={busy} onChange={(e) => setStatus(e.target.value as RewardStatus)} aria-label="Jutalom státusza">
        {REWARD_STATUSES.map((s) => <option key={s} value={s}>{REWARD_STATUS_LABEL[s]}</option>)}
      </select>
    </li>
  );
}
