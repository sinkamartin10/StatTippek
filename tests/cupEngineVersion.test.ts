/**
 * Külön motorverzió a kupaelemzésekhez (`xg-poisson-cup-1`):
 *  - bajnoki meccs → `xg-poisson-1` (változatlan), kupa / nemzetközi kupa / válogatott / barátságos → `xg-poisson-cup-1`,
 *  - a valódi AnalysisService így jelöli, és a valódi archívum ezen a verzión rögzíti,
 *  - a PRO-modell visszaesése (és hibája) megtartja az alap elemzés verzióját,
 *  - a kalibráció (valódi SqliteModelLearningStore) verziónként külön tölti az archívumot – nem keveri,
 *  - a korábbi (xg-poisson-1) archív kupatippek változatlanok maradnak.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { ESPN_LEAGUES } from '../src/server/data/espnProvider';
import { CUP_ENGINE_VERSION, ENGINE_VERSION } from '../src/shared/engine/version';
import { CUP_MODEL_INFO, XG_MODEL_INFO, baseModelInfo } from '../src/shared/engine/xsAnalysis';
import { SqliteTipArchiveStore } from '../src/server/tipArchive/store';
import { TipArchiveService, engineOf } from '../src/server/tipArchive/service';
import { SqliteModelLearningStore } from '../src/server/modelLearning/store';
import { AnalysisService } from '../src/server/services/analysisService';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { XsModelService } from '../src/server/model/xsService';
import { ModelNote } from '../src/client/components/ModelBadge';
import type { Container } from '../src/server/container';
import type { DataOrigin, Match, MatchAnalysis, ServedModelInfo } from '../src/shared/types';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

class StubMatches {
  readonly origin: DataOrigin = 'live';
  async getMatch(): Promise<Match | null> { return null; }
}

/** Minimális, a motor kimenetével azonos alakú elemzés a megadott modell-azonosítóval. */
function analysis(id: string, leagueId: string, model: ServedModelInfo, prob: number, generatedAt: number): MatchAnalysis {
  const match = { id, leagueId, homeTeamId: 'H', awayTeamId: 'A', kickoff: iso(T0 + 48 * H), status: 'scheduled', origin: 'live', importance: 'normal', importanceReasons: [] } as Match;
  return {
    match, league: { id: leagueId, name: leagueId }, homeTeam: { id: 'H', name: 'Hazai' }, awayTeam: { id: 'A', name: 'Vendég' },
    origin: 'live', generatedAt: iso(generatedAt), poisson: {}, model,
    dataQuality: { level: 'magas', score: 80, factors: [] },
    tips: [{ id: 't0', category: 'mérsékelt', market: 'O2.5', label: 'Több mint 2,5', modelProb: prob, odds: null, impliedProb: null, diffPoints: null, supportingStats: [], reasonsFor: [], reasonsAgainst: [], risks: [], supportingIndicators: 3, sampleSize: 20 }],
  } as unknown as MatchAnalysis;
}

function archiveDb() {
  const db = new DatabaseSync(':memory:');
  const store = new SqliteTipArchiveStore(db);
  const learning = new SqliteModelLearningStore(db);
  const svc = new TipArchiveService(store, new StubMatches(), { now: () => new Date(T0) });
  const rows = () => db.prepare('SELECT match_id, market, version_no, engine_version, served_model, model_prob, content_hash, generated_at FROM model_tip_archive ORDER BY match_id, version_no').all() as Record<string, unknown>[];
  return { db, svc, learning, rows };
}

