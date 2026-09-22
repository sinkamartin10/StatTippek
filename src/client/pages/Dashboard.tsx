import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync, pct, fmtTime } from '../lib/format';
import { applyClientFilters, defaultFilters, MatchFilters, MatchGrid } from '../components/MatchList';
import { Card, Disclaimer, ErrorBox, Loading, Note, Stat } from '../components/ui';
import { ProfileCard } from '../auth/ProfileCard';
import { FREE_DAILY_TIPS, ProLock, useFreeDay, usePlan } from '../auth/PlanContext';

export default function Dashboard() {
  const [f, setF] = useState(defaultFilters());
  const leagues = useAsync(() => api.leagues(), []);
  const matches = useAsync(() => api.matches({ date: f.date, leagueId: f.leagueId, country: f.country, importance: f.importance }), [f.date, f.leagueId, f.country, f.importance]);
  const tips = useAsync(() => api.tips(f.date), [f.date]);
  const history = useAsync(() => api.history({}), []);

  const list = matches.data ? applyClientFilters(matches.data, f) : [];
  const scheduled = list.filter((m) => m.status === 'scheduled');
  const strongTips = (tips.data ?? []).filter((t) => t.tip.modelProb >= 0.6 && t.tip.supportingIndicators >= 3 && t.dataQuality.level !== 'kevés');
  const { pro } = usePlan();
  const free = useFreeDay(f.date);
  const highlighted = strongTips.slice(0, pro ? 6 : FREE_DAILY_TIPS);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted">Mérkőzések, modell-becslések és források egy helyen. Az előrejelzések valószínűségi becslések, nem garanciák.</p>
        </div>
      </div>

      <ProfileCard />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Mérkőzés a napon" value={matches.data ? list.length : '…'} sub={`${scheduled.length} még nem kezdődött el`} />
        <Stat label="Bajnokság" value={leagues.data?.length ?? '…'} sub="elérhető sorozat" />
        <Stat label="Erős statisztikai támogatású tipp" value={tips.data ? strongTips.length : '…'} sub="≥60% modell, ≥3 mutató, nem kevés adat" />
        <Stat label="Előzmények találati arány" value={history.data?.summary.hitRate != null ? pct(history.data.summary.hitRate, 1) : '–'} sub={history.data ? `${history.data.summary.correct}/${history.data.summary.correct + history.data.summary.incorrect} lezárt tipp` : ''} />
      </div>

      <Card title="Mai mérkőzések" right={<Link to="/meccsek" className="btn btn-sm">Összes <ArrowRight className="h-3.5 w-3.5" /></Link>}>
        {leagues.data && <div className="mb-4"><MatchFilters f={f} set={setF} leagues={leagues.data} /></div>}
        {matches.loading ? <Loading /> : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} /> : <MatchGrid matches={list.slice(0, 12)} isLocked={free.locked} />}
        {list.length > 12 && <div className="mt-3 text-center text-sm text-muted">+{list.length - 12} további mérkőzés a <Link to="/meccsek" className="text-accent">Mai meccsek</Link> oldalon.</div>}
      </Card>

      <Card title={pro ? 'Statisztikailag erősen támogatott piacok (kiemelés)' : `Statisztikailag erősen támogatott piacok – napi ${FREE_DAILY_TIPS} (FREE)`} right={<div className="flex items-center gap-2">{!pro && <ProLock label="Teljes lista" />}<Link to="/tippek" className="btn btn-sm">Mai tippek <ArrowRight className="h-3.5 w-3.5" /></Link></div>}>
        <Note>Nem rangsor: a lista a modell-valószínűség (≥60%), a támogató mutatók száma (≥3) és az adatminőség szűrőin átjutó piacokat mutatja, kezdési idő szerint. Minden sor mellett látható, miért szerepel.</Note>
        {tips.loading ? <Loading text="Modellek futtatása és hírek keresése a mai meccsekre (első betöltéskor akár 1 perc)…" /> : tips.error ? <ErrorBox message={tips.error} /> : highlighted.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted">Nincs a szűrőknek megfelelő piac erre a napra.</div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead><tr><th>Kezdés</th><th>Mérkőzés</th><th>Piac</th><th>Modell</th><th>Odds</th><th>Mutatók</th><th>Miért?</th></tr></thead>
              <tbody>
                {highlighted.map((t) => (
                  <tr key={t.matchId + t.tip.market}>
                    <td className="mono">{fmtTime(t.kickoff)}</td>
                    <td><Link to={`/meccs/${encodeURIComponent(t.matchId)}`} className="font-semibold hover:text-accent">{t.matchLabel}</Link><div className="text-xs text-muted">{t.leagueName}</div></td>
                    <td>{t.tip.label}</td>
                    <td className="mono font-semibold text-accent">{pct(t.tip.modelProb)}</td>
                    <td className="mono">{t.tip.odds?.toFixed(2).replace('.', ',') ?? '–'}</td>
                    <td className="mono">{t.tip.supportingIndicators}/{t.tip.supportingStats.length}</td>
                    <td className="max-w-md text-xs text-muted">{pro ? t.tip.reasonsFor.slice(1, 3).join(' · ') : <ProLock label="Indoklás" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Disclaimer />
    </div>
  );
}
