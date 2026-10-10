/**
 * Modell-kalibráció – kiértékelés, életciklus, aktiválás, visszaállítás.
 *
 * ÉLETCIKLUS:
 *   alap motor (xg-poisson-1, `active_model_id = null`)
 *   → jelölt illesztése → `shadow` (sosem szolgálják ki)
 *   → `eligible` (MINDEN kapu teljesült) vagy `rejected` (indoklással)
 *   → `active` (csak explicit, auditált admin-aktiválással, CAS-sal)
 *   → `retired` (új aktiválás) / `rolled_back` (visszaállítás)
 *
 * SOHA nem aktivál automatikusan. Az éles szerveren az aktiválás jelenleg
 * TILTVA (`allowPromotion: false`): a kalibrált valószínűség kiszolgálásához
 * az archívumnak az alap és a kiszolgált valószínűséget is rögzítenie kellene
 * (hiányzó mező) – lásd SERVING_NOTE. A kiértékelés, a visszaállítás és az
 * alap motorra való visszaesés ettől függetlenül működik és tesztelt.
 *
 * A kiértékelés NEM fut felhasználói kérésben: csak admin indíthatja, futás-
 * zárral (lease), időkerettel és sorkorláttal; újrafuttatva ugyanarra az
 * adatra ugyanazt a jelöltet (azonos azonosítóval) adja.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ENGINE_VERSION } from '../../shared/engine/version';
import {
  CALIBRATION_METHOD, LEARNING_THRESHOLDS, SERVING_NOTE,
  type CalibrationParams, type GateResult, type LearningRunSummary, type LearningStatus, type ShadowEvaluationResult,
} from '../../shared/modelLearning';
import {
  applyCalibration, byMatch, chronologicalSplit, compare, evaluateGates, fitCandidate, groupReport,
  type Observation, type Thresholds,
} from './calibration';
import type { ArchiveTrainingRow, ModelLearningStore } from './store';

export class LearningTimeoutError extends Error {}

export interface ModelLearningOptions {
  now?: () => Date;
  /** Élesben false: aktiválás csak a kiszolgálási integráció után engedélyezhető. */
  allowPromotion?: boolean;
  thresholds?: Thresholds;
  baseEngineVersion?: string;
  /** A feloldott aktív modell gyorsítótárának élettartama. */
  resolveTtlMs?: number;
}

export type ResolvedModel =
  | { kind: 'baseline'; engineVersion: string; reason: string }
  | { kind: 'calibrated'; engineVersion: string; modelId: string; params: CalibrationParams };

export type EvaluateResult =
  | { status: 'locked' }
  | { status: 'insufficient_data' | 'rejected' | 'eligible' | 'failed'; summary: LearningRunSummary };

export interface ActionResult { ok: boolean; code: string; message: string; activeModelId?: string | null }

/** A kalibrációs paraméterek szerkezeti és tartománybeli ellenőrzése. */
export function validateParams(raw: unknown, t: Thresholds = LEARNING_THRESHOLDS): raw is CalibrationParams {
  const okPair = (p: unknown) => {
    if (!p || typeof p !== 'object') return false;
    const { a, b } = p as { a: unknown; b: unknown };
    return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)
      && b >= t.slopeRange[0] && b <= t.slopeRange[1] && Math.abs(a) <= t.maxAbsIntercept;
  };
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Partial<CalibrationParams>;
  if (!okPair(p.global) || typeof p.lambda !== 'number' || !Number.isFinite(p.lambda)) return false;
  if (!p.byMarketType || typeof p.byMarketType !== 'object') return false;
  return Object.values(p.byMarketType).every(okPair);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** `<alap>+cal-<12 hex>` – a kiszolgáló modell egy kalibráció-e az adott alap motoron. */
export function isCalibrationModelOf(servedModel: string, base: string): boolean {
  return servedModel.startsWith(`${base}+`) && /^cal-[0-9a-f]{12}$/.test(servedModel.slice(base.length + 1));
}

