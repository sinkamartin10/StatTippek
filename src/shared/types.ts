/**
 * Közös típusdefiníciók – a UI, a kutatómotor és az elemzőmotor közötti szerződés.
 * Minden adat "origin" mezőt hordoz: 'demo' (beépített DEMO ADAT) vagy 'live' (külső szolgáltatóból).
 * A két adatforrás soha nem keveredik.
 */

export type DataOrigin = 'demo' | 'live';

export interface League {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  /** 1 = első osztály, 2 = másodosztály, 0 = nemzetközi kupa */
  tier: number;
  international: boolean;
  /** külső szolgáltató azonosítója (pl. API-Football league id) – opcionális */
  externalId?: number;
}

export interface Team {
  id: string;
  name: string;
  shortName: string;
  country: string;
  /** elsődleges bajnokság */
  leagueId: string;
  externalId?: number;
  /** alternatív (pl. angol) nevek – külső források párosításához */
  altNames?: string[];
}

export type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed';
export type MatchImportance = 'low' | 'normal' | 'high' | 'top';

export interface Match {
  id: string;
  leagueId: string;
  homeTeamId: string;
  awayTeamId: string;
  /** ISO 8601 időbélyeg */
  kickoff: string;
  status: MatchStatus;
  round?: string;
  importance: MatchImportance;
  importanceReasons: string[];
  homeGoals?: number;
  awayGoals?: number;
  origin: DataOrigin;
}

/** Lejátszott mérkőzés – a statisztikai motor bemenete */
export interface MatchResult {
  id: string;
  leagueId: string;
  date: string;
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number;
  awayGoals: number;
  htHomeGoals?: number;
  htAwayGoals?: number;
  origin: DataOrigin;
}

export interface MatchOdds {
  matchId: string;
  /** honnan származik: 'manual' = felhasználó adta meg, 'demo', 'live' */
  source: 'manual' | 'demo' | 'live';
  bookmaker?: string;
  retrievedAt: string;
  /** piackód -> tizedes odds */
  markets: Record<string, number>;
  /** piackód -> fogadóiroda neve (ha piaconként más irodától származik a legjobb odds) */
  bookmakers?: Record<string, string>;
}

// ---------- Kutatómotor (internetes keresés) ----------

export type SourceType =
  | 'statisztika'
  | 'hír'
  | 'külső előrejelzés'
  | 'hivatalos'
  | 'odds'
  | 'demo';

export interface SourceRecord {
  id: string;
  matchId: string;
  sourceName: string;
  /** Valódi URL, vagy null ha nincs ellenőrizhető hivatkozás. Soha nem generált URL. */
  url: string | null;
  retrievedAt: string;
  publishedAt?: string | null;
  type: SourceType;
  /** A forrásból kinyert információ (idézet vagy összefoglaló) */
  extracted: string;
  /** hogyan nyertük ki: 'kereső találat', 'API', 'demo' */
  method: string;
  origin: DataOrigin;
}

export type NewsCategory =
  | 'sérülés'
  | 'eltiltás'
  | 'felállás'
  | 'edző'
  | 'átigazolás'
  | 'rotáció'
  | 'menetrend'
  | 'általános';

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  url: string | null;
  sourceName: string;
  publishedAt?: string | null;
  teamId?: string;
  category: NewsCategory;
  origin: DataOrigin;
  sourceId: string;
}

export interface TeamAvailability {
  teamId: string;
  injuries: { player: string; detail: string; sourceId: string }[];
  suspensions: { player: string; detail: string; sourceId: string }[];
  lineupStatus: 'nincs adat' | 'várható' | 'megerősített';
  lineupNote?: string;
  restDays?: number;
  midweekEuropeanMatch?: boolean;
  notes: string[];
}

export interface ExternalPrediction {
  id: string;
  sourceName: string;
  url: string | null;
  publishedAt?: string | null;
  /** eredeti szöveges tipp */
  originalText: string;
  /** normalizált piackód, ha felismerhető (pl. O2.5, BTTS_Y, 1) – null ha nem */
  market: string | null;
  /** a forrás által megadott bizalom (ha van), különben null */
  confidence: string | null;
  sourceId: string;
  origin: DataOrigin;
  /** true, ha a piacot automatikus szövegelemzés ismerte fel, nem a forrás strukturált adata */
  autoExtracted: boolean;
}

export interface ResearchResult {
  matchId: string;
  origin: DataOrigin;
  performedAt: string;
  provider: string;
  news: NewsItem[];
  availability: { home: TeamAvailability; away: TeamAvailability };
  externalPredictions: ExternalPrediction[];
  sources: SourceRecord[];
  /** ha a kutatás nem talált elég adatot, ide kerül a magyarázat */
  warnings: string[];
}

