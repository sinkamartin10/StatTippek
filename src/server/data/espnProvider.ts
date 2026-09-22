/**
 * Élő meccsadat-szolgáltató kulcs nélkül: az ESPN nyilvános scoreboard/schedule JSON végpontjai.
 *
 * Lefedett sorozatok: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, másodosztályok, BL, EL, Konferencia-liga, MLS,
 * UEFA Nemzetek Ligája (+ vb-selejtezők és válogatott barátságos meccsek a válogatottak formájához).
 * (A magyar NB I / NB II nincs az ESPN adatbázisában – ahhoz API_FOOTBALL_KEY szükséges.)
 *
 * Tisztességes használat: User-Agent azonosító, legfeljebb 4 párhuzamos kérés, memória- és SQLite-cache,
 * lejátszott meccsek eredménye nem kérdeződik le újra. Nem kerülünk meg semmilyen védelmet – ezek nyilvános,
 * hitelesítés nélküli végpontok. Ha egy hívás sikertelen, üres eredményt adunk vissza és naplózunk – soha nem
 * pótoljuk kitalált adattal.
 */
import type { League, Match, MatchImportance, MatchOdds, MatchResult, Team } from '../../shared/types';
import type { HttpCache } from '../db/database';
import { DERBIES, TEAMS as DEMO_TEAMS } from './demo/leagues';
import type { MatchDataProvider, MatchQuery } from './provider';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

/** Belső liga-azonosító → ESPN slug */
export const ESPN_LEAGUES: League[] = [
  { id: 'eng-pl', name: 'Premier League', country: 'Anglia', countryCode: 'ENG', tier: 1, international: false },
  { id: 'esp-ll', name: 'La Liga', country: 'Spanyolország', countryCode: 'ESP', tier: 1, international: false },
  { id: 'ita-sa', name: 'Serie A', country: 'Olaszország', countryCode: 'ITA', tier: 1, international: false },
  { id: 'ger-bl', name: 'Bundesliga', country: 'Németország', countryCode: 'GER', tier: 1, international: false },
  { id: 'fra-l1', name: 'Ligue 1', country: 'Franciaország', countryCode: 'FRA', tier: 1, international: false },
  { id: 'uefa-ucl', name: 'Bajnokok Ligája', country: 'Európa', countryCode: 'EUR', tier: 0, international: true },
  { id: 'uefa-uel', name: 'Európa-liga', country: 'Európa', countryCode: 'EUR', tier: 0, international: true },
  { id: 'uefa-uecl', name: 'Konferencia-liga', country: 'Európa', countryCode: 'EUR', tier: 0, international: true },
  { id: 'usa-mls', name: 'MLS', country: 'USA', countryCode: 'USA', tier: 1, international: false },
  { id: 'eng-ch', name: 'Championship', country: 'Anglia', countryCode: 'ENG', tier: 2, international: false },
  { id: 'esp-l2', name: 'LaLiga 2', country: 'Spanyolország', countryCode: 'ESP', tier: 2, international: false },
  { id: 'ita-sb', name: 'Serie B', country: 'Olaszország', countryCode: 'ITA', tier: 2, international: false },
  { id: 'ger-b2', name: '2. Bundesliga', country: 'Németország', countryCode: 'GER', tier: 2, international: false },
  { id: 'fra-l2', name: 'Ligue 2', country: 'Franciaország', countryCode: 'FRA', tier: 2, international: false },
  { id: 'uefa-nl', name: 'Nemzetek Ligája', country: 'Válogatott (UEFA)', countryCode: 'UEFA', tier: 0, international: true },
  { id: 'fifa-wcq-uefa', name: 'Vb-selejtező (UEFA)', country: 'Válogatott (UEFA)', countryCode: 'UEFA', tier: 0, international: true },
  { id: 'fifa-friendly', name: 'Válogatott barátságos', country: 'Válogatott (nemzetközi)', countryCode: 'INT', tier: 0, international: true },
];

