/** Statisztikák: tabella, liga-átlagok, gólstatisztikák bajnokságonként. */
import { useState } from 'react';
import { api } from '../lib/api';
import { num, pct100, useAsync } from '../lib/format';
import { Card, Disclaimer, ErrorBox, FormPills, Loading, OriginBadge, Stat, TeamLink } from '../components/ui';
import { SimpleBarChart } from '../components/charts';
import { LockedBlock, ProLock, usePlan } from '../auth/PlanContext';

export default function Stats() {
  const leagues = useAsync(() => api.leagues(), []);
  const [leagueId, setLeagueId] = useState('eng-pl');
  const st = useAsync(() => api.standings(leagueId), [leagueId]);
  const { pro } = usePlan();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Statisztikák</h1>
          <p className="text-sm text-muted">Tabella, forma és gólstatisztikák bajnokságonként az elérhető lejátszott mérkőzésekből.</p>
        </div>
        <select className="input max-w-xs" value={leagueId} onChange={(e) => setLeagueId(e.target.value)}>
          {leagues.data?.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.country})</option>)}
        </select>
      </div>
      {st.loading ? <Loading /> : st.error ? <ErrorBox message={st.error} onRetry={st.reload} /> : st.data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat label="Lejátszott meccs" value={st.data.averages.matches} />
            <Stat label="Gól / meccs" value={num(st.data.averages.avgTotalGoals)} sub={`hazai ${num(st.data.averages.avgHomeGoals)} · vendég ${num(st.data.averages.avgAwayGoals)}`} />
            <Stat label="Hazai győzelem" value={pct100(st.data.averages.homeWinPct)} />
            <Stat label="Döntetlen" value={pct100(st.data.averages.drawPct)} />
            <Stat label="Több mint 2,5" value={pct100(st.data.averages.over25Pct)} />
            <Stat label="BTTS" value={pct100(st.data.averages.bttsPct)} />
          </div>
          {!pro ? <Card title={`${st.data.league.name} – tabella és gólstatisztikák`} right={<ProLock />}><LockedBlock title="Részletes statisztikák – PRO" text="Tabella, forma, lőtt/kapott gól diagramok PRO előfizetéssel. A liga-átlagok fent ingyenesek." /></Card> : <>
          <Card title={`${st.data.league.name} – tabella`} right={<OriginBadge origin={st.data.origin} small />}>
            {st.data.standings.length === 0 ? <div className="text-sm text-muted">Nincs lejátszott mérkőzés ebben a bajnokságban.</div> : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>#</th><th>Csapat</th><th>M</th><th>Gy</th><th>D</th><th>V</th><th>LG</th><th>KG</th><th>GK</th><th>P</th><th>Forma</th></tr></thead>
                  <tbody>
                    {st.data.standings.map((s) => (
                      <tr key={s.teamId}>
                        <td className="mono text-muted">{s.position}</td>
                        <td className="font-semibold"><TeamLink id={s.teamId} name={s.team?.name ?? s.teamId} /></td>
                        <td className="mono">{s.played}</td><td className="mono">{s.wins}</td><td className="mono">{s.draws}</td><td className="mono">{s.losses}</td>
                        <td className="mono">{s.gf}</td><td className="mono">{s.ga}</td><td className="mono">{s.gd > 0 ? '+' : ''}{s.gd}</td><td className="mono font-bold">{s.points}</td>
                        <td><FormPills form={s.form} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Lőtt gólok csapatonként"><SimpleBarChart data={st.data.standings.map((s) => ({ name: s.team?.shortName ?? s.teamId, v: s.gf }))} height={260} /></Card>
            <Card title="Kapott gólok csapatonként"><SimpleBarChart data={st.data.standings.map((s) => ({ name: s.team?.shortName ?? s.teamId, v: s.ga }))} color="#ef4444" height={260} /></Card>
          </div>
          </>}
        </>
      )}
      <Disclaimer />
    </div>
  );
}
