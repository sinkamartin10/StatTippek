/**
 * Tippverseny részletek: mérkőzések tippelő mezőkkel, ranglista, szabályok.
 * A zárolást (locked) a SZERVER adja meg – itt csak megjelenítjük; a beküldést a backend újra ellenőrzi.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Lock, Trophy } from 'lucide-react';
import type { CompetitionMatchView } from '@shared/competition';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { usePlan } from '../auth/PlanContext';
import { ParticipationBox, useParticipation } from '../components/Participation';
import { CompetitionStatusBadge, remainingText } from './Competitions';

export default function CompetitionDetail() {
  const { id = '' } = useParams();
  const detail = useAsync(() => api.competition(id), [id]);
  const matches = useAsync(() => api.competitionMatches(id), [id]);
  const board = useAsync(() => api.competitionLeaderboard(id), [id]);
  const { loggedIn, configured } = usePlan();
  const participation = useParticipation();
  const canPlay = participation.canPlay;
  const me = useAsync(() => (loggedIn || !configured ? api.competitionMyStats(id) : Promise.resolve(null)), [id, loggedIn, configured]);

  const reload = () => { matches.reload(); board.reload(); me.reload(); participation.reload(); };

  if (detail.loading) return <Loading text="Verseny betöltése…" />;
  if (detail.error) return <ErrorBox message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <EmptyState emoji="🏁" title="A tippverseny nem található" />;

  const c = detail.data.competition;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🏆"
        title={c.name}
        text={`${c.leagueName} · ${fmtDateTime(c.startsAt)} – ${fmtDateTime(c.endsAt)}`}
        right={<div className="flex items-center gap-2"><CompetitionStatusBadge status={c.status} /><Link to="/tippverseny" className="btn btn-sm">Összes verseny</Link></div>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="⏳" tone="primary" label={c.status === 'finished' ? 'Verseny' : 'Hátralévő idő'} value={c.status === 'finished' ? 'Lezárva' : remainingText(c.endsAt)} sub={c.status === 'active' ? 'a tippelési időszak vége' : 'kezdés: ' + fmtDateTime(c.startsAt)} />
        <StatCard icon="⚽" tone="neutral" label="Mérkőzés" value={matches.data?.length ?? '…'} sub="a versenyben" />
        <StatCard icon="🎯" tone="success" label="Saját pont" value={me.data?.points ?? '–'} sub={me.data ? `${me.data.predictions} tipp · ${me.data.exactHits} pontos találat` : 'bejelentkezés után'} />
        <StatCard icon="📊" tone="warning" label="Helyezés" value={me.data?.rank != null ? `${me.data.rank}.` : '–'} sub={me.data ? `${me.data.participants} résztvevő` : ''} />
      </div>

      <ParticipationBox p={participation} />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Mérkőzések */}
        <section className="space-y-3">
          <h2 className="section-title mb-0">Mérkőzések</h2>
          {matches.loading ? <Card><Loading /></Card>
            : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} />
              : !matches.data?.length ? <EmptyState emoji="⚽" title="Még nincsenek mérkőzések" text="Az adminisztrátor hamarosan szinkronizálja a verseny mérkőzéseit." />
                : matches.data.map((m) => <MatchRow key={m.id} competitionId={id} m={m} canPlay={canPlay} onSaved={reload} />)}
        </section>

        {/* Ranglista és szabályok */}
        <div className="space-y-4">
          <Card title="Ranglista">
            {board.loading ? <Loading /> : board.error ? <ErrorBox message={board.error} onRetry={board.reload} />
              : !board.data?.length ? <p className="text-sm font-semibold text-text-muted">Még senki nem adott le tippet.</p> : (
                <ol className="divide-y divide-border">
                  {board.data.map((row) => (
                    <li key={row.rank} className={`flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 ${row.isMe ? 'font-extrabold' : ''}`}>
                      <span className="mono w-7 shrink-0 text-sm font-extrabold text-text-muted">{row.rank}.</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-bold">
                        {row.displayName}{row.isMe && <span className="badge badge-blue ml-2">te</span>}
                      </span>
                      <span className="mono shrink-0 text-right text-sm font-extrabold">{row.points} pont</span>
                    </li>
                  ))}
                </ol>
              )}
            <p className="mt-3 text-[11px] font-semibold text-text-muted">A ranglistán azonosításra alkalmas adat (pl. e-mail) nem jelenik meg.</p>
          </Card>

          <Card title="Pontozás">
            <ul className="space-y-2">
              {detail.data.scoring.map((s) => (
                <li key={s.label} className="flex items-start gap-2 text-sm font-semibold">
                  <span className="badge badge-blue shrink-0">{s.points} pont</span>
                  <span className="min-w-0"><b>{s.label}</b><span className="block text-xs font-semibold text-text-muted">{s.text}</span></span>
                </li>
              ))}
            </ul>
            <div className="mt-4 text-xs font-semibold text-text-muted">
              <b className="text-text">Holtverseny esetén</b> a sorrendet ez dönti el:
              <ol className="mt-1 list-decimal pl-4">{detail.data.tieBreak.map((t) => <li key={t}>{t}</li>)}</ol>
            </div>
          </Card>

          <Card title="Jutalmak">
            <ul className="space-y-1.5 text-sm font-semibold">
              <li className="flex items-center gap-2"><Trophy className="h-4 w-4 text-warning" /> 1. helyezett: 1 hónap PRO</li>
              <li className="flex items-center gap-2"><Trophy className="h-4 w-4 text-text-muted" /> 2. helyezett: 2 hét PRO</li>
              <li className="flex items-center gap-2"><Trophy className="h-4 w-4 text-[#b06a2c]" /> 3. helyezett: 1 hét PRO</li>
            </ul>
            <p className="mt-3 text-xs font-semibold text-text-muted">A jutalmat a verseny lezárása után az adminisztrátor adja át.</p>
          </Card>
        </div>
      </div>

      <Disclaimer />
    </div>
  );
}

