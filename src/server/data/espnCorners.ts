/**
 * ESPN szögletadat-parser – tiszta függvények (a hálózatot az EspnProvider kezeli).
 *
 * Forrás (ellenőrizve valós válaszokon): a scoreboard végpont
 * `events[].competitions[0].competitors[].statistics[name=wonCorners]` mezője.
 * A `teams/{id}/schedule` válaszok NEM tartalmaznak szögletszámot.
 *
 * Elfogadás szabályai:
 * - csak BEFEJEZETT meccs (status.type.completed === true); élő/félidei adat soha,
 * - hosszabbítással/tizenegyesekkel zárult meccs kimarad (a szögletszám a
 *   90 percen túli időt is tartalmazza, a szögletpiacok a rendes játékidőre szólnak),
 * - mindkét csapat értéke kell; csak nemnegatív egész érvényes,
 * - hiányzó/üres/kötőjeles érték → hiányzó (SOHA nem nulla); a valódi "0" érvényes,
 * - ÜRES STATISZTIKA-BLOKK: ha mindkét csapat MINDEN statisztikája 0 vagy üres
 *   (pl. labdabirtoklás 0% – 0%), az ESPN nem rögzítette a meccs adatait, a
 *   „0” helyőrző → hiányzó adat (mért példa: Championship 2024–26, a meccsek
 *   közel fele). Egy csapat valódi 0 szöglete (nem üres blokk mellett) érvényes,
 * - duplikált event ID → az első marad.
 *
 * DÁTUMHATÁR: az ESPN `dates=YYYYMMDD` / `dates=YYYYMM` paramétere az
 * amerikai keleti idő (America/New_York) szerinti napot/hónapot jelenti
 * (pl. a 2025-03-09T03:30Z kezdésű MLS-meccs a 20250308-as napon szerepel).
 */
import type { CornerResult } from '../../shared/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type CornerSkipReason = 'not_completed' | 'extra_time' | 'missing_competitor' | 'missing_value' | 'invalid_value' | 'empty_stats' | 'duplicate';

export interface ParsedCorners {
  results: CornerResult[];
  skipped: { matchId: string; reason: CornerSkipReason }[];
}

/** A `wonCorners` érték kiolvasása egy competitor-objektumból. */
export function readCornerValue(competitor: Json): number | 'missing' | 'invalid' {
  const stat = (Array.isArray(competitor?.statistics) ? competitor.statistics : []).find((s: Json) => s?.name === 'wonCorners');
  if (!stat) return 'missing';
  const dv = stat.displayValue;
  if (typeof dv === 'string') {
    const t = dv.trim();
    if (t === '' || /^-+$/.test(t)) return 'missing';
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    return 'invalid';
  }
  const v = stat.value;
  if (v == null || v === '') return 'missing';
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return 'invalid';
}

/**
 * Igaz, ha mindkét csapat statisztika-blokkja üres vagy csupa nulla – ilyenkor
 * a „0” értékek helyőrzők (valódi meccsen a labdabirtoklás sosem 0%–0%).
 */
export function isEmptyStatBlock(home: Json, away: Json): boolean {
  const vals = [home, away].flatMap((c) => (Array.isArray(c?.statistics) ? c.statistics : []).map((s: Json) => s?.displayValue ?? s?.value));
  return vals.every((v: unknown) => v == null || String(v).trim() === '' || /^-+$/.test(String(v).trim()) || Number(String(v).replace('%', '')) === 0);
}

