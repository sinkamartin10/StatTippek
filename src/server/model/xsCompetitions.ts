/**
 * A több ligás modell sorozatai: a felületen elérhető ESPN-sorozatok és a csak-előzmény
 * hazai bajnokságok (historyPlan). Egyetlen forrás az élő szervernek és az offline validációnak.
 */
import { ESPN_LEAGUES } from '../data/espnProvider';
import { HISTORY_ONLY_DOMESTIC, NATIONAL_COMPETITIONS } from '../data/historyPlan';
import type { CompetitionKind } from '../../shared/engine/experimental/crossLeague';

export const XS_KINDS: Record<string, CompetitionKind> = {
  ...Object.fromEntries(ESPN_LEAGUES.map((l) => [l.id, NATIONAL_COMPETITIONS.has(l.id) ? 'national' : l.international ? 'club_intl' : 'domestic'])),
  ...Object.fromEntries(Object.keys(HISTORY_ONLY_DOMESTIC).map((id) => [id, 'domestic' as const])),
};

/** Minden sorozat, amelynek havi eredménylistája a tanítóadatba kerül. */
export const XS_TRAINING_COMPETITIONS: string[] = Object.keys(XS_KINDS);
