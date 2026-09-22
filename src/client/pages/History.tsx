/** Előzmények: a rendszer által korábban készített tippek átlátható követése – nyertes és vesztes egyaránt. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MARKET_LABELS } from '@shared/engine/markets';
import { api } from '../lib/api';
import { fmtDateTime, odds as fo, pct, signed, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, OriginBadge, Stat } from '../components/ui';
import { SimpleBarChart } from '../components/charts';
import { LockedBlock, ProLock, usePlan } from '../auth/PlanContext';

export default function History() {
  const [f, setF] = useState({ leagueId: '', market: '', from: '', to: '', minProb: '', maxProb: '' });
  const leagues = useAsync(() => api.leagues(), []);
  const slips = useAsync(() => api.savedSlips(), []);
  const { pro } = usePlan();
  const h = useAsync(() => api.history({
    leagueId: f.leagueId || undefined, market: f.market || undefined, from: f.from || undefined, to: f.to || undefined,
    minProb: f.minProb ? String(+f.minProb / 100) : undefined, maxProb: f.maxProb ? String(+f.maxProb / 100) : undefined,
  }), [f]);
  const s = h.data?.summary;

  // Találati arány modell-valószínűség sávonként (kalibráció-jellegű átlátható nézet)
  const bands = [[0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const rows = (h.data?.predictions ?? []).filter((p) => p.modelProb >= lo && p.modelProb < hi && (p.outcome === 'nyert' || p.outcome === 'vesztett'));
    const won = rows.filter((p) => p.outcome === 'nyert').length;
    return { name: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, v: rows.length ? (won / rows.length) * 100 : 0, n: rows.length };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">Előzmények {!pro && <ProLock />}</h1>
        <p className="text-sm text-muted">Minden mentett tipp az eredménnyel együtt. A vesztes tippek nem kerülnek elrejtésre, az eredmények nem módosíthatók.</p>
      </div>
      {!pro && <LockedBlock title="Történelmi eredmények – PRO" text="A mentett tippek és szelvények eredményei, a találati arány, a kalibráció és a ROI PRO előfizetéssel érhető el." />}
      {pro && <Card title="Szűrők">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs text-muted">Bajnokság<select className="input mt-1" value={f.leagueId} onChange={(e) => setF({ ...f, leagueId: e.target.value })}><option value="">Összes</option>{leagues.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <label className="text-xs text-muted">Piac<select className="input mt-1" value={f.market} onChange={(e) => setF({ ...f, market: e.target.value })}><option value="">Összes</option>{Object.entries(MARKET_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="text-xs text-muted">Dátumtól<input type="date" className="input mt-1" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
          <label className="text-xs text-muted">Dátumig<input type="date" className="input mt-1" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          <label className="text-xs text-muted">Modell-val. min. (%)<input type="number" min={0} max={100} className="input mt-1" value={f.minProb} onChange={(e) => setF({ ...f, minProb: e.target.value })} /></label>
          <label className="text-xs text-muted">Modell-val. max. (%)<input type="number" min={0} max={100} className="input mt-1" value={f.maxProb} onChange={(e) => setF({ ...f, maxProb: e.target.value })} /></label>
        </div>
      </Card>}
      {!pro ? null : h.loading ? <Loading /> : h.error ? <ErrorBox message={h.error} onRetry={h.reload} /> : h.data && s && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
            <Stat label="Összes tipp" value={s.total} />
            <Stat label="Lezárt" value={s.settled} sub={`${s.pending} függőben`} />
            <Stat label="Helyes" value={<span className="text-accent">{s.correct}</span>} />
            <Stat label="Helytelen" value={<span className="text-danger">{s.incorrect}</span>} sub={s.voided ? `${s.voided} érvénytelen` : undefined} />
            <Stat label="Tényleges találati arány" value={s.hitRate != null ? pct(s.hitRate, 1) : '–'} />
            <Stat label="Átlagos modell-valószínűség" value={s.avgModelProb != null ? pct(s.avgModelProb, 1) : '–'} />
            <Stat label="ROI (1 egység tét)" value={s.roi != null ? <span className={s.roi >= 0 ? 'text-accent' : 'text-danger'}>{signed(s.roi * 100, 1)}%</span> : '–'} sub={`${s.withOdds} tipp oddsszal`} />
            <Stat label="Adatforrás" value={<OriginBadge origin={h.data.origin} />} mono={false} />
          </div>
          {s.hitRate != null && s.avgModelProb != null && (
            <Note tone={Math.abs(s.hitRate - s.avgModelProb) > 0.08 ? 'warn' : 'info'}>
              Kalibráció: az átlagos modell-valószínűség {pct(s.avgModelProb, 1)}, a tényleges találati arány {pct(s.hitRate, 1)}.
              {s.hitRate < s.avgModelProb - 0.05 ? ' A modell túlbecsüli az esélyeket ebben a mintában.' : s.hitRate > s.avgModelProb + 0.05 ? ' A modell alulbecsüli az esélyeket ebben a mintában.' : ' A modell nagyjából jól kalibrált ebben a mintában.'}
              {h.data.origin === 'demo' && ' (DEMO ADAT – a demo odds árrése miatt a ROI jellemzően negatív.)'}
            </Note>
          )}
          <Card title="Találati arány modell-valószínűség sávonként">
            <SimpleBarChart data={bands} pctAxis height={200} />
            <div className="mt-1 grid grid-cols-5 text-center text-[11px] text-muted">{bands.map((b) => <div key={b.name}>{b.n} tipp</div>)}</div>
          </Card>
          {slips.data && slips.data.length > 0 && (() => {
            const settled = slips.data.filter((x) => x.outcome !== 'függőben');
            const won = settled.filter((x) => x.outcome === 'nyert').length;
            const stake = settled.filter((x) => x.outcome !== 'érvénytelen').length;
            const ret = slips.data.filter((x) => x.outcome === 'nyert').reduce((a, x) => a + x.totalOdds, 0);
            return (
              <Card title={`Mentett szelvények (${slips.data.length})`} right={<Link to="/szelvenyek" className="btn btn-sm">Szelvényépítő</Link>}>
                <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat label="Lezárt szelvény" value={settled.length} sub={`${slips.data.length - settled.length} függőben`} />
                  <Stat label="Bejött" value={<span className="text-accent">{won}</span>} sub={stake ? `${Math.round((won / stake) * 100)}% találat` : ''} />
                  <Stat label="Nem jött be" value={<span className="text-danger">{settled.filter((x) => x.outcome === 'vesztett').length}</span>} />
                  <Stat label="ROI (1 egység / szelvény)" value={stake ? <span className={ret - stake >= 0 ? 'text-accent' : 'text-danger'}>{signed(((ret - stake) / stake) * 100, 1)}%</span> : '–'} />
                </div>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th>Mentve</th><th>Szelvény</th><th>Lábak</th><th>Összodds</th><th>Modell esély</th><th>Kimenet</th></tr></thead>
                    <tbody>
                      {slips.data.map((x) => (
                        <tr key={x.id}>
                          <td className="mono whitespace-nowrap text-xs">{fmtDateTime(x.createdAt)}</td>
                          <td><div className="font-semibold">{x.label}</div><div className="text-xs text-muted">{x.strategy}</div></td>
                          <td className="text-xs">{x.legs.map((l) => <div key={l.id}><span className={l.outcome === 'nyert' ? 'text-accent' : l.outcome === 'vesztett' ? 'text-danger' : 'text-muted'}>●</span> {l.matchLabel} – {l.marketLabel} ({fo(l.odds)}){l.homeGoals != null && <span className="mono text-muted"> {l.homeGoals}–{l.awayGoals}</span>}</div>)}</td>
                          <td className="mono font-semibold">{fo(x.totalOdds)}</td>
                          <td className="mono">{pct(x.jointProb, 1)}</td>
                          <td><span className={`badge ${x.outcome === 'nyert' ? 'badge-green' : x.outcome === 'vesztett' ? 'badge-red' : x.outcome === 'érvénytelen' ? 'badge-muted' : 'badge-yellow'}`}>{x.outcome}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })()}
          <Card title={`Tippek (${h.data.predictions.length})`}>
            {h.data.predictions.length === 0 ? <EmptyState title="Nincs mentett tipp" text="Mérkőzés oldalon a „Mentés az előzményekhez” gombbal rögzíthetsz tippet." /> : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead><tr><th>Dátum</th><th>Mérkőzés</th><th>Bajnokság</th><th>Piac</th><th>Modell</th><th>Odds</th><th>Eredmény</th><th>Kimenet</th><th>Típus</th></tr></thead>
                  <tbody>
                    {h.data.predictions.map((p) => (
                      <tr key={p.id}>
                        <td className="mono whitespace-nowrap text-xs">{fmtDateTime(p.kickoff)}</td>
                        <td><Link to={`/meccs/${encodeURIComponent(p.matchId)}`} className="font-semibold hover:text-accent">{p.matchLabel}</Link></td>
                        <td className="text-xs text-muted">{p.leagueName}</td>
                        <td>{p.marketLabel}</td>
                        <td className="mono">{pct(p.modelProb, 1)}</td>
                        <td className="mono">{fo(p.odds)}</td>
                        <td className="mono">{p.homeGoals != null ? `${p.homeGoals}–${p.awayGoals}` : '–'}</td>
                        <td><span className={`badge ${p.outcome === 'nyert' ? 'badge-green' : p.outcome === 'vesztett' ? 'badge-red' : p.outcome === 'érvénytelen' ? 'badge-muted' : 'badge-yellow'}`}>{p.outcome}</span></td>
                        <td className="text-xs text-muted">{p.predictionType} · {p.category} <OriginBadge origin={p.origin} small /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      <Disclaimer />
    </div>
  );
}