/** Egy mérkőzés sora: eredmény, saját tipp, tippelő mezők vagy zárolás. */
function MatchRow({ competitionId, m, canPlay, onSaved }: { competitionId: string; m: CompetitionMatchView; canPlay: boolean; onSaved: () => void }) {
  const [home, setHome] = useState(String(m.myPrediction?.predictedHomeScore ?? ''));
  const [away, setAway] = useState(String(m.myPrediction?.predictedAwayScore ?? ''));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [editing, setEditing] = useState(!m.myPrediction);

  const save = async () => {
    const h = parseInt(home, 10), a = parseInt(away, 10);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) { setMsg({ tone: 'warn', text: 'Adj meg mindkét csapatnak egy 0 vagy annál nagyobb egész számot.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api.submitCompetitionPrediction(competitionId, m.id, h, a);
      setMsg({ tone: 'info', text: 'Tipp elmentve.' });
      setEditing(false);
      onSaved();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const hasResult = m.homeScore != null && m.awayScore != null;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-text-muted">
        <span>{fmtDateTime(m.kickoff).slice(0, 13)} {fmtTime(m.kickoff)}</span>
        {hasResult
          ? <span className="badge badge-blue">Eredmény: {m.homeScore}–{m.awayScore}</span>
          : m.locked ? <span className="badge badge-muted"><Lock className="h-3 w-3" /> Tippelés lezárva</span>
            : <span className="badge badge-green">Tippelhető</span>}
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="truncate text-right text-base font-extrabold">{m.homeTeam}</div>
        <div className="text-xs font-extrabold uppercase tracking-widest text-text-muted">vs</div>
        <div className="truncate text-base font-extrabold">{m.awayTeam}</div>
      </div>

      {/* Saját tipp / tippelő mezők */}
      <div className="mt-3 border-t border-border pt-3">
        {canPlay && !m.locked && editing ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <input className="input !w-16 text-center" inputMode="numeric" value={home} onChange={(e) => setHome(e.target.value.replace(/\D/g, '').slice(0, 2))} aria-label={`${m.homeTeam} tippelt gólszáma`} />
            <span className="font-extrabold text-text-muted">–</span>
            <input className="input !w-16 text-center" inputMode="numeric" value={away} onChange={(e) => setAway(e.target.value.replace(/\D/g, '').slice(0, 2))} aria-label={`${m.awayTeam} tippelt gólszáma`} />
            <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Mentés…' : m.myPrediction ? 'Tipp módosítása' : 'Tipp leadása'}</button>
            {m.myPrediction && <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Mégse</button>}
          </div>
        ) : m.myPrediction ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold">
              Saját tipped: <span className="mono text-base font-extrabold">{m.myPrediction.predictedHomeScore}–{m.myPrediction.predictedAwayScore}</span>
            </span>
            <span className="flex items-center gap-2">
              {m.myPrediction.points != null && <span className="badge badge-green">{m.myPrediction.points} pont</span>}
              {canPlay && !m.locked && <button className="btn btn-sm" onClick={() => setEditing(true)}>Módosítás</button>}
            </span>
          </div>
        ) : (
          <p className="text-center text-sm font-semibold text-text-muted">
            {m.locked ? (m.lockReason ?? 'Erre a mérkőzésre már nem lehet tippelni.') : canPlay ? 'Még nem tippeltél erre a mérkőzésre.' : 'Ez a funkció PRO előfizetők számára érhető el.'}
          </p>
        )}
        {msg && <div className="mt-2"><Note tone={msg.tone}>{msg.text}</Note></div>}
      </div>
    </div>
  );
}
