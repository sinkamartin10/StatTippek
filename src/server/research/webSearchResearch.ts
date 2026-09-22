/**
 * Internetes kutatómotor keresési API-n keresztül (Tavily vagy Brave Search).
 *
 * Elvek:
 *  - Csak a keresőmotor által visszaadott valódi URL-eket tároljuk; URL-t sosem generálunk.
 *  - A találat szövegrészletét (snippet) idézetként tároljuk "extracted" mezőben – nem értelmezzük túl.
 *  - A külső tipp piacát egyszerű szövegminták alapján ismerjük fel; ha nem egyértelmű, market = null,
 *    és a felület "piac nem felismerhető"-ként mutatja. Ezt az autoExtracted mező jelzi.
 *  - Sérülés/eltiltás listákat NEM állítunk elő automatikusan a szövegből (túl hibalehetőséges);
 *    a találatok hírként jelennek meg, a felhasználó a forrásnál ellenőrizheti.
 *  - Hívások között rövid késleltetés (rate limit), a találatokat a hívó (container) cache-eli.
 *  - Nem kerülünk meg CAPTCHA-t, bejelentkezést vagy fizetőfalat: csak a kereső API nyilvános válaszát használjuk.
 */
import type { ExternalPrediction, NewsCategory, NewsItem, ResearchResult, SourceRecord } from '../../shared/types';
import { parsePredictionText } from '../../shared/engine/markets';
import { emptyAvailability, type ResearchContext, type ResearchProvider } from './provider';

export interface SearchHit { title: string; url: string; snippet: string; publishedAt: string | null; source?: string }

export interface SearchBackend {
  name: string;
  search(query: string, maxResults: number): Promise<SearchHit[]>;
}

export class TavilyBackend implements SearchBackend {
  name = 'Tavily';
  constructor(private key: string) {}
  async search(query: string, maxResults: number): Promise<SearchHit[]> {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: this.key, query, max_results: maxResults, search_depth: 'basic', include_answer: false }),
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const json = (await res.json()) as { results?: { title: string; url: string; content: string; published_date?: string }[] };
    return (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, publishedAt: r.published_date ?? null }));
  }
}

export class BraveBackend implements SearchBackend {
  name = 'Brave Search';
  constructor(private key: string) {}
  async search(query: string, maxResults: number): Promise<SearchHit[]> {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.key },
    });
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
    const json = (await res.json()) as { web?: { results?: { title: string; url: string; description: string; page_age?: string }[] } };
    return (json.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description, publishedAt: r.page_age ?? null }));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function categorize(text: string): NewsCategory {
  const t = text.toLowerCase();
  if (/injur|sérül|out for|ruled out/.test(t)) return 'sérülés';
  if (/suspend|eltilt|banned|red card/.test(t)) return 'eltiltás';
  if (/line-?up|starting xi|felállás|kezdőcsapat/.test(t)) return 'felállás';
  if (/manager|coach|edző|head coach/.test(t)) return 'edző';
  if (/transfer|átigazol|signing/.test(t)) return 'átigazolás';
  if (/rotation|rotál|rest/.test(t)) return 'rotáció';
  if (/fixture|schedule|menetrend|congestion/.test(t)) return 'menetrend';
  return 'általános';
}

export class WebSearchResearchProvider implements ResearchProvider {
  readonly name: string;
  constructor(private backend: SearchBackend) {
    this.name = `Internetes kutatás (${backend.name})`;
  }

