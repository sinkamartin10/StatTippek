/**
 * A nyilvános profil akciósora: követés és megosztás.
 *
 * A PÁRBAJ KIHÍVÁST NEM ez kezeli – arra a meglévő `ChallengeAction`
 * komponens az egyetlen forrás, és azt változatlanul hagyjuk.
 *
 * ADATVÉDELEM: minden művelet a MEGJELENÍTÉSI NÉVVEL dolgozik. A követő
 * azonosítóját a szerver veszi a tokenből – a kliens sosem küld ilyet.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Link2, LogIn, UserMinus, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { usePlan } from '../auth/PlanContext';

/** A profil kanonikus címe – ez kerül vágólapra és a natív megosztásba. */
export const profileUrl = (displayName: string): string =>
  `${window.location.origin}/jatekos/${encodeURIComponent(displayName)}`;

// ---------------------------------------------------------------------------
// Követés
// ---------------------------------------------------------------------------

export function FollowAction({
  displayName, isMe, initialFollowing, onChange,
}: {
  displayName: string;
  isMe: boolean;
  initialFollowing: boolean;
  /** a szülő a számlálót is frissíti belőle */
  onChange?: (following: boolean) => void;
}) {
  const { loggedIn, configured } = usePlan();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);
  // Kettős kattintás elleni zár: a state önmagában egy tickben megkerülhető
  const lock = useRef(false);

  useEffect(() => { setFollowing(initialFollowing); }, [initialFollowing, displayName]);

  if (isMe) return null;

  if (configured && !loggedIn) {
    return (
      <Link to="/bejelentkezes" className="btn btn-sm">
        <LogIn className="h-3.5 w-3.5" /> Belépés a követéshez
      </Link>
    );
  }

  const toggle = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const next = !following;
    try {
      // A szerver a mérvadó: a válasz dönti el a végső állapotot
      const r = next ? await api.follow(displayName) : await api.unfollow(displayName);
      setFollowing(r.following);
      onChange?.(r.following);
    } catch {
      // hálózati hiba: nem váltunk állapotot
    } finally {
      setBusy(false);
      lock.current = false;
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={following}
      className={`btn btn-sm ${following ? '' : 'btn-primary'}`}
    >
      {following
        ? <><Check className="h-3.5 w-3.5" /> Követed</>
        : <><UserPlus className="h-3.5 w-3.5" /> Követés</>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Megosztás
// ---------------------------------------------------------------------------

/**
 * Profil megosztása. Sorrend: natív megosztás → vágólap → kijelölhető cím.
 * Nincs backend végpont és nincs semmilyen követés/analitika.
 */
export function ShareAction({ displayName }: { displayName: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const url = profileUrl(displayName);

  const share = async () => {
    const title = `${displayName} – TippStats`;
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title, url });
        return;
      }
    } catch {
      // a felhasználó megszakította, vagy nem támogatott – megyünk a vágólapra
    }
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
      setTimeout(() => setState('idle'), 2500);
      return;
    } catch {
      // vágólap sem elérhető (pl. nem biztonságos kontextus) – mutatjuk a linket
      setState('manual');
    }
  };

  return (
    <span className="inline-flex min-w-0 flex-col items-stretch gap-1.5">
      <button type="button" onClick={share} className="btn btn-sm">
        <Link2 className="h-3.5 w-3.5" /> {state === 'copied' ? 'Profil link kimásolva' : 'Profil megosztása'}
      </button>
      {state === 'manual' && (
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="A profil címe – jelöld ki és másold"
          className="input text-xs"
        />
      )}
    </span>
  );
}

/** Az „ezt már követed" jelzés a listákban (nem akciógomb). */
export function FollowingBadge() {
  return (
    <span className="badge badge-blue shrink-0">
      <UserMinus className="h-3 w-3" aria-hidden /> követed
    </span>
  );
}
