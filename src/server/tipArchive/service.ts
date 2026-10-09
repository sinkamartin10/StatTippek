/**
 * Modell-tipp archívum – rögzítés, elszámolás és nyilvános lekérdezés.
 *
 * RÖGZÍTÉS: az egyetlen belépési pont a `record(analysis)`, amelyet az
 * AnalysisService a motor (analyzeMatch) TÉNYLEGES lefutása után hív. A motor
 * determinisztikus, a tipp-valószínűséget az odds nem befolyásolja, ezért:
 *   - tartalmilag azonos újraszámolás → nincs új sor (piaconként az ADATBÁZIS
 *     szerinti legutolsó verzió hash-ével hasonlítunk – nincs példányonkénti
 *     memória, így több szerverpéldány mellett sem vész el változás),
 *   - lényegi változás (valószínűség 0,1 százalékpontos pontossággal,
 *     kategória vagy motorverzió) → új, sorszámozott, időbélyeges sor,
 *   - csak az odds változott → nincs új sor (az odds nincs a hash-ben).
 * Ha egy párhuzamos írás ugyanazt a sorszámot foglalta el, újraolvasunk és a
 * következő sorszámmal próbáljuk újra (korlátos számú alkalommal).
 * Nincs ütemezett háttér-generálás: csak az kerül be, amit a termék kérésre
 * ténylegesen kiszámolt.
 *
 * NYILVÁNOSSÁG: a meccs aktuális, hitelesen megfigyelt állapota
 * (`observe`) dönti el – csak az elkezdődött (live) vagy lejátszott
 * (finished) meccs tippjei látszanak. Az állapotot az elemzés (friss
 * getMatch) és a kérés-vezérelt frissítési kör írja; a régebbi megfigyelés
 * nem írhatja felül az újabbat.
 *
 * ELSZÁMOLÁS: a meglévő `evaluateMarket()` szabállyal, a hiteles
 * meccsadatból (`getMatch` → finished + végeredmény). Második szabályrendszer
 * nincs. Ismeretlen piac → „nem elszámolható” (nem vereség). Elhalasztott,
 * törölt, félbeszakadt meccs a szolgáltatónál `postponed` állapotú, sosem
 * `finished` → a tipp függő marad, és nem számít vereségnek.
 */
import { createHash } from 'node:crypto';
import type { Match, MatchAnalysis } from '../../shared/types';
import { evaluateMarket, marketLabel, marketType } from '../../shared/engine/markets';
import { ENGINE_VERSION } from '../../shared/engine/version';
import {
  ARCHIVE_MARKET_TYPES, ARCHIVE_MAX_OFFSET, ARCHIVE_PAGE_MAX, ARCHIVE_PAGE_SIZE, SETTLEMENT_STATUSES,
  TIP_AVAILABILITIES, hitRateOf, sanitizeSearch,
  type SettlementStatus, type TipArchiveEntry, type TipArchiveResponse, type TipAvailability,
} from '../../shared/tipArchive';
import type { MatchDataProvider } from '../data/provider';
import type {
  ArchiveDraft, ArchiveFilter, ArchiveRow, ArchiveScope, LatestVersion, MatchObservation, ObservedStatus, TipArchiveStore,
} from './store';

export class TipArchiveError extends Error {
  constructor(message: string, public status = 400, public code = 'BAD_REQUEST') { super(message); }
}

/** Ennél régebbi kezdésű meccset már nem frissítünk automatikusan. */
const REFRESH_LOOKBACK_MS = 30 * 86_400_000;
/** Egy frissítési körben legfeljebb ennyi meccset kérdezünk le. */
const REFRESH_BATCH = 20;
/** Két frissítési kör között legalább ennyi idő telik el. */
const REFRESH_THROTTLE_MS = 2 * 60_000;
/** Ugyanazt a meccset ennyi ideig nem kérdezzük újra. */
const RECHECK_MS = 15 * 60_000;
/** A lekérdezés legfeljebb ennyit vár a frissítésre, utána a háttérben fut tovább. */
const REFRESH_WAIT_MS = 3_000;
/** A due-lista lapmérete és a körönként legfeljebb átnézett lapok száma (kötött lekérdezésszám). */
const REFRESH_PAGE = 60;
const REFRESH_MAX_PAGES = 5;
/** Beszúrás + ellenőrző olvasás legfeljebb ennyi körben (ütközés / párhuzamos írás esetén). */
const INSERT_ATTEMPTS = 4;
const RESPONSE_TTL_MS = 30_000;
const MAX_MEMO = 2_000;

