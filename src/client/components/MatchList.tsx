/** Mérkőzéslista kártyákkal + szűrősáv. A Dashboard és a Mai meccsek oldal is ezt használja. */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Lightbulb, Lock } from 'lucide-react';
import type { League } from '@shared/types';
import type { MatchWithTeams } from '../lib/api';
import { fmtDayLabel, fmtTime, STATUS_LABEL, todayKey } from '../lib/format';
import { EmptyState, ImportanceBadge, OriginBadge } from './ui';
import { ProLock } from '../auth/PlanContext';

export interface MatchFilterState {
  date: string;
  country: string;
  leagueId: string;
  team: string;
  importance: string;
  timeFrom: string;
  timeTo: string;
}

export const defaultFilters = (): MatchFilterState => ({ date: todayKey(), country: '', leagueId: '', team: '', importance: '', timeFrom: '', timeTo: '' });

export function MatchFilters({ f, set, leagues }: { f: MatchFilterState; set: (f: MatchFilterState) => void; leagues: League[] }) {
  const countries = useMemo(() => [...new Set(leagues.map((l) => l.country))].sort(), [leagues]);
  const leagueOptions = leagues.filter((l) => !f.country || l.country === f.country);
  const u = (patch: Partial<MatchFilterState>) => set({ ...f, ...patch });
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
      <label className="text-xs text-muted">Dátum
        <input type="date" className="input mt-1" value={f.date} onChange={(e) => u({ date: e.target.value })} />
      </label>
      <label className="text-xs text-muted">Ország
        <select className="input mt-1" value={f.country} onChange={(e) => u({ country: e.target.value, leagueId: '' })}>
          <option value="">Összes</option>
          {countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="text-xs text-muted">Bajnokság
        <select className="input mt-1" value={f.leagueId} onChange={(e) => u({ leagueId: e.target.value })}>
          <option value="">Összes</option>
          {leagueOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <label className="text-xs text-muted">Csapat
        <input className="input mt-1" placeholder="pl. Arsenal" value={f.team} onChange={(e) => u({ team: e.target.value })} />
      </label>
      <label className="text-xs text-muted">Fontosság
        <select className="input mt-1" value={f.importance} onChange={(e) => u({ importance: e.target.value })}>
          <option value="">Összes</option>
          <option value="top">Rangadó</option>
          <option value="high">Kiemelt</option>
          <option value="normal">Normál</option>
          <option value="low">Alacsony</option>
        </select>
      </label>
      <label className="text-xs text-muted">Kezdés (-tól)
        <input type="time" className="input mt-1" value={f.timeFrom} onChange={(e) => u({ timeFrom: e.target.value })} />
      </label>
      <label className="text-xs text-muted">Kezdés (-ig)
        <input type="time" className="input mt-1" value={f.timeTo} onChange={(e) => u({ timeTo: e.target.value })} />
      </label>
    </div>
  );
}

/** Kliensoldali szűrés a csapatnévre és kezdési időre (a többit a szerver szűri). */
export function applyClientFilters(matches: MatchWithTeams[], f: MatchFilterState) {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const t = norm(f.team.trim());
  return matches.filter((m) => {
    if (t && !norm(`${m.homeTeam?.name ?? ''} ${m.awayTeam?.name ?? ''}`).includes(t)) return false;
    const time = fmtTime(m.kickoff);
    if (f.timeFrom && time < f.timeFrom) return false;
    if (f.timeTo && time > f.timeTo) return false;
    return true;
  });
}

export function MatchCard({ m, locked }: { m: MatchWithTeams; locked?: boolean }) {
  const finished = m.status === 'finished' || m.status === 'live';
  return (
    <div className={`card flex flex-col gap-3 p-4 transition hover:border-accent/50 ${locked ? 'opacity-80' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-text/90">{m.league?.name ?? m.leagueId}</span>
          <span>· {m.league?.country}</span>
        </div>
        <div className="flex items-center gap-2">
          <ImportanceBadge importance={m.importance} />
          {locked ? <ProLock /> : <OriginBadge origin={m.origin} small />}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/csapat/${m.homeTeamId}`} className="block truncate text-base font-semibold hover:text-accent">{m.homeTeam?.name ?? m.homeTeamId}</Link>
          <Link to={`/csapat/${m.awayTeamId}`} className="block truncate text-base font-semibold hover:text-accent">{m.awayTeam?.name ?? m.awayTeamId}</Link>
        </div>
        <div className="text-right">
          {finished && m.homeGoals != null ? (
            <div className="mono text-2xl font-bold leading-tight">{m.homeGoals}<br />{m.awayGoals}</div>
          ) : (
            <>
              <div className="mono text-xl font-bold">{fmtTime(m.kickoff)}</div>
              <div className="text-xs text-muted">{fmtDayLabel(m.kickoff)}</div>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`badge ${m.status === 'live' ? 'badge-red' : m.status === 'finished' ? 'badge-muted' : 'badge-green'}`}>{STATUS_LABEL[m.status]}</span>
        <div className="flex gap-2">
          {locked ? (
            <Link to={`/meccs/${encodeURIComponent(m.id)}`} className="btn btn-sm"><Lock className="h-3.5 w-3.5 text-warn" /> Elemzés (PRO)</Link>
          ) : (
            <>
              <Link to={`/meccs/${encodeURIComponent(m.id)}`} className="btn btn-sm"><Sparkles className="h-3.5 w-3.5" /> Elemzés</Link>
              <Link to={`/meccs/${encodeURIComponent(m.id)}#tippek`} className="btn btn-sm btn-primary"><Lightbulb className="h-3.5 w-3.5" /> Tipp</Link>
            </>
          )}
        </div>
      </div>
      {m.importanceReasons.length > 0 && <div className="text-xs text-muted">{m.importanceReasons.join(' · ')}</div>}
    </div>
  );
}

export function MatchGrid({ matches, emptyText, isLocked }: { matches: MatchWithTeams[]; emptyText?: string; isLocked?: (id: string) => boolean }) {
  if (!matches.length) return <EmptyState title="Nincs a szűrésnek megfelelő mérkőzés" text={emptyText ?? 'Módosítsd a szűrőket vagy válassz másik napot.'} />;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {matches.map((m) => <MatchCard key={m.id} m={m} locked={isLocked?.(m.id)} />)}
    </div>
  );
}
