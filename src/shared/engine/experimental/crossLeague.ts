/**
 * Több sorozatot összekapcsoló, hierarchikus, regularizált támadó/védekező erősség –
 * `xs-strength-1`. A PRO-elemzéseket szolgálja ki (src/server/model/xsService.ts), ha az
 * adatminőség engedi; az `xg-poisson-1` kimenetét NEM módosítja (az a FREE és a visszaesés
 * motorja marad). Automatikus előléptetés nincs. Validáció: scripts/crossLeagueBacktest.ts.
 *
 * Modell (Dixon–Coles-típusú, korreláció nélkül):
 *   log λ_hazai = μ + h + att(hazai) − def(vendég)
 *   log λ_vendég = μ     + att(vendég) − def(hazai)
 *   att(i) = A[g(i)] + a_i,  def(i) = D[g(i)] + d_i
 * ahol g(i) a csapat csoportja (a tanítóablakban legtöbbet játszott HAZAI
 * bajnoksága; ha nincs ilyen: „csak nemzetközi kupa” vagy „válogatott”).
 *   - a_i, d_i ~ N(0, σ_team²): a csapat a CSOPORTJA szintje felé húzódik (kis minta → csoportátlag),
 *   - A_g, D_g ~ N(0, σ_group²): a csoport a globális szint felé húzódik (kevés liga-adat → óvatos kiindulás).
 * A ligák közti szintkülönbséget a csapatok közös paraméterei kötik össze: a
 * nemzetközi kupameccsek és a ligák között mozgó (feljutó/kieső) csapatok. A
 * ligaerősség így EGYSZER, a paraméterezésben szerepel – nincs külön liga-szorzó,
 * amit még egyszer rá lehetne számolni.
 *
 * Súlyozás: w = 0,5^(eltelt napok / felezési idő). A felezési időt és a σ-kat a
 * validációs időszak választja (nem önkényes konstans). Versenysorozat szerinti
 * külön súlyt NEM használunk: a sorozat hatását a csoport-paraméterek hordozzák.
 *
 * Bizonytalanság: a Laplace-közelítés (a log-poszterior diagonális Hessije)
 * paraméter-szórásait a valószínűségekbe is beépítjük (Gauss–Hermite keverék),
 * így kevés adatnál szélesebb, óvatosabb eloszlás jön ki – nem hamis pontosság.
 */
import { poissonPmf } from '../models';
import type { PoissonResult } from '../../types';

export const XS_MODEL_ID = 'xs-strength-1';
/**
 * A modell állapota: a PRO-elemzéseket szolgálja ki (kézi döntéssel élesítve), ha a validált
 * adatminőségi kategória nem „elégtelen”; minden más esetben az alap motor (xg-poisson-1).
 * Automatikus előléptetés vagy paraméter-hangolás élesben nincs.
 */
export const XS_MODEL_STATUS = 'pro' as const;

/** Sorozattípus: hazai bajnokság, nemzetközi klubkupa vagy válogatott. */
export type CompetitionKind = 'domestic' | 'club_intl' | 'national';

export interface XsMatch {
  id: string;
  /** a kezdés ideje (ISO) */
  date: string;
  competitionId: string;
  homeTeamId: string;
  awayTeamId: string;
  /** rendes játékidős (90 perces) végeredmény */
  homeGoals: number;
  awayGoals: number;
}

export interface XsParams {
  halfLifeDays: number;
  sigmaTeam: number;
  sigmaGroup: number;
  /** legfeljebb ennyi teljes paraméter-kör (alapértelmezés 1000; a rosszul kondicionált idény eleji becslésekhez is elég) */
  maxSweeps?: number;
  /** leállás, ha a legnagyobb log-paraméter-változás ez alá esik (alapértelmezés 1e-4 = a várható gól 0,01%-a) */
  tol?: number;
}

export const INTL_ONLY_GROUP = 'csoport:csak-nemzetkozi-kupa';
export const NATIONAL_GROUP = 'csoport:valogatott';

interface Param { value: number; precisionPrior: number; obsIdx: number[]; signs: number[] }

