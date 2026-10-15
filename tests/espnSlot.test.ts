/**
 * Az ESPN-kliens párhuzamossági korlátja (legfeljebb 4 egyidejű kérés).
 *
 * Hibás eset (javítás előtt): a release() csökkentette a számlálót, majd felébresztette a várakozót,
 * amely csak egy mikrotaszkkal később növelte vissza. A kettő között érkező új slot() hívás látott
 * egy szabad helyet és azonnal elindult – a várakozó ébredése után 5 kérés futott egyszerre.
 * Javítás: a felszabaduló hely közvetlenül a várakozóé, a számláló közben nem csökken.
 */
import { describe, expect, it } from 'vitest';
import { EspnProvider } from '../src/server/data/espnProvider';

type Slots = { slot(): Promise<void>; release(): void; inflight: number };

describe('EspnProvider – legfeljebb 4 egyidejű ESPN-kérés', () => {
  it('a felszabaduló hely a várakozóé: a release() utáni azonnali új kérés nem előzheti meg, és nem lesz 5 futó kérés', async () => {
    const p = new EspnProvider() as unknown as Slots;
    for (let i = 0; i < 4; i++) await p.slot();
    expect(p.inflight).toBe(4);

    let fifthStarted = false, sixthStarted = false;
    const fifth = p.slot().then(() => { fifthStarted = true; });
    p.release(); // az egyik futó kérés véget ér…
    const sixth = p.slot().then(() => { sixthStarted = true; }); // …és UGYANABBAN a tickben új kérés érkezik
    await fifth;

    expect(fifthStarted).toBe(true);
    expect(p.inflight).toBe(4); // javítás előtt: 5
    await Promise.resolve();
    expect(sixthStarted).toBe(false); // a 6. vár, amíg újabb hely fel nem szabadul

    p.release();
    await sixth;
    expect(sixthStarted).toBe(true);
    expect(p.inflight).toBe(4);
    for (let i = 0; i < 4; i++) p.release();
    expect(p.inflight).toBe(0);
  });
});
