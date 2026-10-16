/**
 * Edge Radar – belső szolgáltatási réteg (2. fázis). NINCS API-hoz vagy felülethez kötve, nem tárol,
 * nem indít új külső hívást: a meglévő `analyze` (elemzés + cache) és `resolveOdds` útvonalat használja.
 *
 * Egy sor = egy mérkőzés egy oddsszal rendelkező piaca. Minden kizárt sor megmarad diagnosztikának,
 * kizárási okkal – érvényes `edgePp` nélkül. EV-t NEM számol és nem ad ki (a kalibráció nem igazolt).
 *
 * `edgePp` = (modell-valószínűség − árrésmentesített piaci valószínűség) × 100, és CSAK akkor, ha:
 *  - a piac explicit módon le van képezve egy teljes kimenetelkészletre (1X2, azonos vonalú O/U);
 *  - az árrésmentesítés a szigorú feltételekkel lefutott (quoteFrom + devig1x2/devigTwoWay);
 *  - az odds friss, a meccs tervezett és még nem kezdődött el (checkFreshness);
 *  - az elemzés UGYANAHHOZ a meccshez és UGYANAHHOZ az odds-állapothoz készült, mint az aktuális
 *    feloldott odds (meccsazonosító, forrás, iroda, megfigyelési idő, piacok és árak egyeznek).
 * A jogosultságról a szolgáltatás NEM dönt: a `variant`-ot a hívó adja (FREE: 'base', PRO: 'pro').
 */
import type { Match, MatchAnalysis, MatchOdds, OddsObservation } from '../../shared/types';
import { checkFreshness, devig1x2, devigTwoWay, quoteFrom, rawImplied, type EdgeReason } from '../../shared/engine/edge';

export type EdgeVariant = 'base' | 'pro';

/** A szolgáltatás függőségei – élesben a container.data és az AnalysisService meglévő metódusai. */
export interface EdgeDeps {
  getMatches(q: { date: string }): Promise<Match[]>;
  analyze(matchId: string, opts: { variant: EdgeVariant }): Promise<MatchAnalysis | null>;
  resolveOdds(match: Match): Promise<MatchOdds | null>;
}

export type EdgeExcludeReason =
  | EdgeReason
  | 'analysis_unavailable' | 'match_mismatch' | 'analysis_odds_mismatch' | 'model_prob_missing' | 'market_not_mapped';

/** Explicit piac → kimenetelkészlet leképezés. Ami nincs itt, arra nem számolunk edge-et. */
type Mapping = { group: '1x2'; outcome: 'home' | 'draw' | 'away' } | { group: 'ou'; outcome: 'over' | 'under'; line: number };
export function mapMarket(market: string): Mapping | null {
  if (market === '1') return { group: '1x2', outcome: 'home' };
  if (market === 'X') return { group: '1x2', outcome: 'draw' };
  if (market === '2') return { group: '1x2', outcome: 'away' };
  const m = market.match(/^([OU])(\d\.5)$/);
  if (m) return { group: 'ou', outcome: m[1] === 'O' ? 'over' : 'under', line: Number(m[2]) };
  return null;
}

export interface EdgeRow {
  matchId: string;
  kickoff: string;
  leagueId: string;
  /** a mérkőzés állapota a feldolgozáskor */
  matchStatus: Match['status'];
  market: string;
  /** a leképezett kimenetel (pl. '1x2:home', 'ou2.5:over'); nem leképezett piacnál null */
  outcome: string | null;
  odds: number;
  /** igazolt iroda – csak egyirodás, igazolt eredetű megfigyelésnél; egyébként null */
  bookmaker: string | null;
  /** a forrás (megfigyelés útja); kézi / összefésült / eredet nélküli oddsnál `unverified:<MatchOdds.source>` */
  source: OddsObservation['via'] | `unverified:${MatchOdds['source']}`;
  observedAt: string | null;
  /** a megfigyelés kora a `now`-hoz képest (ms); ismeretlen megfigyelésnél null */
  ageMs: number | null;
  rawImplied: number | null;
  /** árrésmentesített valószínűség – közelítés (arányos normalizálás), nem a „valódi” piaci valószínűség */
  devig: number | null;
  devigReason: EdgeReason | 'market_not_mapped' | null;
  modelProb: number | null;
  /** (modell − árrésmentes) százalékpontban; null, ha bármely feltétel nem igazolható */
  edgePp: number | null;
  modelId: string | null;
  excluded: boolean;
  excludeReason: EdgeExcludeReason | null;
}

