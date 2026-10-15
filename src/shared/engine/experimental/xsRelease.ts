/**
 * `xs-strength-1` – a PRO-kiszolgálás RÖGZÍTETT beállításai.
 *
 * Minden érték az időrendi validációból származik (docs/model-learning/cross-league/
 * report.md és result.json), NEM itt hangoltuk:
 *  - paraméterek: a 2024-25-ös validációs idényen választva (elsődleges mérőszám: 1X2 log loss),
 *  - kategória-küszöbök: az ELŐRE RÖGZÍTETT szabály szerint (a post-hoc, halmozott szabály
 *    nem került be, mert nem megerősítő),
 *  - teszt (2025-26, egyszeri): az éles xg-poisson-1-hez képest Δ 1X2 log loss −0,0368
 *    (95% CI −0,0454 … −0,0284; n = 4508).
 * Módosításuk csak új, dokumentált validációval történhet.
 */
import type { XsParams, XsQualityThresholds } from './crossLeague';

export const XS_RELEASE = {
  params: { halfLifeDays: 365, sigmaTeam: 0.5, sigmaGroup: 0.35 } satisfies XsParams,
  thresholds: { sdGood: 0.2904506701045574, sdLimited: 0.38744307370571823, sdMax: 0.38744307370571823 } satisfies XsQualityThresholds,
  /** a validáció adatkészlet-ujjlenyomata */
  validationDatasetSha256: '7b00462df8c4919052472da7481bcb708bcdef7e7f95595de077cf84f129cc46',
  /** csak ennél legalább ennyi órával korábban kezdődött (lezárt) meccsekből tanul */
  closedHours: 3,
} as const;
