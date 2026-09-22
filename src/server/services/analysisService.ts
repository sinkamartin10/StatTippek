/**
 * Elemzési szolgáltatás: összegyűjti egy mérkőzés adatait (adatszolgáltató + kutatómotor + odds),
 * lefuttatja az elemzőmotort és cache-eli az eredményt.
 */
import type { Match, MatchAnalysis, MatchOdds, PredictionRecord, SlipBuildResponse, SlipLeg, SlipRecord, SlipStrategy, TipListEntry } from '../../shared/types';
import { buildSlips, type SlipBuildOptions } from '../../shared/engine/slips';
import { analyzeMatch } from '../../shared/engine/analysis';
import { marketLabel } from '../../shared/engine/markets';
import { randomUUID } from 'node:crypto';
import type { Container } from '../container';

const RESEARCH_TTL_MS = 30 * 60_000;
const ANALYSIS_TTL_MS = 5 * 60_000;

export class AnalysisService {
  private cache = new Map<string, { at: number; value: MatchAnalysis }>();
  /** párhuzamos kérések ugyanarra a meccsre egyetlen számítást indítanak */
  private inflight = new Map<string, Promise<MatchAnalysis | null>>();

  constructor(private c: Container) {}

  invalidateAll() { this.cache.clear(); }

  invalidate(matchId: string) {
    for (const k of [...this.cache.keys()]) if (k.startsWith(matchId + '|')) this.cache.delete(k);
  }

  async modelOptions() {
    // Opcionális beállítás: ha a tartós tároló épp nem elérhető, az alapértelmezéssel megyünk tovább
    // (a mérkőzés-elemzés ne dőljön el egy nem kritikus olvasás miatt) – a hibát naplózzuk.
    let raw: string | null = null;
    try { raw = await this.c.db.getSetting('shrinkageK'); } catch (e) { this.warnOnce('getSetting', e as Error); }
    const k = parseFloat(raw ?? '3');
    return { shrinkageK: Number.isFinite(k) && k >= 0 ? k : 3 };
  }

  /** Ugyanazt a tároló-hibát nem naplózzuk percenként többször. */
  private warned = new Map<string, number>();
  private warnOnce(op: string, e: Error) {
    const last = this.warned.get(op) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.warned.set(op, Date.now());
    console.error(`[db] a(z) "${op}" olvasás sikertelen, alapértelmezéssel folytatjuk:`, e.message);
  }

  async resolveOdds(match: Match): Promise<MatchOdds | null> {
    // Sorrend: kézi bevitel > több-irodás odds API (ha van kulcs) > az adatszolgáltató által közölt odds.
    // Az odds API és a szolgáltató piacai összefésülhetők (piaconként feljegyezzük az irodát) – odds-ot sosem találunk ki.
    let manual: MatchOdds | null = null;
    try { manual = await this.c.db.getManualOdds(match.id); } catch (e) { this.warnOnce('getManualOdds', e as Error); }
    if (manual) return manual;
    const base = await this.c.data.getOdds(match.id);
    if (!this.c.oddsApi) return base;
    const [leagues, home, away] = await Promise.all([this.c.data.getLeagues(), this.c.data.getTeam(match.homeTeamId), this.c.data.getTeam(match.awayTeamId)]);
    const league = leagues.find((l) => l.id === match.leagueId);
    if (!league || !home || !away) return base;
    const api = await this.c.oddsApi.getOdds(match, league, home, away);
    if (!api) return base;
    if (!base) return api;
    const markets = { ...base.markets };
    const bookmakers: Record<string, string> = Object.fromEntries(Object.keys(base.markets).map((k) => [k, base.bookmaker ?? base.source]));
    for (const [k, v] of Object.entries(api.markets)) {
      if (!markets[k] || v > markets[k]) { markets[k] = v; bookmakers[k] = api.bookmakers?.[k] ?? 'The Odds API'; }
    }
    return { matchId: match.id, source: 'live', bookmaker: `legjobb elérhető odds (${api.bookmaker}; ${base.bookmaker ?? base.source})`, retrievedAt: new Date().toISOString(), markets, bookmakers };
  }

  async getResearch(match: Match, force = false) {
    if (!force) {
      const cached = this.c.db.getResearch(match.id, RESEARCH_TTL_MS);
      if (cached && cached.origin === match.origin) return cached;
    }
    const [league, homeTeam, awayTeam] = await Promise.all([
      this.c.data.getLeagues().then((ls) => ls.find((l) => l.id === match.leagueId)!),
      this.c.data.getTeam(match.homeTeamId),
      this.c.data.getTeam(match.awayTeamId),
    ]);
    if (!league || !homeTeam || !awayTeam) throw new Error('Hiányzó csapat- vagy bajnokságadat');
    const r = await this.c.research.research({ match, league, homeTeam, awayTeam });
    this.c.db.saveResearch(r);
    return r;
  }

  async analyze(matchId: string, opts: { forceResearch?: boolean } = {}): Promise<MatchAnalysis | null> {
    const running = this.inflight.get(matchId);
    if (running && !opts.forceResearch) return running;
    const p = this.analyzeInner(matchId, opts).finally(() => this.inflight.delete(matchId));
    this.inflight.set(matchId, p);
    return p;
  }

