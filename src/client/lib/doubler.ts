/**
 * Duplázó – tiszta segédfüggvények (lépésterv, összodds, kifizetés, szelvényválasztás).
 *
 * NINCS saját tippválasztó modell: a jelölt szelvényeket a MEGLÉVŐ szelvényépítő adja
 * (`GET /api/slips` → `buildSlips`: valódi oddsú lábak, mérkőzésenként legfeljebb egy láb, a modell
 * szerinti legnagyobb együttes esély). Itt csak az történik, ami a duplázáshoz kell:
 *  - a ~2,00-s összoddsú, megfelelő adatú szelvény kiválasztása a jelöltek közül,
 *  - az összodds újraszámolása a lábak tényleges oddsainak szorzatából,
 *  - kizárólag a felhasználó által kiválasztott nap mérkőzései; másik napra soha nem keres,
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

export type Rejection = 'missing_odds' | 'missing_kickoff' | 'duplicate_match' | 'weak_data' | 'odds_out_of_range' | 'other_day' | 'too_early' | 'used_match';

/** A jelöltek szűrése: legkorábbi megengedett kezdés, már használt mérkőzések, kötelező (helyi) nap. */
export interface SlipFilter { notBefore?: number; usedMatches?: Set<string>; onDate?: string }

/** Miért nem használható egy jelölt szelvény a Duplázóban (null: használható). */
export function rejectReason(slip: Slip, opts: SlipFilter = {}): Rejection | null {
  const total = totalOddsOf(slip.legs);
  if (total == null) return 'missing_odds';
  // értelmezhetetlen kezdés nélkül az időrend nem ellenőrizhető (NaN-nal minden összehasonlítás hamis lenne)
  if (slip.legs.some((l) => !Number.isFinite(Date.parse(l.kickoff)))) return 'missing_kickoff';
  const ids = slip.legs.map((l) => l.matchId);
  if (new Set(ids).size !== ids.length) return 'duplicate_match';
  if (ids.some((id) => opts.usedMatches?.has(id))) return 'used_match';
  if (slip.legs.some((l) => l.dataQuality === 'kevés' || !(l.modelProb > 0 && l.modelProb < 1))) return 'weak_data';
  if (total < ODDS_MIN || total > ODDS_MAX) return 'odds_out_of_range';
  // kizárólag a kiválasztott (helyi) nap mérkőzései – a szolgáltató napi bontása ettől eltérhet
  if (opts.onDate != null && slip.legs.some((l) => localDateKey(l.kickoff) !== opts.onDate)) return 'other_day';
  if (opts.notBefore != null && slip.legs.some((l) => Date.parse(l.kickoff) < opts.notBefore!)) return 'too_early';
  return null;
}

/** A szelvény utolsó mérkőzésének kezdése (ms). */
const lastKickoff = (slip: Slip) => Math.max(...slip.legs.map((l) => Date.parse(l.kickoff)));

/** A szelvény első mérkőzésének kezdése (ISO) – ekkor indul a lépés. */
export const firstKickoff = (slip: Slip) => new Date(Math.min(...slip.legs.map((l) => Date.parse(l.kickoff)))).toISOString();

/**
 * A választott szelvény a használhatók közül: a LEGKORÁBBI (az utolsó mérkőzése a legkorábban kezdődik –
 * így a sorozat a lehető leghamarabb haladhat); holtversenyben a modell szerinti nagyobb együttes esély,
 * majd a 2,00-hoz közelebbi összodds, végül a lábak (mérkőzés + piac) szerinti sorrend – így a választás a
 * jelöltek sorrendjétől függetlenül determinisztikus. Ha egyik jelölt sem felel meg, null – gyenge
 * szelvénnyel nem „töltjük ki” a lépést.
 */
export function pickSlip(slips: Slip[], opts: SlipFilter = {}): Slip | null {
  const ok = slips.filter((s) => rejectReason(s, opts) == null);
  ok.sort((a, b) => (lastKickoff(a) - lastKickoff(b))
    || (jointProbOf(b.legs) - jointProbOf(a.legs))
    || (Math.abs(totalOddsOf(a.legs)! - 2) - Math.abs(totalOddsOf(b.legs)! - 2))
    || signature(a).localeCompare(signature(b)));
  return ok[0] ?? null;
}

