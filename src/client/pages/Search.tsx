/** Globális keresés: csapat, mérkőzés, bajnokság, ország. */
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { MatchGrid } from '../components/MatchList';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading } from '../components/ui';

export default function Search() {
  const [sp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const r = useAsync(() => (q.length >= 2 ? api.search(q) : Promise.resolve({ teams: [], leagues: [], matches: [] })), [q]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Keresés: „{q}”</h1>
        <p className="text-sm text-muted">Csapatok, közelgő mérkőzések (3 nap), bajnokságok és országok.</p>
      </div>
      {q.length < 2 ? <EmptyState title="Adj meg legalább 2 karaktert" /> : r.loading ? <Loading /> : r.error ? <ErrorBox message={r.error} onRetry={r.reload} /> : r.data && (
        <>
          {r.data.teams.length === 0 && r.data.leagues.length === 0 && r.data.matches.length === 0 && <EmptyState title="Nincs találat" text="Próbálj más kulcsszót (pl. csapatnév, bajnokság vagy ország)." />}
          {r.data.teams.length > 0 && (
            <Card title={`Csapatok (${r.data.teams.length})`}>
              <div className="flex flex-wrap gap-2">{r.data.teams.map((t) => <Link key={t.id} to={`/csapat/${encodeURIComponent(t.id)}`} className="btn">{t.name} <span className="text-xs text-muted">{t.country}</span></Link>)}</div>
            </Card>
          )}
          {r.data.leagues.length > 0 && (
            <Card title={`Bajnokságok (${r.data.leagues.length})`}>
              <div className="flex flex-wrap gap-2">{r.data.leagues.map((l) => <Link key={l.id} to="/statisztikak" className="btn">{l.name} <span className="text-xs text-muted">{l.country}</span></Link>)}</div>
            </Card>
          )}
          {r.data.matches.length > 0 && (
            <section><h2 className="section-title">Közelgő mérkőzések ({r.data.matches.length})</h2><MatchGrid matches={r.data.matches} /></section>
          )}
        </>
      )}
      <Disclaimer />
    </div>
  );
}
