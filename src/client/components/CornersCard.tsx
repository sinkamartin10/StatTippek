/**
 * Mérkőzésoldal – „Szögletek” kártya (corners-nb-1). PRO-funkció: FREE-ben
 * nem is kéri le az adatot (a szerver is elutasítaná), csak a zárolt blokkot mutatja.
 * Egyoszlopos, mobilon is széles táblázat nélkül; a gólpiacoktól elkülönítve.
 */
import { useState } from 'react';
import type { CornerAnalysis, CornerStats, CornerTeamBlock } from '@shared/types';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { avg, cornerStatusTitle, hasDescriptive, lineRateLabel, sampleLabel } from '../lib/corners';
import { Card, ChipGroup, EmptyState, ErrorBox, Loading, Note, ProbBar } from './ui';
import { LockedBlock, ProLock } from '../auth/PlanContext';

export function CornersCard({ matchId, homeName, awayName, pro }: { matchId: string; homeName: string; awayName: string; pro: boolean }) {
  if (!pro) {
    return (
      <Card id="szogletek" title="Szögletek" right={<ProLock />}>
        <LockedBlock title="Szögletstatisztikák – PRO" text="Szögletátlagok, kiharcolt és kapott szögletek, hazai/idegen bontás és a vonalak történeti teljesülése PRO előfizetéssel érhető el." />
      </Card>
    );
  }
  return <CornersInner matchId={matchId} homeName={homeName} awayName={awayName} />;
}

function CornersInner({ matchId, homeName, awayName }: { matchId: string; homeName: string; awayName: string }) {
  const r = useAsync(() => api.matchCorners(matchId), [matchId]);
  const [side, setSide] = useState<'home' | 'away'>('home');
  if (r.loading) return <Card id="szogletek" title="Szögletek"><Loading text="Szögletadatok betöltése…" /></Card>;
  if (r.error || !r.data) return <Card id="szogletek" title="Szögletek"><ErrorBox message={r.error ?? 'Ismeretlen hiba'} onRetry={r.reload} /></Card>;
  const a = r.data;
  const title = cornerStatusTitle(a);

  if (!hasDescriptive(a)) {
    return (
      <Card id="szogletek" title="Szögletek">
        <EmptyState emoji="🚩" title={title ?? 'Nincs elérhető szögletadat'} text={a.reasons.join(' ') || 'Ehhez a mérkőzéshez nincs hiteles szögletadat.'} />
      </Card>
    );
  }
  const block = side === 'home' ? a.home! : a.away!;
  const name = side === 'home' ? homeName : awayName;

  return (
    <Card id="szogletek" title="Szögletek">
      <p className="text-xs text-muted">
        Múltbeli szögletadatok (csak befejezett, rendes játékidős meccsek). Lefedettség: {a.coverage.valid}/{a.coverage.considered} vizsgált meccsnél van hiteles szögletszám. Forrás: {a.source}.
      </p>

      <div className="mt-3">
        <ChipGroup ariaLabel="Csapat" value={side} onChange={setSide} options={[{ value: 'home', label: homeName }, { value: 'away', label: awayName }]} />
      </div>

      <div className="mt-3 space-y-3">
        <StatsRow s={block.last5} title={`${name} – utolsó 5`} />
        <StatsRow s={block.last10} title={`${name} – utolsó 10`} />
        <StatsRow s={block.venue} title={`${name} – ${side === 'home' ? 'hazai' : 'idegenbeli'} meccsek (utolsó 10)`} />
        <Lines block={block} side={side} name={name} />
      </div>

      {a.league && (
        <div className="mt-4 rounded-lg border border-border bg-card-2 p-3 text-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Liga-átlag ({a.league.sampleSize} meccs)</div>
          <div className="mt-1 mono">hazai {avg(a.league.homeAvg)} · vendég {avg(a.league.awayAvg)} · összes {avg(a.league.totalAvg)}</div>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Modell-becslés ({a.modelVersion})</div>
        {a.prediction ? (
          <div className="space-y-1.5">
            <div className="text-sm">Várható szöglet: {homeName} <b className="mono">{avg(a.prediction.homeExpected)}</b> · {awayName} <b className="mono">{avg(a.prediction.awayExpected)}</b></div>
            {a.prediction.markets.map((m) => <ProbBar key={m.market} label={m.label} value={m.over} />)}
            <p className="text-xs text-muted">
              Időrendi visszatesztben validált becslés ({a.validation.scopes.map((s) => (s === 'home' ? 'hazai' : s === 'away' ? 'vendég' : 'összes')).join(' és ')} szögletek).
              {!a.validation.scopes.includes('total') && ' Az összes szöglet becslése nem bizonyult megbízhatóbbnak a liga-átlagnál, ezért nem jelenik meg.'}
              {' '}A százalékok a modell becslései – nem garantált eredmények, és nem jelentenek automatikusan value-fogadást. Szöglet-odds nem érhető el, ezért value-becslés nincs.
            </p>
          </div>
        ) : (
          <Note tone="warn">
            <strong>{a.validation.validated ? 'Nincs megbízható szöglet-előrejelzés' : 'Modell-valószínűség nem jelenik meg'}</strong>
            <ul className="mt-1 list-disc pl-5">
              {!a.validation.validated && <li>{a.validation.note}</li>}
              {a.reasons.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </Note>
        )}
      </div>
    </Card>
  );
}

function StatsRow({ s, title }: { s: CornerStats; title: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-2 p-3">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-muted">{sampleLabel(s)}</div>
      {s.sampleSize === 0 ? <div className="mt-1 text-xs font-semibold text-text-muted">Nincs hiteles szögletadat ebben az ablakban.</div> : (
        <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs">
          <div><div className="text-muted">Kiharcolt</div><b className="mono text-sm">{avg(s.forAvg)}</b></div>
          <div><div className="text-muted">Kapott</div><b className="mono text-sm">{avg(s.againstAvg)}</b></div>
          <div><div className="text-muted">Összes</div><b className="mono text-sm">{avg(s.totalAvg)}</b></div>
        </div>
      )}
    </div>
  );
}

function Lines({ block, side, name }: { block: CornerTeamBlock; side: 'home' | 'away'; name: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-2 p-3 text-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Vonalak teljesülése (utolsó 10, csak szögletadatos meccsek)</div>
      <div className="mt-1.5 text-xs text-muted">A meccs összes szöglete</div>
      <ul className="mono text-xs">{block.totalLines.map((l) => <li key={`t${l.line}`}>{lineRateLabel(l)}</li>)}</ul>
      <div className="mt-1.5 text-xs text-muted">{name} saját szögletei ({side === 'home' ? 'hazai' : 'vendég'} vonalak)</div>
      <ul className="mono text-xs">{block.forLines.map((l) => <li key={`f${l.line}`}>{lineRateLabel(l)}</li>)}</ul>
    </div>
  );
}
