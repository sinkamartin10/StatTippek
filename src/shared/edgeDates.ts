/**
 * Edge Radar dátumtartomány – KÖZÖS a szervernek és a böngészőnek, így a kettő ugyanazt a napot
 * érti „ma” alatt, a gép időzónájától függetlenül. A „mai nap” a meglévő budapesti napkulcs
 * (`dayKey`, Europe/Budapest – ugyanaz, mint a küldetéseknél); a napok hozzáadása naptári napokkal
 * történik (UTC-naptárszámítás a dátumkulcson), nem 24 órás eltolással – így a hónap-, év-,
 * szökőév- és nyári/téli időszámítás-határok nem csúsztatnak.
 */
import { dayKey } from './missions';

/** Ennyi naptári nap kérhető a mai (budapesti) nap UTÁN. */
export const EDGE_RADAR_MAX_DAYS_AHEAD = 7;

/** 'YYYY-MM-DD' + n naptári nap. */
export function addCalendarDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A kérhető napok: a mai budapesti nap és a következő 7 naptári nap (zárt intervallum). */
export function edgeDateRange(now: Date = new Date(), todayOf: (now: Date) => string = dayKey): { min: string; max: string } {
  const min = todayOf(now);
  return { min, max: addCalendarDays(min, EDGE_RADAR_MAX_DAYS_AHEAD) };
}