/** A kiszolgáló-modell azonosító egy kalibrációhoz. */
export const servedModelId = (base: string, calibrationId: string) => `${base}+${calibrationId}`;
const r9 = (x: number) => Math.round(x * 1e9) / 1e9;

export class ModelLearningService {
  private now: () => Date;
  private t: Thresholds;
  private base: string;
  private allowPromotion: boolean;
  private resolveTtlMs: number;
  private resolved: { at: number; value: ResolvedModel } | null = null;
  private fallbackLogged = new Set<string>();

  constructor(private store: ModelLearningStore, opts: ModelLearningOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.t = opts.thresholds ?? LEARNING_THRESHOLDS;
    this.base = opts.baseEngineVersion ?? ENGINE_VERSION;
    this.allowPromotion = opts.allowPromotion ?? false;
    this.resolveTtlMs = opts.resolveTtlMs ?? 60_000;
  }

  get promotionEnabled(): boolean { return this.allowPromotion; }

  /**
   * Készenlét-ellenőrzés (induláskor): a tanulási réteg csak akkor „kész”, ha a
   * saját állapota (0015) ÉS a tanító olvasás az eredet-oszlopokkal (0016) is
   * elérhető. Üres lista = kész.
   */
  async healthCheck(): Promise<string[]> {
    const missing: string[] = [];
    try { await this.store.getState(); } catch { missing.push('model_learning_state (0015)'); }
    try { await this.store.loadArchive(this.base, 1); } catch { missing.push('model_tip_archive_counted – eredet-oszlopok (0016)'); }
    return missing;
  }

  // -------------------------------------------------------------------------
  // Adat-előkészítés: CSAK érvényes, lezárt, kezdés előtti megfigyelések
  // -------------------------------------------------------------------------

  /**
   * Az archív sorokból tanító megfigyelések. Kizár (és megszámol) mindent,
   * ami nem érvényes, lezárt, kezdés előtti, egyedi tipp. A forrás már a
   * „statisztikába számító” nézet (meccs + piac szerint a kezdés előtti utolsó
   * verzió) – itt ezt védekezésből újra ellenőrizzük.
   */
  buildObservations(rows: ArchiveTrainingRow[]): { obs: Observation[]; excluded: Record<string, number> } {
    const excluded: Record<string, number> = {};
    const skip = (k: string) => { excluded[k] = (excluded[k] ?? 0) + 1; };
    const seen = new Set<string>();
    const obs: Observation[] = [];
    // Tartalom-alapú, determinisztikus sorrend (a sorazonosító véletlen UUID): azonos adatra
    // bitre azonos összegzési sorrend → reprodukálható paraméterek és metrikák
    const ordered = [...rows].sort((x, y) => x.kickoff.localeCompare(y.kickoff) || x.matchId.localeCompare(y.matchId)
      || x.market.localeCompare(y.market) || x.generatedAt.localeCompare(y.generatedAt));
    for (const r of ordered) {
      if (r.engineVersion !== this.base || r.origin !== 'live') { skip('wrong_engine_or_origin'); continue; }
      if (r.settlementStatus === 'pending') { skip('unresolved'); continue; }
      if (r.settlementStatus === 'void') { skip('void'); continue; }
      if (r.settlementStatus === 'unsupported') { skip('unsupported'); continue; }
      if (r.settlementStatus !== 'won' && r.settlementStatus !== 'lost') { skip('unknown_status'); continue; }
      if (r.homeGoals == null || r.awayGoals == null) { skip('missing_result'); continue; }
      const kickoff = Date.parse(r.resultKickoff ?? r.kickoff);
      const generatedAt = Date.parse(r.generatedAt);
      if (!Number.isFinite(kickoff) || !Number.isFinite(generatedAt)) { skip('invalid_timestamp'); continue; }
      // a generáláskori és az elszámoláskori kezdés közül a korábbi előtt kell lennie
      if (!r.preKickoff || generatedAt >= kickoff || generatedAt >= Date.parse(r.kickoff)) { skip('not_pre_kickoff'); continue; }
      if (!(r.modelProb > 0 && r.modelProb < 1)) { skip('invalid_probability'); continue; }
      // Eredet-integritás (0016). Az illesztés MINDIG a nyers `model_prob`-ot használja – a
      // kiszolgált érték sosem tanító bemenet –, de ellentmondásos eredetű sort nem használunk.
      if (r.provenance === 'recorded') {
        if (r.servedProb == null || r.servedModel == null || !(r.servedProb >= 0 && r.servedProb <= 1)) { skip('invalid_provenance'); continue; }
        if (r.servedModel === this.base) {
          if (r.servedProb !== r.modelProb) { skip('provenance_mismatch'); continue; }
        } else if (!isCalibrationModelOf(r.servedModel, this.base)) { skip('invalid_provenance'); continue; }
      } else if (r.provenance === 'legacy_baseline') {
        if (r.servedProb != null || r.servedModel != null) { skip('invalid_provenance'); continue; }
      } else { skip('invalid_provenance'); continue; }
      const key = `${r.matchId}|${r.market}`;
      if (seen.has(key)) { skip('duplicate'); continue; }
      seen.add(key);
      obs.push({
        id: r.id, matchId: r.matchId, market: r.market, marketType: r.marketType, leagueId: r.leagueId,
        kickoff, generatedAt, prob: r.modelProb, y: r.settlementStatus === 'won' ? 1 : 0,
        servedProb: r.servedProb, servedModel: r.servedModel,
      });
    }
    return { obs, excluded };
  }

