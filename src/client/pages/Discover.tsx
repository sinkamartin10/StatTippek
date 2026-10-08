/**
 * Felfedezés – játékos-keresés és Top Tipsterek.
 *
 * MINDEN rangsort a SZERVER állít elő a meglévő nyilvános statisztikából; a
 * kliens csak megjelenít. Kategória csak akkor látszik, ha a jelenlegi adatból
 * HELYESEN kiszámolható – kitalált rangsor nincs.
 */
import { useEffect, useState } from 'react';
import { Search, Users } from 'lucide-react';
import type { PlayerSearchResponse, TopTier, TopTipstersResponse } from '@shared/social';
import { SEARCH_MIN_LENGTH } from '@shared/social';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { PlayerRow } from '../components/PlayerRow';

/** A fokozat kizárólag megjelenítés – nem vásárolható és előnyt nem ad. */
const TIER_STYLE: Record<TopTier, string> = {
  GOLD: 'bg-warning-soft text-[#a96b00]',
  SILVER: 'bg-surface text-text-muted',
  BRONZE: 'bg-surface text-text-muted',
};

export default function Discover() {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');

  // Pergés-csillapítás: gépelés közben nem indítunk kérést minden leütésre
  useEffect(() => {
    const t = setTimeout(() => setQuery(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);

  const results = useAsync<PlayerSearchResponse | null>(
    async () => (query.length < SEARCH_MIN_LENGTH ? null : api.playerSearch(query)),
    [query],
  );
  const top = useAsync<TopTipstersResponse>(() => api.topTipsters(), []);

  return (
    <div className="space-y-5">
      <PageHeader emoji="🔎" title="Felfedezés" text="Keress játékost, vagy nézd meg, kik teljesítenek a legjobban." />

      {/* ------------------------------ Keresés ------------------------------ */}
      <Card title="Játékos keresése">
        <label htmlFor="player-search" className="sr-only">Játékos keresése</label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            id="player-search"
            className="input pl-9"
            type="search"
            placeholder="Játékos keresése…"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            autoComplete="off"
          />
        </div>

        {term.trim().length > 0 && term.trim().length < SEARCH_MIN_LENGTH && (
          <p className="mt-2 text-xs font-semibold text-text-muted">
            Írj legalább {SEARCH_MIN_LENGTH} karaktert.
          </p>
        )}

        {results.loading && <div className="mt-3"><Loading text="Keresés…" /></div>}
        {results.error && <div className="mt-3"><ErrorBox message={results.error} /></div>}

        {results.data && (
          results.data.players.length === 0 ? (
            <p className="mt-3 text-sm font-semibold text-text-muted">
              Nincs találat – a keresés a név elejére illeszkedik.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {results.data.players.map((p) => (
                <li key={p.displayName} className="py-2.5 first:pt-0 last:pb-0">
                  <PlayerRow player={p} />
                </li>
              ))}
            </ul>
          )
        )}
      </Card>

      {/* --------------------------- Top Tipsterek --------------------------- */}
      {top.loading && <Loading text="Top Tipsterek betöltése…" />}
      {top.error && <ErrorBox message={top.error} onRetry={top.reload} />}

      {top.data && (top.data.categories.length === 0 ? (
        <EmptyState
          emoji="📊"
          title="Még nincs elég adat"
          text="A Top Tipsterek listája akkor jelenik meg, ha már elegendő lezárt tipp gyűlt össze."
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {top.data.categories.map((c) => (
              <Card key={c.key} title={c.label} className="min-w-0">
                <ol className="divide-y divide-border">
                  {c.entries.map((e) => (
                    <li key={e.player.displayName} className="flex items-center gap-2.5 py-2.5 first:pt-0 last:pb-0">
                      <span className={`badge shrink-0 ${TIER_STYLE[e.tier]}`} title={`${e.rank}. hely`}>
                        {e.rank}.
                      </span>
                      {/* `compact`: a sor saját szint/pontosság oszlopa kimarad,
                          mert a kategória mérőszáma áll mellette */}
                      <div className="min-w-0 flex-1">
                        <PlayerRow player={e.player} compact />
                      </div>
                      <span className="min-w-0 basis-28 text-right">
                        <span className="mono block truncate text-sm font-extrabold">{e.value}</span>
                        <span className="block truncate text-xs font-semibold text-text-muted">{e.sample}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </Card>
            ))}
          </div>

          <Note>
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden />
              A rangsor {top.data.poolSize} Tippverseny-résztvevő nyilvános statisztikájából készül.
              Kis mintán senki nem kerül rangsorba, és a helyezés sem pénzért, sem kozmetikumért nem befolyásolható.
            </span>
          </Note>
        </>
      ))}
    </div>
  );
}
