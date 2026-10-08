/**
 * Nyilvános játékosprofil.
 *
 * ADATFORRÁS: EGYETLEN végpont, a `GET /api/profile/public/:displayName`. A lap
 * semmit nem számol újra: a szintet, a statisztikát, az achievementeket és a
 * verseny-előzményt készen kapja a szervertől, mert az a mérvadó.
 *
 * AMI SOHA NEM JELENIK MEG: e-mail, user_id, coin-egyenleg, coin-előzmény,
 * vásárlási előzmény, készlet, árak, előfizetési adat, fiókadat, egyedi tipp
 * részletei. A végpont válasza eleve nem tartalmaz ilyet (engedélyező lista a
 * `shared/publicProfile.ts`-ben), így a kliensnek nincs mit kitakarnia.
 *
 * A megjelenést UGYANAZ a `CosmeticProfile` renderer adja, mint a Shopban, a
 * saját profilon és a ranglistán – a kinézet nem tud szétcsúszni.
 */
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Award, Crosshair, Flame, ListChecks, Medal, Percent, Sparkles, Star, Target, Trophy,
} from 'lucide-react';
import type { PublicHighlight, PublicProfileResponse } from '@shared/publicProfile';
import { ApiError, api } from '../lib/api';
import { fmtDate, useAsync } from '../lib/format';
import { Card, EmptyState, ErrorBox, Loading, StatCard } from '../components/ui';
import { CosmeticProfile } from '../components/CosmeticProfile';
import { usePlan } from '../auth/PlanContext';

/** Ezres csoportosítás ICU nélkül – minden környezetben ugyanazt adja. */
const nf = (n: number) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** Arány százalékban. `null` → „–”, sosem NaN. */
const pct = (v: number | null) => (v == null ? '–' : `${Math.round(v * 100)}%`);

const HIGHLIGHT_ICON: Record<PublicHighlight['kind'], typeof Trophy> = {
  win: Trophy, podium: Medal, exact: Target, streak: Flame, level: Star, accuracy: Percent,
};

type Result = { ok: true; profile: PublicProfileResponse } | { ok: false; notFound: true };

