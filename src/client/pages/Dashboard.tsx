/** Áttekintés: üdvözlés, a nap legfontosabb mutatói, kiemelt tipp-kártyák és a mai mérkőzések. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Crown, Trophy } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync, pct, signed } from '../lib/format';
import { applyClientFilters, defaultFilters, MatchFilters, MatchGrid } from '../components/MatchList';
import { Card, Disclaimer, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { TipCard } from '../components/TipCard';
import { CompetitionStatusBadge, remainingText } from './Competitions';
import { MissionsCard } from '../components/MissionsCard';
import { useAuth } from '../auth/AuthContext';
import { FREE_DAILY_TIPS, useFreeDay, usePlan } from '../auth/PlanContext';

export default function Dashboard() {
  const [f, setF] = useState(defaultFilters());
  const leagues = useAsync(() => api.leagues(), []);
  const matches = useAsync(() => api.matches({ date: f.date, leagueId: f.leagueId, country: f.country, importance: f.importance }), [f.date, f.leagueId, f.country, f.importance]);
  const tips = useAsync(() => api.tips(f.date), [f.date]);
  const { user } = useAuth();
  const { pro } = usePlan();
  // Az előzmény-végpont PRO-védett a szerveren – FREE esetén nem hívjuk (a mutatók „–” értéket mutatnak)
  const history = useAsync(() => (pro ? api.history({}) : Promise.resolve(null)), [pro]);
  // Tippverseny belépési pont – külön modul, a többi lekéréstől függetlenül hibatűrő
  const competitions = useAsync(() => api.competitions().catch(() => []), []);
  const free = useFreeDay(f.date);

  const list = matches.data ? applyClientFilters(matches.data, f) : [];
  const strongTips = (tips.data ?? []).filter((t) => t.tip.modelProb >= 0.6 && t.tip.supportingIndicators >= 3 && t.dataQuality.level !== 'kevés');
  const highlighted = strongTips.slice(0, pro ? 6 : FREE_DAILY_TIPS);
  const withOdds = strongTips.filter((t) => t.tip.odds != null);
  const avgOdds = withOdds.length ? withOdds.reduce((a, t) => a + (t.tip.odds ?? 0), 0) / withOdds.length : null;
  const s = history.data?.summary;
  const name = user?.email?.split('@')[0];

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🎯"
        title="Mai tippek"
        text={name ? `Üdv, ${name}! Az algoritmus átnézte a mai mérkőzéseket – itt vannak a statisztikailag legjobban támogatott piacok.` : 'Az algoritmus átnézte a mai mérkőzéseket – itt vannak a statisztikailag legjobban támogatott piacok.'}
        right={<Link to="/tippek" className="btn btn-primary">Összes tipp <ArrowRight className="h-4 w-4" /></Link>}
      />

      {/* A nap mutatói */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="🎯" tone="primary" label="Mai tippek" value={tips.data ? strongTips.length : '…'} sub={`${list.length} mérkőzés a napon`} />
        <StatCard icon="✅" tone="success" label="Találati arány" value={s?.hitRate != null ? pct(s.hitRate, 1) : '–'} sub={s ? `${s.correct}/${s.correct + s.incorrect} lezárt tipp` : pro ? 'még nincs lezárt tipp' : '🔒 PRO-val látható'} />
        <StatCard icon="💰" tone="warning" label="Átlag odds" value={avgOdds != null ? avgOdds.toFixed(2).replace('.', ',') : '–'} sub={`${withOdds.length} piac oddsszal`} />
        <StatCard icon="📈" tone={s?.roi != null && s.roi < 0 ? 'danger' : 'success'} label="ROI" value={s?.roi != null ? `${signed(s.roi * 100, 1)}%` : '–'} sub={pro ? '1 egység tét / tipp, utólag mérve' : '🔒 PRO-val látható'} />
      </div>

      {!pro && (
        <Note tone="warn">
          <b>FREE csomag:</b> naponta {FREE_DAILY_TIPS} tipp és a nap első néhány mérkőzésének elemzése látható. A teljes lista, a modell indoklásai, az előzmények és a szelvényépítő PRO-val nyílik.
          <Link to="/pro" className="btn btn-sm btn-primary ml-2 mt-2 sm:mt-0"><Crown className="h-3.5 w-3.5" /> PRO kipróbálása</Link>
        </Note>
      )}

      {/* Napi és heti küldetések – a haladást a szerver számolja */}
      <MissionsCard />

      {/* Tippverseny – belépési pont */}
      {!!competitions.data?.length && (
        <Card
          title={<span className="flex items-center gap-2"><Trophy className="h-5 w-5 text-warning" /> Tippverseny</span>}
          right={<Link to="/tippverseny" className="btn btn-sm">Összes <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {competitions.data.slice(0, 3).map((c) => (
              <div key={c.id} className="flex flex-col gap-2 rounded-xl border border-border bg-card-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-bold text-text-muted">{c.leagueName}</span>
                  <CompetitionStatusBadge status={c.status} />
                </div>
                <div className="truncate text-base font-extrabold">{c.name}</div>
                {c.status === 'active' && <div className="text-xs font-semibold text-text-muted">Hátralévő idő: {remainingText(c.endsAt)}</div>}
                <Link to={`/tippverseny/${c.id}`} className="btn btn-sm btn-primary mt-auto">Megnyitás</Link>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Kiemelt tippek */}
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="section-title mb-0">🔝 Kiemelt piacok</h2>
            <p className="text-xs font-semibold text-text-muted">Nem rangsor: ≥60% modell-valószínűség, ≥3 támogató mutató, nem „kevés adat”. Minden kártyán látszik, miért szerepel.</p>
          </div>
          <Link to="/tippek" className="btn btn-sm">Szűrhető lista <ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
        {tips.loading ? <Card><Loading text="Modellek futtatása és hírek keresése a mai mérkőzésekre (első betöltéskor akár 1 perc)…" /></Card>
          : tips.error ? <ErrorBox message={tips.error} onRetry={tips.reload} />
            : highlighted.length === 0 ? <Card><div className="py-6 text-center text-sm font-semibold text-text-muted">Erre a napra nincs a szűrőknek megfelelő piac.</div></Card>
              : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {highlighted.map((t) => <TipCard key={t.matchId + t.tip.market} entry={t} pro={pro} />)}
                </div>
              )}
      </section>

      {/* Mai mérkőzések */}
      <Card title="⚽ Mai mérkőzések" right={<Link to="/meccsek" className="btn btn-sm">Összes <ArrowRight className="h-3.5 w-3.5" /></Link>}>
        {leagues.data && <div className="mb-4"><MatchFilters f={f} set={setF} leagues={leagues.data} /></div>}
        {matches.loading ? <Loading /> : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} /> : <MatchGrid matches={list.slice(0, 9)} isLocked={free.locked} />}
        {list.length > 9 && <div className="mt-3 text-center text-sm font-semibold text-text-muted">+{list.length - 9} további mérkőzés a <Link to="/meccsek" className="text-primary">Mai meccsek</Link> oldalon.</div>}
      </Card>

      <Disclaimer />
    </div>
  );
}
