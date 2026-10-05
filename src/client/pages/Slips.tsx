/**
 * Szelvény: kézi szelvényépítő (mai tippekből) + automatikus összeállítás három stratégiával.
 * Csak valódi, internetről lekért oddsokkal dolgozik – odds nélküli piac nem kerül szelvényre.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, ExternalLink, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { Slip, SlipStrategy, TipListEntry } from '@shared/types';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime, odds as fo, pct, signed, todayKey, useAsync } from '../lib/format';
import { Accordion, Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { LockedBlock, usePlan } from '../auth/PlanContext';

const STRATEGY_INFO: Record<SlipStrategy, { title: string; desc: string }> = {
  'legnagyobb esély': { title: 'Legnagyobb esély', desc: 'A lábak modell-valószínűségének szorzata a lehető legnagyobb, az összodds alsó korlátja mellett.' },
  'kiegyensúlyozott': { title: 'Kiegyensúlyozott', desc: 'Magas együttes esély, de a magasabb oddsot enyhén jutalmazza – közepes összodds.' },
  'modell-előny': { title: 'Modell-előny', desc: 'Csak olyan lábak, ahol a modell a piacnál magasabb esélyt becsül; a modell-valószínűség × odds szorzatot maximalizálja. Kockázatosabb – a modell tévedését is felnagyítja.' },
};

interface Pick { matchId: string; market: string; label: string; matchLabel: string; leagueName: string; kickoff: string; odds: number; modelProb: number }

export default function Slips() {
  const { pro } = usePlan();

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🎫"
        title="Szelvény"
        text="Állítsd össze a saját szelvényedet a mai tippekből, vagy kérj automatikus kombinációt. Az együttes esély a lábak modell-becsléseinek szorzata – nincs biztos szelvény."
      />

      <Note tone="warn">
        <b>Minél több láb, annál kisebb az együttes esély.</b> Három 80%-os láb együtt ~51%, öt 80%-os láb ~33%. A modell gólstatisztikákra épül; a fogadóirodák oddsai általában jól kalibráltak, ezért a nagy „modellkülönbség” gyakran a modell hibáját jelzi. A szelvények elemzési kiindulópontok, nem ajánlások.
      </Note>

      {!pro ? (
        <LockedBlock title="Szelvényépítő – PRO" text="A szelvényépítő és a modell szerint legnagyobb esélyű kombinációk valódi oddsokkal, három stratégiával – PRO előfizetéssel." />
      ) : <SlipWorkspace />}

      <Disclaimer />
    </div>
  );
}

/** PRO munkaterület: kézi építő + automatikus összeállítás + mentett szelvények. */
function SlipWorkspace() {
  const [date, setDate] = useState(todayKey());
  const [picks, setPicks] = useState<Pick[]>([]);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tips = useAsync(() => api.tips(date), [date]);
  const saved = useAsync(() => api.savedSlips(), []);

  const candidates = useMemo(
    () => (tips.data ?? []).filter((t) => t.tip.odds != null && t.tip.odds > 1).sort((a, b) => b.tip.modelProb - a.tip.modelProb),
    [tips.data],
  );

  const totalOdds = picks.reduce((a, p) => a * p.odds, 1);
  const jointProb = picks.reduce((a, p) => a * p.modelProb, 1);
  const hasMatch = (matchId: string) => picks.some((p) => p.matchId === matchId);

  const add = (t: TipListEntry) => {
    if (t.tip.odds == null) return;
    if (picks.length >= 8) { setMsg({ tone: 'warn', text: 'Egy szelvényre legfeljebb 8 láb kerülhet.' }); return; }
    if (hasMatch(t.matchId)) { setMsg({ tone: 'warn', text: 'Egy mérkőzés csak egyszer szerepelhet a szelvényen.' }); return; }
    setMsg(null);
    setPicks([...picks, { matchId: t.matchId, market: t.tip.market, label: t.tip.label, matchLabel: t.matchLabel, leagueName: t.leagueName, kickoff: t.kickoff, odds: t.tip.odds, modelProb: t.tip.modelProb }]);
  };
  const remove = (matchId: string, market: string) => { setMsg(null); setPicks(picks.filter((p) => !(p.matchId === matchId && p.market === market))); };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.saveSlip('kiegyensúlyozott', `Saját szelvény – ${picks.length} láb`, picks.map((p) => ({ matchId: p.matchId, market: p.market })));
      setMsg({ tone: 'info', text: 'A szelvény elmentve. A lábak lezárása után az Előzményekben látod, bejött-e.' });
      setPicks([]);
      saved.reload();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  return (
    <>
      {/* ---------------- Kézi szelvény ---------------- */}
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* Választható tippek */}
        <Card
          title="Tippek hozzáadása"
          right={<input type="date" className="input !w-auto !py-2" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Dátum" />}
        >
          {tips.loading ? <Loading text="Mérkőzések elemzése és oddsok lekérése…" />
            : tips.error ? <ErrorBox message={tips.error} onRetry={tips.reload} />
              : candidates.length === 0 ? <EmptyState emoji="🤷" title="Nincs oddsszal rendelkező piac erre a napra" text="Válassz másik napot – odds nélküli piac nem kerülhet szelvényre." />
                : (
                  <ul className="space-y-2">
                    {candidates.slice(0, 40).map((t) => {
                      const picked = picks.some((p) => p.matchId === t.matchId && p.market === t.tip.market);
                      const blocked = !picked && hasMatch(t.matchId);
                      return (
                        <li key={t.matchId + t.tip.market} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card-2 p-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-extrabold">{t.matchLabel}</div>
                            <div className="truncate text-xs font-semibold text-text-muted">{t.tip.label} · {t.leagueName} · <span className="mono">{fmtTime(t.kickoff)}</span></div>
                          </div>
                          <div className="mono text-right text-xs font-bold">
                            <div className="text-base font-extrabold">{fo(t.tip.odds)}</div>
                            <div className="text-text-muted">modell {pct(t.tip.modelProb, 0)}</div>
                          </div>
                          <button
                            className={`btn btn-sm ${picked ? '' : 'btn-primary'}`}
                            onClick={() => (picked ? remove(t.matchId, t.tip.market) : add(t))}
                            disabled={blocked}
                            title={blocked ? 'Erről a mérkőzésről már van láb a szelvényen' : undefined}
                          >
                            {picked ? <><Trash2 className="h-3.5 w-3.5" /> Törlés</> : <><Plus className="h-3.5 w-3.5" /> Hozzáadás</>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
        </Card>

        {/* Mai szelvény */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <Card title="🎫 Mai szelvény">
            {picks.length === 0 ? (
              <p className="text-sm font-semibold text-text-muted">Még nincs kiválasztott tipp. Adj hozzá legalább kettőt a bal oldali listából (egy mérkőzésről egy láb).</p>
            ) : (
              <ul className="space-y-2">
                {picks.map((p) => (
                  <li key={p.matchId + p.market} className="flex items-start gap-2 rounded-xl border border-border bg-card-2 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-extrabold">{p.matchLabel}</div>
                      <div className="truncate text-xs font-semibold text-text-muted">{p.label} · <span className="mono">{fmtTime(p.kickoff)}</span></div>
                    </div>
                    <span className="mono shrink-0 text-sm font-extrabold">{fo(p.odds)}</span>
                    <button className="btn btn-sm btn-ghost !px-2" onClick={() => remove(p.matchId, p.market)} aria-label={`${p.matchLabel} törlése a szelvényről`}><Trash2 className="h-4 w-4 text-danger" /></button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-border bg-card-2 p-3 text-center">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Összodds</div>
                <div className="mono text-2xl font-extrabold">{picks.length ? fo(totalOdds) : '–'}</div>
              </div>
              <div className="rounded-xl border border-primary/20 bg-primary-soft p-3 text-center">
                <div className="text-[11px] font-extrabold uppercase tracking-wide text-primary-strong">Modell esély</div>
                <div className="mono text-2xl font-extrabold">{picks.length ? pct(jointProb, 1) : '–'}</div>
              </div>
            </div>

            <button className="btn btn-primary btn-lg mt-4 w-full" onClick={save} disabled={busy || picks.length < 2}>
              <Bookmark className="h-4 w-4" /> {busy ? 'Mentés…' : 'Szelvény mentése'}
            </button>
            {picks.length === 1 && <p className="mt-2 text-xs font-semibold text-text-muted">Legalább 2 láb kell a mentéshez.</p>}
            {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}
          </Card>
        </div>
      </div>

      {/* ---------------- Automatikus összeállítás ---------------- */}
      <AutoSlips onSaved={saved.reload} />

      {/* ---------------- Mentett szelvények ---------------- */}
      <Card title="Mentett szelvények" right={<Link to="/elozmenyek" className="btn btn-sm">Előzmények</Link>}>
        {saved.loading ? <Loading /> : saved.error ? <ErrorBox message={saved.error} /> : !saved.data?.length ? (
          <p className="text-sm font-semibold text-text-muted">Még nincs mentett szelvény. A lábak lezárása után itt és az Előzményekben látod, bejött-e.</p>
        ) : (
          <ul className="divide-y divide-border">
            {saved.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-extrabold">{s.label}</div>
                  <div className="truncate text-xs font-semibold text-text-muted">{s.strategy} · {fmtDateTime(s.createdAt)} · {s.legs.length} láb</div>
                </div>
                <div className="mono text-right text-xs font-bold text-text-muted"><div>összodds {fo(s.totalOdds)}</div><div>modell {pct(s.jointProb, 1)}</div></div>
                <span className={`badge ${s.outcome === 'nyert' ? 'badge-green' : s.outcome === 'vesztett' ? 'badge-red' : s.outcome === 'érvénytelen' ? 'badge-muted' : 'badge-yellow'}`}>{s.outcome}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** Automatikus összeállítás: a szerver beam-search alapú szelvényajánlatai. */
function AutoSlips({ onSaved }: { onSaved: () => void }) {
  const [from, setFrom] = useState(todayKey());
  const [to, setTo] = useState(todayKey(6));
  const [legs, setLegs] = useState(3);
  const [minOdds, setMinOdds] = useState('1.5');
  const [minLegProb, setMinLegProb] = useState(55);
  const [strategy, setStrategy] = useState<'' | SlipStrategy>('');
  const [params, setParams] = useState<Record<string, string | undefined> | null>(null);
  const r = useAsync(() => (params ? api.slips(params) : Promise.resolve(null)), [params]);

  const run = () => setParams({ from, to, legs: String(legs), minOdds: minOdds.replace(',', '.'), minLegProb: String(minLegProb / 100), strategy: strategy || undefined });
  const preset = (a: number, b: number) => { setFrom(todayKey(a)); setTo(todayKey(b)); };

  return (
    <section className="space-y-4">
      <Accordion label="Automatikus összeállítás (stratégiák)" icon={<SlidersHorizontal className="h-4 w-4 text-primary" />}>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="field-label">Időszak kezdete<input type="date" className="input mt-1.5" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field-label">Időszak vége<input type="date" className="input mt-1.5" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field-label">Lábak száma: <b className="text-text">{legs}</b><input type="range" min={2} max={6} className="mt-2 w-full accent-[#4f6ef7]" value={legs} onChange={(e) => setLegs(+e.target.value)} /></label>
          <label className="field-label">Összodds legalább<input className="input mt-1.5" inputMode="decimal" value={minOdds} onChange={(e) => setMinOdds(e.target.value)} /></label>
          <label className="field-label">Láb modell-esély legalább: <b className="text-text">{minLegProb}%</b><input type="range" min={30} max={90} step={5} className="mt-2 w-full accent-[#4f6ef7]" value={minLegProb} onChange={(e) => setMinLegProb(+e.target.value)} /></label>
          <label className="field-label">Stratégia<select className="input mt-1.5" value={strategy} onChange={(e) => setStrategy(e.target.value as '' | SlipStrategy)}><option value="">Mindhárom</option>{(Object.keys(STRATEGY_INFO) as SlipStrategy[]).map((k) => <option key={k} value={k}>{STRATEGY_INFO[k].title}</option>)}</select></label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="chip" onClick={() => preset(0, 0)}>Ma</button>
          <button className="chip" onClick={() => preset(1, 1)}>Holnap</button>
          <button className="chip" onClick={() => preset(0, 6)}>Következő 7 nap</button>
          <div className="flex-1" />
          <button className="btn btn-primary" onClick={run}>Szelvények összeállítása</button>
        </div>
      </Accordion>

      {!params ? null : r.loading ? <Card><Loading text="Mérkőzések elemzése, oddsok és hírek lekérése az időszakra – első alkalommal ez több percig is tarthat…" /></Card>
        : r.error ? <ErrorBox message={r.error} onRetry={r.reload} />
          : r.data && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatCard icon="⚽" tone="neutral" label="Elemzett mérkőzés" value={r.data.matchesAnalyzed} sub={`${r.data.from} – ${r.data.to}`} />
                <StatCard icon="💰" tone="warning" label="Oddsszal" value={r.data.matchesWithOdds} sub="internetről lekért odds" />
                <StatCard icon="🧩" tone="primary" label="Jelölt lábak" value={r.data.candidateLegs} sub="piac valódi oddsszal" />
                <StatCard icon="🎫" tone="success" label="Szelvény" value={r.data.slips.length} sub="stratégiánként legfeljebb 3" />
              </div>
              {r.data.notes.map((n) => <Note key={n} tone="warn">{n}</Note>)}
              {r.data.slips.length === 0 && r.data.notes.length === 0 && <EmptyState emoji="🧩" title="Nem áll össze szelvény" text="Lazíts a feltételeken (kevesebb láb, alacsonyabb összodds vagy láb-esély)." />}
              {(Object.keys(STRATEGY_INFO) as SlipStrategy[]).map((st) => {
                const list = r.data!.slips.filter((s) => s.strategy === st);
                if (!list.length) return null;
                return (
                  <section key={st}>
                    <h2 className="section-title">{STRATEGY_INFO[st].title}</h2>
                    <p className="mb-3 text-xs font-semibold text-text-muted">{STRATEGY_INFO[st].desc}</p>
                    <div className="grid gap-4 xl:grid-cols-3">{list.map((s) => <SlipCard key={s.id} slip={s} onSaved={onSaved} />)}</div>
                  </section>
                );
              })}
            </>
          )}
    </section>
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
    <div className="card card-lift flex flex-col p-4">
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-card-2 p-2.5"><div className="text-[10px] font-extrabold uppercase tracking-wide text-text-muted">Összodds</div><div className="mono text-xl font-extrabold">{fo(slip.totalOdds)}</div></div>
        <div className="rounded-xl bg-primary-soft p-2.5"><div className="text-[10px] font-extrabold uppercase tracking-wide text-primary-strong">Modell esély</div><div className="mono text-xl font-extrabold">{pct(slip.jointProb, 1)}</div></div>
        <div className="rounded-xl bg-card-2 p-2.5"><div className="text-[10px] font-extrabold uppercase tracking-wide text-text-muted">Odds szerint</div><div className="mono text-xl font-extrabold">{pct(slip.impliedJointProb, 1)}</div></div>
      </div>
      <ul className="flex-1 space-y-2">
        {slip.legs.map((l) => (
          <li key={l.matchId + l.market} className="rounded-xl border border-border bg-card-2 p-2.5 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link to={`/meccs/${encodeURIComponent(l.matchId)}#tippek`} className="block truncate font-extrabold transition hover:text-primary">{l.matchLabel}</Link>
                <div className="text-xs font-semibold text-text-muted">{l.leagueName} · {fmtDateTime(l.kickoff).slice(0, 13)} {fmtTime(l.kickoff)}</div>
              </div>
              <div className="mono shrink-0 text-right"><div className="font-extrabold">{fo(l.odds)}</div><div className="text-xs font-bold text-primary">{pct(l.modelProb)}</div></div>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className="font-extrabold">{l.label}</span>
              <span className={`mono ${l.diffPoints >= 3 ? 'text-success' : l.diffPoints <= -3 ? 'text-danger' : 'text-text-muted'}`}>{signed(l.diffPoints, 1)} pp</span>
              <span className="text-text-muted">{l.supportingIndicators} mutató · {l.dataQuality} adat</span>
              {l.bookmaker && <span className="text-text-muted">· {l.bookmaker}</span>}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 text-xs font-semibold text-text-muted">
        Modell − odds szerinti esély: <b className={slip.diffPoints >= 0 ? 'text-success' : 'text-danger'}>{signed(slip.diffPoints, 1)} pp</b> · várható visszatérülés 1 egységre a modell szerint: <b>{slip.expectedReturn.toFixed(2).replace('.', ',')}</b> (nem ígéret)
      </div>
      <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] font-semibold text-warning">{slip.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      <div className="mt-3 flex items-center gap-2">
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}><Bookmark className="h-3.5 w-3.5" /> Szelvény mentése</button>
        {msg && <span className="text-xs font-semibold text-text-muted">{msg}</span>}
        <div className="flex-1" />
        <Link to={`/meccs/${encodeURIComponent(slip.legs[0].matchId)}`} className="text-xs font-bold text-text-muted transition hover:text-primary"><ExternalLink className="inline h-3 w-3" /> részletek</Link>
      </div>
    </div>
  );
}
