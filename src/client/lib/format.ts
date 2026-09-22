/** Magyar formázási segédfüggvények. */
import { useEffect, useState } from 'react';

export const pct = (p: number | null | undefined, digits = 0) =>
  p == null || Number.isNaN(p) ? '–' : `${(p * 100).toFixed(digits).replace('.', ',')}%`;

export const pct100 = (p: number | null | undefined, digits = 0) =>
  p == null || Number.isNaN(p) ? '–' : `${p.toFixed(digits).replace('.', ',')}%`;

export const num = (n: number | null | undefined, digits = 2) =>
  n == null || Number.isNaN(n) ? '–' : n.toFixed(digits).replace('.', ',');

export const odds = (o: number | null | undefined) => (o == null ? '–' : o.toFixed(2).replace('.', ','));

export const signed = (n: number | null | undefined, digits = 2) =>
  n == null ? '–' : `${n > 0 ? '+' : ''}${n.toFixed(digits).replace('.', ',')}`;

const HU_DAYS = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}.`;
}

export function fmtDateTime(iso: string) {
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

export function fmtDayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
  if (diff === 0) return 'Ma';
  if (diff === 1) return 'Holnap';
  if (diff === -1) return 'Tegnap';
  return `${fmtDate(iso)} (${HU_DAYS[d.getDay()]})`;
}

export function todayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const IMPORTANCE_LABEL: Record<string, string> = { low: 'Alacsony', normal: 'Normál', high: 'Kiemelt', top: 'Rangadó' };
export const STATUS_LABEL: Record<string, string> = { scheduled: 'Tervezett', live: 'Élő', finished: 'Lejátszott', postponed: 'Elhalasztva' };

/** Egyszerű adatlekérő hook: betöltés/hiba/adat állapottal. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: Error) => alive && setState({ data: null, error: e.message, loading: false }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
