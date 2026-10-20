/**
 * 2D meccsanimáció – TISZTA logika (DOM és Canvas nélkül, tesztelhető).
 *
 * SZEMLÉLTETÉS, NEM ELŐREJELZÉS: az eseményeket a szerver által adott végeredményhez (a szimuláció
 * legvalószínűbb pontos eredményéhez) igazítva generáljuk le előre, determinisztikusan. A pályán látható
 * gólok száma MINDIG pontosan a végeredmény; a nem gólos helyzetek száma a várható gólokhoz igazodik.
 * Új valószínűséget nem számol, a Monte Carlo-modellhez nem nyúl.
 *
 * Koordináták méterben: a pálya 105 × 68; a hazai csapat balról jobbra (x → 105) támad.
 */
export const PITCH = { w: 105, h: 68 } as const;
export const GOAL = { top: 30.34, bottom: 37.66 } as const;
export const DEFAULT_DURATION_MS = 45_000;
const MAX_EVENTS = 12;

export type Side = 'home' | 'away';
export type EventKind = 'goal' | 'save' | 'miss';
export interface Pt { x: number; y: number }

export interface MatchEvent {
  /** játékperc (1–90) */
  minute: number;
  /** a lejátszás ideje, amikor a lövés célba ér (ms) */
  atMs: number;
  /** a támadás kezdete (ms) – innen fut a labdakihozatal */
  startMs: number;
  /** a kimenetel animációjának vége (ms) */
  endMs: number;
  team: Side;
  kind: EventKind;
  /** a labda útja: passzok → lövés helye → célpont (gól: a hálóban; védés: a kapusnál; mellé: kapu mellett) */
  path: Pt[];
  /** melyik játékos (index) kapja az adott útpontnál a labdát */
  carriers: number[];
  /** az esemény UTÁNI állás */
  score: [number, number];
}

export interface Timeline {
  durationMs: number;
  final: [number, number];
  events: MatchEvent[];
  seed: number;
}