// ---------- Statisztikai motor kimenete ----------

export interface FormMatchRow {
  date: string;
  opponentId: string;
  venue: 'H' | 'A';
  gf: number;
  ga: number;
  result: 'W' | 'D' | 'L';
}

export interface FormSummary {
  teamId: string;
  venue: 'összes' | 'hazai' | 'idegen';
  sampleSize: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  avgGoalsFor: number;
  avgGoalsAgainst: number;
  cleanSheets: number;
  failedToScore: number;
  /** W/D/L string, legfrissebb elöl */
  formString: string;
  points: number;
  /** százalékos gyakoriságok (0–100) */
  over05: number;
  over15: number;
  over25: number;
  over35: number;
  under15: number;
  under25: number;
  under35: number;
  btts: number;
  firstHalfGoalsAvg: number | null;
  secondHalfGoalsAvg: number | null;
  matches: FormMatchRow[];
}

export interface H2HSummary {
  sampleSize: number;
  homeTeamWins: number;
  draws: number;
  awayTeamWins: number;
  avgGoals: number;
  bttsPct: number;
  over25Pct: number;
  matches: { date: string; homeTeamId: string; awayTeamId: string; hg: number; ag: number; leagueId: string }[];
}

export interface StandingRow {
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  position: number;
}

export interface LeagueAverages {
  leagueId: string;
  matches: number;
  avgHomeGoals: number;
  avgAwayGoals: number;
  avgTotalGoals: number;
  homeWinPct: number;
  drawPct: number;
  awayWinPct: number;
  over25Pct: number;
  bttsPct: number;
}

export interface GoalMarketIndicator {
  market: string;
  label: string;
  homePct: number | null;
  awayPct: number | null;
  combinedPct: number | null;
  /** hány meccsen alapul (hazai + vendég minta) */
  sampleSize: number;
}

export interface XgModelResult {
  homeExpected: number;
  awayExpected: number;
  totalExpected: number;
  homeAttack: number;
  homeDefense: number;
  awayAttack: number;
  awayDefense: number;
  homeSample: number;
  awaySample: number;
  shrinkageK: number;
  notes: string[];
}

export interface PoissonResult {
  maxGoals: number;
  /** matrix[h][a] = P(hazai h gólt, vendég a gólt) */
  matrix: number[][];
  homeGoalDist: number[];
  awayGoalDist: number[];
  homeWin: number;
  draw: number;
  awayWin: number;
  over: Record<string, number>;
  under: Record<string, number>;
  bttsYes: number;
  bttsNo: number;
  homeOver05: number;
  homeOver15: number;
  awayOver05: number;
  awayOver15: number;
  doubleChance: { '1X': number; X2: number; '12': number };
  drawNoBet: { home: number; away: number };
  /** ázsiai hendikep -1 hazai: nyer / push / veszít */
  asianHome1: { win: number; push: number; lose: number };
  correctScores: { score: string; prob: number }[];
}

export type ValueVerdict = 'Pozitív modellkülönbség' | 'Negatív modellkülönbség' | 'Semleges';

export interface ValueRow {
  market: string;
  label: string;
  modelProb: number;
  odds: number | null;
  impliedProb: number | null;
  diffPoints: number | null;
  verdict: ValueVerdict | null;
}

export type TipCategory = 'konzervatív' | 'mérsékelt' | 'magas variancia';

export interface TipSuggestion {
  id: string;
  category: TipCategory;
  market: string;
  label: string;
  modelProb: number;
  odds: number | null;
  impliedProb: number | null;
  diffPoints: number | null;
  supportingStats: string[];
  reasonsFor: string[];
  reasonsAgainst: string[];
  risks: string[];
  /** hány független statisztikai mutató támasztja alá */
  supportingIndicators: number;
  sampleSize: number;
}

export type DataQualityLevel = 'magas' | 'közepes' | 'kevés';

export interface DataQuality {
  level: DataQualityLevel;
  score: number;
  factors: { label: string; ok: boolean; detail: string }[];
}

export interface ExternalConsensus {
  totalSources: number;
  byMarket: { market: string; label: string; count: number; sources: string[] }[];
  agreementNote: string | null;
  disagreementNote: string | null;
}