/** A becsült modell egy adott időpontban (csak a cutoff előtt lezárt meccsekből). */
export interface XsFit {
  params: XsParams;
  cutoff: string;
  trainedMatches: number;
  mu: number;
  home: number;
  /** csapat → csoport */
  groupOf: Map<string, string>;
  att: Map<string, number>;
  def: Map<string, number>;
  attVar: Map<string, number>;
  defVar: Map<string, number>;
  groupAtt: Map<string, number>;
  groupDef: Map<string, number>;
  groupAttVar: Map<string, number>;
  groupDefVar: Map<string, number>;
  /** a csapat súlyozott meccsszáma a tanítóablakban (hatásos mintanagyság) */
  nEff: Map<string, number>;
  /** a csapat súlyozatlan meccsszáma a tanítóablakban */
  nRaw: Map<string, number>;
  sweeps: number;
}

const DAY = 86_400_000;

/**
 * Csoport-hozzárendelés: a csapat a tanítóablakban (súlyozva) legtöbbet játszott
 * HAZAI bajnoksága; ha egyáltalán nincs hazai bajnoki meccse, akkor a
 * „csak nemzetközi kupa” vagy a „válogatott” csoport.
 */
export function assignGroups(matches: XsMatch[], kinds: Record<string, CompetitionKind>, weightOf: (m: XsMatch) => number): Map<string, string> {
  const dom = new Map<string, Map<string, number>>();
  const national = new Set<string>();
  const teams = new Set<string>();
  for (const m of matches) {
    const k = kinds[m.competitionId];
    for (const t of [m.homeTeamId, m.awayTeamId]) {
      teams.add(t);
      if (k === 'national') national.add(t);
      if (k === 'domestic') {
        const per = dom.get(t) ?? new Map<string, number>();
        per.set(m.competitionId, (per.get(m.competitionId) ?? 0) + weightOf(m));
        dom.set(t, per);
      }
    }
  }
  const out = new Map<string, string>();
  for (const t of teams) {
    const per = dom.get(t);
    if (per && per.size) {
      // determinisztikus: legnagyobb súly, döntetlennél azonosító szerint
      out.set(t, [...per.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]);
    } else out.set(t, national.has(t) ? NATIONAL_GROUP : INTL_ONLY_GROUP);
  }
  return out;
}

/**
 * A modell becslése a `cutoff` ELŐTT legalább `closedHours` órával kezdődött
 * meccsekből (így csak a cutoffkor már lezárt eredmény számít – nincs szivárgás).
 * `warm`: előző becslés a gyorsabb konvergenciához (az eredményt nem befolyásolja, csak a lépésszámot).
 */
