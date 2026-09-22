/**
 * DEMO ADAT – bajnokságok és csapatok listája.
 * Új bajnokság hozzáadása: vegyél fel egy új bejegyzést a LEAGUES tömbbe és a csapatait a TEAMS-be.
 * Az "strength" mező a demo-eredmény-generátor támadó/védő erőssége (1.0 = átlagos), NEM valós adat.
 */
import type { League } from '../../../shared/types';

export interface DemoTeamDef {
  id: string;
  name: string;
  shortName: string;
  country: string;
  leagueId: string;
  attack: number;
  defense: number;
}

export const LEAGUES: League[] = [
  { id: 'eng-pl', name: 'Premier League', country: 'Anglia', countryCode: 'ENG', tier: 1, international: false, externalId: 39 },
  { id: 'esp-ll', name: 'La Liga', country: 'Spanyolország', countryCode: 'ESP', tier: 1, international: false, externalId: 140 },
  { id: 'ita-sa', name: 'Serie A', country: 'Olaszország', countryCode: 'ITA', tier: 1, international: false, externalId: 135 },
  { id: 'ger-bl', name: 'Bundesliga', country: 'Németország', countryCode: 'GER', tier: 1, international: false, externalId: 78 },
  { id: 'fra-l1', name: 'Ligue 1', country: 'Franciaország', countryCode: 'FRA', tier: 1, international: false, externalId: 61 },
  { id: 'uefa-ucl', name: 'Bajnokok Ligája', country: 'Európa', countryCode: 'EUR', tier: 0, international: true, externalId: 2 },
  { id: 'uefa-uel', name: 'Európa-liga', country: 'Európa', countryCode: 'EUR', tier: 0, international: true, externalId: 3 },
  { id: 'uefa-uecl', name: 'Konferencia-liga', country: 'Európa', countryCode: 'EUR', tier: 0, international: true, externalId: 848 },
  { id: 'usa-mls', name: 'MLS', country: 'USA', countryCode: 'USA', tier: 1, international: false, externalId: 253 },
  { id: 'hun-nb1', name: 'NB I', country: 'Magyarország', countryCode: 'HUN', tier: 1, international: false, externalId: 271 },
  { id: 'hun-nb2', name: 'NB II', country: 'Magyarország', countryCode: 'HUN', tier: 2, international: false, externalId: 272 },
];

const t = (id: string, name: string, shortName: string, country: string, leagueId: string, attack: number, defense: number): DemoTeamDef =>
  ({ id, name, shortName, country, leagueId, attack, defense });