/** Tartalom-hash: CSAK a tipp lényegi tartalma (odds és időbélyeg nélkül). */
export function contentHash(matchId: string, market: string, category: string, modelProb: number, engineVersion = ENGINE_VERSION): string {
  return createHash('sha256').update(`${engineVersion}|${matchId}|${market}|${category}|${modelProb.toFixed(3)}`).digest('hex');
}

/**
 * A szolgáltató állapota → megfigyelt állapot. A végeredmény nélküli
 * „finished” `live` marad: elkezdődött, de még nem elszámolható – így a
 * frissítési kör tovább figyeli.
 */
export function observedStatusOf(m: Pick<Match, 'status' | 'homeGoals' | 'awayGoals'>): ObservedStatus {
  if (m.status === 'finished') return m.homeGoals != null && m.awayGoals != null ? 'finished' : 'live';
  if (m.status === 'live' || m.status === 'postponed') return m.status;
  return 'scheduled';
}

/** Előrehaladási sorrend azonos kezdésen belül. */
const STATUS_RANK: Record<ObservedStatus, number> = { scheduled: 0, postponed: 0, live: 1, finished: 2 };
const isVisibleStatus = (s: ObservedStatus) => s === 'live' || s === 'finished';

/**
 * Elfogadjuk-e az új megfigyelést a tárolt állapot helyett?
 *
 * FORRÁS-IDŐBÉLYEG NINCS: sem az ESPN, sem az API-Football meccsobjektuma nem
 * hoz megbízható „utoljára frissítve” mezőt vagy verziót, ezért ilyet nem
 * találunk ki. Az `observedAt` csak azt mondja meg, MIKOR olvastuk ki az adatot
 * – egy később kiolvasott, de régi gyorsítótár-tartalom is újabbnak látszana.
 * Ezért időrend helyett tartalmi, konzervatív szabályt alkalmazunk:
 *
 *  1. régebben kiolvasott megfigyelés sosem ír felül újabbat,
 *  2. AZONOS kezdésen belül az állapot csak előre haladhat
 *     (scheduled → live → finished); visszalépés (pl. live → régi „scheduled”)
 *     elavult adatnak minősül. Kivétel: a `postponed` elfogadott a még nem
 *     lejátszott meccsen (rejt – biztonságos irány),
 *  3. ELTÉRŐ kezdés esetén nem tudjuk eldönteni, melyik a frissebb. Ha az új
 *     megfigyelés NYILVÁNOSSÁ tenné a meccset, miközben a tárolt kezdés még a
 *     jövőben van, ellentmondásnak tekintjük és elvetjük (a meccs rejtve
 *     marad, amíg a tárolt kezdés is el nem múlik vagy egyező megfigyelés nem
 *     jön). Minden más kezdés-változás (pl. átütemezés a jövőbe) elfogadott –
 *     ezek csak rejthetnek.
 *
 * Így egy bizonytalan vagy ellentmondó megfigyelés legfeljebb ELREJTHET egy
 * meccset, nyilvánossá tenni nem tudja.
 */
export function decideObservation(
  current: MatchObservation | null, incoming: MatchObservation, now: Date,
): { accept: boolean; reason: string } {
  if (!current) return { accept: true, reason: 'első megfigyelés' };
  if (incoming.observedAt < current.observedAt) return { accept: false, reason: 'régebben kiolvasott megfigyelés' };
  if (incoming.kickoff === current.kickoff) {
    if (current.status === 'finished' && incoming.status !== 'finished') return { accept: false, reason: 'a lejátszott meccs állapota nem léphet vissza' };
    if (incoming.status === 'postponed') return { accept: true, reason: 'elhalasztás (rejt)' };
    if (current.status === 'postponed') return { accept: true, reason: 'elhalasztás után új állapot' };
    if (STATUS_RANK[incoming.status] < STATUS_RANK[current.status]) return { accept: false, reason: 'állapot-visszalépés (elavult adat)' };
    return { accept: true, reason: 'előrehaladás vagy azonos állapot' };
  }
  if (isVisibleStatus(incoming.status) && current.kickoff > now.toISOString()) {
    return { accept: false, reason: 'ellentmondó kezdés: a tárolt kezdés még jövőbeli' };
  }
  return { accept: true, reason: 'kezdés-változás' };
}

