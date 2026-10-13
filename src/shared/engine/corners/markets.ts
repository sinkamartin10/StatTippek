/**
 * Szögletpiacok – elkülönített piackódok és szöglet-specifikus elszámolás.
 *
 * Minden szögletpiac `CRN_` előtagú (pl. `CRN_O9.5`, `CRN_HOME_O4.5`), így a
 * gólpiaci minták (`^[OU]\d\.5$`, `^(HOME|AWAY)_O\d\.5$`, …) sosem illeszkednek rá,
 * és a gólpiaci `evaluateMarket` ismeretlen piacként utasítja el (az archívum
 * ilyenkor „nem elszámolható” állapotot ad – sosem nyert/vesztett).
 *
 * A szögletpiac elszámolása KIZÁRÓLAG hiteles, meccsvégi szögletszámból
 * történhet; ha nincs ilyen, az eredmény `null` (függőben marad).
 */
export const CORNER_MARKET_PREFIX = 'CRN_';

export type CornerScope = 'total' | 'home' | 'away';

export const CORNER_LINES: Record<CornerScope, number[]> = {
  total: [7.5, 8.5, 9.5, 10.5, 11.5, 12.5],
  home: [2.5, 3.5, 4.5, 5.5, 6.5],
  away: [2.5, 3.5, 4.5, 5.5, 6.5],
};

const RE = /^CRN_(?:(HOME|AWAY)_)?([OU])(\d{1,2}\.5)$/;

export function isCornerMarket(market: string): boolean {
  return RE.test(market);
}

export function cornerMarketCode(scope: CornerScope, side: 'O' | 'U', line: number): string {
  const s = scope === 'total' ? '' : `${scope.toUpperCase()}_`;
  return `${CORNER_MARKET_PREFIX}${s}${side}${line.toFixed(1)}`;
}

export function parseCornerMarket(market: string): { scope: CornerScope; side: 'O' | 'U'; line: number } | null {
  const m = market.match(RE);
  if (!m) return null;
  return { scope: m[1] === 'HOME' ? 'home' : m[1] === 'AWAY' ? 'away' : 'total', side: m[2] as 'O' | 'U', line: parseFloat(m[3]) };
}

const fmtLine = (l: number) => l.toFixed(1).replace('.', ',');

export function cornerMarketLabel(market: string): string {
  const p = parseCornerMarket(market);
  if (!p) return market;
  const who = p.scope === 'total' ? 'Összes szöglet' : p.scope === 'home' ? 'Hazai szögletek' : 'Vendég szögletek';
  return `${who}: ${p.side === 'O' ? 'több mint' : 'kevesebb mint'} ${fmtLine(p.line)}`;
}

const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Szögletpiac elszámolása a HITELES meccsvégi szögletszámból.
 * Hiányzó vagy érvénytelen szögletszám → null (a tipp függőben marad).
 * Ismeretlen (nem CRN_) piac → null: gólpiacot itt sosem számolunk el.
 */
export function evaluateCornerMarket(market: string, homeCorners: unknown, awayCorners: unknown): 'win' | 'loss' | null {
  const p = parseCornerMarket(market);
  if (!p || !validCount(homeCorners) || !validCount(awayCorners)) return null;
  const v = p.scope === 'total' ? homeCorners + awayCorners : p.scope === 'home' ? homeCorners : awayCorners;
  const over = v > p.line;
  return (p.side === 'O' ? over : !over) ? 'win' : 'loss';
}
