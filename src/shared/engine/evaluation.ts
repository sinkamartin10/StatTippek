/**
 * Értékelemzés (modell vs. odds), adatminőség-mutató és külső forrás-konszenzus.
 */
import type {
  DataQuality,
  ExternalConsensus,
  ExternalPrediction,
  FormSummary,
  MatchOdds,
  PoissonResult,
  ResearchResult,
  ValueRow,
  ValueVerdict,
} from '../types';
import { marketLabel } from './markets';
import { marketProbability } from './models';

/** Implikált valószínűség tizedes oddsból: 1 / odds (a fogadóiroda árrését NEM távolítjuk el, ezt a felület jelzi). */
export function impliedProbability(odds: number): number {
  return 1 / odds;
}

export function valueVerdict(diffPoints: number): ValueVerdict {
  if (diffPoints >= 3) return 'Pozitív modellkülönbség';
  if (diffPoints <= -3) return 'Negatív modellkülönbség';
  return 'Semleges';
}

export const VALUE_MARKETS = ['1', 'X', '2', '1X', 'X2', 'O1.5', 'O2.5', 'O3.5', 'U2.5', 'U3.5', 'BTTS_Y', 'BTTS_N', 'DNB_1', 'DNB_2'];

/** Minden vizsgált piacra: modell-valószínűség és – ha van odds – implikált valószínűség és különbség (százalékpont). */
export function computeValue(poisson: PoissonResult | null, odds: MatchOdds | null): ValueRow[] {
  if (!poisson) return [];
  return VALUE_MARKETS.map((market) => {
    const modelProb = marketProbability(poisson, market) ?? 0;
    const o = odds?.markets[market];
    if (!o || o <= 1) {
      return { market, label: marketLabel(market), modelProb, odds: null, impliedProb: null, diffPoints: null, verdict: null };
    }
    const implied = impliedProbability(o);
    const diff = Math.round((modelProb - implied) * 10000) / 100;
    return { market, label: marketLabel(market), modelProb, odds: o, impliedProb: implied, diffPoints: diff, verdict: valueVerdict(diff) };
  });
}

export interface DataQualityInput {
  homeLast10: FormSummary;
  awayLast10: FormSummary;
  homeAtHome: FormSummary;
  awayAtAway: FormSummary;
  leagueMatches: number;
  research: ResearchResult;
  odds: MatchOdds | null;
  /** a legfrissebb meccs dátuma (ISO) – az adatok frissességéhez */
  newestResultDate: string | null;
  now: string;
}

/**
 * Adatminőség-mutató. Ez NEM nyerési valószínűség, hanem annak mértéke,
 * hogy mennyi és milyen friss ellenőrizhető adat áll az elemzés mögött.
 */