  // -------------------------------------------------------------------------
  // Kiértékelés (admin által indított, zárral védett, korlátos)
  // -------------------------------------------------------------------------

  async evaluate(actor: string): Promise<EvaluateResult> {
    const owner = randomUUID();
    const startedAt = this.now();
    const locked = await this.store.tryAcquireLock(owner, startedAt.toISOString(), new Date(startedAt.getTime() + this.t.lockLeaseMs).toISOString());
    if (!locked) return { status: 'locked' };

    const deadline = startedAt.getTime() + this.t.timeBudgetMs;
    const checkTime = (phase: string) => {
      if (this.now().getTime() > deadline) throw new LearningTimeoutError(`időkeret túllépve (${phase})`);
    };
    let summary: LearningRunSummary = { validObservations: 0, validMatches: 0, excluded: {}, windows: {}, outcome: 'failed', reasons: [] };
    try {
      const rows = await this.store.loadArchive(this.base, this.t.maxRows);
      checkTime('adatbetöltés');
      const { obs, excluded } = this.buildObservations(rows);
      summary = { ...summary, validObservations: obs.length, validMatches: byMatch(obs).size, excluded };
      const reasons: string[] = [];
      if (rows.length >= this.t.maxRows) reasons.push(`Az adat-korlát (${this.t.maxRows} sor) elérve – a legújabb sorok kimaradhattak.`);

      const split = chronologicalSplit(obs, this.t);
      const sizes = {
        trainMatches: byMatch(split.train).size,
        validationMatches: byMatch(split.validation).size,
        holdoutMatches: byMatch(split.holdout).size,
        holdoutObservations: split.holdout.length,
      };
      const win = (list: Observation[]): [string, string] | undefined => (list.length
        ? [new Date(Math.min(...list.map((o) => o.kickoff))).toISOString(), new Date(Math.max(...list.map((o) => o.kickoff))).toISOString()]
        : undefined);
      summary = { ...summary, sizes, windows: { train: win(split.train), validation: win(split.validation), holdout: win(split.holdout) } };
      if (split.embargoed) excluded.embargo = split.embargoed;

      const short: string[] = [];
      if (sizes.trainMatches < this.t.minTrainMatches) short.push(`tanító mérkőzés ${sizes.trainMatches} < ${this.t.minTrainMatches}`);
      if (sizes.validationMatches < this.t.minValidationMatches) short.push(`validációs mérkőzés ${sizes.validationMatches} < ${this.t.minValidationMatches}`);
      if (sizes.holdoutMatches < this.t.minHoldoutMatches) short.push(`holdout mérkőzés ${sizes.holdoutMatches} < ${this.t.minHoldoutMatches}`);
      if (sizes.holdoutObservations < this.t.minHoldoutObservations) short.push(`holdout megfigyelés ${sizes.holdoutObservations} < ${this.t.minHoldoutObservations}`);
      if (short.length) {
        summary = {
          ...summary, outcome: 'insufficient_data',
          reasons: [...reasons, `Nincs elég lezárt, kezdés előtti adat – a rendszer árnyék-módban marad: ${short.join('; ')}.`],
        };
        await this.store.appendEvent({ kind: 'insufficient_data', modelId: null, actor, details: summary });
        await this.store.finishRun(owner, this.now().toISOString(), 'insufficient_data', null, summary);
        return { status: 'insufficient_data', summary };
      }
      checkTime('felosztás');

      // Reprodukálhatóság: az adat ujjlenyomata határozza meg a bootstrap-magot és a jelölt azonosítóját
      // tartalom-alapú: a sorazonosító véletlen UUID, ezért nem része (azonos adat → azonos ujjlenyomat)
      const fingerprint = sha256(obs.map((o) => `${o.matchId}|${o.market}|${o.marketType}|${o.leagueId}|${o.kickoff}|${o.generatedAt}|${o.prob}|${o.y}`).sort().join('\n'));
      const seed = parseInt(fingerprint.slice(0, 8), 16);

      const { params: rawParams, validationLogLoss } = fitCandidate(split, this.t);
      checkTime('illesztés');
      const params: CalibrationParams = {
        lambda: rawParams.lambda,
        global: { a: r9(rawParams.global.a), b: r9(rawParams.global.b) },
        byMarketType: Object.fromEntries(Object.entries(rawParams.byMarketType).sort(([x], [y]) => x.localeCompare(y))
          .map(([k, v]) => [k, { a: r9(v.a), b: r9(v.b) }])),
      };
      const cand = (o: Observation) => applyCalibration(o.prob, params, o.marketType);
      const { perMatchLogLossDeltas: _d, ...holdout } = compare(split.holdout, cand, this.t, seed);
      checkTime('összevetés');
      const { gate, markets } = evaluateGates(split.holdout, params, holdout, this.t, seed);
      checkTime('kapuk');
      const leagues = groupReport(split.holdout, (o) => o.leagueId, cand)
        .filter((g) => g.matches >= this.t.marketGuardMinMatches); // csak jelentés – a ligák nem kapuk (többszörös összevetés)

      const id = `cal-${sha256(`${CALIBRATION_METHOD}|${this.base}|${fingerprint}|${JSON.stringify(params)}`).slice(0, 12)}`;
      const status = gate.passed ? 'eligible' : 'rejected';
      await this.store.insertVersion({
        id, baseEngineVersion: this.base, method: CALIBRATION_METHOD, params, dataFingerprint: fingerprint,
        trainingWindow: summary.windows, metrics: { holdout, validationLogLoss, markets, leagues, sizes, embargoed: split.embargoed },
        gateResult: gate, status: 'shadow', statusReason: 'árnyék-kiértékelés',
      });
      await this.store.setVersionStatus(id, status, gate.passed ? 'Minden kapu teljesült.' : gate.reasons.join(' '), ['shadow'], this.now().toISOString());

      summary = { ...summary, candidateId: id, outcome: status, reasons: [...reasons, ...(gate.passed ? ['Minden kapu teljesült – aktiválás csak explicit admin-döntéssel.'] : gate.reasons)] };
      await this.store.appendEvent({ kind: 'evaluation', modelId: id, actor, details: summary });
      await this.store.appendEvent({ kind: gate.passed ? 'candidate_eligible' : 'candidate_rejected', modelId: id, actor, details: { reasons: summary.reasons } });
      await this.store.finishRun(owner, this.now().toISOString(), 'succeeded', null, summary);
      return { status, summary };
    } catch (e) {
      const message = String((e as Error)?.message ?? e).slice(0, 500);
      summary = { ...summary, outcome: 'failed', reasons: [...summary.reasons, message] };
      try {
        await this.store.appendEvent({ kind: 'failure', modelId: summary.candidateId ?? null, actor, details: { error: message } });
      } catch { /* az audit-hiba ne takarja el az eredeti hibát */ }
      try { await this.store.finishRun(owner, this.now().toISOString(), 'failed', message, summary); } catch { /* a zár a lease lejártával felszabadul */ }
      return { status: 'failed', summary };
    }
  }

