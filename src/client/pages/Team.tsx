/** Csapatoldal: forma, hazai/idegen bontás, közelgő és legutóbbi mérkőzések. */
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime, num, pct100, useAsync } from '../lib/format';
import { MatchGrid } from '../components/MatchList';
import { Card, Disclaimer, ErrorBox, FormPills, Loading, OriginBadge, Stat } from '../components/ui';
import { FormGoalsChart } from '../components/charts';

export default function Team() {
  const { id = '' } = useParams();
  const t = useAsync(() => api.team(id), [id]);
  if (t.loading) return <Loading />;
  if (t.error || !t.data) return <ErrorBox message={t.error ?? 'Hiba'} onRetry={t.reload} />;
  const d = t.data;
  const FormBox = ({ f, title }: { f: typeof d.last10; title: string }) => (
    <Card title={title}>
      {f.sampleSize === 0 ? <div className="text-sm text-muted">Nincs elérhető mérkőzés.</div> : (
        <>
          <div className="mb-3 flex items-center justify-between"><FormPills form={f.formString} /><span className="text-xs text-muted">{f.sampleSize} meccs</span></div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div><span className="text-muted">Gy–D–V:</span> <b className="mono">{f.wins}–{f.draws}–{f.losses}</b></div>
            <div><span className="text-muted">Pont/meccs:</span> <b className="mono">{num(f.points / f.sampleSize)}</b></div>
            <div><span className="text-muted">Lőtt–kapott/meccs:</span> <b className="mono">{num(f.avgGoalsFor)}–{num(f.avgGoalsAgainst)}</b></div>
            <div><span className="text-muted">Több mint 2,5:</span> <b className="mono">{pct100(f.over25)}</b></div>
            <div><span className="text-muted">BTTS:</span> <b className="mono">{pct100(f.btts)}</b></div>
            <div><span className="text-muted">Kapott gól nélkül:</span> <b className="mono">{f.cleanSheets}</b></div>
          </div>
        </>
      )}
    </Card>
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">{d.team.name}</h1>
        <span className="text-sm text-muted">{d.league?.name} · {d.team.country}</span>
        <OriginBadge origin={d.origin} />
        {d.league && <Link to="/statisztikak" className="btn btn-sm">Tabella</Link>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Forma (utolsó 10)" value={<FormPills form={d.last10.formString} />} mono={false} />
        <Stat label="Pont/meccs" value={d.last10.sampleSize ? num(d.last10.points / d.last10.sampleSize) : '–'} />
        <Stat label="Gólátlag lőtt–kapott" value={`${num(d.last10.avgGoalsFor)}–${num(d.last10.avgGoalsAgainst)}`} />
        <Stat label="Több mint 2,5 / BTTS" value={`${pct100(d.last10.over25)} / ${pct100(d.last10.btts)}`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <FormBox f={d.home} title="Hazai forma (utolsó 10 hazai)" />
        <FormBox f={d.away} title="Idegenbeli forma (utolsó 10 idegen)" />
      </div>
      <Card title="Lőtt / kapott gólok – utolsó 10"><FormGoalsChart form={d.last10} name={d.team.shortName} /></Card>
      <section><h2 className="section-title">Közelgő mérkőzések</h2><MatchGrid matches={d.upcoming} emptyText="Nincs közelgő mérkőzés az adatkészletben." /></section>
      <Card title="Legutóbbi mérkőzések">
        {d.recent.length === 0 ? <div className="text-sm text-muted">Nincs lejátszott mérkőzés.</div> : (
          <table className="table">
            <thead><tr><th>Dátum</th><th>Mérkőzés</th><th>Sorozat</th><th>Eredmény</th><th></th></tr></thead>
            <tbody>
              {d.recent.map((m) => (
                <tr key={m.id}>
                  <td className="mono text-xs">{fmtDateTime(m.date)}</td>
                  <td className="font-semibold">{m.homeTeam?.name ?? m.homeTeamId} – {m.awayTeam?.name ?? m.awayTeamId}</td>
                  <td className="text-xs text-muted">{m.league?.name}</td>
                  <td className="mono font-bold">{m.homeGoals}–{m.awayGoals}{m.htHomeGoals != null && <span className="ml-1 text-xs font-normal text-muted">({m.htHomeGoals}–{m.htAwayGoals})</span>}</td>
                  <td><Link to={`/meccs/${encodeURIComponent(m.id)}`} className="btn btn-sm">Elemzés</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Disclaimer />
    </div>
  );
}