export interface MatchAnalysis {
  match: Match;
  league: League;
  homeTeam: Team;
  awayTeam: Team;
  origin: DataOrigin;
  generatedAt: string;
  insufficientData: boolean;
  insufficientReasons: string[];
  form: {
    homeLast5: FormSummary;
    homeLast10: FormSummary;
    awayLast5: FormSummary;
    awayLast10: FormSummary;
    homeAtHome: FormSummary;
    awayAtAway: FormSummary;
    interpretation: string[];
  };
  h2h: H2HSummary;
  standings: { home: StandingRow | null; away: StandingRow | null; total: number };
  leagueAverages: LeagueAverages;
  goalMarkets: GoalMarketIndicator[];
  xg: XgModelResult | null;
  poisson: PoissonResult | null;
  oneXtwoFactors: string[];
  odds: MatchOdds | null;
  value: ValueRow[];
  tips: TipSuggestion[];
  dataQuality: DataQuality;
  research: ResearchResult;
  consensus: ExternalConsensus;
  risks: string[];
  methodology: string[];
}

// ---------- Előzmények (historikus teljesítmény) ----------

export type PredictionOutcome = 'nyert' | 'vesztett' | 'érvénytelen' | 'függőben';

export interface PredictionRecord {
  id: string;
  /** a tulajdonos Supabase felhasználó azonosítója (a szerver a hitelesített tokenből tölti) */
  userId: string;
  createdAt: string;
  matchId: string;
  matchLabel: string;
  kickoff: string;
  leagueId: string;
  leagueName: string;
  market: string;
  marketLabel: string;
  modelProb: number;
  odds: number | null;
  category: TipCategory;
  predictionType: 'modell' | 'manuális';
  outcome: PredictionOutcome;
  homeGoals: number | null;
  awayGoals: number | null;
  settledAt: string | null;
  origin: DataOrigin;
}

export interface HistorySummary {
  total: number;
  settled: number;
  correct: number;
  incorrect: number;
  voided: number;
  pending: number;
  hitRate: number | null;
  avgModelProb: number | null;
  /** csak azoknál, ahol volt odds: (nyeremény - tét) / tét, 1 egység tétekkel */
  roi: number | null;
  withOdds: number;
}

export interface AppStatus {
  dataMode: DataOrigin;
  requestedMode: string;
  matchProvider: string;
  researchProvider: string;
  liveFootballApiConfigured: boolean;
  webSearchConfigured: boolean;
  oddsApiConfigured: boolean;
  oddsSource: string;
  /** hol vannak a tartós adatok: 'postgres' (Supabase) vagy 'sqlite' (helyi tartalék) */
  appStore: 'postgres' | 'sqlite';
  warnings: string[];
  serverTime: string;
}

/** Tipp-lista sor a "Mai tippek" oldalhoz */
export interface TipListEntry {
  tip: TipSuggestion;
  matchId: string;
  matchLabel: string;
  kickoff: string;
  leagueId: string;
  leagueName: string;
  dataQuality: DataQuality;
  origin: DataOrigin;
}

// ---------- Szelvények (kombinációk) ----------

export interface SlipLeg {
  matchId: string;
  matchLabel: string;
  leagueName: string;
  kickoff: string;
  market: string;
  label: string;
  modelProb: number;
  odds: number;
  bookmaker: string | null;
  impliedProb: number;
  diffPoints: number;
  category: TipCategory;
  supportingIndicators: number;
  dataQuality: DataQualityLevel;
}

export type SlipStrategy = 'legnagyobb esély' | 'kiegyensúlyozott' | 'modell-előny';

export interface Slip {
  id: string;
  strategy: SlipStrategy;
  legs: SlipLeg[];
  totalOdds: number;
  /** a lábak modell-valószínűségeinek szorzata – függetlenséget feltételez */
  jointProb: number;
  /** 1 / összodds */
  impliedJointProb: number;
  diffPoints: number;
  /** várható visszatérülés 1 egység tétre: jointProb × totalOdds */
  expectedReturn: number;
  warnings: string[];
}

export interface SlipRecord {
  id: string;
  /** a tulajdonos Supabase felhasználó azonosítója */
  userId: string;
  createdAt: string;
  strategy: SlipStrategy;
  label: string;
  legPredictionIds: string[];
  totalOdds: number;
  jointProb: number;
  origin: DataOrigin;
  /** a lábak alapján számolt kimenet */
  outcome: PredictionOutcome;
  legs: PredictionRecord[];
}

export interface SlipBuildResponse {
  from: string;
  to: string;
  matchesAnalyzed: number;
  matchesWithOdds: number;
  candidateLegs: number;
  slips: Slip[];
  notes: string[];
}
