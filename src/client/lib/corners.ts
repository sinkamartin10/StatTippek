/**
 * Szögletkártya – tiszta megjelenítési segédfüggvények (DOM nélkül tesztelhetők).
 */
import type { CornerAnalysis, CornerLineRate, CornerStats } from '@shared/types';

const fmtLine = (l: number) => l.toFixed(1).replace('.', ',');

/** Egyértelmű vonalfeltétel: „Over 9,5: 6/10” (6 meccsen volt több mint 9,5 – 10 érvényes adatból). */
export function lineRateLabel(r: CornerLineRate): string {
  return `Over ${fmtLine(r.line)}: ${r.over}/${r.sampleSize}`;
}

/** Mintaméret-szöveg: „9/10 meccs szögletadattal”. */
export function sampleLabel(s: Pick<CornerStats, 'sampleSize' | 'considered'>): string {
  return `${s.sampleSize}/${s.considered} meccs szögletadattal`;
}

export const avg = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '–' : x.toFixed(1).replace('.', ','));

/** A kártya fő üzenete az állapot szerint (az okokat a hívó külön listázza). */
export function cornerStatusTitle(a: Pick<CornerAnalysis, 'status'>): string | null {
  switch (a.status) {
    case 'unsupported': return 'Ehhez a mérkőzéshez nincs megbízható szögletadat';
    case 'unavailable': return 'A szögletadat most nem érhető el';
    case 'insufficient': return 'Nincs megbízható szöglet-előrejelzés';
    default: return null;
  }
}

/** Van-e megjeleníthető leíró statisztika. */
export function hasDescriptive(a: Pick<CornerAnalysis, 'home' | 'away'>): boolean {
  return !!(a.home && a.away && (a.home.last10.sampleSize > 0 || a.away.last10.sampleSize > 0));
}
