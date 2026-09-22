/** Szelvényépítő: a modell szerint legnagyobb együttes esélyű kombinációk valódi oddsokkal. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, ExternalLink } from 'lucide-react';
import type { Slip, SlipStrategy } from '@shared/types';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime, odds as fo, pct, signed, todayKey, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, OriginBadge, Stat } from '../components/ui';
import { LockedBlock, ProLock, usePlan } from '../auth/PlanContext';

const STRATEGY_INFO: Record<SlipStrategy, { title: string; desc: string }> = {
  'legnagyobb esély': { title: 'Legnagyobb esély', desc: 'A lábak modell-valószínűségének szorzata a lehető legnagyobb, az összodds alsó korlátja mellett.' },
  'kiegyensúlyozott': { title: 'Kiegyensúlyozott', desc: 'Magas együttes esély, de a magasabb oddsot enyhén jutalmazza – közepes összodds.' },
  'modell-előny': { title: 'Modell-előny', desc: 'Csak olyan lábak, ahol a modell a piacnál magasabb esélyt becsül; a modell-valószínűség × odds szorzatot maximalizálja. Kockázatosabb – a modell tévedését is felnagyítja.' },
};

export default function Slips() {
  const [from, setFrom] = useState(todayKey());
  const [to, setTo] = useState(todayKey(6));
  const [legs, setLegs] = useState(3);
  const [minOdds, setMinOdds] = useState('1.5');
  const [minLegProb, setMinLegProb] = useState(55);
  const [strategy, setStrategy] = useState<'' | SlipStrategy>('');
  const [params, setParams] = useState<Record<string, string | undefined>>({ from, to, legs: '3', minOdds: '1.5', minLegProb: '0.55' });
  const { pro } = usePlan();
  const r = useAsync(() => (pro ? api.slips(params) : Promise.resolve(null)), [params, pro]);
  const saved = useAsync(() => (pro ? api.savedSlips() : Promise.resolve([])), [pro]);

  const run = () => setParams({ from, to, legs: String(legs), minOdds: minOdds.replace(',', '.'), minLegProb: String(minLegProb / 100), strategy: strategy || undefined });
  const preset = (a: number, b: number) => { setFrom(todayKey(a)); setTo(todayKey(b)); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">Szelvényépítő {!pro && <ProLock />}</h1>
        <p className="text-sm text-muted">Több mérkőzés egy-egy piacából összeállított kombinációk, amelyeknek a <b>modell szerint</b> a legnagyobb az együttes esélye. Csak valódi, internetről lekért oddsokkal dolgozik – odds nélküli piac nem kerül szelvényre.</p>
      </div>

      <Note tone="warn">
        <b>Nincs biztos szelvény.</b> Az együttes esély a lábak modell-becsléseinek szorzata (függetlenséget feltételezve): három 80%-os láb együtt ~51%, öt 80%-os láb ~33%. A modell csak gólstatisztikákra épül; az odds-források (fogadóirodák) általában jól kalibráltak, ezért a nagy „modellkülönbség” gyakran a modell hibáját jelzi. A szelvények elemzési kiindulópontok, nem ajánlások.
      </Note>

      {!pro && <LockedBlock title="Szelvényépítő – PRO" text="A modell szerint legnagyobb esélyű kombinációk valódi oddsokkal, három stratégiával – PRO előfizetéssel." />}
      {pro && <Card title="Beállítások">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <label className="text-xs text-muted">Időszak kezdete<input type="date" className="input mt-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-xs text-muted">Időszak vége<input type="date" className="input mt-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="text-xs text-muted">Lábak száma: <b className="text-text">{legs}</b><input type="range" min={2} max={6} className="mt-2 w-full accent-[#22c55e]" value={legs} onChange={(e) => setLegs(+e.target.value)} /></label>
          <label className="text-xs text-muted">Összodds legalább<input className="input mt-1" inputMode="decimal" value={minOdds} onChange={(e) => setMinOdds(e.target.value)} /></label>
          <label className="text-xs text-muted">Láb modell-esély legalább: <b className="text-text">{minLegProb}%</b><input type="range" min={30} max={90} step={5} className="mt-2 w-full accent-[#22c55e]" value={minLegProb} onChange={(e) => setMinLegProb(+e.target.value)} /></label>
          <label className="text-xs text-muted">Stratégia<select className="input mt-1" value={strategy} onChange={(e) => setStrategy(e.target.value as '' | SlipStrategy)}><option value="">Mindhárom</option>{(Object.keys(STRATEGY_INFO) as SlipStrategy[]).map((k) => <option key={k} value={k}>{STRATEGY_INFO[k].title}</option>)}</select></label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-sm" onClick={() => preset(0, 0)}>Ma</button>
          <button className="btn btn-sm" onClick={() => preset(1, 1)}>Holnap</button>
          <button className="btn btn-sm" onClick={() => preset(0, 6)}>Következő 7 nap</button>
          <div className="flex-1" />
          <button className="btn btn-primary" onClick={run}>Szelvények összeállítása</button>
        </div>
      </Card>}

      {!pro ? null : r.loading ? <Loading text="Mérkőzések elemzése, oddsok és hírek lekérése az időszakra – első alkalommal ez több percig is tarthat (utána gyorsítótárból jön)…" /> : r.error ? <ErrorBox message={r.error} onRetry={r.reload} /> : r.data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Elemzett mérkőzés" value={r.data.matchesAnalyzed} sub={`${r.data.from} – ${r.data.to}`} />
            <Stat label="Oddsszal rendelkező" value={r.data.matchesWithOdds} sub="internetről lekért odds" />
            <Stat label="Jelölt lábak" value={r.data.candidateLegs} sub="piac valódi oddsszal" />
            <Stat label="Szelvény" value={r.data.slips.length} sub="stratégiánként legfeljebb 3" />
          </div>
          {r.data.notes.map((n) => <Note key={n} tone="warn">{n}</Note>)}
          {r.data.slips.length === 0 && r.data.notes.length === 0 && <EmptyState title="Nem áll össze szelvény" text="Lazíts a feltételeken (kevesebb láb, alacsonyabb összodds vagy láb-esély)." />}
          {(Object.keys(STRATEGY_INFO) as SlipStrategy[]).map((st) => {
            const list = r.data!.slips.filter((s) => s.strategy === st);
            if (!list.length) return null;
            return (
              <section key={st}>
                <h2 className="section-title">{STRATEGY_INFO[st].title} <span className="text-xs font-normal text-muted">– {STRATEGY_INFO[st].desc}</span></h2>
                <div className="grid gap-4 xl:grid-cols-3">{list.map((s) => <SlipCard key={s.id} slip={s} onSaved={saved.reload} />)}</div>
              </section>
            );
          })}
        </>
      )}

      {pro && <Card title="Mentett szelvények" right={<Link to="/elozmenyek" className="btn btn-sm">Előzmények</Link>}>
        {saved.loading ? <Loading /> : saved.error ? <ErrorBox message={saved.error} /> : !saved.data?.length ? <div className="text-sm text-muted">Még nincs mentett szelvény. A „Szelvény mentése” gombbal rögzítheted – a lábak lezárása után itt és az Előzményekben látod, bejött-e.</div> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Mentve</th><th>Szelvény</th><th>Lábak</th><th>Összodds</th><th>Modell esély</th><th>Kimenet</th></tr></thead>
              <tbody>
                {saved.data.map((s) => (
                  <tr key={s.id}>
                    <td className="mono whitespace-nowrap text-xs">{fmtDateTime(s.createdAt)}</td>
                    <td><div className="font-semibold">{s.label}</div><div className="text-xs text-muted">{s.strategy} <OriginBadge origin={s.origin} small /></div></td>
                    <td className="text-xs">{s.legs.map((l) => <div key={l.id}><span className={l.outcome === 'nyert' ? 'text-accent' : l.outcome === 'vesztett' ? 'text-danger' : 'text-muted'}>●</span> {l.matchLabel} – {l.marketLabel} ({fo(l.odds)}){l.homeGoals != null && <span className="mono text-muted"> {l.homeGoals}–{l.awayGoals}</span>}</div>)}</td>
                    <td className="mono font-semibold">{fo(s.totalOdds)}</td>
                    <td className="mono">{pct(s.jointProb, 1)}</td>
                    <td><span className={`badge ${s.outcome === 'nyert' ? 'badge-green' : s.outcome === 'vesztett' ? 'badge-red' : s.outcome === 'érvénytelen' ? 'badge-muted' : 'badge-yellow'}`}>{s.outcome}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>}
      <Disclaimer />
    </div>
  );
}

function SlipCard({ slip, onSaved }: { slip: Slip; onSaved: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.saveSlip(slip.strategy, `${slip.legs.length} lábú – ${STRATEGY_INFO[slip.strategy].title}`, slip.legs.map((l) => ({ matchId: l.matchId, market: l.market })));
      setMsg('Mentve.'); onSaved();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card flex flex-col p-4">
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md bg-bg-2 p-2"><div className="text-[10px] uppercase tracking-wider text-muted">Összodds</div><div className="mono text-xl font-bold">{fo(slip.totalOdds)}</div></div>
        <div className="rounded-md bg-accent/10 p-2"><div className="text-[10px] uppercase tracking-wider text-muted">Modell esély</div><div className="mono text-xl font-bold text-accent">{pct(slip.jointProb, 1)}</div></div>
        <div className="rounded-md bg-bg-2 p-2"><div className="text-[10px] uppercase tracking-wider text-muted">Implikált (1/odds)</div><div className="mono text-xl font-bold">{pct(slip.impliedJointProb, 1)}</div></div>
      </div>
      <ul className="flex-1 space-y-2">
        {slip.legs.map((l) => (
          <li key={l.matchId + l.market} className="rounded-lg border border-border bg-bg-2/60 p-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link to={`/meccs/${encodeURIComponent(l.matchId)}#tippek`} className="block truncate font-semibold hover:text-accent">{l.matchLabel}</Link>
                <div className="text-xs text-muted">{l.leagueName} · {fmtDateTime(l.kickoff).slice(0, 13)} {fmtTime(l.kickoff)}</div>
              </div>
              <div className="mono shrink-0 text-right"><div className="font-bold">{fo(l.odds)}</div><div className="text-xs text-accent">{pct(l.modelProb)}</div></div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{l.label}</span>
              <span className={`mono ${l.diffPoints >= 3 ? 'text-accent' : l.diffPoints <= -3 ? 'text-danger' : 'text-muted'}`}>{signed(l.diffPoints, 1)} pp</span>
              <span className="text-muted">{l.supportingIndicators} mutató · {l.dataQuality} adat</span>
              {l.bookmaker && <span className="text-muted">· {l.bookmaker}</span>}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 text-xs text-muted">Modell − implikált: <b className={slip.diffPoints >= 0 ? 'text-accent' : 'text-danger'}>{signed(slip.diffPoints, 1)} pp</b> · várható visszatérülés 1 egységre a modell szerint: <b>{slip.expectedReturn.toFixed(2).replace('.', ',')}</b> (nem ígéret)</div>
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] text-warn">{slip.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      <div className="mt-3 flex items-center gap-2">
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}><Bookmark className="h-3.5 w-3.5" /> Szelvény mentése</button>
        {msg && <span className="text-xs text-muted">{msg}</span>}
        <div className="flex-1" />
        <Link to={`/meccs/${encodeURIComponent(slip.legs[0].matchId)}`} className="text-xs text-muted hover:text-accent"><ExternalLink className="inline h-3 w-3" /> részletek</Link>
      </div>
    </div>
  );
}
