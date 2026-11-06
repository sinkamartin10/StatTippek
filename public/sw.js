/**
 * TippStats service worker – SZÁNDÉKOSAN minimális.
 *
 * Gyorsítótárba KIZÁRÓLAG a saját hoszt tartalom-hashelt build-fájljai (/assets/*) kerülnek: a nevük minden
 * változásnál új, ezért nem avulhatnak el, és felhasználói adatot nem tartalmaznak.
 *
 * Minden mást érintetlenül hagy (a böngésző a service worker nélkül kezeli):
 *  - más hoszt: API (meccsadatok, elemzések, PRO-jogosultság), Supabase (bejelentkezés), Stripe, betűkészletek,
 *  - nem GET kérés, és a saját hoszton minden nem-/assets/ fájl és /api útvonal.
 *
 * Oldalbetöltés: mindig a hálózatról, gyorsítótár nélkül – elavult oldal nem jelenhet meg. Hálózat nélkül egy
 * rövid „nincs kapcsolat” oldal látszik, adat nélkül.
 */
const STATIC_CACHE = 'tippstats-static-v1';
/** a régi build-fájlok kiszorítása: ennél több bejegyzésnél a legrégebbiek törlődnek */
const MAX_ENTRIES = 80;

const OFFLINE_HTML = `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nincs kapcsolat – TippStats</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
         background: #111a33; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { margin: 0 0 20px; color: #c6cfe4; line-height: 1.5; max-width: 320px; }
  button { font: inherit; font-weight: 700; color: #fff; background: #4a69f4; border: 0; border-radius: 12px; padding: 12px 22px; }
</style>
</head>
<body>
<main>
  <h1>Nincs internetkapcsolat</h1>
  <p>A TippStats mindig friss adatokat mutat, ezért kapcsolat nélkül nem tölthető be.</p>
  <button type="button" onclick="location.reload()">Újrapróbálás</button>
</main>
</body>
</html>`;

const offlinePage = () => new Response(OFFLINE_HTML, {
  status: 503,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(old);
  }
  return res;
}

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('tippstats-') && key !== STATIC_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(offlinePage));
    return;
  }
  if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(request));
});