  // -------------------------------------------------------------------------
  // Prospektív (árnyék) kiértékelés – valóban mintán kívüli adaton
  // -------------------------------------------------------------------------

  /**
   * Egy meglévő jelölt kiértékelése OLYAN előrejelzéseken, amelyek a jelölt
   * létrejötte UTÁN keletkeztek, és amelyek meccsei a jelölt adatablakának
   * vége (+ embargó) után kezdődtek – a jelölt ezeket semmilyen módon nem
   * láthatta (sem illesztésnél, sem λ-választásnál, sem a holdouton).
   *
   * A jelölt valószínűsége soronként:
   *  - ha a sort TÉNYLEGESEN ez a jelölt szolgálta ki ('recorded', served_model
   *    = `<alap>+<id>`), a rögzített kiszolgált érték – és ellenőrizzük, hogy
   *    egyezik a nyers értékből újraszámolttal (eltérés → kizárás),
   *  - különben árnyék-érték: a jelölt (megváltoztathatatlan) paramétereivel a
   *    NYERS alap-valószínűségből számolva. A felhasználói kimenet nem változik.
   * Az összevetés alapja mindig az alap motor nyers valószínűsége.
   */
  async evaluateShadow(modelId: string, actor: string): Promise<
    { status: 'locked' | 'not_found' | 'invalid' } | { status: ShadowEvaluationResult['outcome']; result: ShadowEvaluationResult }
  > {
    const version = await this.store.getVersion(modelId);
    if (!version) return { status: 'not_found' };
    if (version.baseEngineVersion !== this.base || version.method !== CALIBRATION_METHOD || !validateParams(version.params, this.t)) {
      return { status: 'invalid' };
    }
    const params = version.params as CalibrationParams;

    const owner = randomUUID();
    const startedAt = this.now();
    const before = await this.store.getState();
    if (!(await this.store.tryAcquireLock(owner, startedAt.toISOString(), new Date(startedAt.getTime() + this.t.lockLeaseMs).toISOString()))) {
      return { status: 'locked' };
    }
    const windows = (version.trainingWindow ?? {}) as Record<string, [string, string] | undefined>;
    const lastUsedKickoff = Math.max(
      ...Object.values(windows).filter((w): w is [string, string] => Array.isArray(w)).map((w) => Date.parse(w[1])).filter(Number.isFinite),
      Date.parse(version.createdAt),
    );
    const cutoff = {
      generatedAfter: version.createdAt,
      kickoffAfter: new Date(lastUsedKickoff + this.t.embargoMs).toISOString(),
    };
    let result: ShadowEvaluationResult = {
      candidateId: modelId, outcome: 'failed', cutoff, sizes: { matches: 0, observations: 0, servedByCandidate: 0, shadowComputed: 0 }, excluded: {}, reasons: [],
    };
    try {
      const deadline = startedAt.getTime() + this.t.timeBudgetMs;
      const { obs: all, excluded } = this.buildObservations(await this.store.loadArchive(this.base, this.t.maxRows));
      if (this.now().getTime() > deadline) throw new LearningTimeoutError('időkeret túllépve (adatbetöltés)');
      const generatedAfter = Date.parse(cutoff.generatedAfter);
      const kickoffAfter = Date.parse(cutoff.kickoffAfter);
      const servedId = servedModelId(this.base, modelId);
      const candidateProb = new Map<string, number>();
      let servedByCandidate = 0;
      let shadowComputed = 0;
      const prospective: Observation[] = [];
      for (const o of all) {
        // mintán kívüliség: a jelölt létrejötte UTÁNI előrejelzés, a jelölt adatablaka UTÁNI meccs
        if (!(o.generatedAt > generatedAfter && o.kickoff > kickoffAfter)) { excluded.before_cutoff = (excluded.before_cutoff ?? 0) + 1; continue; }
        const recomputed = applyCalibration(o.prob, params, o.marketType);
        if (o.servedModel === servedId) {
          if (o.servedProb == null || Math.abs(o.servedProb - recomputed) > 1e-9) { excluded.provenance_mismatch = (excluded.provenance_mismatch ?? 0) + 1; continue; }
          candidateProb.set(o.id, o.servedProb);
          servedByCandidate++;
        } else {
          candidateProb.set(o.id, recomputed);
          shadowComputed++;
        }
        prospective.push(o);
      }
      const matches = byMatch(prospective).size;
      result = { ...result, excluded, sizes: { matches, observations: prospective.length, servedByCandidate, shadowComputed } };
      if (matches < this.t.minHoldoutMatches || prospective.length < this.t.minHoldoutObservations) {
        result = {
          ...result, outcome: 'insufficient_data',
          reasons: [`Nincs elég mintán kívüli adat: ${matches} mérkőzés / ${prospective.length} megfigyelés (legalább ${this.t.minHoldoutMatches} / ${this.t.minHoldoutObservations} kell).`],
        };
      } else {
        const seed = parseInt(sha256(`shadow|${modelId}|${cutoff.kickoffAfter}`).slice(0, 8), 16);
        const cand = (o: Observation) => candidateProb.get(o.id)!;
        const { perMatchLogLossDeltas: _d, ...comparison } = compare(prospective, cand, this.t, seed);
        const { gate } = evaluateGates(prospective, params, comparison, this.t, seed);
        result = { ...result, comparison, outcome: gate.passed ? 'passed' : 'failed_gates', reasons: gate.passed ? ['A mintán kívüli kiértékelés minden kapun átment.'] : gate.reasons };
      }
      await this.store.appendEvent({ kind: 'shadow_evaluation', modelId, actor, details: result });
      await this.store.finishRun(owner, this.now().toISOString(), 'succeeded', null, before.lastRunSummary);
      return { status: result.outcome, result };
    } catch (e) {
      const message = String((e as Error)?.message ?? e).slice(0, 500);
      result = { ...result, outcome: 'failed', reasons: [...result.reasons, message] };
      try { await this.store.appendEvent({ kind: 'failure', modelId, actor, details: { error: message, phase: 'shadow_evaluation' } }); } catch { /* nem takarja el az eredeti hibát */ }
      try { await this.store.finishRun(owner, this.now().toISOString(), 'failed', message, before.lastRunSummary); } catch { /* a lease lejártával felszabadul */ }
      return { status: 'failed', result };
    }
  }