/** „2–1” vagy „2-1” → [2, 1]; minden más (üres, negatív, 9-nél nagyobb) → null. */
export function parseScore(s: string | null | undefined): [number, number] | null {
  const m = typeof s === 'string' ? s.trim().match(/^(\d)\s*[–-]\s*(\d)$/) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** 4-4-2 alapállás a hazai csapatnak (balról jobbra támad); 0 = kapus. */
const BASE: Pt[] = [
  { x: 4, y: 34 },
  { x: 20, y: 10 }, { x: 18, y: 26 }, { x: 18, y: 42 }, { x: 20, y: 58 },
  { x: 40, y: 12 }, { x: 37, y: 28 }, { x: 37, y: 40 }, { x: 40, y: 56 },
  { x: 55, y: 27 }, { x: 55, y: 41 },
];
export const mirror = (p: Pt): Pt => ({ x: PITCH.w - p.x, y: PITCH.h - p.y });
/** a csapat alapállása a saját támadási irányában */
export const baseFor = (side: Side, i: number): Pt => (side === 'home' ? BASE[i] : mirror(BASE[i]));
/** támadó irányú x: hazainál x, vendégnél tükrözve */
const dirX = (side: Side, x: number) => (side === 'home' ? x : PITCH.w - x);

export interface TimelineInput {
  score: [number, number];
  /** a szimulált várható gólok – a nem gólos helyzetek számához */
  expectedGoals: { home: number; away: number };
  seedKey: string;
  durationMs?: number;
}

export function generateTimeline(inp: TimelineInput): Timeline {
  const durationMs = inp.durationMs ?? DEFAULT_DURATION_MS;
  const seed = hash(`${inp.seedKey}|${inp.score.join('-')}`);
  const r = rng(seed);
  const [hg, ag] = inp.score;

  // helyzetek: a gólok MIND; plusz a várható gólokhoz igazodó védések/mellélövések (legfeljebb MAX_EVENTS)
  const chances = (xg: number, goals: number) => Math.max(goals, Math.min(6, Math.round(xg * 3)));
  const items: { team: Side; kind: EventKind }[] = [];
  for (let i = 0; i < hg; i++) items.push({ team: 'home', kind: 'goal' });
  for (let i = 0; i < ag; i++) items.push({ team: 'away', kind: 'goal' });
  const extra: { team: Side; kind: EventKind }[] = [];
  for (const [team, xg, g] of [['home', inp.expectedGoals.home, hg], ['away', inp.expectedGoals.away, ag]] as const) {
    for (let i = g; i < chances(xg, g); i++) extra.push({ team, kind: r() < 0.55 ? 'save' : 'miss' });
  }
  while (items.length < MAX_EVENTS && extra.length) items.push(extra.splice(Math.floor(r() * extra.length), 1)[0]);
  // keverés (Fisher–Yates)
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }

  const n = items.length;
  const msPerMin = durationMs / 90;
  const events: MatchEvent[] = [];
  let h = 0, a = 0;
  // egyenletes időrések (az első a kezdőrúgás után): minden támadásnak elég idő jut a labdakihozatalra,
  // a résen belül véletlen eltolással – nincs átfedés, és minden esemény a lejátszáson belül marad
  const slotMs = (durationMs - 1300) / Math.max(1, n);
  items.forEach((it, i) => {
    const pre = clamp(slotMs * 0.62, 600, 2600);
    const post = Math.min(it.kind === 'goal' ? 1500 : 800, slotMs * 0.33);
    const free = Math.max(0, slotMs - pre - post);
    const startMs = 900 + i * slotMs + r() * free * 0.8;
    const atMs = startMs + pre;
    const endMs = atMs + post;
    const minute = Math.min(90, Math.max(1, Math.ceil(atMs / msPerMin)));
    if (it.kind === 'goal') { if (it.team === 'home') h++; else a++; }

    // labdakihozatal: védő → középpályás → középpályás → csatár (a lövő), előretolt pozíciókban
    const s = it.team;
    const carriers = [1 + Math.floor(r() * 4), 5 + Math.floor(r() * 4), 5 + Math.floor(r() * 4), 9 + Math.floor(r() * 2)];
    // a passz oda megy, ahol a fogadó a csapatblokk eltolásával (labda felé + támadó-előretolás) amúgy is áll:
    // x = alap + (x − 52,5)·0,55 + 8  →  x = (alap − 20,875) / 0,45 – így a fogadónak csak keveset kell igazítania
    const settle = (bx: number) => clamp((bx - 20.875) / 0.45, 12, 72);
    const path: Pt[] = carriers.map((c, k) => {
      const b = baseFor(s, c);
      return k < 3 ? { x: dirX(s, settle(BASE[c].x)), y: b.y } : { x: dirX(s, 80 + r() * 6), y: 24 + r() * 20 };
    });
    const gy = GOAL.top + 0.8 + r() * (GOAL.bottom - GOAL.top - 1.6);
    if (it.kind === 'goal') path.push({ x: dirX(s, PITCH.w + 1.2), y: gy });
    else if (it.kind === 'save') { path.push({ x: dirX(s, PITCH.w - 1.5), y: gy }); path.push({ x: dirX(s, PITCH.w - 9), y: gy + (r() < 0.5 ? -9 : 9) }); }
    else path.push({ x: dirX(s, PITCH.w + 1.5), y: r() < 0.5 ? GOAL.top - 2.5 - r() * 3 : GOAL.bottom + 2.5 + r() * 3 });
    events.push({ minute, atMs, startMs, endMs, team: s, kind: it.kind, path, carriers, score: [h, a] });
  });
  return { durationMs, final: [hg, ag], events, seed };
}

// ---------------------------------------------------------------------------
// Képkocka egy adott időpontban
// ---------------------------------------------------------------------------