export const TEAMS: DemoTeamDef[] = [
  // Premier League
  t('arsenal', 'Arsenal', 'Arsenal', 'Anglia', 'eng-pl', 1.45, 0.65),
  t('man-city', 'Manchester City', 'Man City', 'Anglia', 'eng-pl', 1.5, 0.7),
  t('liverpool', 'Liverpool', 'Liverpool', 'Anglia', 'eng-pl', 1.5, 0.72),
  t('chelsea', 'Chelsea', 'Chelsea', 'Anglia', 'eng-pl', 1.25, 0.85),
  t('tottenham', 'Tottenham Hotspur', 'Tottenham', 'Anglia', 'eng-pl', 1.2, 1.0),
  t('man-utd', 'Manchester United', 'Man Utd', 'Anglia', 'eng-pl', 1.05, 0.95),
  t('newcastle', 'Newcastle United', 'Newcastle', 'Anglia', 'eng-pl', 1.2, 0.85),
  t('aston-villa', 'Aston Villa', 'Aston Villa', 'Anglia', 'eng-pl', 1.15, 0.9),
  t('brighton', 'Brighton & Hove Albion', 'Brighton', 'Anglia', 'eng-pl', 1.1, 1.0),
  t('west-ham', 'West Ham United', 'West Ham', 'Anglia', 'eng-pl', 0.95, 1.1),
  t('crystal-palace', 'Crystal Palace', 'Crystal Palace', 'Anglia', 'eng-pl', 0.95, 0.9),
  t('brentford', 'Brentford', 'Brentford', 'Anglia', 'eng-pl', 1.05, 1.05),
  t('fulham', 'Fulham', 'Fulham', 'Anglia', 'eng-pl', 1.0, 1.0),
  t('bournemouth', 'AFC Bournemouth', 'Bournemouth', 'Anglia', 'eng-pl', 1.05, 1.0),
  t('everton', 'Everton', 'Everton', 'Anglia', 'eng-pl', 0.8, 0.95),
  t('wolves', 'Wolverhampton Wanderers', 'Wolves', 'Anglia', 'eng-pl', 0.85, 1.15),
  t('nottm-forest', 'Nottingham Forest', 'Nottm Forest', 'Anglia', 'eng-pl', 0.95, 0.9),
  t('leicester', 'Leicester City', 'Leicester', 'Anglia', 'eng-pl', 0.8, 1.25),
  t('ipswich', 'Ipswich Town', 'Ipswich', 'Anglia', 'eng-pl', 0.75, 1.3),
  t('southampton', 'Southampton', 'Southampton', 'Anglia', 'eng-pl', 0.7, 1.35),
  // La Liga
  t('real-madrid', 'Real Madrid', 'Real Madrid', 'Spanyolország', 'esp-ll', 1.5, 0.7),
  t('barcelona', 'FC Barcelona', 'Barcelona', 'Spanyolország', 'esp-ll', 1.55, 0.8),
  t('atletico', 'Atlético Madrid', 'Atlético', 'Spanyolország', 'esp-ll', 1.2, 0.65),
  t('athletic', 'Athletic Bilbao', 'Athletic', 'Spanyolország', 'esp-ll', 1.05, 0.75),
  t('villarreal', 'Villarreal', 'Villarreal', 'Spanyolország', 'esp-ll', 1.15, 1.0),
  t('real-sociedad', 'Real Sociedad', 'R. Sociedad', 'Spanyolország', 'esp-ll', 0.95, 0.85),
  t('betis', 'Real Betis', 'Betis', 'Spanyolország', 'esp-ll', 1.0, 0.95),
  t('sevilla', 'Sevilla', 'Sevilla', 'Spanyolország', 'esp-ll', 0.9, 1.05),
  t('valencia', 'Valencia', 'Valencia', 'Spanyolország', 'esp-ll', 0.85, 1.05),
  t('girona', 'Girona', 'Girona', 'Spanyolország', 'esp-ll', 0.95, 1.05),
  t('osasuna', 'Osasuna', 'Osasuna', 'Spanyolország', 'esp-ll', 0.9, 1.0),
  t('celta', 'Celta Vigo', 'Celta', 'Spanyolország', 'esp-ll', 1.0, 1.1),
  t('mallorca', 'RCD Mallorca', 'Mallorca', 'Spanyolország', 'esp-ll', 0.8, 0.9),
  t('rayo', 'Rayo Vallecano', 'Rayo', 'Spanyolország', 'esp-ll', 0.9, 1.0),
  t('getafe', 'Getafe', 'Getafe', 'Spanyolország', 'esp-ll', 0.7, 0.85),
  t('alaves', 'Deportivo Alavés', 'Alavés', 'Spanyolország', 'esp-ll', 0.8, 1.05),
  t('espanyol', 'Espanyol', 'Espanyol', 'Spanyolország', 'esp-ll', 0.8, 1.1),
  t('las-palmas', 'Las Palmas', 'Las Palmas', 'Spanyolország', 'esp-ll', 0.85, 1.2),
  t('leganes', 'Leganés', 'Leganés', 'Spanyolország', 'esp-ll', 0.75, 1.1),
  t('valladolid', 'Real Valladolid', 'Valladolid', 'Spanyolország', 'esp-ll', 0.65, 1.4),
  // Serie A
  t('inter', 'Inter', 'Inter', 'Olaszország', 'ita-sa', 1.5, 0.7),
  t('napoli', 'Napoli', 'Napoli', 'Olaszország', 'ita-sa', 1.25, 0.65),
  t('atalanta', 'Atalanta', 'Atalanta', 'Olaszország', 'ita-sa', 1.45, 0.85),
  t('juventus', 'Juventus', 'Juventus', 'Olaszország', 'ita-sa', 1.1, 0.7),
  t('milan', 'AC Milan', 'Milan', 'Olaszország', 'ita-sa', 1.2, 0.95),
  t('lazio', 'Lazio', 'Lazio', 'Olaszország', 'ita-sa', 1.15, 0.95),
  t('roma', 'AS Roma', 'Roma', 'Olaszország', 'ita-sa', 1.1, 0.9),
  t('fiorentina', 'Fiorentina', 'Fiorentina', 'Olaszország', 'ita-sa', 1.1, 0.9),
  t('bologna', 'Bologna', 'Bologna', 'Olaszország', 'ita-sa', 1.05, 0.95),
  t('torino', 'Torino', 'Torino', 'Olaszország', 'ita-sa', 0.85, 0.95),
  t('udinese', 'Udinese', 'Udinese', 'Olaszország', 'ita-sa', 0.9, 1.05),
  t('genoa', 'Genoa', 'Genoa', 'Olaszország', 'ita-sa', 0.8, 1.0),
  t('como', 'Como', 'Como', 'Olaszország', 'ita-sa', 0.9, 1.1),
  t('verona', 'Hellas Verona', 'Verona', 'Olaszország', 'ita-sa', 0.75, 1.2),
  t('cagliari', 'Cagliari', 'Cagliari', 'Olaszország', 'ita-sa', 0.8, 1.1),
  t('parma', 'Parma', 'Parma', 'Olaszország', 'ita-sa', 0.9, 1.2),
  t('lecce', 'Lecce', 'Lecce', 'Olaszország', 'ita-sa', 0.65, 1.15),
  t('empoli', 'Empoli', 'Empoli', 'Olaszország', 'ita-sa', 0.7, 1.1),
  t('venezia', 'Venezia', 'Venezia', 'Olaszország', 'ita-sa', 0.75, 1.2),
  t('monza', 'Monza', 'Monza', 'Olaszország', 'ita-sa', 0.7, 1.25),
  // Bundesliga
  t('bayern', 'Bayern München', 'Bayern', 'Németország', 'ger-bl', 1.7, 0.7),
  t('leverkusen', 'Bayer Leverkusen', 'Leverkusen', 'Németország', 'ger-bl', 1.45, 0.85),
  t('dortmund', 'Borussia Dortmund', 'Dortmund', 'Németország', 'ger-bl', 1.3, 1.0),
  t('leipzig', 'RB Leipzig', 'Leipzig', 'Németország', 'ger-bl', 1.2, 0.9),
  t('frankfurt', 'Eintracht Frankfurt', 'Frankfurt', 'Németország', 'ger-bl', 1.3, 1.0),
  t('stuttgart', 'VfB Stuttgart', 'Stuttgart', 'Németország', 'ger-bl', 1.25, 1.05),
  t('freiburg', 'SC Freiburg', 'Freiburg', 'Németország', 'ger-bl', 1.0, 1.0),
  t('mainz', 'Mainz 05', 'Mainz', 'Németország', 'ger-bl', 1.05, 0.9),
  t('gladbach', 'Borussia Mönchengladbach', 'Gladbach', 'Németország', 'ger-bl', 1.05, 1.1),
  t('wolfsburg', 'VfL Wolfsburg', 'Wolfsburg', 'Németország', 'ger-bl', 1.05, 1.1),
  t('augsburg', 'FC Augsburg', 'Augsburg', 'Németország', 'ger-bl', 0.85, 1.0),
  t('bremen', 'Werder Bremen', 'Bremen', 'Németország', 'ger-bl', 1.05, 1.15),
  t('union', 'Union Berlin', 'Union Berlin', 'Németország', 'ger-bl', 0.8, 1.0),
  t('hoffenheim', 'TSG Hoffenheim', 'Hoffenheim', 'Németország', 'ger-bl', 0.95, 1.25),
  t('heidenheim', '1. FC Heidenheim', 'Heidenheim', 'Németország', 'ger-bl', 0.85, 1.25),
  t('st-pauli', 'FC St. Pauli', 'St. Pauli', 'Németország', 'ger-bl', 0.7, 0.95),
  t('kiel', 'Holstein Kiel', 'Kiel', 'Németország', 'ger-bl', 0.9, 1.5),
  t('bochum', 'VfL Bochum', 'Bochum', 'Németország', 'ger-bl', 0.75, 1.4),
  // Ligue 1
  t('psg', 'Paris Saint-Germain', 'PSG', 'Franciaország', 'fra-l1', 1.7, 0.65),
  t('marseille', 'Olympique Marseille', 'Marseille', 'Franciaország', 'fra-l1', 1.3, 0.95),
  t('monaco', 'AS Monaco', 'Monaco', 'Franciaország', 'fra-l1', 1.25, 0.9),
  t('lille', 'LOSC Lille', 'Lille', 'Franciaország', 'fra-l1', 1.1, 0.8),
  t('lyon', 'Olympique Lyon', 'Lyon', 'Franciaország', 'fra-l1', 1.2, 0.95),
  t('nice', 'OGC Nice', 'Nice', 'Franciaország', 'fra-l1', 1.15, 0.9),
  t('lens', 'RC Lens', 'Lens', 'Franciaország', 'fra-l1', 0.95, 0.85),
  t('strasbourg', 'RC Strasbourg', 'Strasbourg', 'Franciaország', 'fra-l1', 1.05, 1.0),
  t('brest', 'Stade Brestois', 'Brest', 'Franciaország', 'fra-l1', 1.0, 1.05),
  t('rennes', 'Stade Rennais', 'Rennes', 'Franciaország', 'fra-l1', 1.0, 1.0),
  t('toulouse', 'Toulouse FC', 'Toulouse', 'Franciaország', 'fra-l1', 0.9, 0.95),
  t('auxerre', 'AJ Auxerre', 'Auxerre', 'Franciaország', 'fra-l1', 0.9, 1.05),
  t('reims', 'Stade de Reims', 'Reims', 'Franciaország', 'fra-l1', 0.8, 1.1),
  t('nantes', 'FC Nantes', 'Nantes', 'Franciaország', 'fra-l1', 0.8, 1.1),
  t('angers', 'Angers SCO', 'Angers', 'Franciaország', 'fra-l1', 0.75, 1.15),
  t('le-havre', 'Le Havre AC', 'Le Havre', 'Franciaország', 'fra-l1', 0.8, 1.3),
  t('saint-etienne', 'AS Saint-Étienne', 'St-Étienne', 'Franciaország', 'fra-l1', 0.75, 1.4),
  t('montpellier', 'Montpellier HSC', 'Montpellier', 'Franciaország', 'fra-l1', 0.65, 1.45),
  // MLS
  t('inter-miami', 'Inter Miami CF', 'Inter Miami', 'USA', 'usa-mls', 1.5, 1.05),
  t('la-galaxy', 'LA Galaxy', 'LA Galaxy', 'USA', 'usa-mls', 1.35, 1.0),
  t('lafc', 'Los Angeles FC', 'LAFC', 'USA', 'usa-mls', 1.3, 0.9),
  t('columbus', 'Columbus Crew', 'Columbus', 'USA', 'usa-mls', 1.3, 0.95),
  t('cincinnati', 'FC Cincinnati', 'Cincinnati', 'USA', 'usa-mls', 1.15, 0.95),
  t('seattle', 'Seattle Sounders', 'Seattle', 'USA', 'usa-mls', 1.1, 0.9),
  t('orlando', 'Orlando City', 'Orlando', 'USA', 'usa-mls', 1.1, 1.0),
  t('nycfc', 'New York City FC', 'NYCFC', 'USA', 'usa-mls', 1.05, 1.0),
  t('ny-red-bulls', 'New York Red Bulls', 'NY Red Bulls', 'USA', 'usa-mls', 1.0, 1.05),
  t('atlanta', 'Atlanta United', 'Atlanta', 'USA', 'usa-mls', 1.05, 1.1),
  t('portland', 'Portland Timbers', 'Portland', 'USA', 'usa-mls', 1.1, 1.15),
  t('philadelphia', 'Philadelphia Union', 'Philadelphia', 'USA', 'usa-mls', 1.0, 1.1),
  t('charlotte', 'Charlotte FC', 'Charlotte', 'USA', 'usa-mls', 0.95, 0.95),
  t('nashville', 'Nashville SC', 'Nashville', 'USA', 'usa-mls', 0.9, 1.05),
  t('toronto', 'Toronto FC', 'Toronto', 'Kanada', 'usa-mls', 0.9, 1.2),
  t('chicago', 'Chicago Fire', 'Chicago', 'USA', 'usa-mls', 0.9, 1.2),
  // NB I
  t('ferencvaros', 'Ferencvárosi TC', 'Ferencváros', 'Magyarország', 'hun-nb1', 1.5, 0.7),
  t('puskas', 'Puskás Akadémia', 'Puskás AFC', 'Magyarország', 'hun-nb1', 1.2, 0.85),
  t('paks', 'Paksi FC', 'Paks', 'Magyarország', 'hun-nb1', 1.3, 1.05),
  t('mtk', 'MTK Budapest', 'MTK', 'Magyarország', 'hun-nb1', 1.1, 1.0),
  t('ujpest', 'Újpest FC', 'Újpest', 'Magyarország', 'hun-nb1', 0.95, 1.0),
  t('debrecen', 'Debreceni VSC', 'Debrecen', 'Magyarország', 'hun-nb1', 1.0, 1.1),
  t('gyor', 'ETO FC Győr', 'ETO Győr', 'Magyarország', 'hun-nb1', 1.05, 0.95),
  t('diosgyor', 'Diósgyőri VTK', 'DVTK', 'Magyarország', 'hun-nb1', 0.95, 1.05),
  t('zalaegerszeg', 'Zalaegerszegi TE', 'ZTE', 'Magyarország', 'hun-nb1', 0.95, 1.1),
  t('nyiregyhaza', 'Nyíregyháza Spartacus', 'Nyíregyháza', 'Magyarország', 'hun-nb1', 0.85, 1.2),
  t('kecskemet', 'Kecskeméti TE', 'Kecskemét', 'Magyarország', 'hun-nb1', 0.8, 1.25),
  t('fehervar', 'Fehérvár FC', 'Fehérvár', 'Magyarország', 'hun-nb1', 0.85, 1.15),
  // NB II
  t('honved', 'Budapest Honvéd', 'Honvéd', 'Magyarország', 'hun-nb2', 1.2, 0.85),
  t('vasas', 'Vasas FC', 'Vasas', 'Magyarország', 'hun-nb2', 1.15, 0.85),
  t('szeged', 'Szeged-Csanád GA', 'Szeged', 'Magyarország', 'hun-nb2', 1.05, 0.95),
  t('kazincbarcika', 'Kazincbarcikai SC', 'Kazincbarcika', 'Magyarország', 'hun-nb2', 1.1, 0.9),
  t('bekescsaba', 'Békéscsaba 1912 Előre', 'Békéscsaba', 'Magyarország', 'hun-nb2', 1.0, 1.0),
  t('csakvar', 'Aqvital FC Csákvár', 'Csákvár', 'Magyarország', 'hun-nb2', 0.9, 1.0),
  t('kisvarda', 'Kisvárda FC', 'Kisvárda', 'Magyarország', 'hun-nb2', 1.15, 0.9),
  t('soroksar', 'Soroksár SC', 'Soroksár', 'Magyarország', 'hun-nb2', 0.9, 1.05),
  t('ajka', 'FC Ajka', 'Ajka', 'Magyarország', 'hun-nb2', 0.95, 1.0),
  t('gyirmot', 'Gyirmót FC Győr', 'Gyirmót', 'Magyarország', 'hun-nb2', 0.9, 1.05),
  t('tiszakecske', 'Tiszakécske LC', 'Tiszakécske', 'Magyarország', 'hun-nb2', 0.85, 1.1),
  t('siofok', 'BFC Siófok', 'Siófok', 'Magyarország', 'hun-nb2', 0.8, 1.15),
  t('budafok', 'Budafoki MTE', 'Budafok', 'Magyarország', 'hun-nb2', 0.85, 1.1),
  t('mezokovesd', 'Mezőkövesd Zsóry', 'Mezőkövesd', 'Magyarország', 'hun-nb2', 0.9, 1.05),
  t('kozarmisleny', 'Kozármisleny SE', 'Kozármisleny', 'Magyarország', 'hun-nb2', 0.75, 1.2),
  t('sopron', 'Soproni VSE', 'Sopron', 'Magyarország', 'hun-nb2', 0.75, 1.25),
];

