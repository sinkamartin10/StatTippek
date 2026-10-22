/**
 * Cloudflare Worker a statikus frontend (dist/) elé – CSAK SEO-célú kiszolgálási szabályok:
 *  - fájlok (assetek, robots.txt, sitemap.xml, ikonok): változatlanul a statikus tárolóból; hiányzó fájl → valódi 404;
 *  - HTML-útvonalak: az index.html az útvonal metaadataival (cím, leírás, robots, canonical, OG/Twitter);
 *    ismeretlen útvonal → 404 státusz + noindex (a SPA a „nem található” nézetet rendereli);
 *  - privát / nem indexelendő oldalak és a nem elsődleges hoszt (pl. *.workers.dev): `X-Robots-Tag: noindex`.
 * Az alkalmazás működéséhez (API, bejelentkezés, előfizetés) nem nyúl: az API egy másik hoszton fut.
 */
import { SITE_ORIGIN, injectSeo, metaForPath } from '../shared/seo';

/** a Workers statikus asset-kötése (wrangler.jsonc: assets.binding) */
export interface AssetsBinding { fetch(request: Request): Promise<Response> }
export interface Env { ASSETS: AssetsBinding }

const PRIMARY_HOST = new URL(SITE_ORIGIN).host;
const FILE_PATH = /\.[a-z0-9]{1,8}$/i;

function withHeader(res: Response, name: string, value: string): Response {
  const out = new Response(res.body, res);
  out.headers.set(name, value);
  return out;
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const primary = url.host === PRIMARY_HOST;

  // fájl (vagy nem GET/HEAD kérés): a statikus tároló dönt – nem létező fájl valódi 404
  if ((request.method !== 'GET' && request.method !== 'HEAD') || url.pathname.startsWith('/assets/') || FILE_PATH.test(url.pathname)) {
    const res = await env.ASSETS.fetch(request);
    return primary ? res : withHeader(res, 'X-Robots-Tag', 'noindex');
  }

  // HTML-útvonal: a SPA-váz (index.html) feltételes fejlécek nélkül, hogy mindig legyen törzs
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url).toString(), { method: 'GET' }));
  if (!shell.ok) return shell;
  const meta = metaForPath(url.pathname);
  const html = injectSeo(await shell.text(), meta, primary);
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' });
  if (!meta.index || !primary) headers.set('X-Robots-Tag', meta.status === 404 ? 'noindex' : 'noindex, follow');
  return new Response(request.method === 'HEAD' ? null : html, { status: meta.status, headers });
}

export default { fetch: handle };