export function computeDataQuality(inp: DataQualityInput): DataQuality {
  const factors: DataQuality['factors'] = [];
  let score = 0;

  const minSample = Math.min(inp.homeLast10.sampleSize, inp.awayLast10.sampleSize);
  const okSample = minSample >= 8;
  factors.push({ label: 'Historikus meccsek száma', ok: okSample, detail: `hazai: ${inp.homeLast10.sampleSize}, vendég: ${inp.awayLast10.sampleSize} (cél: legalább 8)` });
  score += okSample ? 25 : minSample >= 4 ? 12 : 0;

  const venueSample = Math.min(inp.homeAtHome.sampleSize, inp.awayAtAway.sampleSize);
  const okVenue = venueSample >= 4;
  factors.push({ label: 'Hazai/idegen minta', ok: okVenue, detail: `hazai pályán: ${inp.homeAtHome.sampleSize}, idegenben: ${inp.awayAtAway.sampleSize} (cél: legalább 4)` });
  score += okVenue ? 15 : venueSample >= 2 ? 7 : 0;

  const okLeague = inp.leagueMatches >= 30;
  factors.push({ label: 'Liga-átlag mintanagyság', ok: okLeague, detail: `${inp.leagueMatches} bajnoki meccs` });
  score += okLeague ? 10 : inp.leagueMatches >= 10 ? 5 : 0;

  const verifiableSources = inp.research.sources.filter((s) => s.url).length;
  const anySources = inp.research.sources.length;
  const okSources = verifiableSources >= 3;
  factors.push({
    label: 'Ellenőrizhető források',
    ok: okSources,
    detail: inp.research.origin === 'demo'
      ? `${anySources} DEMO forrás (URL nélkül – nem ellenőrizhető)`
      : `${verifiableSources} forrás URL-lel`,
  });
  score += okSources ? 15 : anySources > 0 ? 5 : 0;

  const hasTeamInfo = inp.research.news.length > 0 || inp.research.availability.home.notes.length > 0;
  factors.push({ label: 'Aktuális csapatinformáció', ok: hasTeamInfo, detail: hasTeamInfo ? `${inp.research.news.length} hír / információ` : 'nincs friss hír vagy hiányzó-információ' });
  score += hasTeamInfo ? 10 : 0;

  const lineups = inp.research.availability.home.lineupStatus === 'megerősített' && inp.research.availability.away.lineupStatus === 'megerősített';
  factors.push({ label: 'Megerősített kezdőcsapatok', ok: lineups, detail: `hazai: ${inp.research.availability.home.lineupStatus}, vendég: ${inp.research.availability.away.lineupStatus}` });
  score += lineups ? 10 : 0;

  const hasOdds = !!inp.odds && Object.keys(inp.odds.markets).length > 0;
  factors.push({ label: 'Odds elérhető', ok: hasOdds, detail: hasOdds ? `forrás: ${inp.odds!.source}` : 'nincs odds – az értékelemzés nem futtatható' });
  score += hasOdds ? 5 : 0;

  let fresh = false;
  let freshDetail = 'nincs adat';
  if (inp.newestResultDate) {
    const days = (new Date(inp.now).getTime() - new Date(inp.newestResultDate).getTime()) / 86400000;
    fresh = days <= 21;
    freshDetail = `legfrissebb eredmény ${Math.max(0, Math.round(days))} napja`;
  }
  factors.push({ label: 'Adatok frissessége', ok: fresh, detail: freshDetail });
  score += fresh ? 10 : 0;

  const level = score >= 70 ? 'magas' : score >= 40 ? 'közepes' : 'kevés';
  return { level, score, factors };
}

/** Külső források tippjeinek összesítése – az egyetértés NEM bizonyíték, csak megfigyelés. */
export function computeConsensus(preds: ExternalPrediction[]): ExternalConsensus {
  const byMarket = new Map<string, string[]>();
  for (const p of preds) {
    if (!p.market) continue;
    if (!byMarket.has(p.market)) byMarket.set(p.market, []);
    byMarket.get(p.market)!.push(p.sourceName);
  }
  const rows = [...byMarket.entries()]
    .map(([market, sources]) => ({ market, label: marketLabel(market), count: sources.length, sources }))
    .sort((a, b) => b.count - a.count);
  const total = preds.length;
  let agreementNote: string | null = null;
  let disagreementNote: string | null = null;
  if (rows.length > 0 && total >= 2 && rows[0].count >= 2) {
    agreementNote = `Az online források között a(z) „${rows[0].label}” piacon látható egyetértés (${rows[0].count}/${total} forrás).`;
  }
  // Ellentmondás: ha egymást kizáró piacok egyaránt megjelennek
  const conflicts: [string, string][] = [['1', '2'], ['O2.5', 'U2.5'], ['BTTS_Y', 'BTTS_N'], ['1', 'X'], ['2', 'X']];
  for (const [a, b] of conflicts) {
    if (byMarket.has(a) && byMarket.has(b)) {
      disagreementNote = `Források eltérő következtetésre jutnak: „${marketLabel(a)}” és „${marketLabel(b)}” egyaránt szerepel.`;
      break;
    }
  }
  return { totalSources: total, byMarket: rows, agreementNote, disagreementNote };
}
