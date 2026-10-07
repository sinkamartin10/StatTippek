/**
 * Tippverseny részvételi állapot: bejelentkezés → megjelenítési név.
 * FREE csomaggal is részt lehet venni, napi tippkerettel; a keretet a szerver
 * kényszeríti ki. A felületi jelzés CSAK tájékoztatás: a tényleges feltételeket
 * a szerver ellenőrzi (401 / 403 DISPLAY_NAME_REQUIRED / 403 FREE_DAILY_LIMIT_REACHED).
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
  /** csak akkor true, ha minden részvételi feltétel teljesül (a napi keret ettől független) */
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
    // A csomag NEM zárja ki a részvételt: a FREE felhasználó is tippelhet,
    // csak napi keret mellett (azt a szerver tartja nyilván és kényszeríti ki).
    canPlay: (!configured || loggedIn) && nameOk,
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
      {!p.pro && p.configured && (
        <span className="font-semibold text-text-muted">
          FREE csomagban naponta 3 új tippet adhatsz le, és a verseny jutalmaira nem vagy jogosult.
          <Link to="/pro" className="btn btn-sm btn-primary ml-2">PRO megtekintése</Link>
        </span>
      )}
      <Link to="/profil" className="btn btn-sm btn-ghost ml-auto">Név módosítása</Link>
    </div>
  );
}
