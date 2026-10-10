/**
 * Modell-kalibráció (tanulási réteg) – közös típusok és a kapuk SZÁMSZERŰ
 * küszöbei. Minden küszöb itt, egy helyen van, hogy auditálható legyen.
 *
 * A tanulási réteg NEM cseréli le az alap motort (`xg-poisson-1`): a
 * jelöltek az alap motor kezdés előtti valószínűségeit kalibrálják. A
 * kiszolgált modell jelenleg MINDIG az alap motor (lásd SERVING_NOTE).
 */

/** A kalibrációs módszer azonosítója – a paraméterek értelmezése ehhez kötött. */
export const CALIBRATION_METHOD = 'platt-shrunk-v1';

/** Életciklus. Az alap motor nem sor a táblában: `active_model_id = null`. */
export type CalibrationStatus = 'shadow' | 'eligible' | 'active' | 'rejected' | 'rolled_back' | 'retired';

/** A kiértékelés küszöbei – mérkőzés-szinten számolva (a piacok nem függetlenek). */
export const LEARNING_THRESHOLDS = {
  /** a tanító szakasz legalább ennyi mérkőzés */
  minTrainMatches: 300,
  /** a validációs szakasz (λ-választás) legalább ennyi mérkőzés */
  minValidationMatches: 100,
  /** az érintetlen, időben legkésőbbi holdout legalább ennyi mérkőzés … */
  minHoldoutMatches: 150,
  /** … és legalább ennyi tipp-megfigyelés */
  minHoldoutObservations: 400,
  /** a holdout ennyivel a tanító/validációs szakasz utolsó kezdése UTÁN kezdődik (szivárgás ellen) */
  embargoMs: 24 * 60 * 60 * 1000,
  /** a log loss relatív javulása a holdouton legalább ennyi (1%) */
  minRelativeLogLossImprovement: 0.01,
  /** páros (mérkőzés-szintű) bootstrap: ismétlésszám és megbízhatósági szint */
  bootstrapResamples: 2000,
  confidenceLevel: 0.95,
  /** piactípus-őr: ennyi holdout-mérkőzéstől és -megfigyeléstől „megfelelően mintázott” */
  marketGuardMinMatches: 50,
  marketGuardMinObservations: 100,
  /** piactípus-őr: ennél nagyobb relatív log loss romlás elutasít (2%) */
  marketGuardMaxRelativeDegradation: 0.02,
  /** a kalibrációs paraméterek értelmes tartománya (különben elutasítás) */
  slopeRange: [0.25, 4] as const,
  maxAbsIntercept: 3,
  /** piactípus-szintű paraméter csak ennyi tanító-mérkőzéstől (különben a globális) */
  minTypeTrainMatches: 200,
  /** a λ (zsugorítás az identitás felé, mérkőzés-súlyban) jelöltjei */
  lambdaGrid: [0.5, 2, 8, 32, 128] as const,
  /** egy kiértékelés legfeljebb ennyi sort olvas és ennyi ideig fut */
  maxRows: 100_000,
  timeBudgetMs: 20_000,
  /** a futás-zár (lease) élettartama – összeomlás után ennyi idő múlva újra futtatható */
  lockLeaseMs: 10 * 60 * 1000,
} as const;

/** Miért nem a kalibrált modell a kiszolgált modell – nyilvánosan nem jelenik meg. */
export const SERVING_NOTE =
  'A kiszolgált valószínűségek az alap motorból (xg-poisson-1) jönnek. Kalibrált modell kiszolgálásához az archívumnak '
  + 'a kiszolgált ÉS az alap valószínűséget is rögzítenie kell (hiányzó mező), ezért az élesítés jelenleg le van tiltva.';

export interface CalibrationParams {
  /** globális paraméterek: p' = σ(a + b·logit(p)) */
  global: { a: number; b: number };
  /** piactípus-szintű paraméterek (csak elegendő adatnál) */
  byMarketType: Record<string, { a: number; b: number }>;
  lambda: number;
}

export interface ScoreSummary {
  matches: number;
  observations: number;
  logLoss: number;
  brier: number;
  /** várt kalibrációs hiba (10 sáv, megfigyelés-súlyozott) */
  ece: number;
}

export interface ComparisonSummary {
  baseline: ScoreSummary;
  candidate: ScoreSummary;
  /** (alap − jelölt) mérkőzés-átlagolt log loss; pozitív = a jelölt jobb */
  logLossDelta: number;
  logLossDeltaCi: [number, number];
  relativeLogLossImprovement: number;
  brierDelta: number;
}

export interface GateResult {
  passed: boolean;
  reasons: string[];
}

/** Prospektív (árnyék) kiértékelés eredménye – az esemény-naplóba kerül. */
export interface ShadowEvaluationResult {
  candidateId: string;
  outcome: 'insufficient_data' | 'passed' | 'failed_gates' | 'failed';
  /** csak ennél KÉSŐBB generált és kezdődő meccsek számítanak (a jelölt nem láthatta őket) */
  cutoff: { generatedAfter: string; kickoffAfter: string };
  sizes: { matches: number; observations: number; servedByCandidate: number; shadowComputed: number };
  excluded: Record<string, number>;
  comparison?: ComparisonSummary;
  reasons: string[];
}

export interface LearningRunSummary {
  validObservations: number;
  validMatches: number;
  excluded: Record<string, number>;
  windows: {
    train?: [string, string];
    validation?: [string, string];
    holdout?: [string, string];
  };
  sizes?: { trainMatches: number; validationMatches: number; holdoutMatches: number; holdoutObservations: number };
  candidateId?: string;
  outcome: 'insufficient_data' | 'rejected' | 'eligible' | 'failed';
  reasons: string[];
}

/** Admin státusz – csak hitelesített adminnak. */
export interface LearningStatus {
  baselineEngineVersion: string;
  servedModel: string;
  servingNote: string;
  promotionEnabled: boolean;
  activeModelId: string | null;
  previousModelId: string | null;
  stateVersion: number;
  lastRun: {
    startedAt: string | null;
    finishedAt: string | null;
    status: string | null;
    error: string | null;
    summary: LearningRunSummary | null;
  };
  nextScheduledEvaluation: null;
  schedulingNote: string;
  locked: boolean;
  thresholds: typeof LEARNING_THRESHOLDS;
  candidates: {
    id: string;
    status: CalibrationStatus;
    statusReason: string | null;
    createdAt: string;
    metrics: unknown;
    gateResult: GateResult;
  }[];
  recentEvents: { at: string; kind: string; modelId: string | null; details: unknown }[];
}
