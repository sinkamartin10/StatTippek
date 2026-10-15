/**
 * ESPN havi scoreboard → végeredmények (a több ligás modell tanítóadata).
 *
 * EGYETLEN értelmező: ezt használja az élő szerver (xs-strength-1 tanítóadat) és az
 * offline validáció is (scripts/lib/espnDataset.ts), így a kettő ugyanazt az adatot látja.
 * Szabályok: csak befejezett meccs; érvényes eredmény és csapat kell; a bemutató-meccsek
 * (pl. MLS All-Stars) kimaradnak; a hosszabbítással/tizenegyesekkel eldőlt meccs megjelölve
 * (`regulation: false` – a forrás eredménye ilyenkor nem a 90 perces).
 */
export interface ScoreboardResult {
  /** `espn-<slug>-<eseményazonosító>` – ugyanaz a formátum, mint a szolgáltató eredményeinél */
  id: string;
  competitionId: string;
  date: string;
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number;
  awayGoals: number;
  regulation: boolean;
}

export type ScoreboardSkip = 'not_completed' | 'invalid_score_or_team' | 'exhibition_all_stars';

const EXHIBITION = /all[- ]?stars?/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseScoreboardResults(json: any, slug: string, competitionId: string): { results: ScoreboardResult[]; skipped: ScoreboardSkip[] } {
  const results: ScoreboardResult[] = [];
  const skipped: ScoreboardSkip[] = [];
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const ev of (Array.isArray(json?.events) ? json.events : []) as any[]) {
    if (ev?.id == null) continue;
    const id = `espn-${slug}-${ev.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = ev.competitions?.[0];
    const st = (c?.status ?? ev.status)?.type ?? {};
    if (st.completed !== true) { skipped.push('not_completed'); continue; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = c?.competitors?.find((x: any) => x?.homeAway === 'home');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = c?.competitors?.find((x: any) => x?.homeAway === 'away');
    const hg = Number(h?.score?.value ?? h?.score), ag = Number(a?.score?.value ?? a?.score);
    const date = new Date(ev.date ?? c?.date);
    if (!h?.team?.id || !a?.team?.id || !Number.isFinite(hg) || !Number.isFinite(ag) || Number.isNaN(date.getTime())) { skipped.push('invalid_score_or_team'); continue; }
    if (EXHIBITION.test(String(h.team.displayName ?? '')) || EXHIBITION.test(String(a.team.displayName ?? ''))) { skipped.push('exhibition_all_stars'); continue; }
    const regulation = !(/AET|PEN/i.test(String(st.name ?? '')) || /AET|PEN/i.test(String(st.shortDetail ?? '')));
    results.push({ id, competitionId, date: date.toISOString(), homeTeamId: `espn-${h.team.id}`, awayTeamId: `espn-${a.team.id}`, homeGoals: hg, awayGoals: ag, regulation });
  }
  return { results, skipped };
}
