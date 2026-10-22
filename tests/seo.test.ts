/**
 * SEO P0: útvonaltábla, robots.txt, sitemap.xml, index.html-váz, favicon/OG-fájlok és a Worker kiszolgálási
 * szabályai (státuszkód, robots, canonical, workers.dev). Hálózat nélkül, hamis statikus tárolóval.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildSitemapXml, injectSeo, metaForPath, renderSeoHead, sitemapUrls, SITE_ORIGIN } from '../src/shared/seo';
import { handle, type Env } from '../src/worker/index';

const ROOT = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');
const INDEX = read('index.html');

/** az App.tsx összes útvonala (a „*” kivételével) */
const appRoutes = [...read('src/client/App.tsx').matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '*');

describe('Útvonaltábla', () => {
  it('a főoldal és a /pro egyedi, a témához illő címet és leírást kap, canonicallal', () => {
    const home = metaForPath('/'), pro = metaForPath('/pro');
    expect(home).toMatchObject({ status: 200, index: true, canonicalPath: '/' });
    expect(home.title).toMatch(/futballstatisztika/i);
    expect(home.title).toMatch(/mérkőzéselemzés/i);
    expect(pro).toMatchObject({ status: 200, index: true, canonicalPath: '/pro' });
    expect(pro.title).not.toBe(home.title);
    expect(pro.description).not.toBe(home.description);
  });

  it('minden nyilvános (indexelhető) oldal címe és leírása egyedi', () => {
    const pub = sitemapUrls().map((u) => metaForPath(new URL(u).pathname));
    expect(new Set(pub.map((m) => m.title)).size).toBe(pub.length);
    expect(new Set(pub.map((m) => m.description)).size).toBe(pub.length);
    for (const m of pub) { expect(m.title.length).toBeLessThanOrEqual(70); expect(m.description.length).toBeLessThanOrEqual(200); }
  });

  it('az App.tsx minden útvonala ismert (nem kap 404-et); a tábla nem tartalmaz nem létező statikus útvonalat', () => {
    for (const p of appRoutes) {
      const sample = p.replace(/:[a-z]+/gi, 'x1');
      expect(metaForPath(sample).status, p).toBe(200);
    }
    for (const u of sitemapUrls()) expect(appRoutes, u).toContain(new URL(u).pathname);
  });

  it('privát, belépési, admin- és felhasználói oldalak: létezik (200), de noindex és nincs canonical', () => {
    for (const p of ['/bejelentkezes', '/regisztracio', '/elfelejtett-jelszo', '/uj-jelszo', '/dashboard', '/profil', '/beallitasok', '/admin/pro-befizetesek', '/edge-radar', '/felfedezes', '/kereses', '/jatekos/Gabor07', '/battles/abc']) {
      expect(metaForPath(p), p).toMatchObject({ status: 200, index: false, canonicalPath: null });
    }
  });

  it('dinamikus, érvényes útvonalak nem lesznek 404-ek; ismeretlen útvonal 404 + „nem található” meta', () => {
    for (const p of ['/meccs/espn-uefa.champions-401915395', '/csapat/espn-123', '/tippverseny/24831fed-c808-47c1-8a19-8cb94318ecb0']) expect(metaForPath(p).status, p).toBe(200);
    for (const p of ['/ez-nem-letezik', '/meccs', '/meccs/a/b', '/pro/extra', '/admin']) {
      const m = metaForPath(p);
      expect(m, p).toMatchObject({ status: 404, index: false, canonicalPath: null });
      expect(m.title).toMatch(/nem található/);
    }
  });

  it('záró perjel: ugyanaz az oldal, a canonical perjel nélküli', () => {
    expect(metaForPath('/pro/')).toMatchObject({ status: 200, canonicalPath: '/pro' });
  });
});