/** Egy scoreboard-válasz szögletadatai (egy liga, egy nap vagy hónap). */
export function parseScoreboardCorners(json: Json, slug: string, leagueId: string): ParsedCorners {
  const results: CornerResult[] = [];
  const skipped: ParsedCorners['skipped'] = [];
  const seen = new Set<string>();
  for (const ev of (Array.isArray(json?.events) ? json.events : []) as Json[]) {
    if (ev?.id == null) continue;
    const matchId = `espn-${slug}-${ev.id}`;
    if (seen.has(matchId)) { skipped.push({ matchId, reason: 'duplicate' }); continue; }
    seen.add(matchId);
    const comp = ev.competitions?.[0];
    const st = (comp?.status ?? ev.status)?.type ?? {};
    if (st.completed !== true) { skipped.push({ matchId, reason: 'not_completed' }); continue; }
    if (/AET|PEN/i.test(String(st.name ?? '')) || /AET|PEN/i.test(String(st.shortDetail ?? ''))) { skipped.push({ matchId, reason: 'extra_time' }); continue; }
    const home = comp?.competitors?.find((c: Json) => c?.homeAway === 'home');
    const away = comp?.competitors?.find((c: Json) => c?.homeAway === 'away');
    if (!home?.team?.id || !away?.team?.id) { skipped.push({ matchId, reason: 'missing_competitor' }); continue; }
    if (isEmptyStatBlock(home, away)) { skipped.push({ matchId, reason: 'empty_stats' }); continue; }
    const hc = readCornerValue(home), ac = readCornerValue(away);
    if (hc === 'invalid' || ac === 'invalid') { skipped.push({ matchId, reason: 'invalid_value' }); continue; }
    if (hc === 'missing' || ac === 'missing') { skipped.push({ matchId, reason: 'missing_value' }); continue; }
    const date = new Date(ev.date ?? comp?.date);
    if (Number.isNaN(date.getTime())) { skipped.push({ matchId, reason: 'missing_competitor' }); continue; }
    results.push({
      matchId, leagueId, date: date.toISOString(),
      homeTeamId: `espn-${home.team.id}`, awayTeamId: `espn-${away.team.id}`,
      homeCorners: hc, awayCorners: ac,
    });
  }
  return { results, skipped };
}

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Az ESPN `dates` paraméteréhez: a keleti idő szerinti nap (YYYYMMDD). */
export function espnDayKey(iso: string): string {
  return ET.format(new Date(iso)).replace(/-/g, '');
}

/** Az ESPN `dates` paraméteréhez: a keleti idő szerinti hónap (YYYYMM). */
export function espnMonthKey(iso: string): string {
  return espnDayKey(iso).slice(0, 6);
}

export function shiftMonth(yyyymm: string, delta: number): string {
  const y = parseInt(yyyymm.slice(0, 4), 10), m = parseInt(yyyymm.slice(4, 6), 10) - 1 + delta;
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * A meccset tartalmazó hónap(ok): az elsődleges a keleti idő szerinti hónap;
 * ha a kezdés 36 órán belül van egy hónaphatártól, a szomszédos hónap is
 * jelölt (tartalékként, ha az event ID nem található az elsődlegesben).
 */
export function candidateMonths(kickoffIso: string): string[] {
  const t = new Date(kickoffIso).getTime();
  const out = [espnMonthKey(kickoffIso)];
  for (const dh of [-36, 36]) {
    const k = espnMonthKey(new Date(t + dh * 3600_000).toISOString());
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** A keleti idő szerinti hónap vége (UTC ISO) – a cache-élettartamhoz. */
export function monthEndUtc(yyyymm: string): number {
  const next = shiftMonth(yyyymm, 1);
  // a következő hónap 1. napja 12:00 UTC biztosan a keleti idő szerinti hónapon túl van
  return Date.UTC(parseInt(next.slice(0, 4), 10), parseInt(next.slice(4, 6), 10) - 1, 1, 12);
}

/**
 * Ligák, ahol a szögletadat ismerten megbízhatatlan – a modell nem fut rájuk.
 * (Mért lefedettség: barátságos válogatott meccsek ~55%. A magyar NB I nincs az
 * ESPN-ben, ezért itt nem is szerepel – nem támogatott.)
 */
export const CORNER_UNSUPPORTED_LEAGUES: Record<string, string> = {
  'fifa-friendly': 'A barátságos válogatott meccseknél a szögletadat a mintákban csak részben (~55%) érhető el – megbízható szögletelemzés nem készül.',
};
