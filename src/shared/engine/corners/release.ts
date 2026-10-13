/**
 * A corners-nb-1 kiadási állapota – EGYETLEN forrás a szervernek és a kliensnek.
 *
 * A `validated` és a `validatedScopes` kizárólag a `scripts/cornersBacktest.ts`
 * valós, időrendi visszatesztjének eredményét rögzíti (docs/corners/backtest-report.md).
 *
 * 2026-10-13-i futás (hangolás: 2024–25; holdout: 2025–26, 4657 értékelhető meccs):
 * - a kiadási kapu összességében átment: log loss Δ −0,0062 (95% CI −0,0084 … −0,0041),
 *   Brier Δ −0,0026 (95% CI −0,0035 … −0,0017) a liga-átlag baseline-hoz képest;
 * - hazai csapat szögletei: Δ −0,0112 (CI −0,0146 … −0,0076) – meggyőző javulás;
 * - vendégcsapat szögletei: Δ −0,0080 (CI −0,0113 … −0,0046) – meggyőző javulás;
 * - ÖSSZES szöglet: Δ −0,0005 (CI −0,0032 … +0,0025) – NEM meggyőző. A két oldal
 *   szögletszáma negatívan korrelál (r = −0,25), a függetlenségi feltételezés
 *   tehát nem teljesül. Ezért az összes szögletre vonatkozó valószínűség NEM kerül
 *   kiadásra (konzervatív döntés; a holdout alapján nem hangoltunk utólag).
 *
 * A kiválasztott paraméterek (k = 20, ablak = 20) a hangolási rács szélén vannak –
 * a következő újrahangolás bővebb ráccsal és ÚJ holdouttal (2026–27) történjen.
 */
import { CORNER_MODEL_VERSION, DEFAULT_CORNER_PARAMS, type CornerModelParams } from './model';
import type { CornerScope } from './markets';

export interface CornerRelease {
  modelVersion: string;
  validated: boolean;
  /** csak ezekre a piaccsoportokra adható ki modell-valószínűség */
  validatedScopes: CornerScope[];
  params: CornerModelParams;
  note: string;
}

export const CORNER_RELEASE: CornerRelease = {
  modelVersion: CORNER_MODEL_VERSION,
  validated: true,
  validatedScopes: ['home', 'away'],
  params: { ...DEFAULT_CORNER_PARAMS, k: 20, window: 20, distribution: 'negbin' },
  note: 'Időrendi visszatesztben (2025–26 holdout) a hazai és vendég szögletpiacokon validált. Az összes szögletre vonatkozó becslés nem bizonyult meggyőzően jobbnak a liga-átlagnál, ezért nem jelenik meg.',
};

/**
 * Szöglettippek (Tippek lista) engedélyezése: csak validált modellnél ÉS
 * kifejezett szerveroldali kapcsolóval (CORNER_TIPS_ENABLED=1). Jelenleg
 * egyik fogyasztó sem generál szöglettippet – ez az előkészített kapu; a
 * bekötéshez külön, szögletspecifikus archívum és elszámolás kell
 * (docs/corners/archive-migration-plan.md).
 */
export function cornerTipsEnabled(release: CornerRelease, env: Record<string, string | undefined>): boolean {
  return release.validated && release.validatedScopes.length > 0 && env.CORNER_TIPS_ENABLED === '1';
}
