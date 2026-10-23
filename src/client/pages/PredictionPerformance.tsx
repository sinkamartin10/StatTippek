/**
 * Az előrejelzések teljesítménye – nyilvános, csak olvasható oldal.
 *
 * Minden szám a meglévő modell-tipp archívumból jön (`/api/tip-archive`, `scope=counted`): mérkőzésenként
 * és piaconként a kezdés előtt rögzített utolsó verzió, a szerver meglévő elszámolásával. Az oldal semmit
 * nem ír, nem módosít és nem számol újra; a heti / havi bontás ugyanannak a végpontnak a dátumszűrőjével
 * (a mérkőzés kezdési ideje, magyar naptár) készül. Az archívum csak már elkezdődött meccseket ad ki,
 * így a jövőbeli (PRO) előrejelzések itt sem látszanak.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ChevronLeft, ChevronRight } from 'lucide-react';
import type { SettlementStatus, TipArchiveEntry, TipArchiveQuery, TipArchiveResponse } from '@shared/tipArchive';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, pct, useAsync } from '../lib/format';
import {
  LIST_MAX_PAGES, LIST_PAGE_SIZE, MIN_SETTLED, VERDICT, budapestDateKey, monthPeriods, perfStats, weekPeriods,
  type PerfStats, type Period,
} from '../lib/predictionPerformance';
import { Card, ChipGroup, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';

export interface PeriodRow { period: Period; stats: PerfStats }
export interface PeriodData { weeks: PeriodRow[]; months: PeriodRow[] }

/**
 * A heti és havi összesítések betöltése (időszakonként egy, egyelemű lapos kérés – csak az összesítés kell).
 * `coverageStart === undefined`: az áttekintés még nem töltött be → nincs mit kérni.
 */
export async function loadPeriods(
  coverageStart: string | null | undefined,
  today: string,
  fetch: (q: TipArchiveQuery) => Promise<TipArchiveResponse> = api.tipArchive,
): Promise<PeriodData | null> {
  if (coverageStart === undefined) return null;
  const weeks = weekPeriods(coverageStart, today);
  const months = monthPeriods(coverageStart, today);
  const all = [...weeks, ...months];
  const res = await Promise.all(all.map((p) => fetch({ scope: 'counted', from: p.from, to: p.to, pageSize: 1 })));
  const rows = all.map((period, i) => ({ period, stats: perfStats(res[i].summary) }));
  return { weeks: rows.slice(0, weeks.length), months: rows.slice(weeks.length) };
}

function HitRate({ s }: { s: PerfStats }) {
  if (s.hitRate == null) return <span className="text-text-muted">–</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {pct(s.hitRate, 1)}
      {s.smallSample && <span className="badge badge-yellow" title={`${MIN_SETTLED}-nál kevesebb lezárt előrejelzés – az arány még erősen ingadozhat.`}>kis minta</span>}
    </span>
  );
}

/** Az összesítő kártyák – a teljes rögzített időszakra. */
export function PerformanceOverview({ data, today }: { data: TipArchiveResponse; today: string }) {
  const s = perfStats(data.summary);
  if (!data.coverageStart) {
    return <EmptyState emoji="📈" title="Még nincs rögzített előrejelzés" text="Az előrejelzések a mérkőzések elemzésekor rögzülnek; amint az első mérkőzések lejátszódnak, itt megjelenik a teljesítményük." />;
  }
  return (
    <section aria-label="Összesítés" className="space-y-3">
      <p className="text-sm font-semibold text-text-muted">
        Időszak: <strong className="text-text">{fmtDate(data.coverageStart)} – {fmtDate(`${today}T12:00:00Z`)}</strong> (a mérkőzések kezdési ideje szerint, a rögzítés kezdete óta)
      </p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* rövid alcímek: mobilon (két oszlop) a kártya csonkolná a hosszabbat */}
        <StatCard icon="🗂️" tone="neutral" label="Lezárt előrejelzések" value={s.settled} sub="értékelhető" />
        <StatCard icon="✅" tone="success" label="Helyes" value={s.correct} />
        <StatCard icon="❌" tone="danger" label="Helytelen" value={s.incorrect} />
        <StatCard
          icon="🎯"
          tone="primary"
          label="Találati arány"
          value={s.hitRate != null ? pct(s.hitRate, 1) : '–'}
          sub={s.settled === 0 ? 'nincs még adat' : s.smallSample ? 'kis minta' : undefined}
        />
      </div>
      <p className="text-xs font-semibold text-text-muted">
        Nem számít bele: {s.pending} feldolgozás alatt (a mérkőzés még nem zárult le) · {s.excluded} érvénytelen vagy nem értékelhető
        (pl. elhalasztott mérkőzés).
      </p>
    </section>
  );
}