export default function PublicProfile() {
  const { name = '' } = useParams();
  const displayName = decodeURIComponent(name);
  const { loggedIn } = usePlan();

  const state = useAsync<Result>(async () => {
    try {
      return { ok: true, profile: await api.publicProfile(displayName) };
    } catch (e) {
      // A 404 nem hiba, hanem üres állapot – a többi hibát felbukkantatjuk
      if (e instanceof ApiError && e.status === 404) return { ok: false, notFound: true };
      throw e;
    }
  }, [displayName]);

  // Csak azért, hogy a saját profilra visszavezessünk; kijelentkezve el sem indul.
  const me = useAsync(async () => (loggedIn ? (await api.profileMe()).displayName : null), [loggedIn]);

  if (state.loading) return <Loading text="Játékos betöltése…" />;

  if (state.error) {
    return (
      <div className="space-y-5">
        <BackLink />
        <ErrorBox message={state.error} onRetry={state.reload} />
      </div>
    );
  }

  if (!state.data || !state.data.ok) {
    return (
      <div className="space-y-5">
        <BackLink />
        <EmptyState
          emoji="🔍"
          title="Nincs ilyen játékos"
          text={`„${displayName}” nevű játékos nem található a TippStatson.`}
          action={<Link to="/tippverseny" className="btn btn-primary">Tippversenyek</Link>}
        />
      </div>
    );
  }

  const p = state.data.profile;
  const s = p.statistics;
  const isMe = !!me.data && me.data.toLowerCase() === p.displayName.toLowerCase();
  const progressPct = Math.round(p.progression.progress * 100);

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
        {/* ---------- Fejléc-oszlop: kinézet, szint, kiemelések ---------- */}
        <div className="space-y-3 lg:sticky lg:top-20">
          <Card className="text-center">
            <CosmeticProfile
              displayName={p.displayName}
              avatar={p.cosmetics.avatar}
              borderKey={p.cosmetics.borderKey}
              titleKey={p.cosmetics.titleKey}
              shop={p.cosmetics.shop}
              size={112}
            />

            <div className="mt-4 text-left">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-sm font-bold">
                <span>Szint {p.progression.level}{p.progression.levelTier ? ` · ${p.progression.levelTier}` : ''}</span>
                <span className="mono text-xs text-text-muted">
                  {p.progression.xpForNextLevel
                    ? `${nf(p.progression.xpIntoLevel)} / ${nf(p.progression.xpForNextLevel)} XP`
                    : `${nf(p.progression.xp)} XP`}
                </span>
              </div>
              <div
                className="xp-bar mt-2"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPct}
                aria-label={`Haladás a következő szintig: ${progressPct} százalék`}
              >
                <div className="xp-bar-fill" style={{ width: `${progressPct}%` }} />
              </div>
            </div>

            {isMe && <Link to="/profil" className="btn btn-sm mt-4 w-full">Ez te vagy – saját profil</Link>}
          </Card>

          {p.highlights.length > 0 && (
            <Card title="Kiemelések">
              <ul className="space-y-2">
                {p.highlights.map((h) => {
                  const Icon = HIGHLIGHT_ICON[h.kind];
                  return (
                    <li key={`${h.kind}-${h.label}`} className="flex items-center gap-2.5">
                      <span aria-hidden className="icon-bubble h-8 w-8 shrink-0 bg-warning-soft text-[#a96b00]"><Icon className="h-4 w-4" /></span>
                      <span className="min-w-0 flex-1 truncate text-sm font-bold text-text-muted">{h.label}</span>
                      <span className="mono shrink-0 text-sm font-extrabold">{h.value}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>

        {/* ---------- Tartalom-oszlop ---------- */}
        <div className="min-w-0 space-y-4">
          <div>
            <h1 className="truncate text-2xl font-extrabold tracking-tight sm:text-3xl">{p.displayName}</h1>
            <p className="mt-1 text-sm font-semibold text-text-muted">
              Nyilvános játékosprofil – tippelési teljesítmény és eredmények.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard icon={<ListChecks className="h-4 w-4" />} tone="neutral" label="Tippek"
              value={nf(s.totalPredictions)} sub={`${nf(s.settledPredictions)} lezárt`} />
            <StatCard icon={<Percent className="h-4 w-4" />} tone="success" label="Pontosság"
              value={pct(s.accuracy)} sub={`${nf(s.correctPredictions)} helyes`} />
            <StatCard icon={<Crosshair className="h-4 w-4" />} tone="primary" label="Pontos eredmény"
              value={nf(s.exactScores)} sub={`arány: ${pct(s.exactHitRate)}`} />
            <StatCard icon={<Flame className="h-4 w-4" />} tone="warning" label="Leghosszabb sorozat"
              value={nf(s.bestStreak)} sub={`jelenleg: ${nf(s.currentStreak)}`} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard icon={<Trophy className="h-4 w-4" />} tone="warning" label="Győzelem"
              value={nf(s.competitionWins)} sub={`${nf(s.competitionPodiums)} dobogó`} />
            <StatCard icon={<Medal className="h-4 w-4" />} tone="neutral" label="Legjobb helyezés"
              value={s.bestPlacement == null ? '–' : `${s.bestPlacement}.`} />
            <StatCard icon={<Sparkles className="h-4 w-4" />} tone="primary" label="Versenyek"
              value={nf(s.competitions)} sub="szereplés" />
            <StatCard icon={<Award className="h-4 w-4" />} tone="success" label="Achievement"
              value={nf(p.achievements.length)} sub="feloldva" />
          </div>

          {/* Verseny-előzmény */}
          <Card title="Szereplés a versenyeken">
            {p.competitions.length === 0 ? (
              <p className="text-sm font-semibold text-text-muted">Még nem szerepelt egyetlen Tippversenyen sem.</p>
            ) : (
              <ul className="divide-y divide-border">
                {p.competitions.map((c) => (
                  <li key={c.competitionId} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <span className="w-9 shrink-0 text-center text-sm font-extrabold text-text-muted">
                      {c.placement == null ? '–' : `${c.placement}.`}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link to={`/tippverseny/${c.competitionId}`} className="block truncate text-sm font-bold transition hover:text-primary">
                        {c.name}
                      </Link>
                      <p className="mt-0.5 text-xs font-semibold text-text-muted">
                        {nf(c.predictions)} tipp · {nf(c.exactHits)} pontos
                      </p>
                    </div>
                    <span className="mono shrink-0 text-sm font-extrabold">{nf(c.points)} pont</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Achievementek – csak a feloldottak */}
          <Card title="Feloldott achievementek">
            {p.achievements.length === 0 ? (
              <p className="text-sm font-semibold text-text-muted">Még nincs feloldott achievement.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {p.achievements.map((a) => (
                  <li key={a.key} className="flex items-start gap-2.5 rounded-xl border border-border bg-surface p-2.5">
                    <span aria-hidden className="text-xl leading-none">{a.icon}</span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-extrabold">{a.name}</div>
                      <p className="text-xs font-semibold text-text-muted">{a.description}</p>
                      {a.unlockedAt && (
                        <p className="mono mt-0.5 text-[11px] font-bold text-text-muted">{fmtDate(a.unlockedAt)}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <p className="text-xs font-semibold text-text-muted">
            A nyilvános profil csak a játékos tippelési teljesítményét mutatja. A coin-egyenleg, a
            vásárlások, a készlet és a fiókadatok soha nem nyilvánosak.
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
