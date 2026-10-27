/**
 * Statisztikák: tabella, liga-átlagok, gólstatisztikák bajnokságonként.
 * Kupánál, válogatott sorozatnál és barátságos meccseknél NINCS bajnoki tabella (a 3-1-0 pontsorrend félrevezető
 * lenne): helyette a sorozat mérkőzései és eredményei látszanak, a formátum egyértelmű jelzésével.
 */
import { useState } from 'react';
import { FORMAT_INFO, type CompetitionFormat, type CompetitionResultRow } from '@shared/competitionFormat';
import { api } from '../lib/api';
import { fmtDateTime, num, pct100, useAsync } from '../lib/format';
import { Card, Disclaimer, ErrorBox, FormPills, Loading, Note, OriginBadge, Stat, TeamLink } from '../components/ui';
import { SimpleBarChart } from '../components/charts';
import { LockedBlock, ProLock, usePlan } from '../auth/PlanContext';

/** Hogyan dőlt el a meccs (hosszabbítás / tizenegyespárbaj) – szövegesen, a pontos eredménnyel együtt. */
export function decidedText(r: Pick<CompetitionResultRow, 'decidedBy' | 'shootout'>): string | null {
  if (r.decidedBy === 'aet') return 'hosszabbítás után';
  if (r.decidedBy === 'pen') return r.shootout ? `tizenegyesekkel ${r.shootout.home}–${r.shootout.away}` : 'tizenegyesekkel';
  return null;
}

/** A nem-bajnoki sorozat mérkőzései és eredményei – pontozás és rangsor nélkül. */
export function CompetitionResults({ name, format, results, total }: {
  name: string;
  format: Exclude<CompetitionFormat, 'league'>;
  results: CompetitionResultRow[];
  total: number;
}) {
  const info = FORMAT_INFO[format];
  return (
    <Card title={`${name} – mérkőzések és eredmények`} right={<span className="badge badge-blue">{info.label}</span>}>
      <div className="space-y-3">
        <Note>{info.text}</Note>
        {results.length === 0 ? (
          <div className="text-sm font-semibold text-text-muted">Ebben az idényben még nincs lejátszott mérkőzés ebben a sorozatban.</div>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {results.map((r) => {
                const decided = decidedText(r);
                const homeWon = r.decidedBy === 'pen' && r.shootout ? r.shootout.home > r.shootout.away : r.homeGoals > r.awayGoals;
                const awayWon = r.decidedBy === 'pen' && r.shootout ? r.shootout.away > r.shootout.home : r.awayGoals > r.homeGoals;
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                    <span className="w-32 shrink-0 text-xs font-semibold text-text-muted">{fmtDateTime(r.date)}</span>
                    <span className="min-w-0 flex-1 basis-48">
                      <TeamLink id={r.homeTeamId} name={r.homeTeam?.name ?? r.homeTeamId} className={homeWon ? 'font-extrabold' : 'font-semibold'} />
                      <span className="text-text-muted"> – </span>
                      <TeamLink id={r.awayTeamId} name={r.awayTeam?.name ?? r.awayTeamId} className={awayWon ? 'font-extrabold' : 'font-semibold'} />
                    </span>
                    <span className="mono shrink-0 font-extrabold">{r.homeGoals}–{r.awayGoals}</span>
                    {decided && <span className="badge badge-muted shrink-0">{decided}</span>}
                  </li>
                );
              })}
            </ul>
            {total > results.length && <p className="text-xs font-semibold text-text-muted">A legutóbbi {results.length} eredmény látszik ({total} lejátszott meccsből).</p>}
          </>
        )}
      </div>
    </Card>
  );
}

export default function Stats() {
  const leagues = useAsync(() => api.leagues(), []);
  const [leagueId, setLeagueId] = useState('eng-pl');
  const st = useAsync(() => api.standings(leagueId), [leagueId]);
  const { pro } = usePlan();
  const format = st.data?.format ?? 'league';
  const isLeague = format === 'league';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Statisztikák</h1>
          <p className="mt-1.5 text-sm font-semibold text-text-muted">Tabella, forma és gólstatisztikák bajnokságonként az elérhető lejátszott mérkőzésekből.</p>
        </div>
        <select className="input max-w-xs" value={leagueId} onChange={(e) => setLeagueId(e.target.value)}>
          {leagues.data?.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.country})</option>)}
        </select>
      </div>
      {st.loading ? <Loading /> : st.error ? <ErrorBox message={st.error} onRetry={st.reload} /> : st.data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <Stat label={isLeague ? 'Lejátszott meccs' : 'Rendes játékidős meccs'} value={st.data.averages.matches} />
            <Stat label="Gól / meccs" value={num(st.data.averages.avgTotalGoals)} sub={`hazai ${num(st.data.averages.avgHomeGoals)} · vendég ${num(st.data.averages.avgAwayGoals)}`} />
            <Stat label="Hazai győzelem" value={pct100(st.data.averages.homeWinPct)} />
            <Stat label="Döntetlen" value={pct100(st.data.averages.drawPct)} />
            <Stat label="Több mint 2,5" value={pct100(st.data.averages.over25Pct)} />
            <Stat label="BTTS" value={pct100(st.data.averages.bttsPct)} />
          </div>
          {!isLeague && (
            <p className="text-xs font-semibold text-text-muted">
              A fenti átlagok a sorozat rendes játékidőben lezárult meccseiből készülnek – a hosszabbítással vagy tizenegyespárbajjal eldőlt meccsek nem számítanak bele.
            </p>
          )}
          {!pro ? (
            <Card title={`${st.data.league.name} – ${isLeague ? 'tabella és gólstatisztikák' : 'mérkőzések és eredmények'}`} right={<ProLock />}>
              <LockedBlock
                title="Részletes statisztikák – PRO"
                text={isLeague
                  ? 'Tabella, forma, lőtt/kapott gól diagramok PRO előfizetéssel. A liga-átlagok fent ingyenesek.'
                  : 'A sorozat mérkőzései és eredményei PRO előfizetéssel. Az átlagok fent ingyenesek.'}
              />
            </Card>
          ) : !isLeague ? (
            <CompetitionResults name={st.data.league.name} format={format as Exclude<CompetitionFormat, 'league'>} results={st.data.results} total={st.data.resultsTotal} />
          ) : <>
          <Card title={`${st.data.league.name} – tabella`} right={<OriginBadge origin={st.data.origin} small />}>
            {st.data.standings.length === 0 ? <div className="mt-1.5 text-sm font-semibold text-text-muted">Nincs lejátszott mérkőzés ebben a bajnokságban.</div> : (
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
            <Card title="Kapott gólok csapatonként"><SimpleBarChart data={st.data.standings.map((s) => ({ name: s.team?.shortName ?? s.teamId, v: s.ga }))} color="#f2546a" height={260} /></Card>
          </div>
          </>}
        </>
      )}
      <Disclaimer />
    </div>
  );
}
