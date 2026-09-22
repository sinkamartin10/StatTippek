/** Beállítások: adatmód és szolgáltatók állapota (kulcsok nélkül), modellparaméter, felelős játék. */
import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { Card, Disclaimer, ErrorBox, Loading, Note, OriginBadge } from '../components/ui';

export default function Settings() {
  const s = useAsync(() => api.settings(), []);
  const [k, setK] = useState('3');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (s.data) setK(String(s.data.shrinkageK)); }, [s.data]);

  const save = async () => {
    setMsg(null);
    try { const r = await api.saveSettings(parseFloat(k.replace(',', '.'))); setMsg(`Mentve: k = ${r.shrinkageK}. Az elemzések újraszámolódnak.`); } catch (e) { setMsg((e as Error).message); }
  };

  if (s.loading) return <Loading />;
  if (s.error || !s.data) return <ErrorBox message={s.error ?? 'Hiba'} onRetry={s.reload} />;
  const st = s.data.status;
  const Row = ({ ok, label, detail }: { ok: boolean; label: string; detail: string }) => (
    <div className="flex items-start gap-2 text-sm">{ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" /> : <XCircle className="mt-0.5 h-4 w-4 text-muted" />}<div><b>{label}</b><div className="text-xs text-muted">{detail}</div></div></div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Beállítások</h1>
        <p className="text-sm text-muted">Adatforrások állapota és a modell paraméterei. Az API kulcsok kizárólag a szerver .env fájljában tárolódnak, a felület sosem látja őket.</p>
      </div>
      <Card title="Adatmód és szolgáltatók" right={<OriginBadge origin={st.dataMode} />}>
        <div className="grid gap-3 md:grid-cols-2">
          <Row ok={st.dataMode === 'live'} label={`Adatmód: ${st.dataMode === 'live' ? 'ÉLŐ' : 'DEMO'}`} detail={`Kért mód: ${st.requestedMode}. Meccsadat-szolgáltató: ${st.matchProvider}.`} />
          <Row ok={st.liveFootballApiConfigured} label="Bővített meccsadat API (API_FOOTBALL_KEY) – opcionális" detail={st.liveFootballApiConfigured ? 'Konfigurálva: API-Football szolgáltató (NB I / NB II is).' : 'Nincs beállítva – kulcs nélkül az ESPN nyilvános API adja a topligákat és a kupákat; a magyar NB I / NB II ehhez a kulcshoz kötött.'} />
          <Row ok={st.webSearchConfigured} label="Keresési API (TAVILY_API_KEY vagy BRAVE_SEARCH_API_KEY) – opcionális" detail={st.webSearchConfigured ? `Konfigurálva. Kutatómotor: ${st.researchProvider}` : `Nincs beállítva – kutatómotor: ${st.researchProvider} (valós idejű hírkeresés kulcs nélkül).`} />
          <Row ok={st.oddsApiConfigured} label="Odds forrás (ODDS_API_KEY) – opcionális" detail={`${st.oddsSource}. ${st.oddsApiConfigured ? 'Több fogadóiroda, piaconként a legjobb odds.' : 'Kulcs nélkül az ESPN által közölt (DraftKings) odds; The Odds API kulccsal több iroda legjobb ára és több piac (BTTS).'}`} />
          <Row ok={true} label="Adatbázis" detail="SQLite (node:sqlite) – előzmények, források, kézi odds, beállítások." />
        </div>
        {st.warnings.length > 0 && <div className="mt-3 space-y-2">{st.warnings.map((w) => <Note key={w} tone="warn">{w}</Note>)}</div>}
        <div className="mt-4 rounded-lg border border-border bg-bg-2/60 p-3 text-xs text-muted">
          <div className="mb-1 font-semibold text-text">Opcionális kulcsok (.env)</div>
          <pre className="mono whitespace-pre-wrap">{`API_FOOTBALL_KEY=…      # NB I / NB II és további ligák
TAVILY_API_KEY=…        # vagy BRAVE_SEARCH_API_KEY – teljes webes keresés
ODDS_API_KEY=…          # The Odds API – több fogadóiroda legjobb oddsa
DATA_MODE=demo          # csak teszteléshez: beépített DEMO ADAT`}</pre>
          Kulcs nélkül is élő adattal fut az alkalmazás (ESPN nyilvános API + hír-RSS). A demo és az élő adat sosem keveredik.
        </div>
      </Card>
      <Card title="Modellparaméter">
        <label className="block max-w-sm text-sm">Zsugorítási erősség (k) – hány „liga-átlagos” meccset keverünk a csapat mintájához
          <input className="input mt-1" inputMode="decimal" value={k} onChange={(e) => setK(e.target.value)} />
        </label>
        <p className="mt-1 max-w-xl text-xs text-muted">Képlet: erősség' = (n·erősség + k·1) / (n + k). k = 0: nincs zsugorítás (kis mintánál szélsőséges becslések); k = 3 (alapértelmezés): mérsékelt; k = 10: erős húzás a liga-átlag felé.</p>
        <div className="mt-3 flex items-center gap-3"><button className="btn btn-primary btn-sm" onClick={save}>Mentés</button>{msg && <span className="text-xs text-muted">{msg}</span>}</div>
      </Card>
      <Card title="Felelős játék">
        <p className="text-sm text-muted">Ez az alkalmazás elemző és kutató eszköz. Nem ad fogadási tanácsot, nem ösztönöz tétemelésre, és egyetlen tippet sem tekint biztosnak. Ha úgy érzed, hogy a szerencsejáték problémát okoz, kérj segítséget: Játékosvédelmi vonal 06 80 205 305 (ingyenes).</p>
      </Card>
      <Disclaimer />
    </div>
  );
}