export interface EdgeOptions {
  /** a megfigyelés legnagyobb elfogadott kora (alapból 60 perc) */
  maxAgeMs?: number;
  /** egyszerre legfeljebb ennyi meccs elemzése (alapból 3, mint a meglévő analyzeMany) */
  concurrency?: number;
}

/** Ugyanaz-e a két odds-állapot: azonosító, forrás, iroda, megfigyelési idő, piacok és árak. */
export function sameOddsState(a: MatchOdds | null, b: MatchOdds | null): boolean {
  if (!a || !b) return false;
  if (a.matchId !== b.matchId || a.source !== b.source || (a.bookmaker ?? null) !== (b.bookmaker ?? null)) return false;
  if ((a.observedAt ?? null) !== (b.observedAt ?? null)) return false;
  const ka = Object.keys(a.markets).sort(), kb = Object.keys(b.markets).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a.markets[k] === b.markets[k]);
}

const ORDER = ['1', 'X', '2'];
const marketOrder = (m: string) => { const i = ORDER.indexOf(m); return i >= 0 ? `0${i}` : `1${m}`; };

export class EdgeService {
  constructor(private deps: EdgeDeps, private opts: EdgeOptions = {}) {}

  /** A nap (helyi dátum, YYYY-MM-DD) összes oddsszal rendelkező piaca, determinisztikus sorrendben. */
  async buildEdgeRows(date: string, variant: EdgeVariant, now: string | number | Date): Promise<EdgeRow[]> {
    return (await this.buildEdgeResult(date, variant, now)).rows;
  }