/**
 * A nyilvános adatforma – allowlist. A `kickoff` a meccs AKTUÁLIS, már elmúlt
 * kezdése; a generáláskori kezdés (audit) és minden belső jelző kimarad.
 */
export function toEntry(r: ArchiveRow, counted: boolean): TipArchiveEntry {
  return {
    id: r.id,
    matchId: r.matchId,
    matchLabel: r.matchLabel,
    leagueId: r.leagueId,
    leagueName: r.leagueName,
    kickoff: r.currentKickoff,
    market: r.market,
    marketLabel: r.marketLabel,
    marketType: r.marketType,
    category: r.category,
    modelProb: r.modelProb,
    odds: r.odds,
    dataQuality: r.dataQuality,
    sampleSize: r.sampleSize,
    engineVersion: r.engineVersion,
    versionNo: r.versionNo,
    generatedAt: r.generatedAt,
    preKickoff: r.preKickoff,
    counted,
    availability: r.availability,
    status: r.status,
    homeGoals: r.homeGoals,
    awayGoals: r.awayGoals,
    settledAt: r.settledAt,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-zA-Z0-9._:-]{1,80}$/;

/** A dátumszűrő naptára: magyar idő, a szerver időzónájától függetlenül. */
export const ARCHIVE_TIME_ZONE = 'Europe/Budapest';
const tzParts = new Intl.DateTimeFormat('en-US', {
  timeZone: ARCHIVE_TIME_ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** A magyar falióra eltérése az UTC-től az adott pillanatban (ms). */
function budapestOffsetMs(utcMs: number): number {
  const p = Object.fromEntries(tzParts.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/**
 * YYYY-MM-DD → a MAGYAR naptári nap kezdete UTC-ben (téli/nyári időszámítással).
 * A szerver (pl. Render: UTC) helyi idejétől független.
 */
export function budapestDayStart(key: string, plusDays = 0): string | null {
  if (!DATE.test(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  const wall = Date.UTC(y, m - 1, d + plusDays);
  // Két lépés: az első becslés eltolása, majd a tényleges pillanat eltolása (DST-váltás napján is pontos;
  // a magyar éjfél sosem esik az óraátállítás résébe).
  let t = wall - budapestOffsetMs(wall);
  t = wall - budapestOffsetMs(t);
  return new Date(t).toISOString();
}

export interface ParsedArchiveQuery {
  filter: Omit<ArchiveFilter, 'origin' | 'visibleBefore'>;
  scope: ArchiveScope;
  page: number;
  pageSize: number;
}

/** A kérés paramétereinek ellenőrzése. Hibás bemenetre TipArchiveError (400). */
export function parseArchiveQuery(raw: Record<string, unknown>): ParsedArchiveQuery {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const filter: ParsedArchiveQuery['filter'] = {};

  const from = str(raw.from);
  const to = str(raw.to);
  if (from) {
    const iso = budapestDayStart(from);
    if (!iso) throw new TipArchiveError('Érvénytelen kezdő dátum (YYYY-MM-DD).');
    filter.from = iso;
  }
  if (to) {
    if (!budapestDayStart(to)) throw new TipArchiveError('Érvénytelen záró dátum (YYYY-MM-DD).');
    filter.to = budapestDayStart(to, 1)!; // a záró nap egésze benne van
  }
  if (filter.from && filter.to && filter.from >= filter.to) throw new TipArchiveError('A kezdő dátum nem lehet későbbi a záró dátumnál.');

  const leagueId = str(raw.leagueId);
  if (leagueId) {
    if (!ID.test(leagueId)) throw new TipArchiveError('Érvénytelen bajnokság-azonosító.');
    filter.leagueId = leagueId;
  }
  const mt = str(raw.marketType);
  if (mt) {
    if (!(ARCHIVE_MARKET_TYPES as readonly string[]).includes(mt)) throw new TipArchiveError('Ismeretlen piactípus.');
    filter.marketType = mt;
  }
  const status = str(raw.status);
  if (status) {
    if (!SETTLEMENT_STATUSES.includes(status as SettlementStatus)) throw new TipArchiveError('Ismeretlen eredmény-állapot.');
    filter.status = status as SettlementStatus;
  }
  const availability = str(raw.availability);
  if (availability) {
    if (!TIP_AVAILABILITIES.includes(availability as TipAvailability)) throw new TipArchiveError('Ismeretlen közzétételi állapot.');
    filter.availability = availability as TipAvailability;
  }
  const search = sanitizeSearch(raw.search);
  if (search) filter.search = search;

  const scopeRaw = str(raw.scope) ?? 'all';
  if (scopeRaw !== 'all' && scopeRaw !== 'counted') throw new TipArchiveError('Ismeretlen nézet (all | counted).');

  const pageRaw = str(raw.page);
  const page = pageRaw == null ? 1 : Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) throw new TipArchiveError('Érvénytelen oldalszám.');
  const sizeRaw = str(raw.pageSize);
  const sizeNum = sizeRaw == null ? ARCHIVE_PAGE_SIZE : Number(sizeRaw);
  if (!Number.isInteger(sizeNum) || sizeNum < 1) throw new TipArchiveError('Érvénytelen oldalméret.');
  const pageSize = Math.min(ARCHIVE_PAGE_MAX, sizeNum);
  if ((page - 1) * pageSize > ARCHIVE_MAX_OFFSET) throw new TipArchiveError('Túl mély lapozás – szűkítsd a szűrőkkel.');

  return { filter, scope: scopeRaw, page, pageSize };
}

export interface TipArchiveOptions {
  now?: () => Date;
  /** a lekérdezés ennyit vár a frissítésre (teszteknél állítható) */
  settleWaitMs?: number;
}

export class TipArchiveService {
  private now: () => Date;
  private settleWaitMs: number;
  /** meccsenként sorba állított rögzítés – egy példányon belül két számolás nem versenyez a sorszámért */
  private chain = new Map<string, Promise<unknown>>();
  private lastRefreshRun = 0;
  private refreshing: Promise<number> | null = null;
  private checkedAt = new Map<string, number>();
  private responses = new Map<string, { at: number; value: TipArchiveResponse }>();

  constructor(
    private store: TipArchiveStore,
    private data: Pick<MatchDataProvider, 'getMatch' | 'getMatchFresh' | 'origin'>,
    opts: TipArchiveOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.settleWaitMs = opts.settleWaitMs ?? REFRESH_WAIT_MS;
  }

  private remember<V>(map: Map<string, V>, key: string, value: V) {
    if (map.size >= MAX_MEMO && !map.has(key)) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  }

  /**
   * Egy ténylegesen lefutott elemzés tippjeinek rögzítése. Visszaadja az új
   * sorok számát. Meccsenként sorba állítva fut.
   */
  record(analysis: MatchAnalysis): Promise<number> {
    const id = analysis.match.id;
    const prev = this.chain.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.recordInner(analysis));
    this.chain.set(id, next);
    void next.finally(() => { if (this.chain.get(id) === next) this.chain.delete(id); }).catch(() => undefined);
    return next;
  }

  private async recordInner(a: MatchAnalysis): Promise<number> {
    let inserted = 0;
    if (a.poisson && a.tips.length) {
      const m = a.match;
      const kickoff = new Date(m.kickoff).toISOString();
      const generatedAt = new Date(a.generatedAt).toISOString();
      const seen = new Set<string>();
      const tips = a.tips.filter((t) => (seen.has(t.market) ? false : (seen.add(t.market), true)));
      const wanted = new Map(tips.map((t) => [t.market, { tip: t, hash: contentHash(m.id, t.market, t.category, t.modelProb) }]));

      // ÁLLAPOT ELŐBB, SOROK UTÁNA: ha a meccsnek még nincs tárolt állapota,
      // a tipp-sorok beszúrása ELŐTT rögzítjük. Ha ez elbukik, nem keletkezik
      // árva (állapot nélküli, sosem frissített) sor; ha sikerül, a meccs a
      // frissítési kör látókörében van akkor is, ha a későbbi lépések elbuknak.
      // A „finished” itt még „live”: a frissítés addig figyeli, amíg az
      // elszámolás is meg nem történt.
      if (!(await this.store.matchState(m.id))) {
        await this.writeState(m, generatedAt, true);
      }

      const draftFor = (market: string, last: LatestVersion | undefined): ArchiveDraft => {
        const { tip: t, hash } = wanted.get(market)!;
        return {
          matchId: m.id,
          market,
          versionNo: (last?.versionNo ?? 0) + 1,
          contentHash: hash,
          engineVersion: ENGINE_VERSION,
          generatedAt,
          origin: a.origin,
          matchLabel: `${a.homeTeam.name} – ${a.awayTeam.name}`,
          leagueId: a.league.id,
          leagueName: a.league.name,
          kickoff,
          marketLabel: t.label || marketLabel(market),
          marketType: marketType(market),
          category: t.category,
          modelProb: t.modelProb,
          odds: t.odds != null && t.odds > 1 ? Math.round(t.odds * 100) / 100 : null,
          impliedProb: t.impliedProb != null && t.impliedProb >= 0 && t.impliedProb <= 1 ? t.impliedProb : null,
          dataQuality: a.dataQuality.level,
          sampleSize: Math.max(0, Math.round(t.sampleSize)),
          supportingIndicators: Math.max(0, Math.round(t.supportingIndicators)),
          preKickoff: generatedAt < kickoff,
          availability: 'pro_on_request',
        };
      };

      // 1. kör: az ADATBÁZIS legutolsó verziójához hasonlítunk (nincs
      //    példányonkénti memória) – tartalmilag azonos → nincs új sor.
      // Ellenőrző kör(ök): a beszúrás UTÁN újraolvasunk. Ha közben egy másik
      //    példány a mi számolásunknál RÉGEBBI, eltérő tartalmú verziót írt a
      //    legutolsó helyre (pl. A → [B a másik példányról] → A), vagy a mi
      //    sorunk sorszám-ütközés miatt kimaradt, a mi – frissebb – kimenetünket
      //    a következő sorszámmal rögzítjük. A nálunk FRISSEBB idegen verziót
      //    nem írjuk felül. Egyezésnél (azonos idő) nem írunk újra – ez kizárja
      //    a két példány közti „pingpongot”.
      let verify = false;
      for (let attempt = 0; ; attempt++) {
        if (attempt >= INSERT_ATTEMPTS) {
          // Tartós ütközés: nem nyeljük el csendben – a hívó naplózza és számolja
          throw new Error(`[tip-archive] ${m.id}: a verziók ${INSERT_ATTEMPTS} kör után sem stabilizálódtak (párhuzamos írás?)`);
        }
        const latest = await this.store.latestVersions(m.id);
        const drafts: ArchiveDraft[] = [];
        for (const [market, { hash }] of wanted) {
          const last = latest.get(market);
          if (last && last.contentHash === hash) continue;               // a legutolsó már ez
          if (verify && last && last.generatedAt >= generatedAt) continue; // idegen, nálunk frissebb verzió
          drafts.push(draftFor(market, last));
        }
        if (!drafts.length) {
          if (verify) break; // stabil: minden piac legutolsó verziója a miénk vagy frissebb
          verify = true;
          continue;
        }
        inserted += (await this.store.insertVersions(drafts)).length;
        verify = true;
      }
      if (inserted) this.responses.clear();
    }
    // A meccs friss, hiteles állapota (és lejátszott meccsnél az elszámolás)
    await this.observe(a.match, a.generatedAt);
    return inserted;
  }

  /**
   * A megfigyelés rögzítése a `decideObservation` szabálya szerint. Visszaadja,
   * hogy elfogadtuk-e. `holdFinished`: a „finished” még „live”-ként kerül be
   * (az elszámolás előtt nem zárjuk le a meccs figyelését).
   */
  private async writeState(m: Match, observedAt: string, holdFinished = false): Promise<boolean> {
    const k = new Date(m.kickoff);
    if (!m.kickoff || Number.isNaN(k.getTime())) return false;
    const status = observedStatusOf(m);
    const incoming: MatchObservation = {
      matchId: m.id,
      kickoff: k.toISOString(),
      status: holdFinished && status === 'finished' ? 'live' : status,
      observedAt,
    };
    const current = await this.store.matchState(m.id);
    if (!decideObservation(current, incoming, this.now()).accept) {
      this.rejectedObservations++;
      return false;
    }
    await this.store.observeMatch(incoming);
    this.responses.clear();
    return true;
  }

  /** Elvetett (elavult vagy ellentmondó) megfigyelések száma – megfigyelhetőség. */
  rejectedObservations = 0;

  /**
   * A meccs hiteles megfigyelése. Az ELFOGADOTT, lejátszott meccsnél ELŐBB
   * elszámol, AZTÁN rögzíti a `finished` állapotot: ha az elszámolás elbukik,
   * az állapot nem lesz `finished`, így a frissítési kör újra megpróbálja.
   * Elvetett (elavult/ellentmondó) megfigyelés alapján nem számolunk el.
   * Érvénytelen kezdési idő esetén nem írunk állapotot – a meccs nem nyilvános.
   */
  async observe(m: Match, observedAt?: string): Promise<number> {
    const k = new Date(m.kickoff);
    if (!m.kickoff || Number.isNaN(k.getTime())) return 0;
    const atRaw = observedAt ? new Date(observedAt) : this.now();
    const at = (Number.isNaN(atRaw.getTime()) ? this.now() : atRaw).toISOString();
    const incoming: MatchObservation = { matchId: m.id, kickoff: k.toISOString(), status: observedStatusOf(m), observedAt: at };
    if (!decideObservation(await this.store.matchState(m.id), incoming, this.now()).accept) {
      this.rejectedObservations++;
      return 0;
    }
    const settled = await this.settleFromMatch(m);
    await this.writeState(m, at);
    return settled;
  }

  /** Egy meccs függő tippjeinek lezárása a hiteles végeredménnyel. Idempotens. */
  async settleFromMatch(m: Match): Promise<number> {
    if (m.status !== 'finished' || m.homeGoals == null || m.awayGoals == null) return 0;
    const markets = await this.store.pendingMarkets(m.id);
    if (!markets.length) return 0;
    const hg = m.homeGoals;
    const ag = m.awayGoals;
    const outcomes = markets.map((market) => {
      let status: Exclude<SettlementStatus, 'pending'>;
      try {
        const r = evaluateMarket(market, hg, ag);
        status = r === 'win' ? 'won' : r === 'loss' ? 'lost' : 'void';
      } catch {
        status = 'unsupported'; // ismeretlen piac: nem vereség, és nem számít a statisztikába
      }
      return { market, status };
    });
    const n = await this.store.settle({
      matchId: m.id, homeGoals: hg, awayGoals: ag,
      resultKickoff: new Date(m.kickoff).toISOString(),
      settledAt: this.now().toISOString(),
      outcomes,
    });
    if (n) this.responses.clear();
    return n;
  }

  /**
   * Honnan olvas a frissítési kör: `fresh`, ha a szolgáltató a memóriabeli
   * gyorsítótárát megkerülve tud olvasni (ESPN: `getMatchFresh`), különben
   * `cached` – ilyenkor a `getMatch` eredménye elavult lehet, és a
   * `decideObservation` szabálya akadályozza meg, hogy ez nyilvánosságot vagy
   * visszalépést okozzon.
   */
  get refreshSource(): 'fresh' | 'cached' {
    return typeof this.data.getMatchFresh === 'function' ? 'fresh' : 'cached';
  }

  /**
   * Kérés által indított frissítési kör: azoknak a meccseknek a lekérdezése,
   * amelyek ismert kezdése már elmúlt, de még nincsenek `finished`
   * állapotban, valamint az archivált, de állapot nélküli meccseké. Ütemezett
   * háttérfolyamat nincs – csak archívum-lekérdezéskor indul, legfeljebb 2
   * percenként, legfeljebb 20 meccsel, meccsenként legfeljebb 15 percenként.
   */
  settleDue(force = false): Promise<number> {
    if (this.refreshing) return this.refreshing;
    const t = this.now().getTime();
    if (!force && t - this.lastRefreshRun < REFRESH_THROTTLE_MS) return Promise.resolve(0);
    this.lastRefreshRun = t;
    this.refreshing = this.refreshInner(t).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** A frissítési kör jelöltjei – kötött számú lekérdezéssel, sorrendhelyesen. */
  private async refreshCandidates(t: number): Promise<string[]> {
    const nowIso = new Date(t).toISOString();
    const after = new Date(t - REFRESH_LOOKBACK_MS).toISOString();
    const eligible = (id: string) => t - (this.checkedAt.get(id) ?? 0) >= RECHECK_MS;
    const picked: string[] = [];
    const take = (id: string) => {
      if (picked.length < REFRESH_BATCH && eligible(id) && !picked.includes(id)) picked.push(id);
    };
    // Mindkét forrásból lapozva olvasunk: ha egy lap elejét nemrég
    // ellenőriztük (és az ellenőrzés nem írt újabb megfigyelést), lapozunk
    // tovább – így a hátrébb lévők is sorra kerülnek. A lapok száma kötött.
    const sources: ((offset: number) => Promise<string[]>)[] = [
      // 1) archivált, de állapot nélküli meccsek (soha nem látott → elsőbbség)
      (offset) => this.store.orphanMatchIds(nowIso, after, REFRESH_PAGE, offset),
      // 2) a legrégebben megfigyelt, még nem lezárt meccsek
      (offset) => this.store.dueMatchIds(nowIso, after, REFRESH_PAGE, offset),
    ];
    for (const source of sources) {
      for (let page = 0; page < REFRESH_MAX_PAGES && picked.length < REFRESH_BATCH; page++) {
        const ids = await source(page * REFRESH_PAGE);
        for (const id of ids) take(id);
        if (ids.length < REFRESH_PAGE) break;
      }
    }
    return picked;
  }

  private async refreshInner(t: number): Promise<number> {
    const due = await this.refreshCandidates(t);
    const read = typeof this.data.getMatchFresh === 'function'
      ? (id: string) => this.data.getMatchFresh!(id)
      : (id: string) => this.data.getMatch(id);
    let n = 0;
    for (const id of due) {
      this.remember(this.checkedAt, id, t);
      try {
        const m = await read(id);
        if (m) n += await this.observe(m);
      } catch (e) {
        console.error('[tip-archive] frissítés', id, (e as Error).message);
      }
    }
    return n;
  }

  /** Nyilvános, lapozott lekérdezés összesítéssel – ugyanarra a szűrt adatkörre. */
  async query(raw: Record<string, unknown>): Promise<TipArchiveResponse> {
    const parsed = parseArchiveQuery(raw);

    // Frissítés: legfeljebb rövid ideig várunk rá, a lista akkor is kiszolgálható
    const refresh = this.settleDue().catch((e) => { console.error('[tip-archive] frissítés', (e as Error).message); return 0; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refresh, new Promise((r) => { timer = setTimeout(r, this.settleWaitMs); })]);
    clearTimeout(timer);

    const now = this.now();
    const cacheKey = JSON.stringify(parsed);
    const hit = this.responses.get(cacheKey);
    if (hit && now.getTime() - hit.at < RESPONSE_TTL_MS) return hit.value;

    const filter: ArchiveFilter = {
      ...parsed.filter,
      origin: this.data.origin,
      // Csak az AKTUÁLIS állapot szerint ténylegesen elkezdődött meccsek: a
      // jövőbeli (akár elhalasztott) meccsek tippjei PRO-tartalmak, az archívum
      // nem kerülheti meg a meglévő FREE/PRO szabályt.
      visibleBefore: now.toISOString(),
    };
    const offset = (parsed.page - 1) * parsed.pageSize;
    const [{ rows, total }, summary, coverageStart] = await Promise.all([
      this.store.list(filter, parsed.scope, offset, parsed.pageSize),
      this.store.summary(filter),
      this.store.coverageStart(this.data.origin),
    ]);
    const counted = parsed.scope === 'counted'
      ? new Set(rows.map((r) => r.id))
      : await this.store.countedIds([...new Set(rows.map((r) => r.matchId))]);

    const c = summary.counted;
    const value: TipArchiveResponse = {
      entries: rows.map((r) => toEntry(r, counted.has(r.id))),
      page: parsed.page,
      pageSize: parsed.pageSize,
      total,
      hasMore: offset + rows.length < total,
      summary: {
        records: summary.records,
        counted: c.won + c.lost + c.void + c.pending + c.unsupported,
        ...c,
        hitRate: hitRateOf(c.won, c.lost),
      },
      coverageStart,
      engineVersion: ENGINE_VERSION,
      origin: this.data.origin,
    };
    if (this.responses.size >= 100) this.responses.clear();
    this.responses.set(cacheKey, { at: now.getTime(), value });
    return value;
  }
}
