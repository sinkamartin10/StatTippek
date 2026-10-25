/**
 * Duplázó – tiszta segédfüggvények (lépésterv, összodds, kifizetés, szelvényválasztás).
 *
 * NINCS saját tippválasztó modell: a jelölt szelvényeket a MEGLÉVŐ szelvényépítő adja
 * (`GET /api/slips` → `buildSlips`: valódi oddsú lábak, mérkőzésenként legfeljebb egy láb, a modell
 * szerinti legnagyobb együttes esély). Itt csak az történik, ami a duplázáshoz kell:
 *  - a ~2,00-s összoddsú, megfelelő adatú szelvény kiválasztása a jelöltek közül,
 *  - az összodds újraszámolása a lábak tényleges oddsainak szorzatából,
 *  - a lépések időrendje: egy lépés csak az előző lépés mérkőzéseinek BECSÜLT vége után kezdődhet, mert a
 *    következő tét az előző nyereménye.
 * Oddsot, mérkőzést vagy tippet SOHA nem pótolunk: ha nincs megfelelő szelvény, a lépés üres marad.
 */
import type { Slip, SlipLeg } from '@shared/types';

export const DEFAULT_STAKE = 1000;
export const MIN_STAKE = 100;
export const MAX_STAKE = 1_000_000;
/** A lánc legfeljebb ennyi lépés (64-szeres cél) – hosszabb sorozat esélye gyakorlatilag nulla. */
export const MAX_STEPS = 6;
export const TARGET_PRESETS = [4000, 8000, 16000, 32000];

/** A „körülbelül 2,00” összodds tartománya. Az alsó határt a szerver is megkapja (`minOdds`). */
export const ODDS_MIN = 1.9;
export const ODDS_MAX = 2.3;
/** Láb modell-valószínűség alsó határa a szelvényépítőnek. */
export const MIN_LEG_PROB = 0.55;
/** Előbb 2, majd 3 lábas szelvényt keresünk – kevesebb láb, nagyobb együttes esély. */
export const LEG_COUNTS = [2, 3];
/**
 * BECSÜLT lezárási idő a kezdéstől (szünettel, ráadással). Csak a lépések időrendjéhez használt becslés,
 * nem garantált mérkőzésvég: hosszabbítás, csúszás vagy halasztás esetén a tényleges elszámolás a mérvadó.
 */
export const MATCH_SPAN_MS = 2.5 * 3600_000;

