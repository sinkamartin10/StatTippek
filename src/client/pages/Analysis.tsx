/** Elemzés-központ: mérkőzés kiválasztása elemzéshez + a módszertan leírása. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDayLabel, fmtTime, todayKey, useAsync } from '../lib/format';
import { Card, Disclaimer, ErrorBox, ImportanceBadge, Loading, EmptyState } from '../components/ui';

export default function Analysis() {
  const [q, setQ] = useState('');
  const [leagueId, setLeagueId] = useState('');
  const leagues = useAsync(() => api.leagues(), []);
  const matches = useAsync(() => api.matches({ from: todayKey(), to: todayKey(3), leagueId, status: 'scheduled' }), [leagueId]);
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const list = (matches.data ?? []).filter((m) => !q || norm(`${m.homeTeam?.name} ${m.awayTeam?.name}`).includes(norm(q)));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Elemzés</h1>
        <p className="text-sm text-muted">Válassz mérkőzést a következő 3 napból – a kutatómotor és a statisztikai modellek részletes elemzést készítenek.</p>
      </div>
      <Card title="Mérkőzés kiválasztása">
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="input" placeholder="Csapatnév szűrése… (pl. Arsenal vs Chelsea)" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" value={leagueId} onChange={(e) => setLeagueId(e.target.value)}>
            <option value="">Összes bajnokság</option>
            {leagues.data?.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.country})</option>)}
          </select>
        </div>
        <div className="mt-4">
          {matches.loading ? <Loading /> : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} /> : list.length === 0 ? <EmptyState title="Nincs találat" /> : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Időpont</th><th>Mérkőzés</th><th>Bajnokság</th><th>Fontosság</th><th></th></tr></thead>
                <tbody>
                  {list.slice(0, 80).map((m) => (
                    <tr key={m.id}>
                      <td className="mono whitespace-nowrap">{fmtDayLabel(m.kickoff)} {fmtTime(m.kickoff)}</td>
                      <td className="font-semibold">{m.homeTeam?.name} – {m.awayTeam?.name}</td>
                      <td className="text-muted">{m.league?.name}</td>
                      <td><ImportanceBadge importance={m.importance} /></td>
                      <td><Link to={`/meccs/${encodeURIComponent(m.id)}`} className="btn btn-sm btn-primary"><Sparkles className="h-3.5 w-3.5" /> Elemzés</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
      <Card title="Hogyan készül az elemzés?">
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <div>
            <h4 className="font-semibold">1. Kutatómotor</h4>
            <p className="text-muted">A kiválasztott mérkőzéshez híreket, hiányzókat, felállásokat és külső előrejelzéseket gyűjt. Minden találat forrással, URL-lel és lekérési idővel kerül tárolásra. URL-t sosem generálunk; ellenőrizhetetlen információ nem jelenik meg tényként.</p>
          </div>
          <div>
            <h4 className="font-semibold">2. Statisztikai motor</h4>
            <p className="text-muted">Utolsó 5/10 meccs, hazai/idegen bontás, gólpiaci historikus gyakoriságok, egymás elleni mérkőzések, tabella és liga-átlagok – tiszta, ellenőrizhető számítások.</p>
          </div>
          <div>
            <h4 className="font-semibold">3. Várható gól + Poisson-modell</h4>
            <p className="text-muted">Támadó/védő erősség a liga-átlaghoz viszonyítva → λ paraméterek → teljes eredmény-eloszlás (1X2, gólszám, BTTS, pontos eredmény). Kis mintánál zsugorítás a liga-átlag felé.</p>
          </div>
          <div>
            <h4 className="font-semibold">4. Érték, tippek, adatminőség</h4>
            <p className="text-muted">Modell vs. implikált valószínűség (1/odds); tippgenerátor három kockázati kategóriában mellette/ellene érvekkel; átlátható adatminőség-mutató, amely nem nyerési esély.</p>
          </div>
        </div>
      </Card>
      <Disclaimer />
    </div>
  );
}