  // -------------------------------------------------------------------------
  // Aktiválás és visszaállítás – explicit, auditált, CAS-sal atomikus
  // -------------------------------------------------------------------------

  async promote(modelId: string, actor: string): Promise<ActionResult> {
    if (!this.allowPromotion) {
      await this.store.appendEvent({ kind: 'promotion_refused', modelId, actor, details: { reason: SERVING_NOTE } });
      return { ok: false, code: 'PROMOTION_DISABLED', message: SERVING_NOTE };
    }
    const state = await this.store.getState();
    const v = await this.store.getVersion(modelId);
    const refuse = async (code: string, message: string): Promise<ActionResult> => {
      await this.store.appendEvent({ kind: 'promotion_refused', modelId, actor, details: { code, message } });
      return { ok: false, code, message };
    };
    if (!v) return refuse('NOT_FOUND', 'Ismeretlen jelölt.');
    if (v.status !== 'eligible') return refuse('NOT_ELIGIBLE', `A jelölt állapota „${v.status}” – csak „eligible” aktiválható.`);
    if (v.baseEngineVersion !== this.base || v.method !== CALIBRATION_METHOD) return refuse('INCOMPATIBLE', 'A jelölt más motorverzióhoz vagy módszerhez készült.');
    if (!validateParams(v.params, this.t) || !(v.gateResult as GateResult | null)?.passed) return refuse('INVALID', 'A jelölt paraméterei vagy kapu-eredménye érvénytelen.');
    if (state.activeModelId === modelId) return refuse('ALREADY_ACTIVE', 'A jelölt már aktív.');
    // A visszamenőleges holdout mellett a jelöltnek MINTÁN KÍVÜLI (prospektív) bizonyíték is kell
    const shadow = await this.store.latestEvent(modelId, 'shadow_evaluation');
    if ((shadow?.details as ShadowEvaluationResult | undefined)?.outcome !== 'passed') {
      return refuse('SHADOW_NOT_PASSED', 'A jelölt legutolsó mintán kívüli (árnyék) kiértékelése nem sikeres vagy hiányzik.');
    }

    const at = this.now().toISOString();
    // EGYETLEN feltételes írás dönti el, mi az aktív – párhuzamos kísérletből csak egy nyer
    if (!(await this.store.casActive(state.stateVersion, modelId, state.activeModelId, at))) {
      return refuse('CONFLICT', 'Az aktív modell közben megváltozott – frissíts és próbáld újra.');
    }
    await this.store.setVersionStatus(modelId, 'active', `Aktiválta: ${actor}`, ['eligible'], at);
    if (state.activeModelId) await this.store.setVersionStatus(state.activeModelId, 'retired', `Leváltotta: ${modelId}`, ['active'], at);
    await this.store.appendEvent({ kind: 'promotion', modelId, actor, details: { previous: state.activeModelId, stateVersion: state.stateVersion + 1 } });
    this.resolved = null;
    return { ok: true, code: 'PROMOTED', message: 'Aktiválva.', activeModelId: modelId };
  }

