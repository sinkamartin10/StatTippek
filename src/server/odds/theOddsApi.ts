/**
 * Opcionális odds-szolgáltató: The Odds API (https://the-odds-api.com/) – ODDS_API_KEY szükséges (van ingyenes csomag).
 * Több fogadóiroda árait adja; piaconként a LEGJOBB (legmagasabb) oddsot tartjuk meg, az irodát feljegyezve.
 * Piacok: 1X2 (h2h), gólszám (totals), mindkét csapat szerez gólt (btts – csak ahol elérhető).
 *
 * A mérkőzéseket csapatnév-hasonlóság és kezdési idő (±3 óra) alapján párosítjuk; bizonytalan párosításnál nem adunk oddsot.
 * A válaszokat 15 percig cache-eljük (a kvóta kímélése miatt), sportáganként (bajnokságonként) egy hívással.
 */
import type { League, Match, MatchOdds, Team } from '../../shared/types';
import type { HttpCache } from '../db/database';

const SPORT_KEYS: Record<string, string> = {
  'eng-pl': 'soccer_epl',
  'esp-ll': 'soccer_spain_la_liga',
  'ita-sa': 'soccer_italy_serie_a',
  'ger-bl': 'soccer_germany_bundesliga',
  'fra-l1': 'soccer_france_ligue_one',
  'uefa-ucl': 'soccer_uefa_champs_league',
  'uefa-uel': 'soccer_uefa_europa_league',
  'uefa-uecl': 'soccer_uefa_europa_conference_league',
  'usa-mls': 'soccer_usa_mls',
  'eng-ch': 'soccer_efl_champ',
  'esp-l2': 'soccer_spain_segunda_division',
  'ita-sb': 'soccer_italy_serie_b',
  'ger-b2': 'soccer_germany_bundesliga2',
  'fra-l2': 'soccer_france_ligue_two',
  'hun-nb1': 'soccer_hungary_nb_i',
  'uefa-nl': 'soccer_uefa_nations_league',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(fc|cf|sc|afc|club|calcio|ac|ssc|ud|cd|rc)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Két csapatnév hasonlósága (0–1): közös szavak aránya + előtag-egyezés. */
export function nameSimilarity(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = new Set(na.split(' ')), wb = new Set(nb.split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w) && w.length > 2) common++;
  return common / Math.max(1, Math.min(wa.size, wb.size));
}

export class TheOddsApiProvider {
  readonly name = 'The Odds API (több fogadóiroda, legjobb odds)';
  private mem = new Map<string, { at: number; data: Json[] }>();

  constructor(private apiKey: string, private cache?: HttpCache) {}

  private async events(sport: string): Promise<Json[]> {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=eu,uk&markets=h2h,totals,btts&oddsFormat=decimal&apiKey=${this.apiKey}`;
    const cacheKey = `odds-api:${sport}`;
    const hit = this.mem.get(cacheKey);
    if (hit && Date.now() - hit.at < 15 * 60_000) return hit.data;
    const stored = this.cache?.get(cacheKey, 15 * 60_000);
    if (stored) { const data = JSON.parse(stored); this.mem.set(cacheKey, { at: Date.now(), data }); return data; }
    try {
      const res = await fetch(url);
      if (!res.ok) { console.error(`[odds-api] ${sport} -> HTTP ${res.status}`); return []; }
      const data = (await res.json()) as Json[];
      if (!Array.isArray(data)) return [];
      this.mem.set(cacheKey, { at: Date.now(), data });
      this.cache?.set(cacheKey, JSON.stringify(data));
      return data;
    } catch (e) {
      console.error(`[odds-api] ${sport} -> kivétel:`, (e as Error).message);
      return [];
    }
  }

  async getOdds(match: Match, league: League, home: Team, away: Team): Promise<MatchOdds | null> {
    const sport = SPORT_KEYS[league.id];
    if (!sport) return null;
    const list = await this.events(sport);
    const kick = new Date(match.kickoff).getTime();
    let best: Json = null, bestScore = 0;
    for (const ev of list) {
      const dt = Math.abs(new Date(ev.commence_time).getTime() - kick);
      if (dt > 3 * 3600_000) continue;
      const sim = (name: string, t: Team) => Math.max(nameSimilarity(name, t.name), ...(t.altNames ?? []).map((n) => nameSimilarity(name, n)));
      const score = sim(ev.home_team, home) + sim(ev.away_team, away);
      if (score > bestScore) { bestScore = score; best = ev; }
    }
    if (!best || bestScore < 1.2) return null; // bizonytalan párosítás – inkább nincs odds

    const markets: Record<string, number> = {};
    const bookmakers: Record<string, string> = {};
    const put = (key: string, price: number, book: string) => {
      if (!(price > 1)) return;
      if (!markets[key] || price > markets[key]) { markets[key] = Math.round(price * 100) / 100; bookmakers[key] = book; }
    };
    for (const bm of best.bookmakers ?? []) {
      for (const m of bm.markets ?? []) {
        for (const o of m.outcomes ?? []) {
          const name = String(o.name);
          if (m.key === 'h2h') {
            if (name === best.home_team) put('1', o.price, bm.title);
            else if (name === best.away_team) put('2', o.price, bm.title);
            else if (/draw/i.test(name)) put('X', o.price, bm.title);
          } else if (m.key === 'totals' && o.point != null) {
            const line = Number(o.point);
            if ([0.5, 1.5, 2.5, 3.5, 4.5].includes(line)) put(`${/over/i.test(name) ? 'O' : 'U'}${line}`, o.price, bm.title);
          } else if (m.key === 'btts') {
            put(/yes/i.test(name) ? 'BTTS_Y' : 'BTTS_N', o.price, bm.title);
          }
        }
      }
    }
    if (!Object.keys(markets).length) return null;
    const books = [...new Set(Object.values(bookmakers))];
    return {
      matchId: match.id,
      source: 'live',
      bookmaker: `legjobb odds ${books.length} irodából (The Odds API)`,
      retrievedAt: new Date().toISOString(),
      markets,
      bookmakers,
    };
  }
}