export function fitCrossLeague(
  all: XsMatch[],
  kinds: Record<string, CompetitionKind>,
  cutoff: string,
  params: XsParams,
  opts: { closedHours?: number; warm?: XsFit | null } = {},
): XsFit {
  const cut = Date.parse(cutoff);
  const closedBefore = cut - (opts.closedHours ?? 3) * 3600_000;
  const train = all.filter((m) => Date.parse(m.date) <= closedBefore && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && m.homeTeamId !== m.awayTeamId);
  const weightOf = (m: XsMatch) => Math.pow(0.5, (cut - Date.parse(m.date)) / DAY / params.halfLifeDays);
  const groupOf = assignGroups(train, kinds, weightOf);

  // Megfigyelések: meccsenként kettő (hazai gól, vendég gól)
  const n = train.length * 2;
  const y = new Float64Array(n), w = new Float64Array(n), eta = new Float64Array(n), lam = new Float64Array(n);
  const nEff = new Map<string, number>(), nRaw = new Map<string, number>();
  const params_ = new Map<string, Param>();
  const precTeam = 1 / (params.sigmaTeam ** 2), precGroup = 1 / (params.sigmaGroup ** 2);
  const P = (key: string, prior: number, init = 0): Param => {
    let p = params_.get(key);
    if (!p) { p = { value: init, precisionPrior: prior, obsIdx: [], signs: [] }; params_.set(key, p); }
    return p;
  };
  const warmVal = (key: string): number => {
    const wf = opts.warm;
    if (!wf) return 0;
    if (key === 'mu') return wf.mu;
    if (key === 'home') return wf.home;
    const [kind, id] = [key.slice(0, 2), key.slice(2)];
    return ({ 'a:': wf.att, 'd:': wf.def, 'A:': wf.groupAtt, 'D:': wf.groupDef } as Record<string, Map<string, number>>)[kind]?.get(id) ?? 0;
  };
  const mu = P('mu', 0, opts.warm?.mu ?? Math.log(1.35));
  const home = P('home', 0, opts.warm?.home ?? 0.2);

  train.forEach((m, i) => {
    const wt = weightOf(m);
    for (const t of [m.homeTeamId, m.awayTeamId]) { nEff.set(t, (nEff.get(t) ?? 0) + wt); nRaw.set(t, (nRaw.get(t) ?? 0) + 1); }
    const gh = groupOf.get(m.homeTeamId)!, ga = groupOf.get(m.awayTeamId)!;
    const obs: [number, number, string, string, boolean][] = [
      [2 * i, m.homeGoals, m.homeTeamId, m.awayTeamId, true],
      [2 * i + 1, m.awayGoals, m.awayTeamId, m.homeTeamId, false],
    ];
    for (const [o, goals, attacker, defender, isHome] of obs) {
      y[o] = goals; w[o] = wt;
      const ga_ = attacker === m.homeTeamId ? gh : ga, gd_ = defender === m.homeTeamId ? gh : ga;
      const link: [Param, number][] = [
        [mu, 1],
        [P(`a:${attacker}`, precTeam, warmVal(`a:${attacker}`)), 1],
        [P(`d:${defender}`, precTeam, warmVal(`d:${defender}`)), -1],
        [P(`A:${ga_}`, precGroup, warmVal(`A:${ga_}`)), 1],
        [P(`D:${gd_}`, precGroup, warmVal(`D:${gd_}`)), -1],
      ];
      if (isHome) link.push([home, 1]);
      for (const [p, s] of link) { p.obsIdx.push(o); p.signs.push(s); }
    }
  });

  // η (lineáris prediktor) a kiinduló értékekből
  for (const p of params_.values()) for (let j = 0; j < p.obsIdx.length; j++) eta[p.obsIdx[j]] += p.signs[j] * p.value;
  for (let o = 0; o < n; o++) lam[o] = Math.exp(eta[o]);

  // A paraméterezésben vannak „lapos” irányok, amelyek mentén a likelihood PONTOSAN állandó,
  // csak a büntetés változik (a csoportszint ↔ a csoport csapatai; a konstans ↔ a csoportszintek).
  // A koordinátánkénti lépések ezek mentén nagyon lassan haladnának, ezért minden körben
  // zárt alakban, pontosan optimalizáljuk őket (a λ ettől nem változik).
  const teamsOfGroup = new Map<string, string[]>();
  for (const [t, g] of groupOf) if (params_.has(`a:${t}`)) (teamsOfGroup.get(g) ?? teamsOfGroup.set(g, []).get(g)!).push(t);
  // összefüggő komponensek (unió–keresés a tanítómeccseken); egy csoport a tagjai komponensébe tartozik
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  for (const m of train) for (const t of [m.homeTeamId, m.awayTeamId]) if (!parent.has(t)) parent.set(t, t);
  for (const m of train) { const a = find(m.homeTeamId), b = find(m.awayTeamId); if (a !== b) parent.set(a, b); }
  const compMap = new Map<string, { teams: string[]; groups: Set<string> }>();
  for (const t of parent.keys()) {
    const c = compMap.get(find(t)) ?? compMap.set(find(t), { teams: [], groups: new Set() }).get(find(t))!;
    c.teams.push(t);
    c.groups.add(groupOf.get(t)!);
  }
  // egy csoport csak akkor tolható a komponensével együtt, ha minden tagja abban a komponensben van
  const groupComps = new Map<string, Set<string>>();
  for (const t of parent.keys()) (groupComps.get(groupOf.get(t)!) ?? groupComps.set(groupOf.get(t)!, new Set()).get(groupOf.get(t)!)!).add(find(t));
  const components = [...compMap.values()].map((c) => ({ teams: c.teams, groups: [...c.groups].filter((g) => groupComps.get(g)!.size === 1) }));
  const recenter = (): number => {
    let moved = 0;
    for (const [g, ts] of teamsOfGroup) {
      for (const [G, T] of [['A:', 'a:'], ['D:', 'd:']] as const) {
        const gp = params_.get(`${G}${g}`);
        if (!gp) continue;
        const tps = ts.map((t) => params_.get(`${T}${t}`)!).filter(Boolean);
        // min_δ  precG·(G+δ)²/2 + precT·Σ(t_i−δ)²/2
        const delta = (precTeam * tps.reduce((s, p) => s + p.value, 0) - precGroup * gp.value) / (precGroup + tps.length * precTeam);
        gp.value += delta;
        for (const p of tps) p.value -= delta;
        moved = Math.max(moved, Math.abs(delta));
      }
    }
    // konstans ↔ csoportszintek: minden megfigyelésben pontosan egy A (+) és egy D (−) szerepel
    const As = [...params_].filter(([k]) => k.startsWith('A:')).map(([, p]) => p);
    const Ds = [...params_].filter(([k]) => k.startsWith('D:')).map(([, p]) => p);
    if (As.length) { const m = As.reduce((s, p) => s + p.value, 0) / As.length; for (const p of As) p.value -= m; mu.value += m; moved = Math.max(moved, Math.abs(m)); }
    if (Ds.length) { const m = Ds.reduce((s, p) => s + p.value, 0) / Ds.length; for (const p of Ds) p.value -= m; mu.value -= m; moved = Math.max(moved, Math.abs(m)); }
    // egy összefüggő komponens (egymással valaha játszott csapatok) MINDEN támadása és védekezése
    // együtt eltolva szintén lapos (+a és −d minden megfigyelésben); pl. az MLS vagy a válogatottak
    // külön komponens – ezért komponensenként, csapat- és csoportszinten is pontosan optimalizáljuk
    for (const comp of components) {
      for (const [prefA, prefD, ids] of [['a:', 'd:', comp.teams], ['A:', 'D:', comp.groups]] as const) {
        const ps = ids.map((id) => [params_.get(`${prefA}${id}`), params_.get(`${prefD}${id}`)] as const).filter(([x, y]) => x && y) as [Param, Param][];
        if (!ps.length) continue;
        const m = -ps.reduce((s, [x, y]) => s + x.value + y.value, 0) / (2 * ps.length);
        for (const [x, y] of ps) { x.value += m; y.value += m; }
        moved = Math.max(moved, Math.abs(m));
      }
    }
    return moved;
  };

  // Ciklikus koordináta-Newton a büntetett (log-poszterior) súlyozott Poisson-likelihoodon
  const maxSweeps = params.maxSweeps ?? 1000, tol = params.tol ?? 1e-4;
  const order = [...params_.values()];
  let sweeps = 0;
  for (; sweeps < maxSweeps; sweeps++) {
    let maxStep = recenter();
    for (const p of order) {
      let g = -p.precisionPrior * p.value, hss = p.precisionPrior;
      for (let j = 0; j < p.obsIdx.length; j++) { const o = p.obsIdx[j]; g += w[o] * p.signs[j] * (y[o] - lam[o]); hss += w[o] * lam[o]; }
      if (hss <= 0) continue;
      let step = g / hss;
      if (step > 1) step = 1; else if (step < -1) step = -1; // védőkorlát a korai köröknek
      if (step === 0) continue;
      p.value += step;
      for (let j = 0; j < p.obsIdx.length; j++) { const o = p.obsIdx[j]; eta[o] += p.signs[j] * step; lam[o] = Math.exp(eta[o]); }
      if (Math.abs(step) > maxStep) maxStep = Math.abs(step);
    }
    if (maxStep < tol) { sweeps++; break; }
  }

  // Laplace-diagonális: var ≈ 1 / (Σ w λ + prior-precízió)
  const variance = (p: Param) => {
    let hss = p.precisionPrior;
    for (const o of p.obsIdx) hss += w[o] * lam[o];
    return hss > 0 ? 1 / hss : Infinity;
  };
  const att = new Map<string, number>(), def = new Map<string, number>(), attVar = new Map<string, number>(), defVar = new Map<string, number>();
  const groupAtt = new Map<string, number>(), groupDef = new Map<string, number>(), groupAttVar = new Map<string, number>(), groupDefVar = new Map<string, number>();
  for (const [key, p] of params_) {
    const id = key.slice(2);
    if (key.startsWith('a:')) { att.set(id, p.value); attVar.set(id, variance(p)); }
    else if (key.startsWith('d:')) { def.set(id, p.value); defVar.set(id, variance(p)); }
    else if (key.startsWith('A:')) { groupAtt.set(id, p.value); groupAttVar.set(id, variance(p)); }
    else if (key.startsWith('D:')) { groupDef.set(id, p.value); groupDefVar.set(id, variance(p)); }
  }
  return {
    params, cutoff, trainedMatches: train.length, mu: mu.value, home: home.value, groupOf,
    att, def, attVar, defVar, groupAtt, groupDef, groupAttVar, groupDefVar, nEff, nRaw, sweeps,
  };
}

