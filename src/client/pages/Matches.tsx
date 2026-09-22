import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync, todayKey, fmtDayLabel } from '../lib/format';
import { applyClientFilters, defaultFilters, MatchFilters, MatchGrid } from '../components/MatchList';
import { Card, Disclaimer, ErrorBox, Loading, Note } from '../components/ui';
import { useFreeDay, usePlan } from '../auth/PlanContext';

export default function Matches() {
  const [f, setF] = useState(defaultFilters());
  const leagues = useAsync(() => api.leagues(), []);
  const matches = useAsync(() => api.matches({ date: f.date, leagueId: f.leagueId, country: f.country, importance: f.importance }), [f.date, f.leagueId, f.country, f.importance]);
  const list = matches.data ? applyClientFilters(matches.data, f) : [];
  const { pro } = usePlan();
  const free = useFreeDay(f.date);

  // Bajnokságonként csoportosítva
  const groups = new Map<string, typeof list>();
  for (const m of list) {
    const key = m.league ? `${m.league.name} · ${m.league.country}` : m.leagueId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Mai meccsek</h1>
          <p className="text-sm text-muted">{fmtDayLabel(f.date + 'T12:00:00')} – {list.length} mérkőzés</p>
        </div>
        <div className="flex gap-2">
          {[-1, 0, 1, 2].map((d) => (
            <button key={d} className={`btn btn-sm ${f.date === todayKey(d) ? 'btn-primary' : ''}`} onClick={() => setF({ ...f, date: todayKey(d) })}>
              {d === -1 ? 'Tegnap' : d === 0 ? 'Ma' : d === 1 ? 'Holnap' : 'Holnapután'}
            </button>
          ))}
        </div>
      </div>
      <Card title="Szűrők">
        {leagues.data ? <MatchFilters f={f} set={setF} leagues={leagues.data} /> : <Loading />}
      </Card>
      {!pro && !free.loading && free.total > 0 && (
        <Note tone="warn">FREE csomag: ezen a napon {free.total} mérkőzésből <b>{free.quota}</b> elemzése ingyenes (a kezdési idő szerinti első {free.quota}); a többi lakattal jelölt, PRO előfizetéssel nyitható.</Note>
      )}
      {matches.loading ? <Loading /> : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} /> : groups.size === 0 ? (
        <MatchGrid matches={[]} />
      ) : (
        [...groups.entries()].map(([name, ms]) => (
          <section key={name}>
            <h2 className="section-title">{name} <span className="text-xs font-normal text-muted">({ms.length})</span></h2>
            <MatchGrid matches={ms} isLocked={free.locked} />
          </section>
        ))
      )}
      <Disclaimer />
    </div>
  );
}
