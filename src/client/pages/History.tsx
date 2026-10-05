/** Előzmények: a korábbi tippek átlátható követése – nyertes és vesztes egyaránt, utólag nem módosítható. */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import type { PredictionRecord } from '@shared/types';
import { MARKET_LABELS } from '@shared/engine/markets';
import { api } from '../lib/api';
import { fmtDateTime, odds as fo, pct, signed, useAsync } from '../lib/format';
import { Accordion, Card, ChipGroup, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { SimpleBarChart } from '../components/charts';
import { LockedBlock, usePlan } from '../auth/PlanContext';

type OutcomeFilter = 'mind' | 'nyert' | 'vesztett' | 'függőben';

const OUTCOME_UI: Record<string, { icon: string; cls: string; label: string }> = {
  'nyert': { icon: '✓', cls: 'text-success', label: 'Nyert' },
  'vesztett': { icon: '✕', cls: 'text-danger', label: 'Vesztes' },
  'függőben': { icon: '●', cls: 'text-warning', label: 'Függőben' },
  'érvénytelen': { icon: '–', cls: 'text-text-muted', label: 'Érvénytelen' },
};

function OutcomeTag({ outcome }: { outcome: PredictionRecord['outcome'] }) {
  const u = OUTCOME_UI[outcome] ?? OUTCOME_UI['érvénytelen'];
  return <span className={`inline-flex items-center gap-1.5 text-sm font-extrabold ${u.cls}`}><span aria-hidden>{u.icon}</span> {u.label}</span>;
}

export default function History() {
  const [f, setF] = useState({ leagueId: '', market: '', from: '', to: '', minProb: '', maxProb: '' });
  const [tab, setTab] = useState<OutcomeFilter>('mind');
  const leagues = useAsync(() => api.leagues(), []);
  const { pro } = usePlan();
  // Az előzmény- és szelvény-végpontok PRO-védettek a szerveren – FREE esetén nem is hívjuk őket
  const slips = useAsync(() => (pro ? api.savedSlips() : Promise.resolve([])), [pro]);
  const h = useAsync(() => (pro ? api.history({
    leagueId: f.leagueId || undefined, market: f.market || undefined, from: f.from || undefined, to: f.to || undefined,
    minProb: f.minProb ? String(+f.minProb / 100) : undefined, maxProb: f.maxProb ? String(+f.maxProb / 100) : undefined,
  }) : Promise.resolve(null)), [f, pro]);
  const s = h.data?.summary;
  const all = h.data?.predictions ?? [];

  /** Nyereség/veszteség egységben: 1 egység tét tippenként, csak ahol volt odds. */
  const profit = useMemo(() => all.reduce((acc, p) => {
    if (p.odds == null) return acc;
    if (p.outcome === 'nyert') return acc + (p.odds - 1);
    if (p.outcome === 'vesztett') return acc - 1;
    return acc;
  }, 0), [all]);

  const rows = useMemo(() => (tab === 'mind' ? all : all.filter((p) => p.outcome === tab)), [all, tab]);
  const count = (o: OutcomeFilter) => (o === 'mind' ? all.length : all.filter((p) => p.outcome === o).length);

  // Találati arány modell-valószínűség sávonként (kalibráció-jellegű átlátható nézet)
  const bands = [[0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
    const r = all.filter((p) => p.modelProb >= lo && p.modelProb < hi && (p.outcome === 'nyert' || p.outcome === 'vesztett'));
    const won = r.filter((p) => p.outcome === 'nyert').length;
    return { name: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, v: r.length ? (won / r.length) * 100 : 0, n: r.length };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="📈"
        title="Teljesítmény"
        text="Minden mentett tipp az eredménnyel együtt. A vesztes tippek nem kerülnek elrejtésre, és az eredmények utólag nem módosíthatók."
      />

      {!pro ? (
        <LockedBlock title="Történelmi eredmények – PRO" text="A mentett tippek és szelvények eredményei, a találati arány, a kalibráció és a nyereség/veszteség PRO előfizetéssel érhető el." />
      ) : h.loading ? <Card><Loading /></Card> : h.error ? <ErrorBox message={h.error} onRetry={h.reload} /> : h.data && s && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon="🎯" tone="primary" label="Tippek" value={s.total} sub={`${s.settled} lezárt · ${s.pending} függőben`} />
            <StatCard icon="✅" tone="success" label="Találati arány" value={s.hitRate != null ? pct(s.hitRate, 1) : '–'} sub={`${s.correct} nyert · ${s.incorrect} vesztes`} />
            <StatCard icon="📊" tone={s.roi != null && s.roi < 0 ? 'danger' : 'success'} label="ROI" value={s.roi != null ? `${signed(s.roi * 100, 1)}%` : '–'} sub={`${s.withOdds} tipp oddsszal`} />
            <StatCard icon={profit >= 0 ? '💰' : '📉'} tone={profit >= 0 ? 'success' : 'danger'} label="Nyereség / veszteség" value={`${signed(profit, 2)} egység`} sub="1 egység tét tippenként" />
          </div>

          {s.hitRate != null && s.avgModelProb != null && (
            <Note tone={Math.abs(s.hitRate - s.avgModelProb) > 0.08 ? 'warn' : 'info'}>
              Kalibráció: az átlagos modell-valószínűség {pct(s.avgModelProb, 1)}, a tényleges találati arány {pct(s.hitRate, 1)}.
              {s.hitRate < s.avgModelProb - 0.05 ? ' A modell túlbecsüli az esélyeket ebben a mintában.' : s.hitRate > s.avgModelProb + 0.05 ? ' A modell alulbecsüli az esélyeket ebben a mintában.' : ' A modell nagyjából jól kalibrált ebben a mintában.'}
              {h.data.origin === 'demo' && ' (DEMO ADAT – a demo odds árrése miatt a ROI jellemzően negatív.)'}
            </Note>
          )}

          <Accordion label="Szűrők" icon={<SlidersHorizontal className="h-4 w-4 text-primary" />}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <label className="field-label">Bajnokság<select className="input mt-1.5" value={f.leagueId} onChange={(e) => setF({ ...f, leagueId: e.target.value })}><option value="">Összes</option>{leagues.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
              <label className="field-label">Piac<select className="input mt-1.5" value={f.market} onChange={(e) => setF({ ...f, market: e.target.value })}><option value="">Összes</option>{Object.entries(MARKET_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="field-label">Dátumtól<input type="date" className="input mt-1.5" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
              <label className="field-label">Dátumig<input type="date" className="input mt-1.5" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
              <label className="field-label">Modell min. (%)<input type="number" min={0} max={100} className="input mt-1.5" value={f.minProb} onChange={(e) => setF({ ...f, minProb: e.target.value })} /></label>
              <label className="field-label">Modell max. (%)<input type="number" min={0} max={100} className="input mt-1.5" value={f.maxProb} onChange={(e) => setF({ ...f, maxProb: e.target.value })} /></label>
            </div>
          </Accordion>

          {/* Tipp-lista szűrő-csipeszekkel */}
          <Card
            title={`Tippek (${rows.length})`}
            right={<ChipGroup
              ariaLabel="Kimenet szerinti szűrés"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'mind', label: `Összes ${count('mind')}` },
                { value: 'nyert', label: `✓ Nyert ${count('nyert')}` },
                { value: 'vesztett', label: `✕ Vesztes ${count('vesztett')}` },
                { value: 'függőben', label: `● Függőben ${count('függőben')}` },
              ]}
            />}
          >
            {rows.length === 0 ? (
              <EmptyState emoji="🗒️" title={all.length ? 'Nincs ilyen kimenetű tipp' : 'Nincs mentett tipp'} text={all.length ? 'Válts másik szűrőre.' : 'A mérkőzés oldalon a „Mentés az előzményekhez” gombbal rögzíthetsz tippet.'} />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <Link to={`/meccs/${encodeURIComponent(p.matchId)}`} className="block truncate text-sm font-extrabold transition hover:text-primary">{p.matchLabel}</Link>
                      <div className="truncate text-xs font-semibold text-text-muted">{p.marketLabel} · {p.leagueName} · {fmtDateTime(p.kickoff)}</div>
                    </div>
                    <div className="mono text-right text-xs font-bold text-text-muted">
                      <div>modell {pct(p.modelProb, 0)}</div>
                      <div>odds {fo(p.odds)}</div>
                    </div>
                    <div className="mono w-14 text-center text-sm font-extrabold">{p.homeGoals != null ? `${p.homeGoals}–${p.awayGoals}` : '–'}</div>
                    <div className="w-28 text-right"><OutcomeTag outcome={p.outcome} /></div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="📊 Találati arány modell-valószínűség sávonként">
            <SimpleBarChart data={bands} pctAxis height={200} />
            <div className="mt-1 grid grid-cols-5 text-center text-[11px] font-semibold text-text-muted">{bands.map((b) => <div key={b.name}>{b.n} tipp</div>)}</div>
          </Card>

          {slips.data && slips.data.length > 0 && (() => {
            const settled = slips.data.filter((x) => x.outcome !== 'függőben');
            const won = settled.filter((x) => x.outcome === 'nyert').length;
            const stake = settled.filter((x) => x.outcome !== 'érvénytelen').length;
            const ret = slips.data.filter((x) => x.outcome === 'nyert').reduce((a, x) => a + x.totalOdds, 0);
            return (
              <Card title={`🎫 Mentett szelvények (${slips.data.length})`} right={<Link to="/szelvenyek" className="btn btn-sm">Szelvényépítő</Link>}>
                <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <StatCard icon="🎫" tone="neutral" label="Lezárt szelvény" value={settled.length} sub={`${slips.data.length - settled.length} függőben`} />
                  <StatCard icon="✅" tone="success" label="Bejött" value={won} sub={stake ? `${Math.round((won / stake) * 100)}% találat` : ''} />
                  <StatCard icon="✕" tone="danger" label="Nem jött be" value={settled.filter((x) => x.outcome === 'vesztett').length} />
                  <StatCard icon="📊" tone={stake && ret - stake >= 0 ? 'success' : 'danger'} label="ROI / szelvény" value={stake ? `${signed(((ret - stake) / stake) * 100, 1)}%` : '–'} sub="1 egység / szelvény" />
                </div>
                <ul className="divide-y divide-border">
                  {slips.data.map((x) => (
                    <li key={x.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-extrabold">{x.label}</div>
                          <div className="text-xs font-semibold text-text-muted">{x.strategy} · mentve: {fmtDateTime(x.createdAt)}</div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="mono text-right text-xs font-bold text-text-muted"><div>összodds {fo(x.totalOdds)}</div><div>modell {pct(x.jointProb, 1)}</div></div>
                          <OutcomeTag outcome={x.outcome} />
                        </div>
                      </div>
                      <ul className="mt-1.5 space-y-0.5">
                        {x.legs.map((l) => (
                          <li key={l.id} className="truncate text-xs font-semibold text-text-muted">
                            <span className={OUTCOME_UI[l.outcome]?.cls}>{OUTCOME_UI[l.outcome]?.icon}</span> {l.matchLabel} – {l.marketLabel} ({fo(l.odds)}){l.homeGoals != null && <span className="mono"> {l.homeGoals}–{l.awayGoals}</span>}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })()}
        </>
      )}
      <Disclaimer />
    </div>
  );
}
