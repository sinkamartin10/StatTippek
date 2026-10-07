/**
 * Nyilvános játékosprofil.
 *
 * ADATFORRÁS: KIZÁRÓLAG a már létező, nyilvános Tippverseny-ranglista
 * (`GET /api/competition/:id/leaderboard`). Nem készült hozzá új backend
 * végpont, és nem kér le semmit, ami ne lenne eddig is nyilvános.
 *
 * AMI SOHA NEM JELENIK MEG: e-mail, user_id, coin-egyenleg, coin-előzmény,
 * vásárlási előzmény, fiókadat. A ranglista válasza eleve nem tartalmaz
 * ilyet – a felhasználót a megjelenítési neve azonosítja, nem az azonosítója.
 *
 * AMI NINCS: szint/XP, achievementek és a részletes tipster-statisztika, mert
 * ezekhez ma csak SAJÁT, hitelesített végpont létezik (`/api/progression/*`).
 * Ezeket szándékosan kihagyjuk, nem építünk hozzá új, nyilvános végpontot.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Crosshair, ListChecks, Medal, Trophy } from 'lucide-react';
import type { Competition, LeaderboardRow } from '@shared/competition';
import type { ShopEquips } from '@shared/shop';
import { api } from '../lib/api';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatCard } from '../components/ui';
import { CosmeticProfile } from '../components/CosmeticProfile';

/** Hány versenyt nézünk át – kötött felső korlát, hogy ne legyen N+1 robbanás. */
const MAX_COMPETITIONS = 6;

interface Appearance {
  competition: Competition;
  row: LeaderboardRow;
}

export default function PublicProfile() {
  const { name = '' } = useParams();
  const displayName = decodeURIComponent(name);

  const [appearances, setAppearances] = useState<Appearance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAppearances(null);
    setError(null);

    (async () => {
      try {
        const competitions = await api.competitions();
        const recent = competitions
          .filter((c) => c.status === 'active' || c.status === 'finished')
          .slice(0, MAX_COMPETITIONS);

        const boards = await Promise.all(recent.map(async (competition) => {
          try {
            const rows = await api.competitionLeaderboard(competition.id);
            const row = rows.find((r) => r.displayName === displayName);
            return row ? { competition, row } : null;
          } catch { return null; }
        }));

        if (!cancelled) setAppearances(boards.filter((b): b is Appearance => b !== null));
      } catch {
        if (!cancelled) setError('A játékos profilja most nem tölthető be.');
      }
    })();

    return () => { cancelled = true; };
  }, [displayName]);

  /** Összesített, NYILVÁNOS statisztika a megtalált ranglista-sorokból. */
  const summary = useMemo(() => {
    if (!appearances?.length) return null;
    const points = appearances.reduce((s, a) => s + a.row.points, 0);
    const predictions = appearances.reduce((s, a) => s + a.row.predictions, 0);
    const exactHits = appearances.reduce((s, a) => s + a.row.exactHits, 0);
    const bestRank = Math.min(...appearances.map((a) => a.row.rank));
    const podiums = appearances.filter((a) => a.row.rank <= 3).length;
    // A megjelenés a LEGFRISSEBB versenyből – ez a játékos aktuális kinézete
    const latest = appearances[0].row;
    return { points, predictions, exactHits, bestRank, podiums, latest, isMe: appearances.some((a) => a.row.isMe) };
  }, [appearances]);

  if (error) {
    return (
      <div className="space-y-5">
        <PageHeader emoji="👤" title="Játékos" />
        <ErrorBox message={error} />
      </div>
    );
  }

  if (!appearances) return <Loading text="Játékos betöltése…" />;

  if (!summary) {
    return (
      <div className="space-y-5">
        <BackLink />
        <EmptyState
          emoji="🔍"
          title="Nincs megjeleníthető adat"
          text={`„${displayName}” nem szerepel a jelenlegi Tippversenyek ranglistáin.`}
          action={<Link to="/tippverseny" className="btn btn-primary">Tippversenyek</Link>}
        />
      </div>
    );
  }

  const profile = summary.latest.profile;

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
        {/* Játékoskártya – ugyanaz a renderer, mint a Shopban és a profilon */}
        <div className="space-y-3">
          <CosmeticProfile
            displayName={summary.latest.displayName}
            avatar={profile?.avatar}
            borderKey={profile?.borderKey}
            titleKey={profile?.titleKey}
            shop={profile?.shop as Partial<ShopEquips> | undefined}
            size={112}
          />
          {summary.isMe && (
            <Link to="/profil" className="btn btn-sm w-full">Ez te vagy – saját profil</Link>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <PageHeader
            title={summary.latest.displayName}
            text="Nyilvános játékosprofil a Tippverseny-ranglisták alapján."
          />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard icon={<Trophy className="h-4 w-4" />} label="Összpont" value={summary.points} tone="primary" />
            <StatCard icon={<ListChecks className="h-4 w-4" />} label="Tippek" value={summary.predictions} tone="primary" />
            <StatCard icon={<Crosshair className="h-4 w-4" />} label="Pontos eredmény" value={summary.exactHits} tone="success" />
            <StatCard icon={<Medal className="h-4 w-4" />} label="Legjobb helyezés" value={`${summary.bestRank}.`} tone="warning" />
          </div>

          <Card title="Szereplés a versenyeken">
            <ul className="divide-y divide-border">
              {appearances.map(({ competition, row }) => (
                <li key={competition.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="w-10 shrink-0 text-center text-sm font-extrabold text-text-muted">
                    {row.rank}.
                  </span>
                  <Link to={`/tippverseny/${competition.id}`} className="min-w-0 flex-1 truncate text-sm font-bold transition hover:text-primary">
                    {competition.name}
                  </Link>
                  <span className="mono shrink-0 text-sm font-extrabold">{row.points} pont</span>
                </li>
              ))}
            </ul>
            {summary.podiums > 0 && (
              <p className="mt-3 text-xs font-semibold text-text-muted">
                Dobogós helyezés: <strong className="text-text">{summary.podiums}</strong>
              </p>
            )}
          </Card>

          <p className="text-xs font-semibold text-text-muted">
            A nyilvános profil a Tippverseny-ranglisták adatait mutatja. A coin-egyenleg, a vásárlások
            és a fiókadatok soha nem nyilvánosak.
          </p>
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/tippverseny" className="inline-flex items-center gap-1.5 text-sm font-bold text-text-muted transition hover:text-primary">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Vissza a Tippversenyhez
    </Link>
  );
}
