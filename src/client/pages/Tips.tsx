/** „Tippek”: nem rangsor – mérhető jellemzők szerint szűrhető lista tipp-kártyákkal. */
import { useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { marketType, type MarketType } from '@shared/engine/markets';
import { api } from '../lib/api';
import { signed, todayKey, useAsync } from '../lib/format';
import { useUrlState } from '../lib/listState';
import { Accordion, Card, ChipGroup, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { TipCard } from '../components/TipCard';
import { FREE_DAILY_TIPS, LockedBlock, usePlan } from '../auth/PlanContext';

const TYPES: MarketType[] = ['1X2', 'dupla esély', 'gólszám', 'BTTS', 'csapat gólszám', 'pontos eredmény', 'hendikep'];

export default function Tips() {
  // A nap az URL-ben: a tipp megnyitása után a „Vissza” ugyanide hoz vissza
  const [params, setParams] = useUrlState({ date: todayKey() }, ['date']);
  const date = params.date;
  const setDate = (v: string) => setParams({ date: v });
  const [minProb, setMinProb] = useState(60);
  const [minDiff, setMinDiff] = useState(-100);
  const [minSample, setMinSample] = useState(10);
  const [minInd, setMinInd] = useState(2);
  const [types, setTypes] = useState<MarketType[]>(TYPES);
  const [cat, setCat] = useState('');
  const [quality, setQuality] = useState('');
  const tips = useAsync(() => api.tips(date), [date], `tips:${date}`);
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
  const shown = pro ? list : list.slice(0, FREE_DAILY_TIPS);

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🎯"
        title="Tippek"
        text="Statisztikailag támogatott piacok a modell alapján. Nincs „legjobb tipp” pontszám – te állítod be a mérhető szűrőket."
        right={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="tips-date">Dátum</label>
            <input id="tips-date" type="date" className="input !w-auto" value={date} onChange={(e) => setDate(e.target.value)} />
            <ChipGroup
              ariaLabel="Nap választása"
              value={date}
              onChange={setDate}
              options={[{ value: todayKey(), label: 'Ma' }, { value: todayKey(1), label: 'Holnap' }]}
            />
          </div>
        }
      />

      <Accordion label="Szűrők (mérhető jellemzők)" icon={<SlidersHorizontal className="h-4 w-4 text-primary" />}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label className="field-label">Modell-valószínűség legalább: <b className="text-text">{minProb}%</b>
            <input type="range" min={0} max={95} step={5} className="mt-2 w-full accent-[#4f6ef7]" value={minProb} onChange={(e) => setMinProb(+e.target.value)} />
          </label>
          <label className="field-label">Modell − odds szerinti különbség legalább: <b className="text-text">{minDiff <= -100 ? 'nincs szűrés' : `${signed(minDiff, 0)} pp`}</b>
            <input type="range" min={-100} max={20} step={1} className="mt-2 w-full accent-[#4f6ef7]" value={minDiff} onChange={(e) => setMinDiff(+e.target.value)} />
            <span className="block text-[10px] text-text-muted">(−100 = nincs szűrés; odds nélküli sorok kiesnek, ha szűrsz)</span>
          </label>
          <label className="field-label">Minta legalább: <b className="text-text">{minSample} meccs</b>
            <input type="range" min={0} max={20} className="mt-2 w-full accent-[#4f6ef7]" value={minSample} onChange={(e) => setMinSample(+e.target.value)} />
          </label>
          <label className="field-label">Támogató mutatók legalább: <b className="text-text">{minInd}</b>
            <input type="range" min={0} max={5} className="mt-2 w-full accent-[#4f6ef7]" value={minInd} onChange={(e) => setMinInd(+e.target.value)} />
          </label>
          <label className="field-label">Kategória
            <select className="input mt-1.5" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Összes</option><option value="konzervatív">Konzervatív</option><option value="mérsékelt">Mérsékelt</option><option value="magas variancia">Magas variancia</option>
            </select>
          </label>
          <label className="field-label">Adatminőség
            <select className="input mt-1.5" value={quality} onChange={(e) => setQuality(e.target.value)}>
              <option value="">Összes</option><option value="magas">Magas</option><option value="közepes">Közepes</option><option value="kevés">Kevés</option>
            </select>
          </label>
          <div className="field-label md:col-span-2 xl:col-span-3">Piactípus
            <div className="mt-2 flex flex-wrap gap-2">
              {TYPES.map((t) => (
                <button key={t} type="button" aria-pressed={types.includes(t)} className={`chip ${types.includes(t) ? 'chip-active' : ''}`} onClick={() => toggleType(t)}>{t}</button>
              ))}
            </div>
          </div>
        </div>
      </Accordion>

      {tips.loading ? <Card><Loading text="Modellek futtatása és friss hírek keresése minden mérkőzéshez – első betöltéskor akár 1 percig is tarthat, utána gyorsítótárból jön…" /></Card>
        : tips.error ? <ErrorBox message={tips.error} onRetry={tips.reload} />
          : list.length === 0 ? (
            <EmptyState
              emoji="🧐"
              title="Nincs a szűrőknek megfelelő piac"
              text={tips.data?.length ? `${tips.data.length} piac közül egy sem felel meg. Lazíts a szűrőkön.` : 'Erre a napra nincs elemezhető mérkőzés, vagy nem áll rendelkezésre elegendő adat.'}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="section-title mb-0">{pro ? `${list.length} piac (kezdési idő szerint)` : `Napi ${FREE_DAILY_TIPS} tipp – összesen ${list.length} piac`}</h2>
              </div>
              <Note>Minden kártya megmutatja, miért jelenik meg: modell-valószínűség, támogató mutatók, minta és adatminőség. A megjelenés statisztikai elemzés, nem ajánlás.</Note>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {shown.map((t) => <TipCard key={t.matchId + t.tip.market} entry={t} pro={pro} />)}
              </div>
              {!pro && list.length > FREE_DAILY_TIPS && (
                <LockedBlock
                  title={`További ${list.length - FREE_DAILY_TIPS} tipp PRO-val`}
                  text={`A FREE csomagban naponta ${FREE_DAILY_TIPS} tipp látható. A teljes lista, a modell indoklásai és a részletes statisztikák PRO előfizetéssel érhetők el.`}
                />
              )}
            </>
          )}
      <Disclaimer />
    </div>
  );
}