/** Forint-összeg beolvasása: szóköz, pont és „Ft” megengedett; csak pozitív egész. */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/ft/i, '').replace(/[\s.\u00A0]/g, '');
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** Forint-\u00F6sszeg ezres tagol\u00E1ssal (1 000 Ft) \u2013 a b\u00F6ng\u00E9sz\u0151 nyelvi be\u00E1ll\u00EDt\u00E1s\u00E1t\u00F3l f\u00FCggetlen\u00FCl. */
export const fmtFt = (n: number) => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Ft`;

export interface StepRow { step: number; stake: number; goal: number }

export type Plan =
  | { ok: true; steps: number; rows: StepRow[]; finalAmount: number; exact: boolean; lower: number | null; upper: number }
  | { ok: false; error: string };

/**
 * Lépésterv: hány duplázás kell a célhoz. A lépésszám a legkisebb k, amelyre kezdő × 2^k ≥ cél
 * (egész aritmetikával, lebegőpontos log nélkül). Ha a cél nem pontos duplázás, a legközelebbi
 * elérhető összegek: alatta (kezdő × 2^(k−1), ha az már legalább egy lépés) és fölötte (kezdő × 2^k).
 */
export function planSteps(stake: number | null, target: number | null): Plan {
  if (stake == null || !Number.isInteger(stake) || stake < MIN_STAKE || stake > MAX_STAKE) {
    return { ok: false, error: `A kezdőösszeg ${fmtFt(MIN_STAKE)} és ${fmtFt(MAX_STAKE)} közötti egész szám lehet.` };
  }
  if (target == null || !Number.isInteger(target)) {
    return { ok: false, error: 'Adj meg érvényes célösszeget (egész forint).' };
  }
  if (target <= stake) {
    return { ok: false, error: 'A célösszegnek nagyobbnak kell lennie a kezdőösszegnél.' };
  }
  let steps = 0;
  let amount = stake;
  while (amount < target) { amount *= 2; steps++; }
  if (steps > MAX_STEPS) {
    return { ok: false, error: `Legfeljebb ${MAX_STEPS} lépés (${fmtFt(stake * 2 ** MAX_STEPS)}) tervezhető – minden további lépés tovább csökkenti a teljes sorozat esélyét.` };
  }
  const rows: StepRow[] = Array.from({ length: steps }, (_, i) => ({ step: i + 1, stake: stake * 2 ** i, goal: stake * 2 ** (i + 1) }));
  const exact = amount === target;
  return { ok: true, steps, rows, finalAmount: amount, exact, lower: exact || steps < 2 ? null : amount / 2, upper: amount };
}

/** Az összodds a lábak tényleges oddsainak szorzata, két tizedesre kerekítve (ahogy a szelvényen áll). */
export function totalOddsOf(legs: Pick<SlipLeg, 'odds'>[]): number | null {
  if (!legs.length) return null;
  let p = 1;
  for (const l of legs) {
    if (typeof l.odds !== 'number' || !Number.isFinite(l.odds) || l.odds <= 1) return null;
    p *= l.odds;
  }
  return Math.round((p + Number.EPSILON) * 100) / 100;
}

/** Becsült bruttó kifizetés: tét × összodds (egész forintra kerekítve). Nem garantált nyeremény. */
export const grossPayout = (stake: number, totalOdds: number) => Math.round(stake * totalOdds);

/** A lábak modell-valószínűségeinek szorzata (függetlenséget feltételez – ahogy a szelvényépítő is). */
export const jointProbOf = (legs: Pick<SlipLeg, 'modelProb'>[]) => legs.reduce((p, l) => p * l.modelProb, 1);

export type Rejection = 'missing_odds' | 'duplicate_match' | 'weak_data' | 'odds_out_of_range' | 'too_early' | 'used_match';

/** Miért nem használható egy jelölt szelvény a Duplázóban (null: használható). */
export function rejectReason(slip: Slip, opts: { notBefore?: number; usedMatches?: Set<string> } = {}): Rejection | null {
  const total = totalOddsOf(slip.legs);
  if (total == null) return 'missing_odds';
  const ids = slip.legs.map((l) => l.matchId);
  if (new Set(ids).size !== ids.length) return 'duplicate_match';
  if (ids.some((id) => opts.usedMatches?.has(id))) return 'used_match';
  if (slip.legs.some((l) => l.dataQuality === 'kevés' || !(l.modelProb > 0 && l.modelProb < 1))) return 'weak_data';
  if (total < ODDS_MIN || total > ODDS_MAX) return 'odds_out_of_range';
  if (opts.notBefore != null && slip.legs.some((l) => Date.parse(l.kickoff) < opts.notBefore!)) return 'too_early';
  return null;
}

/**
 * A legjobb használható szelvény: a modell szerinti legnagyobb együttes esély; holtversenyben a 2,00-hoz
 * közelebbi összodds. Ha egyik jelölt sem felel meg, null – gyenge szelvénnyel nem „töltjük ki” a lépést.
 */
export function pickSlip(slips: Slip[], opts: { notBefore?: number; usedMatches?: Set<string> } = {}): Slip | null {
  const ok = slips.filter((s) => rejectReason(s, opts) == null);
  ok.sort((a, b) => (jointProbOf(b.legs) - jointProbOf(a.legs))
    || (Math.abs(totalOddsOf(a.legs)! - 2) - Math.abs(totalOddsOf(b.legs)! - 2)));
  return ok[0] ?? null;
}

/** A szelvény utolsó mérkőzésének BECSÜLT vége (kezdés + 2,5 óra) – a következő lépés legkorábbi kezdete. */
export const slipEndsAt = (slip: Slip) => Math.max(...slip.legs.map((l) => Date.parse(l.kickoff))) + MATCH_SPAN_MS;

/** Rövid, a meglévő elemzés adataiból összerakott indoklás egy lábhoz (nincs kitalált szöveg). */
export function legReason(l: SlipLeg): string {
  const parts = [`a modell szerint ${Math.round(l.modelProb * 100)}% esély`];
  if (Number.isFinite(l.impliedProb)) parts.push(`az odds alapján ${Math.round(l.impliedProb * 100)}%`);
  parts.push(`${l.supportingIndicators} támogató statisztikai mutató`, `${l.dataQuality} adatminőség`);
  return parts.join(' · ');
}

export interface ChainStep {
  row: StepRow;
  /** a lépés napja (YYYY-MM-DD) */
  date: string;
  slip: Slip | null;
  totalOdds: number | null;
  payout: number | null;
  /** miért nincs szelvény (ha nincs) */
  note: string | null;
}

export type SlipFetcher = (params: Record<string, string | undefined>) => Promise<{ slips: Slip[] }>;

/**
 * A lépések szelvényei: az i. lépés az i. nap (ma, holnap, …) mérkőzéseiből, és csak az előző lépés
 * mérkőzéseinek vége után kezdődő lábakból áll. Az első hiányzó lépésnél megáll – a lánc ott megszakad,
 * a későbbi lépésekhez nem generálunk szelvényt.
 */
export async function buildChain(
  rows: StepRow[],
  dateOf: (offsetDays: number) => string,
  fetchSlips: SlipFetcher,
  onProgress?: (step: number) => void,
): Promise<ChainStep[]> {
  const out: ChainStep[] = [];
  const used = new Set<string>();
  let notBefore: number | undefined;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const date = dateOf(i);
    onProgress?.(row.step);
    let slip: Slip | null = null;
    for (const legs of LEG_COUNTS) {
      const r = await fetchSlips({ from: date, to: date, legs: String(legs), minOdds: String(ODDS_MIN), minLegProb: String(MIN_LEG_PROB) });
      slip = pickSlip(r.slips, { notBefore, usedMatches: used });
      if (slip) break;
    }
    if (!slip) {
      out.push({ row, date, slip: null, totalOdds: null, payout: null, note: 'Erre a napra nincs megfelelő adatokkal rendelkező, kb. 2,00-s összoddsú szelvény.' });
      for (const rest of rows.slice(i + 1)) {
        out.push({ row: rest, date: dateOf(rest.step - 1), slip: null, totalOdds: null, payout: null, note: 'Nem generálható: az előző lépéshez nincs szelvény.' });
      }
      break;
    }
    const totalOdds = totalOddsOf(slip.legs)!;
    for (const l of slip.legs) used.add(l.matchId);
    notBefore = slipEndsAt(slip);
    out.push({ row, date, slip, totalOdds, payout: grossPayout(row.stake, totalOdds), note: null });
  }
  return out;
}

/** A teljes sorozat modell szerinti esélye: a lépések együttes esélyeinek szorzata (csak teljes láncra). */
export function chainProbability(steps: ChainStep[]): number | null {
  if (!steps.length || steps.some((s) => !s.slip)) return null;
  return steps.reduce((p, s) => p * jointProbOf(s.slip!.legs), 1);
}
