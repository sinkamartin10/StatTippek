/**
 * `xs-strength-1` kiszolgálás a PRO-elemzésekhez.
 *
 *  1. Tanítóadat: minden sorozat (XS_TRAINING_COMPETITIONS) havi ESPN-eredménylistája az utolsó
 *     `historyMonths` hónapból. A lezárt hónapok a tartós tárban (0021) maradnak, és nem kérjük le
 *     újra; tár nélkül memóriában (a folyamaton belül szintén nem kérjük le újra, újraindulás után igen).
 *  2. Becslés: a rögzített kiadási paraméterekkel (XS_RELEASE), CSAK a becslés időpontja előtt
 *     legalább 3 órával kezdődött, rendes játékidővel lezárt meccsekből. Minden becslés naplózva
 *     (fitId = sha256(modell | paraméterek | időhatár | tanítóadat-ujjlenyomat)) → reprodukálható.
 *  3. Kiszolgálás: csak ha (a) van becslés, (b) az nem elavult, (c) a meccs a becslés időhatára
 *     UTÁN (−3 óra) kezdődik – különben a tanítóadat a meccs utáni eredményeket is tartalmazhatná –,
 *     és (d) a validált adatminőségi kategória nem „elégtelen”. Minden más esetben az alap motor
 *     szolgál ki, a visszaesés okával (`model.fallbackReason` / `fallbackCode`), okonként számolva.
 */
import { createHash } from 'node:crypto';
import type { Match, MatchAnalysis, XsFallbackCode } from '../../shared/types';
import { fitCrossLeague, predictCrossLeague, qualityOf, XS_MODEL_ID, type XsFit, type XsMatch } from '../../shared/engine/experimental/crossLeague';
import { XS_RELEASE } from '../../shared/engine/experimental/xsRelease';
import { XG_MODEL_INFO, buildXsAnalysis } from '../../shared/engine/xsAnalysis';
import type { ScoreboardResult } from '../data/scoreboardResults';
import { XS_KINDS, XS_TRAINING_COMPETITIONS } from './xsCompetitions';
import type { XsTrainingStore } from './xsStore';

/** Havi eredménylista-forrás (élesben az EspnProvider). null = a hónap most nem érhető el. */
export interface MonthlyResultsSource {
  monthResults(competitionId: string, yyyymm: string): Promise<ScoreboardResult[] | null>;
}

export interface XsServiceOptions {
  now?: () => Date;
  /** hány hónapra visszamenőleg tanul (alapértelmezés 36) */
  historyMonths?: number;
  /** legalább ennyi tanítómeccs kell a becsléshez (alapértelmezés 2000) */
  minTrainingMatches?: number;
  /** ennél régebbi becslés nem szolgál ki (alapértelmezés 30 óra: 6 órás frissítésnél 4 kimaradt kör) */
  maxFitAgeHours?: number;
  competitions?: string[];
  log?: (msg: string) => void;
}

export interface XsStatus {
  modelId: typeof XS_MODEL_ID;
  ready: boolean;
  fitId: string | null;
  cutoff: string | null;
  trainedMatches: number;
  datasetSha256: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  /** az utolsó frissítés: tárból kihagyott / letöltött / sikertelen / a folyamat memóriájából kihagyott hónapok */
  months: { stored: number; fetched: number; failed: number; cached: number };
  /** az utolsó frissítésben elérhető volt-e a tartós tár (0021) */
  durableStore: boolean;
  storeError: string | null;
  /** kiszolgálás a folyamat indulása óta: xs-elemzések száma és a visszaesések okonként */
  serving: { xs: number; fallbacks: Partial<Record<XsFallbackCode, number>> };
}

const HOUR = 3600_000;

