/**
 * SEO – egyetlen útvonaltábla a Worker (szerveroldali meta, státuszkód, indexelés) és a kliens
 * (cím frissítése kliensoldali navigáció után) számára. A sitemap URL-listája is innen jön.
 *
 * Szabályok:
 *  - `index: true` csak a vendégként is tartalmat adó, nyilvános oldalakon (ezek kerülnek a sitemapbe);
 *  - a privát (belépési, admin-, személyes) és a vékony / felhasználói tartalmú oldalak `noindex`-et kapnak;
 *  - ismeretlen útvonal: 404 + `noindex`, „Az oldal nem található” metaadatokkal (nem normál oldalként);
 *  - canonical CSAK indexelhető oldalon, mindig az elsődleges domainen, query string nélkül.
 * A metaadatok a ténylegesen látható oldaltartalomhoz igazodnak.
 */
export const SITE_ORIGIN = 'https://tippstats.hu';
export const SITE_NAME = 'TippStats';
export const OG_IMAGE = '/og-image.png';

export interface RouteMeta {
  title: string;
  description: string;
  /** indexelhető-e (canonical és sitemap csak ilyenkor) */
  index: boolean;
  /** 200 – létező útvonal; 404 – ismeretlen */
  status: 200 | 404;
  /** az oldal kanonikus útvonala (indexelhető oldalon), egyébként null */
  canonicalPath: string | null;
}

type Entry = { title: string; description: string; index: boolean };

const PUBLIC: Record<string, Entry> = {
  '/': {
    title: 'TippStats – AI-alapú futballstatisztika és mérkőzéselemzés',
    description: 'Futballstatisztikák, xG-alapú mérkőzéselemzés és AI-meccsszimuláció a topligákhoz és kupákhoz. Tippelj, versenyezz 1v1-ben, és kövesd a statisztikáidat.',
    index: true,
  },
  '/pro': {
    title: 'TippStats PRO – teljes AI-mérkőzéselemzés minden meccshez',
    description: 'A PRO-val megnyílik minden mérkőzés, minden piac és a modell teljes indoklása: szögletstatisztikák, több ligás AI-modell és teljes meccsszimuláció. Havi vagy heti csomag.',
    index: true,
  },
  '/meccsek': {
    title: 'Mai meccsek – mérkőzések ligánként | TippStats',
    description: 'A nap futballmérkőzései ligánként: kezdési időpontok, adatminőség és a TippStats statisztikai elemzései egy helyen.',
    index: true,
  },
  '/elemzes': {
    title: 'Mérkőzéselemzés – xG, forma és Poisson-modell | TippStats',
    description: 'Válassz mérkőzést a következő 3 napból: a kutatómotor és a statisztikai modellek (várható gól, Poisson) részletes elemzést készítenek.',
    index: true,
  },
  '/tippek': {
    title: 'Statisztikailag támogatott tippek | TippStats',
    description: 'Statisztikailag támogatott piacok a modell alapján, mérhető szűrőkkel. Nincs „legjobb tipp” pontszám – nem fogadási tanács.',
    index: true,
  },
  '/statisztikak': {
    title: 'Futballstatisztikák – tabella, forma és gólok | TippStats',
    description: 'Tabella, forma és gólstatisztikák bajnokságonként az elérhető lejátszott mérkőzésekből.',
    index: true,
  },
  '/modell-archivum': {
    title: 'Modell-tipp archívum – a statisztikai motor eredményei | TippStats',
    description: 'A statisztikai motor (xG + Poisson) minden rögzített tippje a valós végeredménnyel elszámolva – a vesztes tippek is, utólagos módosítás nélkül.',
    index: true,
  },
  '/eloorejelzesek-teljesitmenye': {
    title: 'AI futball-előrejelzések teljesítménye | TippStats',
    description: 'Nézd meg a TippStats AI-futball-előrejelzéseinek korábbi eredményeit, találati arányát és teljesítményét.',
    index: true,
  },
  '/tippverseny': {
    title: 'Tippverseny – pontok és ranglista | TippStats',
    description: 'Tippeld meg a mérkőzések végeredményét, és gyűjts pontokat: pontos eredmény 5 pont, helyes kimenetel 3 pont.',
    index: true,
  },
  '/kozosseg': {
    title: 'Közösség – játékosok bejegyzései és tippjei | TippStats',
    description: 'A TippStats közösségi oldala: a játékosok gondolatai és előrejelzései a mérkőzésekről. Olvasd a bejegyzéseket, lájkold őket, és oszd meg a sajátodat.',
    index: true,
  },
  '/duplazo': {
    title: 'Duplázó – lépésenkénti 2,00-s szelvényterv | TippStats',
    description: 'Számold ki, hány duplázás kell a célösszegedhez, és nézd meg a lépésenkénti, kb. 2,00-s összoddsú szelvényeket valódi oddsokkal (PRO). Becslés, nem garantált nyeremény.',
    index: true,
  },
  '/forrasok': {
    title: 'Források – honnan jönnek az adatok? | TippStats',
    description: 'Minden külső információ forrással, URL-lel és lekérési idővel. URL nélküli tétel nem tekinthető ellenőrzöttnek.',
    index: true,
  },
};