describe('Statikus fájlok', () => {
  it('sitemap.xml: érvényes XML, pontosan az indexelhető nyilvános URL-ek, paraméter és privát oldal nélkül', () => {
    const xml = read('public/sitemap.xml');
    expect(xml).toBe(buildSitemapXml());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    expect(new Set(locs).size).toBe(locs.length);
    for (const u of locs) {
      expect(u.startsWith(SITE_ORIGIN + '/'), u).toBe(true);
      expect(u, u).not.toMatch(/[?#]/);
      expect(metaForPath(new URL(u).pathname), u).toMatchObject({ status: 200, index: true });
    }
    for (const priv of ['bejelentkezes', 'regisztracio', 'admin', 'profil', 'beallitasok']) expect(xml).not.toContain(priv);
  });

  it('robots.txt: mindent enged (az admint kivéve), és a sitemapre hivatkozik', () => {
    const txt = read('public/robots.txt');
    expect(txt).toMatch(/^User-agent: \*$/m);
    expect(txt).not.toMatch(/^Disallow: \/\s*$/m);
    expect(txt).toMatch(/^Disallow: \/admin\/$/m);
    expect(txt).toContain('Sitemap: https://tippstats.hu/sitemap.xml');
  });

  it('index.html: a seo-blokk pontosan a főoldal metaadatai; a favicon- és OG-képfájlok léteznek', () => {
    const block = INDEX.match(/<!--seo-->[\s\S]*?<!--\/seo-->/)![0];
    expect(block).toBe(renderSeoHead(metaForPath('/'), true));
    for (const href of [...INDEX.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1])) {
      expect(existsSync(new URL('public' + href, ROOT)), href).toBe(true);
    }
    const og = readFileSync(new URL('public/og-image.png', ROOT));
    expect(og.subarray(1, 4).toString()).toBe('PNG');
    expect([og.readUInt32BE(16), og.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(block).toContain(`${SITE_ORIGIN}/og-image.png`);
  });

  it('a belső API_FOOTBALL_KEY figyelmeztetés nem kerül a nyilvános státusz-figyelmeztetések közé', () => {
    const src = read('src/server/container.ts');
    expect(src).not.toMatch(/warnings\.push\([^)]*API_FOOTBALL_KEY/);
    expect(src).toMatch(/console\.warn\([^)]*API_FOOTBALL_KEY/);
  });
});

describe('Worker', () => {
  const files: Record<string, { body: string; type: string }> = {
    '/': { body: INDEX, type: 'text/html' },
    '/robots.txt': { body: 'User-agent: *', type: 'text/plain' },
    '/sitemap.xml': { body: '<?xml version="1.0"?>', type: 'application/xml' },
    '/assets/index-abc.js': { body: 'console.log(1)', type: 'text/javascript' },
    '/og-image.png': { body: 'PNG', type: 'image/png' },
  };
  const env: Env = {
    ASSETS: {
      async fetch(req: Request) {
        const p = new URL(req.url).pathname;
        if (req.headers.get('if-none-match')) return new Response(null, { status: 304 }); // feltételes kérésre nincs törzs
        const f = files[p];
        return f ? new Response(f.body, { status: 200, headers: { 'Content-Type': f.type } }) : new Response('Not found', { status: 404 });
      },
    },
  };
  const get = (url: string, init?: RequestInit) => handle(new Request(url, init), env);
  const head = async (r: Response) => { const html = await r.text(); return { html, title: html.match(/<title>([^<]*)<\/title>/)?.[1], canonical: html.match(/rel="canonical" href="([^"]+)"/)?.[1] ?? null, robots: html.match(/name="robots" content="([^"]+)"/)?.[1] }; };

  it('főoldal és /pro: 200, egyedi cím, canonical a tippstats.hu-n, indexelhető, OG-adatokkal', async () => {
    const home = await get('https://tippstats.hu/');
    const pro = await get('https://tippstats.hu/pro');
    expect(home.status).toBe(200);
    expect(pro.status).toBe(200);
    expect(pro.headers.get('X-Robots-Tag')).toBeNull();
    const h = await head(home), p = await head(pro);
    expect(h).toMatchObject({ canonical: 'https://tippstats.hu/', robots: 'index, follow' });
    expect(p).toMatchObject({ canonical: 'https://tippstats.hu/pro', robots: 'index, follow', title: metaForPath('/pro').title });
    expect(p.title).not.toBe(h.title);
    expect(p.html).toContain('property="og:url" content="https://tippstats.hu/pro"');
    expect(p.html).toContain('<div id="root"></div>'); // a SPA-váz változatlan
  });

  it('ismeretlen útvonal: 404, noindex (fejlécben és metában), nincs canonical és OG', async () => {
    const r = await get('https://tippstats.hu/ez-nem-letezik-12345');
    expect(r.status).toBe(404);
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex');
    const h = await head(r);
    expect(h).toMatchObject({ canonical: null, robots: 'noindex' });
    expect(h.title).toMatch(/nem található/);
    expect(h.html).not.toContain('og:title');
  });

  it('privát és dinamikus oldalak: 200, noindex, canonical nélkül', async () => {
    for (const u of ['https://tippstats.hu/bejelentkezes', 'https://tippstats.hu/regisztracio', 'https://tippstats.hu/admin/pro-befizetesek', 'https://tippstats.hu/meccs/espn-x-1']) {
      const r = await get(u);
      expect(r.status, u).toBe(200);
      expect(r.headers.get('X-Robots-Tag'), u).toBe('noindex, follow');
      expect((await head(r)).canonical, u).toBeNull();
    }
  });

  it('fájlok: változatlanul, helyes Content-Type-pal; hiányzó fájl valódi 404 (nem a SPA-váz)', async () => {
    const robots = await get('https://tippstats.hu/robots.txt');
    expect([robots.status, robots.headers.get('Content-Type')]).toEqual([200, 'text/plain']);
    const sm = await get('https://tippstats.hu/sitemap.xml');
    expect([sm.status, sm.headers.get('Content-Type')]).toEqual([200, 'application/xml']);
    expect((await get('https://tippstats.hu/assets/index-abc.js')).status).toBe(200);
    const miss = await get('https://tippstats.hu/favicon.ico');
    expect(miss.status).toBe(404);
    expect(await miss.text()).not.toContain('<div id="root">');
    expect((await get('https://tippstats.hu/assets/nincs.js')).status).toBe(404);
  });

  it('nem elsődleges hoszt (workers.dev): noindex minden válaszon, a canonical a tippstats.hu megfelelő oldalára mutat', async () => {
    const r = await get('https://stattippek.sinkamartin10.workers.dev/pro');
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(await head(r)).toMatchObject({ canonical: 'https://tippstats.hu/pro', robots: 'noindex, follow' });
    expect((await get('https://stattippek.sinkamartin10.workers.dev/robots.txt')).headers.get('X-Robots-Tag')).toBe('noindex');
  });

  it('HEAD-kérés: fejlécek törzs nélkül; feltételes böngészőkérésre is teljes HTML (a váz feltétel nélkül kérődik)', async () => {
    const h = await get('https://tippstats.hu/pro', { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
    const cond = await get('https://tippstats.hu/pro', { headers: { 'If-None-Match': '"abc"' } });
    expect(cond.status).toBe(200);
    expect((await head(cond)).title).toBe(metaForPath('/pro').title);
  });

  it('injectSeo: hiányzó seo-blokk esetén hibát dob (nem ad ki meta nélküli oldalt csendben)', () => {
    expect(() => injectSeo('<html><head></head></html>', metaForPath('/'), true)).toThrow(/seo/);
  });
});
