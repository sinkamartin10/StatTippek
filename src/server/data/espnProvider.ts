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
import type { CornerResult, League, Match, MatchImportance, MatchOdds, MatchResult, Team } from '../../shared/types';
import type { HttpCache } from '../db/database';
import { DERBIES, TEAMS as DEMO_TEAMS } from './demo/leagues';
import type { CornerFetch, CornerRef, MatchDataProvider, MatchQuery } from './provider';
import { candidateMonths, espnMonthKey, monthEndUtc, parseScoreboardCorners, shiftMonth, type ParsedCorners } from './espnCorners';
import { espnTeamLogo } from '../../shared/teamLogo';
import { parseScoreboardResults, type ScoreboardResult } from './scoreboardResults';
import { HISTORY_ONLY_DOMESTIC, closedBefore, dedupeResults, extendedRequests, requestKey, type CoverageReason, type TeamState } from './historyPlan';

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
  { id: 'ger-dfb', name: 'DFB-Pokal', country: 'Németország', countryCode: 'GER', tier: 0, international: false, domesticCup: true },
  { id: 'eng-efl', name: 'EFL Cup (Carabao Cup)', country: 'Anglia', countryCode: 'ENG', tier: 0, international: false, domesticCup: true },
  { id: 'esp-cdr', name: 'Copa del Rey', country: 'Spanyolország', countryCode: 'ESP', tier: 0, international: false, domesticCup: true },
];

