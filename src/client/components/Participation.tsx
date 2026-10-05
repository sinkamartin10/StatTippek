/**
 * Tippverseny részvételi állapot: bejelentkezés → PRO → megjelenítési név.
 * A felületi jelzés CSAK tájékoztatás: a tényleges feltételeket a szerver ellenőrzi
 * (401 / 403 PRO_REQUIRED / 403 DISPLAY_NAME_REQUIRED).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Lock, UserCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { usePlan } from '../auth/PlanContext';
import { Note } from './ui';
import { DisplayNameEditor } from './DisplayNameEditor';

export interface Participation {
  loading: boolean;
  /** hitelesítés be van-e kapcsolva ezen a példányon */
  configured: boolean;
  loggedIn: boolean;
  pro: boolean;
  displayName: string | null;
  /** csak akkor true, ha minden feltétel teljesül */
  canPlay: boolean;
  reload: () => void;
}

export function useParticipation(): Participation {
  const { pro, loggedIn, configured, loading: planLoading } = usePlan();
  const me = useAsync(() => (!configured || loggedIn ? api.profileMe().catch(() => null) : Promise.resolve(null)), [configured, loggedIn]);
  const displayName = me.data?.displayName ?? null;
  // Supabase nélküli helyi módban nincs profil – ott a szerver sem követeli meg a nevet
  const nameOk = !configured || !!displayName;
  return {
    loading: planLoading || me.loading,
    configured,
    loggedIn,
    pro,
    displayName,
    canPlay: pro && (!configured || loggedIn) && nameOk,
    reload: me.reload,
  };
}

/** Egysoros, nem tolakodó állapotsáv + a hiányzó lépés elvégzése. */
export function ParticipationBox({ p }: { p: Participation }) {
  const [editing, setEditing] = useState(false);
  if (p.loading) return null;

  if (!p.loggedIn && p.configured) {
    return (
      <Note>
        <Lock className="mr-1 inline h-4 w-4" /> A Tippversenyben való részvételhez jelentkezz be. A versenyt és a ranglistát enélkül is megnézheted.
        <Link to="/bejelentkezes" className="btn btn-sm btn-primary ml-2 mt-2 sm:mt-0">Bejelentkezés</Link>
      </Note>
    );
  }

  if (!p.pro) {
    return (
      <Note tone="warn">
        🔒 A Tippverseny PRO előfizetők számára érhető el. A versenyt, a mérkőzéseket és a ranglistát továbbra is megnézheted.
        <Link to="/pro" className="btn btn-sm btn-primary ml-2 mt-2 sm:mt-0">PRO megtekintése</Link>
      </Note>
    );
  }

  if (!p.displayName && p.configured) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning-soft p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-bold">
            <UserCircle2 className="mr-1 inline h-4 w-4" /> A részvételhez először állíts be egy megjelenítési nevet.
          </span>
          {!editing && (
            <span className="flex gap-2">
              <button className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>Megjelenítési név beállítása</button>
              <Link to="/profil" className="btn btn-sm">Profil megnyitása</Link>
            </span>
          )}
        </div>
        {editing && (
          <div className="mt-3 rounded-xl bg-card p-3">
            <DisplayNameEditor current={null} onSaved={() => { setEditing(false); p.reload(); }} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-success/25 bg-success-soft px-4 py-3 text-sm font-bold text-text">
      <Check className="h-4 w-4 text-success" /> Részt vehetsz a Tippversenyben.
      {p.displayName && <span className="font-semibold text-text-muted">A ranglistán így jelensz meg: <b className="text-text">{p.displayName}</b></span>}
      <Link to="/profil" className="btn btn-sm btn-ghost ml-auto">Név módosítása</Link>
    </div>
  );
}
