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

export interface Container {
  data: MatchDataProvider;
  research: ResearchProvider;
  /** opcionális, több-irodás odds forrás (ODDS_API_KEY) */
  oddsApi: TheOddsApiProvider | null;
  db: Database;
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

  return {
    data,
    research,
    oddsApi,
    db,
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