/** 'YYYYMM' (UTC) eltolása */
function shiftMonth(m: string, d: number): string {
  const y = +m.slice(0, 4), mo = +m.slice(4) - 1 + d;
  return `${y + Math.floor(mo / 12)}${String((((mo % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}
const monthKey = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
/** a hónap utolsó pillanata (UTC) */
const monthEnd = (m: string) => Date.UTC(+m.slice(0, 4), +m.slice(4), 1) - 1;

/** A tanítóadat ujjlenyomata (sorrendfüggetlen: a sorok rendezve kerülnek a hash-be). */
export function datasetFingerprint(rows: Pick<ScoreboardResult, 'id' | 'date' | 'homeTeamId' | 'awayTeamId' | 'homeGoals' | 'awayGoals' | 'regulation'>[]): string {
  const lines = rows.map((r) => `${r.id}|${r.date}|${r.homeTeamId}|${r.awayTeamId}|${r.homeGoals}|${r.awayGoals}|${r.regulation}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function fitIdOf(cutoff: string, datasetSha256: string): string {
  return createHash('sha256').update(`${XS_MODEL_ID}|${JSON.stringify(XS_RELEASE.params)}|${XS_RELEASE.closedHours}|${cutoff}|${datasetSha256}`).digest('hex');
}

export class XsModelService {
  private data = new Map<string, ScoreboardResult>();
  /** a folyamatban már letöltött, LEZÁRT hónapok – tár nélkül sem kérjük le őket újra */
  private closedFetched = new Set<string>();
  private fit: (XsFit & { fitId: string; datasetSha256: string }) | null = null;
  private refreshing: Promise<void> | null = null;
  private st: XsStatus = {
    modelId: XS_MODEL_ID, ready: false, fitId: null, cutoff: null, trainedMatches: 0, datasetSha256: null,
    lastRefreshAt: null, lastError: null, months: { stored: 0, fetched: 0, failed: 0, cached: 0 }, durableStore: false, storeError: null,
    serving: { xs: 0, fallbacks: {} },
  };

  constructor(private source: MonthlyResultsSource | null, private store: XsTrainingStore | null, private opts: XsServiceOptions = {}) {}

  private now() { return this.opts.now?.() ?? new Date(); }
  private log(m: string) { (this.opts.log ?? ((x: string) => console.log(x)))(m); }

  status(): XsStatus {
    return { ...this.st, months: { ...this.st.months }, serving: { xs: this.st.serving.xs, fallbacks: { ...this.st.serving.fallbacks } } };
  }

  /** Tanítóadat frissítése + újrabecslés. Egyszerre egy fut; a hívó nem vár rá a kérésekben. */
  refresh(): Promise<void> {
    if (!this.refreshing) this.refreshing = this.refreshInner().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshInner(): Promise<void> {
    const now = this.now();
    const months = this.opts.historyMonths ?? 36;
    const last = monthKey(now), first = shiftMonth(last, -months);
    const comps = this.opts.competitions ?? XS_TRAINING_COMPETITIONS;
    // A tár elérhetőségét MINDEN frissítés újra megnézi: egy átmeneti hiba nem kapcsolja ki végleg
    let storeUp = !!this.store;
    let storeError: string | null = null;
    const storeDown = (op: string, e: unknown) => {
      storeUp = false;
      storeError = `${op}: ${(e as Error).message}`.slice(0, 300);
      this.log(`[xs] tartós tár nem érhető el (${op}) – ebben a körben memóriából dolgozunk: ${(e as Error).message}`);
    };
    let stored = new Map<string, boolean>();
    if (this.store) {
      try { stored = await this.store.months(); } catch (e) { storeDown('months', e); }
    }
    let fetched = 0, failed = 0, skipped = 0, cached = 0, writeErrors = 0;
    for (const c of comps) {
      for (let m = first; m <= last; m = shiftMonth(m, 1)) {
        const key = `${c}|${m}`;
        if (stored.get(key) === true) { skipped++; continue; } // lezárt, eltárolt hónap
        if (this.closedFetched.has(key)) { cached++; continue; } // lezárt, ebben a folyamatban már letöltve
        const rows = this.source ? await this.source.monthResults(c, m) : null;
        if (!rows) { failed++; continue; }
        fetched++;
        for (const r of rows) this.data.set(r.id, r);
        const closed = monthEnd(m) + 3 * 24 * HOUR < now.getTime();
        if (closed) this.closedFetched.add(key);
        if (this.store && storeUp) {
          try { await this.store.saveMonth(c, m, closed, rows); }
          catch (e) {
            // egy hónap írási hibája (pl. egy sor megszorítás-sértése) nem állítja le a többit; ismétlődő hiba igen
            this.log(`[xs] hónap mentése sikertelen (${key}): ${(e as Error).message}`);
            if (++writeErrors >= 3) storeDown('saveMonth', e);
          }
        }
      }
    }
    const fromIso = new Date(Date.UTC(+first.slice(0, 4), +first.slice(4) - 1, 1)).toISOString();
    if (this.store && storeUp) {
      try { for (const r of await this.store.loadMatches(fromIso)) if (!this.data.has(r.id)) this.data.set(r.id, r); }
      catch (e) { storeDown('loadMatches', e); }
    }
    // az ablakból kicsúszott meccsek nem maradnak a memóriában
    for (const [id, r] of this.data) if (r.date < fromIso) this.data.delete(id);
    this.st.months = { stored: skipped, fetched, failed, cached };
    this.st.lastRefreshAt = now.toISOString();
    this.st.durableStore = !!this.store && storeUp;
    this.st.storeError = this.store ? storeError : 'nincs tartós tár konfigurálva';

    // Becslés: CSAK a lezárt (cutoff − 3 óra előtt kezdődött), rendes játékidős meccsekből
    const cutoff = now.toISOString();
    const limit = now.getTime() - XS_RELEASE.closedHours * HOUR;
    const window = [...this.data.values()].filter((r) => r.date >= fromIso && Date.parse(r.date) <= limit && XS_KINDS[r.competitionId]);
    const train: XsMatch[] = window.filter((r) => r.regulation);
    const minN = this.opts.minTrainingMatches ?? 2000;
    if (train.length < minN) {
      // a korábbi (érvényes) becslés marad – a kiszolgálást a becslés kora korlátozza
      this.st.lastError = `Kevés tanítóadat a becsléshez (${train.length} < ${minN}; sikertelen hónapok: ${failed}).`;
      this.log(`[xs] ${this.st.lastError}`);
      return;
    }
    const datasetSha256 = datasetFingerprint(window);
    const fit = fitCrossLeague(train, XS_KINDS, cutoff, XS_RELEASE.params, { closedHours: XS_RELEASE.closedHours, warm: this.fit });
    const fitId = fitIdOf(cutoff, datasetSha256);
    this.fit = { ...fit, fitId, datasetSha256 };
    Object.assign(this.st, {
      ready: true, fitId, cutoff, trainedMatches: fit.trainedMatches, datasetSha256,
      lastError: failed ? `${failed} hónap nem volt letölthető – a becslés a többi adatból készült.` : null,
    });
    this.log(`[xs] becslés kész: ${fit.trainedMatches} meccs, ${fit.sweeps} kör, fitId ${fitId.slice(0, 12)} (hónapok: ${fetched} letöltve, ${skipped} tárból, ${cached} memóriából, ${failed} hiba)`);
    if (this.store && storeUp) {
      try {
        await this.store.recordFit({ fitId, modelId: XS_MODEL_ID, cutoff, closedHours: XS_RELEASE.closedHours, params: { ...XS_RELEASE.params }, datasetSha256, trainedMatches: fit.trainedMatches, sweeps: fit.sweeps });
      } catch (e) { this.log(`[xs] becslésnapló írása sikertelen: ${(e as Error).message}`); }
    }
  }

  /**
   * A PRO-nak kiszolgált elemzés: több ligás modell, ha szabad és lehet; különben az alap
   * elemzés a visszaesés okával. A `base` az alap motor (xg-poisson-1) elemzése ugyanarra a meccsre.
   */
  serve(match: Match, base: MatchAnalysis): MatchAnalysis {
    const fallback = (code: XsFallbackCode, reason: string): MatchAnalysis => {
      const f = this.st.serving.fallbacks;
      // okonként az első előfordulás naplózódik; a számláló az admin-állapotban látszik
      if (!f[code]) this.log(`[xs] visszaesés az alap motorra (${code}): ${reason}`);
      f[code] = (f[code] ?? 0) + 1;
      // az alap elemzés modell-azonosítója marad (bajnokság: xg-poisson-1, kupa: xg-poisson-cup-1)
      return { ...base, model: { ...(base.model ?? XG_MODEL_INFO), fallbackReason: reason, fallbackCode: code } };
    };
    const fit = this.fit;
    if (!fit) return fallback('not_ready', 'A több ligás modell még nem áll készen (a tanítóadat gyűjtése folyamatban).');
    if (this.now().getTime() - Date.parse(fit.cutoff) > (this.opts.maxFitAgeHours ?? 30) * HOUR) {
      return fallback('stale_fit', 'A több ligás modell legutóbbi becslése elavult (a frissítés nem sikerült) – az alap motor szolgál ki.');
    }
    if (!XS_KINDS[match.leagueId]) return fallback('competition', 'Ez a sorozat nincs a több ligás modell tanítóadatában.');
    // szivárgás ellen: a becslés nem tartalmazhat a meccs kezdése utáni eredményt
    if (Date.parse(match.kickoff) <= Date.parse(fit.cutoff) - XS_RELEASE.closedHours * HOUR) {
      return fallback('leakage', 'A meccs a modell legutóbbi becslése előtt kezdődött – a jövőbeli adat kizárása miatt utólag nem számoljuk.');
    }
    const pred = predictCrossLeague(fit, match.homeTeamId, match.awayTeamId, match.leagueId, XS_KINDS);
    const q = qualityOf(pred, XS_RELEASE.thresholds);
    if (q.quality === 'elegtelen') return fallback('quality', q.reason);
    this.st.serving.xs++;
    return buildXsAnalysis(base, pred, q, { fitId: fit.fitId, cutoff: fit.cutoff, trainedMatches: fit.trainedMatches });
  }
}
