/**
 * Edge Radar (KÍSÉRLETI, PRO): a modell és az árrésmentesített piaci valószínűség különbsége
 * százalékpontban, piaconként. A böngésző NEM számol edge-et és nem írja felül a kizárást – az API
 * (`excluded`, `edgePp`) döntése az irányadó. EV-t / várható nyereséget nem jelenít meg.
 * A kliensoldali zár csak kényelmi: a PRO-jogosultságot a szerver (requirePro) kényszeríti ki.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EdgeRadarResponse } from '@shared/types';
import { api, ApiError, type MatchWithTeams } from '../lib/api';
import { fmtTime, odds as fo, pct, signed, useAsync } from '../lib/format';
import { edgeDateRange } from '@shared/edgeDates';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { LockedBlock, usePlan } from '../auth/PlanContext';
import { Matchup } from '../components/TeamCrest';
import { marketLabel } from '@shared/engine/markets';
import { ageMinutes, coverage, DEFAULT_FILTERS, filterItems, filterOptions, reasonText, showEdge, sortItems, sourceText, type EdgeFilters } from '../lib/edgeRadar';

/** A lekérés eredménye: siker, vagy jogosultsági elutasítás (401/403) – minden más hibaként megy tovább. */
export type EdgeLoad =
  | { kind: 'ok'; data: EdgeRadarResponse }
  | { kind: 'denied'; status: number; code?: string; message: string }
  | { kind: 'disabled' };

/** egyszerre ennyi sor jelenik meg (a többi gombbal) */
export const PAGE_ROWS = 150;

export async function loadEdgeRadar(date: string, fetcher: (d: string) => Promise<EdgeRadarResponse> = api.edgeRadar): Promise<EdgeLoad> {
  try { return { kind: 'ok', data: await fetcher(date) }; }
  catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return { kind: 'denied', status: e.status, code: e.code, message: e.message };
    // a szerveroldali kapcsoló (EDGE_RADAR_ENABLED) ki van kapcsolva – nem hiba, hanem állapot
    if (e instanceof ApiError && e.status === 503 && e.code === 'EDGE_RADAR_DISABLED') return { kind: 'disabled' };
    throw e;
  }
}

export default function EdgeRadarPage() {
  const { pro } = usePlan();
  return <EdgeRadarGate pro={pro} />;
}

/** FREE: zárt blokk, adatlekérés NÉLKÜL; PRO: munkaterület. (A szerver ettől függetlenül requirePro-val véd.) */
export function EdgeRadarGate({ pro }: { pro: boolean }) {
  return (
    <div className="space-y-6">
      <PageHeader emoji="📡" title="Edge Radar" text="Kísérleti: a modell valószínűsége és az odds árrésmentesített valószínűsége közti különbség, százalékpontban – piaconként, a megfigyelés idejével és forrásával." />
      {!pro ? <LockedBlock title="Edge Radar – PRO" text="A kísérleti Edge Radar PRO előfizetéssel érhető el." /> : <EdgeWorkspace />}
      <Disclaimer />
    </div>
  );
}

function EdgeWorkspace() {
  // a kezdő nap a mai BUDAPESTI nap – ugyanaz, mint a szerver „mai napja” (a böngésző időzónájától független)
  const [date, setDate] = useState(() => edgeDateRange().min);
  const [filters, setFilters] = useState<EdgeFilters>(DEFAULT_FILTERS);
  const edge = useAsync(() => loadEdgeRadar(date), [date]);
  // csapatnevek és címerek a meglévő meccslistából (hiba esetén az azonosító marad)
  const matches = useAsync(() => api.matches({ date }), [date]);
  return (
    <EdgeRadarBody
      date={date}
      onDate={(d) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d); }}
      state={{ loading: edge.loading, error: edge.error, result: edge.data }}
      matches={matches.data}
      filters={filters}
      onFilters={setFilters}
      onRetry={edge.reload}
    />
  );
}

export interface EdgeRadarBodyProps {
  date: string;
  onDate: (date: string) => void;
  state: { loading: boolean; error: string | null; result: EdgeLoad | null };
  matches: MatchWithTeams[] | null;
  filters: EdgeFilters;
  onFilters: (f: EdgeFilters) => void;
  onRetry?: () => void;
}