  /**
   * Visszaállítás az utolsó ismert jó állapotra: az előző aktív modellre, ha
   * az még érvényes, különben az alap motorra. Mindig engedélyezett.
   */
  async rollback(actor: string): Promise<ActionResult> {
    const state = await this.store.getState();
    if (!state.activeModelId) return { ok: false, code: 'NOTHING_ACTIVE', message: 'Az alap motor az aktív – nincs mit visszaállítani.' };
    let target: string | null = null;
    if (state.previousModelId) {
      const prev = await this.store.getVersion(state.previousModelId);
      if (prev && prev.baseEngineVersion === this.base && prev.method === CALIBRATION_METHOD && validateParams(prev.params, this.t)) target = prev.id;
    }
    const at = this.now().toISOString();
    if (!(await this.store.casActive(state.stateVersion, target, null, at))) {
      return { ok: false, code: 'CONFLICT', message: 'Az aktív modell közben megváltozott – frissíts és próbáld újra.' };
    }
    await this.store.setVersionStatus(state.activeModelId, 'rolled_back', `Visszaállította: ${actor}`, ['active'], at);
    if (target) await this.store.setVersionStatus(target, 'active', 'Visszaállítás után újra aktív', ['retired', 'eligible'], at);
    await this.store.appendEvent({ kind: 'rollback', modelId: state.activeModelId, actor, details: { restored: target ?? `alap motor (${this.base})` } });
    this.resolved = null;
    return { ok: true, code: 'ROLLED_BACK', message: 'Visszaállítva.', activeModelId: target };
  }

