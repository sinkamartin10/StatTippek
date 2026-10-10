/**
 * Modell-tipp archívum – a statisztikai motor MINDEN rögzített tippje, a
 * valós végeredménnyel elszámolva. Nyilvános oldal; csak elkezdődött meccsek
 * tippjeit mutatja (a jövőbeli tippek továbbra is a PRO-csomag részei).
 *
 * Minden szám a szerver valós rekordjaiból jön – a felület semmit nem számol
 * újra és nem egészít ki. A szűrők az URL-ben élnek, így a visszalépés és a
 * frissítés megőrzi őket.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react';
import {
  ARCHIVE_CATEGORIES, ARCHIVE_MARKET_TYPES, AVAILABILITY_LABEL, CATEGORY_LABEL, SETTLEMENT_LABEL, SETTLEMENT_STATUSES, TIP_AVAILABILITIES,
  type SettlementStatus, type TipArchiveEntry,
} from '@shared/tipArchive';
import { api } from '../lib/api';
import { archiveEmptyState, categoryFromParam, categoryLabel } from '../lib/archiveCategory';
import { fmtDate, fmtDateTime, odds as fo, pct, useAsync } from '../lib/format';
import { useUrlState } from '../lib/listState';
import {
  Accordion, Card, ChipGroup, Disclaimer, EmptyState, ErrorBox, Loading, Note, OriginBadge, PageHeader, StatCard,
} from '../components/ui';

const DEFAULTS = {
  from: '', to: '', leagueId: '', marketType: '', category: '', status: '', availability: '', search: '', scope: 'all', page: '1',
};
type Filters = typeof DEFAULTS;

const STATUS_UI: Record<SettlementStatus, { icon: string; cls: string }> = {
  won: { icon: '✓', cls: 'text-success' },
  lost: { icon: '✕', cls: 'text-danger' },
  pending: { icon: '●', cls: 'text-warning' },
  void: { icon: '–', cls: 'text-text-muted' },
  unsupported: { icon: '?', cls: 'text-text-muted' },
};

function StatusTag({ status }: { status: SettlementStatus }) {
  const u = STATUS_UI[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-extrabold ${u.cls}`}>
      <span aria-hidden>{u.icon}</span> {SETTLEMENT_LABEL[status]}
    </span>
  );
}

/** Miért számít / nem számít egy sor a teljesítménybe – szövegesen, nem csak színnel. */
function CountedTag({ e }: { e: TipArchiveEntry }) {
  if (e.counted) return <span className="badge badge-blue">Statisztikába számít</span>;
  if (!e.preKickoff) return <span className="badge badge-muted" title="A tipp a kezdés után keletkezett, ezért nem számít a teljesítménybe.">Kezdés után generált</span>;
  return <span className="badge badge-muted" title="Ugyanerre a piacra később, még a kezdés előtt újabb verzió készült – az számít.">Korábbi verzió</span>;
}