  /**
   * Mint a `buildEdgeRows`, de a meccsenkénti számítási hibákat NEM nyeli le csendben: a hibás
   * meccsek azonosítója a `failedMatchIds`-ben (üzenet nélkül – az csak a szervernaplóba kerül).
   * A meccslista lekérésének hibája kivételként továbbmegy.
   */
  async buildEdgeResult(date: string, variant: EdgeVariant, now: string | number | Date): Promise<{ rows: EdgeRow[]; matchCount: number; failedMatchIds: string[] }> {
    const matches = await this.deps.getMatches({ date });
    const out: EdgeRow[][] = new Array(matches.length).fill(null).map(() => []);
    const failed: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < matches.length) {
        const i = next++;
        try { out[i] = await this.rowsForMatch(matches[i], variant, now); }
        catch (e) { console.error('[edge]', matches[i].id, (e as Error).message); out[i] = []; failed.push(matches[i].id); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 3, matches.length) }, worker));
    const rows = out.flat().sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.matchId.localeCompare(b.matchId) || marketOrder(a.market).localeCompare(marketOrder(b.market)));
    return { rows, matchCount: matches.length, failedMatchIds: failed.sort() };
  }

  /** Egy mérkőzés sorai. Oddsszal nem rendelkező mérkőzés nem ad sort. */
  async rowsForMatch(match: Match, variant: EdgeVariant, now: string | number | Date): Promise<EdgeRow[]> {
    const odds = await this.deps.resolveOdds(match);
    if (!odds || !Object.keys(odds.markets).length) return [];

    const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
    const fresh = checkFreshness({ observedAt: odds.observedAt, observedStatus: odds.observation?.matchStatus, matchStatus: match.status, kickoff: match.kickoff, now: nowMs, maxAgeMs: this.opts.maxAgeMs });
    const observedMs = odds.observedAt ? Date.parse(odds.observedAt) : NaN;
    // jövőbeli megfigyelésnek nincs értelmes kora (a sor úgyis kizárt: observed_in_future)
    const ageMs = Number.isFinite(observedMs) && Number.isFinite(nowMs) && nowMs >= observedMs ? nowMs - observedMs : null;

    // Elemzés CSAK akkor, ha edge egyáltalán lehetséges (friss, kezdés előtti odds). Különben fölösleges
    // számítás lenne – és az elemzés a kutatási rétegen át külső hívásokat indíthat (pl. befejezett meccsre).
    const analysis = fresh.ok ? await this.deps.analyze(match.id, { variant }) : null;

    // elemzés-szintű feltételek (minden sorra azonosak); frissességi hibánál az az elsődleges ok
    let analysisIssue: EdgeExcludeReason | null = null;
    if (!fresh.ok) analysisIssue = null;
    else if (!analysis) analysisIssue = 'analysis_unavailable';
    else if (analysis.match.id !== match.id || odds.matchId !== match.id) analysisIssue = 'match_mismatch';
    else if (!sameOddsState(analysis.odds, odds)) analysisIssue = 'analysis_odds_mismatch'; // pl. cache-elt elemzés régebbi odds-szal

    // árrésmentesítés kimenetelkészletenként (a szigorú 1. fázisú feltételekkel)
    const q = (m: string) => quoteFrom(odds, m);
    const x12 = devig1x2({ home: q('1'), draw: q('X'), away: q('2') });
    const ouCache = new Map<number, ReturnType<typeof devigTwoWay>>();
    const ou = (line: number) => {
      if (!ouCache.has(line)) {
        const o = q(`O${line}`), u = q(`U${line}`);
        ouCache.set(line, devigTwoWay({ over: o && { ...o, line }, under: u && { ...u, line } }));
      }
      return ouCache.get(line)!;
    };
    // a megfigyelés útja, ha az odds hordozza; kézi / összefésült / eredet nélküli odds → unverified:<source>
    // (piaconként az igazoltságot a `bookmaker` mutatja: null = nem igazolt)
    const source: EdgeRow['source'] = odds.observation ? odds.observation.via : `unverified:${odds.source}`;

    return Object.keys(odds.markets).map((market): EdgeRow => {
      const price = odds.markets[market];
      const map = mapMarket(market);
      let devig: number | null = null;
      let devigReason: EdgeRow['devigReason'] = null;
      if (!map) devigReason = 'market_not_mapped';
      else {
        const r = map.group === '1x2' ? x12 : ou(map.line);
        if (r.ok) devig = (r.probs as Record<string, number>)[map.outcome];
        else devigReason = r.reason;
      }
      // modell-valószínűség: ugyanannak az elemzésnek a computeValue-sora, ugyanarra a piackódra,
      // és csak ha az elemzésnek van Poisson-eredménye (különben a computeValue 0-t adna)
      const row = analysis && analysis.poisson ? analysis.value.find((v) => v.market === market) : undefined;
      const modelProb = row && Number.isFinite(row.modelProb) && row.modelProb >= 0 && row.modelProb <= 1 ? row.modelProb : null;
      // a sor odds-a is egyezzen (explicit, piaconkénti ellenőrzés az objektum-egyezés mellett)
      const rowOddsOk = !row || row.odds == null || row.odds === price;

      const excludeReason: EdgeExcludeReason | null =
        !fresh.ok ? fresh.reason
        : analysisIssue ? analysisIssue
        : !rowOddsOk ? 'analysis_odds_mismatch'
        : !map ? 'market_not_mapped'
        : modelProb == null ? 'model_prob_missing'
        : devig == null ? (devigReason as EdgeExcludeReason)
        : null;
      const usable = excludeReason == null;
      return {
        matchId: match.id, kickoff: match.kickoff, leagueId: match.leagueId, matchStatus: match.status,
        market, outcome: map ? (map.group === '1x2' ? `1x2:${map.outcome}` : `ou${map.line}:${map.outcome}`) : null,
        odds: price, bookmaker: q(market)?.bookmaker ?? null, source,
        observedAt: odds.observedAt ?? null, ageMs,
        rawImplied: rawImplied(price), devig, devigReason,
        modelProb: analysisIssue || !rowOddsOk ? null : modelProb,
        edgePp: usable ? Math.round((modelProb! - devig!) * 10000) / 100 : null,
        modelId: analysis?.model?.id ?? null,
        excluded: !usable, excludeReason,
      };
    });
  }
}

/** Élő bekötéshez (később): a meglévő container + AnalysisService metódusai, változtatás nélkül. */
export function edgeDepsFrom(c: { data: { getMatches(q: { date: string }): Promise<Match[]> } }, svc: { analyze(id: string, o: { variant: EdgeVariant }): Promise<MatchAnalysis | null>; resolveOdds(m: Match): Promise<MatchOdds | null> }): EdgeDeps {
  return { getMatches: (q) => c.data.getMatches(q), analyze: (id, o) => svc.analyze(id, o), resolveOdds: (m) => svc.resolveOdds(m) };
}
