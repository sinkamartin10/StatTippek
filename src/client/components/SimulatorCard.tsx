/**
 * Mérkőzésoldal – „AI-meccsszimulátor” kártya (mc-poisson-lognormal-1). Mindenki kap előnézetet
 * (1X2, frissesség, bizonytalanság); a teljes eredményt a szerver csak PRO-nak küldi el (`full`).
 * A felület semmit nem számol újra: minden szám a szerver válaszából jön.
 */
import type { SimulationReport, UncertaintyLevel } from '@shared/engine/simulator';
import { api } from '../lib/api';
import { fmtDateTime, num, pct, useAsync } from '../lib/format';
import { Card, EmptyState, ErrorBox, Loading, Note, ProbBar } from './ui';
import { LockedBlock, ProLock } from '../auth/PlanContext';

const LEVEL_BADGE: Record<UncertaintyLevel, string> = { alacsony: 'badge-green', közepes: 'badge-yellow', magas: 'badge-red' };
const TITLE = 'AI-meccsszimulátor';

export function SimulatorCard({ matchId, homeName, awayName, pro }: { matchId: string; homeName: string; awayName: string; pro: boolean }) {
  const r = useAsync(() => api.matchSimulation(matchId), [matchId]);
  if (r.loading) return <Card id="szimulator" title={TITLE}><Loading text="Szimuláció futtatása…" /></Card>;
  if (r.error || !r.data) return <Card id="szimulator" title={TITLE}><ErrorBox message={r.error ?? 'Ismeretlen hiba'} onRetry={r.reload} /></Card>;
  return <SimulatorView s={r.data} homeName={homeName} awayName={awayName} pro={pro} />;
}

export function SimulatorView({ s, homeName, awayName, pro }: { s: SimulationReport; homeName: string; awayName: string; pro: boolean }) {
  if (s.status !== 'ok' || !s.oneXTwo) {
    return (
      <Card id="szimulator" title={TITLE}>
        <EmptyState emoji="🎲" title="A szimuláció nem futtatható" text={s.reasons.join(' ') || 'Nincs elegendő ellenőrizhető adat – értéket nem találunk ki.'} />
      </Card>
    );
  }
  const f = s.full;
  return (
    <Card id="szimulator" title={TITLE} right={f ? undefined : <ProLock />}>
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-text-muted" data-sim-meta>
        <span>{f ? `${f.n.toLocaleString('hu-HU')} szimuláció` : 'Előnézet'} · {s.modelLabel}</span>
        {s.uncertainty && <span className={`badge ${LEVEL_BADGE[s.uncertainty.level]}`} data-sim-uncertainty={s.uncertainty.level}>Bizonytalanság: {s.uncertainty.level}</span>}
        {s.freshness.stale && <span className="badge badge-red" data-sim-stale>Elavult adat</span>}
      </div>

      <div className="mt-3 space-y-1.5" data-sim-1x2>
        <ProbBar label={`${homeName} győz`} value={s.oneXTwo.home} />
        <ProbBar label="Döntetlen" value={s.oneXTwo.draw} color="bg-warning" />
        <ProbBar label={`${awayName} győz`} value={s.oneXTwo.away} color="bg-success" />
      </div>

      <p className="mt-2 text-xs text-muted">
        Legfrissebb eredmény: {s.freshness.newestResultDate ? `${fmtDateTime(s.freshness.newestResultDate)} (${s.freshness.daysBeforeKickoff} nappal a kezdés előtt)` : 'nincs'} · számítva: {fmtDateTime(s.freshness.generatedAt)}.
      </p>
      {s.uncertainty && <ul className="mt-1 list-disc pl-5 text-xs text-muted">{s.uncertainty.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}

      {f ? (
        <div className="mt-4 space-y-4" data-sim-full>
          <div className="text-sm">
            Várható gólok (szimulált átlag): {homeName} <b className="mono">{num(f.expectedGoals.home)}</b> · {awayName} <b className="mono">{num(f.expectedGoals.away)}</b> · összesen <b className="mono">{num(f.expectedGoals.total)}</b>
            <span className="text-xs text-muted"> (összgól 80%-os tartomány: {f.totalGoals80[0]}–{f.totalGoals80[1]})</span>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">Gólpiacok</div>
            {f.overUnder.map((o) => <ProbBar key={o.line} label={`Több mint ${String(o.line).replace('.', ',')} gól`} value={o.over} />)}
            <ProbBar label="Mindkét csapat szerez gólt" value={f.btts.yes} />
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Legvalószínűbb pontos eredmények</div>
            <div className="flex flex-wrap gap-2">
              {f.topScores.map((x) => <span key={x.score} className="badge badge-blue mono">{x.score} · {pct(x.prob, 1)}</span>)}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Magyarázat</div>
            <ul className="list-disc space-y-1 pl-5 text-sm">{f.explanation.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
          <p className="text-xs text-muted">
            Monte Carlo szórás: ±{pct(f.standardError, 1)} (1X2). A százalékok modellbecslések, nem garantált eredmények és nem fogadási tanácsok.
          </p>
        </div>
      ) : (
        <div className="mt-4">
          {pro ? (
            <Note tone="warn">A teljes szimuláció betöltése nem sikerült – frissítsd az oldalt.</Note>
          ) : (
            <LockedBlock compact title="Teljes szimuláció – PRO" text="Várható gólok, gólpiacok (O/U, mindkét csapat gól), legvalószínűbb pontos eredmények és adatvezérelt magyarázat 10 000 szimulációból." />
          )}
        </div>
      )}
    </Card>
  );
}
