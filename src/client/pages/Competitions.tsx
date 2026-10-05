/** Tippverseny – versenyek listája. Mindenki láthatja; tippelni csak PRO előfizetéssel lehet. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarRange, Settings2 } from 'lucide-react';
import { COMPETITION_STATUS_LABEL, type Competition, type CompetitionStatus } from '@shared/competition';
import { api } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';
import { ParticipationBox, useParticipation } from '../components/Participation';

const STATUS_BADGE: Record<CompetitionStatus, string> = {
  draft: 'badge-muted',
  scheduled: 'badge-yellow',
  active: 'badge-green',
  finished: 'badge-blue',
  cancelled: 'badge-red',
};

export function CompetitionStatusBadge({ status }: { status: CompetitionStatus }) {
  return <span className={`badge ${STATUS_BADGE[status]}`}>{COMPETITION_STATUS_LABEL[status]}</span>;
}

/** Hátralévő idő rövid, olvasható formában (nap/óra/perc). */
export function remainingText(target: string, now = Date.now()): string {
  const ms = new Date(target).getTime() - now;
  if (ms <= 0) return 'lejárt';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d} nap ${h} óra`;
  if (h > 0) return `${h} óra ${m} perc`;
  return `${m} perc`;
}

/** Igaz, ha a bejelentkezett felhasználó adminisztrátor – a szerver dönti el (403 → nem). */
export function useIsAdmin(): boolean {
  const [admin, setAdmin] = useState(false);
  useEffect(() => {
    let alive = true;
    api.adminCompetitions().then(() => { if (alive) setAdmin(true); }).catch(() => { if (alive) setAdmin(false); });
    return () => { alive = false; };
  }, []);
  return admin;
}

export function CompetitionCard({ c }: { c: Competition }) {
  return (
    <div className="card card-lift flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-text-muted">{c.leagueName}</span>
        <CompetitionStatusBadge status={c.status} />
      </div>
      <h3 className="text-lg font-extrabold tracking-tight">{c.name}</h3>
      <div className="flex items-start gap-2 text-xs font-semibold text-text-muted">
        <CalendarRange className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{fmtDateTime(c.startsAt)} – {fmtDateTime(c.endsAt)}</span>
      </div>
      {c.status === 'active' && (
        <div className="rounded-xl bg-surface px-3 py-2 text-xs font-bold text-text-muted">
          Hátralévő idő: <span className="text-text">{remainingText(c.endsAt)}</span>
        </div>
      )}
      <Link to={`/tippverseny/${c.id}`} className="btn btn-primary mt-auto w-full">
        Megnyitás <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

export default function Competitions() {
  const list = useAsync(() => api.competitions(), []);
  const participation = useParticipation();
  const admin = useIsAdmin();

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🏆"
        title="Tippverseny"
        text="Tippeld meg a mérkőzések végeredményét, és gyűjts pontokat. Pontos eredmény 5 pont, helyes kimenetel 3 pont."
        right={admin ? <Link to="/admin/tippverseny" className="btn"><Settings2 className="h-4 w-4" /> Admin</Link> : undefined}
      />

      <ParticipationBox p={participation} />

      {list.loading ? <Card><Loading text="Versenyek betöltése…" /></Card>
        : list.error ? <ErrorBox message={list.error} onRetry={list.reload} />
          : !list.data?.length ? (
            <EmptyState emoji="🏁" title="Jelenleg nincs meghirdetett tippverseny" text="Nézz vissza később – az új versenyek itt jelennek meg." />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {list.data.map((c) => <CompetitionCard key={c.id} c={c} />)}
            </div>
          )}

      <Card title="Hogyan működik?">
        <ol className="list-decimal space-y-2 pl-5 text-sm font-semibold text-text-muted">
          <li>Válassz egy aktív versenyt, és nyisd meg.</li>
          <li>Tippeld meg a mérkőzések pontos végeredményét a kezdő sípszó előtt.</li>
          <li>A kezdés után a tipp zárolódik, és már nem módosítható.</li>
          <li>Az eredmények beérkezése után a rendszer automatikusan pontoz, és frissül a ranglista.</li>
          <li>A verseny végén az első három helyezett jutalmat kap, amit az adminisztrátor ad át.</li>
        </ol>
      </Card>

      <Disclaimer />
    </div>
  );
}
