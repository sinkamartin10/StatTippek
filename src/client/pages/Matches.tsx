import { api } from '../lib/api';
import { useAsync, todayKey, fmtDayLabel } from '../lib/format';
import { useUrlState } from '../lib/listState';
import { applyClientFilters, defaultFilters, MatchFilters, MatchGrid } from '../components/MatchList';
import { Card, Disclaimer, ErrorBox, Loading, Note } from '../components/ui';
import { useFreeDay, usePlan } from '../auth/PlanContext';

export default function Matches() {
  /**
   * A választott nap és a szűrők az URL-BEN élnek. Így a meccs megnyitása
   * után a „Vissza” ugyanazt a napot adja vissza (a böngésző az előzményből
   * állítja helyre a címet), és a `?date=…` cím újratöltve is működik.
   */
  const [f, setF] = useUrlState(defaultFilters(), ['date']);
  const leagues = useAsync(() => api.leagues(), []);
  const matches = useAsync(
    () => api.matches({ date: f.date, leagueId: f.leagueId, country: f.country, importance: f.importance }),
    [f.date, f.leagueId, f.country, f.importance],
    // Visszalépéskor az utolsó friss lista azonnal látszik, és a háttérben frissül
    `matches:${f.date}|${f.leagueId}|${f.country}|${f.importance}`,
  );
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
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Mai meccsek</h1>
          <p className="mt-1.5 text-sm font-semibold text-text-muted">{fmtDayLabel(f.date + 'T12:00:00')} – {list.length} mérkőzés</p>
        </div>
        <div className="flex gap-2">
          {[-1, 0, 1, 2].map((d) => (
            <button key={d} className={`chip ${f.date === todayKey(d) ? 'chip-active' : ''}`} onClick={() => setF({ ...f, date: todayKey(d) })}>
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
