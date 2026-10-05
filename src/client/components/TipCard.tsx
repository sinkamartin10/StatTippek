/**
 * Tipp-kártya – az alkalmazás legfontosabb eleme.
 * Egy pillantásra látszik: melyik mérkőzés, melyik piac, mekkora az odds,
 * mennyire támogatja a statisztika, mikor kezdődik, és röviden hogy miért.
 * A részletes indoklás összecsukható („Miért ezt választotta?”); FREE csomagban zárt.
 */
import { Link } from 'react-router-dom';
import { Clock, Lock, Sparkles } from 'lucide-react';
import type { TipListEntry } from '@shared/types';
import { fmtDayLabel, fmtTime, odds as fo, pct, signed } from '../lib/format';
import { Accordion, ConfidenceMeter, QualityBadge } from './ui';

const CATEGORY_BADGE: Record<string, string> = {
  'konzervatív': 'badge-green',
  'mérsékelt': 'badge-blue',
  'magas variancia': 'badge-yellow',
};

/** A csapatneveket a „A – B” címkéből bontjuk, hogy külön sorban jelenjenek meg. */
function teams(label: string): [string, string] {
  const m = label.split(/\s+[–-]\s+/);
  return [m[0] ?? label, m[1] ?? ''];
}

export function TipCard({ entry, pro }: { entry: TipListEntry; pro: boolean }) {
  const t = entry.tip;
  const [home, away] = teams(entry.matchLabel);
  const why = t.reasonsFor[0] ?? t.supportingStats[0] ?? null;

  return (
    <article className="card card-lift flex flex-col gap-4 p-4 sm:p-5">
      {/* Fejléc: bajnokság + kezdés */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-text-muted">
        <span className="truncate">{entry.leagueName}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1">
          <Clock className="h-3.5 w-3.5" /> <span className="mono">{fmtTime(entry.kickoff)}</span>
          <span className="font-semibold">· {fmtDayLabel(entry.kickoff)}</span>
        </span>
      </div>

      {/* Mérkőzés */}
      <Link to={`/meccs/${encodeURIComponent(entry.matchId)}#tippek`} className="group block">
        <div className="text-lg font-extrabold leading-snug tracking-tight transition group-hover:text-primary">{home}</div>
        <div className="my-0.5 text-[11px] font-extrabold uppercase tracking-widest text-text-muted">vs</div>
        <div className="text-lg font-extrabold leading-snug tracking-tight transition group-hover:text-primary">{away}</div>
      </Link>

      {/* Ajánlás + odds */}
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2 rounded-xl border border-primary/20 bg-primary-soft p-3">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-primary-strong">🎯 Tipp</div>
          <div className="mt-0.5 truncate text-base font-extrabold text-text" title={t.label}>{t.label}</div>
        </div>
        <div className="rounded-xl border border-border bg-card-2 p-3 text-center">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">💰 Odds</div>
          <div className="mono mt-0.5 text-xl font-extrabold">{fo(t.odds)}</div>
        </div>
      </div>

      {/* Mennyire támogatja a statisztika */}
      <ConfidenceMeter value={t.modelProb} />

      {/* Rövid indoklás + megbízhatóság */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${CATEGORY_BADGE[t.category] ?? 'badge-muted'}`}>{t.category}</span>
        <QualityBadge q={entry.dataQuality} />
        <span className="badge badge-muted" title="Egymástól független statisztikai mutatók, amelyek alátámasztják">
          {t.supportingIndicators}/{t.supportingStats.length} mutató
        </span>
      </div>
      {why && <p className="text-sm font-semibold text-text-muted">{why}</p>}

      {/* Részletes elemzés */}
      <div className="mt-auto">
        {pro ? (
          <Accordion label="Miért ezt választotta?" icon={<Sparkles className="h-4 w-4 text-primary" />}>
            <TipReasoning entry={entry} />
          </Accordion>
        ) : (
          <div className="rounded-xl border border-dashed border-warning/40 bg-warning-soft p-3.5">
            <div className="flex items-center gap-2 text-sm font-extrabold text-[#a96b00]">
              <Lock className="h-4 w-4" /> 🔒 PRO elemzés
            </div>
            <p className="mt-1 text-xs font-semibold text-text-muted">Oldd fel a teljes elemzést: mellette és ellene szóló mutatók, kockázatok, odds-összevetés.</p>
            <Link to="/pro" className="btn btn-sm btn-primary mt-2.5">PRO kipróbálása</Link>
          </div>
        )}
      </div>
    </article>
  );
}

/** A modell indoklása: mellette / ellene / kockázatok + mérhető számok. */
export function TipReasoning({ entry }: { entry: TipListEntry }) {
  const t = entry.tip;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-card p-2.5"><div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Modell</div><div className="mono font-extrabold">{pct(t.modelProb, 1)}</div></div>
        <div className="rounded-lg bg-card p-2.5"><div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Odds szerint</div><div className="mono font-extrabold">{t.impliedProb != null ? pct(t.impliedProb, 1) : '–'}</div></div>
        <div className="rounded-lg bg-card p-2.5"><div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Különbség</div><div className={`mono font-extrabold ${t.diffPoints == null ? 'text-text-muted' : t.diffPoints >= 3 ? 'text-success' : t.diffPoints <= -3 ? 'text-danger' : ''}`}>{t.diffPoints != null ? `${signed(t.diffPoints, 1)} pp` : '–'}</div></div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <div className="mb-1 text-xs font-extrabold uppercase tracking-wide text-success">Mellette</div>
          <ul className="list-disc space-y-1 pl-4 text-xs font-semibold text-text-muted">{t.reasonsFor.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
        <div>
          <div className="mb-1 text-xs font-extrabold uppercase tracking-wide text-danger">Ellene</div>
          <ul className="list-disc space-y-1 pl-4 text-xs font-semibold text-text-muted">{t.reasonsAgainst.length ? t.reasonsAgainst.map((r) => <li key={r}>{r}</li>) : <li>nincs</li>}</ul>
        </div>
        <div>
          <div className="mb-1 text-xs font-extrabold uppercase tracking-wide text-warning">Kockázatok</div>
          <ul className="list-disc space-y-1 pl-4 text-xs font-semibold text-text-muted">{t.risks.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </div>
      <div className="text-[11px] font-semibold text-text-muted">
        Minta: {t.sampleSize} mérkőzés · adatminőség: {entry.dataQuality.level} ({entry.dataQuality.score}/100)
        A megjelenés statisztikai elemzés, nem ajánlás és nem ígéret.
      </div>
      <Link to={`/meccs/${encodeURIComponent(entry.matchId)}#tippek`} className="btn btn-sm">Teljes mérkőzés-elemzés</Link>
    </div>
  );
}
