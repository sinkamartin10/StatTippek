/**
 * Statisztikáim – a felhasználó SAJÁT tipster teljesítménye.
 *
 * Minden érték a szervertől jön (`/api/progression/stats` és `/history`); a kliens
 * csak megjelenít. A lap a meglévő Tippverseny-tippekből dolgozik, új adat nincs.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Crown } from 'lucide-react';
import { PREDICTION_STATUS_LABEL, type HistoryEntry, type PredictionStatus } from '@shared/progression';
import { api } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { usePlan } from '../auth/PlanContext';

const pct = (v: number | null, digits = 1) => (v == null ? '–' : `${(v * 100).toFixed(digits).replace('.', ',')}%`);
const nf = (n: number) => n.toLocaleString('hu-HU');

const STATUS_STYLE: Record<PredictionStatus, { icon: string; cls: string }> = {
  exact: { icon: '🎯', cls: 'badge-green' },
  correct: { icon: '✓', cls: 'badge-blue' },
  wrong: { icon: '✕', cls: 'badge-red' },
  pending: { icon: '●', cls: 'badge-yellow' },
};

export default function MyStats() {
  const [limit, setLimit] = useState(20);
  const stats = useAsync(() => api.progressionStats(), []);
  const history = useAsync(() => api.progressionHistory(limit), [limit]);
  const { pro } = usePlan();

  if (stats.loading) return <Loading text="Statisztikák betöltése…" />;
  if (stats.error) return <ErrorBox message={stats.error} onRetry={stats.reload} />;
  if (!stats.data) return null;
  const s = stats.data;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="📊"
        title="Statisztikáim"
        text="A Tippversenyben leadott saját tippjeid teljesítménye. Minden érték a tényleges eredményekből számolódik."
        right={<Link to="/profil" className="btn btn-sm">Tipster profil</Link>}
      />

      {s.totalPredictions === 0 ? (
        <EmptyState
          emoji="📭"
          title="Még nincs leadott tipped"
          text="A Tippversenyben leadott tippjeid után itt látod majd a pontosságodat, a sorozataidat és a fejlődésedet."
          action={<Link to="/tippverseny" className="btn btn-primary">Tippverseny megnyitása</Link>}
        />
      ) : (
        <>
          {/* Fő mutatók */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon="📝" tone="neutral" label="Tippjeim" value={nf(s.totalPredictions)} sub={`${nf(s.settledPredictions)} lezárt · ${nf(s.pendingPredictions)} függőben`} />
            <StatCard icon="✅" tone="success" label="Pontosság" value={pct(s.accuracy)} sub={`${nf(s.correctPredictions)} helyes · ${nf(s.wrongPredictions)} nem talált`} />
            <StatCard icon="🎯" tone="primary" label="Pontos találat" value={nf(s.exactScores)} sub="pontos végeredmény" />
            <StatCard icon="🔥" tone="warning" label="Aktuális sorozat" value={nf(s.currentStreak)} sub={`legjobb: ${nf(s.bestStreak)}`} />
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon="📈" tone="primary" label="XP" value={nf(s.totalXp)} sub={`Level ${s.level} · ${s.levelTier}`} />
            <StatCard icon="🏆" tone="warning" label="Megnyert verseny" value={nf(s.competitionWins)} sub={`${nf(s.competitionPodiums)} dobogós helyezés`} />
            <StatCard icon="🥈" tone="neutral" label="2. helyezés" value={nf(s.competitionRunnerUps)} />
            <StatCard icon="🌍" tone="neutral" label="Ligák" value={nf(s.distinctLeagues)} sub="ahol tippeltél" />
          </div>

          {!pro && (
            <Note>
              A statisztikáid a korábbi tippjeidből számolódnak. A Tippverseny és az XP-gyűjtés PRO előfizetéssel érhető el.
              <Link to="/pro" className="btn btn-sm btn-primary ml-2 mt-2 sm:mt-0"><Crown className="h-3.5 w-3.5" /> PRO megtekintése</Link>
            </Note>
          )}

          {/* XP haladás */}
          <Card title="Szint és XP">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-bold">
              <span>Level {s.level} · {s.levelTier}</span>
              <span className="mono text-text-muted">
                {s.xpForNextLevel ? `${nf(s.xpIntoLevel)} / ${nf(s.xpForNextLevel)} XP` : `Maximális szint · ${nf(s.totalXp)} XP`}
              </span>
            </div>
            <div className="xp-bar mt-2">
              <div className="xp-bar-fill" style={{ width: `${Math.round(s.progress * 100)}%` }} />
            </div>
          </Card>

          {/* Ligánkénti bontás */}
          <Card title="Ligánkénti teljesítmény">
            {s.leagues.length === 0 ? (
              <p className="text-sm font-semibold text-text-muted">Még nincs adat.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Liga</th><th>Tipp</th><th>Lezárt</th><th>Helyes</th><th>Pontos</th><th>Pontosság</th></tr></thead>
                  <tbody>
                    {s.leagues.map((l) => (
                      <tr key={l.leagueKey}>
                        <td className="font-bold">{l.leagueName}</td>
                        <td className="mono">{nf(l.predictions)}</td>
                        <td className="mono">{nf(l.settled)}</td>
                        <td className="mono">{nf(l.correct)}</td>
                        <td className="mono">{nf(l.exact)}</td>
                        <td className="mono font-extrabold">{pct(l.accuracy, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Teljesítmény-trend */}
          <Card title={`Teljesítmény-trend (utolsó ${s.trend.length} lezárt tipp)`}>
            {s.trend.length < 2 ? (
              <p className="text-sm font-semibold text-text-muted">Legalább két lezárt tipp kell a trendhez.</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={s.trend.map((t) => ({ i: t.index, acc: Math.round(t.rollingAccuracy * 1000) / 10 }))}>
                    <CartesianGrid stroke="#e2e7f3" vertical={false} />
                    <XAxis dataKey="i" tick={{ stroke: '#6d7894', fontSize: 11, fontWeight: 700 }} />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ stroke: '#6d7894', fontSize: 11, fontWeight: 700 }} />
                    <Tooltip formatter={(v) => `${Number(v).toFixed(1).replace('.', ',')}%`} labelFormatter={(l) => `${l}. tipp`} />
                    <Line isAnimationActive={false} type="monotone" dataKey="acc" stroke="#4f6ef7" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
                <p className="mt-1 text-xs font-semibold text-text-muted">
                  A görbe a futó pontosságot mutatja: az adott tippig elért helyes találatok aránya.
                </p>
              </>
            )}
          </Card>

          {/* Tipp-előzmény */}
          <Card
            title={`Tipp-előzmény${history.data ? ` (${nf(history.data.total)})` : ''}`}
            right={
              <select className="input !w-auto !py-1.5 text-xs" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Megjelenített tippek száma">
                {[10, 20, 50, 100].map((n) => <option key={n} value={n}>Utolsó {n}</option>)}
              </select>
            }
          >
            {history.loading ? <Loading /> : history.error ? <ErrorBox message={history.error} onRetry={history.reload} />
              : !history.data?.entries.length ? <p className="text-sm font-semibold text-text-muted">Még nincs leadott tipped.</p>
                : <ul className="divide-y divide-border">{history.data.entries.map((e) => <HistoryRow key={e.predictionId} e={e} />)}</ul>}
          </Card>
        </>
      )}

      <Disclaimer />
    </div>
  );
}

function HistoryRow({ e }: { e: HistoryEntry }) {
  const st = STATUS_STYLE[e.status];
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-extrabold">{e.homeTeam} – {e.awayTeam}</div>
        <div className="truncate text-xs font-semibold text-text-muted">{e.leagueName} · {fmtDateTime(e.kickoff)}</div>
      </div>

      <div className="mono text-center text-xs font-bold text-text-muted">
        <div>tipp <b className="text-text">{e.predictedHome}–{e.predictedAway}</b></div>
        <div>eredmény <b className="text-text">{e.actualHome != null ? `${e.actualHome}–${e.actualAway}` : '–'}</b></div>
      </div>

      <span className={`badge ${st.cls} shrink-0`}>{st.icon} {PREDICTION_STATUS_LABEL[e.status]}</span>

      <div className="mono w-20 shrink-0 text-right text-xs font-bold">
        <div>{e.points != null ? `${e.points} pont` : '–'}</div>
        <div className="text-text-muted">{e.xpEarned ? `+${e.xpEarned} XP` : '0 XP'}</div>
      </div>
    </li>
  );
}