describe('Motorverzió a sorozat szerint', () => {
  it('bajnokság → xg-poisson-1; kupa, nemzetközi kupa, válogatott sorozat, barátságos → xg-poisson-cup-1', () => {
    expect(ENGINE_VERSION).toBe('xg-poisson-1');
    expect(CUP_ENGINE_VERSION).toBe('xg-poisson-cup-1');
    const got = Object.fromEntries(ESPN_LEAGUES.map((l) => [l.id, baseModelInfo(l).id]));
    for (const l of ESPN_LEAGUES) {
      const isLeague = !l.international && !l.domesticCup;
      expect(got[l.id], l.id).toBe(isLeague ? 'xg-poisson-1' : 'xg-poisson-cup-1');
    }
    expect(got['ger-bl']).toBe('xg-poisson-1');
    expect(got['ger-dfb']).toBe('xg-poisson-cup-1');
    expect(got['uefa-ucl']).toBe('xg-poisson-cup-1');
  });

  it('az archívum motorverziója a modell-azonosítóból: bajnoki, kupás és több ligás külön', () => {
    expect(engineOf(analysis('m', 'ger-bl', XG_MODEL_INFO, 0.5, T0))).toBe('xg-poisson-1');
    expect(engineOf(analysis('m', 'ger-dfb', CUP_MODEL_INFO, 0.5, T0))).toBe('xg-poisson-cup-1');
    expect(engineOf(analysis('m', 'x', { id: 'xs-strength-1', label: 'xs' }, 0.5, T0))).toBe('xs-strength-1');
    expect(engineOf({ ...analysis('m', 'x', XG_MODEL_INFO, 0.5, T0), model: undefined })).toBe('xg-poisson-1');
  });
});

describe('Valódi AnalysisService (demó adat) + valódi archívum', () => {
  it('bajnoki meccs xg-poisson-1, nemzetközi kupameccs xg-poisson-cup-1 – az elemzésben és az archív sorban is', async () => {
    const demo = new DemoMatchDataProvider();
    const { db, svc: archive } = archiveDb();
    const container = { data: demo, research: new DemoResearchProvider(demo), oddsApi: null, db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined } } as unknown as Container;
    const service = new AnalysisService(container, archive);
    const leagues = await demo.getLeagues();
    const matches = await demo.getMatches({});
    const leagueMatch = matches.find((m) => !leagues.find((l) => l.id === m.leagueId)?.international && m.status === 'scheduled')!;
    const cupMatch = matches.find((m) => leagues.find((l) => l.id === m.leagueId)?.international && m.status === 'scheduled')!;
    expect(leagueMatch && cupMatch).toBeTruthy();

    const a = await service.analyze(leagueMatch.id);
    const b = await service.analyze(cupMatch.id);
    await service.archiveIdle();
    expect(a?.model?.id).toBe('xg-poisson-1');
    expect(b?.model?.id).toBe('xg-poisson-cup-1');
    const byMatch = (id: string) => db.prepare('SELECT DISTINCT engine_version, served_model FROM model_tip_archive WHERE match_id = ?').all(id) as { engine_version: string; served_model: string }[];
    // mindkét elemzés ad tippet, így az archív sorok ténylegesen ellenőrzöttek
    expect(a?.tips.length).toBeGreaterThan(0);
    expect(b?.tips.length).toBeGreaterThan(0);
    expect(byMatch(leagueMatch.id)).toEqual([{ engine_version: 'xg-poisson-1', served_model: 'xg-poisson-1' }]);
    expect(byMatch(cupMatch.id)).toEqual([{ engine_version: 'xg-poisson-cup-1', served_model: 'xg-poisson-cup-1' }]);
  });
});

