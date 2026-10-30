/**
 * ESPN HTTP-réteg: a párhuzamos, AZONOS címre menő lekérések egyetlen hálózati kérést osztanak meg
 * (`EspnProvider.callMeta`). Hamis `fetch`, hálózat nélkül.
 *
 * Ellenőrzi: egy kérés két párhuzamos hívónak; a retain:false hívó nem ír cache-be (és nem csatlakozik egy
 * retain:true lekéréshez); a sikertelen lekérés nem ragad be; a lekérés vége után az új hívó új kérést indít.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EspnProvider } from '../src/server/data/espnProvider';

type Meta = { data: unknown; fetchedAt: number | null } | null;
/** a privát HTTP-réteg közvetlen elérése (a szemantika pontos ellenőrzéséhez) */
const callMeta = (p: EspnProvider, path: string, retain = true): Promise<Meta> =>
  (p as unknown as { callMeta: (path: string, ttl: number, o: { retain?: boolean }) => Promise<Meta> }).callMeta(path, 60_000, { retain });

/** Hamis ESPN: a válasz 20 ms múlva érkezik, így az egyszerre indított hívók biztosan átfednek. */
function gatedFetch(status = 200) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url).split('/soccer/')[1]);
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ n }), { status });
  }));
  return { calls };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ESPN – folyamatban lévő lekérés megosztása', () => {
  it('két párhuzamos hívó ugyanarra a címre: egy hálózati kérés, ugyanaz a válasz', async () => {
    const f = gatedFetch();
    const p = new EspnProvider();
    const a = callMeta(p, 'eng.1/teams');
    const b = callMeta(p, 'eng.1/teams');
    const [ra, rb] = await Promise.all([a, b]);
    expect(f.calls).toEqual(['eng.1/teams']);
    expect(ra).toEqual(rb);
    expect(ra?.data).toEqual({ n: 1 });
    // a lekérés vége után a memóriacache szolgál ki (retain) – új hálózati kérés nincs
    expect((await callMeta(p, 'eng.1/teams'))?.data).toEqual({ n: 1 });
    expect(f.calls).toHaveLength(1);
  });

  it('különböző címek nem osztoznak', async () => {
    const f = gatedFetch();
    const p = new EspnProvider();
    const a = callMeta(p, 'eng.1/teams');
    const b = callMeta(p, 'esp.1/teams');
    await Promise.all([a, b]);
    expect(f.calls.sort()).toEqual(['eng.1/teams', 'esp.1/teams']);
  });

  it('retain:false: a párhuzamos retain:false hívók osztoznak, de semmi nem kerül cache-be (később új kérés)', async () => {
    const f = gatedFetch();
    const p = new EspnProvider();
    const a = callMeta(p, 'eng.1/scoreboard?dates=202609', false);
    const b = callMeta(p, 'eng.1/scoreboard?dates=202609', false);
    await Promise.all([a, b]);
    expect(f.calls).toHaveLength(1);
    const later = callMeta(p, 'eng.1/scoreboard?dates=202609', false);
    await later;
    expect(f.calls).toHaveLength(2);
  });

  it('retain:true és retain:false ugyanarra a címre nem keveredik (a retain:false nem okozhat cache-írást)', async () => {
    const f = gatedFetch();
    const p = new EspnProvider();
    const keep = callMeta(p, 'eng.1/scoreboard?dates=202609', true);
    const drop = callMeta(p, 'eng.1/scoreboard?dates=202609', false);
    await Promise.all([keep, drop]);
    expect(f.calls).toHaveLength(2);
  });

  it('sikertelen lekérés: a párhuzamos hívók egy kérést osztanak, de a hiba nem ragad be – a következő hívás újra próbál', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = gatedFetch(503);
    const p = new EspnProvider();
    const a = callMeta(p, 'eng.1/teams');
    const b = callMeta(p, 'eng.1/teams');
    expect(await Promise.all([a, b])).toEqual([null, null]);
    expect(f.calls).toHaveLength(1);
    const retry = callMeta(p, 'eng.1/teams');
    expect(await retry).toBeNull();
    expect(f.calls).toHaveLength(2);
  });
});
