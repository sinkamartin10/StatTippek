/**
 * Függőség-összekötés: környezeti változók alapján választja ki az adat- és kutatószolgáltatót.
 *
 * Alapértelmezés (kulcs nélkül is): ÉLŐ adat – ESPN nyilvános API (meccsek, eredmények, odds) +
 * valós idejű hírkeresés RSS feedeken (Bing News + Google News).
 * Opcionális kulcsokkal: API-Football (több liga, pl. NB I/NB II) és Tavily/Brave keresés.
 * DEMO ADAT csak explicit DATA_MODE=demo esetén; a demo és az élő adat sosem keveredik.
 */
import 'dotenv/config';
import path from 'node:path';
import type { AppStatus } from '../shared/types';
import { DemoMatchDataProvider } from './data/demoProvider';
import { ApiFootballProvider } from './data/apiFootballProvider';
import { EspnProvider } from './data/espnProvider';
import type { MatchDataProvider } from './data/provider';
import { DemoResearchProvider } from './research/demoResearch';
import { BraveBackend, TavilyBackend, WebSearchResearchProvider } from './research/webSearchResearch';
import { CombinedRssBackend } from './research/rssSearch';
import type { ResearchProvider } from './research/provider';
import { Database } from './db/database';
import { TheOddsApiProvider } from './odds/theOddsApi';
import { PostgresCompetitionStore, SqliteCompetitionStore, type CompetitionStore } from './competition/store';
import { InMemoryDisplayNameDirectory, SupabaseDisplayNameDirectory, type DisplayNameDirectory } from './profile/displayNameDirectory';
import { PostgresProgressionStore, SqliteProgressionStore, type ProgressionStore } from './progression/store';
import { PostgresBattleStore, SqliteBattleStore, type BattleStore } from './battles/store';
import { PostgresNotificationStore, SqliteNotificationStore, type NotificationStore } from './notifications/store';
import { PostgresCoinStore, SqliteCoinStore, type CoinStore } from './coins/store';
import { PostgresFollowStore, SqliteFollowStore, type FollowStore } from './social/store';
import { PostgresTipArchiveStore, SqliteTipArchiveStore, type TipArchiveStore } from './tipArchive/store';
import { PostgresModelLearningStore, SqliteModelLearningStore, type ModelLearningStore } from './modelLearning/store';

export interface Container {
  data: MatchDataProvider;
  research: ResearchProvider;
  /** opcionális, több-irodás odds forrás (ODDS_API_KEY) */
  oddsApi: TheOddsApiProvider | null;
  db: Database;
  /** Tippverseny modul tárolója – külön táblák, a meglévő AppStore-tól függetlenül */
  competitions: CompetitionStore;
  /** Megjelenítési nevek a meglévő profiles táblából */
  displayNames: DisplayNameDirectory;
  /** Tipster progression tárolója – saját táblák, a Tippversenytől függetlenül */
  progression: ProgressionStore;
  /** 1v1 Tipp Battle tárolója – saját táblák; a user_predictions-hez nem nyúl */
  battles: BattleStore;
  /** In-app értesítések tárolója – saját tábla, általános (nem Battle-specifikus) */
  notifications: NotificationStore;
  /** Coin + shop tárolója – saját táblák; a pénzmozgás-szerű műveletek authority-ja a DB */
  coins: CoinStore;
  /** Követés (social) – saját tábla a 0013-ból, más rendszert nem érint */
  follows: FollowStore;
  /** Modell-tipp archívum – saját tábla a 0014-ből; felhasználói adatot nem tárol */
  tipArchive: TipArchiveStore;
  /** Modell-kalibráció (tanulási réteg) – saját táblák a 0015-ből; az archívumot csak olvassa */
  learning: ModelLearningStore;
  status(): AppStatus;
}