/** Nemzetközi kupák résztvevői (a bajnokságokból merítve) – ligaszakasz jellegű demo sorsolás. */
export const CUP_PARTICIPANTS: Record<string, string[]> = {
  'uefa-ucl': ['arsenal', 'man-city', 'liverpool', 'real-madrid', 'barcelona', 'atletico', 'inter', 'atalanta', 'juventus', 'bayern', 'leverkusen', 'dortmund', 'psg', 'monaco', 'lille', 'brest'],
  'uefa-uel': ['tottenham', 'man-utd', 'athletic', 'real-sociedad', 'lazio', 'roma', 'frankfurt', 'hoffenheim', 'lyon', 'nice', 'ferencvaros', 'porto-demo'],
  'uefa-uecl': ['chelsea', 'betis', 'fiorentina', 'heidenheim', 'lens', 'gent-demo', 'legia-demo', 'rapid-demo', 'celje-demo', 'vikingur-demo', 'panathinaikos-demo', 'jagiellonia-demo'],
};

/** Kupákban szereplő, a fenti bajnokságokban nem listázott csapatok (demo). */
export const EXTRA_CUP_TEAMS: DemoTeamDef[] = [
  t('porto-demo', 'FC Porto', 'Porto', 'Portugália', 'uefa-uel', 1.2, 0.85),
  t('gent-demo', 'KAA Gent', 'Gent', 'Belgium', 'uefa-uecl', 1.0, 1.05),
  t('legia-demo', 'Legia Warszawa', 'Legia', 'Lengyelország', 'uefa-uecl', 1.0, 1.0),
  t('rapid-demo', 'Rapid Wien', 'Rapid Wien', 'Ausztria', 'uefa-uecl', 1.05, 1.0),
  t('celje-demo', 'NK Celje', 'Celje', 'Szlovénia', 'uefa-uecl', 0.95, 1.15),
  t('vikingur-demo', 'Víkingur Reykjavík', 'Víkingur', 'Izland', 'uefa-uecl', 0.8, 1.2),
  t('panathinaikos-demo', 'Panathinaikos', 'Panathinaikos', 'Görögország', 'uefa-uecl', 1.05, 0.95),
  t('jagiellonia-demo', 'Jagiellonia Białystok', 'Jagiellonia', 'Lengyelország', 'uefa-uecl', 0.95, 1.1),
];

