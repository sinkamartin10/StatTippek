/**
 * Modell-tipp archívum – rögzítés, verziózás, elszámolás, láthatóság és
 * nyilvános API.
 *
 * Valódi `SqliteTipArchiveStore` (a 0014 megfelelője, triggerekkel és
 * nézetekkel), valódi `TipArchiveService`, valódi `tipArchiveRouter` egy
 * Express appban, és – az integrációs részben – a VALÓDI `AnalysisService` a
 * valódi elemzőmotorral a beépített DEMO adatkészleten. Hálózat, Supabase,
 * .env NINCS: minden memóriában fut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

import { SqliteTipArchiveStore, type ArchiveDraft, type TipArchiveStore } from '../src/server/tipArchive/store';
import {
  TipArchiveService, budapestDayStart, contentHash, decideObservation, observedStatusOf, parseArchiveQuery, TipArchiveError,
} from '../src/server/tipArchive/service';
import type { ObservedStatus } from '../src/server/tipArchive/store';
import { EspnProvider } from '../src/server/data/espnProvider';
import { tipArchiveRouter } from '../src/server/routes/tipArchive';
import { AnalysisService } from '../src/server/services/analysisService';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { ENGINE_VERSION } from '../src/shared/engine/version';
import { ARCHIVE_PAGE_MAX, sanitizeSearch, type TipArchiveResponse } from '../src/shared/tipArchive';
import type { Container } from '../src/server/container';
import type { DataOrigin, Match, MatchAnalysis, TipCategory } from '../src/shared/types';

type DB = InstanceType<typeof DatabaseSync>;

// ---------------------------------------------------------------------------
// Segédek
// ---------------------------------------------------------------------------

const T0 = new Date('2026-10-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

/** Vezérelhető óra. */
function clock(start = T0) {
  let t = start.getTime();
  return { now: () => new Date(t), set: (d: Date | number) => { t = typeof d === 'number' ? d : d.getTime(); }, advance: (ms: number) => { t += ms; } };
}

/** Meccsadat-csonk: a frissítési kör a getMatch-et hívja. */
class StubMatches {
  readonly origin: DataOrigin;
  matches = new Map<string, Match>();
  calls: string[] = [];
  constructor(origin: DataOrigin = 'live') { this.origin = origin; }
  async getMatch(id: string): Promise<Match | null> { this.calls.push(id); return this.matches.get(id) ?? null; }
}

function match(id: string, kickoff: string, extra: Partial<Match> = {}): Match {
  return {
    id, leagueId: 'L1', homeTeamId: 'H', awayTeamId: 'A', kickoff, status: 'scheduled', origin: 'live', ...extra,
  } as Match;
}

interface TipSpec { market: string; prob: number; category?: TipCategory; odds?: number | null }

/** Minimális, a motor kimenetével azonos alakú elemzés. */
function analysis(m: Match, tips: TipSpec[], generatedAt: string, opts: { origin?: DataOrigin; league?: string; home?: string; away?: string } = {}): MatchAnalysis {
  return {
    match: m,
    league: { id: opts.league ?? m.leagueId, name: `Liga ${opts.league ?? m.leagueId}` },
    homeTeam: { id: 'H', name: opts.home ?? 'Hazai FC' },
    awayTeam: { id: 'A', name: opts.away ?? 'Vendég SC' },
    origin: opts.origin ?? 'live',
    generatedAt,
    poisson: {},
    dataQuality: { level: 'magas', score: 80, factors: [] },
    tips: tips.map((t, i) => ({
      id: `t${i}`, category: t.category ?? 'mérsékelt', market: t.market, label: `címke ${t.market}`,
      modelProb: t.prob, odds: t.odds ?? null, impliedProb: t.odds ? 1 / t.odds : null, diffPoints: null,
      supportingStats: ['NEM SZABAD KIADNI'], reasonsFor: ['titkos indoklás'], reasonsAgainst: [], risks: [],
      supportingIndicators: 3, sampleSize: 20,
    })),
  } as unknown as MatchAnalysis;
}

function rows(db: DB, where = '1=1') {
  return db.prepare(`SELECT * FROM model_tip_archive WHERE ${where} ORDER BY match_id, market, version_no`).all() as Record<string, unknown>[];
}

function draft(over: Partial<ArchiveDraft> = {}): ArchiveDraft {
  return {
    matchId: 'mx', market: 'O2.5', versionNo: 1, contentHash: 'a'.repeat(64), engineVersion: ENGINE_VERSION,
    generatedAt: iso(T0.getTime() - 5 * H), origin: 'live', matchLabel: 'X – Y', leagueId: 'L1', leagueName: 'Liga',
    kickoff: iso(T0.getTime() - 2 * H), marketLabel: 'x', marketType: 'gólszám', category: 'mérsékelt', modelProb: 0.5,
    odds: null, impliedProb: null, dataQuality: 'magas', sampleSize: 1, supportingIndicators: 1, preKickoff: true,
    availability: 'pro_on_request', ...over,
  };
}

interface Harness {
  db: DB;
  store: SqliteTipArchiveStore;
  data: StubMatches;
  clk: ReturnType<typeof clock>;
  svc: TipArchiveService;
  url: string;
  close: () => Promise<void>;
  get: (qs?: string) => Promise<{ status: number; body: TipArchiveResponse & { error?: string; code?: string } }>;
  /** a meccs hiteles megfigyelése „elkezdődött” állapotban */
  start: (id: string, kickoff: string, extra?: Partial<Match>) => Promise<void>;
  /** friss szolgáltatás (üres válasz-cache) ugyanazon a tárolón */
  fresh: () => TipArchiveService;
}

async function harness(origin: DataOrigin = 'live'): Promise<Harness> {
  const db = new DatabaseSync(':memory:');
  const store = new SqliteTipArchiveStore(db);
  const data = new StubMatches(origin);
  const clk = clock();
  const svc = new TipArchiveService(store, data, { now: clk.now, settleWaitMs: 2_000 });
  const app = express();
  app.use(express.json());
  app.use('/api/tip-archive', tipArchiveRouter(svc));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ismeretlen API végpont.' }));
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db, store, data, clk, svc, url,
    close: () => new Promise((r) => server.close(() => r())),
    get: async (qs = '') => {
      const res = await fetch(`${url}/api/tip-archive${qs}`);
      return { status: res.status, body: await res.json() };
    },
    start: async (id, kickoff, extra = {}) => { await svc.observe(match(id, kickoff, { status: 'live', ...extra })); },
    fresh: () => new TipArchiveService(store, data, { now: clk.now, settleWaitMs: 2_000 }),
  };
}

// ---------------------------------------------------------------------------
// 1) Rögzítés, idempotencia, verziózás
// ---------------------------------------------------------------------------

