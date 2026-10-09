/** Magyar formázási segédfüggvények. */
import { useEffect, useState } from 'react';

export const pct = (p: number | null | undefined, digits = 0) =>
  p == null || Number.isNaN(p) ? '–' : `${(p * 100).toFixed(digits).replace('.', ',')}%`;

export const pct100 = (p: number | null | undefined, digits = 0) =>
  p == null || Number.isNaN(p) ? '–' : `${p.toFixed(digits).replace('.', ',')}%`;

export const num = (n: number | null | undefined, digits = 2) =>
  n == null || Number.isNaN(n) ? '–' : n.toFixed(digits).replace('.', ',');

export const odds = (o: number | null | undefined) => (o == null ? '–' : o.toFixed(2).replace('.', ','));

export const signed = (n: number | null | undefined, digits = 2) =>
  n == null ? '–' : `${n > 0 ? '+' : ''}${n.toFixed(digits).replace('.', ',')}`;

const HU_DAYS = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];

export function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}.`;
}

export function fmtDateTime(iso: string) {
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}

export function fmtDayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400000);
  if (diff === 0) return 'Ma';
  if (diff === 1) return 'Holnap';
  if (diff === -1) return 'Tegnap';
  return `${fmtDate(iso)} (${HU_DAYS[d.getDay()]})`;
}

export function todayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const IMPORTANCE_LABEL: Record<string, string> = { low: 'Alacsony', normal: 'Normál', high: 'Kiemelt', top: 'Rangadó' };
export const STATUS_LABEL: Record<string, string> = { scheduled: 'Tervezett', live: 'Élő', finished: 'Lejátszott', postponed: 'Elhalasztva' };

/**
 * Rövid életű pillanatkép az utolsó sikeres lekérésekről.
 *
 * MIÉRT: ha a felhasználó megnyit egy meccset, majd visszalép, a lista
 * komponens ÚJRA csatolódik, és egy üres töltőképernyőn át jutna el ugyanahhoz
 * az adathoz. A pillanatkép ilyenkor azonnal megmutatja a korábbi listát,
 * miközben a háttérben mindig újratöltünk – így a frissességi garancia NEM
 * gyengül, csak a villogás tűnik el.
 *
 * A tárolás szándékosan szűk: memóriában él (újratöltésnél eltűnik), kötött
 * elemszámmal, és rövid lejárattal – elavult adatot nem őrizgetünk.
 */
const SNAPSHOT_TTL_MS = 60_000;
const SNAPSHOT_MAX = 20;
const snapshots = new Map<string, { at: number; data: unknown }>();

function readSnapshot<T>(key: string | null): T | null {
  if (!key) return null;
  const hit = snapshots.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SNAPSHOT_TTL_MS) { snapshots.delete(key); return null; }
  return hit.data as T;
}

function writeSnapshot(key: string | null, data: unknown): void {
  if (!key) return;
  // A legrégebbi kulcs esik ki először – a Map beszúrási sorrendet tart
  if (snapshots.size >= SNAPSHOT_MAX) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
  snapshots.set(key, { at: Date.now(), data });
}

/** Teszthez / kijelentkezéshez: a pillanatképek eldobása. */
export const clearSnapshots = (): void => { snapshots.clear(); };

/** Egyszerű adatlekérő hook: betöltés/hiba/adat állapottal. */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  /**
   * Nem kötelező pillanatkép-kulcs. Megadva a hook az utolsó friss eredményt
   * AZONNAL megmutatja (nincs töltőképernyő), és a háttérben újratölt.
   * Kulcs nélkül a viselkedés bitre azonos a korábbival.
   */
  snapshotKey?: string | null,
) {
  const seed = snapshotKey ? readSnapshot<T>(snapshotKey) : null;
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>(
    seed != null ? { data: seed, error: null, loading: false } : { data: null, error: null, loading: true },
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const cached = snapshotKey ? readSnapshot<T>(snapshotKey) : null;
    // Van friss pillanatkép? Akkor azt mutatjuk, és csendben revalidálunk.
    setState((s) => (cached != null
      ? { data: cached, error: null, loading: false }
      : { ...s, loading: true, error: null }));
    fn().then(
      (data) => {
        writeSnapshot(snapshotKey ?? null, data);
        if (alive) setState({ data, error: null, loading: false });
      },
      (e: Error) => alive && setState({ data: null, error: e.message, loading: false }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, snapshotKey]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
