/**
 * Kulcs nélküli, valós idejű hír-keresés RSS feedeken keresztül (Bing News + Google News).
 *
 * - A feedek nyilvános, feed-olvasásra szánt végpontok; nem kerülünk meg semmilyen védelmet.
 * - A Bing feed a cikk EREDETI URL-jét (url= paraméter) és rövid kivonatát adja; a Google feed a forrás nevét.
 * - Minden találat valódi, ellenőrizhető hivatkozás; URL-t sosem generálunk.
 * - A Google News feed a saját szabályzata szerint személyes, nem kereskedelmi feed-olvasásra használható –
 *   ez az alkalmazás személyes elemzőeszköz; lásd README.
 */
import type { SearchBackend } from './webSearchResearch';

interface Hit { title: string; url: string; snippet: string; publishedAt: string | null; source?: string }

const UA = 'Mozilla/5.0 (compatible; TIPPMIX-AI/1.0; personal research tool)';

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(item: string, name: string): string | null {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

function parseItems(xml: string): string[] {
  return xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
}

function toIso(d: string | null): string | null {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export class BingNewsRssBackend implements SearchBackend {
  name = 'Bing News RSS';
  async search(query: string, maxResults: number): Promise<Hit[]> {
    const xml = await fetchText(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`);
    return parseItems(xml).slice(0, maxResults).map((it) => {
      const link = tag(it, 'link') ?? '';
      // A Bing átirányító link url= paramétere az eredeti cikk címe
      const m = link.match(/[?&]url=([^&]+)/);
      const url = m ? decodeURIComponent(m[1]) : link;
      return {
        title: tag(it, 'title') ?? '',
        url,
        snippet: tag(it, 'description') ?? '',
        publishedAt: toIso(tag(it, 'pubDate')),
        source: tag(it, 'News:Source') ?? undefined,
      };
    }).filter((h) => h.url.startsWith('http'));
  }
}

export class GoogleNewsRssBackend implements SearchBackend {
  name = 'Google News RSS';
  async search(query: string, maxResults: number): Promise<Hit[]> {
    const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`);
    return parseItems(xml).slice(0, maxResults).map((it) => {
      const title = tag(it, 'title') ?? '';
      const source = tag(it, 'source') ?? undefined;
      return {
        title: source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title,
        url: tag(it, 'link') ?? '',
        // a Google feed nem ad kivonatot – a cím az egyetlen szöveg
        snippet: title,
        publishedAt: toIso(tag(it, 'pubDate')),
        source,
      };
    }).filter((h) => h.url.startsWith('http'));
  }
}

/** Több feed egyesítése: mindkettőt lekérdezi, a hibát tűri, cím szerint deduplikál. */
export class CombinedRssBackend implements SearchBackend {
  name = 'Bing News + Google News RSS';
  private backends: SearchBackend[] = [new BingNewsRssBackend(), new GoogleNewsRssBackend()];
  async search(query: string, maxResults: number): Promise<Hit[]> {
    const results = await Promise.allSettled(this.backends.map((b) => b.search(query, maxResults)));
    const out: Hit[] = [];
    const seen = new Set<string>();
    let failures = 0;
    for (const r of results) {
      if (r.status === 'rejected') { failures++; continue; }
      for (const h of r.value) {
        const key = h.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(h);
      }
    }
    if (failures === this.backends.length) throw new Error('egyik hírforrás sem érhető el');
    // legfrissebb elöl
    out.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    return out.slice(0, maxResults);
  }
}
