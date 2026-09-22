/**
 * Piackódok, magyar címkék és eredmény-kiértékelés.
 * A piackód a rendszer belső, nyelvfüggetlen azonosítója (pl. "O2.5"),
 * a címke a felhasználónak megjelenített magyar szöveg.
 */

export const MARKET_LABELS: Record<string, string> = {
  '1': 'Hazai győzelem (1)',
  X: 'Döntetlen (X)',
  '2': 'Vendég győzelem (2)',
  '1X': 'Dupla esély 1X',
  X2: 'Dupla esély X2',
  '12': 'Dupla esély 12',
  DNB_1: 'Döntetlennél tét vissza – hazai',
  DNB_2: 'Döntetlennél tét vissza – vendég',
  'O0.5': 'Gólszám több mint 0,5',
  'O1.5': 'Gólszám több mint 1,5',
  'O2.5': 'Gólszám több mint 2,5',
  'O3.5': 'Gólszám több mint 3,5',
  'O4.5': 'Gólszám több mint 4,5',
  'U1.5': 'Gólszám kevesebb mint 1,5',
  'U2.5': 'Gólszám kevesebb mint 2,5',
  'U3.5': 'Gólszám kevesebb mint 3,5',
  'U4.5': 'Gólszám kevesebb mint 4,5',
  BTTS_Y: 'Mindkét csapat szerez gólt – igen',
  BTTS_N: 'Mindkét csapat szerez gólt – nem',
  'HOME_O0.5': 'Hazai csapat több mint 0,5 gól',
  'HOME_O1.5': 'Hazai csapat több mint 1,5 gól',
  'AWAY_O0.5': 'Vendég csapat több mint 0,5 gól',
  'AWAY_O1.5': 'Vendég csapat több mint 1,5 gól',
  'AH_HOME_-1': 'Ázsiai hendikep hazai -1,0',
};

export function marketLabel(market: string): string {
  if (MARKET_LABELS[market]) return MARKET_LABELS[market];
  if (market.startsWith('CS_')) {
    const [h, a] = market.slice(3).split('-');
    return `Pontos eredmény ${h}–${a}`;
  }
  return market;
}

/** Piactípus a "Mai tippek" szűrőhöz */
export type MarketType = '1X2' | 'dupla esély' | 'gólszám' | 'BTTS' | 'csapat gólszám' | 'pontos eredmény' | 'hendikep' | 'egyéb';

export function marketType(market: string): MarketType {
  if (['1', 'X', '2'].includes(market)) return '1X2';
  if (['1X', 'X2', '12', 'DNB_1', 'DNB_2'].includes(market)) return 'dupla esély';
  if (/^[OU]\d\.5$/.test(market)) return 'gólszám';
  if (market.startsWith('BTTS')) return 'BTTS';
  if (market.startsWith('HOME_O') || market.startsWith('AWAY_O')) return 'csapat gólszám';
  if (market.startsWith('CS_')) return 'pontos eredmény';
  if (market.startsWith('AH_')) return 'hendikep';
  return 'egyéb';
}

export type MarketOutcome = 'win' | 'loss' | 'void';

/**
 * Egy piac kiértékelése a végeredmény alapján.
 * A "void" a tét-visszajáró eseteket jelöli (döntetlennél tét vissza, ázsiai push).
 */
export function evaluateMarket(market: string, hg: number, ag: number): MarketOutcome {
  const total = hg + ag;
  const w = (c: boolean): MarketOutcome => (c ? 'win' : 'loss');
  switch (market) {
    case '1': return w(hg > ag);
    case 'X': return w(hg === ag);
    case '2': return w(ag > hg);
    case '1X': return w(hg >= ag);
    case 'X2': return w(ag >= hg);
    case '12': return w(hg !== ag);
    case 'DNB_1': return hg === ag ? 'void' : w(hg > ag);
    case 'DNB_2': return hg === ag ? 'void' : w(ag > hg);
    case 'BTTS_Y': return w(hg > 0 && ag > 0);
    case 'BTTS_N': return w(!(hg > 0 && ag > 0));
    case 'AH_HOME_-1': return hg - ag === 1 ? 'void' : w(hg - ag > 1);
  }
  let m = market.match(/^([OU])(\d\.5)$/);
  if (m) {
    const line = parseFloat(m[2]);
    return w(m[1] === 'O' ? total > line : total < line);
  }
  m = market.match(/^(HOME|AWAY)_O(\d\.5)$/);
  if (m) {
    const line = parseFloat(m[2]);
    return w((m[1] === 'HOME' ? hg : ag) > line);
  }
  m = market.match(/^CS_(\d+)-(\d+)$/);
  if (m) return w(hg === parseInt(m[1]) && ag === parseInt(m[2]));
  throw new Error(`Ismeretlen piac: ${market}`);
}

/**
 * Szabad szöveges (pl. angol nyelvű) tipp piackóddá alakítása.
 * Csak egyértelmű mintákra ad vissza értéket; ha bizonytalan, null.
 */
export function parsePredictionText(text: string, homeName?: string, awayName?: string): string | null {
  const t = text.toLowerCase().replace(/,/g, '.');
  // Csapatnév-alapú minták ("Arsenal to win", "Arsenal to beat …", "Arsenal win") – csak ha a név adott
  const nameWin = (name?: string) => {
    if (!name) return false;
    const n = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter((w) => w.length > 3)[0];
    if (!n) return false;
    return new RegExp(`\\b${n}\\b[^.]{0,25}\\b(to win|to beat|to edge|win\\b|victory|győz)`).test(t);
  };
  const hw = nameWin(homeName), aw = nameWin(awayName);
  if (hw && !aw) return '1';
  if (aw && !hw) return '2';
  let m = t.match(/(over|több mint)\s*(\d\.5)/);
  if (m) return `O${m[2]}`;
  m = t.match(/(under|kevesebb mint)\s*(\d\.5)/);
  if (m) return `U${m[2]}`;
  if (/(btts|both teams to score|mindkét csapat).*(no|nem)\b/.test(t)) return 'BTTS_N';
  if (/(btts|both teams to score|gg\b|mindkét csapat)/.test(t)) return 'BTTS_Y';
  if (/(home win|hazai győzelem|home to win|1x2:\s*1\b)/.test(t)) return '1';
  if (/(away win|vendég győzelem|away to win|1x2:\s*2\b)/.test(t)) return '2';
  if (/\bdraw\b|döntetlen/.test(t) && !/no bet|tét vissza/.test(t)) return 'X';
  if (/double chance 1x|dupla esély 1x/.test(t)) return '1X';
  if (/double chance x2|dupla esély x2/.test(t)) return 'X2';
  m = t.match(/correct score\s*(\d)\s*[-–:]\s*(\d)/);
  if (m) return `CS_${m[1]}-${m[2]}`;
  return null;
}