/** Egy csapat erőssége a becslésből; ismeretlen csapatnál a csoport szintje (a_i = 0) a TELJES prior-szórással. */
function teamStrength(fit: XsFit, teamId: string, fallbackGroup: string) {
  const g = fit.groupOf.get(teamId) ?? fallbackGroup;
  const known = fit.att.has(teamId);
  const s2 = fit.params.sigmaTeam ** 2, g2 = fit.params.sigmaGroup ** 2;
  return {
    group: g,
    known,
    att: (fit.groupAtt.get(g) ?? 0) + (fit.att.get(teamId) ?? 0),
    def: (fit.groupDef.get(g) ?? 0) + (fit.def.get(teamId) ?? 0),
    // a csoport és a csapat bizonytalansága összeadódik (konzervatív: a kovarianciát elhanyagoljuk)
    attVar: (fit.groupAttVar.get(g) ?? g2) + (fit.attVar.get(teamId) ?? s2),
    defVar: (fit.groupDefVar.get(g) ?? g2) + (fit.defVar.get(teamId) ?? s2),
    nEff: fit.nEff.get(teamId) ?? 0,
    nRaw: fit.nRaw.get(teamId) ?? 0,
  };
}

export interface XsPrediction {
  modelId: typeof XS_MODEL_ID;
  lambdaHome: number;
  lambdaAway: number;
  /** a log-ráták szórása (bizonytalanság) */
  sdLogHome: number;
  sdLogAway: number;
  /** összevont bizonytalanság: √(sd_h² + sd_a²) */
  sdLog: number;
  /** a csapatok log-skálájú támadó/védekező ereje (csoportszint + csapatszint) */
  home: { group: string; known: boolean; nEff: number; nRaw: number; att: number; def: number };
  away: { group: string; known: boolean; nEff: number; nRaw: number; att: number; def: number };
  poisson: PoissonResult;
}

