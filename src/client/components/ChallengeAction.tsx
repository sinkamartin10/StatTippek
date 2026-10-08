/**
 * „Párbajra hívás" – a nyilvános játékosprofil SZOCIÁLIS belépési pontja.
 *
 * NEM új párbajrendszer: a meglévő 1v1 Tipp Battle folyamatába vezet át
 * (`/battles`), és minden szabályt a szerver dönt el. Ez a komponens csak azt
 * mutatja meg, hogy a néző MOST mit tehet ezzel a játékossal.
 *
 * ADATVÉDELEM – fontos:
 * A nyilvános profil API SOHA nem ad ki `user_id`-t, és ezen nem is lazítunk.
 * A kihíváshoz szükséges azonosítót a HITELESÍTETT `eligible-opponents`
 * végpont adja, amely eddig is visszaadta – a párosítás a megjelenítési név
 * alapján, kliensoldalon történik. Így a nyilvános válasz alakja változatlan.
 *
 * A párbaj FREE és PRO felhasználónak egyaránt jár – nincs csomagkapu.
 * Lekérdezés csak akkor indul, ha tényleg kellhet: kijelentkezve és a saját
 * profilon egyetlen hálózati kérés sem fut le.
 */
import { Link } from 'react-router-dom';
import { LogIn, Swords } from 'lucide-react';
import { sameDisplayName } from '@shared/displayName';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import { usePlan } from '../auth/PlanContext';

/** A párbaj-folyamatban „élő" állapotok – ilyenkor nem indítunk újat. */
const OPEN_STATUSES = new Set(['pending', 'active']);

export function ChallengeAction({ displayName, isMe }: { displayName: string; isMe: boolean }) {
  const { loggedIn, configured } = usePlan();

  // A párbaj NEM PRO funkció: a belépés az egyetlen feltétel.
  // Helyi (hitelesítés nélküli) módban mindig engedélyezett.
  const canChallenge = !configured || loggedIn;
  const active = !isMe && canChallenge;

  /**
   * Két hitelesített, kötött méretű lekérdezés – KIZÁRÓLAG akkor, ha a
   * kihívásnak egyáltalán van értelme. A hibát elnyeljük: a profil
   * megjelenítését ez a blokk soha nem törheti el.
   */
  const state = useAsync(async () => {
    if (!active) return null;
    const [list, opponents] = await Promise.all([
      api.battles().catch(() => null),
      api.battleEligibleOpponents().catch(() => []),
    ]);

    // Van-e már nyitott párbaj ezzel a játékossal? (a szerver is tiltja a duplát)
    const open = [...(list?.incoming ?? []), ...(list?.outgoing ?? []), ...(list?.active ?? [])]
      .find((b) => OPEN_STATUSES.has(b.status)
        && (sameDisplayName(b.challenger.displayName, displayName)
          || sameDisplayName(b.opponent.displayName, displayName)));
    if (open) return { kind: 'open' as const, battleId: open.id, status: open.status };

    const eligible = opponents.some((o) => sameDisplayName(o.displayName, displayName));
    return { kind: eligible ? ('ready' as const) : ('not-eligible' as const) };
  }, [active, displayName]);

  if (isMe) return null;

  // ---- Kijelentkezve: a profil látható marad, a kihívás bejelentkezést kér ----
  if (configured && !loggedIn) {
    return (
      <Shell>
        <Link to="/bejelentkezes" className="btn btn-sm w-full">
          <LogIn className="h-3.5 w-3.5" /> Jelentkezz be a kihíváshoz
        </Link>
      </Shell>
    );
  }

  if (state.loading || !state.data) return null;

  if (state.data.kind === 'open') {
    return (
      <Shell>
        <Link to={`/battles/${encodeURIComponent(state.data.battleId)}`} className="btn btn-sm w-full">
          <Swords className="h-3.5 w-3.5" />
          {state.data.status === 'pending' ? 'Függőben lévő párbaj' : 'Folyamatban lévő párbaj'}
        </Link>
      </Shell>
    );
  }

  if (state.data.kind === 'not-eligible') {
    return (
      <Shell>
        <p className="text-xs font-semibold text-text-muted">
          Ez a játékos most nem hívható ki: ellenfelet a Tippverseny ranglistáján
          szereplő, megjelenítési nevet beállított játékosok közül választhatsz.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <Link to={`/battles?kihivas=${encodeURIComponent(displayName)}`} className="btn btn-sm btn-primary w-full">
        <Swords className="h-3.5 w-3.5" /> Párbajra hívás
      </Link>
    </Shell>
  );
}

/** Közös keret, hogy minden állapot ugyanott és ugyanúgy jelenjen meg. */
function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mt-4">{children}</div>;
}
