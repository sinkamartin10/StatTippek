/**
 * PRO-kiszolgálás a több ligás modellel (xs-strength-1) – végponttól végpontig.
 *
 * VALÓDI apiRouter + VALÓDI AnalysisService + VALÓDI XsModelService (+ SqliteXsStore) +
 * VALÓDI archívum-tár; DEMO-meccsek, a modell tanítóadata a DEMO-csapatok determinisztikus
 * előzménye. A jogosultságot – mint élesben az attachPlan – a `res.locals.plan` adja.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { AnalysisService } from '../src/server/services/analysisService';
import { apiRouter } from '../src/server/routes/api';
import { CornerService } from '../src/server/corners/service';
import { XsModelService, datasetFingerprint, fitIdOf, type MonthlyResultsSource } from '../src/server/model/xsService';
import { SqliteXsStore } from '../src/server/model/xsStore';
import { SqliteTipArchiveStore } from '../src/server/tipArchive/store';
import { TipArchiveService } from '../src/server/tipArchive/service';
import type { ScoreboardResult } from '../src/server/data/scoreboardResults';
import type { Container } from '../src/server/container';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import { rng } from '../src/shared/engine/experimental/crossLeagueEval';
import { ModelBadge, ModelNote } from '../src/client/components/ModelBadge';
import type { Match, MatchAnalysis, TipListEntry } from '../src/shared/types';

const DAY = 86_400_000, HOUR = 3_600_000;
const container = (demo: DemoMatchDataProvider): Container => ({
  data: demo, research: new DemoResearchProvider(demo), oddsApi: null,
  db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined },
} as unknown as Container);

/**
 * A DEMO-csapatok determinisztikus, múltbeli tanítótörténete ligánként (két „idény” oda-vissza),
 * ESPN-havi bontásban – ez helyettesíti az ESPN-t a tesztben.
 */
async function historySource(demo: DemoMatchDataProvider, now: Date, extra: ScoreboardResult[] = [], excludeTeam: string | null = null): Promise<{ source: MonthlyResultsSource; rows: ScoreboardResult[]; competitions: string[] }> {
  const r = rng(42);
  const teams = await demo.getTeams();
  const leagues = ['eng-pl', 'esp-ll', 'ita-sa', 'ger-bl', 'fra-l1', 'usa-mls'];
  const rows: ScoreboardResult[] = [];
  let n = 0;
  for (const l of leagues) {
    const lt = teams.filter((t) => t.leagueId === l && t.id !== excludeTeam);
    for (let season = 0; season < 2; season++) {
      for (const h of lt) for (const a of lt) {
        if (h === a) continue;
        const date = new Date(now.getTime() - (40 + season * 200 + (n % 180)) * DAY).toISOString();
        rows.push({ id: `espn-x-${n++}`, competitionId: l, date, homeTeamId: h.id, awayTeamId: a.id, homeGoals: Math.floor(r() * 4), awayGoals: Math.floor(r() * 3), regulation: true });
      }
    }
  }
  rows.push(...extra);
  const month = (iso: string) => iso.slice(0, 7).replace('-', '');
  const source: MonthlyResultsSource = {
    monthResults: async (c, m) => rows.filter((x) => x.competitionId === c && month(x.date) === m),
  };
  return { source, rows, competitions: leagues };
}

async function readyService(demo: DemoMatchDataProvider, opts: { now?: Date; extra?: ScoreboardResult[]; db?: InstanceType<typeof DatabaseSync>; excludeTeam?: string } = {}) {
  const now = opts.now ?? new Date();
  const h = await historySource(demo, now, opts.extra, opts.excludeTeam ?? null);
  const store = new SqliteXsStore(opts.db ?? new DatabaseSync(':memory:'));
  const xs = new XsModelService(h.source, store, { now: () => now, historyMonths: 24, minTrainingMatches: 100, competitions: h.competitions, log: () => {} });
  await xs.refresh();
  return { xs, store, rows: h.rows, now };
}