  async research(ctx: ResearchContext): Promise<ResearchResult> {
    const { match, homeTeam, awayTeam } = ctx;
    // Kereséshez az angol név (ha van), hogy a nemzetközi hírforrások találjanak; válogatottaknál a 'football' szó a nem sportos hírek kiszűréséhez
    const qn = (t: typeof homeTeam) => t.altNames?.[0] ?? t.name;
    const national = !!(homeTeam.altNames?.length || awayTeam.altNames?.length);
    const sport = national ? ' football' : '';
    const now = new Date().toISOString();
    const sources: SourceRecord[] = [];
    const news: NewsItem[] = [];
    const externalPredictions: ExternalPrediction[] = [];
    const warnings: string[] = [];
    const seenUrls = new Set<string>();
    let sid = 0;

    const addSource = (hit: SearchHit, type: SourceRecord['type']): SourceRecord | null => {
      if (!hit.url || seenUrls.has(hit.url)) return null;
      seenUrls.add(hit.url);
      const s: SourceRecord = {
        id: `${match.id}-src-${++sid}`,
        matchId: match.id,
        sourceName: hit.source ?? safeHost(hit.url),
        url: hit.url,
        retrievedAt: now,
        publishedAt: hit.publishedAt,
        type,
        extracted: hit.snippet.slice(0, 400),
        method: `kereső találat (${this.backend.name})`,
        origin: 'live',
      };
      sources.push(s);
      return s;
    };

    const run = async (query: string, max: number): Promise<SearchHit[]> => {
      try {
        const hits = await this.backend.search(query, max);
        await sleep(150);
        return hits;
      } catch (e) {
        warnings.push(`Keresés sikertelen („${query}”): ${(e as Error).message}`);
        return [];
      }
    };

    // 1) Külső előrejelzések
    const predHits = await run(`${qn(homeTeam)} vs ${qn(awayTeam)}${sport} prediction`, 8);
    for (const hit of predHits) {
      const text = `${hit.title}. ${hit.snippet}`;
      // Relevancia: a tipp-cikknek mindkét csapatot említenie kell (az egyik nélkül más meccsről szólhat)
      const key = (t: typeof homeTeam) => qn(t).toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter((w) => w.length > 3)[0] ?? qn(t).toLowerCase();
      const lower = text.toLowerCase();
      const mentions = [key(homeTeam), key(awayTeam)].filter((k) => lower.includes(k)).length;
      if (mentions === 0) continue;
      // "predicted line-up / XI" cikkek nem tippek, hanem felállás-hírek
      const isLineupArticle = /predicted (line-?ups?|xi|starting|team)|line-?ups?:|team news/i.test(hit.title);
      if (mentions < 2 || isLineupArticle || !/predict|\btips?\b|forecast|odds|betting|tipp|előrejelz/i.test(text)) {
        // nem tipp jellegű találat – hírként tároljuk
        const s = addSource(hit, 'hír');
        if (s) news.push({ id: `${match.id}-news-${s.id}`, title: hit.title, summary: hit.snippet.slice(0, 300), url: hit.url, sourceName: s.sourceName, publishedAt: hit.publishedAt, category: categorize(text), origin: 'live', sourceId: s.id });
        continue;
      }
      const s = addSource(hit, 'külső előrejelzés');
      if (!s) continue;
      const market = parsePredictionText(text, qn(homeTeam), qn(awayTeam));
      externalPredictions.push({
        id: `${match.id}-ep-${s.id}`,
        sourceName: s.sourceName,
        url: hit.url,
        publishedAt: hit.publishedAt,
        originalText: hit.snippet.slice(0, 300),
        market,
        confidence: null,
        sourceId: s.id,
        origin: 'live',
        autoExtracted: true,
      });
    }

    // 2) Csapathírek (sérülések, eltiltások, felállás)
    for (const team of [homeTeam, awayTeam]) {
      const hits = await run(`${qn(team)}${sport} team news injury`, 5);
      for (const hit of hits) {
        const s = addSource(hit, 'hír');
        if (!s) continue;
        news.push({
          id: `${match.id}-news-${s.id}`,
          title: hit.title,
          summary: hit.snippet.slice(0, 300),
          url: hit.url,
          sourceName: s.sourceName,
          publishedAt: hit.publishedAt,
          teamId: team.id,
          category: categorize(`${hit.title} ${hit.snippet}`),
          origin: 'live',
          sourceId: s.id,
        });
      }
    }

    // 3) Mérkőzés-előzetes
    const previewHits = await run(`${qn(homeTeam)} ${qn(awayTeam)}${sport} preview lineup`, 5);
    for (const hit of previewHits) {
      const s = addSource(hit, 'hír');
      if (!s) continue;
      news.push({
        id: `${match.id}-news-${s.id}`, title: hit.title, summary: hit.snippet.slice(0, 300), url: hit.url, sourceName: s.sourceName,
        publishedAt: hit.publishedAt, category: categorize(`${hit.title} ${hit.snippet}`), origin: 'live', sourceId: s.id,
      });
    }

    if (sources.length === 0) warnings.push('Ehhez a mérkőzéshez jelenleg nem áll rendelkezésre elegendő ellenőrizhető adat.');
    if (externalPredictions.length === 0) warnings.push('Nem található külső előrejelzés ehhez a mérkőzéshez.');
    const home = emptyAvailability(homeTeam.id);
    const away = emptyAvailability(awayTeam.id);
    const note = 'Sérülés/eltiltás lista automatikusan nem kinyerhető – lásd a hírek szekciót és a forrásokat.';
    home.notes.push(note);
    away.notes.push(note);

    return { matchId: match.id, origin: 'live', performedAt: now, provider: this.name, news, availability: { home, away }, externalPredictions, sources, warnings };
  }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'ismeretlen forrás'; }
}