export interface Frame {
  minute: number;
  score: [number, number];
  ball: Pt;
  home: Pt[];
  away: Pt[];
  possession: Side;
  overlay: { text: string; team: Side } | null;
  finished: boolean;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
/** smoothstep: folytonos sebesség, a csúcs az átlag 1,5-szerese (a mozgás nem „rántós”) */
const ease = (t: number) => t * t * (3 - 2 * t);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** pont egy útvonalon, egyenletes szakaszidőkkel (0 ≤ t ≤ 1) */
function along(path: Pt[], t: number): { p: Pt; seg: number; local: number } {
  const segs = path.length - 1;
  const f = clamp(t, 0, 1) * segs;
  const seg = Math.min(segs - 1, Math.floor(f));
  const local = f - seg;
  return { p: lerp(path[seg], path[seg + 1], ease(local)), seg, local };
}

const CENTRE: Pt = { x: PITCH.w / 2, y: PITCH.h / 2 };
const IDLE_PASS_MS = 900;
/** a támadó-eltolás átváltásának ideje labdabirtoklás-váltáskor */
const POSSESSION_BLEND_MS = 1000;
/** a csapatblokk időbeli simítása: ennyi minta, ilyen távolságra visszafelé (≈ 0,8 s ablak) */
const SMOOTH_SAMPLES = 20;
const SMOOTH_STEP_MS = 40;

/** a labda helyzete nyugodt labdabirtoklásban – az előző esemény végpontjából folytatva (nincs teleport) */
function idleBall(tl: Timeline, t: number): { ball: Pt; possession: Side; from: number; prevTeam: Side | null } {
  let last: MatchEvent | null = null;
  for (const e of tl.events) if (e.endMs <= t) last = e;
  const next = tl.events.find((e) => e.startMs > t) ?? null;
  const possession: Side = next ? next.team : last && last.team === 'home' ? 'away' : 'home';
  const from = last ? last.endMs : 0;
  const lastPt = last ? last.path[last.path.length - 1] : CENTRE;
  const pick = (j: number): Pt => {
    if (j === 0) return lastPt; // ahol a labda az előző esemény végén volt (hálóban, kapusnál, alapvonalon túl)
    if (j === 1 && (!last || last.kind === 'goal')) return CENTRE; // gól után: vissza középre, kezdőrúgás
    if (j === 1) return { x: clamp(lastPt.x, 6, PITCH.w - 6), y: clamp(lastPt.y, 6, PITCH.h - 6) }; // kirúgás / kidobás
    return baseFor(possession, 2 + (hash(`${tl.seed}|${from}|${j}`) % 7)); // védők és középpályások között
  };
  const k = Math.floor((t - from) / IDLE_PASS_MS);
  const local = ((t - from) % IDLE_PASS_MS) / IDLE_PASS_MS;
  const ball = !last && t < IDLE_PASS_MS ? CENTRE : lerp(pick(k), pick(k + 1), ease(local));
  return { ball, possession, from, prevTeam: last ? last.team : null };
}

interface RawState {
  ball: Pt;
  possession: Side;
  /** a hazai csapat „támadó” mértéke (0–1), labdabirtoklás-váltáskor folytonosan átvált */
  homeAttack: number;
  ev: MatchEvent | null;
  /** passzfogadók: folytonos súllyal húzódnak a labda útpontja felé */
  pulls: { side: Side; idx: number; to: Pt; w: number }[];
  /** védésnél a kapus kimozdulása (folytonos súllyal) */
  keeper: { side: Side; y: number; w: number } | null;
}

function rawAt(tl: Timeline, tMs: number): RawState {
  const t = clamp(tMs, 0, tl.durationMs);
  const ev = tl.events.find((e) => t >= e.startMs && t <= e.endMs) ?? null;
  if (!ev) {
    const idle = idleBall(tl, t);
    const target = idle.possession === 'home' ? 1 : 0;
    const prev = idle.prevTeam ? (idle.prevTeam === 'home' ? 1 : 0) : target;
    const homeAttack = prev + (target - prev) * ease(clamp((t - idle.from) / POSSESSION_BLEND_MS, 0, 1));
    return { ball: idle.ball, possession: idle.possession, homeAttack, ev: null, pulls: [], keeper: null };
  }
  // a támadás onnan indul, ahol a labda közvetlenül a kezdete ELŐTT volt (ugyanazzal a labdabirtoklással)
  const before = idleBall(tl, ev.startMs - 0.001);
  // nincs visszafelé passz: a labda aktuális helyénél hátrébb lévő útpontokat kihagyjuk (a lövő mindig marad)
  const fwd = (p: Pt) => (ev.team === 'home' ? p.x : PITCH.w - p.x);
  const nc = ev.carriers.length;
  const keep = [0];
  for (let j = 1; j < nc - 1; j++) if (fwd(ev.path[j]) > fwd(keep.length > 1 ? ev.path[keep[keep.length - 1]] : before.ball) + 4) keep.push(j);
  keep.push(nc - 1);
  const build = keep.map((j) => (j === 0 ? before.ball : ev.path[j]));
  const carriers = keep.map((j) => ev.carriers[j]);
  // a támadó-eltolás átváltása folytatódik (nem szakad meg az esemény kezdetén)
  const attTarget = ev.team === 'home' ? 1 : 0;
  const attPrev = before.prevTeam ? (before.prevTeam === 'home' ? 1 : 0) : attTarget;
  const homeAttack = attPrev + (attTarget - attPrev) * ease(clamp((t - before.from) / POSSESSION_BLEND_MS, 0, 1));
  const segs = build.length - 1;
  const pulls: RawState['pulls'] = [];
  const shotFrom = build[segs];
  const target = ev.path[nc];
  let ball: Pt;
  if (t < ev.atMs) {
    // a lövésre legalább ~280 ms jut (rövid, zsúfolt támadásnál is látható), de legfeljebb a támadás fele
    const pre = ev.atMs - ev.startMs;
    const shotMs = Math.min(pre * 0.5, Math.max(pre * 0.22, 280));
    const buildEnd = ev.atMs - shotMs;
    const shooting = t >= buildEnd;
    const shotProg = shooting ? (t - buildEnd) / shotMs : 0;
    const buildProg = shooting ? 1 : (t - ev.startMs) / (buildEnd - ev.startMs);
    ball = shooting ? lerp(shotFrom, target, ease(shotProg)) : along(build, buildProg).p;
    // j. fogadó: a hozzá futó passz alatt 0 → 1, a továbbpassz alatt 1 → 0 (a lövőnél a lövés alatt)
    const f = buildProg * segs;
    for (let j = 1; j <= segs; j++) {
      let w = f < j - 1 ? 0 : f < j ? ease(f - (j - 1)) : j < segs ? 1 - ease(Math.min(1, f - j)) : 1;
      if (j === segs && shooting) w = 1 - ease(shotProg);
      if (w > 0) pulls.push({ side: ev.team, idx: carriers[j], to: build[j], w });
    }
  } else {
    const after = ev.path.slice(nc);
    const prog = (t - ev.atMs) / (ev.endMs - ev.atMs);
    ball = ev.kind === 'save' && after.length > 1 ? lerp(after[0], after[1], ease(clamp(prog * 1.6, 0, 1))) : after[0];
  }
  let keeper: RawState['keeper'] = null;
  if (ev.kind === 'save') {
    const w = t < ev.atMs ? ease(clamp((t - ev.startMs) / (ev.atMs - ev.startMs), 0, 1)) : 1 - ease(clamp((t - ev.atMs) / (ev.endMs - ev.atMs), 0, 1));
    keeper = { side: ev.team === 'home' ? 'away' : 'home', y: target.y, w };
  }
  return { ball, possession: ev.team, homeAttack, ev, pulls, keeper };
}

/** a csapatok célpozíciói egy időpontban: a labda felé tolódó blokk, támadó-eltolás, finom mozgás */
function teamTargets(tl: Timeline, t: number): { home: Pt[]; away: Pt[]; raw: RawState } {
  const raw = rawAt(tl, t);
  const { ball } = raw;
  const team = (side: Side): Pt[] =>
    BASE.map((_, i) => {
      const b = baseFor(side, i);
      if (i === 0) return { x: side === 'home' ? 2.5 : PITCH.w - 2.5, y: clamp(34 + (ball.y - 34) * 0.25, GOAL.top - 2, GOAL.bottom + 2) };
      const att = side === 'home' ? raw.homeAttack : 1 - raw.homeAttack;
      const shift = (ball.x - PITCH.w / 2) * 0.55 + att * (side === 'home' ? 8 : -8);
      const wob = Math.sin(t / 650 + i * 1.7 + (side === 'home' ? 0 : 2)) * 1.2;
      return { x: clamp(b.x + shift, 3, PITCH.w - 3), y: clamp(b.y + (ball.y - b.y) * 0.18 + wob, 3, PITCH.h - 3) };
    });
  const home = team('home'), away = team('away');
  // passzfogadók és a kapus kimozdulása a célpozíció része → az időbeli simítás ezeket is lágyítja
  for (const pl of raw.pulls) {
    const arr = pl.side === 'home' ? home : away;
    arr[pl.idx] = lerp(arr[pl.idx], pl.to, 0.85 * pl.w);
  }
  if (raw.keeper) {
    const gk = (raw.keeper.side === 'home' ? home : away)[0];
    gk.y += (raw.keeper.y - gk.y) * raw.keeper.w;
  }
  return { home, away, raw };
}

export function frameAt(tl: Timeline, tMs: number): Frame {
  const t = clamp(tMs, 0, tl.durationMs);
  const finished = tMs >= tl.durationMs;
  const minute = finished ? 90 : Math.min(90, Math.floor((t / tl.durationMs) * 90) + 1);
  let score: [number, number] = [0, 0];
  for (const e of tl.events) if (e.kind === 'goal' && e.atMs <= t) score = e.score;
  if (finished) score = tl.final;

  // a játékosok a célpozíciók időbeli (háromszög-súlyozott) átlagát követik → nincs ugrás, életszerű reakció
  const now = teamTargets(tl, t);
  const acc = { home: now.home.map(() => ({ x: 0, y: 0 })), away: now.away.map(() => ({ x: 0, y: 0 })) };
  let wsum = 0;
  for (let k = 0; k < SMOOTH_SAMPLES; k++) {
    const w = SMOOTH_SAMPLES - k;
    const s = k === 0 ? now : teamTargets(tl, t - k * SMOOTH_STEP_MS);
    for (const side of ['home', 'away'] as const) s[side].forEach((p, i) => { acc[side][i].x += p.x * w; acc[side][i].y += p.y * w; });
    wsum += w;
  }
  const home = acc.home.map((p) => ({ x: p.x / wsum, y: p.y / wsum }));
  const away = acc.away.map((p) => ({ x: p.x / wsum, y: p.y / wsum }));
  const raw = now.raw;

  const ev = raw.ev;
  let overlay: Frame['overlay'] = null;
  if (ev && t >= ev.atMs) overlay = { text: ev.kind === 'goal' ? 'GÓL!' : ev.kind === 'save' ? 'Védés!' : 'Mellé!', team: ev.team };
  if (finished) overlay = { text: 'Vége', team: raw.possession };
  return { minute, score, ball: raw.ball, home, away, possession: raw.possession, overlay, finished };
}

// ---------------------------------------------------------------------------
// Vezérlés (indítás / szünet / újrajátszás) – reducer
// ---------------------------------------------------------------------------

export type PlayStatus = 'ready' | 'playing' | 'paused' | 'finished';
export interface PlayState { status: PlayStatus; elapsed: number; durationMs: number }
export type PlayAction = { type: 'play' } | { type: 'pause' } | { type: 'replay' } | { type: 'tick'; dt: number };

export function playReducer(s: PlayState, a: PlayAction): PlayState {
  switch (a.type) {
    case 'play': return s.status === 'finished' ? { ...s, status: 'playing', elapsed: 0 } : { ...s, status: 'playing' };
    case 'pause': return s.status === 'playing' ? { ...s, status: 'paused' } : s;
    case 'replay': return { ...s, status: 'playing', elapsed: 0 };
    case 'tick': {
      if (s.status !== 'playing') return s;
      const elapsed = Math.min(s.durationMs, s.elapsed + Math.max(0, Math.min(a.dt, 250))); // nagy ugrás (háttérfül) nem pörgeti át
      return { ...s, elapsed, status: elapsed >= s.durationMs ? 'finished' : 'playing' };
    }
  }
}