export default function TipArchive() {
  const [f, setF] = useUrlState<Filters>(DEFAULTS, ['scope', 'page']);
  const page = Math.max(1, parseInt(f.page, 10) || 1);
  const [searchText, setSearchText] = useState(f.search);
  useEffect(() => setSearchText(f.search), [f.search]);

  const leagues = useAsync(() => api.leagues(), []);
  // Ismeretlen kategória az URL-ben → nincs szűrés (az „Összes kategória” aktív)
  const category = categoryFromParam(f.category);
  const r = useAsync(() => api.tipArchive({
    from: f.from || undefined,
    to: f.to || undefined,
    leagueId: f.leagueId || undefined,
    marketType: f.marketType || undefined,
    category: category ?? undefined,
    status: f.status || undefined,
    availability: f.availability || undefined,
    search: f.search || undefined,
    scope: f.scope === 'counted' ? 'counted' : 'all',
    page,
  }), [f.from, f.to, f.leagueId, f.marketType, category, f.status, f.availability, f.search, f.scope, page]);

  /** Szűrőváltáskor mindig az első oldalra ugrunk. */
  const change = (patch: Partial<Filters>) => setF({ ...f, ...patch, page: '1' });
  const submitSearch = (ev: FormEvent) => { ev.preventDefault(); change({ search: searchText.trim() }); };
  /** a kategórián kívüli szűrők valamelyike aktív-e */
  const otherFilters = Object.entries(f).some(([k, v]) => k !== 'page' && k !== 'scope' && k !== 'category' && v !== '');
  const filtered = otherFilters || !!category;
  const empty = archiveEmptyState(category, otherFilters);
  // Az ismeretlen kategória kikerül az URL-ből, hogy a cím és a kiválasztott chip mindig egyezzen
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (f.category && !category) setF({ ...f, category: '' }); }, [f.category, category]);

  const d = r.data;
  const s = d?.summary;
  const first = d && d.total ? (d.page - 1) * d.pageSize + 1 : 0;
  const last = d ? (d.page - 1) * d.pageSize + d.entries.length : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🗄️"
        title="Modell-tipp archívum"
        text="A statisztikai motor (xG + Poisson) minden rögzített tippje, a valós végeredménnyel elszámolva. A vesztes tippek is itt maradnak, és a rögzített tipp utólag nem módosítható."
        right={d ? <OriginBadge origin={d.origin} /> : undefined}
      />

      <Note>
        A tippeket egy <strong>determinisztikus statisztikai modell</strong> számolja (motorverzió:{' '}
        <span className="mono">{d?.engineVersion ?? '–'}</span>) – nem nyelvi modell, és nem tanul magától.
        {' '}Mérkőzésenként és piaconként <strong>csak a kezdés előtt rögzített utolsó verzió</strong> számít a statisztikába;
        a függő, érvénytelen és nem elszámolható tipp nem számít vereségnek. Az archívum csak már elkezdődött meccseket mutat.
      </Note>

      {d && (
        <Note tone={d.coverageStart ? 'info' : 'warn'}>
          {d.coverageStart
            ? <>Az archívum <strong>{fmtDateTime(d.coverageStart)}</strong> óta rögzíti a tippeket. Korábbi tippeket nem töltöttünk fel visszamenőleg, mert azok eredeti formája nem ellenőrizhető.</>
            : <>Az archívum még üres: a tippek a bevezetés pillanatától, a mérkőzések elemzésekor rögzülnek. Visszamenőleges feltöltés nincs.</>}
          {' '}A tipp akkor kerül be, amikor a termék ténylegesen kiszámolja (pl. valaki megnyitja a mérkőzést vagy a Tippek listát), ezért nem minden mérkőzés szerepel.
        </Note>
      )}

      {/* Összesítés – ugyanarra a szűrt adatkörre, mint a lista */}
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon="🗂️" tone="neutral" label="Rögzített tippek" value={s.records} sub="minden verzió" />
          <StatCard icon="🎯" tone="primary" label="Statisztikába számít" value={s.counted} sub={`${s.pending} függő · ${s.void} érvénytelen · ${s.unsupported} nem elsz.`} />
          <StatCard icon="✅" tone="success" label="Találati arány" value={s.hitRate != null ? pct(s.hitRate, 1) : '–'} sub={`${s.won} nyert · ${s.lost} vesztett`} />
          <StatCard icon="📏" tone="neutral" label="Lezárt (nyert + vesztett)" value={s.won + s.lost} sub="ebből számol a találati arány" />
        </div>
      )}

      <Accordion label="Szűrők" icon={<SlidersHorizontal className="h-4 w-4 text-primary" />} defaultOpen={otherFilters}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <label className="field-label min-w-0">Dátumtól<input type="date" className="input mt-1.5" value={f.from} onChange={(e) => change({ from: e.target.value })} /></label>
            <label className="field-label min-w-0">Dátumig<input type="date" className="input mt-1.5" value={f.to} onChange={(e) => change({ to: e.target.value })} /></label>
            <label className="field-label min-w-0">Bajnokság
              <select className="input mt-1.5" value={f.leagueId} onChange={(e) => change({ leagueId: e.target.value })}>
                <option value="">Összes</option>
                {leagues.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <label className="field-label min-w-0">Piactípus
              <select className="input mt-1.5" value={f.marketType} onChange={(e) => change({ marketType: e.target.value })}>
                <option value="">Összes</option>
                {ARCHIVE_MARKET_TYPES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="field-label min-w-0">Eredmény
              <select className="input mt-1.5" value={f.status} onChange={(e) => change({ status: e.target.value })}>
                <option value="">Összes</option>
                {SETTLEMENT_STATUSES.map((st) => <option key={st} value={st}>{SETTLEMENT_LABEL[st]}</option>)}
              </select>
            </label>
            <label className="field-label min-w-0">Közzététel
              <select className="input mt-1.5" value={f.availability} onChange={(e) => change({ availability: e.target.value })}>
                <option value="">Összes</option>
                {TIP_AVAILABILITIES.map((a) => <option key={a} value={a}>{AVAILABILITY_LABEL[a]}</option>)}
              </select>
            </label>
          </div>
          <form onSubmit={submitSearch} className="flex flex-wrap items-end gap-2">
            <label className="field-label min-w-0 flex-1">Csapat keresése
              <input className="input mt-1.5" value={searchText} maxLength={40} placeholder="pl. Arsenal" onChange={(e) => setSearchText(e.target.value)} />
            </label>
            <button type="submit" className="btn"><Search className="h-4 w-4" /> Keresés</button>
            {filtered && <button type="button" className="btn btn-ghost" onClick={() => { setSearchText(''); setF({ ...DEFAULTS, scope: f.scope }); }}>Szűrők törlése</button>}
          </form>
        </div>
      </Accordion>

      {/* Kategória – jól látható, a többi szűrő mellett; váltáskor a többi szűrő megmarad */}
      <section aria-label="Tipp-kategória" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs font-extrabold uppercase tracking-wide text-text-muted">Kategória</span>
        <ChipGroup
          ariaLabel="Tipp-kategória"
          value={category ?? ''}
          onChange={(v) => change({ category: v })}
          options={[
            { value: '', label: 'Összes kategória' },
            ...ARCHIVE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
          ]}
        />
      </section>

      <Card
        title={d ? `Tippek (${d.total})${category ? ` · ${CATEGORY_LABEL[category]}` : ''}` : 'Tippek'}
        right={<ChipGroup
          ariaLabel="Megjelenített verziók"
          value={f.scope === 'counted' ? 'counted' : 'all'}
          onChange={(v) => change({ scope: v })}
          options={[
            { value: 'all', label: 'Minden verzió' },
            { value: 'counted', label: 'Csak a statisztikába számítók' },
          ]}
        />}
      >
        {r.loading && !d ? <Loading /> : r.error ? <ErrorBox message={r.error} onRetry={r.reload} /> : !d || d.entries.length === 0 ? (
          <EmptyState
            emoji="🗄️"
            title={empty.title}
            text={empty.text}
            action={category ? <button type="button" className="btn btn-sm" onClick={() => change({ category: '' })}>Összes kategória</button> : undefined}
          />
        ) : (
          <>
            <ul className={`divide-y divide-border ${r.loading ? 'opacity-60' : ''}`} aria-busy={r.loading}>
              {d.entries.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1 basis-56">
                    <Link to={`/meccs/${encodeURIComponent(e.matchId)}`} className="block truncate text-sm font-extrabold transition hover:text-primary">{e.matchLabel}</Link>
                    <div className="truncate text-xs font-semibold text-text-muted">{e.marketLabel} · {categoryLabel(e.category)} · {e.leagueName} · {fmtDateTime(e.kickoff)}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-text-muted">
                      <CountedTag e={e} />
                      <span className="badge badge-muted">{AVAILABILITY_LABEL[e.availability]}</span>
                      <span title={`Rögzítve: ${fmtDateTime(e.generatedAt)} · motor: ${e.engineVersion}`}>{e.versionNo}. verzió · rögzítve {fmtDate(e.generatedAt)}</span>
                    </div>
                  </div>
                  <div className="mono text-right text-xs font-bold text-text-muted">
                    <div>modell {pct(e.modelProb, 1)}</div>
                    <div title="A rögzítéskor ismert odds – a modell valószínűségét nem befolyásolja">odds {fo(e.odds)}</div>
                  </div>
                  <div className="mono w-14 text-center text-sm font-extrabold">{e.homeGoals != null ? `${e.homeGoals}–${e.awayGoals}` : '–'}</div>
                  <div className="w-32 text-right"><StatusTag status={e.status} /></div>
                </li>
              ))}
            </ul>
            <nav className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3" aria-label="Lapozás">
              <span className="text-xs font-semibold text-text-muted">{first}–{last} / {d.total}</span>
              <div className="flex gap-2">
                <button type="button" className="btn btn-sm" disabled={d.page <= 1 || r.loading} onClick={() => setF({ ...f, page: String(d.page - 1) })}>
                  <ChevronLeft className="h-4 w-4" /> Előző
                </button>
                <button type="button" className="btn btn-sm" disabled={!d.hasMore || r.loading} onClick={() => setF({ ...f, page: String(d.page + 1) })}>
                  Következő <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </nav>
          </>
        )}
      </Card>

      <Note tone="warn">A múltbeli teljesítmény nem garantálja a jövőbeli eredményeket. A modell-valószínűségek statisztikai becslések, nem ígéretek.</Note>
      <Disclaimer />
    </div>
  );
}