/** A szelvény azonosító lenyomata (rendezett mérkőzés:piac lista) – a végső, determinisztikus döntéshez. */
const signature = (slip: Slip) => slip.legs.map((l) => `${l.matchId}:${l.market}`).sort().join('|');

/** A szelvény utolsó mérkőzésének BECSÜLT vége (kezdés + 2,5 óra) – a következő lépés legkorábbi kezdete. */
export const slipEndsAt = (slip: Slip) => lastKickoff(slip) + MATCH_SPAN_MS;

/** Egy pillanat helyi naptári napja (YYYY-MM-DD) – ugyanaz a naptár, mint a `todayKey()`-é. */
export function localDateKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Rövid, a meglévő elemzés adataiból összerakott indoklás egy lábhoz (nincs kitalált szöveg). */
export function legReason(l: SlipLeg): string {
  const parts = [`a modell szerint ${Math.round(l.modelProb * 100)}% esély`];
  if (Number.isFinite(l.impliedProb)) parts.push(`az odds alapján ${Math.round(l.impliedProb * 100)}%`);
  parts.push(`${l.supportingIndicators} támogató statisztikai mutató`, `${l.dataQuality} adatminőség`);
  return parts.join(' · ');
}

/**
 * Egy szelvény-lekérés kliensoldali időkorlátja. A Render előtti Cloudflare kb. 100 mp után CORS-fejléc nélküli
 * hibaoldallal (524) bontja a kapcsolatot – ezt a böngésző csak egy átláthatatlan „Failed to fetch”-ként
 * jelzi. A kliens ELŐTTE, saját maga szakítja meg a kérést (egyértelmű időtúllépés-hiba): a kliens órája a
 * kérés elküldése előtt indul, ezért mindig legalább annyit mér, mint a Cloudflare-é – 90 mp-nél így kb.
 * 10 mp tartalék marad. A szerver a megszakított elemzést befejezi és gyorsítótárazza, így az újrakérés gyors.
 */
export const REQUEST_TIMEOUT_MS = 90_000;
/**
 * Átmeneti hiba után ennyit várunk a következő próbálkozás előtt (lekérésenként legfeljebb 3 kísérlet).
 * A szerver a megszakadt kérés elemzését is befejezi és 5 percig gyorsítótárazza (a folyamatban lévőhöz
 * csatlakozik, nem indítja újra) – ezért az újrapróbálkozás jellemzően már gyors és sikeres.
 */
export const RETRY_DELAYS_MS = [10_000, 30_000];

/** A kiválasztott napra nincs megfelelő duplázó – a felületen is pontosan ez a szöveg jelenik meg. */
export const NO_DOUBLER_TEXT = 'A kiválasztott napra nem található megfelelő duplázó.';

export interface ChainStep {
  row: StepRow;
  /** a kiválasztott nap (YYYY-MM-DD) – minden lépés ebből dolgozik */
  date: string;
  slip: Slip | null;
  totalOdds: number | null;
  payout: number | null;
  /** miért nincs szelvény (ha nincs) */
  note: string | null;
  /** true: nincs szelvény, de NEM azért, mert nincs megfelelő tipp – a lekérés hiba miatt nem sikerült */
  incomplete: boolean;
}

export type SlipFetcher = (params: Record<string, string | undefined>, signal?: AbortSignal) => Promise<{ slips: Slip[] }>;

/** Egy napi lekérés kimenete: a jelöltek, vagy a végleges (átmeneti, de kifogyott próbálkozású) hiba. */
export type DayFetchResult = { ok: true; slips: Slip[] } | { ok: false; error: string };

export interface ChainOptions {
  timeoutMs?: number;
  retryDelaysMs?: number[];
  /** várakozás (tesztben helyettesíthető) */
  sleep?: (ms: number) => Promise<void>;
}

export interface ChainProgress { step: number; attempt: number }