export function buildContainer(): Container {
  const warnings: string[] = [];
  const requestedMode = (process.env.DATA_MODE ?? 'live').toLowerCase();
  const footballKey = process.env.API_FOOTBALL_KEY?.trim();
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  const oddsKey = process.env.ODDS_API_KEY?.trim();

  const dbPath = process.env.DATABASE_PATH ?? path.resolve(process.cwd(), 'data/tippmix-ai.db');
  const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  // Hibrid: tartós adat Supabase PostgreSQL-ben (ha van service_role kulcs), cache mindig helyi SQLite-ban
  const db = new Database({ file: dbPath, supabaseUrl, supabaseServiceRoleKey: serviceRoleKey });
  if (db.storeKind === 'sqlite') warnings.push('A tartós adatok helyi SQLite-ban vannak (nincs SUPABASE_SERVICE_ROLE_KEY) – éles üzemre állítsd be a Supabase PostgreSQL-t.');

  let data: MatchDataProvider;
  let research: ResearchProvider;

  if (requestedMode === 'demo') {
    const demo = new DemoMatchDataProvider();
    data = demo;
    research = new DemoResearchProvider(demo);
    warnings.push('DEMO ADAT mód: minden mérkőzés és hír beépített, szemléltető adat.');
  } else {
    data = footballKey ? new ApiFootballProvider(footballKey) : new EspnProvider(db.httpCache());
    if (!footballKey) warnings.push('Magyar NB I / NB II élő adatához API_FOOTBALL_KEY szükséges – jelenleg a nemzetközi topligák és kupák érhetők el.');
    research = new WebSearchResearchProvider(
      tavilyKey ? new TavilyBackend(tavilyKey) : braveKey ? new BraveBackend(braveKey) : new CombinedRssBackend(),
    );
  }

  const oddsApi = requestedMode !== 'demo' && oddsKey ? new TheOddsApiProvider(oddsKey, db.httpCache()) : null;

  // Tippverseny tároló: élesben Supabase PostgreSQL, kulcs nélkül helyi SQLite (a meglévő tárolót nem érinti)
  const competitions: CompetitionStore = supabaseUrl && serviceRoleKey
    ? new PostgresCompetitionStore(supabaseUrl, serviceRoleKey)
    : new SqliteCompetitionStore(db.sqliteHandle());
  // A megjelenítési név a MEGLÉVŐ profiles táblában él; Supabase nélkül memóriában (helyi mód)
  const displayNames: DisplayNameDirectory = supabaseUrl && serviceRoleKey
    ? new SupabaseDisplayNameDirectory()
    : new InMemoryDisplayNameDirectory();
  // Progression (XP, achievement, testreszabás): élesben Supabase, kulcs nélkül helyi SQLite
  const progression: ProgressionStore = supabaseUrl && serviceRoleKey
    ? new PostgresProgressionStore(supabaseUrl, serviceRoleKey)
    : new SqliteProgressionStore(db.sqliteHandle());

  const battles: BattleStore = supabaseUrl && serviceRoleKey
    ? new PostgresBattleStore(supabaseUrl, serviceRoleKey)
    : new SqliteBattleStore(db.sqliteHandle());

  const notifications: NotificationStore = supabaseUrl && serviceRoleKey
    ? new PostgresNotificationStore(supabaseUrl, serviceRoleKey)
    : new SqliteNotificationStore(db.sqliteHandle());

  // Coin + shop: élesben Supabase (a 0011 plpgsql függvényeivel), kulcs nélkül
  // helyi SQLite ugyanazzal a szerződéssel és ugyanazokkal a megszorításokkal
  const coins: CoinStore = supabaseUrl && serviceRoleKey
    ? new PostgresCoinStore(supabaseUrl, serviceRoleKey)
    : new SqliteCoinStore(db.sqliteHandle());

  // Követés: élesben Supabase (0013), kulcs nélkül helyi SQLite azonos szerződéssel
  const follows: FollowStore = supabaseUrl && serviceRoleKey
    ? new PostgresFollowStore(supabaseUrl, serviceRoleKey)
    : new SqliteFollowStore(db.sqliteHandle());

  // Modell-tipp archívum: élesben Supabase (0014), kulcs nélkül helyi SQLite azonos szerződéssel
  const tipArchive: TipArchiveStore = supabaseUrl && serviceRoleKey
    ? new PostgresTipArchiveStore(supabaseUrl, serviceRoleKey)
    : new SqliteTipArchiveStore(db.sqliteHandle());

  // Modell-kalibráció: élesben Supabase (0015); helyben SQLite – az archívum-tároló UTÁN, mert annak nézeteit olvassa
  const learning: ModelLearningStore = supabaseUrl && serviceRoleKey
    ? new PostgresModelLearningStore(supabaseUrl, serviceRoleKey)
    : new SqliteModelLearningStore(db.sqliteHandle());

  return {
    data,
    research,
    oddsApi,
    db,
    competitions,
    displayNames,
    progression,
    battles,
    notifications,
    coins,
    follows,
    tipArchive,
    learning,
    status: () => ({
      dataMode: data.origin,
      requestedMode,
      matchProvider: data.name,
      researchProvider: research.name,
      liveFootballApiConfigured: !!footballKey,
      webSearchConfigured: !!(tavilyKey || braveKey),
      oddsApiConfigured: !!oddsApi,
      appStore: db.storeKind,
      oddsSource: oddsApi ? `${oddsApi.name} + ${data.name}` : `${data.name} (ESPN által közölt odds)`,
      warnings,
      serverTime: new Date().toISOString(),
    }),
  };
}