/** Heti / havi bontás táblázatban; a folyamatban lévő időszak jelölve. */
export function PeriodTable({ rows, empty }: { rows: PeriodRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm font-semibold text-text-muted">{empty}</p>;
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="table min-w-[32rem]">
        <thead>
          <tr>
            <th>Időszak</th>
            {/* a találati arány közvetlenül az időszak mellett: mobilon görgetés nélkül is látszik */}
            <th className="text-right">Találati arány</th>
            <th className="text-right">Lezárt</th>
            <th className="text-right">Helyes</th>
            <th className="text-right">Helytelen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ period, stats }) => (
            <tr key={period.from}>
              <td className="font-bold">
                {period.label}
                {period.current && <span className="badge badge-muted ml-2">folyamatban</span>}
              </td>
              <td className="mono text-right font-extrabold"><HitRate s={stats} /></td>
              <td className="mono text-right">{stats.settled}</td>
              <td className="mono text-right">{stats.correct}</td>
              <td className="mono text-right">{stats.incorrect}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A korábbi előrejelzések rövid listája. */
export function PredictionList({ entries }: { entries: TipArchiveEntry[] }) {
  if (entries.length === 0) {
    return <EmptyState emoji="🗂️" title="Még nincs megjeleníthető előrejelzés" text="Csak már elkezdődött mérkőzések előrejelzései jelennek meg." />;
  }
  return (
    <ul className="divide-y divide-border">
      {entries.map((e) => {
        const v = VERDICT[e.status];
        return (
          <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1 basis-56">
              <Link to={`/meccs/${encodeURIComponent(e.matchId)}`} className="block truncate text-sm font-extrabold transition hover:text-primary">{e.matchLabel}</Link>
              <div className="truncate text-xs font-semibold text-text-muted">{fmtDateTime(e.kickoff)} · {e.leagueName}</div>
            </div>
            <div className="min-w-0 flex-1 basis-40">
              <div className="truncate text-sm font-bold">{e.marketLabel}</div>
              <div className="mono text-xs font-semibold text-text-muted">modell {pct(e.modelProb, 1)}</div>
            </div>
            <div className="mono w-14 text-center text-sm font-extrabold" title="Végeredmény">{e.homeGoals != null ? `${e.homeGoals}–${e.awayGoals}` : '–'}</div>
            <div className={`w-36 text-right text-sm font-extrabold ${v.cls}`}><span aria-hidden>{v.icon}</span> {v.label}</div>
          </li>
        );
      })}
    </ul>
  );
}

/** A lista szűrője – a meglévő archívum-végpont `status` paramétere (egyszerre egy állapot). */
const LIST_FILTERS: { value: '' | SettlementStatus; label: string }[] = [
  { value: '', label: 'Összes' },
  { value: 'won', label: VERDICT.won.label },
  { value: 'lost', label: VERDICT.lost.label },
  { value: 'pending', label: VERDICT.pending.label },
];

export default function PredictionPerformance() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'' | SettlementStatus>('');
  const today = budapestDateKey(new Date());
  // az összesítés mindig a teljes (szűretlen) adatkörre vonatkozik – a lista szűrője nem torzíthatja
  const r = useAsync(() => api.tipArchive({ scope: 'counted', pageSize: 1 }), []);
  const d = r.data;
  const list = useAsync(
    () => api.tipArchive({ scope: 'counted', status: status || undefined, page, pageSize: LIST_PAGE_SIZE }),
    [status, page],
  );
  const l = list.data;
  // undefined, amíg az áttekintés nem töltött be; null, ha az archívum üres
  const coverage = d ? d.coverageStart : undefined;
  const periods = useAsync(() => loadPeriods(coverage, today), [coverage, today]);
  const lastPage = l ? Math.min(LIST_MAX_PAGES, Math.max(1, Math.ceil(l.total / l.pageSize))) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="📈"
        title="AI-előrejelzések teljesítménye"
        text="A TippStats statisztikai modelljeinek korábbi előrejelzései a valós végeredménnyel összevetve – a helytelenek is, utólagos módosítás nélkül."
      />

      <Note>
        Minden szám az adatbázisban rögzített, már elkezdődött mérkőzések előrejelzéseiből származik. Mérkőzésenként és piaconként
        {' '}<strong>csak a kezdés előtt rögzített utolsó előrejelzés</strong> számít. A találati arány: helyes / (helyes + helytelen) × 100 –
        a feldolgozás alatt lévő, érvénytelen és nem értékelhető előrejelzések nem számítanak bele.
      </Note>

      {r.loading && !d ? <Loading /> : r.error && !d ? <ErrorBox message={r.error} onRetry={r.reload} /> : d && (
        <>
          <PerformanceOverview data={d} today={today} />

          {d.coverageStart && (
            <div className="grid gap-6 xl:grid-cols-2">
              <Card className="min-w-0" title="Heti teljesítmény" right={<span className="text-xs font-semibold text-text-muted">hétfőtől vasárnapig</span>}>
                {periods.loading && !periods.data ? <Loading /> : periods.error ? <ErrorBox message={periods.error} onRetry={periods.reload} /> : (
                  <PeriodTable rows={periods.data?.weeks ?? []} empty="Még nincs heti adat." />
                )}
              </Card>
              <Card className="min-w-0" title="Havi teljesítmény" right={<span className="text-xs font-semibold text-text-muted">naptári hónap</span>}>
                {periods.loading && !periods.data ? <Loading /> : periods.error ? <ErrorBox message={periods.error} onRetry={periods.reload} /> : (
                  <PeriodTable rows={periods.data?.months ?? []} empty="Még nincs havi adat." />
                )}
              </Card>
            </div>
          )}

          <Card
            title="Korábbi előrejelzések"
            right={<Link to="/modell-archivum" className="inline-flex items-center gap-1.5 text-xs font-bold text-primary"><Archive className="h-3.5 w-3.5" /> Teljes archívum</Link>}
          >
            <div className="mb-4">
              <ChipGroup
                ariaLabel="Értékelés szerinti szűrés"
                value={status}
                onChange={(v) => { setStatus(v as '' | SettlementStatus); setPage(1); }}
                options={LIST_FILTERS}
              />
            </div>
            {list.loading && !l ? <Loading /> : list.error && !l ? <ErrorBox message={list.error} onRetry={list.reload} /> : l && (
              <>
                <div className={list.loading ? 'opacity-60' : ''} aria-busy={list.loading}>
                  <PredictionList entries={l.entries} />
                </div>
                {l.total > l.pageSize && (
                  <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3" aria-label="Lapozás">
                    <span className="text-xs font-semibold text-text-muted">{page}. oldal / {lastPage}</span>
                    <div className="flex gap-2">
                      <button type="button" className="btn btn-sm" disabled={page <= 1 || list.loading} onClick={() => setPage(page - 1)}>
                        <ChevronLeft className="h-4 w-4" /> Előző
                      </button>
                      <button type="button" className="btn btn-sm" disabled={page >= lastPage || !l.hasMore || list.loading} onClick={() => setPage(page + 1)}>
                        Következő <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </nav>
                )}
              </>
            )}
          </Card>
        </>
      )}

      <Note tone="warn">A múltbeli teljesítmény nem garantálja a jövőbeli eredményeket. A modell-valószínűségek statisztikai becslések, nem ígéretek.</Note>
      <Disclaimer />
    </div>
  );
}