const SLUG: Record<string, string> = {
  'eng-pl': 'eng.1', 'esp-ll': 'esp.1', 'ita-sa': 'ita.1', 'ger-bl': 'ger.1', 'fra-l1': 'fra.1',
  'uefa-ucl': 'uefa.champions', 'uefa-uel': 'uefa.europa', 'uefa-uecl': 'uefa.europa.conf', 'usa-mls': 'usa.1',
  'eng-ch': 'eng.2', 'esp-l2': 'esp.2', 'ita-sb': 'ita.2', 'ger-b2': 'ger.2', 'fra-l2': 'fra.2',
  'uefa-nl': 'uefa.nations', 'fifa-wcq-uefa': 'fifa.worldq.uefa', 'fifa-friendly': 'fifa.friendly',
};
/** Válogatott csapatok előzményei: a Nemzetek Ligája kétévente van, ezért az előző kiírás (év−2), a vb-selejtező (év−1) és a barátságos meccsek (év, év−1) is kellenek. */
const NATIONAL_SLUG = 'uefa.nations';
const NATIONAL_HISTORY: [string, number][] = [['uefa.nations', 0], ['uefa.nations', -2], ['fifa.worldq.uefa', -1], ['fifa.worldq.uefa', 0], ['fifa.friendly', 0], ['fifa.friendly', -1]];

/** Válogatottak magyar neve (az ESPN angolul adja) */
const NATION_HU: Record<string, string> = {
  Hungary: 'Magyarország', Germany: 'Németország', France: 'Franciaország', Spain: 'Spanyolország', Italy: 'Olaszország', England: 'Anglia', Portugal: 'Portugália',
  Netherlands: 'Hollandia', Belgium: 'Belgium', Croatia: 'Horvátország', Denmark: 'Dánia', Switzerland: 'Svájc', Austria: 'Ausztria', Poland: 'Lengyelország',
  'Czech Republic': 'Csehország', Czechia: 'Csehország', Slovakia: 'Szlovákia', Slovenia: 'Szlovénia', Serbia: 'Szerbia', Romania: 'Románia', Ukraine: 'Ukrajna', Turkey: 'Törökország', 'Türkiye': 'Törökország',
  Greece: 'Görögország', Sweden: 'Svédország', Norway: 'Norvégia', Finland: 'Finnország', Iceland: 'Izland', Ireland: 'Írország', 'Republic of Ireland': 'Írország', 'Northern Ireland': 'Észak-Írország',
  Scotland: 'Skócia', Wales: 'Wales', Bosnia: 'Bosznia-Hercegovina', 'Bosnia and Herzegovina': 'Bosznia-Hercegovina', 'Bosnia-Herzegovina': 'Bosznia-Hercegovina', Montenegro: 'Montenegró', Albania: 'Albánia',
  'North Macedonia': 'Észak-Macedónia', Kosovo: 'Koszovó', Bulgaria: 'Bulgária', Georgia: 'Grúzia', Armenia: 'Örményország', Azerbaijan: 'Azerbajdzsán', Kazakhstan: 'Kazahsztán', Israel: 'Izrael',
  Cyprus: 'Ciprus', Malta: 'Málta', Luxembourg: 'Luxemburg', Liechtenstein: 'Liechtenstein', Andorra: 'Andorra', 'San Marino': 'San Marino', Gibraltar: 'Gibraltár', 'Faroe Islands': 'Feröer',
  Estonia: 'Észtország', Latvia: 'Lettország', Lithuania: 'Litvánia', Moldova: 'Moldova', Belarus: 'Fehéroroszország', Russia: 'Oroszország',
};
/** első osztály → másodosztály (feljutott csapatok előző idényéhez) */
const SECOND_TIER: Record<string, string> = { 'eng-pl': 'eng-ch', 'esp-ll': 'esp-l2', 'ita-sa': 'ita-sb', 'ger-bl': 'ger-b2', 'fra-l1': 'fra-l2' };
const LEAGUE_BY_SLUG = Object.fromEntries(Object.entries(SLUG).map(([id, slug]) => [slug, id]));
const DOMESTIC = ESPN_LEAGUES.filter((l) => !l.international).map((l) => l.id);

const MIN = 60_000;
const HOUR = 3600_000;

/** Amerikai odds → tizedes odds (pl. -140 → 1,71; +260 → 3,60) */
export function americanToDecimal(s: string | number | undefined | null): number | null {
  if (s == null) return null;
  const n = typeof s === 'number' ? s : parseFloat(String(s).replace('+', ''));
  if (!Number.isFinite(n) || n === 0) return null;
  const dec = n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  return Math.round(dec * 100) / 100;
}

