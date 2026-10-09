/**
 * Lista-állapot az URL-BEN – hogy a böngészés kontextusa ne vesszen el.
 *
 * MIÉRT: a mérkőzéslista korábban komponens-állapotban tartotta a választott
 * napot (`useState(defaultFilters())`). Amikor a felhasználó megnyitott egy
 * meccset, a React Router lecsatolta a listát; visszalépéskor a komponens
 * újra csatolódott, az állapot újrainicializálódott, és a nap visszaugrott
 * mára. Az URL viszont a böngésző előzményének része, ezért visszalépéskor a
 * böngésző adja vissza – külön mentés nélkül.
 *
 * Ez egyben megoldja a megosztható/frissíthető címet is: a `?date=2026-10-11`
 * oldalt újratöltve ugyanaz a nap jön vissza.
 *
 * IDŐZÓNA: a dátum végig `YYYY-MM-DD` szöveg marad, és a meglévő `todayKey()`
 * helyi idő szerinti alakját használja. SEHOL nem megyünk át `Date`-en vagy
 * UTC-n, ezért nem keletkezhet egy nap elcsúszás.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { todayKey } from './format';

/** Pontosan `YYYY-MM-DD` alakú-e, és valódi naptári nap-e? */
export function isDateKey(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Helyi idő szerinti ellenőrzés: a Date(y, m-1, d) nem lép át UTC-be.
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/**
 * Az URL-ből olvasott nap. Hiányzó vagy érvénytelen érték esetén a mai nap –
 * a meglévő alapértelmezés, hibaüzenet nélkül (a rossz cím nem törhet el
 * semmit).
 */
export const dateFromParams = (params: URLSearchParams): string => {
  const raw = params.get('date');
  return isDateKey(raw) ? raw : todayKey();
};

/**
 * Szöveges lista-állapot az URL keresési paramétereiben.
 *
 * Csak azokat a kulcsokat írjuk ki, amelyeknek van értékük, és a `date`-et
 * csak akkor, ha nem a mai nap – így a cím tiszta marad, amíg a felhasználó
 * nem tér el az alapértelmezéstől.
 *
 * A frissítés `replace: true`-val megy: a szűrőállítás NEM hoz létre új
 * előzmény-bejegyzést, különben egyetlen „Vissza” nem a meccslistáról a
 * meccsre vinne, hanem a szűrőzgetés lépéseit játszaná vissza.
 */
/**
 * URL → állapot. A hiányzó kulcsok az alapértelmezést kapják, az érvénytelen
 * dátum pedig csendben visszaesik az alapértelmezésre.
 *
 * Tiszta függvény, hogy önmagában tesztelhető legyen.
 */
export function paramsToState<T extends Record<keyof T, string>>(defaults: T, params: URLSearchParams): T {
  const out: Record<string, string> = { ...(defaults as Record<string, string>) };
  for (const key of Object.keys(out)) {
    const raw = params.get(key);
    if (raw != null) out[key] = raw;
  }
  if ('date' in out && !isDateKey(out.date)) {
    out.date = (defaults as Record<string, string>).date;
  }
  return out as T;
}

/**
 * Állapot → URL. Üres értéket és (kérésre) az alapértelmezéssel egyező
 * kulcsot nem írunk ki, hogy a cím tiszta maradjon. A nem ismert paramétereket
 * (pl. más komponensé) érintetlenül hagyjuk.
 *
 * Tiszta függvény, hogy önmagában tesztelhető legyen.
 */
export function stateToParams<T extends Record<keyof T, string>>(
  defaults: T, next: T, current: URLSearchParams, omitWhenDefault: (keyof T)[] = [],
): URLSearchParams {
  const sp = new URLSearchParams(current);
  const rec = next as Record<string, string>;
  const def = defaults as Record<string, string>;
  const omit = omitWhenDefault.map(String);
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    const skip = !v || (omit.includes(k) && v === def[k]);
    if (skip) sp.delete(k); else sp.set(k, v);
  }
  return sp;
}

export function useUrlState<T extends Record<keyof T, string>>(
  defaults: T,
  /** Mely kulcsokat NE írjuk ki, ha az alapértelmezéssel egyeznek. */
  omitWhenDefault: (keyof T)[] = [],
): [T, (next: T) => void] {
  const [params, setParams] = useSearchParams();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => paramsToState(defaults, params), [params]);

  const set = useCallback(
    (next: T) => setParams(stateToParams(defaults, next, params, omitWhenDefault), { replace: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params, setParams],
  );

  return [value, set];
}
