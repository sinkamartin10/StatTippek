/** "Mai tippek": nem rangsor – mérhető jellemzők szerint szűrhető lista, minden sornál látható, miért szerepel. */
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { marketType, type MarketType } from '@shared/engine/markets';
import { api } from '../lib/api';
import { fmtTime, odds as fo, pct, signed, todayKey, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, OriginBadge, QualityBadge } from '../components/ui';
import { FREE_DAILY_TIPS, LockedBlock, ProLock, usePlan } from '../auth/PlanContext';

const TYPES: MarketType[] = ['1X2', 'dupla esély', 'gólszám', 'BTTS', 'csapat gólszám', 'pontos eredmény', 'hendikep'];

export default function Tips() {
  const [date, setDate] = useState(todayKey());
  const [minProb, setMinProb] = useState(60);
  const [minDiff, setMinDiff] = useState(-100);
  const [minSample, setMinSample] = useState(10);
  const [minInd, setMinInd] = useState(2);
  const [types, setTypes] = useState<MarketType[]>(TYPES);
  const [cat, setCat] = useState('');
  const [quality, setQuality] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const tips = useAsync(() => api.tips(date), [date]);
  const { pro } = usePlan();

  const list = useMemo(() => (tips.data ?? []).filter((t) => {
    if (t.tip.modelProb * 100 < minProb) return false;
    if (minDiff > -100 && (t.tip.diffPoints == null || t.tip.diffPoints < minDiff)) return false;
    if (t.tip.sampleSize < minSample) return false;
    if (t.tip.supportingIndicators < minInd) return false;
    if (!types.includes(marketType(t.tip.market))) return false;
    if (cat && t.tip.category !== cat) return false;
    if (quality && t.dataQuality.level !== quality) return false;
    return true;
  }).sort((a, b) => a.kickoff.localeCompare(b.kickoff)), [tips.data, minProb, minDiff, minSample, minInd, types, cat, quality]);

  const toggleType = (t: MarketType) => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Mai tippek</h1>
        <p className="text-sm text-muted">Statisztikailag támogatott piacok a modell alapján. Nincs „legjobb tipp” pontszám – te választod ki a mérhető szűrőket.</p>
      </div>
      <Card title="Szűrők (mérhető jellemzők)">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-xs text-muted">Dátum<input type="date" className="input mt-1" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="text-xs text-muted">Modell-valószínűség legalább: <b className="text-text">{minProb}%</b><input type="range" min={0} max={95} step={5} className="mt-2 w-full accent-[#22c55e]" value={minProb} onChange={(e) => setMinProb(+e.target.value)} /></label>
          <label className="text-xs text-muted">Modell − implikált különbség legalább: <b className="text-text">{minDiff <= -100 ? 'nincs szűrés' : `${signed(minDiff, 0)} pp`}</b><input type="range" min={-100} max={20} step={1} className="mt-2 w-full accent-[#22c55e]" value={minDiff} onChange={(e) => setMinDiff(+e.target.value)} /><span className="text-[10px]">(−100 = nincs szűrés; odds nélküli sorok kiesnek, ha szűrsz)</span></label>
          <label className="text-xs text-muted">Minta legalább: <b className="text-text">{minSample} meccs</b><input type="range" min={0} max={20} className="mt-2 w-full accent-[#22c55e]" value={minSample} onChange={(e) => setMinSample(+e.target.value)} /></label>
          <label className="text-xs text-muted">Támogató mutatók legalább: <b className="text-text">{minInd}</b><input type="range" min={0} max={5} className="mt-2 w-full accent-[#22c55e]" value={minInd} onChange={(e) => setMinInd(+e.target.value)} /></label>
          <label className="text-xs text-muted">Kategória<select className="input mt-1" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Összes</option><option value="konzervatív">Konzervatív</option><option value="mérsékelt">Mérsékelt</option><option value="magas variancia">Magas variancia</option></select></label>
          <label className="text-xs text-muted">Adatminőség<select className="input mt-1" value={quality} onChange={(e) => setQuality(e.target.value)}><option value="">Összes</option><option value="magas">Magas</option><option value="közepes">Közepes</option><option value="kevés">Kevés</option></select></label>
          <div className="text-xs text-muted">Piactípus
            <div className="mt-1 flex flex-wrap gap-1">{TYPES.map((t) => <button key={t} className={`btn btn-sm ${types.includes(t) ? 'btn-primary' : ''}`} onClick={() => toggleType(t)}>{t}</button>)}</div>
          </div>
        </div>
      </Card>

      {tips.loading ? <Loading text="Modellek futtatása és friss hírek keresése minden mai mérkőzéshez – első betöltéskor akár 1 percig is tarthat, utána gyorsítótárból jön…" /> : tips.error ? <ErrorBox message={tips.error} onRetry={tips.reload} /> : list.length === 0 ? (
        <EmptyState title="Nincs a szűrőknek megfelelő piac" text={tips.data?.length ? `${tips.data.length} piac közül egy sem felel meg. Lazíts a szűrőkön.` : 'Erre a napra nincs elemezhető mérkőzés, vagy nem áll rendelkezésre elegendő adat.'} />
      ) : (
        <Card title={pro ? `${list.length} piac (kezdési idő szerint)` : `Napi ${FREE_DAILY_TIPS} tipp (FREE) – összesen ${list.length} piac`} right={!pro && list.length > FREE_DAILY_TIPS ? <ProLock label={`PRO: mind a ${list.length}`} /> : undefined}>
          <Note>Minden sor mutatja, miért jelenik meg: modell-valószínűség, támogató mutatók, minta, adatminőség. A megjelenés nem ajánlás.</Note>
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead><tr><th>Kezdés</th><th>Mérkőzés</th><th>Piac</th><th>Kat.</th><th>Modell</th><th>Odds</th><th>Különbség</th><th>Mutatók</th><th>Minta</th><th>Adatminőség</th><th></th></tr></thead>
              <tbody>
                {(pro ? list : list.slice(0, FREE_DAILY_TIPS)).map((t) => {
                  const key = t.matchId + t.tip.market;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td className="mono">{fmtTime(t.kickoff)}</td>
                        <td><Link to={`/meccs/${encodeURIComponent(t.matchId)}#tippek`} className="font-semibold hover:text-accent">{t.matchLabel}</Link><div className="flex items-center gap-1 text-xs text-muted">{t.leagueName} <OriginBadge origin={t.origin} small /></div></td>
                        <td>{t.tip.label}</td>
                        <td className="text-xs text-muted">{t.tip.category}</td>
                        <td className="mono font-semibold text-accent">{pct(t.tip.modelProb, 1)}</td>
                        <td className="mono">{fo(t.tip.odds)}</td>
                        <td className={`mono ${t.tip.diffPoints == null ? 'text-muted' : t.tip.diffPoints >= 3 ? 'text-accent' : t.tip.diffPoints <= -3 ? 'text-danger' : ''}`}>{t.tip.diffPoints != null ? `${signed(t.tip.diffPoints)} pp` : '–'}</td>
                        <td className="mono">{t.tip.supportingIndicators}/{t.tip.supportingStats.length}</td>
                        <td className="mono">{t.tip.sampleSize}</td>
                        <td><QualityBadge q={t.dataQuality} /></td>
                        <td>{pro ? <button className="btn btn-sm" onClick={() => setExpanded(expanded === key ? null : key)}>Miért?</button> : <ProLock label="Indoklás" />}</td>
                      </tr>
                      {pro && expanded === key && (
                        <tr>
                          <td colSpan={11} className="bg-bg-2/60">
                            <div className="grid gap-3 py-2 text-xs md:grid-cols-3">
                              <div><div className="mb-1 font-semibold text-accent">Mellette</div><ul className="list-disc pl-4">{t.tip.reasonsFor.map((r) => <li key={r}>{r}</li>)}</ul></div>
                              <div><div className="mb-1 font-semibold text-danger">Ellene</div><ul className="list-disc pl-4">{t.tip.reasonsAgainst.length ? t.tip.reasonsAgainst.map((r) => <li key={r}>{r}</li>) : <li className="text-muted">nincs</li>}</ul></div>
                              <div><div className="mb-1 font-semibold text-warn">Kockázatok</div><ul className="list-disc pl-4">{t.tip.risks.map((r) => <li key={r}>{r}</li>)}</ul></div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!pro && list.length > FREE_DAILY_TIPS && (
            <div className="mt-3"><LockedBlock title={`További ${list.length - FREE_DAILY_TIPS} tipp PRO-val`} text="A FREE csomagban naponta 3 tipp látható. A teljes lista, a modell indoklásai és a részletes statisztikák PRO előfizetéssel érhetők el." compact /></div>
          )}
        </Card>
      )}
      <Disclaimer />
    </div>
  );
}