/** Ékezet- és írásjel-független névnormalizálás (derbi-felismeréshez) */
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const DEMO_NAME_TO_ID = new Map(DEMO_TEAMS.map((t) => [norm(t.name), t.id]));
const DEMO_SHORT_TO_ID = new Map(DEMO_TEAMS.map((t) => [norm(t.shortName), t.id]));

function derbyFor(homeName: string, awayName: string): string | null {
  const h = DEMO_NAME_TO_ID.get(norm(homeName)) ?? DEMO_SHORT_TO_ID.get(norm(homeName));
  const a = DEMO_NAME_TO_ID.get(norm(awayName)) ?? DEMO_SHORT_TO_ID.get(norm(awayName));
  if (!h || !a) return null;
  return DERBIES.find(([x, y]) => (x === h && y === a) || (x === a && y === h))?.[2] ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export class EspnProvider implements MatchDataProvider {
  readonly name = 'ESPN nyilvános API (élő, kulcs nélkül)';
  readonly origin = 'live' as const;
  private mem = new Map<string, { at: number; ttl: number; data: Json }>();
  private inflight = 0;
  private queue: (() => void)[] = [];
  private teams = new Map<string, Team>();
  /** csapat → sorozatok (slug), amelyekben szerepel */
  private teamSlugs = new Map<string, Set<string>>();
  private matches = new Map<string, Match>();
  private odds = new Map<string, MatchOdds>();
  private teamsLoaded = new Set<string>();
  private seasonStart = new Map<string, string>();

  constructor(private cache?: HttpCache) {}

  // ---------- HTTP ----------

  private async slot(): Promise<void> {
    if (this.inflight < 4) { this.inflight++; return; }
    await new Promise<void>((r) => this.queue.push(r));
    this.inflight++;
  }
  private release() {
    this.inflight--;
    this.queue.shift()?.();
  }

  private async call(path: string, ttlMs: number): Promise<Json | null> {
    const url = `${BASE}/${path}`;
    const hit = this.mem.get(url);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
    const stored = this.cache?.get(url, ttlMs);
    if (stored) {
      const data = JSON.parse(stored);
      this.mem.set(url, { at: Date.now(), ttl: ttlMs, data });
      return data;
    }
    await this.slot();
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'TIPPMIX-AI/1.0 (personal research tool)', accept: 'application/json' } });
      if (!res.ok) {
        console.error(`[espn] ${path} -> HTTP ${res.status}`);
        return null;
      }
      const data = await res.json();
      this.mem.set(url, { at: Date.now(), ttl: ttlMs, data });
      this.cache?.set(url, JSON.stringify(data));
      return data;
    } catch (e) {
      console.error(`[espn] ${path} -> kivétel:`, (e as Error).message);
      return null;
    } finally {
      this.release();
    }
  }

  // ---------- Csapatok ----------

  private registerTeam(raw: Json, leagueId: string, slug: string): Team {
    const id = `espn-${raw.id}`;
    const league = ESPN_LEAGUES.find((l) => l.id === leagueId)!;
    const existing = this.teams.get(id);
    if (!existing) {
      const en = String(raw.displayName ?? raw.name);
      const hu = slug === NATIONAL_SLUG || slug.startsWith('fifa.') ? NATION_HU[en] : undefined;
      this.teams.set(id, {
        id,
        name: hu ?? en,
        shortName: hu ?? raw.shortDisplayName ?? raw.abbreviation ?? en,
        altNames: hu ? [en] : undefined,
        country: league.international ? '–' : league.country,
        leagueId,
        externalId: Number(raw.id),
      });
    } else if (existing.leagueId !== leagueId && !league.international && ESPN_LEAGUES.find((l) => l.id === existing.leagueId)?.international) {
      // ha először kupából ismertük meg, a hazai bajnokság lesz az elsődleges
      this.teams.set(id, { ...existing, leagueId, country: league.country });
    }
    if (!this.teamSlugs.has(id)) this.teamSlugs.set(id, new Set());
    this.teamSlugs.get(id)!.add(slug);
    return this.teams.get(id)!;
  }

  private async loadTeams(leagueId: string): Promise<void> {
    if (this.teamsLoaded.has(leagueId)) return;
    const data = await this.call(`${SLUG[leagueId]}/teams`, 24 * HOUR);
    const list: Json[] = data?.sports?.[0]?.leagues?.[0]?.teams ?? [];
    for (const t of list) this.registerTeam(t.team, leagueId, SLUG[leagueId]);
    if (list.length) this.teamsLoaded.add(leagueId);
  }

  private async loadAllTeams(): Promise<void> {
    // előbb a hazai bajnokságok (elsődleges liga), utána a kupák
    await Promise.all(DOMESTIC.map((id) => this.loadTeams(id)));
    await Promise.all(ESPN_LEAGUES.filter((l) => l.international).map((l) => this.loadTeams(l.id)));
  }

  // ---------- Meccsek ----------

  private toMatch(ev: Json, leagueId: string): Match | null {
    const comp = ev.competitions?.[0];
    if (!comp) return null;
    const slug = SLUG[leagueId];
    const home = comp.competitors?.find((c: Json) => c.homeAway === 'home');
    const away = comp.competitors?.find((c: Json) => c.homeAway === 'away');
    if (!home || !away) return null;
    const h = this.registerTeam(home.team, leagueId, slug);
    const a = this.registerTeam(away.team, leagueId, slug);
    const st = (ev.status ?? comp.status)?.type ?? {};
    const name = String(st.name ?? '');
    const status: Match['status'] = st.completed ? 'finished'
      : st.state === 'in' ? 'live'
      : /POSTPONED|CANCELED|SUSPENDED|ABANDONED/.test(name) ? 'postponed' : 'scheduled';
    const league = ESPN_LEAGUES.find((l) => l.id === leagueId)!;
    const reasons: string[] = [];
    let importance: MatchImportance = 'normal';
    const derby = derbyFor(h.name, a.name);
    if (derby) { reasons.push(derby); importance = 'top'; }
    if (league.international) { reasons.push('Nemzetközi kupamérkőzés'); if (importance === 'normal') importance = 'high'; }
    const score = (c: Json) => {
      const s = c.score;
      const v = typeof s === 'object' && s ? s.value : s;
      const n = v == null ? NaN : parseFloat(String(v));
      return Number.isFinite(n) ? n : undefined;
    };
    const m: Match = {
      id: `espn-${slug}-${ev.id}`,
      leagueId,
      homeTeamId: h.id,
      awayTeamId: a.id,
      kickoff: new Date(ev.date ?? comp.date).toISOString(),
      status,
      round: ev.week?.number ? `${ev.week.number}. forduló` : undefined,
      importance,
      importanceReasons: reasons,
      homeGoals: status === 'scheduled' ? undefined : score(home),
      awayGoals: status === 'scheduled' ? undefined : score(away),
      origin: 'live',
    };
    this.matches.set(m.id, m);
    const odds = this.toOdds(m.id, comp.odds?.[0]);
    if (odds) this.odds.set(m.id, odds);
    return m;
  }

  private toOdds(matchId: string, o: Json): MatchOdds | null {
    if (!o) return null;
    const markets: Record<string, number> = {};
    const ml = o.moneyline;
    const pick = (x: Json) => americanToDecimal(x?.close?.odds ?? x?.open?.odds);
    const h = pick(ml?.home), d = pick(ml?.draw), a = pick(ml?.away);
    if (h) markets['1'] = h;
    if (d) markets['X'] = d;
    if (a) markets['2'] = a;
    const line = parseFloat(String(o.total?.over?.close?.line ?? o.total?.over?.open?.line ?? o.overUnder ?? '').replace(/[ou]/i, ''));
    if (Number.isFinite(line) && [0.5, 1.5, 2.5, 3.5, 4.5].includes(line)) {
      const ov = pick(o.total?.over), un = pick(o.total?.under);
      if (ov) markets[`O${line}`] = ov;
      if (un) markets[`U${line}`] = un;
    }
    if (!Object.keys(markets).length) return null;
    return { matchId, source: 'live', bookmaker: o.provider?.name ? `${o.provider.name} (ESPN)` : 'ESPN', retrievedAt: new Date().toISOString(), markets };
  }

  private async scoreboard(leagueId: string, dateKey: string): Promise<Match[]> {
    const d = dateKey.replace(/-/g, '');
    const today = localDateKey(new Date().toISOString());
    const ttl = dateKey < today ? 6 * HOUR : 5 * MIN;
    const data = await this.call(`${SLUG[leagueId]}/scoreboard?dates=${d}`, ttl);
    const start = data?.leagues?.[0]?.season?.startDate;
    if (start) this.seasonStart.set(leagueId, new Date(start).toISOString());
    return ((data?.events ?? []) as Json[]).map((ev) => this.toMatch(ev, leagueId)).filter((m): m is Match => !!m);
  }

  async getLeagues(): Promise<League[]> { return ESPN_LEAGUES; }

  async getTeams(): Promise<Team[]> {
    await this.loadAllTeams();
    return [...this.teams.values()];
  }

  async getTeam(id: string): Promise<Team | null> {
    if (!this.teams.has(id)) await this.loadAllTeams();
    return this.teams.get(id) ?? null;
  }

  async getMatches(q: MatchQuery): Promise<Match[]> {
    const today = localDateKey(new Date().toISOString());
    const days: string[] = [];
    if (q.from || q.to) {
      const from = new Date((q.from ?? today) + 'T12:00:00');
      const to = new Date((q.to ?? q.from ?? today) + 'T12:00:00');
      for (let d = new Date(from); d <= to && days.length < 14; d.setDate(d.getDate() + 1)) days.push(localDateKey(d.toISOString()));
    } else {
      days.push(q.date ?? today);
    }
    const leagues = ESPN_LEAGUES.filter((l) => (!q.leagueId || l.id === q.leagueId) && (!q.country || l.country === q.country));
    const lists = await Promise.all(leagues.flatMap((l) => days.map((d) => this.scoreboard(l.id, d))));
    const seen = new Set<string>();
    return lists.flat()
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .filter((m) => {
        // az ESPN a nap UTC-eltolása miatt szomszédos napi meccseket is adhat – helyi nap szerint szűrünk
        const day = localDateKey(m.kickoff);
        if (q.date && !q.from && !q.to && day !== q.date) return false;
        if (q.from && day < q.from) return false;
        if (q.to && day > q.to) return false;
        if (q.teamId && m.homeTeamId !== q.teamId && m.awayTeamId !== q.teamId) return false;
        if (q.importance && m.importance !== q.importance) return false;
        if (q.status && m.status !== q.status) return false;
        return true;
      })
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  }

  async getMatch(id: string): Promise<Match | null> {
    if (this.matches.has(id)) return this.matches.get(id)!;
    const m = id.match(/^espn-([a-z0-9.]+)-(\d+)$/);
    if (!m) return null;
    const leagueId = LEAGUE_BY_SLUG[m[1]];
    if (!leagueId) return null;
    const data = await this.call(`${m[1]}/summary?event=${m[2]}`, 5 * MIN);
    const comp = data?.header?.competitions?.[0];
    if (!comp) return null;
    return this.toMatch({ id: m[2], date: comp.date, status: comp.status, competitions: [comp] }, leagueId);
  }

  // ---------- Eredmények ----------

  private seasonYear(leagueId: string): number {
    const now = new Date();
    if (leagueId === 'usa-mls') return now.getFullYear();
    return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  }

  private async teamSchedule(teamId: string, leagueId: string, season?: number): Promise<MatchResult[]> {
    const team = this.teams.get(teamId);
    if (!team?.externalId) return [];
    const slug = SLUG[leagueId];
    const data = await this.call(`${slug}/teams/${team.externalId}/schedule${season ? `?season=${season}` : ''}`, 3 * HOUR);
    const out: MatchResult[] = [];
    for (const ev of (data?.events ?? []) as Json[]) {
      const comp = ev.competitions?.[0];
      const st = comp?.status?.type;
      if (!comp || !st?.completed) continue;
      const home = comp.competitors?.find((c: Json) => c.homeAway === 'home');
      const away = comp.competitors?.find((c: Json) => c.homeAway === 'away');
      if (!home || !away) continue;
      const hg = parseFloat(String(home.score?.value ?? home.score?.displayValue ?? home.score));
      const ag = parseFloat(String(away.score?.value ?? away.score?.displayValue ?? away.score));
      if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
      const h = this.registerTeam(home.team, leagueId, slug);
      const a = this.registerTeam(away.team, leagueId, slug);
      out.push({ id: `espn-${slug}-${ev.id}`, leagueId, date: new Date(ev.date).toISOString(), homeTeamId: h.id, awayTeamId: a.id, homeGoals: hg, awayGoals: ag, origin: 'live' });
    }
    return out;
  }

  async getTeamResults(teamId: string): Promise<MatchResult[]> {
    if (!this.teams.has(teamId)) await this.loadAllTeams();
    const team = this.teams.get(teamId);
    if (!team) return [];
    const slugs = [...(this.teamSlugs.get(teamId) ?? [SLUG[team.leagueId]])];
    const jobs: Promise<MatchResult[]>[] = [];
    if (slugs.some((sl) => sl === NATIONAL_SLUG || sl.startsWith('fifa.'))) {
      // Válogatott: Nemzetek Ligája (aktuális + előző kiírás), vb-selejtező, barátságos meccsek
      const y = this.seasonYear('uefa-nl');
      for (const [sl, off] of NATIONAL_HISTORY) jobs.push(this.teamSchedule(teamId, LEAGUE_BY_SLUG[sl], off === 0 ? undefined : y + off));
      const seenN = new Set<string>();
      return (await Promise.all(jobs)).flat().filter((r) => (seenN.has(r.id) ? false : (seenN.add(r.id), true)));
    }
    for (const slug of slugs) {
      const leagueId = LEAGUE_BY_SLUG[slug];
      jobs.push(this.teamSchedule(teamId, leagueId));
      // az előző idény is kell, hogy idény elején is legyen legalább 10 meccs
      if (!ESPN_LEAGUES.find((l) => l.id === leagueId)!.international) jobs.push(this.teamSchedule(teamId, leagueId, this.seasonYear(leagueId) - 1));
    }
    const seen = new Set<string>();
    const results = (await Promise.all(jobs)).flat().filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    // Feljutott csapat: ha az első osztályból kevés meccs van, az előző idény másodosztályú eredményei is bekerülnek
    // (a Team.leagueId szerinti liga marad az elsődleges; az elemzés kockázatai között jelezzük az alacsonyabb osztályt).
    const second = SECOND_TIER[team.leagueId];
    if (second && results.filter((r) => r.leagueId === team.leagueId).length < 10) {
      const extra = await this.teamSchedule(teamId, second, this.seasonYear(team.leagueId) - 1);
      for (const r of extra) if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
    }
    return results;
  }

  async getLeagueResults(leagueId: string): Promise<MatchResult[]> {
    await this.loadTeams(leagueId);
    const ids = [...this.teams.values()].filter((t) => this.teamSlugs.get(t.id)?.has(SLUG[leagueId])).map((t) => t.id);
    const seen = new Set<string>();
    const all = await Promise.all(ids.map((id) => this.teamSchedule(id, leagueId)));
    const league = ESPN_LEAGUES.find((l) => l.id === leagueId)!;
    // Hazai bajnokság: előző idény is; Nemzetek Ligája: az előző (két évvel korábbi) kiírás, hogy legyen liga-átlag
    const prevSeason = !league.international ? this.seasonYear(leagueId) - 1 : leagueId === 'uefa-nl' ? this.seasonYear(leagueId) - 2 : null;
    const prev = prevSeason == null ? [] : await Promise.all(ids.map((id) => this.teamSchedule(id, leagueId, prevSeason)));
    return [...all.flat(), ...prev.flat()].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  async getResultsForAnalysis(match: Match): Promise<MatchResult[]> {
    const [lg, h, a] = await Promise.all([this.getLeagueResults(match.leagueId), this.getTeamResults(match.homeTeamId), this.getTeamResults(match.awayTeamId)]);
    const seen = new Set<string>();
    return [...lg, ...h, ...a].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  async getOdds(matchId: string): Promise<MatchOdds | null> {
    if (!this.odds.has(matchId)) await this.getMatch(matchId);
    return this.odds.get(matchId) ?? null;
  }

  /** Az aktuális idény kezdete (tabellához) – az ESPN scoreboard válaszából, különben becsült (júl. 1.). */
  async getSeasonStart(leagueId: string): Promise<string> {
    if (!this.seasonStart.has(leagueId)) await this.scoreboard(leagueId, localDateKey(new Date().toISOString()));
    return this.seasonStart.get(leagueId) ?? `${this.seasonYear(leagueId)}-${leagueId === 'usa-mls' ? '01-01' : '07-01'}T00:00:00.000Z`;
  }
}

export function localDateKey(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
