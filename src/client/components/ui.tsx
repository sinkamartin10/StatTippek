/** Újrafelhasználható UI elemek – világos, barátságos („cartoon SaaS”) stílusban. */
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronDown, Info, Loader2, ShieldAlert } from 'lucide-react';
import type { DataOrigin, DataQuality, MatchImportance } from '@shared/types';
import { IMPORTANCE_LABEL } from '../lib/format';

export function Card({ title, right, children, className = '', id }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`card ${className}`}>
      {title && (
        <div className="card-head">
          <h3 className="card-title">{title}</h3>
          {right}
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

/** Oldalfejléc: nagy, barátságos cím + rövid magyarázat, opcionális jobb oldali tartalom. */
export function PageHeader({ emoji, title, text, right }: { emoji?: string; title: ReactNode; text?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-2xl font-extrabold tracking-tight sm:text-3xl">
          {emoji && <span aria-hidden className="text-2xl sm:text-3xl">{emoji}</span>}
          {title}
        </h1>
        {text && <p className="mt-1.5 max-w-2xl text-sm font-semibold text-text-muted">{text}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function OriginBadge({ origin, small }: { origin: DataOrigin; small?: boolean }) {
  return origin === 'demo'
    ? <span className={`badge badge-demo ${small ? 'text-[10px]' : ''}`} title="Beépített, szemléltető adat – nem valós">DEMO ADAT</span>
    : <span className={`badge badge-live ${small ? 'text-[10px]' : ''}`}>ÉLŐ ADAT</span>;
}

export function QualityBadge({ q, showScore }: { q: DataQuality; showScore?: boolean }) {
  const cls = q.level === 'magas' ? 'badge-green' : q.level === 'közepes' ? 'badge-yellow' : 'badge-red';
  const dot = q.level === 'magas' ? '🟢' : q.level === 'közepes' ? '🟡' : '🔴';
  return (
    <span className={`badge ${cls}`} title="Adatminőség – NEM nyerési esély">
      {dot} {q.level === 'kevés' ? 'Kevés adat' : `${q.level} adatminőség`}{showScore ? ` · ${q.score}/100` : ''}
    </span>
  );
}

export function ImportanceBadge({ importance }: { importance: MatchImportance }) {
  const cls = importance === 'top' ? 'badge-blue' : importance === 'high' ? 'badge-yellow' : 'badge-muted';
  return <span className={`badge ${cls}`}>{IMPORTANCE_LABEL[importance]}</span>;
}

export function FormPills({ form }: { form: string }) {
  if (!form) return <span className="text-text-muted">–</span>;
  return (
    <span className="inline-flex gap-1">
      {form.split('').map((c, i) => (
        <span key={i} className={`pill pill-${c}`}>{c === 'W' ? 'Gy' : c === 'D' ? 'D' : 'V'}</span>
      ))}
    </span>
  );
}

/** Vízszintes valószínűség-sáv címkével és százalékkal. */
export function ProbBar({ value, label, color = 'bg-primary' }: { value: number; label?: string; color?: string }) {
  const w = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="flex items-center gap-3">
      {label && <span className="w-40 shrink-0 text-sm font-semibold text-text-muted">{label}</span>}
      <div className="meter flex-1">
        <div className={`meter-fill ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="mono w-14 text-right text-sm font-extrabold">{w.toFixed(1).replace('.', ',')}%</span>
    </div>
  );
}

/**
 * Konfidencia-mérő: a modell-valószínűség vizuálisan.
 * Szándékosan „mennyire támogatja a statisztika” jelentéssel – nem nyerési garancia.
 */
export function ConfidenceMeter({ value, compact }: { value: number; compact?: boolean }) {
  const p = Math.max(0, Math.min(100, value * 100));
  const tone = p >= 70 ? 'bg-success' : p >= 55 ? 'bg-primary' : 'bg-warning';
  return (
    <div className="w-full">
      <div className={`flex items-baseline justify-between ${compact ? 'mb-1' : 'mb-1.5'}`}>
        <span className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">📊 Statisztikai támogatás</span>
        <span className="mono text-sm font-extrabold">{p.toFixed(0)}%</span>
      </div>
      <div className="meter" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label="Statisztikai támogatás">
        <div className={`meter-fill ${tone}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

/** Összecsukható blokk („Miért? / Elemzés”) – finom animációval. */
export function Accordion({ label, children, defaultOpen = false, icon }: { label: ReactNode; children: ReactNode; defaultOpen?: boolean; icon?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="rounded-xl border border-border bg-card-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm font-bold text-text transition hover:bg-surface focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25"
      >
        <span className="flex items-center gap-2">{icon}{label}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div id={id} className="border-t border-border px-4 py-3">{children}</div>}
    </div>
  );
}

/** Szűrő-csipesz csoport (pl. [Összes][Nyert][Vesztes][Függőben]). */
export function ChipGroup<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value} className={`chip ${value === o.value ? 'chip-active' : ''}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Loading({ text = 'Betöltés…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm font-semibold text-text-muted">
      <Loader2 className="h-5 w-5 animate-spin text-primary" /> {text}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-danger/25 bg-danger-soft p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
      <div className="flex-1">
        <div className="font-extrabold text-danger">Hiba</div>
        <div className="font-semibold text-text">{message}</div>
        {onRetry && <button className="btn btn-sm mt-3" onClick={onRetry}>Újra</button>}
      </div>
    </div>
  );
}

export function EmptyState({ title, text, emoji = '🔍', action }: { title: string; text?: string; emoji?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border-2 border-dashed border-border bg-card-2 px-6 py-12 text-center">
      <span aria-hidden className="text-4xl">{emoji}</span>
      <div className="text-base font-extrabold">{title}</div>
      {text && <div className="max-w-md text-sm font-semibold text-text-muted">{text}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  const cls = tone === 'warn' ? 'border-warning/30 bg-warning-soft' : 'border-primary/20 bg-primary-soft';
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border ${cls} px-4 py-3 text-sm font-semibold`}>
      <Info className={`mt-0.5 h-4 w-4 shrink-0 ${tone === 'warn' ? 'text-warning' : 'text-primary'}`} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Disclaimer() {
  return (
    <div className="mt-8 flex items-start gap-3 rounded-[var(--radius-card)] border border-border bg-card p-4 text-xs font-semibold text-text-muted">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <strong className="text-text">Felelős játék.</strong> A TippStats elemző- és kutatóeszköz. Egyetlen előrejelzés sem garantált; a megjelenített
        valószínűségek statisztikai becslések, nem ígéretek. A szerencsejáték függőséget okozhat és anyagi veszteséggel járhat – soha ne tegyél fel
        olyan összeget, amelynek elvesztését nem engedheted meg magadnak. Csak 18 éven felülieknek. Segítség: Játékosvédelmi vonal (ingyenes): 06 80 205 305.
      </div>
    </div>
  );
}

export function TeamLink({ id, name, className = '' }: { id: string; name: string; className?: string }) {
  return <Link to={`/csapat/${encodeURIComponent(id)}`} className={`transition hover:text-primary ${className}`}>{name}</Link>;
}

/** Kompakt mutató (táblázatok és rácsok mellé). */
export function Stat({ label, value, sub, mono = true }: { label: string; value: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card-2 p-3.5">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`kpi mt-1 ${mono ? 'mono' : ''}`}>{value}</div>
      {sub && <div className="mt-1 text-xs font-semibold text-text-muted">{sub}</div>}
    </div>
  );
}

const STAT_TONES = {
  primary: { bubble: 'bg-primary-soft text-primary-strong', value: 'text-text' },
  success: { bubble: 'bg-success-soft text-success', value: 'text-text' },
  warning: { bubble: 'bg-warning-soft text-[#a96b00]', value: 'text-text' },
  danger: { bubble: 'bg-danger-soft text-danger', value: 'text-text' },
  neutral: { bubble: 'bg-surface text-text-muted', value: 'text-text' },
} as const;

/** Nagy, játékos statisztika-kártya a dashboardhoz (ikonbuborék + érték + rövid magyarázat). */
export function StatCard({ icon, label, value, sub, tone = 'primary' }: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: keyof typeof STAT_TONES;
}) {
  const t = STAT_TONES[tone];
  return (
    <div className="card card-lift flex items-start gap-3 p-4">
      <span aria-hidden className={`icon-bubble ${t.bubble}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-xs font-extrabold uppercase tracking-wide text-text-muted">{label}</div>
        <div className={`mono mt-0.5 text-2xl font-extrabold tracking-tight ${t.value}`}>{value}</div>
        {sub && <div className="mt-0.5 truncate text-xs font-semibold text-text-muted" title={typeof sub === 'string' ? sub : undefined}>{sub}</div>}
      </div>
    </div>
  );
}