describe('rögzítés és verziózás', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  const m1 = () => match('m1', iso(T0.getTime() + 6 * H));

  it('minden előállított tipp rögzül, motorverzióval és kezdés előtti jelzővel', async () => {
    const n = await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61, odds: 1.8 }, { market: '1X', prob: 0.72 }], T0.toISOString()));
    expect(n).toBe(2);
    const r = rows(h.db);
    expect(r).toHaveLength(2);
    for (const x of r) {
      expect(x.engine_version).toBe(ENGINE_VERSION);
      expect(x.version_no).toBe(1);
      expect(x.pre_kickoff).toBe(1);
      expect(x.settlement_status).toBe('pending');
      expect(x.availability).toBe('pro_on_request');
      expect(x.archive_visible).toBe(1);
    }
    expect(r.find((x) => x.market === 'O2.5')!.odds_at_generation).toBe(1.8);
  });

  it('a tartalmilag azonos újraszámolás nem hoz létre új sort – új szolgáltatás-példánnyal sem', async () => {
    const tips = [{ market: 'O2.5', prob: 0.61 }, { market: 'BTTS_Y', prob: 0.55 }];
    await h.svc.record(analysis(m1(), tips, T0.toISOString()));
    expect(await h.svc.record(analysis(m1(), tips, iso(T0.getTime() + 60_000)))).toBe(0);
    expect(await h.fresh().record(analysis(m1(), tips, iso(T0.getTime() + 120_000)))).toBe(0);
    expect(rows(h.db)).toHaveLength(2);
  });

  it('csak az odds változása NEM új tipp', async () => {
    await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61, odds: 1.8 }], T0.toISOString()));
    expect(await h.fresh().record(analysis(m1(), [{ market: 'O2.5', prob: 0.61, odds: 2.4 }], iso(T0.getTime() + H)))).toBe(0);
    const r = rows(h.db);
    expect(r).toHaveLength(1);
    expect(r[0].odds_at_generation).toBe(1.8); // az eredeti, első odds marad
  });

  it('a 0,1 százalékpont alatti zaj nem változás, a lényegi változás új, időbélyeges verzió – a régi megmarad', async () => {
    await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()));
    expect(await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61000004 }], iso(T0.getTime() + H)))).toBe(0);
    expect(await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.64 }], iso(T0.getTime() + 2 * H)))).toBe(1);
    expect(await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.64, category: 'konzervatív' }], iso(T0.getTime() + 3 * H)))).toBe(1);
    const r = rows(h.db);
    expect(r.map((x) => [x.version_no, x.model_prob, x.category])).toEqual([
      [1, 0.61, 'mérsékelt'], [2, 0.64, 'mérsékelt'], [3, 0.64, 'konzervatív'],
    ]);
    expect(r[0].generated_at).toBe(T0.toISOString());
    expect(r[1].generated_at).toBe(iso(T0.getTime() + 2 * H));
  });

  it('A → B → A egy példányon belül is új verzió (a legutolsóhoz hasonlítunk, nem bármelyikhez)', async () => {
    await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()));
    await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.65 }], iso(T0.getTime() + H)));
    expect(await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], iso(T0.getTime() + 2 * H)))).toBe(1);
    expect(rows(h.db).map((x) => x.version_no)).toEqual([1, 2, 3]);
  });

  it('TÖBB PÉLDÁNY: A (1. példány) → B (2. példány) → A (1. példány) nem vész el', async () => {
    const a = h.fresh();
    const b = h.fresh();
    await a.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()));
    await b.record(analysis(m1(), [{ market: 'O2.5', prob: 0.65 }], iso(T0.getTime() + H)));
    // az 1. példány ugyanazt az A-t számolja újra, mint amit korábban maga írt
    expect(await a.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], iso(T0.getTime() + 2 * H)))).toBe(1);
    expect(rows(h.db).map((x) => [x.version_no, x.model_prob])).toEqual([[1, 0.61], [2, 0.65], [3, 0.61]]);
  });

  it('TÖBB PÉLDÁNY: ütköző sorszám → újraolvasás és a következő sorszám; nincs duplikátum és nincs elveszett verzió', async () => {
    // A tároló-burkoló az első beszúrás ELŐTT egy „másik példány” sorát szúrja be ugyanazzal a sorszámmal
    let injected = false;
    const racing: TipArchiveStore = new Proxy(h.store, {
      get(t, prop, recv) {
        if (prop === 'insertVersions') {
          return async (drafts: ArchiveDraft[]) => {
            if (!injected) {
              injected = true;
              // a másik példány RÉGEBBI számolása (1 mp-cel korábbi) foglalja el ugyanazt a sorszámot
              await t.insertVersions(drafts.map((d) => ({ ...d, contentHash: 'f'.repeat(64), modelProb: 0.7, generatedAt: iso(T0.getTime() - 1000) })));
            }
            return t.insertVersions(drafts);
          };
        }
        return Reflect.get(t, prop, recv);
      },
    });
    const svc = new TipArchiveService(racing, h.data, { now: h.clk.now });
    expect(await svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()))).toBe(1);
    expect(rows(h.db).map((x) => [x.version_no, x.model_prob])).toEqual([[1, 0.7], [2, 0.61]]);
  });

  it('tartós ütközés esetén a rögzítés hibát dob (nem nyeli el csendben)', async () => {
    const stuck: TipArchiveStore = new Proxy(h.store, {
      get(t, prop, recv) {
        if (prop === 'insertVersions') return async () => [];
        return Reflect.get(t, prop, recv);
      },
    });
    const svc = new TipArchiveService(stuck, h.data, { now: h.clk.now });
    await expect(svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()))).rejects.toThrow(/kör után sem stabilizálódtak/);
  });

  it('külön meccsek és külön piacok külön rekordok', async () => {
    await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.6 }, { market: 'U2.5', prob: 0.4 }], T0.toISOString()));
    await h.svc.record(analysis(match('m2', iso(T0.getTime() + 6 * H)), [{ market: 'O2.5', prob: 0.6 }], T0.toISOString()));
    expect(rows(h.db)).toHaveLength(3);
    expect(contentHash('m1', 'O2.5', 'mérsékelt', 0.6)).not.toBe(contentHash('m2', 'O2.5', 'mérsékelt', 0.6));
    expect(contentHash('m1', 'O2.5', 'mérsékelt', 0.6, 'masik-motor')).not.toBe(contentHash('m1', 'O2.5', 'mérsékelt', 0.6));
  });

  it('párhuzamos rögzítés ugyanarra a meccsre: nincs duplikált sorszám, nincs elveszett verzió', async () => {
    const a = h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()));
    const b = h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.66 }], iso(T0.getTime() + 1000)));
    await Promise.all([a, b]);
    expect(rows(h.db).map((x) => [x.version_no, x.model_prob])).toEqual([[1, 0.61], [2, 0.66]]);
  });

  it('modell-eredmény nélküli elemzés (nincs Poisson / nincs tipp) nem ír tipp-sort', async () => {
    expect(await h.svc.record(analysis(m1(), [], T0.toISOString()))).toBe(0);
    expect(await h.svc.record({ ...analysis(m1(), [{ market: 'O2.5', prob: 0.6 }], T0.toISOString()), poisson: null } as MatchAnalysis)).toBe(0);
    expect(rows(h.db)).toHaveLength(0);
  });

  it('a kezdés után keletkezett tipp is rögzül, de kezdés utániként jelölve', async () => {
    await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() + 7 * H)));
    expect(rows(h.db)[0].pre_kickoff).toBe(0);
  });

  it('a rögzítés a meccs aktuális állapotát is feljegyzi; régebbi megfigyelés nem írja felül az újabbat', async () => {
    await h.svc.record(analysis(m1(), [{ market: 'O2.5', prob: 0.6 }], T0.toISOString()));
    const state = () => h.db.prepare("SELECT * FROM model_tip_archive_match_state WHERE match_id = 'm1'").get() as Record<string, unknown>;
    expect(state()).toMatchObject({ match_status: 'scheduled', current_kickoff: iso(T0.getTime() + 6 * H), observed_at: T0.toISOString() });
    await h.svc.observe(match('m1', iso(T0.getTime() + 48 * H), { status: 'postponed' }), iso(T0.getTime() + H));
    await h.svc.observe(match('m1', iso(T0.getTime() + 6 * H), { status: 'live' }), iso(T0.getTime() + 30 * 60_000)); // régebbi
    expect(state()).toMatchObject({ match_status: 'postponed', current_kickoff: iso(T0.getTime() + 48 * H) });
  });

  it('observedStatusOf: végeredmény nélküli „finished” még nem elszámolható → live', () => {
    expect(observedStatusOf({ status: 'finished', homeGoals: 1, awayGoals: 0 })).toBe('finished');
    expect(observedStatusOf({ status: 'finished' })).toBe('live');
    expect(observedStatusOf({ status: 'live' })).toBe('live');
    expect(observedStatusOf({ status: 'postponed' })).toBe('postponed');
    expect(observedStatusOf({ status: 'scheduled' })).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
// 2) Adatbázis-szintű garanciák (a 0014 megfelelője)
// ---------------------------------------------------------------------------

describe('adatbázis-garanciák', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  it('a rögzített tipp-mezők (a generáláskori kickoff is) nem írhatók felül', async () => {
    await h.store.insertVersions([draft()]);
    expect(() => h.db.prepare("UPDATE model_tip_archive SET model_prob = 0.9 WHERE match_id = 'mx'").run()).toThrow(/nem módosítható/);
    expect(() => h.db.prepare("UPDATE model_tip_archive SET kickoff = '2030-01-01T00:00:00.000Z' WHERE match_id = 'mx'").run()).toThrow(/nem módosítható/);
  });

  it('a sorok nem törölhetők – sem egyenként, sem a teljes tábla (SQLite: a feltétel nélküli DELETE a TRUNCATE megfelelője)', async () => {
    await h.store.insertVersions([draft()]);
    await h.svc.observe(match('mx', iso(T0.getTime() - 2 * H), { status: 'live' }));
    expect(() => h.db.prepare("DELETE FROM model_tip_archive WHERE match_id = 'mx'").run()).toThrow(/nem törölhetők/);
    expect(() => h.db.prepare('DELETE FROM model_tip_archive').run()).toThrow(/nem törölhetők/);
    expect(() => h.db.prepare('DELETE FROM model_tip_archive_match_state').run()).toThrow(/nem törölhetők/);
    expect(rows(h.db)).toHaveLength(1);
  });

  it('a lezárt tipp eredménye nem írható át', async () => {
    await h.store.insertVersions([draft()]);
    await h.store.settle({ matchId: 'mx', homeGoals: 2, awayGoals: 1, resultKickoff: iso(T0.getTime() + H), settledAt: T0.toISOString(), outcomes: [{ market: 'O2.5', status: 'won' }] });
    expect(() => h.db.prepare("UPDATE model_tip_archive SET settlement_status = 'lost' WHERE match_id = 'mx'").run()).toThrow(/nem írható át/);
    // a feltételes elszámolás második futása semmit nem ír
    expect(await h.store.settle({ matchId: 'mx', homeGoals: 0, awayGoals: 0, resultKickoff: iso(T0.getTime() + H), settledAt: T0.toISOString(), outcomes: [{ market: 'O2.5', status: 'lost' }] })).toBe(0);
    expect(rows(h.db)[0].settlement_status).toBe('won');
  });

  it('a hamis „kezdés előtti” jelzőt és az eredmény nélküli lezárást elutasítja', async () => {
    expect(() => h.db.prepare(
      `INSERT INTO model_tip_archive (id, match_id, market, version_no, content_hash, engine_version, generated_at, origin, match_label,
        league_id, league_name, kickoff, market_label, market_type, category, model_prob, data_quality, sample_size, supporting_indicators, pre_kickoff)
       VALUES ('x', 'm', 'O2.5', 1, '${'a'.repeat(64)}', 'v', '2026-10-02T00:00:00.000Z', 'live', 'l', 'L', 'L', '2026-10-01T00:00:00.000Z', 'x', 'y', 'mérsékelt', 0.5, 'magas', 1, 1, 1)`,
    ).run()).toThrow();
    await h.store.insertVersions([draft()]);
    expect(() => h.db.prepare("UPDATE model_tip_archive SET settlement_status = 'won' WHERE match_id = 'mx'").run()).toThrow();
  });

  it('ugyanaz a (meccs, piac, sorszám) másodszor nem szúrható be', async () => {
    expect(await h.store.insertVersions([draft()])).toEqual(['O2.5']);
    expect(await h.store.insertVersions([draft({ modelProb: 0.9, contentHash: 'b'.repeat(64) })])).toEqual([]);
    expect(rows(h.db)).toHaveLength(1);
    expect(rows(h.db)[0].model_prob).toBe(0.5);
  });

  it('a PostgreSQL migráció tartalmazza a garanciákat', () => {
    const sql = readFileSync(new URL('../supabase/migrations/0014_model_tip_archive.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/unique \(match_id, market, version_no\)/);
    expect(sql).toMatch(/check \(pre_kickoff = \(generated_at < kickoff\)\)/);
    expect(sql).toMatch(/before update on public\.model_tip_archive/);
    expect(sql).toMatch(/before delete on public\.%I for each row/);
    expect(sql).toMatch(/before truncate on public\.%I for each statement/);
    expect(sql).toMatch(/revoke delete, truncate, trigger, references on public\.model_tip_archive from service_role/);
    expect(sql).toMatch(/revoke delete, truncate, trigger, references on public\.model_tip_archive_match_state from service_role/);
    expect(sql).toMatch(/select distinct on \(match_id, market\) \*/);
    expect(sql).toMatch(/server_version_num/);
    expect(sql).toMatch(/where s\.observed_at <= excluded\.observed_at/);
    expect(sql).toMatch(/join public\.model_tip_archive_match_state s on s\.match_id = a\.match_id/);
    for (const obj of ['model_tip_archive', 'model_tip_archive_match_state', 'model_tip_archive_counted',
      'model_tip_archive_listing', 'model_tip_archive_counted_listing']) {
      expect(sql).toContain(`revoke all on public.${obj} from anon, authenticated;`);
    }
    // nincs kliens-oldali policy; meglévő objektumot nem töröl / módosít
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/^\s*(drop|alter table (?!public\.model_tip_archive))/im);
    // nincs security definer függvény (a megjegyzés-sorokat kihagyva)
    const code = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
    expect(code).not.toMatch(/security definer/i);
  });
});

// ---------------------------------------------------------------------------
// 3) Elszámolás – a meglévő evaluateMarket() szabállyal
// ---------------------------------------------------------------------------

describe('elszámolás', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  const kickoff = iso(T0.getTime() + 2 * H);
  const markets: TipSpec[] = [
    { market: '1', prob: 0.5 }, { market: 'X', prob: 0.3 }, { market: '2', prob: 0.2 },
    { market: 'DNB_1', prob: 0.6 }, { market: 'AH_HOME_-1', prob: 0.3 }, { market: 'O2.5', prob: 0.5 },
    { market: 'U2.5', prob: 0.5 }, { market: 'BTTS_Y', prob: 0.5 }, { market: 'CS_1-1', prob: 0.1 },
    { market: 'HOME_O0.5', prob: 0.8 },
  ];

  it('döntetlen (1–1): a piacok a meglévő szabály szerint zárulnak, a DNB érvénytelen (tét vissza)', async () => {
    await h.svc.record(analysis(match('s1', kickoff), markets, T0.toISOString()));
    const n = await h.svc.settleFromMatch(match('s1', kickoff, { status: 'finished', homeGoals: 1, awayGoals: 1 }));
    expect(n).toBe(markets.length);
    const st = Object.fromEntries(rows(h.db).map((x) => [x.market, x.settlement_status]));
    expect(st).toEqual({
      '1': 'lost', X: 'won', '2': 'lost', DNB_1: 'void', 'AH_HOME_-1': 'lost', 'O2.5': 'lost',
      'U2.5': 'won', BTTS_Y: 'won', 'CS_1-1': 'won', 'HOME_O0.5': 'won',
    });
    for (const x of rows(h.db)) { expect(x.home_goals).toBe(1); expect(x.away_goals).toBe(1); expect(x.settled_at).toBeTruthy(); }
  });

  it('ázsiai hendikep pontosan egygólos hazai győzelemnél érvénytelen', async () => {
    await h.svc.record(analysis(match('s2', kickoff), [{ market: 'AH_HOME_-1', prob: 0.3 }], T0.toISOString()));
    await h.svc.settleFromMatch(match('s2', kickoff, { status: 'finished', homeGoals: 2, awayGoals: 1 }));
    expect(rows(h.db)[0].settlement_status).toBe('void');
  });

  it('ismeretlen piac: „nem elszámolható” – nem vereség', async () => {
    await h.store.insertVersions([draft({ matchId: 's3', market: 'FURCSA_PIAC', marketType: 'egyéb', kickoff, generatedAt: T0.toISOString() })]);
    await h.svc.settleFromMatch(match('s3', kickoff, { status: 'finished', homeGoals: 0, awayGoals: 0 }));
    expect(rows(h.db)[0].settlement_status).toBe('unsupported');
  });

  it('elhalasztott / törölt / folyamatban lévő meccs függő marad (nem vereség)', async () => {
    await h.svc.record(analysis(match('s4', kickoff), [{ market: 'O2.5', prob: 0.5 }], T0.toISOString()));
    expect(await h.svc.settleFromMatch(match('s4', kickoff, { status: 'postponed' }))).toBe(0);
    expect(await h.svc.settleFromMatch(match('s4', kickoff, { status: 'live', homeGoals: 0, awayGoals: 0 }))).toBe(0);
    expect(await h.svc.settleFromMatch(match('s4', kickoff, { status: 'finished' }))).toBe(0);
    expect(rows(h.db)[0].settlement_status).toBe('pending');
  });

  it('az elszámolás idempotens: másodszor semmit nem ír át', async () => {
    await h.svc.record(analysis(match('s5', kickoff), [{ market: 'O2.5', prob: 0.5 }], T0.toISOString()));
    const fin = match('s5', kickoff, { status: 'finished', homeGoals: 3, awayGoals: 0 });
    expect(await h.svc.settleFromMatch(fin)).toBe(1);
    const before = rows(h.db)[0];
    h.clk.advance(H);
    expect(await h.svc.settleFromMatch(fin)).toBe(0);
    expect(rows(h.db)[0]).toEqual(before);
  });

  it('a már lejátszott meccs elemzése azonnal elszámol (kezdés utáni rekordként)', async () => {
    const fin = match('s6', kickoff, { status: 'finished', homeGoals: 2, awayGoals: 2 });
    await h.svc.record(analysis(fin, [{ market: 'BTTS_Y', prob: 0.55 }], iso(T0.getTime() + 5 * H)));
    const r = rows(h.db)[0];
    expect(r.settlement_status).toBe('won');
    expect(r.pre_kickoff).toBe(0);
  });

  it('frissítési kör: csak a már elmúlt kezdésű, nem lezárt meccseket kérdezi le, és fojtott', async () => {
    const past = iso(T0.getTime() - 3 * H);
    const future = iso(T0.getTime() + 3 * H);
    await h.svc.record(analysis(match('d1', past), [{ market: 'O2.5', prob: 0.5 }], iso(T0.getTime() - 10 * H)));
    await h.svc.record(analysis(match('d2', future), [{ market: 'O2.5', prob: 0.5 }], iso(T0.getTime() - 10 * H)));
    h.data.matches.set('d1', match('d1', past, { status: 'finished', homeGoals: 1, awayGoals: 2 }));
    h.data.calls = [];
    expect(await h.svc.settleDue()).toBe(1);
    expect(h.data.calls).toEqual(['d1']); // a d2 még el sem kezdődött
    expect(Object.fromEntries(rows(h.db).map((x) => [x.match_id, x.settlement_status]))).toEqual({ d1: 'won', d2: 'pending' });
    // fojtás: azonnal újra hívva nem kérdez le semmit
    expect(await h.svc.settleDue()).toBe(0);
    expect(h.data.calls).toEqual(['d1']);
  });
});

// ---------------------------------------------------------------------------
// 4) Statisztika: kezdés előtti utolsó verzió
// ---------------------------------------------------------------------------

describe('statisztika – kezdés előtti utolsó verzió', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  it('a kezdés utáni verzió nem írhatja felül a kezdés előttit; a korábbi verzió nem számít', async () => {
    const k = iso(T0.getTime() - 2 * H);
    const m = match('p1', k);
    await h.svc.record(analysis(m, [{ market: 'O2.5', prob: 0.55 }], iso(T0.getTime() - 8 * H))); // v1, kezdés előtt
    await h.svc.record(analysis(m, [{ market: 'O2.5', prob: 0.62 }], iso(T0.getTime() - 4 * H))); // v2, kezdés előtt → ez számít
    await h.svc.record(analysis(m, [{ market: 'O2.5', prob: 0.9 }], iso(T0.getTime() - 1 * H)));  // v3, kezdés után
    await h.svc.observe(match('p1', k, { status: 'finished', homeGoals: 0, awayGoals: 0 }));

    const { status, body } = await h.get();
    expect(status).toBe(200);
    expect(body.entries.map((e) => [e.versionNo, e.counted, e.preKickoff])).toEqual([[3, false, false], [2, true, true], [1, false, true]]);
    expect(body.summary).toMatchObject({ records: 3, counted: 1, won: 0, lost: 1, hitRate: 0 });

    const counted = await h.get('?scope=counted');
    expect(counted.body.entries.map((e) => e.versionNo)).toEqual([2]);
    expect(counted.body.total).toBe(1);
  });

  it('csak kezdés utáni verzió esetén a piac nem számít a statisztikába', async () => {
    const k = iso(T0.getTime() - 2 * H);
    await h.svc.record(analysis(match('p2', k, { status: 'live' }), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - 1 * H)));
    const { body } = await h.get();
    expect(body.summary.records).toBe(1);
    expect(body.summary.counted).toBe(0);
    expect(body.entries[0].counted).toBe(false);
  });

  it('ha a meccs kezdése előrébb került, a már kezdés utáninak bizonyuló verzió nem számít', async () => {
    const plannedKickoff = iso(T0.getTime() - 1 * H);
    const realKickoff = iso(T0.getTime() - 5 * H);
    await h.svc.record(analysis(match('p3', plannedKickoff), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - 8 * H)));
    await h.svc.record(analysis(match('p3', plannedKickoff), [{ market: 'O2.5', prob: 0.7 }], iso(T0.getTime() - 3 * H)));
    await h.svc.observe(match('p3', realKickoff, { status: 'finished', homeGoals: 3, awayGoals: 1 }));
    const { body } = await h.get('?scope=counted');
    expect(body.entries.map((e) => [e.versionNo, e.modelProb])).toEqual([[1, 0.6]]);
  });

  it('függő, érvénytelen és nem elszámolható tipp nem vereség, a találati arány csak nyert/vesztett', async () => {
    const k = iso(T0.getTime() - 3 * H);
    await h.svc.record(analysis(match('q1', k), [{ market: 'DNB_1', prob: 0.6 }, { market: 'O2.5', prob: 0.5 }, { market: 'BTTS_Y', prob: 0.5 }], iso(T0.getTime() - 9 * H)));
    await h.svc.record(analysis(match('q2', k), [{ market: 'O2.5', prob: 0.5 }], iso(T0.getTime() - 9 * H)));
    await h.svc.observe(match('q1', k, { status: 'finished', homeGoals: 1, awayGoals: 1 }));
    await h.start('q2', k); // elkezdődött, még nincs eredmény → függő
    const { body } = await h.get();
    expect(body.summary).toMatchObject({ counted: 4, won: 1, lost: 1, void: 1, pending: 1, unsupported: 0, hitRate: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// 5) Nyilvánosság: csak az AKTUÁLIS állapot szerint elkezdődött meccs
// ---------------------------------------------------------------------------

describe('nyilvánosság – elhalasztott / jövőbeli / ismeretlen állapotú meccs', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  const oldKickoff = iso(T0.getTime() + H);       // 2026-10-01 13:00 UTC
  const newKickoff = iso(T0.getTime() + 48 * H);  // 2026-10-03 12:00 UTC

  /** Minden nyilvános útvonal, amelyen sor vagy szám kijuthat. */
  const ROUTES = [
    '', '?scope=counted', '?scope=all&page=1&pageSize=50', '?page=2&pageSize=1',
    '?status=pending', '?status=won', '?leagueId=L1', '?marketType=g%C3%B3lsz%C3%A1m', '?marketType=BTTS',
    '?search=Hazai', '?availability=pro_on_request', '?from=2026-10-01&to=2026-10-01', '?from=2026-09-01&to=2026-12-31',
    '?scope=counted&status=pending&leagueId=L1&from=2026-10-01&to=2026-10-03',
  ];

  async function expectHiddenEverywhere(svc: TipArchiveService) {
    for (const qs of ROUTES) {
      const r = await svc.query(Object.fromEntries(new URLSearchParams(qs)));
      expect(r.entries, qs).toEqual([]);
      expect(r.total, qs).toBe(0);
      expect(r.summary, qs).toEqual({ records: 0, counted: 0, won: 0, lost: 0, void: 0, pending: 0, unsupported: 0, hitRate: null });
    }
  }

  it('REGRESSZIÓ: a tipp 13:00 előtt készült, a meccset 10-03 12:00-ra halasztották → 10-01 14:00-kor SEHOL nem látszik', async () => {
    h.clk.set(T0.getTime() - H); // 11:00 – tipp az eredeti kezdés előtt
    await h.svc.record(analysis(match('pp', oldKickoff), [{ market: 'O2.5', prob: 0.61 }, { market: 'BTTS_Y', prob: 0.5 }], h.clk.now().toISOString()));
    h.clk.set(T0.getTime() + 2 * H); // 14:00 – az eredeti kezdés elmúlt, a meccs elhalasztva
    h.data.matches.set('pp', match('pp', newKickoff, { status: 'scheduled' }));
    // az elemzés is az új időponttal fut újra – azonos tartalom, nincs új sor
    await h.svc.record(analysis(match('pp', newKickoff), [{ market: 'O2.5', prob: 0.61 }, { market: 'BTTS_Y', prob: 0.5 }], h.clk.now().toISOString()));
    expect(rows(h.db)).toHaveLength(2);
    expect(rows(h.db).every((x) => x.kickoff === oldKickoff)).toBe(true); // az eredeti kickoff auditcélból megmarad

    await expectHiddenEverywhere(h.fresh());
    // HTTP-n át is
    for (const qs of ROUTES) {
      const { status, body } = await h.get(qs);
      expect(status, qs).toBe(200);
      expect(body.total, qs).toBe(0);
    }
  });

  it('elhalasztott, még ismeretlen új időpontú meccs (postponed) sem látszik', async () => {
    await h.svc.record(analysis(match('pq', oldKickoff), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - H)));
    h.clk.set(T0.getTime() + 2 * H);
    await h.svc.observe(match('pq', oldKickoff, { status: 'postponed' }));
    await expectHiddenEverywhere(h.fresh());
  });

  it('az elhalasztott meccs az ÚJ kezdés után, megerősített kezdéskor jelenik meg – a nyilvános kickoff az aktuális', async () => {
    await h.svc.record(analysis(match('pr', oldKickoff), [{ market: 'O2.5', prob: 0.61 }], iso(T0.getTime() - H)));
    await h.svc.observe(match('pr', newKickoff, { status: 'scheduled' }), iso(T0.getTime() + 2 * H));
    h.clk.set(T0.getTime() + 49 * H);
    await expectHiddenEverywhere(h.fresh()); // a kezdés elmúlt, de még nincs megerősítve (a frissítés null-t kap)
    await h.svc.observe(match('pr', newKickoff, { status: 'live' }));
    const r = await h.fresh().query({});
    expect(r.total).toBe(1);
    expect(r.entries[0].kickoff).toBe(newKickoff);
    expect(r.entries[0].counted).toBe(true); // az eredeti kezdés előtt készült → az új kezdés előtt is
  });

  it('ismeretlen aktuális állapot (nincs megfigyelés) → rejtett', async () => {
    await h.store.insertVersions([draft({ matchId: 'nostate' })]);
    await expectHiddenEverywhere(h.fresh());
  });

  it('érvénytelen aktuális kickoff → nem kerül állapot, a meccs rejtett marad', async () => {
    await h.store.insertVersions([draft({ matchId: 'badk' })]);
    await h.svc.observe(match('badk', 'nem-datum', { status: 'live' }));
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM model_tip_archive_match_state WHERE match_id = 'badk'").get()).toEqual({ n: 0 });
    await expectHiddenEverywhere(h.fresh());
  });

  it('a kezdés elmúlt, de a szolgáltató még „scheduled” → rejtett, amíg a frissítés el nem kezdődöttnek látja', async () => {
    const k = iso(T0.getTime() - 30 * 60_000);
    await h.svc.record(analysis(match('pu', k), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - 5 * H)));
    expect((await h.fresh().query({ scope: 'all' })).total).toBe(0);
    // a frissítési kör a szolgáltatótól már „live”-ot kap
    h.data.matches.set('pu', match('pu', k, { status: 'live' }));
    const r = await h.fresh().query({});
    expect(h.data.calls).toContain('pu');
    expect(r.total).toBe(1);
    expect(r.entries[0].kickoff).toBe(k);
  });

  it('korábbra hozott kezdés: ellentmondó megfigyelésre rejtve marad, a tárolt kezdés elmúltával megjelenik – a jövőbeli generáláskori kickoff nem szivárog', async () => {
    // generáláskor 18:00-ra volt kiírva, végül 11:00-kor kezdődött
    await h.svc.record(analysis(match('pe', iso(T0.getTime() + 6 * H)), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - 5 * H)));
    await h.start('pe', iso(T0.getTime() - H)); // ellentmond a tárolt (még jövőbeli) 18:00-nak → elvetve
    expect((await h.fresh().query({})).total).toBe(0);
    // a tárolt kezdés is elmúlt → a frissítés már elfogadja a (lejátszott) megfigyelést
    h.clk.set(T0.getTime() + 7 * H);
    h.data.matches.set('pe', match('pe', iso(T0.getTime() - H), { status: 'finished', homeGoals: 1, awayGoals: 0 }));
    const r = await h.fresh().query({});
    expect(r.total).toBe(1);
    const now = h.clk.now().toISOString();
    for (const e of r.entries) expect(e.kickoff < now).toBe(true);
    expect(r.entries[0].kickoff).toBe(iso(T0.getTime() - H));
    expect(JSON.stringify(r)).not.toContain(iso(T0.getTime() + 6 * H));
  });

  it('a jövőbeli és az elhalasztott meccs mellett a látható meccs számai pontosak', async () => {
    await h.svc.record(analysis(match('ok', iso(T0.getTime() - 3 * H)), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - 5 * H)));
    await h.svc.observe(match('ok', iso(T0.getTime() - 3 * H), { status: 'finished', homeGoals: 2, awayGoals: 1 }));
    h.clk.set(T0.getTime() - H);
    await h.svc.record(analysis(match('pp', oldKickoff), [{ market: 'O2.5', prob: 0.61 }], h.clk.now().toISOString()));
    h.clk.set(T0.getTime() + 2 * H);
    await h.svc.observe(match('pp', newKickoff));
    await h.svc.record(analysis(match('fut', iso(T0.getTime() + 5 * H)), [{ market: 'O2.5', prob: 0.9 }], h.clk.now().toISOString()));
    const r = await h.fresh().query({});
    expect(r.entries.map((e) => e.matchId)).toEqual(['ok']);
    expect(r.summary).toMatchObject({ records: 1, counted: 1, won: 1 });
  });
});