/** A sorozatból adódó csoport, ha egy csapat egyáltalán nem szerepel a tanítóadatban. */
export function fallbackGroupFor(competitionId: string, kinds: Record<string, CompetitionKind>): string {
  const k = kinds[competitionId];
  return k === 'domestic' ? competitionId : k === 'national' ? NATIONAL_GROUP : INTL_ONLY_GROUP;
}

// 5 pontos Gauss–Hermite (valószínűségi, standard normálisra normált) csomópontok
const GH_X = [-2.856970013872806, -1.355626179974266, 0, 1.355626179974266, 2.856970013872806];
const GH_W = [0.011257411327720691, 0.22207592200561266, 0.5333333333333333, 0.22207592200561266, 0.011257411327720691];

/** Előrejelzés: a modell-paraméterek bizonytalanságát a gólmátrixba keverjük (Gauss–Hermite). */
export function predictCrossLeague(fit: XsFit, homeTeamId: string, awayTeamId: string, competitionId: string, kinds: Record<string, CompetitionKind>, maxGoals = 8): XsPrediction {
  const fb = fallbackGroupFor(competitionId, kinds);
  const H = teamStrength(fit, homeTeamId, fb), A = teamStrength(fit, awayTeamId, fb);
  const etaH = fit.mu + fit.home + H.att - A.def;
  const etaA = fit.mu + A.att - H.def;
  const sdH = Math.sqrt(H.attVar + A.defVar), sdA = Math.sqrt(A.attVar + H.defVar);
  const mats: { w: number; lh: number; la: number }[] = [];
  for (let i = 0; i < GH_X.length; i++) for (let j = 0; j < GH_X.length; j++) {
    mats.push({ w: GH_W[i] * GH_W[j], lh: Math.exp(etaH + sdH * GH_X[i]), la: Math.exp(etaA + sdA * GH_X[j]) });
  }
  const matrix = Array.from({ length: maxGoals + 1 }, () => new Array<number>(maxGoals + 1).fill(0));
  for (const c of mats) {
    const hp = marginal(c.lh, maxGoals), ap = marginal(c.la, maxGoals);
    for (let h = 0; h <= maxGoals; h++) for (let a = 0; a <= maxGoals; a++) matrix[h][a] += c.w * hp[h] * ap[a];
  }
  return {
    modelId: XS_MODEL_ID,
    lambdaHome: Math.exp(etaH), lambdaAway: Math.exp(etaA),
    sdLogHome: sdH, sdLogAway: sdA, sdLog: Math.sqrt(sdH * sdH + sdA * sdA),
    home: { group: H.group, known: H.known, nEff: H.nEff, nRaw: H.nRaw, att: H.att, def: H.def },
    away: { group: A.group, known: A.known, nEff: A.nEff, nRaw: A.nRaw, att: A.att, def: A.def },
    poisson: poissonResultFromMatrix(matrix),
  };
}

