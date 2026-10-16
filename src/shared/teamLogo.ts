/**
 * Csapatcímer-URL ellenőrzése. Csak az adatforrás (ESPN) saját CDN-jéről származó, https-es
 * képcímet fogadunk el – nevet vagy azonosítót NEM alakítunk URL-lé, és más hosztot sem
 * engedünk (a szerver és a felület is ugyanezzel a szabállyal szűr).
 */
const ESPN_LOGO = /^https:\/\/a\.espncdn\.com\/[A-Za-z0-9/_.\-]+\.(png|svg)(\?[A-Za-z0-9=&_.\-%]*)?$/i;

export function safeTeamLogo(url: unknown): string | undefined {
  return typeof url === 'string' && url.length <= 300 && ESPN_LOGO.test(url) ? url : undefined;
}

/**
 * Az ESPN-csapatobjektum címere: a `logo` mező (scoreboard), vagy a `logos` listából az
 * alapértelmezett (nem sötét változatú) kép (teams / schedule végpont). Nincs ilyen → undefined.
 */
export function espnTeamLogo(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as { logo?: unknown; logos?: unknown };
  const direct = safeTeamLogo(t.logo);
  if (direct) return direct;
  if (!Array.isArray(t.logos)) return undefined;
  const logos = t.logos.filter((l): l is { href?: unknown; rel?: unknown } => !!l && typeof l === 'object');
  const rel = (l: { rel?: unknown }) => (Array.isArray(l.rel) ? l.rel.map(String) : []);
  const pick = logos.find((l) => rel(l).includes('default') && !rel(l).includes('dark')) ?? logos.find((l) => !rel(l).includes('dark'));
  return pick ? safeTeamLogo(pick.href) : undefined;
}