describe('A PRO-modell visszaesése megtartja a verziót', () => {
  it('a valódi XsService „még nincs kész” visszaesésénél a kupaelemzés xg-poisson-cup-1 marad, a bajnoki xg-poisson-1', () => {
    const xs = new XsModelService(null, null, { log: () => {} });
    const cup = xs.serve(analysis('c', 'ger-dfb', CUP_MODEL_INFO, 0.5, T0).match, analysis('c', 'ger-dfb', CUP_MODEL_INFO, 0.5, T0));
    const lg = xs.serve(analysis('l', 'ger-bl', XG_MODEL_INFO, 0.5, T0).match, analysis('l', 'ger-bl', XG_MODEL_INFO, 0.5, T0));
    expect(cup.model).toMatchObject({ id: 'xg-poisson-cup-1', fallbackCode: 'not_ready' });
    expect(lg.model).toMatchObject({ id: 'xg-poisson-1', fallbackCode: 'not_ready' });
    expect(engineOf(cup)).toBe('xg-poisson-cup-1');
  });

  it('ha a PRO-modell hibát dob, a kupaelemzés PRO-változata is xg-poisson-cup-1 marad (a valódi AnalysisService hibaágán)', async () => {
    const demo = new DemoMatchDataProvider();
    const { db, svc: archive } = archiveDb();
    const container = { data: demo, research: new DemoResearchProvider(demo), oddsApi: null, db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined } } as unknown as Container;
    const service = new AnalysisService(container, archive, { serve: () => { throw new Error('teszt-hiba'); } });
    const leagues = await demo.getLeagues();
    const cupMatch = (await demo.getMatches({})).find((m) => leagues.find((l) => l.id === m.leagueId)?.international && m.status === 'scheduled')!;
    const pro = await service.analyze(cupMatch.id, { variant: 'pro' });
    await service.archiveIdle();
    expect(pro?.model).toMatchObject({ id: 'xg-poisson-cup-1', fallbackCode: 'error' });
    expect(db.prepare('SELECT DISTINCT engine_version FROM model_tip_archive WHERE match_id = ?').all(cupMatch.id)).toEqual([{ engine_version: 'xg-poisson-cup-1' }]);
  });

  it('a kupás alapmotor nem kap félrevezető „visszaesés” magyarázatot a meccsoldalon', () => {
    expect(renderToStaticMarkup(createElement(ModelNote, { model: CUP_MODEL_INFO }))).toBe('');
    expect(renderToStaticMarkup(createElement(ModelNote, { model: XG_MODEL_INFO }))).toBe('');
  });
});

describe('Archívum és kalibráció: a két verzió nem keveredik, a régi tippek változatlanok', () => {
  it('a kalibráció verziónként tölti az archívumot: xg-poisson-1 csak bajnoki, xg-poisson-cup-1 csak kupás sorokat kap', async () => {
    const { svc, learning } = archiveDb();
    await svc.record(analysis('bl-1', 'ger-bl', XG_MODEL_INFO, 0.55, T0));
    await svc.record(analysis('dfb-1', 'ger-dfb', CUP_MODEL_INFO, 0.61, T0));
    const base = await learning.loadArchive('xg-poisson-1', 100);
    const cup = await learning.loadArchive('xg-poisson-cup-1', 100);
    expect(base.map((r) => r.matchId)).toEqual(['bl-1']);
    expect(cup.map((r) => r.matchId)).toEqual(['dfb-1']);
  });

  it('a korábbi (xg-poisson-1) kupatipp sora változatlan marad; az új kupás elemzés ÚJ verziósort kap', async () => {
    const { svc, learning, rows } = archiveDb();
    // a deploy előtti állapot: a kupameccs tippje még az alap motor verzióján rögzült
    await svc.record(analysis('dfb-2', 'ger-dfb', XG_MODEL_INFO, 0.58, T0 - 3 * H));
    const before = rows();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ engine_version: 'xg-poisson-1', version_no: 1, model_prob: 0.58 });

    // a deploy után: ugyanaz a meccs, kupa-verzióval
    await svc.record(analysis('dfb-2', 'ger-dfb', CUP_MODEL_INFO, 0.63, T0));
    const after = rows();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]); // a régi sor bitre azonos
    expect(after[1]).toMatchObject({ engine_version: 'xg-poisson-cup-1', served_model: 'xg-poisson-cup-1', version_no: 2, model_prob: 0.63 });
    // a „számító” (legfrissebb, kezdés előtti) sor az új verzióé; a régi verzió kalibrációs halmaza nem kap kupás sort
    expect((await learning.loadArchive('xg-poisson-cup-1', 100)).map((r) => r.matchId)).toEqual(['dfb-2']);
    expect((await learning.loadArchive('xg-poisson-1', 100)).map((r) => r.matchId)).toEqual([]);
  });

  it('bajnoki meccs újraelemzése változatlanul xg-poisson-1-en marad (azonos tartalomnál nincs új sor)', async () => {
    const { svc, rows } = archiveDb();
    await svc.record(analysis('bl-2', 'ger-bl', XG_MODEL_INFO, 0.52, T0 - H));
    await svc.record(analysis('bl-2', 'ger-bl', XG_MODEL_INFO, 0.52, T0));
    expect(rows().map((r) => [r.engine_version, r.version_no])).toEqual([['xg-poisson-1', 1]]);
  });
});