export const SLUG: Record<string, string> = {
  'eng-pl': 'eng.1', 'esp-ll': 'esp.1', 'ita-sa': 'ita.1', 'ger-bl': 'ger.1', 'fra-l1': 'fra.1',
  'uefa-ucl': 'uefa.champions', 'uefa-uel': 'uefa.europa', 'uefa-uecl': 'uefa.europa.conf', 'usa-mls': 'usa.1',
  'eng-ch': 'eng.2', 'esp-l2': 'esp.2', 'ita-sb': 'ita.2', 'ger-b2': 'ger.2', 'fra-l2': 'fra.2',
  'uefa-nl': 'uefa.nations', 'fifa-wcq-uefa': 'fifa.worldq.uefa', 'fifa-friendly': 'fifa.friendly',
  'ger-dfb': 'ger.dfb_pokal',
  // ESPN: 3920 „English Carabao Cup” – hosszabbítás nincs, döntetlennél azonnal tizenegyesek (STATUS_FINAL_PEN)
  'eng-efl': 'eng.league_cup',
  // ESPN: 3951 „Spanish Copa del Rey” – hosszabbítás (STATUS_FINAL_AET) és tizenegyesek (STATUS_FINAL_PEN) is van
  'esp-cdr': 'esp.copa_del_rey',
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
/**
 * Kupa (nemzetközi vagy hazai): nem elsődleges sorozat – a csapat elsődleges sorozata a bajnoksága, és a kupa
 * előző idényét nem töltjük le. A meglévő sorozatokra azonos a korábbi `international` feltétellel.
 */
const isCup = (l: League) => l.international || !!l.domesticCup;
/** Hosszabbítással ('aet') vagy tizenegyespárbajjal ('pen') eldőlt meccs az ESPN státuszából; rendes játékidő: null. */
export function decidedByOf(st: { name?: unknown; shortDetail?: unknown } | null | undefined): 'aet' | 'pen' | null {
  const text = `${st?.name ?? ''} ${st?.shortDetail ?? ''}`;
  if (/PEN/i.test(text)) return 'pen';
  if (/AET/i.test(text)) return 'aet';
  return null;
}
const leagueById = (id: string) => ESPN_LEAGUES.find((l) => l.id === id)!;
const DOMESTIC = ESPN_LEAGUES.filter((l) => !isCup(l)).map((l) => l.id);

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
  /** `at`: a memóriába kerülés ideje (a TTL ehhez mér – változatlan viselkedés); `fetchedAt`: a forrás eredeti lekérése (null = ismeretlen) */
  private mem = new Map<string, { at: number; ttl: number; data: Json; fetchedAt: number | null }>();
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
    // a felszabaduló helyet a release() közvetlenül nekünk adja át (a számláló közben nem csökken)
    await new Promise<void>((r) => this.queue.push(r));
  }
  private release() {
    const next = this.queue.shift();
    if (next) next(); else this.inflight--;
  }

  /**
   * @param opts.retain false: a választ NEM tartjuk meg (se memóriában, se a SQLite-cache-ben) –
   * tömeges, egyszer feldolgozott lekérésekhez (a több ligás modell ~1250 havi listája
   * feldolgozatlanul ~430 MB heap lenne). A meglévő cache-bejegyzést ilyenkor is használjuk.
   */
  private async call(path: string, ttlMs: number, opts: { retain?: boolean } = {}): Promise<Json | null> {
    return (await this.callMeta(path, ttlMs, opts))?.data ?? null;
  }

  /**
   * Mint a `call`, de a válasz FORRÁS-lekérésének idejével (ms): hálózati kérésnél a válasz
   * megérkezése, cache-találatnál a cache-bejegyzés eredeti lekérése (null, ha a cache ezt nem
   * közli). null = sikertelen lekérés (hálózat, HTTP-hiba) – ilyenkor semmit nem szabad
   * „eltűntnek” tekinteni.
   */
  private async callMeta(path: string, ttlMs: number, opts: { retain?: boolean } = {}): Promise<{ data: Json; fetchedAt: number | null } | null> {
    const retain = opts.retain !== false;
    const url = `${BASE}/${path}`;
    const hit = this.mem.get(url);
    if (hit && Date.now() - hit.at < hit.ttl) return { data: hit.data, fetchedAt: hit.fetchedAt };
    const entry = this.cache?.getEntry ? this.cache.getEntry(url, ttlMs) : null;
    const stored = entry ? entry.body : this.cache?.getEntry ? null : this.cache?.get(url, ttlMs) ?? null;
    if (stored) {
      const data = JSON.parse(stored);
      const fetchedAt = entry ? entry.fetchedAt : null;
      if (retain) this.mem.set(url, { at: Date.now(), ttl: ttlMs, data, fetchedAt });
      return { data, fetchedAt };
    }
    await this.slot();
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'TIPPMIX-AI/1.0 (personal research tool)', accept: 'application/json' } });
      if (!res.ok) {
        console.error(`[espn] ${path} -> HTTP ${res.status}`);
        return null;
      }
      const fetchedAt = Date.now(); // a válasz megérkezése – a saját lekérésünk ideje
      const data = await res.json();
      if (retain) {
        this.mem.set(url, { at: Date.now(), ttl: ttlMs, data, fetchedAt });
        this.cache?.set(url, JSON.stringify(data));
      }
      return { data, fetchedAt };
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
    // címer: csak amit az ESPN maga közöl (a.espncdn.com) – nincs URL-kitalálás
    const logo = espnTeamLogo(raw);
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
        logo,
      });
    } else if (existing.leagueId !== leagueId && !isCup(league) && ESPN_LEAGUES.some((l) => l.id === existing.leagueId && isCup(l))) {
      // ha először kupából ismertük meg, a hazai bajnokság lesz az elsődleges
      this.teams.set(id, { ...existing, leagueId, country: league.country });
    }
    // ha először címer nélküli forrásból ismertük meg, a később kapott címert pótoljuk
    const cur = this.teams.get(id)!;
    if (!cur.logo && logo) this.teams.set(id, { ...cur, logo });
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

  /** a folyamatban lévő teljes csapatlista-betöltés – a párhuzamos hívók ezt várják meg (nincs ismételt lekérés) */
  private allTeamsLoading: Promise<void> | null = null;

  private loadAllTeams(): Promise<void> {
    this.allTeamsLoading ??= (async () => {
      // előbb a hazai bajnokságok (elsődleges liga), utána a kupák
      await Promise.all(DOMESTIC.map((id) => this.loadTeams(id)));
      await Promise.all(ESPN_LEAGUES.filter(isCup).map((l) => this.loadTeams(l.id)));
    })().finally(() => { this.allTeamsLoading = null; });
    return this.allTeamsLoading;
  }

  /**
   * Csak hazai kupából (pl. DFB-Pokal, EFL Cup) ismert csapat: az elsődleges bajnoksága csak a bajnoki
   * csapatlisták betöltése után derül ki (a betöltés ligánként egyszeri, utána nem kér újra).
   */
  private knownOnlyFromDomesticCup(teamId: string): boolean {
    const known = [...(this.teamSlugs.get(teamId) ?? [])];
    return known.length > 0 && known.every((s) => ESPN_LEAGUES.find((l) => l.id === LEAGUE_BY_SLUG[s])?.domesticCup);
  }

  // ---------- Meccsek ----------

  /**
   * @param remember false esetén a meccset és az oddsot NEM írja a közös
   * memóriabeli térképekbe (a `getMatchFresh` így nem változtatja meg, mit
   * lát a többi fogyasztó a `getMatch`-en át).
   * @param obs a forrásválasz: lekérési ideje, és hogy az esemény odds-mezője MÉRVADÓ-e. Mérvadó
   * csak a sikeresen lekért scoreboard (ott az ESPN az eseményhez közli az oddsot); ha egy mérvadó
   * válaszban az eseménynél nincs használható odds, a korábbi odds törlődik (eltűnt vonal).
   */
  private toMatch(ev: Json, leagueId: string, remember = true, obs: { fetchedAt: number | null; via: 'espn-scoreboard' | 'espn-summary'; authoritative: boolean } | null = null): Match | null {
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
    else if (league.domesticCup) { reasons.push('Kupamérkőzés'); if (importance === 'normal') importance = 'high'; }
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
    if (!remember) return m;
    this.matches.set(m.id, m);
    const odds = this.toOdds(m.id, comp.odds?.[0], obs, status);
    if (odds) this.odds.set(m.id, odds);
    // eltűnt vonal: a friss, SIKERES scoreboard ugyanerre az eseményre már nem közöl oddsot →
    // a régi érték nem maradhat használható (sikertelen lekérésnél ide el sem jutunk)
    else if (obs?.authoritative) this.odds.delete(m.id);
    return m;
  }

  private toOdds(matchId: string, o: Json, obs: { fetchedAt: number | null; via: 'espn-scoreboard' | 'espn-summary' } | null = null, status?: Match['status']): MatchOdds | null {
    if (!o) return null;
    const markets: Record<string, number> = {};
    // piaconként feljegyezzük, melyik vonalból jött az ár (a piacok értéke változatlan)
    const priceKind: Record<string, 'close' | 'open' | 'unverified'> = {};
    const ml = o.moneyline;
    const pick = (x: Json) => americanToDecimal(x?.close?.odds ?? x?.open?.odds);
    const kind = (x: Json): 'close' | 'open' => (americanToDecimal(x?.close?.odds) != null ? 'close' : 'open');
    const h = pick(ml?.home), d = pick(ml?.draw), a = pick(ml?.away);
    if (h) { markets['1'] = h; priceKind['1'] = kind(ml?.home); }
    if (d) { markets['X'] = d; priceKind['X'] = kind(ml?.draw); }
    if (a) { markets['2'] = a; priceKind['2'] = kind(ml?.away); }
    const line = parseFloat(String(o.total?.over?.close?.line ?? o.total?.over?.open?.line ?? o.overUnder ?? '').replace(/[ou]/i, ''));
    if (Number.isFinite(line) && [0.5, 1.5, 2.5, 3.5, 4.5].includes(line)) {
      const ov = pick(o.total?.over), un = pick(o.total?.under);
      // az under saját vonala: csak akkor igazolt, ha a forrás közli, és egyezik az over vonalával
      const uLine = parseFloat(String(o.total?.under?.close?.line ?? o.total?.under?.open?.line ?? '').replace(/[ou]/i, ''));
      if (ov) { markets[`O${line}`] = ov; priceKind[`O${line}`] = o.total?.over?.close?.line != null || o.total?.over?.open?.line != null ? kind(o.total?.over) : 'unverified'; }
      if (un) { markets[`U${line}`] = un; priceKind[`U${line}`] = uLine === line ? kind(o.total?.under) : 'unverified'; }
    }
    if (!Object.keys(markets).length) return null;
    return {
      matchId, source: 'live', bookmaker: o.provider?.name ? `${o.provider.name} (ESPN)` : 'ESPN', retrievedAt: new Date().toISOString(), markets,
      // az ESPN egy eseményhez EGY iroda (provider) vonalait közli, egy válaszban
      ...(obs?.fetchedAt != null ? { observedAt: new Date(obs.fetchedAt).toISOString() } : {}),
      ...(obs ? { observation: { via: obs.via, singleBook: !!o.provider?.name, matchStatus: status, priceKind } } : {}),
    };
  }

  private async scoreboard(leagueId: string, dateKey: string): Promise<Match[]> {
    const d = dateKey.replace(/-/g, '');
    const today = localDateKey(new Date().toISOString());
    const ttl = dateKey < today ? 6 * HOUR : 5 * MIN;
    const res = await this.callMeta(`${SLUG[leagueId]}/scoreboard?dates=${d}`, ttl);
    const data = res?.data;
    const start = data?.leagues?.[0]?.season?.startDate;
    if (start) this.seasonStart.set(leagueId, new Date(start).toISOString());
    // csak sikeres, esemény-listát tartalmazó válasz mérvadó az oddsra (hibás/üres szerkezetnél semmit nem törlünk)
    const authoritative = !!res && Array.isArray(data?.events);
    const obs = res ? { fetchedAt: res.fetchedAt, via: 'espn-scoreboard' as const, authoritative } : null;
    return ((authoritative ? data.events : []) as Json[]).map((ev) => this.toMatch(ev, leagueId, true, obs)).filter((m): m is Match => !!m);
  }

  async getLeagues(): Promise<League[]> { return ESPN_LEAGUES; }

  async getTeams(): Promise<Team[]> {
    await this.loadAllTeams();
    return [...this.teams.values()];
  }

  async getTeam(id: string): Promise<Team | null> {
    // kupameccs elemzése hidegindítás után: a csapat elsődleges sorozata a bajnokság legyen, ne a kupa
    if (!this.teams.has(id) || this.knownOnlyFromDomesticCup(id)) await this.loadAllTeams();
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
    const m = id.match(/^espn-([a-z0-9._]+)-(\d+)$/); // a kupák slugjában aláhúzás is van (ger.dfb_pokal, eng.league_cup)
    if (!m) return null;
    const leagueId = LEAGUE_BY_SLUG[m[1]];
    if (!leagueId) return null;
    const data = await this.call(`${m[1]}/summary?event=${m[2]}`, 5 * MIN);
    const comp = data?.header?.competitions?.[0];
    if (!comp) return null;
    // a summary nem mérvadó az oddsra (nem töröl), és megfigyelési időt sem ad → az innen jövő odds nem igazolható
    return this.toMatch({ id: m[2], date: comp.date, status: comp.status, competitions: [comp] }, leagueId, true, { fetchedAt: null, via: 'espn-summary', authoritative: false });
  }

  /**
   * A meccs állapota a memóriabeli térkép MEGKERÜLÉSÉVEL (a `getMatch` a
   * térképben lévő – akár órák óta változatlan – objektumot adja vissza).
   * Ugyanazt a summary-végpontot használja, ugyanazzal az 5 perces HTTP-
   * gyorsítótárral, mint a `getMatch`: új végpont és sűrűbb hívás nincs. A
   * közös térképeket nem írja, így más fogyasztók viselkedése nem változik.
   */
  async getMatchFresh(id: string): Promise<Match | null> {
    const m = id.match(/^espn-([a-z0-9._]+)-(\d+)$/);
    if (!m) return null;
    const leagueId = LEAGUE_BY_SLUG[m[1]];
    if (!leagueId) return null;
    const data = await this.call(`${m[1]}/summary?event=${m[2]}`, 5 * MIN);
    const comp = data?.header?.competitions?.[0];
    if (!comp) return null;
    return this.toMatch({ id: m[2], date: comp.date, status: comp.status, competitions: [comp] }, leagueId, false);
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
      const r: MatchResult = { id: `espn-${slug}-${ev.id}`, leagueId, date: new Date(ev.date).toISOString(), homeTeamId: h.id, awayTeamId: a.id, homeGoals: hg, awayGoals: ag, origin: 'live' };
      // hosszabbítás / tizenegyespárbaj (kupában): a gólszám nem 90 perces eredmény – jelöljük, hogy rendes
      // játékidős átlagba ne számítson (rendes játékidős meccsnél az objektum változatlan)
      const decided = decidedByOf(st);
      if (decided) {
        r.regulation = false;
        r.decidedBy = decided;
        const so = (c: Json) => parseFloat(String(c.score?.shootoutScore ?? c.shootoutScore));
        if (decided === 'pen' && Number.isFinite(so(home)) && Number.isFinite(so(away))) r.shootout = { home: so(home), away: so(away) };
      }
      out.push(r);
    }
    return out;
  }

  async getTeamResults(teamId: string): Promise<MatchResult[]> {
    // csak hazai kupából ismert csapatnál is: így a bajnoki előzménye is bekerül
    if (!this.teams.has(teamId) || this.knownOnlyFromDomesticCup(teamId)) await this.loadAllTeams();
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
      if (!isCup(leagueById(leagueId))) jobs.push(this.teamSchedule(teamId, leagueId, this.seasonYear(leagueId) - 1));
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
    const prevSeason = !isCup(league) ? this.seasonYear(leagueId) - 1 : leagueId === 'uefa-nl' ? this.seasonYear(leagueId) - 2 : null;
    const prev = prevSeason == null ? [] : await Promise.all(ids.map((id) => this.teamSchedule(id, leagueId, prevSeason)));
    return [...all.flat(), ...prev.flat()].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  async getResultsForAnalysis(match: Match): Promise<MatchResult[]> {
    const [lg, h, a] = await Promise.all([this.getLeagueResults(match.leagueId), this.getTeamResults(match.homeTeamId), this.getTeamResults(match.awayTeamId)]);
    // Kupameccs: a liga-alapérték a csapatok ELSŐDLEGES BAJNOKSÁGÁBÓL jön (lásd shared/engine/baseline) – ehhez a
    // bajnokság teljes eredménylistája kell (nem csak a két csapat meccsei). A csapatok sorozata a fenti
    // csapat-lekérés után ismert; bajnoki meccsnél ez az ág nem fut, ott minden változatlan.
    const extra: MatchResult[][] = [];
    const league = ESPN_LEAGUES.find((l) => l.id === match.leagueId);
    if (league && isCup(league)) {
      const own = new Set([match.homeTeamId, match.awayTeamId].map((id) => this.teams.get(id)?.leagueId)
        .filter((id): id is string => !!id && id !== match.leagueId && ESPN_LEAGUES.some((l) => l.id === id && !isCup(l))));
      extra.push(...(await Promise.all([...own].map((id) => this.getLeagueResults(id)))));
    }
    const seen = new Set<string>();
    return [...lg, ...h, ...a, ...extra.flat()].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }

  // ---------- Bővített előzmény – KÍSÉRLETI, az éles elemzés NEM használja ----------

  /** csapat → csak-előzmény hazai bajnokság (pl. por-pl), a csak-előzmény ligák csapatlistáiból */
  private historyTeamLeague = new Map<string, string>();
  private historyTeamsLoaded = false;

  private async loadHistoryOnlyTeams(): Promise<void> {
    if (this.historyTeamsLoaded) return;
    for (const [leagueId, { slug }] of Object.entries(HISTORY_ONLY_DOMESTIC)) {
      const data = await this.call(`${slug}/teams`, 24 * HOUR);
      for (const t of (data?.sports?.[0]?.leagues?.[0]?.teams ?? []) as Json[]) {
        if (t?.team?.id != null) this.historyTeamLeague.set(`espn-${t.team.id}`, leagueId);
      }
    }
    this.historyTeamsLoaded = true;
  }

  /**
   * Csapat-menetrend REGISZTRÁCIÓ NÉLKÜL: a szolgáltató közös állapotát (csapatlista,
   * csapat–sorozat hozzárendelés, meccs- és oddstár) nem módosítja, így az éles
   * `getResultsForAnalysis` viselkedése a bővített letöltéstől független marad.
   * ISMERT ELTÉRÉS: ez a kísérleti út (az éles `teamSchedule`-lal ellentétben) jelenleg NEM jelöli a
   * hosszabbítással / tizenegyespárbajjal eldőlt meccseket (`regulation`, `decidedBy`, `shootout`).
   */
  private async scheduleWithoutRegistering(externalId: number, leagueId: string, season?: number): Promise<MatchResult[]> {
    const slug = SLUG[leagueId] ?? HISTORY_ONLY_DOMESTIC[leagueId]?.slug;
    if (!slug) return [];
    const data = await this.call(`${slug}/teams/${externalId}/schedule${season ? `?season=${season}` : ''}`, 3 * HOUR);
    const out: MatchResult[] = [];
    for (const ev of (data?.events ?? []) as Json[]) {
      const comp = ev.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;
      const home = comp.competitors?.find((c: Json) => c.homeAway === 'home');
      const away = comp.competitors?.find((c: Json) => c.homeAway === 'away');
      if (!home?.team?.id || !away?.team?.id) continue;
      const hg = parseFloat(String(home.score?.value ?? home.score?.displayValue ?? home.score));
      const ag = parseFloat(String(away.score?.value ?? away.score?.displayValue ?? away.score));
      if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
      out.push({ id: `espn-${slug}-${ev.id}`, leagueId, date: new Date(ev.date).toISOString(), homeTeamId: `espn-${home.team.id}`, awayTeamId: `espn-${away.team.id}`, homeGoals: hg, awayGoals: ag, origin: 'live' });
    }
    return out;
  }

  /**
   * KÍSÉRLETI, bővített előzmény egy meccshez: a változatlan éles adatkör
   * (`getResultsForAnalysis`) + a `historyPlan` bővítései (előző kupaidény, kiesett csapat
   * előző élvonalbeli idénye, válogatott naptári ablak, csak-előzmény hazai bajnokság).
   * Egy meccs egyszer szerepel; csak a kezdés előtt legalább 3 órával indult meccsek.
   * Az éles elemzés és a tippek NEM használják.
   */
  async getResultsForAnalysisExtended(match: Match): Promise<{ results: MatchResult[]; sourceOf: Map<string, CoverageReason | 'alap'>; duplicates: number; requests: number }> {
    const base = await this.getResultsForAnalysis(match);
    const state = (id: string): TeamState => {
      const t = this.teams.get(id);
      const competitions = [...(this.teamSlugs.get(id) ?? [])].map((s) => LEAGUE_BY_SLUG[s]).filter(Boolean);
      return { id, leagueId: t?.leagueId ?? match.leagueId, competitions };
    };
    const nowIso = new Date().toISOString();
    // a tervező „international” feltétele = nem elsődleges sorozat (kupa) – a hazai kupa is ide tartozik
    const isIntl = (l: string) => { const x = ESPN_LEAGUES.find((y) => y.id === l); return x ? isCup(x) : false; };
    await this.loadHistoryOnlyTeams();
    const reqs = extendedRequests(match, state(match.homeTeamId), state(match.awayTeamId), nowIso, { international: isIntl }, (id) => this.historyTeamLeague.get(id) ?? null);
    const seenReq = new Set<string>();
    const sourceOf = new Map<string, CoverageReason | 'alap'>(base.map((r) => [r.id, 'alap']));
    const extra: { r: MatchResult; reason: CoverageReason }[] = [];
    let requests = 0;
    for (const req of reqs) {
      if (req.onlyIfFewerThan) {
        const n = base.filter((r) => r.leagueId === req.onlyIfFewerThan!.leagueId && (r.homeTeamId === req.teamId || r.awayTeamId === req.teamId)).length;
        if (n >= req.onlyIfFewerThan.count) continue;
      }
      const ids = req.teamId === '*' ? [...this.teams.values()].filter((t) => this.teamSlugs.get(t.id)?.has(SLUG[req.leagueId])).map((t) => t.id) : [req.teamId];
      for (const id of ids) {
        const key = requestKey({ ...req, teamId: id }, nowIso);
        if (seenReq.has(key)) continue;
        seenReq.add(key);
        const ext = this.teams.get(id)?.externalId;
        if (ext == null) continue;
        requests++;
        for (const r of await this.scheduleWithoutRegistering(ext, req.leagueId, req.season === 'current' ? undefined : req.season)) extra.push({ r, reason: req.reason });
      }
    }
    const merged = dedupeResults([...base, ...extra.map((x) => x.r)]);
    for (const x of extra) if (!sourceOf.has(x.r.id)) sourceOf.set(x.r.id, x.reason);
    const results = closedBefore(merged.results, match.kickoff, 3);
    return { results, sourceOf, duplicates: merged.duplicates, requests };
  }

  /**
   * Egy sorozat egy havi eredménylistája (a több ligás modell tanítóadata). Ugyanaz az
   * ESPN-végpont, mint a szögletadaté; a választ NEM tartjuk meg (a tartós tárolás a 0021
   * táblák dolga – memóriában ~430 MB lenne). Regisztráció NÉLKÜL – a szolgáltató közös
   * állapotát nem módosítja. null = nem érhető el.
   */
  async monthResults(competitionId: string, yyyymm: string): Promise<ScoreboardResult[] | null> {
    const slug = SLUG[competitionId] ?? HISTORY_ONLY_DOMESTIC[competitionId]?.slug;
    if (!slug || !/^\d{6}$/.test(yyyymm)) return null;
    const closed = monthEndUtc(yyyymm) + 3 * 24 * HOUR < Date.now();
    const data = await this.call(`${slug}/scoreboard?dates=${yyyymm}`, closed ? 30 * 24 * HOUR : 30 * MIN, { retain: false });
    return data ? parseScoreboardResults(data, slug, competitionId).results : null;
  }

  async getOdds(matchId: string): Promise<MatchOdds | null> {
    if (!this.odds.has(matchId)) await this.getMatch(matchId);
    return this.odds.get(matchId) ?? null;
  }

  // ---------- Szögletek (külön réteg – a gólelemzés nem használja) ----------

  /**
   * Egy liga egy (keleti idő szerinti) hónapjának szögletadatai a scoreboard
   * végpontról, a meglévő HTTP-cache-sel. A lezárt hónap 30 napig, a folyó
   * hónap 30 percig cache-elt. Hálózati vagy cache-hiba → null (soha nem kitalált adat).
   */
  async getCornerMonth(leagueId: string, yyyymm: string): Promise<ParsedCorners | null> {
    // ugyanarra a hónapra párhuzamosan (csapat- és liga-előzmény) csak egy ESPN-kérés induljon
    const key = `${leagueId}|${yyyymm}`;
    const running = this.cornerInflight.get(key);
    if (running) return running;
    const p = this.fetchCornerMonth(leagueId, yyyymm).finally(() => this.cornerInflight.delete(key));
    this.cornerInflight.set(key, p);
    return p;
  }

  private cornerInflight = new Map<string, Promise<ParsedCorners | null>>();

  private async fetchCornerMonth(leagueId: string, yyyymm: string): Promise<ParsedCorners | null> {
    const slug = SLUG[leagueId];
    if (!slug || !/^\d{6}$/.test(yyyymm)) return null;
    const closed = monthEndUtc(yyyymm) + 3 * 24 * HOUR < Date.now();
    try {
      const data = await this.call(`${slug}/scoreboard?dates=${yyyymm}`, closed ? 30 * 24 * HOUR : 30 * MIN);
      return data ? parseScoreboardCorners(data, slug, leagueId) : null;
    } catch (e) {
      console.error(`[espn] szögletadat ${slug} ${yyyymm} -> kivétel:`, (e as Error).message);
      return null;
    }
  }

  async getCornerResults(refs: CornerRef[]): Promise<CornerFetch> {
    const found = new Map<string, CornerResult>();
    const missing: CornerFetch['missing'] = [];
    const pending = new Map<string, CornerRef>();
    for (const r of refs) {
      const slug = SLUG[r.leagueId];
      if (!slug || !r.matchId.startsWith(`espn-${slug}-`)) { missing.push({ matchId: r.matchId, reason: 'unsupported_league' }); continue; }
      pending.set(r.matchId, r);
    }
    const failedMonths = new Set<string>();
    // 1. kör: az elsődleges (keleti idő szerinti) hónap; 2–3. kör: hónaphatár-közeli tartalék
    for (let attempt = 0; attempt < 3 && pending.size; attempt++) {
      const jobs = new Map<string, { leagueId: string; month: string }>();
      for (const r of pending.values()) {
        const m = candidateMonths(r.kickoff)[attempt];
        if (m) jobs.set(`${r.leagueId}|${m}`, { leagueId: r.leagueId, month: m });
      }
      if (!jobs.size) break;
      const fetched = await Promise.all([...jobs.entries()].map(async ([key, j]) => [key, await this.getCornerMonth(j.leagueId, j.month)] as const));
      for (const [key, parsed] of fetched) {
        if (!parsed) { failedMonths.add(key); continue; }
        for (const r of parsed.results) if (pending.delete(r.matchId)) found.set(r.matchId, r);
        // megtalált, de nem elfogadható meccs (nem befejezett, hosszabbítás, hiányzó érték) – nem keressük tovább
        for (const s of parsed.skipped) if (pending.delete(s.matchId)) missing.push({ matchId: s.matchId, reason: s.reason });
      }
    }
    for (const r of pending.values()) {
      const failed = candidateMonths(r.kickoff).some((m) => failedMonths.has(`${r.leagueId}|${m}`));
      missing.push({ matchId: r.matchId, reason: failed ? 'request_failed' : 'not_found' });
    }
    return { results: [...found.values()], missing, failedRequests: failedMonths.size };
  }

  async getLeagueCornerHistory(leagueId: string, before: string, minMatches: number, maxMonths: number): Promise<CornerFetch> {
    if (!SLUG[leagueId]) return { results: [], missing: [], failedRequests: 0 };
    const seen = new Set<string>();
    const results: CornerResult[] = [];
    let failed = 0;
    let month = espnMonthKey(before);
    for (let i = 0; i < maxMonths && results.length < minMatches; i++, month = shiftMonth(month, -1)) {
      const p = await this.getCornerMonth(leagueId, month);
      if (!p) { failed++; continue; }
      for (const r of p.results) if (r.date < before && !seen.has(r.matchId)) { seen.add(r.matchId); results.push(r); }
    }
    return { results, missing: [], failedRequests: failed };
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
