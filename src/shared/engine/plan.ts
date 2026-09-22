/**
 * FREE / PRO szabályok – EGY helyen, a szerver és a kliens ugyanezt használja.
 * A jogosultságot mindig a szerver dönti el (profiles tábla); a kliens csak a megjelenítéshez használja ezeket.
 */
import type { MatchAnalysis, TipListEntry, TipSuggestion } from '../types';

export const FREE_DAILY_TIPS = 3;

/** FREE napi mérkőzés-kvóta: 1–5 meccs → 1 · 6–15 → 2 · 16+ → 3 */
export function freeMatchQuota(matchesOnDay: number): number {
  if (matchesOnDay <= 0) return 0;
  if (matchesOnDay <= 5) return 1;
  if (matchesOnDay <= 15) return 2;
  return 3;
}

/** A nap ingyenesen elemezhető meccsei: determinisztikusan a kezdési idő szerinti első N. */
export function freeMatchIds(matches: { id: string; kickoff: string }[]): Set<string> {
  const sorted = [...matches].sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
  return new Set(sorted.slice(0, freeMatchQuota(sorted.length)).map((m) => m.id));
}

/** FREE: a tipp modell-indoklása nem elérhető – a szerver kiüríti, nem csak a felület rejti el. */
export function redactTipForFree(t: TipSuggestion): TipSuggestion {
  return { ...t, supportingStats: [], reasonsFor: [], reasonsAgainst: [], risks: [] };
}

/** FREE: a napi tipplista rövidítése + indoklás nélkül. */
export function redactTipsForFree(list: TipListEntry[]): TipListEntry[] {
  return [...list]
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff))
    .slice(0, FREE_DAILY_TIPS)
    .map((e) => ({ ...e, tip: redactTipForFree(e.tip) }));
}

/**
 * FREE: a részletes statisztikák és a modell indoklásai kikerülnek a válaszból.
 * A gyors áttekintéshez szükséges összesítők (forma-string, átlagok, 1X2/gólpiac becslés, odds, hírek, források) maradnak.
 */
export function redactAnalysisForFree(a: MatchAnalysis): MatchAnalysis {
  const strip = (f: MatchAnalysis['form']['homeLast10']) => ({ ...f, matches: [] });
  return {
    ...a,
    form: {
      homeLast5: strip(a.form.homeLast5),
      homeLast10: strip(a.form.homeLast10),
      awayLast5: strip(a.form.awayLast5),
      awayLast10: strip(a.form.awayLast10),
      homeAtHome: strip(a.form.homeAtHome),
      awayAtAway: strip(a.form.awayAtAway),
      interpretation: [],
    },
    h2h: { ...a.h2h, matches: [] },
    goalMarkets: [],
    xg: a.xg ? { ...a.xg, notes: [] } : null,
    poisson: a.poisson ? { ...a.poisson, matrix: [], correctScores: [] } : null,
    oneXtwoFactors: [],
    tips: a.tips.map(redactTipForFree),
  };
}
