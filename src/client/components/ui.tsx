/** Kis, újrafelhasználható UI elemek. */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Info, Loader2, ShieldAlert } from 'lucide-react';
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
  const cls = importance === 'top' ? 'badge-green' : importance === 'high' ? 'badge-yellow' : 'badge-muted';
  return <span className={`badge ${cls}`}>{IMPORTANCE_LABEL[importance]}</span>;
}

export function FormPills({ form }: { form: string }) {
  if (!form) return <span className="text-muted">–</span>;
  return (
    <span className="inline-flex gap-1">
      {form.split('').map((c, i) => (
        <span key={i} className={`pill pill-${c}`}>{c === 'W' ? 'Gy' : c === 'D' ? 'D' : 'V'}</span>
      ))}
    </span>
  );
}

export function ProbBar({ value, label, color = 'bg-accent' }: { value: number; label?: string; color?: string }) {
  const w = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="flex items-center gap-3">
      {label && <span className="w-40 shrink-0 text-sm text-muted">{label}</span>}
      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-bg-2">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${w}%` }} />
      </div>
      <span className="mono w-14 text-right text-sm font-semibold">{w.toFixed(1).replace('.', ',')}%</span>
    </div>
  );
}

export function Loading({ text = 'Betöltés…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-muted">
      <Loader2 className="h-5 w-5 animate-spin text-accent" /> {text}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
      <div className="flex-1">
        <div className="font-semibold text-danger">Hiba</div>
        <div className="text-text/90">{message}</div>
        {onRetry && <button className="btn btn-sm mt-3" onClick={onRetry}>Újra</button>}
      </div>
    </div>
  );
}

export function EmptyState({ title, text }: { title: string; text?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-12 text-center">
      <Info className="h-6 w-6 text-muted" />
      <div className="font-semibold">{title}</div>
      {text && <div className="max-w-md text-sm text-muted">{text}</div>}
    </div>
  );
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  const cls = tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-info/40 bg-info/10';
  return (
    <div className={`flex items-start gap-2 rounded-lg border ${cls} px-3 py-2 text-sm`}>
      <Info className={`mt-0.5 h-4 w-4 shrink-0 ${tone === 'warn' ? 'text-warn' : 'text-info'}`} />
      <div>{children}</div>
    </div>
  );
}

export function Disclaimer() {
  return (
    <div className="mt-8 flex items-start gap-3 rounded-xl border border-border bg-card-2/60 p-4 text-xs text-muted">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      <div>
        <strong className="text-text">Felelős játék.</strong> A TIPPMIX AI elemző- és kutatóeszköz. Egyetlen előrejelzés sem garantált; a megjelenített
        valószínűségek statisztikai becslések, nem ígéretek. A szerencsejáték függőséget okozhat és anyagi veszteséggel járhat – soha ne tegyél fel
        olyan összeget, amelynek elvesztését nem engedheted meg magadnak. Csak 18 éven felülieknek. Segítség: Játékosvédelmi vonal (ingyenes): 06 80 205 305.
      </div>
    </div>
  );
}

export function TeamLink({ id, name, className = '' }: { id: string; name: string; className?: string }) {
  return <Link to={`/csapat/${encodeURIComponent(id)}`} className={`hover:text-accent ${className}`}>{name}</Link>;
}

export function Stat({ label, value, sub, mono = true }: { label: string; value: ReactNode; sub?: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-bg-2/60 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`kpi mt-1 ${mono ? 'mono' : ''}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}