  // -------------------------------------------------------------------------
  // Az aktív modell feloldása – bármilyen hibánál az alap motor
  // -------------------------------------------------------------------------

  async resolveActive(): Promise<ResolvedModel> {
    const nowMs = this.now().getTime();
    if (this.resolved && nowMs - this.resolved.at < this.resolveTtlMs) return this.resolved.value;
    const baseline = (reason: string): ResolvedModel => ({ kind: 'baseline', engineVersion: this.base, reason });
    let value: ResolvedModel;
    try {
      const state = await this.store.getState();
      if (!state.activeModelId) value = baseline('nincs aktív kalibráció');
      else {
        const v = await this.store.getVersion(state.activeModelId);
        const problem = !v ? 'hiányzó modellverzió'
          : v.status !== 'active' ? `a modell állapota „${v.status}”`
            : v.baseEngineVersion !== this.base ? `inkompatibilis alap motor (${v.baseEngineVersion})`
              : v.method !== CALIBRATION_METHOD ? `ismeretlen módszer (${v.method})`
                : !validateParams(v.params, this.t) ? 'sérült vagy érvénytelen paraméterek' : null;
        if (problem) {
          value = baseline(`visszaesés az alap motorra: ${problem}`);
          await this.logFallback(state.activeModelId, problem);
        } else {
          value = { kind: 'calibrated', engineVersion: this.base, modelId: v!.id, params: v!.params as CalibrationParams };
        }
      }
    } catch (e) {
      value = baseline(`visszaesés az alap motorra: a konfiguráció nem olvasható (${(e as Error).message})`);
    }
    this.resolved = { at: nowMs, value };
    return value;
  }