const statusOf = (e: unknown): number | undefined => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/** Átmeneti-e a hiba: hálózati / CORS nélküli proxyhiba („Failed to fetch”), időtúllépés, 5xx, 408 vagy 429. */
export function isRetryable(e: unknown): boolean {
  if ((e as { name?: unknown } | null)?.name === 'AbortError') return true;
  if (e instanceof TypeError) return true;
  const status = statusOf(e);
  return status != null && (status >= 500 || status === 408 || status === 429);
}

/** Érthető magyar leírás egy végleg sikertelen napi lekéréshez. */
export function fetchErrorText(e: unknown): string {
  if ((e as { name?: unknown } | null)?.name === 'AbortError') return 'a szerver nem válaszolt időben';
  if (e instanceof TypeError) return 'megszakadt a kapcsolat a szerverrel, vagy a szerver nem válaszolt időben';
  const status = statusOf(e);
  if (status === 429) return 'túl sok kérés – a szerver átmenetileg korlátozza a lekéréseket';
  return status != null ? `szerverhiba (${status})` : 'ismeretlen hiba';
}

/**
 * Egy napi lekérés időkorláttal és korlátozott számú újrapróbálkozással. Átmeneti hibánál várakozás után
 * újra kér (egyszerre mindig csak egy kérés fut); a végleges átmeneti hibát EREDMÉNYKÉNT adja vissza
 * (`ok: false`), nem dobja. Nem átmeneti hiba (pl. 400, 401, 403 – jogosultság) azonnal továbbdobódik:
 * azt újrapróbálni értelmetlen, és a keresés sem folytatható.
 */