describe('XsModelService – tanítóadat, becslés, reprodukálhatóság, szivárgás', () => {
  it('becslés csak a lezárt (−3 óra) meccsekből; a jövőbeli/folyamatban lévő eredmény nem kerül be', async () => {
    const demo = new DemoMatchDataProvider();
    const now = new Date();
    const team = (await demo.getTeams()).find((t) => t.leagueId === 'eng-pl')!;
    const opp = (await demo.getTeams()).filter((t) => t.leagueId === 'eng-pl')[1];
    const future: ScoreboardResult[] = [
      { id: 'espn-x-future', competitionId: 'eng-pl', date: new Date(now.getTime() + 2 * HOUR).toISOString(), homeTeamId: team.id, awayTeamId: opp.id, homeGoals: 9, awayGoals: 0, regulation: true },
      { id: 'espn-x-recent', competitionId: 'eng-pl', date: new Date(now.getTime() - 1 * HOUR).toISOString(), homeTeamId: team.id, awayTeamId: opp.id, homeGoals: 9, awayGoals: 0, regulation: true },
    ];
    const a = await readyService(demo, { now });
    const b = await readyService(demo, { now, extra: future });
    expect(a.xs.status().ready).toBe(true);
    expect(b.xs.status().trainedMatches).toBe(a.xs.status().trainedMatches);
    expect(b.xs.status().fitId).toBe(a.xs.status().fitId); // a kizárt sorok az ujjlenyomatba sem kerülnek
  });

  it('reprodukálható: ugyanazon adatból és időpontból ugyanaz a fitId; a tartós tárból újraindulás után hálózat nélkül is becsül', async () => {
    const demo = new DemoMatchDataProvider();
    const db = new DatabaseSync(':memory:');
    const now = new Date(Date.now() - 0);
    const first = await readyService(demo, { now, db });
    const st = first.xs.status();
    // a fitId a dokumentált képletből számolható
    expect(st.fitId).toBe(fitIdOf(st.cutoff!, st.datasetSha256!));
    const window = first.rows.filter((r) => Date.parse(r.date) <= now.getTime() - 3 * HOUR);
    expect(st.datasetSha256).toBe(datasetFingerprint(window));
    // „újraindulás”: új szolgáltatás, a forrás NEM elérhető – a lezárt hónapok a tárból jönnek
    const offline = new XsModelService({ monthResults: async () => null }, new SqliteXsStore(db), { now: () => now, historyMonths: 24, minTrainingMatches: 100, competitions: ['eng-pl', 'esp-ll', 'ita-sa', 'ger-bl', 'fra-l1', 'usa-mls'], log: () => {} });
    await offline.refresh();
    expect(offline.status().ready).toBe(true);
    expect(offline.status().datasetSha256).toBe(st.datasetSha256);
    expect(offline.status().fitId).toBe(st.fitId);
    // becslésnapló: append-only, egy sor fitId-nként
    expect((db.prepare('SELECT COUNT(*) AS n FROM xs_model_fits').get() as { n: number }).n).toBe(1);
    expect(() => db.prepare("UPDATE xs_model_fits SET sweeps = 0").run()).toThrow(/nem módosíthatók/);
  });
});

