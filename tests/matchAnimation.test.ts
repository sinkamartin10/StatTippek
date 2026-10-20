/**
 * 2D meccsanimáció: a pályán látható gólok = a végeredmény, eseménysor, képkockák, vezérlés, jogosultság.
 * Tiszta függvények + statikus renderelés (nincs DOM-függőség).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_DURATION_MS, GOAL, PITCH, frameAt, generateTimeline, parseScore, playReducer, type PlayState, type Timeline } from '../src/client/lib/matchAnimation';
import { MatchAnimation } from '../src/client/components/MatchAnimation';
import { SimulatorView } from '../src/client/components/SimulatorCard';
import { previewSimulation, type SimulationReport } from '../src/shared/engine/simulator';

const SCORES: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [1, 3], [3, 3], [5, 4], [0, 6], [9, 9]];
const XG = [{ home: 0.4, away: 0.3 }, { home: 1.6, away: 1.1 }, { home: 3.2, away: 2.5 }];
const all = (fn: (tl: Timeline, score: [number, number]) => void) => {
  for (const score of SCORES) for (const xg of XG) for (const seedKey of ['m1', 'espn-x-401915395']) fn(generateTimeline({ score, expectedGoals: xg, seedKey }), score);
};

describe('Végeredmény = a pályán látható gólok', () => {
  it('a gól-események száma csapatonként pontosan a végeredmény; az utolsó gól utáni állás = a végeredmény', () => {
    all((tl, [h, a]) => {
      const goals = tl.events.filter((e) => e.kind === 'goal');
      expect(goals.filter((e) => e.team === 'home').length).toBe(h);
      expect(goals.filter((e) => e.team === 'away').length).toBe(a);
      expect(tl.final).toEqual([h, a]);
      expect(goals.length ? goals[goals.length - 1].score : [0, 0]).toEqual([h, a]);
    });
  });

  it('az eredményjelző menet közben monoton nő, és a végén pontosan a végeredményt mutatja (90. perc, vége)', () => {
    all((tl, score) => {
      let prev: [number, number] = [0, 0];
      for (let t = 0; t <= tl.durationMs; t += 250) {
        const f = frameAt(tl, t);
        expect(f.score[0]).toBeGreaterThanOrEqual(prev[0]);
        expect(f.score[1]).toBeGreaterThanOrEqual(prev[1]);
        expect(f.minute).toBeGreaterThanOrEqual(1);
        expect(f.minute).toBeLessThanOrEqual(90);
        prev = f.score;
      }
      const end = frameAt(tl, tl.durationMs);
      expect(end.finished).toBe(true);
      expect(end.minute).toBe(90);
      expect(end.score).toEqual(score);
    });
  });

  it('gólnál a labda a kapuban van (a kapufák között, a gólvonal mögött); védésnél és mellélövésnél nem', () => {
    all((tl) => {
      for (const e of tl.events) {
        const at = frameAt(tl, e.atMs);
        const inGoal = (at.ball.x > PITCH.w || at.ball.x < 0) && at.ball.y > GOAL.top && at.ball.y < GOAL.bottom;
        if (e.kind === 'goal') {
          expect(inGoal).toBe(true);
          expect(e.team === 'home' ? at.ball.x > PITCH.w : at.ball.x < 0).toBe(true); // a megfelelő kapuba
          expect(at.overlay?.text).toBe('GÓL!');
          expect(frameAt(tl, e.atMs).score).toEqual(e.score);
          expect(frameAt(tl, e.atMs - 1).score).not.toEqual(e.score);
        } else {
          for (let t = e.atMs; t <= e.endMs; t += 50) {
            const f = frameAt(tl, t);
            expect((f.ball.x > PITCH.w || f.ball.x < 0) && f.ball.y > GOAL.top && f.ball.y < GOAL.bottom).toBe(false);
          }
        }
      }
    });
  });
});

describe('Eseménysor és képkockák', () => {
  it('30–60 mp, az események időrendben, átfedés nélkül, a lejátszáson belül; legfeljebb 12 esemény; determinisztikus', () => {
    expect(DEFAULT_DURATION_MS).toBeGreaterThanOrEqual(30_000);
    expect(DEFAULT_DURATION_MS).toBeLessThanOrEqual(60_000);
    all((tl, [h, a]) => {
      expect(tl.events.length).toBeLessThanOrEqual(Math.max(12, h + a));
      let prevEnd = 0, prevMin = 0;
      for (const e of tl.events) {
        expect(e.startMs).toBeGreaterThanOrEqual(prevEnd);
        expect(e.startMs).toBeLessThan(e.atMs);
        expect(e.atMs).toBeLessThan(e.endMs);
        expect(e.minute).toBeGreaterThanOrEqual(prevMin);
        prevEnd = e.endMs; prevMin = e.minute;
      }
      expect(prevEnd).toBeLessThanOrEqual(tl.durationMs); // minden esemény (gól) a lejátszáson belül látható
    });
    const a = generateTimeline({ score: [2, 1], expectedGoals: XG[1], seedKey: 'x' });
    expect(generateTimeline({ score: [2, 1], expectedGoals: XG[1], seedKey: 'x' })).toEqual(a);
    // a nem gólos helyzetek a várható gólokhoz igazodnak: több xG → több helyzet
    const lo = generateTimeline({ score: [1, 1], expectedGoals: XG[0], seedKey: 'x' }).events.length;
    const hi = generateTimeline({ score: [1, 1], expectedGoals: XG[2], seedKey: 'x' }).events.length;
    expect(hi).toBeGreaterThan(lo);
  });

  it('11–11 játékos a pályán, a labda mozog, a támadásban passzok (több útpont) és lövés van', () => {
    const tl = generateTimeline({ score: [2, 1], expectedGoals: XG[1], seedKey: 'p' });
    const seen = new Set<string>();
    for (let t = 0; t <= tl.durationMs; t += 400) {
      const f = frameAt(tl, t);
      expect(f.home.length).toBe(11);
      expect(f.away.length).toBe(11);
      for (const p of [...f.home, ...f.away]) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(PITCH.w); expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(PITCH.h); }
      seen.add(`${f.ball.x.toFixed(1)},${f.ball.y.toFixed(1)}`);
    }
    expect(seen.size).toBeGreaterThan(50);
    for (const e of tl.events) expect(e.path.length).toBeGreaterThanOrEqual(5); // 4 labdaérintés + célpont
  });

  it('sima mozgás 60 fps-nél (16 ms): nincs ugrás és nincs rángatás (hirtelen sebességváltás); a labda sem teleportál – gól után sem', () => {
    let worstP = 0, worstAcc = 0, worstB = 0;
    all((tl) => {
      let prev = frameAt(tl, 0);
      const vel = new Map<string, { x: number; y: number }>();
      for (let t = 16; t <= tl.durationMs; t += 16) {
        const f = frameAt(tl, t);
        for (const side of ['home', 'away'] as const) f[side].forEach((p, i) => {
          const v = { x: p.x - prev[side][i].x, y: p.y - prev[side][i].y };
          worstP = Math.max(worstP, Math.hypot(v.x, v.y));
          const pv = vel.get(side + i);
          if (pv) worstAcc = Math.max(worstAcc, Math.hypot(v.x - pv.x, v.y - pv.y));
          vel.set(side + i, v);
        });
        worstB = Math.max(worstB, Math.hypot(f.ball.x - prev.ball.x, f.ball.y - prev.ball.y));
        prev = f;
      }
    });
    // a javítás előtt: egy játékos egy képkocka alatt akár 48,8 m-t ugrott (labda-teleport, birtoklásváltás, passzfogadó, kapus)
    expect(worstP).toBeLessThan(2);
    expect(worstAcc).toBeLessThan(0.6);
    expect(worstB).toBeLessThan(3.5);
  });

  it('parseScore: csak érvényes pontos eredményt fogad el', () => {
    expect(parseScore('2–1')).toEqual([2, 1]);
    expect(parseScore('0-0')).toEqual([0, 0]);
    for (const bad of ['', '10–1', '2:1', 'a–b', null, undefined, '-1–0']) expect(parseScore(bad as string)).toBeNull();
  });
});

describe('Vezérlés (indítás / szünet / újrajátszás)', () => {
  const s0: PlayState = { status: 'ready', elapsed: 0, durationMs: 1000 };
  it('lejátszás, szünet, folytatás, vége, újra; a háttérben eltelt nagy idő nem pörgeti át', () => {
    let s = playReducer(s0, { type: 'tick', dt: 100 });
    expect(s.elapsed).toBe(0); // indítás előtt nem halad
    s = playReducer(s, { type: 'play' });
    expect(s.status).toBe('playing');
    s = playReducer(s, { type: 'tick', dt: 200 });
    expect(s.elapsed).toBe(200);
    s = playReducer(s, { type: 'pause' });
    s = playReducer(s, { type: 'tick', dt: 200 });
    expect(s).toMatchObject({ status: 'paused', elapsed: 200 });
    s = playReducer(s, { type: 'play' });
    s = playReducer(s, { type: 'tick', dt: 10_000 });
    expect(s.elapsed).toBe(450); // legfeljebb 250 ms / tick
    for (let i = 0; i < 10; i++) s = playReducer(s, { type: 'tick', dt: 200 });
    expect(s).toMatchObject({ status: 'finished', elapsed: 1000 });
    expect(playReducer(s, { type: 'play' })).toMatchObject({ status: 'playing', elapsed: 0 });
    expect(playReducer({ ...s, status: 'paused', elapsed: 600 }, { type: 'replay' })).toMatchObject({ status: 'playing', elapsed: 0 });
  });
});

describe('Felület és jogosultság', () => {
  const base: SimulationReport = {
    matchId: 'm1', simulator: 'mc-poisson-lognormal-1', modelId: 'xg-poisson-1', modelLabel: 'Alap motor', status: 'ok', reasons: [],
    freshness: { generatedAt: '2026-10-20T10:00:00Z', newestResultDate: '2026-10-18T10:00:00Z', daysBeforeKickoff: 3, stale: false },
    uncertainty: { level: 'közepes', reasons: ['x'] }, oneXTwo: { home: 0.47, draw: 0.28, away: 0.25, pct: { home: 47, draw: 28, away: 25 } }, mostLikely: '1',
    full: {
      n: 10000, seed: 1, inputs: { homeLambda: 1.6, awayLambda: 1.1, sdHome: 0.2, sdAway: 0.2, sdSource: 'sample' },
      expectedGoals: { home: 1.6, away: 1.1, total: 2.7 }, overUnder: [{ line: 2.5, over: 0.5, under: 0.5 }], btts: { yes: 0.5, no: 0.5 },
      teamOver05: { home: 0.8, away: 0.7 }, topScores: [{ score: '1–1', prob: 0.12 }, { score: '2–1', prob: 0.1 }], totalGoals80: [1, 4], standardError: 0.005, explanation: ['e'],
    },
  };
  const render = (s: SimulationReport, pro: boolean) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SimulatorView, { s, homeName: 'Como', awayName: 'Man United', pro })));

  it('PRO (teljes szerverválasz): indítható animáció a legvalószínűbb pontos eredménnyel', () => {
    const out = render(base, true);
    expect(out).toContain('data-anim-launch');
    expect(out).toContain('Meccs-animáció (1–1)');
  });

  it('FREE előnézet: nincs animáció és nincs végeredmény a markupban; hiányos adat / érvénytelen eredmény: nincs indítás', () => {
    const free = render(previewSimulation(base), false);
    expect(free).not.toContain('data-anim');
    expect(free).not.toContain('1–1');
    expect(free).toContain('2D meccs-animáció');
    const none = render({ ...base, status: 'insufficient', oneXTwo: null, mostLikely: null, uncertainty: null, full: undefined, reasons: ['kevés meccs'] }, true);
    expect(none).not.toContain('data-anim');
    const bad = render({ ...base, full: { ...base.full!, topScores: [] } }, true);
    expect(bad).not.toContain('data-anim-launch');
    expect(bad).toContain('nem indítható');
  });

  it('a lejátszó kezdőállapota: 0–0, 1. perc, Lejátszás gomb, a végeredmény jelölve, szemléltetés-figyelmeztetés', () => {
    const out = renderToStaticMarkup(createElement(MatchAnimation, { score: [2, 1], expectedGoals: { home: 1.6, away: 1.1 }, seedKey: 'm1', homeName: 'Como', awayName: 'Man United' }));
    expect(out).toContain('data-anim-final="2-1"');
    expect(out).toMatch(/data-anim-score="?[^>]*>0 – 0</);
    expect(out).toContain("1&#x27;");
    expect(out).toContain('data-anim-control="play"');
    expect(out).not.toContain('data-anim-control="replay"');
    expect(out).toContain('nem előrejelzés');
    expect(out).toContain('<canvas');
  });
});