/** Állapotmentes megjelenítés (tesztelhető DOM nélkül is). */
export function EdgeRadarBody({ date, onDate, state, matches, filters, onFilters, onRetry }: EdgeRadarBodyProps) {
  const data = state.result?.kind === 'ok' ? state.result.data : null;
  const items = useMemo(() => (data ? sortItems(filterItems(data.items, filters), filters.sort) : []), [data, filters]);
  const opts = useMemo(() => filterOptions(data?.items ?? []), [data]);
  const byId = useMemo(() => new Map((matches ?? []).map((m) => [m.id, m])), [matches]);
  const leagueName = (id: string) => (matches ?? []).find((m) => m.leagueId === id)?.league?.name ?? id;
  // fokozatos megjelenítés (sok száz sor egyszerre lassú): szűrő- vagy adatváltáskor újraindul
  const viewKey = `${data?.generatedAt ?? ''}|${JSON.stringify(filters)}`;
  const [shown, setShown] = useState({ key: viewKey, n: PAGE_ROWS });
  const limit = shown.key === viewKey ? shown.n : PAGE_ROWS;
  const visible = items.slice(0, limit);
  const u = (p: Partial<EdgeFilters>) => onFilters({ ...filters, ...p });
  const range = edgeDateRange();

  return (
    <div className="space-y-4">
      <Note tone="warn">
        <b>Kísérleti funkció.</b> A százalékpontos különbség <b>nem nyereség és nem garancia</b>; a modell kalibrációja nincs igazolva. Az árrésmentesítés arányos normalizálással készül (közelítés), és csak egy iroda egyetlen megfigyeléséből származó, teljes kimenetelkészletre. A „megfigyelve” időpont a saját lekérésünk ideje, nem az odds tényleges változásáé.
      </Note>

      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <label className="field-label">Dátum
            {/* ugyanaz a budapesti tartomány, mint a szerveren (shared/edgeDates); a mérvadó a szerver */}
            <input type="date" className="input mt-1.5" value={date} min={range.min} max={range.max} onChange={(e) => onDate(e.target.value)} />
          </label>
          <label className="field-label">Bajnokság
            <select className="input mt-1.5" value={filters.leagueId} onChange={(e) => u({ leagueId: e.target.value })}>
              <option value="">Összes</option>
              {opts.leagues.map((l) => <option key={l} value={l}>{leagueName(l)}</option>)}
            </select>
          </label>
          <label className="field-label">Piac
            <select className="input mt-1.5" value={filters.market} onChange={(e) => u({ market: e.target.value })}>
              <option value="">Összes</option>
              {opts.markets.map((m) => <option key={m} value={m}>{marketLabel(m)}</option>)}
            </select>
          </label>
          <label className="field-label">Állapot
            <select className="input mt-1.5" value={filters.state} onChange={(e) => u({ state: e.target.value as EdgeFilters['state'] })}>
              <option value="all">Összes sor</option>
              <option value="usable">Csak használható</option>
              <option value="excluded">Csak kizárt</option>
            </select>
          </label>
          <label className="field-label">Rendezés
            <select className="input mt-1.5" value={filters.sort} onChange={(e) => u({ sort: e.target.value as EdgeFilters['sort'] })}>
              <option value="kickoff">Kezdés szerint</option>
              <option value="edge">Különbség szerint (csak használható sorok)</option>
            </select>
          </label>
        </div>
      </Card>

      {state.loading ? <Loading text="Edge Radar számolása…" />
        : state.error ? <ErrorBox message={`Az Edge Radar most nem érhető el. (${state.error})`} onRetry={onRetry} />
        : state.result?.kind === 'disabled' ? (
          <Note><span data-edge-state="disabled">Az Edge Radar jelenleg nincs bekapcsolva.</span></Note>
        )
        : state.result?.kind === 'denied' ? (
          state.result.status === 401
            ? <Note tone="warn" ><span data-edge-state="auth">Bejelentkezés szükséges. <Link to="/bejelentkezes" className="font-bold underline">Belépés</Link></span></Note>
            : <LockedBlock title="Edge Radar – PRO" text="Ez a funkció PRO előfizetéssel érhető el." />
        )
        : data ? (
          <>
            <CoverageBar data={data} />
            {data.meta.partial && (
              <Note tone="warn"><span data-edge-state="partial"><b>Részleges eredmény:</b> {data.meta.failedMatchIds.length} mérkőzés számítása nem sikerült – ezek hiányoznak a listából.</span></Note>
            )}
            {data.items.length === 0 ? (
              <EmptyState emoji="📡" title="Nincs oddsszal rendelkező piac ezen a napon" text="Lehet, hogy az adott sorozatokhoz a forrás nem közöl oddsot (pl. Európa-liga, Konferencialiga)." />
            ) : items.length === 0 ? (
              <EmptyState title="Nincs a szűrésnek megfelelő sor" text="Módosítsd a szűrőket." />
            ) : (
              <Card>
                <div className="overflow-x-auto">
                  <table className="table" data-edge-table>
                    <thead><tr><th>Kezdés</th><th>Mérkőzés</th><th>Piac</th><th>Odds</th><th>Iroda / forrás</th><th>Megfigyelve</th><th>Nyers implikált</th><th>Árrésmentes</th><th>Modell – piac</th></tr></thead>
                    <tbody>
                      {visible.map((i) => {
                        const m = byId.get(i.matchId);
                        const age = ageMinutes(i);
                        return (
                          <tr key={`${i.matchId}|${i.market}`} data-edge-row={i.excluded ? 'excluded' : 'usable'}>
                            <td className="mono whitespace-nowrap">{fmtTime(i.kickoff)}</td>
                            <td className="font-semibold">
                              {m ? <Link to={`/meccs/${encodeURIComponent(i.matchId)}`} className="flex min-w-0 hover:text-primary"><Matchup home={m.homeTeam?.name ?? m.homeTeamId} away={m.awayTeam?.name ?? m.awayTeamId} homeLogo={m.homeTeam?.logo} awayLogo={m.awayTeam?.logo} /></Link> : <span className="mono text-xs">{i.matchId}</span>}
                              <div className="text-xs font-semibold text-text-muted">{m?.league?.name ?? i.leagueId}</div>
                            </td>
                            <td>{marketLabel(i.market)}</td>
                            <td className="mono">{fo(i.odds)}</td>
                            <td className="text-xs">{i.bookmaker ?? '–'}<div className="text-text-muted">{sourceText(i.source)}</div></td>
                            <td className="mono whitespace-nowrap text-xs">{i.observedAt ? fmtTime(i.observedAt) : '–'}{age != null && <div className="text-text-muted">{age} perce</div>}</td>
                            <td className="mono">{i.rawImplied != null ? pct(i.rawImplied, 1) : '–'}</td>
                            <td className="mono" title={i.devig == null && i.devigReason ? reasonText(i.devigReason) : undefined}>{i.devig != null ? pct(i.devig, 1) : '–'}</td>
                            <td>
                              {showEdge(i)
                                ? <span className={`mono font-extrabold ${i.edgePp! >= 0 ? 'text-primary' : 'text-danger'}`} data-edge-value>{signed(i.edgePp, 1)} pp</span>
                                : <span className="text-xs font-semibold text-text-muted" data-edge-excluded={i.excludeReason ?? ''}>{reasonText(i.excludeReason ?? i.devigReason) || 'Nem használható.'}</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {items.length > limit && (
                  <div className="mt-3 text-center">
                    <button className="btn btn-sm" onClick={() => setShown({ key: viewKey, n: limit + PAGE_ROWS })} data-edge-more>
                      Még {Math.min(PAGE_ROWS, items.length - limit)} sor ({limit} / {items.length} látható)
                    </button>
                  </div>
                )}
              </Card>
            )}
            <MethodNote notice={data.meta.notice} />
          </>
        ) : null}
    </div>
  );
}

function CoverageBar({ data }: { data: EdgeRadarResponse }) {
  const c = coverage(data.items, data.meta.matches);
  return (
    <div className="flex flex-wrap gap-2 text-xs font-bold" data-edge-coverage>
      <span className="badge badge-muted">{c.matchesWithOdds} / {c.matches} mérkőzésnél van odds</span>
      <span className="badge badge-green">{c.usable} használható sor</span>
      <span className="badge badge-muted">{data.items.length - c.usable} kizárt sor</span>
    </div>
  );
}

function MethodNote({ notice }: { notice: string[] }) {
  return (
    <Card title="Módszer és korlátok">
      <ul className="list-disc space-y-1 pl-5 text-sm font-semibold text-text-muted">
        <li>Nyers implikált valószínűség = 1 ÷ odds (az iroda árrésével együtt).</li>
        <li>Árrésmentes valószínűség: a teljes kimenetelkészlet 1 ÷ odds értékeinek arányos normalizálása – közelítés.</li>
        <li>„Modell – piac”: a modell valószínűsége mínusz az árrésmentes valószínűség, százalékpontban – csak ha minden adatfeltétel teljesül.</li>
        {notice.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </Card>
  );
}