  private async logFallback(modelId: string, problem: string) {
    const key = `${modelId}|${problem}`;
    if (this.fallbackLogged.has(key)) return;
    this.fallbackLogged.add(key);
    console.warn(`[model-learning] visszaesés az alap motorra (${modelId}): ${problem}`);
    try { await this.store.appendEvent({ kind: 'fallback', modelId, actor: 'system', details: { problem } }); } catch { /* nem kritikus */ }
  }

  // -------------------------------------------------------------------------
  // Admin státusz – csak tárolt adatból, újraszámolás nélkül
  // -------------------------------------------------------------------------

  async status(): Promise<LearningStatus> {
    const [state, versions, events] = await Promise.all([this.store.getState(), this.store.listVersions(10), this.store.listEvents(20)]);
    const nowIso = this.now().toISOString();
    return {
      baselineEngineVersion: this.base,
      servedModel: this.base,
      servingNote: SERVING_NOTE,
      promotionEnabled: this.allowPromotion,
      activeModelId: state.activeModelId,
      previousModelId: state.previousModelId,
      stateVersion: state.stateVersion,
      lastRun: {
        startedAt: state.lastRunStartedAt, finishedAt: state.lastRunFinishedAt, status: state.lastRunStatus,
        error: state.lastRunError, summary: state.lastRunSummary,
      },
      nextScheduledEvaluation: null,
      schedulingNote: 'Nincs ütemező (a Render-szolgáltatáson nincs cron/worker beállítva): a kiértékelést admin indítja a POST /api/admin/model-learning/evaluate végponton.',
      locked: !!state.lockUntil && state.lockUntil > nowIso,
      thresholds: this.t,
      candidates: versions.map((v) => ({
        id: v.id, status: v.status, statusReason: v.statusReason, createdAt: v.createdAt, metrics: v.metrics,
        gateResult: v.gateResult as GateResult,
      })),
      recentEvents: events.map((e) => ({ at: e.at, kind: e.kind, modelId: e.modelId, details: e.details })),
    };
  }
}
