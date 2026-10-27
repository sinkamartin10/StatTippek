/**
 * Sorozatformátum – melyik sorozatnál van értelme hagyományos bajnoki tabellának.
 *
 * Csak a valódi bajnokság kap tabellát (3-1-0 pontszámítás, helyezések). A többinél a 3-1-0 pontozás
 * félrevezető rangsort adna, ezért ott a felület a mérkőzéseket és eredményeket mutatja:
 *  - hazai kupa (pl. DFB-Pokal): egyenes kiesés – a továbbjutásról a párharc dönt (hosszabbítás, tizenegyes),
 *  - nemzetközi klubkupa (BL, EL, KL): ligaszakasz + egyenes kiesés; a ligaszakasz hivatalos tabellájához a
 *    szakaszokat szét kellene választani, de az elérhető eredményekben nincs megbízható szakasz/forduló-adat,
 *  - válogatott sorozat (Nemzetek Ligája, vb-selejtező): csoportokra osztva – egyetlen közös tabella hamis lenne,
 *  - barátságos mérkőzések: nincs tabella.
 */
import type { League, MatchResult, Team } from './types';

/** Kupa / nem-bajnoki sorozat egy eredménysora a Statisztikák oldalon (a tabella helyett). */
export interface CompetitionResultRow extends MatchResult { homeTeam: Team | null; awayTeam: Team | null }
/** Ennyi legfrissebb eredményt adunk ki egy sorozatból (a teljes szám külön mezőben). */
export const COMPETITION_RESULTS_LIMIT = 100;

export type CompetitionFormat = 'league' | 'domestic_cup' | 'club_intl_cup' | 'national_team' | 'friendly';

/** Válogatott (csoportos / kieséses) sorozatok és a barátságos meccsek azonosítói. */
const NATIONAL_TEAM_IDS = new Set(['uefa-nl', 'fifa-wcq-uefa']);
const FRIENDLY_IDS = new Set(['fifa-friendly']);

export function competitionFormat(l: Pick<League, 'id' | 'international' | 'domesticCup'>): CompetitionFormat {
  if (l.domesticCup) return 'domestic_cup';
  if (!l.international) return 'league';
  if (FRIENDLY_IDS.has(l.id)) return 'friendly';
  if (NATIONAL_TEAM_IDS.has(l.id)) return 'national_team';
  return 'club_intl_cup';
}

/** Csak valódi bajnokságnál van hagyományos bajnoki tabella. */
export const hasLeagueTable = (l: Pick<League, 'id' | 'international' | 'domesticCup'>) => competitionFormat(l) === 'league';

/** A nem-bajnoki formátumok felirata és magyarázata a felületen. */
export const FORMAT_INFO: Record<Exclude<CompetitionFormat, 'league'>, { label: string; text: string }> = {
  domestic_cup: {
    label: 'Kieséses hazai kupa',
    text: 'Egyenes kieséses sorozat, ezért nincs tabella: a továbbjutásról a párharc dönt (szükség esetén hosszabbítással és tizenegyespárbajjal).',
  },
  club_intl_cup: {
    label: 'Nemzetközi kupa',
    text: 'Ligaszakasz és egyenes kieséses szakasz. Tabellát nem számolunk: az elérhető eredményekből a szakaszok nem választhatók szét megbízhatóan, így egy közös pontsorrend félrevezető lenne.',
  },
  national_team: {
    label: 'Válogatott sorozat',
    text: 'Csoportokra osztott (és kieséses) válogatott sorozat, ezért egyetlen közös tabella félrevezető lenne.',
  },
  friendly: {
    label: 'Barátságos mérkőzések',
    text: 'Barátságos mérkőzések – ezekből nincs tabella.',
  },
};