/** Poisson-peremeloszlás 0..maxGoals, a maradék tömeg az utolsó cellában (mint a `poissonModel`-ben). */
function marginal(lambda: number, maxGoals: number): number[] {
  const l = Math.max(0.05, lambda);
  const p: number[] = [];
  for (let i = 0; i <= maxGoals; i++) p.push(poissonPmf(l, i));
  p[maxGoals] += Math.max(0, 1 - p.reduce((a, b) => a + b, 0));
  return p;
}

/**
 * Tetszőleges (pl. keverék) gólmátrixból ugyanaz a kimeneti formátum, mint a
 * `poissonModel`-é – így a kísérleti modell a meglévő piacfüggvényekkel
 * (`marketProbability`) is kiértékelhető. Bizonytalanság nélkül a két függvény
 * kimenete azonos (teszt ellenőrzi).
 */
export function poissonResultFromMatrix(matrix: number[][]): PoissonResult {
  const maxGoals = matrix.length - 1;
  const hp = matrix.map((row) => row.reduce((a, b) => a + b, 0));
  const ap = matrix[0].map((_, a) => matrix.reduce((s, row) => s + row[a], 0));
  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0, ahWin = 0, ahPush = 0, ahLose = 0;
  const totalDist: number[] = new Array(2 * maxGoals + 1).fill(0);
  const scores: { score: string; prob: number }[] = [];
  for (let h = 0; h <= maxGoals; h++) for (let a = 0; a <= maxGoals; a++) {
    const p = matrix[h][a];
    if (h > a) homeWin += p; else if (h === a) draw += p; else awayWin += p;
    if (h > 0 && a > 0) bttsYes += p;
    totalDist[h + a] += p;
    const diff = h - a;
    if (diff > 1) ahWin += p; else if (diff === 1) ahPush += p; else ahLose += p;
    scores.push({ score: `${h}–${a}`, prob: p });
  }
  const over: Record<string, number> = {}, under: Record<string, number> = {};
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    let o = 0;
    totalDist.forEach((p, g) => { if (g > line) o += p; });
    over[String(line)] = o;
    under[String(line)] = 1 - o;
  }
  const dist6 = (arr: number[]) => { const d = arr.slice(0, 5); d.push(arr.slice(5).reduce((a, b) => a + b, 0)); return d; };
  const tail = (arr: number[], from: number) => arr.slice(from).reduce((a, b) => a + b, 0);
  scores.sort((x, y) => y.prob - x.prob);
  return {
    maxGoals, matrix: matrix.map((r) => [...r]),
    homeGoalDist: dist6(hp), awayGoalDist: dist6(ap),
    homeWin, draw, awayWin, over, under, bttsYes, bttsNo: 1 - bttsYes,
    homeOver05: tail(hp, 1), homeOver15: tail(hp, 2), awayOver05: tail(ap, 1), awayOver15: tail(ap, 2),
    doubleChance: { '1X': homeWin + draw, X2: draw + awayWin, '12': homeWin + awayWin },
    drawNoBet: { home: homeWin / (homeWin + awayWin), away: awayWin / (homeWin + awayWin) },
    asianHome1: { win: ahWin, push: ahPush, lose: ahLose },
    correctScores: scores.slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Adatminőségi / bizonytalansági kategóriák
// ---------------------------------------------------------------------------

export type XsQuality = 'elegendo' | 'korlatozott' | 'keves_regularizalt' | 'elegtelen';

export const XS_QUALITY_LABEL: Record<XsQuality, string> = {
  elegendo: 'Elegendő, jó minőségű történeti adat',
  korlatozott: 'Korlátozott, de használható adat',
  keves_regularizalt: 'Kevés adat, erős regularizációval',
  elegtelen: 'Elégtelen vagy megbízhatatlan adat – nem indokolt előrejelzés',
};

/**
 * A küszöböket NEM itt találjuk ki: a validációs időszakból származnak
 * (scripts/crossLeagueBacktest.ts), és a jelentés dokumentálja őket.
 */
export interface XsQualityThresholds {
  /** e bizonytalanság alatt: elegendő */
  sdGood: number;
  /** e alatt: korlátozott */
  sdLimited: number;
  /** e alatt: kevés, regularizált; felette elégtelen */
  sdMax: number;
}

/**
 * Kategória. Ha bármelyik csapatról EGYÁLTALÁN nincs tanítóadat, az eredmény
 * „elégtelen” – az adat hiánya nem keverhető össze a gyenge teljesítménnyel
 * (az ismeretlen csapat a csoportja átlagát kapná, ami nem ítélet róla).
 */
export function qualityOf(pred: { sdLog: number; home: { known: boolean }; away: { known: boolean } }, t: XsQualityThresholds): { quality: XsQuality; reason: string } {
  if (!pred.home.known || !pred.away.known) {
    return { quality: 'elegtelen', reason: 'Legalább az egyik csapatnak nincs egyetlen lezárt meccse sem a tanítóadatban (adathiány, nem gyengeség).' };
  }
  if (pred.sdLog <= t.sdGood) return { quality: 'elegendo', reason: `Bizonytalanság ${pred.sdLog.toFixed(3)} ≤ ${t.sdGood.toFixed(3)}.` };
  if (pred.sdLog <= t.sdLimited) return { quality: 'korlatozott', reason: `Bizonytalanság ${pred.sdLog.toFixed(3)} ≤ ${t.sdLimited.toFixed(3)}.` };
  if (pred.sdLog <= t.sdMax) return { quality: 'keves_regularizalt', reason: `Bizonytalanság ${pred.sdLog.toFixed(3)} ≤ ${t.sdMax.toFixed(3)}; a becslés erősen a csoportátlag felé húzott.` };
  return { quality: 'elegtelen', reason: `Bizonytalanság ${pred.sdLog.toFixed(3)} > ${t.sdMax.toFixed(3)} – a validáción ebben a sávban a modell nem volt jobb a naiv alapnál.` };
}