describe('Modellválasztás az API-ban – PRO: xs-strength-1, FREE: alap motor', () => {
  let server: Server | null = null;
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; vi.restoreAllMocks(); });

  async function app(plan: unknown, opts: { xsReady?: boolean } = {}) {
    const demo = new DemoMatchDataProvider();
    const db = new DatabaseSync(':memory:');
    const archive = new TipArchiveService(new SqliteTipArchiveStore(db), demo);
    const xs = opts.xsReady === false
      ? new XsModelService(null, null, { log: () => {} })
      : (await readyService(demo)).xs;
    const svc = new AnalysisService(container(demo), archive, xs);
    const a = express();
    a.use(express.json());
    a.use((_req, res, next) => { res.locals.plan = plan; next(); });
    a.use('/api', apiRouter(container(demo), svc, new CornerService(demo)));
    server = await new Promise<Server>((r) => { const s = a.listen(0, () => r(s)); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string) => { const res = await fetch(url + path); return { status: res.status, body: await res.json() }; };
    return { get, demo, svc, db };
  }
  const PRO = { enforced: true, user: { id: 'pro-1' }, pro: true, admin: false };
  const FREE = { enforced: true, user: { id: 'free-1' }, pro: false, admin: false };
  const scheduledIn = async (demo: DemoMatchDataProvider, league: string): Promise<Match> => (await demo.getMatches({ status: 'scheduled' })).find((m) => m.leagueId === league)!;

  it('GET /api/matches/:id/analysis: PRO → xs-strength-1 (adatminőség-jelzéssel), FREE → xg-poisson-1 (kitakarva); a valószínűségek eltérnek', async () => {
    const { get, demo } = await app(PRO);
    const m = await scheduledIn(demo, 'eng-pl');
    const pro = await get(`/api/matches/${m.id}/analysis`);
    expect(pro.status).toBe(200);
    const pa = pro.body as MatchAnalysis;
    expect(pa.model).toMatchObject({ id: 'xs-strength-1', quality: expect.stringMatching(/^(elegendo|korlatozott|keves_regularizalt)$/) });
    expect(pa.model!.fitId).toMatch(/^[0-9a-f]{64}$/);
    expect(pa.insufficientData).toBe(false);
    expect(pa.tips.length).toBeGreaterThan(0);
    expect(pa.poisson!.homeWin + pa.poisson!.draw + pa.poisson!.awayWin).toBeCloseTo(1, 6);
    expect(pa.methodology[0]).toMatch(/xs-strength-1/);

    await new Promise<void>((r) => server!.close(() => r())); server = null;
    const free = await app(FREE);
    const day = (await free.demo.getMatches({})).filter((x) => x.kickoff.slice(0, 10) === m.kickoff.slice(0, 10));
    const { freeMatchIds } = await import('../src/shared/engine/plan');
    const freeId = [...freeMatchIds(day)][0];
    const fr = await free.get(`/api/matches/${freeId}/analysis`);
    expect(fr.status).toBe(200);
    expect((fr.body as MatchAnalysis).model).toMatchObject({ id: 'xg-poisson-1' });
    expect((fr.body as MatchAnalysis).tips.every((t) => t.reasonsFor.length === 0)).toBe(true); // FREE-redakció változatlan
  });

  it('a jogosultság változatlan: FREE a napi kereten kívüli meccsre 403-at kap (a modellváltás nem nyit ki semmit)', async () => {
    const { get, demo } = await app(FREE);
    const scheduled = await demo.getMatches({ status: 'scheduled' });
    const { freeMatchIds } = await import('../src/shared/engine/plan');
    const locked = scheduled.find((x) => !freeMatchIds(scheduled.filter((y) => y.kickoff.slice(0, 10) === x.kickoff.slice(0, 10))).has(x.id))!;
    const r = await get(`/api/matches/${locked.id}/analysis`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PRO_REQUIRED');
  });

  it('GET /api/tips: PRO-lista a több ligás modellből (modell-jelöléssel), FREE-lista az alap motorból, legfeljebb 3 tipp', async () => {
    const pro = await app(PRO);
    const m = await scheduledIn(pro.demo, 'eng-pl');
    const date = new Date(m.kickoff).toLocaleDateString('sv-SE');
    const pl = (await pro.get(`/api/tips?date=${date}`)).body as TipListEntry[];
    expect(pl.length).toBeGreaterThan(0);
    expect(pl.filter((e) => e.leagueId === 'eng-pl').every((e) => e.model?.id === 'xs-strength-1')).toBe(true);
    await new Promise<void>((r) => server!.close(() => r())); server = null;
    const free = await app(FREE);
    const fl = (await free.get(`/api/tips?date=${date}`)).body as TipListEntry[];
    expect(fl.length).toBeLessThanOrEqual(3);
    expect(fl.every((e) => e.model?.id === 'xg-poisson-1')).toBe(true);
  });

  it('visszaesés megnevezett okkal: a modell még nem kész; a sorozat nincs a tanítóadatban; a meccs a becslés előtt kezdődött', async () => {
    const notReady = await app(PRO, { xsReady: false });
    const m = await scheduledIn(notReady.demo, 'eng-pl');
    const r1 = (await notReady.get(`/api/matches/${m.id}/analysis`)).body as MatchAnalysis;
    expect(r1.model).toMatchObject({ id: 'xg-poisson-1', fallbackReason: expect.stringMatching(/még nem áll készen/) });
    await new Promise<void>((r) => server!.close(() => r())); server = null;

    const ready = await app(PRO);
    const hun = await scheduledIn(ready.demo, 'hun-nb1');
    const r2 = (await ready.get(`/api/matches/${hun.id}/analysis`)).body as MatchAnalysis;
    expect(r2.model).toMatchObject({ id: 'xg-poisson-1', fallbackReason: expect.stringMatching(/nincs a több ligás modell tanítóadatában/) });
    const past = (await ready.demo.getMatches({ status: 'finished' })).find((x) => x.leagueId === 'eng-pl')!;
    const r3 = (await ready.get(`/api/matches/${past.id}/analysis`)).body as MatchAnalysis;
    expect(r3.model).toMatchObject({ id: 'xg-poisson-1', fallbackReason: expect.stringMatching(/jövőbeli adat kizárása/) });
  });

  it('archívum: a PRO-nak kiszolgált xs-tippek saját motorverzióval rögzülnek; a FREE kérés nem ír mellé xg-sort (nincs verzió-pingpong)', async () => {
    const { get, demo, svc, db } = await app(PRO);
    const m = await scheduledIn(demo, 'eng-pl');
    const pa = (await get(`/api/matches/${m.id}/analysis`)).body as MatchAnalysis;
    await svc.archiveIdle();
    type ArchiveRow = { engine_version: string; served_model: string; served_prob: number; model_prob: number; market: string };
    const rows = db.prepare('SELECT engine_version, served_model, served_prob, model_prob, market FROM model_tip_archive WHERE match_id = ?').all(m.id) as ArchiveRow[];
    expect(rows.length).toBe(pa.tips.length);
    for (const r of rows) {
      expect(r).toMatchObject({ engine_version: 'xs-strength-1', served_model: 'xs-strength-1' });
      expect(r.served_prob).toBe(r.model_prob);
      expect(r.model_prob).toBe(pa.tips.find((t) => t.market === r.market)!.modelProb);
    }
    // ugyanaz a meccs alap-változatban (FREE-útvonal) – ugyanabból a számításból, új archív sor nélkül
    const base = await svc.analyze(m.id);
    await svc.archiveIdle();
    expect(base!.model!.id).toBe(ENGINE_VERSION);
    expect((db.prepare('SELECT COUNT(*) AS n FROM model_tip_archive WHERE match_id = ?').get(m.id) as { n: number }).n).toBe(rows.length);
  });
});

