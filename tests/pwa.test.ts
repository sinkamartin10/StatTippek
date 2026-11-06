/**
 * PWA: manifest, ikonok, iOS-metaadatok, a Worker kiszolgálása és a service worker gyorsítótár-szabályai.
 *
 * A service workert a VALÓDI public/sw.js futtatja, kézi `self` / `caches` / `fetch` környezetben. A fő állítás:
 * a gyorsítótárba KIZÁRÓLAG a saját hoszt /assets/* fájljai kerülnek – API, Supabase, Stripe és oldalbetöltés soha.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { handle } from '../src/worker/index';

const ROOT = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8');
const ORIGIN = 'https://tippstats.hu';
const manifest = JSON.parse(read('public/manifest.json'));
const INDEX = read('index.html');

/** PNG-fejléc: szélesség, magasság, színtípus (2 = RGB, 6 = RGBA) */
function png(path: string) {
  const b = readFileSync(new URL(path, ROOT));
  expect(b.subarray(1, 4).toString()).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

describe('Manifest és ikonok', () => {
  it('TippStats név, önálló megjelenítés, a saját hosztra szűkített hatókör, a fejléc színe', () => {
    expect(manifest).toMatchObject({
      id: '/', name: 'TippStats', short_name: 'TippStats', lang: 'hu', start_url: '/', scope: '/', display: 'standalone',
      theme_color: '#111a33', background_color: '#111a33',
    });
    expect(INDEX).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`);
  });

  it('192-es és 512-es ikon „any” és „maskable” célra; a megadott méret a valódi méret, átlátszóság nélkül', () => {
    for (const purpose of ['any', 'maskable']) {
      expect(manifest.icons.filter((i: { purpose: string }) => i.purpose === purpose).map((i: { sizes: string }) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    }
    for (const i of manifest.icons as { src: string; sizes: string; type: string }[]) {
      expect(i.type).toBe('image/png');
      const [w, h] = i.sizes.split('x').map(Number);
      expect(png(`public${i.src}`)).toEqual({ width: w, height: h, colorType: 2 });
    }
  });

  it('Apple touch icon: 180×180, átlátszóság nélkül (az iOS maga kerekíti a sarkokat)', () => {
    expect(png('public/apple-touch-icon.png')).toEqual({ width: 180, height: 180, colorType: 2 });
  });
});

describe('iPhone Safari metaadatok (index.html)', () => {
  it('manifest-link, Apple touch icon és önálló futás', () => {
    for (const tag of [
      '<link rel="manifest" href="/manifest.json" />',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />',
      '<meta name="apple-mobile-web-app-capable" content="yes" />',
      '<meta name="mobile-web-app-capable" content="yes" />',
      '<meta name="apple-mobile-web-app-title" content="TippStats" />',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black" />',
      '<meta name="format-detection" content="telephone=no" />',
    ]) expect(INDEX).toContain(tag);
  });

  it('a PWA-metaadatok a SEO-blokkon kívül vannak: a Worker oldalankénti cseréje nem érinti őket', () => {
    const seo = INDEX.slice(INDEX.indexOf('<!--seo-->'), INDEX.indexOf('<!--/seo-->'));
    expect(seo).not.toContain('manifest');
    expect(seo).not.toContain('apple-mobile-web-app');
  });

  it('a tartalom nem csúszhat a notch alá: nincs viewport-fit=cover', () => {
    expect(INDEX).not.toContain('viewport-fit');
  });
});

describe('Worker: a PWA-fájlok fájlként mennek ki, nem SEO-vázként', () => {
  it.each(['/manifest.json', '/sw.js', '/icons/icon-512.png', '/apple-touch-icon.png'])('%s', async (path) => {
    const assets = { fetch: vi.fn(async () => new Response('fájl')) };
    const res = await handle(new Request(`${ORIGIN}${path}`), { ASSETS: assets });
    expect(await res.text()).toBe('fájl');
    expect(new URL((assets.fetch.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe(path);
  });
});

// ---------------------------------------------------------------------------
// A valódi public/sw.js kézi böngészőkörnyezetben
// ---------------------------------------------------------------------------

type Handler = (e: Record<string, unknown>) => void;

function loadSw(net: (req: FakeRequest) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const open = (name: string) => stores.get(name) ?? stores.set(name, new Map()).get(name)!;
  const caches = {
    open: async (name: string) => {
      const m = open(name);
      return {
        match: async (r: FakeRequest) => m.get(r.url)?.clone(),
        put: async (r: FakeRequest, res: Response) => { m.set(r.url, res); },
        keys: async () => [...m.keys()].map((url) => ({ url })),
        delete: async (r: FakeRequest) => m.delete(r.url),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const listeners: Record<string, Handler> = {};
  const self = {
    location: { origin: ORIGIN },
    clients: { claim: vi.fn(async () => {}) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, fn: Handler) => { listeners[type] = fn; },
  };
  const fetchMock = vi.fn(net);
  new Function('self', 'caches', 'fetch', 'Response', read('public/sw.js'))(self, caches, fetchMock, Response);
  /** egy kérés a service workeren át; undefined = a SW nem avatkozott be, a böngésző kezeli */
  const dispatch = async (request: FakeRequest): Promise<Response | undefined> => {
    let responded: Promise<Response> | undefined;
    listeners.fetch({ request, respondWith: (p: Promise<Response>) => { responded = p; } });
    return responded;
  };
  return { self, stores, fetchMock, dispatch, listeners, cached: () => [...stores.values()].flatMap((m) => [...m.keys()]) };
}
interface FakeRequest { url: string; method: string; mode: string }
const get = (url: string, mode = 'cors'): FakeRequest => ({ url, method: 'GET', mode });
const ok = async () => new Response('tartalom', { status: 200 });
/** a Response.type a konstruktorból „default” – a saját hoszt valódi válasza „basic” */
const basic = (status = 200) => async () => Object.defineProperty(new Response('tartalom', { status }), 'type', { value: 'basic' });

describe('Service worker – mi kerülhet gyorsítótárba', () => {
  it.each([
    ['API (meccsek)', 'https://stattippek.onrender.com/api/matches?date=2026-11-06'],
    ['API (elemzés)', 'https://stattippek.onrender.com/api/matches/espn-eng.1-1/analysis'],
    ['API (jogosultság)', 'https://stattippek.onrender.com/api/billing/me'],
    ['Supabase auth', 'https://abc.supabase.co/auth/v1/user'],
    ['Supabase adat', 'https://abc.supabase.co/rest/v1/profiles?id=eq.1'],
    ['Stripe', 'https://api.stripe.com/v1/checkout/sessions'],
    ['betűkészlet', 'https://fonts.googleapis.com/css2?family=Nunito'],
    ['más hoszt /assets útvonala', 'https://stattippek.onrender.com/assets/x.js'],
  ])('más hoszt: %s – a SW nem avatkozik be', async (_n, url) => {
    const sw = loadSw(ok);
    expect(await sw.dispatch(get(url))).toBeUndefined();
    expect(sw.fetchMock).not.toHaveBeenCalled();
    expect(sw.cached()).toEqual([]);
  });

  it.each(['/api/matches', '/api/profile/me', '/manifest.json', '/sw.js', '/og-image.png'])('saját hoszt, %s: nem avatkozik be', async (path) => {
    const sw = loadSw(ok);
    expect(await sw.dispatch(get(`${ORIGIN}${path}`))).toBeUndefined();
    expect(sw.cached()).toEqual([]);
  });

  it('nem GET kérés (pl. igénylés, szelvény mentése): nem avatkozik be', async () => {
    const sw = loadSw(ok);
    for (const method of ['POST', 'PUT', 'DELETE']) expect(await sw.dispatch({ url: `${ORIGIN}/assets/a.js`, method, mode: 'cors' })).toBeUndefined();
    expect(sw.cached()).toEqual([]);
  });

  it('build-fájl: első kérés a hálózatról, utána a gyorsítótárból', async () => {
    const sw = loadSw(basic());
    const url = `${ORIGIN}/assets/index-abc123.js`;
    expect((await sw.dispatch(get(url)))?.status).toBe(200);
    expect(sw.cached()).toEqual([url]);
    expect((await sw.dispatch(get(url)))?.status).toBe(200);
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hibás válasz nem kerül gyorsítótárba', async () => {
    const sw = loadSw(basic(404));
    expect((await sw.dispatch(get(`${ORIGIN}/assets/nincs.js`)))?.status).toBe(404);
    expect(sw.cached()).toEqual([]);
  });

  it('a gyorsítótár nem nő a végtelenségig: a legrégebbi build-fájlok kiesnek', async () => {
    const sw = loadSw(basic());
    for (let i = 0; i < 85; i++) await sw.dispatch(get(`${ORIGIN}/assets/f${i}.js`));
    expect(sw.cached()).toHaveLength(80);
    expect(sw.cached()).not.toContain(`${ORIGIN}/assets/f0.js`);
    expect(sw.cached()).toContain(`${ORIGIN}/assets/f84.js`);
  });
});

describe('Service worker – oldalbetöltés', () => {
  it('mindig a hálózatról, és az oldal nem kerül gyorsítótárba (két betöltés = két hálózati kérés)', async () => {
    const sw = loadSw(basic());
    for (const path of ['/dashboard', '/dashboard']) expect((await sw.dispatch(get(`${ORIGIN}${path}`, 'navigate')))?.status).toBe(200);
    expect(sw.fetchMock).toHaveBeenCalledTimes(2);
    expect(sw.cached()).toEqual([]);
  });

  it('a szerver hibaválasza változatlanul átmegy (nem offline oldal)', async () => {
    const sw = loadSw(basic(404));
    expect((await sw.dispatch(get(`${ORIGIN}/nincs-ilyen`, 'navigate')))?.status).toBe(404);
  });

  it('hálózat nélkül: rövid „nincs kapcsolat” oldal, adat nélkül, és nem tárolható', async () => {
    const sw = loadSw(async () => { throw new TypeError('Failed to fetch'); });
    const res = await sw.dispatch(get(`${ORIGIN}/dashboard`, 'navigate'));
    expect(res?.status).toBe(503);
    expect(res?.headers.get('cache-control')).toBe('no-store');
    expect(await res?.text()).toContain('Nincs internetkapcsolat');
    expect(sw.cached()).toEqual([]);
  });
});

describe('Service worker – életciklus', () => {
  it('az új verzió azonnal átveszi a helyét, a régi TippStats-gyorsítótár törlődik, más gyorsítótárhoz nem nyúl', async () => {
    const sw = loadSw(ok);
    sw.stores.set('tippstats-static-v0', new Map());
    sw.stores.set('mas-alkalmazas', new Map());
    sw.stores.set('tippstats-static-v1', new Map());
    sw.listeners.install({});
    expect(sw.self.skipWaiting).toHaveBeenCalled();
    let done: Promise<unknown> = Promise.resolve();
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect([...sw.stores.keys()].sort()).toEqual(['mas-alkalmazas', 'tippstats-static-v1']);
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});

describe('Kliens-regisztráció', () => {
  it('csak production buildben, frissítéskor a HTTP-gyorsítótár megkerülésével', () => {
    const src = read('src/client/pwa.ts');
    expect(src).toContain('import.meta.env.PROD');
    expect(src).toContain("register('/sw.js', { updateViaCache: 'none' })");
    expect(read('src/client/main.tsx')).toContain('registerServiceWorker();');
    expect(existsSync(new URL('public/sw.js', ROOT))).toBe(true);
  });
});