  private async analyzeInner(matchId: string, opts: { forceResearch?: boolean }): Promise<MatchAnalysis | null> {
    const match = await this.c.data.getMatch(matchId);
    if (!match) return null;
    const odds = await this.resolveOdds(match);
    const key = `${matchId}|${JSON.stringify(odds?.markets ?? {})}`;
    const hit = this.cache.get(key);
    if (hit && !opts.forceResearch && Date.now() - hit.at < ANALYSIS_TTL_MS) return hit.value;

    const [leagues, homeTeam, awayTeam, results, research, modelOptions, seasonStart] = await Promise.all([
      this.c.data.getLeagues(),
      this.c.data.getTeam(match.homeTeamId),
      this.c.data.getTeam(match.awayTeamId),
      this.c.data.getResultsForAnalysis(match),
      this.getResearch(match, opts.forceResearch),
      this.modelOptions(),
      this.c.data.getSeasonStart?.(match.leagueId),
    ]);
    const league = leagues.find((l) => l.id === match.leagueId);
    if (!league || !homeTeam || !awayTeam) return null;

    const analysis = analyzeMatch({ match, league, homeTeam, awayTeam, results, odds, research, now: new Date().toISOString(), modelOptions, seasonStart });
    this.cache.set(key, { at: Date.now(), value: analysis });
    return analysis;
  }

  /** "Mai tippek": minden, a napon még le nem játszott meccs tippjei. */
  async tipsForDate(date: string): Promise<TipListEntry[]> {
    const matches = await this.c.data.getMatches({ date, status: 'scheduled' });
    const analyses = await this.analyzeMany(matches);
    const out: TipListEntry[] = [];
    matches.forEach((m, i) => {
      const a = analyses[i];
      if (!a || !a.poisson) return;
      for (const tip of a.tips) {
        out.push({
          tip, matchId: m.id, matchLabel: `${a.homeTeam.name} – ${a.awayTeam.name}`, kickoff: m.kickoff,
          leagueId: a.league.id, leagueName: a.league.name, dataQuality: a.dataQuality, origin: a.origin,
        });
      }
    });
    return out;
  }