// ---------------------------------------------------------------------------
// 6) Nyilvános API: szűrés, lapozás, összesítés, adatvédelem
// ---------------------------------------------------------------------------

describe('nyilvános API', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    // 12 elkezdődött meccs két bajnokságban + 1 jövőbeli meccs
    for (let i = 0; i < 12; i++) {
      const k = iso(T0.getTime() - (i + 1) * 24 * H);
      const league = i % 2 ? 'L2' : 'L1';
      const id = `a${String(i).padStart(2, '0')}`;
      await h.svc.record(analysis(match(id, k, { leagueId: league }),
        [{ market: 'O2.5', prob: 0.55 }, { market: '1X', prob: 0.7 }],
        iso(new Date(k).getTime() - 5 * H), { league, home: i === 3 ? 'Ferencváros' : `Csapat${i}`, away: 'Vendég' }));
      await h.start(id, k);
    }
    await h.svc.record(analysis(match('future', iso(T0.getTime() + 24 * H)), [{ market: 'O2.5', prob: 0.99 }], T0.toISOString()));
    await h.svc.observe(match('a00', iso(T0.getTime() - 24 * H), { status: 'finished', homeGoals: 3, awayGoals: 0 }));
  });
  afterEach(async () => { await h.close(); });

  it('jövőbeli meccs tippje nem jelenik meg (a PRO-tartalom nem szivárog)', async () => {
    const { body } = await h.get('?pageSize=50');
    expect(body.total).toBe(24);
    expect(body.entries.some((e) => e.matchId === 'future')).toBe(false);
    expect(body.summary.records).toBe(24);
  });

  it('stabil sorrend, kötött lapméret, átfedés- és hézagmentes lapozás', async () => {
    const seen: string[] = [];
    let page = 1;
    for (;;) {
      const { body } = await h.get(`?pageSize=5&page=${page}`);
      expect(body.entries.length).toBeLessThanOrEqual(5);
      seen.push(...body.entries.map((e) => e.id));
      if (!body.hasMore) break;
      page++;
    }
    expect(seen).toHaveLength(24);
    expect(new Set(seen).size).toBe(24);
    const all = (await h.get('?pageSize=50')).body.entries;
    expect(all.map((e) => e.id)).toEqual(seen);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].kickoff >= all[i].kickoff).toBe(true);
    expect((await h.get('?pageSize=9999')).body.pageSize).toBe(ARCHIVE_PAGE_MAX);
  });

  it('szűrők: bajnokság, piactípus, eredmény, dátum, keresés – az összesítés ugyanarra a körre', async () => {
    const l2 = (await h.get('?leagueId=L2&pageSize=50')).body;
    expect(l2.total).toBe(12);
    expect(l2.entries.every((e) => e.leagueId === 'L2')).toBe(true);
    expect(l2.summary.records).toBe(12);

    const goals = (await h.get('?marketType=g%C3%B3lsz%C3%A1m')).body;
    expect(goals.total).toBe(12);
    expect(goals.entries.every((e) => e.market === 'O2.5')).toBe(true);

    const won = (await h.get('?status=won')).body;
    expect(won.total).toBe(2);
    expect(won.summary).toMatchObject({ records: 2, won: 2, lost: 0, pending: 0 });

    // a00 kezdése 2026-09-30 12:00 UTC = 14:00 magyar idő → a magyar 09-30-i napon van
    const oneDay = (await h.get('?from=2026-09-30&to=2026-09-30')).body;
    expect(oneDay.entries.every((e) => e.matchId === 'a00')).toBe(true);
    expect(oneDay.total).toBe(2);

    const search = (await h.get(`?search=${encodeURIComponent('ferencv')}`)).body;
    expect(search.total).toBe(2);
    expect(search.entries.every((e) => e.matchLabel.startsWith('Ferencváros'))).toBe(true);
  });

  it('közzétételi állapot: elérhetőség szerint szűrhető, a rejtett sor nem jelenik meg', async () => {
    expect((await h.get('?availability=pro_on_request')).body.total).toBe(24);
    expect((await h.get('?availability=not_published')).body.total).toBe(0);
    h.db.prepare("UPDATE model_tip_archive SET archive_visible = 0 WHERE match_id = 'a01'").run();
    const r = await h.fresh().query({ pageSize: '50' });
    expect(r.total).toBe(22);
    expect(r.entries.some((e) => e.matchId === 'a01')).toBe(false);
  });

  it('érvénytelen paraméterekre 400, belső részlet nélkül', async () => {
    for (const qs of ['?from=2026-13-01', '?from=2026-02-30', '?to=tegnap', '?from=2026-10-05&to=2026-10-01', '?leagueId=%3Bdrop', '?marketType=semmi',
      '?status=nyert', '?availability=mindenki', '?scope=titkos', '?page=0', '?page=-1', '?page=abc', '?pageSize=0', '?page=100000']) {
      const { status, body } = await h.get(qs);
      expect(status, qs).toBe(400);
      expect(body.code).toBe('BAD_REQUEST');
    }
  });

  it('a keresés tisztított: a LIKE- és PostgREST-vezérlőkarakterek nem jutnak a lekérdezésbe', async () => {
    expect(sanitizeSearch('%_,()*')).toBeUndefined();
    expect(sanitizeSearch(' Ferenc%város, ')).toBe('Ferencváros');
    expect(sanitizeSearch('x')).toBeUndefined();
    expect(sanitizeSearch('a'.repeat(100))!.length).toBe(40);
    expect((await h.get('?search=%25')).body.total).toBe(24); // a „%” kiesik → nincs keresés
  });

  it('nem ad ki belső vagy érzékeny mezőt (allowlist)', async () => {
    const { body } = await h.get();
    const allowed = ['id', 'matchId', 'matchLabel', 'leagueId', 'leagueName', 'kickoff', 'market', 'marketLabel', 'marketType',
      'category', 'modelProb', 'odds', 'dataQuality', 'sampleSize', 'engineVersion', 'versionNo', 'generatedAt', 'preKickoff',
      'counted', 'availability', 'status', 'homeGoals', 'awayGoals', 'settledAt'].sort();
    for (const e of body.entries) expect(Object.keys(e).sort()).toEqual(allowed);
    const text = JSON.stringify(body);
    for (const bad of ['content_hash', 'contentHash', 'NEM SZABAD KIADNI', 'titkos indoklás', 'archiveVisible', 'resultKickoff',
      'currentKickoff', 'matchStatus', 'match_status', 'observed', 'userId', 'user_id']) {
      expect(text).not.toContain(bad);
    }
    expect(Object.keys(body).sort()).toEqual(['coverageStart', 'engineVersion', 'entries', 'hasMore', 'origin', 'page', 'pageSize', 'summary', 'total']);
  });

  it('csak olvasható: írási kérés nem létezik; bejelentkezés nélkül is olvasható', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${h.url}/api/tip-archive`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status, method).toBe(404);
    }
    expect(rows(h.db)).toHaveLength(25);
    expect((await h.get()).status).toBe(200);
  });

  it('a lefedettség kezdete a legkorábbi valós rekord; demo és élő adat nem keveredik', async () => {
    const { body } = await h.get();
    expect(body.coverageStart).toBe(rows(h.db).map((x) => String(x.generated_at)).sort()[0]);
    expect(body.origin).toBe('live');
    const demo = new TipArchiveService(h.store, new StubMatches('demo'), { now: h.clk.now });
    const r = await demo.query({});
    expect(r.total).toBe(0);
    expect(r.coverageStart).toBeNull();
  });

  it('parseArchiveQuery: alapértékek', () => {
    expect(parseArchiveQuery({})).toEqual({ filter: {}, scope: 'all', page: 1, pageSize: 25 });
    expect(() => parseArchiveQuery({ page: '0' })).toThrow(TipArchiveError);
  });
});

// ---------------------------------------------------------------------------
// 7) Dátumszűrő: magyar naptári nap, a szerver időzónájától függetlenül
// ---------------------------------------------------------------------------

describe('dátumszűrő – Europe/Budapest', () => {
  it('a magyar nap kezdete UTC-ben, nyári és téli időszámítással, átállás napján is', () => {
    expect(budapestDayStart('2026-10-02')).toBe('2026-10-01T22:00:00.000Z');  // CEST, UTC+2
    expect(budapestDayStart('2026-12-01')).toBe('2026-11-30T23:00:00.000Z');  // CET, UTC+1
    expect(budapestDayStart('2026-03-29')).toBe('2026-03-28T23:00:00.000Z');  // tavaszi átállás napja
    expect(budapestDayStart('2026-03-29', 1)).toBe('2026-03-29T22:00:00.000Z');
    expect(budapestDayStart('2026-10-25')).toBe('2026-10-24T22:00:00.000Z');  // őszi átállás napja
    expect(budapestDayStart('2026-10-25', 1)).toBe('2026-10-25T23:00:00.000Z');
    expect(budapestDayStart('2026-02-29')).toBeNull();
    expect(budapestDayStart('2026-1-01')).toBeNull();
  });

  it('a magyar éjfél utáni meccs a magyar naphoz tartozik (UTC szerint még az előző nap)', async () => {
    const h = await harness();
    try {
      const k = '2026-09-30T22:30:00.000Z'; // magyar idő: 2026-10-01 00:30
      await h.svc.record(analysis(match('late', k), [{ market: 'O2.5', prob: 0.6 }], iso(Date.parse(k) - 5 * H)));
      await h.start('late', k);
      expect((await h.fresh().query({ from: '2026-10-01', to: '2026-10-01' })).total).toBe(1);
      expect((await h.fresh().query({ from: '2026-09-30', to: '2026-09-30' })).total).toBe(0);
    } finally { await h.close(); }
  });
});

// ---------------------------------------------------------------------------
// 8) Integráció: a VALÓDI AnalysisService + motor minden fogyasztói útja
// ---------------------------------------------------------------------------

describe('integráció az AnalysisService-szel (valódi motor, DEMO adat)', () => {
  function container(demo: DemoMatchDataProvider): Container {
    return {
      data: demo,
      research: new DemoResearchProvider(demo),
      oddsApi: null,
      db: {
        getSetting: async () => null,
        getManualOdds: async () => null,
        getResearch: () => null,
        saveResearch: () => undefined,
      },
    } as unknown as Container;
  }

  it('a mérkőzés-elemzés és a Tippek lista ugyanazon a ponton rögzít; az ismételt kérés nem duplikál', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new SqliteTipArchiveStore(db);
    const demo = new DemoMatchDataProvider();
    const archive = new TipArchiveService(store, demo);
    const svc = new AnalysisService(container(demo), archive);

    const upcoming = (await demo.getMatches({ status: 'scheduled' }))[0];
    expect(upcoming).toBeTruthy();
    const a = await svc.analyze(upcoming.id);
    await svc.archiveIdle();
    expect(a && a.tips.length).toBeGreaterThan(0);
    const r1 = rows(db, `match_id = '${upcoming.id}'`);
    expect(r1.map((x) => x.market).sort()).toEqual(a!.tips.map((t) => t.market).sort());
    for (const x of r1) {
      const tip = a!.tips.find((t) => t.market === x.market)!;
      expect(x.model_prob).toBe(tip.modelProb);
      expect(x.category).toBe(tip.category);
      expect(x.origin).toBe('demo');
      expect(x.engine_version).toBe(ENGINE_VERSION);
    }
    // a jövőbeli meccs állapota rögzült, és nyilvánosan NEM látszik
    expect(db.prepare('SELECT match_status FROM model_tip_archive_match_state WHERE match_id = ?').get(upcoming.id)).toEqual({ match_status: 'scheduled' });
    expect((await archive.query({})).entries.some((e) => e.matchId === upcoming.id)).toBe(false);

    // ugyanaz a meccs újra (cache nélkül) → a motor újra lefut, de nincs új sor
    svc.invalidateAll();
    await svc.analyze(upcoming.id);
    await svc.archiveIdle();
    expect(rows(db, `match_id = '${upcoming.id}'`)).toHaveLength(r1.length);

    // a Tippek lista útja is ide fut be – a nap összes meccse rögzül
    const list = await svc.tipsForDate(new Date(upcoming.kickoff).toLocaleDateString('sv-SE'));
    await svc.archiveIdle();
    const byMatch = new Set(list.map((t) => t.matchId));
    expect(byMatch.size).toBeGreaterThan(0);
    for (const id of byMatch) expect(rows(db, `match_id = '${id}'`).length, id).toBeGreaterThan(0);
  });

  it('az archívum hibája nem dönti el az elemzést, és naplózva diagnosztizálható', async () => {
    const demo = new DemoMatchDataProvider();
    const broken = { record: async () => { throw new Error('nincs tábla'); } };
    const svc = new AnalysisService(container(demo), broken);
    const upcoming = (await demo.getMatches({ status: 'scheduled' }))[0];
    const orig = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      const a = await svc.analyze(upcoming.id);
      await svc.archiveIdle();
      expect(a && a.tips.length).toBeGreaterThan(0);
      expect(logged.some((l) => String(l[0]).includes('[tip-archive]'))).toBe(true);
    } finally { console.error = orig; }
  });

  it('archívum nélkül (régi konstruktor) az AnalysisService változatlanul működik', async () => {
    const demo = new DemoMatchDataProvider();
    const svc = new AnalysisService(container(demo));
    const upcoming = (await demo.getMatches({ status: 'scheduled' }))[0];
    expect((await svc.analyze(upcoming.id))?.tips.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9) Állapotírási hiba utáni helyreállítás (árva sorok)
// ---------------------------------------------------------------------------

describe('állapotírási hiba – helyreállítás', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  /** Tároló-burkoló: a megadott sorszámú observeMatch-hívások elbuknak. */
  function failingObserve(failCalls: number[]) {
    let call = 0;
    const store: TipArchiveStore = new Proxy(h.store, {
      get(t, prop, recv) {
        if (prop === 'observeMatch') {
          return async (o: Parameters<TipArchiveStore['observeMatch']>[0]) => {
            call++;
            if (failCalls.includes(call)) throw new Error('átmeneti állapotírási hiba');
            return t.observeMatch(o);
          };
        }
        const v = Reflect.get(t, prop, recv);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return new TipArchiveService(store, h.data, { now: h.clk.now, settleWaitMs: 2_000 });
  }

  const k = iso(T0.getTime() + H); // 13:00

  it('az ELSŐ állapotírás hibája után nem marad árva sor; a következő számolás rendben rögzít', async () => {
    const svc = failingObserve([1]);
    await expect(svc.record(analysis(match('o1', k), [{ market: 'O2.5', prob: 0.6 }], T0.toISOString()))).rejects.toThrow(/átmeneti/);
    expect(rows(h.db, "match_id = 'o1'")).toHaveLength(0);
    expect(await svc.record(analysis(match('o1', k), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() + 60_000)))).toBe(1);
    expect(await h.store.matchState('o1')).not.toBeNull();
  });

  it('a VÉGSŐ állapotírás hibája után a meccs a frissítés látókörében marad, és egy későbbi frissítés helyreállítja', async () => {
    const svc = failingObserve([2]); // 1.: előzetes állapot (ok), 2.: végső állapot (hiba)
    await expect(svc.record(analysis(match('o2', k), [{ market: 'O2.5', prob: 0.6 }], T0.toISOString()))).rejects.toThrow(/átmeneti/);
    expect(rows(h.db, "match_id = 'o2'")).toHaveLength(1);
    expect((await h.store.matchState('o2'))?.status).toBe('scheduled');
    h.clk.set(T0.getTime() + 4 * H);
    expect((await h.fresh().query({ scope: 'all' })).total, 'még nincs megerősítve').toBe(0);
    h.data.matches.set('o2', match('o2', k, { status: 'finished', homeGoals: 3, awayGoals: 0 }));
    const r = await svc.query({});
    expect(h.data.calls).toContain('o2');
    expect(r.total).toBe(1);
    expect(rows(h.db, "match_id = 'o2'")[0].settlement_status).toBe('won');
  });

  it('állapot nélküli, már archivált (árva) meccs: rejtett, majd a frissítési kör megtalálja és helyreállítja', async () => {
    // pl. régebbi kód vagy félbemaradt írás nyoma: sor van, állapot nincs
    await h.store.insertVersions([draft({ matchId: 'orphan', kickoff: k, generatedAt: T0.toISOString() })]);
    h.clk.set(T0.getTime() + 4 * H);
    expect((await h.fresh().query({})).total).toBe(0); // ismeretlen állapot → rejtett
    h.data.matches.set('orphan', match('orphan', k, { status: 'finished', homeGoals: 0, awayGoals: 2 }));
    h.data.calls = [];
    expect(await h.svc.settleDue(true)).toBe(1);
    expect(h.data.calls).toEqual(['orphan']);
    expect(await h.store.matchState('orphan')).toMatchObject({ status: 'finished', kickoff: k });
    expect((await h.fresh().query({})).total).toBe(1);
  });

  it('az árva meccs ellenőrzése is korlátozott: 15 percen belül nem kérdezzük újra, és körönként legfeljebb 20', async () => {
    for (let i = 0; i < 25; i++) {
      await h.store.insertVersions([draft({ matchId: `orph${String(i).padStart(2, '0')}`, kickoff: k, generatedAt: T0.toISOString() })]);
    }
    h.clk.set(T0.getTime() + 4 * H);
    await h.svc.settleDue(true); // a szolgáltató nem ismeri őket (null)
    expect(h.data.calls).toHaveLength(20);
    h.data.calls = [];
    h.clk.advance(2 * 60_000);
    await h.svc.settleDue(true);
    expect(h.data.calls).toHaveLength(5); // csak a még nem ellenőrzött 5
    h.data.calls = [];
    h.clk.advance(5 * 60_000);
    await h.svc.settleDue(true);
    expect(h.data.calls).toHaveLength(0); // 15 percen belül senki nem kerül újra sorra
  });
});

// ---------------------------------------------------------------------------
// 10) Frissítési kör: kiéheztetés, újraellenőrzési korlát, friss olvasás
// ---------------------------------------------------------------------------

describe('frissítési kör – sorrend és korlátok', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  /** 70 el nem dőlt meccs + egy régebbi, valójában lejátszott „target”. */
  async function seedStarvation(targetObservedAt: string) {
    for (let i = 0; i < 70; i++) {
      await h.store.observeMatch({ matchId: `stuck${i}`, kickoff: iso(T0.getTime() - (i + 1) * H), status: 'scheduled', observedAt: iso(T0.getTime() - 100 * H) });
    }
    await h.store.observeMatch({ matchId: 'target', kickoff: iso(T0.getTime() - 5 * 24 * H), status: 'scheduled', observedAt: targetObservedAt });
    h.data.matches.set('target', match('target', iso(T0.getTime() - 5 * 24 * H), { status: 'finished', homeGoals: 1, awayGoals: 0 }));
  }

  /** `rounds` kör 2 percenként; visszaadja, melyik körben kérdeztük le az egyes meccseket. */
  async function runRounds(rounds: number) {
    const polledAt = new Map<string, number[]>();
    for (let r = 0; r < rounds; r++) {
      h.data.calls = [];
      await h.svc.settleDue();
      for (const id of h.data.calls) polledAt.set(id, [...(polledAt.get(id) ?? []), r]);
      h.clk.advance(2 * 60_000);
    }
    return polledAt;
  }

  it('REGRESSZIÓ (70 meccs): a régi, már lejátszott meccs legkésőbb a 4. körben sorra kerül, és mind a 71 meccs ellenőrződik', async () => {
    await seedStarvation(iso(T0.getTime() - 200 * H));
    // a 70 „beragadt” meccs: elhalasztva (azonos kezdéssel) – az új megfigyelés hátrébb sorolja őket
    for (let i = 0; i < 70; i++) h.data.matches.set(`stuck${i}`, match(`stuck${i}`, iso(T0.getTime() - (i + 1) * H), { status: 'postponed' }));
    const polled = await runRounds(4);
    expect(polled.get('target')?.[0]).toBeLessThanOrEqual(3);
    expect(polled.size).toBe(71);
    expect(await h.store.matchState('target')).toMatchObject({ status: 'finished' });
  });

  it('REGRESSZIÓ (70 meccs, legrosszabb eset): a target megfigyelése a legfrissebb, a többit a szolgáltató nem ismeri (null) – lapozással akkor is sorra kerül', async () => {
    await seedStarvation(iso(T0.getTime() - 50 * H)); // a target a sor VÉGÉN
    const polled = await runRounds(4);
    expect(polled.has('target')).toBe(true);
    expect(polled.get('target')![0]).toBeLessThanOrEqual(3);
    // körönként legfeljebb 20 lekérdezés
    const perRound = [0, 1, 2, 3].map((r) => [...polled.values()].filter((rs) => rs.includes(r)).length);
    for (const n of perRound) expect(n).toBeLessThanOrEqual(20);
  });

  it('a frissen ellenőrzött meccs 15 percen belül nem kerül újra sorra; utána igen', async () => {
    for (let i = 0; i < 5; i++) {
      await h.store.observeMatch({ matchId: `r${i}`, kickoff: iso(T0.getTime() - H), status: 'scheduled', observedAt: iso(T0.getTime() - 2 * H) });
    }
    const polled = await runRounds(9); // 0., 2., …, 16. perc
    for (let i = 0; i < 5; i++) {
      const rs = polled.get(`r${i}`)!;
      expect(rs[0]).toBe(0);
      // a 15. percig (7. kör = 14. perc) nincs újabb lekérdezés, a 16. percben (8. kör) van
      expect(rs.filter((r) => r > 0 && r < 8)).toEqual([]);
      expect(rs).toContain(8);
    }
  });

  it('a régóta nem ellenőrzött meccs elsőbbséget kap a frissen ellenőrzöttel szemben', async () => {
    await h.store.observeMatch({ matchId: 'fresh', kickoff: iso(T0.getTime() - H), status: 'scheduled', observedAt: iso(T0.getTime() - 60_000) });
    await h.store.observeMatch({ matchId: 'old', kickoff: iso(T0.getTime() - H), status: 'scheduled', observedAt: iso(T0.getTime() - 48 * H) });
    expect(await h.store.dueMatchIds(T0.toISOString(), iso(T0.getTime() - 30 * 24 * H), 1)).toEqual(['old']);
  });

  it('ha a szolgáltatónak van gyorsítótár-megkerülő olvasása, a frissítés azt használja (nem a memóriabeli getMatch-et)', async () => {
    const k = iso(T0.getTime() - H);
    await h.store.insertVersions([draft({ matchId: 'fr', kickoff: k, generatedAt: iso(T0.getTime() - 5 * H) })]);
    await h.store.observeMatch({ matchId: 'fr', kickoff: k, status: 'scheduled', observedAt: iso(T0.getTime() - 3 * H) });
    const reads: string[] = [];
    const provider = {
      origin: 'live' as const,
      getMatch: async () => match('fr', k, { status: 'scheduled' }),            // elavult memóriabeli objektum
      getMatchFresh: async (id: string) => { reads.push(id); return match('fr', k, { status: 'live' }); },
    };
    const svc = new TipArchiveService(h.store, provider, { now: h.clk.now });
    expect(svc.refreshSource).toBe('fresh');
    expect(new TipArchiveService(h.store, h.data, { now: h.clk.now }).refreshSource).toBe('cached');
    const r = await svc.query({});
    expect(reads).toEqual(['fr']);
    expect(r.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11) ESPN: a friss olvasás nem írja a közös memóriabeli térképet
// ---------------------------------------------------------------------------

describe('ESPN getMatchFresh', () => {
  const summary = (state: string, completed: boolean, hs: number, as: number) => ({
    header: {
      competitions: [{
        date: '2026-10-01T13:00Z',
        status: { type: { state, completed, name: completed ? 'STATUS_FULL_TIME' : 'STATUS_SCHEDULED' } },
        competitors: [
          { homeAway: 'home', team: { id: '1', displayName: 'Arsenal' }, score: String(hs) },
          { homeAway: 'away', team: { id: '2', displayName: 'Chelsea' }, score: String(as) },
        ],
      }],
    },
  });

  it('friss állapotot ad, de a getMatch (más fogyasztók) továbbra is a korábbi objektumot látja; ugyanazt az 5 perces HTTP-utat használja', async () => {
    const espn = new EspnProvider();
    const paths: { path: string; ttl: number }[] = [];
    let current = summary('pre', false, 0, 0);
    (espn as unknown as { call: (p: string, t: number) => Promise<unknown> }).call = async (path: string, ttl: number) => {
      paths.push({ path, ttl });
      return current;
    };
    const id = 'espn-eng.1-12345';
    const cached = await espn.getMatch(id);
    expect(cached?.status).toBe('scheduled');
    current = summary('post', true, 2, 1);
    expect((await espn.getMatch(id))?.status).toBe('scheduled'); // memóriabeli térkép: elavult
    const fresh = await espn.getMatchFresh(id);
    expect(fresh).toMatchObject({ status: 'finished', homeGoals: 2, awayGoals: 1 });
    expect((await espn.getMatch(id))?.status).toBe('scheduled'); // a közös térkép változatlan
    expect(paths.every((p) => p.path === 'eng.1/summary?event=12345' && p.ttl === 5 * 60_000)).toBe(true);
    expect(await espn.getMatchFresh('nem-espn-id')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12) Megfigyelések időrendje és ellentmondásai
// ---------------------------------------------------------------------------

describe('megfigyelések – elavult és ellentmondó adat', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  it('REGRESSZIÓ (két példány): live → később kiolvasott, régi „scheduled” nem írja felül, a meccs látható marad', async () => {
    const k = iso(T0.getTime() - 2 * H);
    const b = new TipArchiveService(h.store, { origin: 'live', getMatch: async () => null }, { now: () => new Date(T0.getTime()) });
    await b.record(analysis(match('m2', k, { status: 'live' }), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - 5 * H)));
    await b.observe(match('m2', k, { status: 'live' }));
    // A példány: elavult memóriacache (még „scheduled”), de a frissítés 12:20-kor fut
    const aNow = () => new Date(T0.getTime() + 20 * 60_000);
    const a = new TipArchiveService(h.store, { origin: 'live', getMatch: async () => match('m2', k, { status: 'scheduled' }) }, { now: aNow, settleWaitMs: 1000 });
    expect((await b.query({})).total).toBe(1);
    await a.settleDue(true);
    expect(a.rejectedObservations).toBe(1);
    expect(await h.store.matchState('m2')).toMatchObject({ status: 'live' });
    expect((await new TipArchiveService(h.store, h.data, { now: aNow }).query({})).total).toBe(1);
  });

  it('ellentmondó, nyilvánosságot okozó megfigyelés (régi kezdés + live) nem teszi nyilvánossá az átütemezett meccset', async () => {
    const oldK = iso(T0.getTime() - H);
    const newK = iso(T0.getTime() + 48 * H);
    await h.svc.record(analysis(match('cx', oldK), [{ market: 'O2.5', prob: 0.6 }], iso(T0.getTime() - 3 * H)));
    await h.svc.observe(match('cx', newK, { status: 'scheduled' }), iso(T0.getTime() + 30 * 60_000));
    h.clk.set(T0.getTime() + H);
    // elavult cache: a régi kezdéssel „live”-ot mond
    expect(await h.svc.observe(match('cx', oldK, { status: 'live' }))).toBe(0);
    expect(await h.store.matchState('cx')).toMatchObject({ status: 'scheduled', kickoff: newK });
    expect((await h.fresh().query({})).total).toBe(0);
    // a lejátszott meccs elavult „finished”-e sem számol el
    expect(await h.svc.observe(match('cx', oldK, { status: 'finished', homeGoals: 1, awayGoals: 0 }))).toBe(0);
    expect(rows(h.db, "match_id = 'cx'")[0].settlement_status).toBe('pending');
  });

  it('decideObservation – szabálytábla', () => {
    const now = new Date(T0);
    const o = (status: ObservedStatus, kickoff: string, observedAt = T0.toISOString()) => ({ matchId: 'x', status, kickoff, observedAt });
    const past = iso(T0.getTime() - H);
    const future = iso(T0.getTime() + H);
    const later = iso(T0.getTime() + 60_000);
    expect(decideObservation(null, o('live', past), now).accept).toBe(true);
    expect(decideObservation(o('live', past), o('scheduled', past, later), now).accept).toBe(false);   // visszalépés
    expect(decideObservation(o('finished', past), o('live', past, later), now).accept).toBe(false);    // lejátszott terminális
    expect(decideObservation(o('scheduled', past), o('live', past, later), now).accept).toBe(true);    // előrehaladás
    expect(decideObservation(o('live', past), o('postponed', past, later), now).accept).toBe(true);    // rejt
    expect(decideObservation(o('postponed', past), o('scheduled', past, later), now).accept).toBe(true);
    expect(decideObservation(o('live', past, later), o('finished', past), now).accept).toBe(false);    // régebben olvasott
    expect(decideObservation(o('scheduled', future), o('live', past, later), now).accept).toBe(false); // ellentmondás
    expect(decideObservation(o('scheduled', past), o('scheduled', future, later), now).accept).toBe(true); // átütemezés (rejt)
    expect(decideObservation(o('live', past), o('finished', iso(T0.getTime() - 2 * H), later), now).accept).toBe(true); // mindkét kezdés múlt
  });
});

// ---------------------------------------------------------------------------
// 13) A → B → A két példány között, determinisztikusan
// ---------------------------------------------------------------------------

describe('verziózás – két példány közötti versenyhelyzet', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });
  afterEach(async () => { await h.close(); });

  /** X példány tárolója: az ELSŐ latestVersions-olvasás után a másik példány (Y) beszúr. */
  function racingStore(onFirstRead: () => Promise<unknown>) {
    let once = true;
    return new Proxy(h.store, {
      get(t, prop, recv) {
        if (prop === 'latestVersions') {
          return async (id: string) => {
            const res = await t.latestVersions(id);
            if (once) { once = false; await onFirstRead(); }
            return res;
          };
        }
        const v = Reflect.get(t, prop, recv);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as TipArchiveStore;
  }

  const m = () => match('m3', iso(T0.getTime() + 6 * H));

  it('REGRESSZIÓ: X beolvassa (A), közben Y beszúrja B-t, X legfrissebb kimenete A → v3 = A rögzül', async () => {
    const y = h.fresh();
    await y.record(analysis(m(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()));             // v1 = A
    const x = new TipArchiveService(racingStore(() => y.record(analysis(m(), [{ market: 'O2.5', prob: 0.65 }], iso(T0.getTime() + 60_000)))), h.data, { now: h.clk.now });
    expect(await x.record(analysis(m(), [{ market: 'O2.5', prob: 0.61 }], iso(T0.getTime() + 120_000)))).toBe(1);
    expect(rows(h.db, "match_id = 'm3'").map((r) => [r.version_no, r.model_prob])).toEqual([[1, 0.61], [2, 0.65], [3, 0.61]]);
    // a számító (kezdés előtti, legkésőbb generált) verzió X A-ja
    h.clk.set(T0.getTime() + 8 * H);
    await h.svc.observe(match('m3', iso(T0.getTime() + 6 * H), { status: 'live' }));
    const counted = await h.fresh().query({ scope: 'counted' });
    expect(counted.entries.map((e) => [e.versionNo, e.modelProb])).toEqual([[3, 0.61]]);
  });

  it('ha a közben beszúrt idegen verzió a FRISSEBB számolás, X nem írja felül a régebbi kimenetével', async () => {
    const y = h.fresh();
    await y.record(analysis(m(), [{ market: 'O2.5', prob: 0.61 }], T0.toISOString()));             // v1 = A
    const x = new TipArchiveService(racingStore(() => y.record(analysis(m(), [{ market: 'O2.5', prob: 0.65 }], iso(T0.getTime() + 300_000)))), h.data, { now: h.clk.now });
    expect(await x.record(analysis(m(), [{ market: 'O2.5', prob: 0.61 }], iso(T0.getTime() + 120_000)))).toBe(0);
    expect(rows(h.db, "match_id = 'm3'").map((r) => [r.version_no, r.model_prob])).toEqual([[1, 0.61], [2, 0.65]]);
  });
});

// ---------------------------------------------------------------------------
// 14) Naplózás: percenkénti korlát mellett a kihagyott hibák száma sem vész el
// ---------------------------------------------------------------------------

describe('archívum-írási hibák számlálója', () => {
  it('egy percen belül egy naplósor, a többi hiba számolva; a következő sor kiírja a kihagyottakat', async () => {
    let fail = true;
    const archive = { record: async () => { if (fail) throw new Error('nincs tábla'); return 0; } };
    const svc = new AnalysisService({} as Container, archive);
    const rec = (svc as unknown as { recordInArchive: (a: MatchAnalysis) => void }).recordInArchive.bind(svc);
    const a = analysis(match('lg', iso(T0.getTime() + H)), [{ market: 'O2.5', prob: 0.6 }], T0.toISOString());
    let clockMs = Date.parse('2026-10-01T12:00:00Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clockMs);
    const errors: string[] = [];
    const warns: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...x: unknown[]) => { errors.push(x.map(String).join(' ')); });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...x: unknown[]) => { warns.push(x.map(String).join(' ')); });
    try {
      for (let i = 0; i < 3; i++) { rec(a); await svc.archiveIdle(); clockMs += 1000; }
      expect(errors).toHaveLength(1);
      expect(svc.archiveFailureStats()).toMatchObject({ total: 3, suppressed: 2, lastMessage: 'nincs tábla' });
      // egy perc múlva újabb hiba: a sor kiírja a 2 kihagyottat
      clockMs += 60_000;
      rec(a); await svc.archiveIdle();
      expect(errors).toHaveLength(2);
      expect(errors[1]).toMatch(/\+2 kihagyott hiba.*összesen 4/);
      // újabb kihagyott hiba, majd siker egy perc múlva → összegző sor
      clockMs += 1000;
      rec(a); await svc.archiveIdle();
      expect(svc.archiveFailureStats().suppressed).toBe(1);
      fail = false;
      clockMs += 60_000;
      rec(a); await svc.archiveIdle();
      expect(warns.some((w) => /1 rögzítési hiba nem került külön naplóba \(összesen 5/.test(w))).toBe(true);
      expect(svc.archiveFailureStats().suppressed).toBe(0);
      // a számláló nem tárol tipp-tartalmat vagy azonosítót a hibaüzeneten túl
      expect(Object.keys(svc.archiveFailureStats()).sort()).toEqual(['lastAt', 'lastMessage', 'suppressed', 'total']);
    } finally {
      nowSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore();
    }
  });
});