/** Rangadók (derbik) – a meccs fontosságának jelzéséhez. */
export const DERBIES: [string, string, string][] = [
  ['arsenal', 'tottenham', 'Észak-londoni derbi'],
  ['liverpool', 'man-utd', 'Északnyugati derbi'],
  ['man-city', 'man-utd', 'Manchesteri derbi'],
  ['arsenal', 'chelsea', 'Londoni derbi'],
  ['chelsea', 'tottenham', 'Londoni derbi'],
  ['real-madrid', 'barcelona', 'El Clásico'],
  ['real-madrid', 'atletico', 'Madridi derbi'],
  ['sevilla', 'betis', 'Sevillai derbi'],
  ['inter', 'milan', 'Derby della Madonnina'],
  ['roma', 'lazio', 'Derby della Capitale'],
  ['juventus', 'torino', 'Derby della Mole'],
  ['bayern', 'dortmund', 'Der Klassiker'],
  ['dortmund', 'gladbach', 'Ruhr-vidéki rangadó'],
  ['psg', 'marseille', 'Le Classique'],
  ['lyon', 'saint-etienne', 'Derby du Rhône'],
  ['la-galaxy', 'lafc', 'El Tráfico'],
  ['ferencvaros', 'ujpest', 'Budapesti örökrangadó'],
  ['ferencvaros', 'mtk', 'Budapesti rangadó'],
  ['honved', 'vasas', 'Budapesti rangadó'],
  ['debrecen', 'diosgyor', 'Keleti rangadó'],
];
