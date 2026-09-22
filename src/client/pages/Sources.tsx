/** Forrásnapló: minden külső forrásból származó információ URL-lel, lekérési idővel, típussal. */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, OriginBadge } from '../components/ui';

export default function Sources() {
  const [sp] = useSearchParams();
  const [matchId, setMatchId] = useState(sp.get('matchId') ?? '');
  const [origin, setOrigin] = useState('');
  const [type, setType] = useState('');
  const s = useAsync(() => api.sources({ matchId: matchId || undefined, origin: origin || undefined }), [matchId, origin]);
  const list = (s.data ?? []).filter((x) => !type || x.type === type);
  const types = [...new Set((s.data ?? []).map((x) => x.type))];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Források</h1>
        <p className="text-sm text-muted">Minden külső információ forrással, URL-lel és lekérési idővel. URL nélküli tétel nem tekinthető ellenőrzöttnek.</p>
      </div>
      <Note>A forrásnapló az eddig elemzett mérkőzésekhez tartozó bejegyzéseket tartalmazza (legfeljebb 500 legfrissebb). Új mérkőzés elemzésekor bővül.</Note>
      <Card title="Szűrők">
        <div className="grid gap-3 sm:grid-cols-3">
          <input className="input" placeholder="Mérkőzés azonosító (pl. demo-eng-pl-r13-1)" value={matchId} onChange={(e) => setMatchId(e.target.value)} />
          <select className="input" value={origin} onChange={(e) => setOrigin(e.target.value)}><option value="">Minden eredet</option><option value="live">Élő</option><option value="demo">Demo</option></select>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="">Minden típus</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </div>
      </Card>
      {s.loading ? <Loading /> : s.error ? <ErrorBox message={s.error} onRetry={s.reload} /> : list.length === 0 ? <EmptyState title="Nincs rögzített forrás" text="Nyiss meg egy mérkőzés-elemzést, és a kutatómotor forrásai itt jelennek meg." /> : (
        <Card title={`${list.length} forrásbejegyzés`}>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Lekérve</th><th>Forrás</th><th>Típus</th><th>Mérkőzés</th><th>Kinyert információ</th><th>Módszer</th><th>Eredet</th><th>URL</th></tr></thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.id}>
                    <td className="mono whitespace-nowrap text-xs">{fmtDateTime(x.retrievedAt)}</td>
                    <td className="font-semibold">{x.sourceName}</td>
                    <td><span className="badge badge-muted">{x.type}</span></td>
                    <td className="text-xs text-muted">{x.matchId}</td>
                    <td className="max-w-md text-xs">„{x.extracted}”</td>
                    <td className="text-xs text-muted">{x.method}</td>
                    <td><OriginBadge origin={x.origin} small /></td>
                    <td>{x.url ? <a href={x.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent">link <ExternalLink className="h-3 w-3" /></a> : <span className="text-xs text-warn">nincs</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Disclaimer />
    </div>
  );
}