const NOINDEX_DESC = 'TippStats – futballstatisztika és mérkőzéselemzés.';
/** létező, de nem indexelendő statikus útvonalak (privát, belépési, admin-, személyes vagy vékony tartalmú) */
const PRIVATE: Record<string, string> = {
  '/dashboard': 'Áttekintés', '/bejelentkezes': 'Bejelentkezés', '/regisztracio': 'Regisztráció',
  '/elfelejtett-jelszo': 'Elfelejtett jelszó', '/uj-jelszo': 'Új jelszó', '/profil': 'Profil',
  '/kovetes': 'Követés', '/statisztikaim': 'Statisztikáim', '/ertesitesek': 'Értesítések', '/shop': 'Shop',
  '/battles': 'Párbajok', '/szelvenyek': 'Szelvények', '/edge-radar': 'Edge Radar', '/felfedezes': 'Felfedezés',
  '/elozmenyek': 'Előzmények', '/beallitasok': 'Beállítások', '/kereses': 'Keresés',
  '/admin/tippverseny': 'Admin', '/admin/modell-tanulas': 'Admin', '/admin/pro-befizetesek': 'Admin', '/admin/pro-statisztika': 'Admin',
};

/** érvényes dinamikus útvonalak – a létezést a kliens (API) dönti el; itt csak a formátumot ellenőrizzük */
const SEG = '[^/]{1,120}';
const DYNAMIC: { re: RegExp; title: string; description: string }[] = [
  { re: new RegExp(`^/meccs/${SEG}$`), title: 'Mérkőzéselemzés | TippStats', description: 'Mérkőzésstatisztikák, várható gólok és AI-alapú elemzés a TippStatson.' },
  { re: new RegExp(`^/csapat/${SEG}$`), title: 'Csapatstatisztikák | TippStats', description: 'Csapatforma, eredmények és gólstatisztikák a TippStatson.' },
  { re: new RegExp(`^/jatekos/${SEG}$`), title: 'Játékosprofil | TippStats', description: NOINDEX_DESC },
  { re: new RegExp(`^/tippverseny/${SEG}$`), title: 'Tippverseny | TippStats', description: NOINDEX_DESC },
  { re: new RegExp(`^/battles/${SEG}$`), title: 'Párbaj | TippStats', description: NOINDEX_DESC },
];

/** az útvonal normalizálása: dekódolás nélkül, záró perjel nélkül (a gyökér kivételével) */
export function normalizePath(pathname: string): string {
  const p = pathname.replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : '/';
}

/**
 * A meta egy útvonalra. Dinamikus oldalak (meccs, csapat, …) P0-ban `noindex, follow`: a tartalmuk
 * jelentős része vendégként zárolt / rövid életű, és a szerver nem ismeri a valódi nevüket – a
 * kliens a betöltés után a valódi névvel frissíti a címet.
 */
export function metaForPath(pathname: string): RouteMeta {
  const p = normalizePath(pathname);
  const pub = PUBLIC[p];
  if (pub) return { title: pub.title, description: pub.description, index: pub.index, status: 200, canonicalPath: pub.index ? p : null };
  const priv = PRIVATE[p];
  if (priv) return { title: `${priv} | ${SITE_NAME}`, description: NOINDEX_DESC, index: false, status: 200, canonicalPath: null };
  const dyn = DYNAMIC.find((d) => d.re.test(p));
  if (dyn) return { title: dyn.title, description: dyn.description, index: false, status: 200, canonicalPath: null };
  return { title: `Az oldal nem található | ${SITE_NAME}`, description: 'A keresett oldal nem létezik a TippStatson.', index: false, status: 404, canonicalPath: null };
}

/** a sitemap URL-jei: kizárólag az indexelhető, statikus, nyilvános útvonalak az elsődleges domainen */
export function sitemapUrls(): string[] {
  return Object.entries(PUBLIC).filter(([, e]) => e.index).map(([p]) => SITE_ORIGIN + (p === '/' ? '/' : p));
}

export function buildSitemapXml(): string {
  const urls = sitemapUrls().map((u) => `  <url><loc>${u}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Az index.html `<!--seo-->…<!--/seo-->` blokkjának cseréje az útvonal metaadataira (szerveroldalon).
 * `primary`: az elsődleges domain-e a kérés hosztja – ha nem (pl. workers.dev), mindenhol `noindex`.
 */
export function renderSeoHead(meta: RouteMeta, primary: boolean): string {
  const robots = meta.index && primary ? 'index, follow' : meta.status === 404 ? 'noindex' : 'noindex, follow';
  const canonical = meta.canonicalPath ? SITE_ORIGIN + meta.canonicalPath : null;
  const lines = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<meta name="robots" content="${robots}" />`,
  ];
  if (canonical) lines.push(`<link rel="canonical" href="${canonical}" />`);
  if (meta.status === 200) {
    lines.push(
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="${SITE_NAME}" />`,
      `<meta property="og:locale" content="hu_HU" />`,
      `<meta property="og:title" content="${esc(meta.title)}" />`,
      `<meta property="og:description" content="${esc(meta.description)}" />`,
      `<meta property="og:image" content="${SITE_ORIGIN}${OG_IMAGE}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${esc(meta.title)}" />`,
      `<meta name="twitter:description" content="${esc(meta.description)}" />`,
      `<meta name="twitter:image" content="${SITE_ORIGIN}${OG_IMAGE}" />`,
    );
    if (canonical) lines.push(`<meta property="og:url" content="${canonical}" />`);
  }
  return `<!--seo-->\n    ${lines.join('\n    ')}\n    <!--/seo-->`;
}

export function injectSeo(html: string, meta: RouteMeta, primary: boolean): string {
  const re = /<!--seo-->[\s\S]*?<!--\/seo-->/;
  if (!re.test(html)) throw new Error('Az index.html-ből hiányzik a <!--seo--> blokk.');
  return html.replace(re, renderSeoHead(meta, primary));
}