export async function fetchDayWithRetry(
  fetchSlips: SlipFetcher,
  params: Record<string, string | undefined>,
  opts: ChainOptions & { onAttempt?: (attempt: number) => void } = {},
): Promise<DayFetchResult> {
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    opts.onAttempt?.(attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      return { ok: true, slips: (await fetchSlips(params, ctrl.signal)).slips };
    } catch (e) {
      if (!isRetryable(e)) throw e;
      console.warn(`[duplázó] ${params.from} (${params.legs} láb) lekérése sikertelen, ${attempt}. kísérlet:`, (e as Error)?.message ?? e);
      if (attempt > delays.length) return { ok: false, error: fetchErrorText(e) };
      await sleep(delays[attempt - 1]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A lépések szelvényei – KIZÁRÓLAG a kiválasztott nap (`date`, YYYY-MM-DD) mérkőzéseiből. Másik napot soha
 * nem kér le és nem keres: ha a napon nincs (több) megfelelő szelvény, a sorozat ott megáll.
 *
 * A meglévő szelvényépítőtől előbb 2, majd 3 lábas jelölteket kér (a szűrők változatlanok); egy lábszámot
 * egy futás alatt csak egyszer kér le – minden lépés ugyanabból a napi jelöltlistából választ. A választás a
 * meglévő `pickSlip` (legkorábbi megfelelő, majd nagyobb modell-esély). Kizárva: a már elkezdődött
 * (`now` előtti) mérkőzés, a más napon kezdődő mérkőzés, az előző lépés mérkőzéseinek becsült vége előtt
 * kezdődő mérkőzés és a sorozatban már szereplő mérkőzés.
 *
 * HIBAKEZELÉS: a lekérés időkorláttal és korlátozott újrapróbálkozással fut (`fetchDayWithRetry`). Ha egy
 * lekérés végleg sikertelen, a lépés NEM „nincs megfelelő duplázó”, hanem „a keresés nem fejeződött be”
 * (`incomplete`), és a sorozat ott megáll. Nem átmeneti hiba (pl. 403) azonnal továbbdobódik.
 */
export async function buildChain(
  rows: StepRow[],
  date: string,
  fetchSlips: SlipFetcher,
  onProgress?: (p: ChainProgress) => void,
  now: number = Date.now(),
  opts: ChainOptions = {},
): Promise<ChainStep[]> {
  const out: ChainStep[] = [];
  const used = new Set<string>();
  const cache = new Map<number, Promise<DayFetchResult>>();
  let step = 0;
  const fetchLegs = (legs: number) => {
    if (!cache.has(legs)) {
      cache.set(legs, fetchDayWithRetry(
        fetchSlips,
        { from: date, to: date, legs: String(legs), minOdds: String(ODDS_MIN), minLegProb: String(MIN_LEG_PROB) },
        { ...opts, onAttempt: (attempt) => onProgress?.({ step, attempt }) },
      ));
    }
    return cache.get(legs)!;
  };
  // a pontosan „most” kezdődő mérkőzés már elkezdettnek számít: csak a most UTÁN kezdődő választható
  let notBefore = now + 1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    step = row.step;
    let slip: Slip | null = null;
    let failure: string | null = null;
    for (const legs of LEG_COUNTS) {
      const res = await fetchLegs(legs);
      if (!res.ok) { failure = res.error; break; }
      slip = pickSlip(res.slips, { notBefore, usedMatches: used, onDate: date });
      if (slip) break;
    }
    if (!slip) {
      const incomplete = failure != null;
      out.push({
        row, date, slip: null, totalOdds: null, payout: null, incomplete,
        note: incomplete
          ? `A keresés nem fejeződött be: a szelvények lekérése többszöri próbálkozás után sem sikerült (${failure}). Ez nem azt jelenti, hogy nincs megfelelő tipp – próbáld újra néhány perc múlva.`
          : i === 0
            ? NO_DOUBLER_TEXT
            : `Ezen a napon nincs több megfelelő mérkőzés a(z) ${row.step}. lépéshez – a sorozat itt megáll.`,
      });
      for (const rest of rows.slice(i + 1)) {
        out.push({
          row: rest, date, slip: null, totalOdds: null, payout: null, incomplete: false,
          note: incomplete ? 'Nem generálható: az előző lépés keresése nem fejeződött be.' : 'Nem generálható: az előző lépéshez nincs szelvény.',
        });
      }
      break;
    }
    const totalOdds = totalOddsOf(slip.legs)!;
    for (const l of slip.legs) used.add(l.matchId);
    notBefore = slipEndsAt(slip);
    out.push({ row, date, slip, totalOdds, payout: grossPayout(row.stake, totalOdds), note: null, incomplete: false });
  }
  return out;
}

/** Egy generálás eredménye a napjával együtt – a felület csak a kiválasztott nap eredményét mutatja. */
export interface ChainResult { date: string; chain: ChainStep[] }

/**
 * A megjeleníthető lánc: csak ha az eredmény a KIVÁLASZTOTT naphoz tartozik. Dátumváltás után a korábbi
 * (akár később befejeződő) generálás eredménye így sosem marad félrevezetően a felületen.
 */
export const chainForDate = (result: ChainResult | null, date: string): ChainStep[] | null =>
  (result && result.date === date ? result.chain : null);

/** Legfeljebb ennyi nappal előre választható nap (a szolgáltató menetrendje ennél távolabbra ritkán teljes). */
export const MAX_DAYS_AHEAD = 30;

/** A választott nap ellenőrzése: valós YYYY-MM-DD dátum, a mai nap vagy későbbi, legfeljebb `MAX_DAYS_AHEAD` nappal előre. */
export function checkDoublerDate(date: string, today: string, lastDay: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Válassz érvényes dátumot.';
  const [y, m, d] = date.split('-').map(Number);
  const real = new Date(Date.UTC(y, m - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return 'Válassz érvényes dátumot.';
  if (date < today) return 'Múltbeli napra nem készíthető duplázó – a mérkőzések már elkezdődtek.';
  if (date > lastDay) return `Legfeljebb ${MAX_DAYS_AHEAD} nappal előre választhatsz napot.`;
  return null;
}

/** A teljes sorozat modell szerinti esélye: a lépések együttes esélyeinek szorzata (csak teljes láncra). */
export function chainProbability(steps: ChainStep[]): number | null {
  if (!steps.length || steps.some((s) => !s.slip)) return null;
  return steps.reduce((p, s) => p * jointProbOf(s.slip!.legs), 1);
}
