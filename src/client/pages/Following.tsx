/**
 * Követés – a saját követettek és követők listája.
 *
 * Minden adat a SZERVERTŐL jön, lapozva: korlátlan lekérdezés nincs. A lap
 * nem social háló, csak két egyszerű lista, amiből a profilra lehet lépni.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, Users } from 'lucide-react';
import type { FollowListResponse } from '@shared/social';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { Card, ChipGroup, EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';
import { PlayerRow } from '../components/PlayerRow';
import { usePlan } from '../auth/PlanContext';

type Tab = 'kovetettek' | 'kovetok';

export default function Following() {
  const { loggedIn, configured } = usePlan();
  const [tab, setTab] = useState<Tab>('kovetettek');

  const data = useAsync<FollowListResponse | null>(
    async () => (configured && !loggedIn ? null
      : tab === 'kovetettek' ? api.following() : api.followers()),
    [tab, loggedIn],
  );

  if (configured && !loggedIn) {
    return (
      <div className="space-y-5">
        <PageHeader emoji="👥" title="Követés" text="Kövesd a játékosokat, akiket érdemes figyelned." />
        <EmptyState
          emoji="🔒"
          title="Jelentkezz be"
          text="A követett játékosaidat bejelentkezés után látod."
          action={<Link to="/bejelentkezes" className="btn btn-primary">Bejelentkezés</Link>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader emoji="👥" title="Követés" text="Akiket követsz, és akik téged követnek." />

      <ChipGroup<Tab>
        ariaLabel="Lista választása"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'kovetettek', label: 'Követettek' },
          { value: 'kovetok', label: 'Követők' },
        ]}
      />

      {data.loading && <Loading text="Betöltés…" />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}

      {data.data && (
        data.data.players.length === 0 ? (
          <EmptyState
            emoji={tab === 'kovetettek' ? '🔍' : '👋'}
            title={tab === 'kovetettek' ? 'Még senkit nem követsz' : 'Még nincs követőd'}
            text={tab === 'kovetettek'
              ? 'Keress játékosokat, és kövesd, akiknek a tippjeit figyelnéd.'
              : 'Oszd meg a profilodat, hogy mások is megtaláljanak.'}
            action={<Link to="/felfedezes" className="btn btn-primary"><UserPlus className="h-4 w-4" /> Játékosok keresése</Link>}
          />
        ) : (
          <Card
            title={tab === 'kovetettek' ? 'Követett játékosok' : 'Követőid'}
            right={<span className="inline-flex items-center gap-1.5 text-xs font-bold text-text-muted">
              <Users className="h-3.5 w-3.5" /> {data.data.players.length}
            </span>}
          >
            <ul className="divide-y divide-border">
              {data.data.players.map((p) => (
                <li key={p.displayName} className="py-2.5 first:pt-0 last:pb-0">
                  <PlayerRow player={p} />
                </li>
              ))}
            </ul>
            {data.data.hasMore && (
              <p className="mt-3 text-xs font-semibold text-text-muted">
                További játékosok is vannak – a lista lapozott.
              </p>
            )}
          </Card>
        )
      )}
    </div>
  );
}