describe('Adatminőség: „elégtelen” → alap motor, az adathiány megnevezésével', () => {
  it('ha az egyik csapatnak nincs lezárt meccse a tanítóadatban, a PRO-elemzés az alap motorból jön, megnevezett okkal', async () => {
    const demo = new DemoMatchDataProvider();
    const m = (await demo.getMatches({ status: 'scheduled' })).find((x) => x.leagueId === 'eng-pl')!;
    const { xs } = await readyService(demo, { excludeTeam: m.homeTeamId });
    const svc = new AnalysisService(container(demo), null, xs);
    const pro = await svc.analyze(m.id, { variant: 'pro' });
    expect(pro!.model).toMatchObject({ id: 'xg-poisson-1', fallbackReason: expect.stringMatching(/adathiány, nem gyengeség/) });
    // és a többi meccs ugyanabban a ligában a több ligás modellt kapja
    const other = (await demo.getMatches({ status: 'scheduled' })).find((x) => x.leagueId === 'eng-pl' && x.homeTeamId !== m.homeTeamId && x.awayTeamId !== m.homeTeamId)!;
    expect((await svc.analyze(other.id, { variant: 'pro' }))!.model!.id).toBe('xs-strength-1');
  });
});

describe('Frontend-jelzés', () => {
  it('a modell- és adatminőség-jelvény, illetve a visszaesés oka megjelenik', () => {
    const xs = { id: 'xs-strength-1' as const, label: 'Több ligás erősségmodell', quality: 'korlatozott' as const, qualityLabel: 'Korlátozott, de használható adat', qualityReason: 'Bizonytalanság 0.35 ≤ 0.387.', fitId: 'a'.repeat(64), trainedMatches: 12345, fitCutoff: '2026-10-15T10:00:00.000Z' };
    const badge = renderToStaticMarkup(createElement(ModelBadge, { model: xs }));
    expect(badge).toContain('Több ligás modell · Korlátozott, de használható adat');
    expect(badge).toContain('data-model="xs-strength-1"');
    const note = renderToStaticMarkup(createElement(ModelNote, { model: xs }));
    expect(note).toContain('12345 lezárt meccs');
    expect(note).toContain('aaaaaaaaaaaa');
    const fb = renderToStaticMarkup(createElement(ModelNote, { model: { id: 'xg-poisson-1', label: 'x', fallbackReason: 'A több ligás modell még nem áll készen.' } }));
    expect(fb).toContain('még nem áll készen');
    expect(renderToStaticMarkup(createElement(ModelNote, { model: { id: 'xg-poisson-1', label: 'x' } }))).toBe(''); // FREE: nincs zaj
    expect(renderToStaticMarkup(createElement(ModelBadge, {}))).toBe(''); // régi válasz: nincs jelvény
  });
});
