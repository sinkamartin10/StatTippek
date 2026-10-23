/**
 * Az előrejelzések teljesítményoldalának tiszta segédfüggvényei.
 *
 * Az adatok a meglévő, nyilvános modell-tipp archívumból jönnek (`/api/tip-archive`, `scope=counted`):
 * mérkőzésenként és piaconként a kezdés előtt rögzített utolsó verzió. Az értékelést (nyert / vesztett /
 * függő / érvénytelen / nem elszámolható) a szerver végzi a meglévő szabállyal – itt semmit nem
 * számolunk újra, csak megjelenítjük, és a heti / havi időszakokat állítjuk elő.
 * Az időszakok a mérkőzés kezdési idejére vonatkoznak, magyar naptár szerint (mint az archívum szűrője).
 */
import { hitRateOf, type SettlementStatus, type TipArchiveSummary } from '@shared/tipArchive';

/** Ennél kevesebb lezárt előrejelzésnél a találati arány mellé „kis minta” figyelmeztetés kerül. */
export const MIN_SETTLED = 30;
/** Ennyi hetet és hónapot mutatunk legfeljebb (a legfrissebbtől visszafelé). */
export const MAX_WEEKS = 8;
export const MAX_MONTHS = 6;
/** A lista lapmérete és a lapozható lapok száma (a teljes lista a modell-archívumban érhető el). */
export const LIST_PAGE_SIZE = 10;
export const LIST_MAX_PAGES = 10;

export const PERF_TIME_ZONE = 'Europe/Budapest';
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: PERF_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const HU_MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];

/** Egy pillanat → magyar naptári nap (YYYY-MM-DD). */
export function budapestDateKey(d: Date): string {
  return DATE_FMT.format(d);
}

const parseKey = (key: string) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toKey = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => { const d = parseKey(key); d.setUTCDate(d.getUTCDate() + n); return toKey(d); };
/** a nap hetének hétfője */
export const mondayOf = (key: string) => addDays(key, -((parseKey(key).getUTCDay() + 6) % 7));
const short = (key: string) => `${key.slice(5, 7)}. ${key.slice(8, 10)}.`;

export interface Period {
  /** első nap (YYYY-MM-DD, a nap egésze benne van) */
  from: string;
  /** utolsó nap (YYYY-MM-DD, a nap egésze benne van) */
  to: string;
  label: string;
  /** a mai nap ebbe az időszakba esik (még nem zárult le) */
  current: boolean;
}

/**
 * Hétfőtől vasárnapig tartó hetek a lefedettség kezdetétől a mai napig, a legfrissebbel kezdve.
 * Lefedettség nélkül (üres archívum) nincs időszak.
 */
export function weekPeriods(coverageStart: string | null, today: string, max = MAX_WEEKS): Period[] {
  if (!coverageStart) return [];
  const first = mondayOf(budapestDateKey(new Date(coverageStart)));
  const out: Period[] = [];
  for (let from = mondayOf(today); from >= first && out.length < max; from = addDays(from, -7)) {
    const to = addDays(from, 6);
    out.push({ from, to, label: `${from.slice(0, 4)}. ${short(from)} – ${short(to)}`, current: today >= from && today <= to });
  }
  return out;
}

/** Naptári hónapok a lefedettség kezdetétől a mai napig, a legfrissebbel kezdve. */
export function monthPeriods(coverageStart: string | null, today: string, max = MAX_MONTHS): Period[] {
  if (!coverageStart) return [];
  const first = budapestDateKey(new Date(coverageStart)).slice(0, 7);
  const out: Period[] = [];
  let [y, m] = today.slice(0, 7).split('-').map(Number);
  while (out.length < max) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym < first) break;
    const from = `${ym}-01`;
    const to = addDays(toKey(new Date(Date.UTC(y, m, 1))), -1);
    out.push({ from, to, label: `${y}. ${HU_MONTHS[m - 1]}`, current: today >= from && today <= to });
    if (--m === 0) { m = 12; y--; }
  }
  return out;
}

export interface PerfStats {
  /** helyes (nyert) */
  correct: number;
  /** helytelen (vesztett) */
  incorrect: number;
  /** értékelhető, lezárt előrejelzések: helyes + helytelen */
  settled: number;
  /** a találati arányba NEM számító előrejelzések */
  pending: number;
  excluded: number;
  /** helyes / (helyes + helytelen); null, ha nincs lezárt előrejelzés */
  hitRate: number | null;
  smallSample: boolean;
}

/** A szerver összesítéséből: a függő, érvénytelen és nem elszámolható előrejelzés nem számít bele. */
export function perfStats(s: Pick<TipArchiveSummary, 'won' | 'lost' | 'pending' | 'void' | 'unsupported'>): PerfStats {
  const settled = s.won + s.lost;
  return {
    correct: s.won,
    incorrect: s.lost,
    settled,
    pending: s.pending,
    excluded: s.void + s.unsupported,
    hitRate: hitRateOf(s.won, s.lost),
    smallSample: settled > 0 && settled < MIN_SETTLED,
  };
}

export const VERDICT: Record<SettlementStatus, { label: string; icon: string; cls: string }> = {
  won: { label: 'Helyes', icon: '✓', cls: 'text-success' },
  lost: { label: 'Helytelen', icon: '✕', cls: 'text-danger' },
  pending: { label: 'Feldolgozás alatt', icon: '●', cls: 'text-warning' },
  void: { label: 'Érvénytelen', icon: '–', cls: 'text-text-muted' },
  unsupported: { label: 'Nem értékelhető', icon: '?', cls: 'text-text-muted' },
};