  /** Több meccs elemzése párhuzamosan (legfeljebb 3 egyszerre). */
  private async analyzeMany(matches: Match[]): Promise<(MatchAnalysis | null)[]> {
    const out: (MatchAnalysis | null)[] = new Array(matches.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < matches.length) {
        const i = next++;
        try { out[i] = await this.analyze(matches[i].id); } catch (e) { console.error('[analyze]', matches[i].id, (e as Error).message); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, matches.length) }, worker));
    return out;
  }

  /**
   * Szelvényépítés egy időszak még le nem játszott meccseiből: csak valódi oddsszal rendelkező lábak kerülnek szóba.
   * Legfeljebb 60 meccset elemzünk (kezdési idő szerint), hogy az első betöltés is belátható ideig tartson.
   */
  async buildSlips(from: string, to: string, opts: SlipBuildOptions): Promise<SlipBuildResponse> {
    const matches = (await this.c.data.getMatches({ from, to, status: 'scheduled' })).slice(0, 60);
    const analyses = await this.analyzeMany(matches);
    const legs: SlipLeg[] = [];
    let withOdds = 0;
    analyses.forEach((a, i) => {
      if (!a || !a.poisson) return;
      if (a.odds && Object.keys(a.odds.markets).length) withOdds++;
      for (const t of a.tips) {
        if (t.odds == null || t.impliedProb == null || t.diffPoints == null) continue;
        legs.push({
          matchId: matches[i].id, matchLabel: `${a.homeTeam.name} – ${a.awayTeam.name}`, leagueName: a.league.name, kickoff: matches[i].kickoff,
          market: t.market, label: t.label, modelProb: t.modelProb, odds: t.odds, bookmaker: a.odds?.bookmakers?.[t.market] ?? a.odds?.bookmaker ?? null,
          impliedProb: t.impliedProb, diffPoints: t.diffPoints, category: t.category, supportingIndicators: t.supportingIndicators, dataQuality: a.dataQuality.level,
        });
      }
    });
    const slips = buildSlips(legs, opts);
    const notes: string[] = [];
    if (matches.length === 0) notes.push('Nincs még le nem játszott mérkőzés a megadott időszakban.');
    if (withOdds === 0 && matches.length) notes.push('Egyik mérkőzéshez sem érhető el odds – szelvény nem építhető. Odds kézzel is megadható a mérkőzés oldalán.');
    if (slips.length === 0 && legs.length) notes.push('A megadott feltételekkel (lábszám, összodds, láb-valószínűség) nem áll össze szelvény – lazíts a szűrőkön.');
    return { from, to, matchesAnalyzed: analyses.filter(Boolean).length, matchesWithOdds: withOdds, candidateLegs: legs.length, slips, notes };
  }

  /**
   * Szelvény mentése a HITELESÍTETT felhasználó nevében: minden láb tippként rögzül (ha még nincs),
   * a szelvény a lábak (predictions) azonosítóit tárolja.
   */
  async saveSlip(userId: string, strategy: SlipStrategy, label: string, legs: { matchId: string; market: string }[]): Promise<SlipRecord | null> {
    const ids: string[] = [];
    let totalOdds = 1, jointProb = 1;
    for (const leg of legs) {
      let rec = await this.c.db.getPredictionByMarket(userId, leg.matchId, leg.market);
      if (!rec) rec = await this.savePrediction(userId, leg.matchId, leg.market, 'manuális');
      if (!rec) return null;
      // Odds nélküli láb nem kerülhet szelvényre: az összodds értelmezhetetlen lenne (és az adatbázis is elutasítja)
      if (rec.odds == null || !(rec.odds > 1)) return null;
      ids.push(rec.id);
      totalOdds *= rec.odds;
      jointProb *= rec.modelProb;
    }
    const rec = {
      id: randomUUID(),
      userId,
      createdAt: new Date().toISOString(),
      strategy,
      label,
      legPredictionIds: ids,
      totalOdds: Math.round(totalOdds * 100) / 100,
      jointProb,
      origin: this.c.data.origin,
    };
    await this.c.db.saveSlip(rec);
    return (await this.c.db.listSlips(userId)).find((s) => s.id === rec.id) ?? null;
  }

  /** Tipp mentése a HITELESÍTETT felhasználó előzményeihez. Ugyanarra a meccsre és piacra csak egyszer. */
  async savePrediction(userId: string, matchId: string, market: string, predictionType: 'modell' | 'manuális' = 'modell'): Promise<PredictionRecord | null> {
    const a = await this.analyze(matchId);
    if (!a || !a.poisson) return null;
    const already = await this.c.db.getPredictionByMarket(userId, matchId, market);
    if (already) return null;
    const tip = a.tips.find((t) => t.market === market);
    const { marketProbability } = await import('../../shared/engine/models');
    const prob = tip?.modelProb ?? marketProbability(a.poisson, market);
    if (prob == null) return null;
    const draft = {
      userId,
      createdAt: new Date().toISOString(),
      matchId,
      matchLabel: `${a.homeTeam.name} – ${a.awayTeam.name}`,
      kickoff: a.match.kickoff,
      leagueId: a.league.id,
      leagueName: a.league.name,
      market,
      marketLabel: marketLabel(market),
      modelProb: prob,
      odds: a.odds?.markets[market] ?? null,
      category: tip?.category ?? 'mérsékelt',
      predictionType,
      origin: a.origin,
    };
    const rec = await this.c.db.savePrediction(draft);
    // Már lejátszott meccs: azonnal lezárjuk a valós eredménnyel
    if (a.match.status === 'finished' && a.match.homeGoals != null && a.match.awayGoals != null) {
      return (await this.c.db.settlePrediction(userId, rec.id, a.match.homeGoals, a.match.awayGoals)) ?? rec;
    }
    return rec;
  }

  /** A HITELESÍTETT felhasználó függőben lévő tippjeinek lezárása a lejátszott meccsek végeredményével. */
  async settlePending(userId: string): Promise<number> {
    let n = 0;
    for (const p of await this.c.db.pendingPredictions(userId)) {
      const m = await this.c.data.getMatch(p.matchId);
      if (m && m.status === 'finished' && m.homeGoals != null && m.awayGoals != null) {
        const settled = await this.c.db.settlePrediction(userId, p.id, m.homeGoals, m.awayGoals);
        if (settled) n++;
      }
    }
    return n;
  }

  /**
   * DEMO előzmények feltöltése: az utolsó két lejátszott demo forduló meccseire lefuttatjuk a modellt
   * (csak a meccs ELŐTTI adatokból – az elemzőmotor a lejátszott meccseknél automatikusan így szűr),
   * elmentjük a konzervatív és mérsékelt kategória első tippjét, majd a valós demo eredménnyel lezárjuk.
   * Így az előzmény-oldal őszinte, nyerő és vesztes tippeket egyaránt mutat.
   */
  async seedDemoHistory(userId: string): Promise<number> {
    if (this.c.data.origin !== 'demo') return 0;
    if ((await this.c.db.getSetting('demoHistorySeeded')) === 'v1') return 0;
    const from = new Date(Date.now() - 15 * 86400000);
    const p = (n: number) => String(n).padStart(2, '0');
    const key = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const matches = await this.c.data.getMatches({ from: key(from), to: key(new Date()), status: 'finished' });
    let n = 0;
    for (const m of matches) {
      const odds = await this.c.data.getOdds(m.id);
      if (!odds) continue;
      const a = await this.analyze(m.id);
      if (!a || !a.poisson) continue;
      const picks = ['konzervatív', 'mérsékelt'].map((cat) => a.tips.find((t) => t.category === cat)).filter(Boolean);
      for (const tip of picks) {
        const saved = await this.savePrediction(userId, m.id, tip!.market, 'modell');
        if (saved) n++;
      }
    }
    await this.c.db.setSetting('demoHistorySeeded', 'v1');
    return n;
  }
}
