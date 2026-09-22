/**
 * Szelvényépítő: több mérkőzés egy-egy piacát kombinálja, és azokat a kombinációkat keresi meg,
 * amelyeknek a MODELL szerint a legnagyobb az esélyük (a lábak valószínűségeinek szorzata).
 *
 * Feltevések és korlátok (a felületen is jelezve):
 *  - A lábak függetlenek (különböző mérkőzések) – ezért szorozhatók a valószínűségek.
 *  - A modell-valószínűség becslés; 5 láb 80%-os eséllyel is csak ~33% együttes esély.
 *  - Csak olyan láb kerül szelvényre, amelyhez valódi odds tartozik – odds-ot nem találunk ki.
 *  - Nem ajánlás: a szelvények elemzési kiindulópontok.
 *
 * Keresés: nyaláb-keresés (beam search) mérkőzésenként legfeljebb egy lábbal.
 */
import type { DataQualityLevel, Slip, SlipLeg, SlipStrategy } from '../types';

export interface SlipBuildOptions {
  legs: number;
  /** összodds alsó korlátja (pl. 1,5) */
  minTotalOdds: number;
  /** láb modell-valószínűség alsó korlátja (0–1) */
  minLegProb: number;
  /** ennyi szelvényt adunk vissza stratégiánként */
  perStrategy?: number;
  strategies?: SlipStrategy[];
  beamWidth?: number;
}

const QUALITY_RANK: Record<DataQualityLevel, number> = { 'kevés': 0, 'közepes': 1, 'magas': 2 };

interface Partial { legs: SlipLeg[]; logP: number; logOdds: number; logEv: number }

function scoreFor(strategy: SlipStrategy, p: Partial): number {
  switch (strategy) {
    case 'legnagyobb esély': return p.logP;
    case 'kiegyensúlyozott': return p.logP + 0.35 * p.logOdds; // enyhén jutalmazza a magasabb oddsot
    case 'modell-előny': return p.logEv;
  }
}

function legAllowed(strategy: SlipStrategy, leg: SlipLeg, minLegProb: number): boolean {
  if (leg.modelProb < minLegProb) return false;
  if (strategy === 'modell-előny') return leg.diffPoints > 0;
  return true;
}

function finalize(strategy: SlipStrategy, p: Partial, idx: number): Slip {
  const totalOdds = Math.exp(p.logOdds);
  const jointProb = Math.exp(p.logP);
  const implied = 1 / totalOdds;
  const warnings: string[] = [];
  warnings.push('A lábak függetlenségét feltételezzük; az együttes valószínűség a modell-becslések szorzata, nem garancia.');
  const lowQ = p.legs.filter((l) => l.dataQuality === 'kevés').length;
  if (lowQ) warnings.push(`${lowQ} láb kevés adatra épül.`);
  const lowInd = p.legs.filter((l) => l.supportingIndicators < 2).length;
  if (lowInd) warnings.push(`${lowInd} lábnál 2-nél kevesebb statisztikai mutató támogatja a piacot.`);
  const neg = p.legs.filter((l) => l.diffPoints < 0).length;
  if (neg) warnings.push(`${neg} lábnál az odds implikált valószínűsége magasabb a modellnél (negatív modellkülönbség).`);
  const far = p.legs.filter((l) => l.diffPoints >= 15).length;
  if (far) warnings.push(`${far} lábnál a modell 15+ százalékponttal a piac fölött becsül – a fogadóirodák általában jól kalibráltak, ez inkább a modell túlbecslését jelezheti, mint valódi előnyt.`);
  if (jointProb < 0.25) warnings.push(`Az együttes esély a modell szerint is csak ${Math.round(jointProb * 100)}% – a szelvények többsége várhatóan nem jön be.`);
  return {
    id: `${strategy}-${idx}-${p.legs.map((l) => l.matchId + ':' + l.market).join('|')}`,
    strategy,
    legs: [...p.legs].sort((a, b) => a.kickoff.localeCompare(b.kickoff)),
    totalOdds: Math.round(totalOdds * 100) / 100,
    jointProb,
    impliedJointProb: implied,
    diffPoints: Math.round((jointProb - implied) * 10000) / 100,
    expectedReturn: Math.round(jointProb * totalOdds * 1000) / 1000,
    warnings,
  };
}

/** Egy mérkőzéshez tartozó legjobb lábak (stratégiától függő rendezés, legfeljebb `perMatch` darab). */
function candidatesByMatch(legs: SlipLeg[], strategy: SlipStrategy, minLegProb: number, perMatch = 3): SlipLeg[][] {
  const byMatch = new Map<string, SlipLeg[]>();
  for (const l of legs) {
    if (!legAllowed(strategy, l, minLegProb) || !(l.odds > 1)) continue;
    if (!byMatch.has(l.matchId)) byMatch.set(l.matchId, []);
    byMatch.get(l.matchId)!.push(l);
  }
  const key = (l: SlipLeg) => (strategy === 'modell-előny' ? Math.log(l.modelProb * l.odds) : strategy === 'kiegyensúlyozott' ? Math.log(l.modelProb) + 0.35 * Math.log(l.odds) : Math.log(l.modelProb));
  const groups = [...byMatch.values()].map((ls) => ls.sort((a, b) => key(b) - key(a)).slice(0, perMatch));
  // a legígéretesebb mérkőzések elöl – a nyaláb így hamar jó megoldásokat talál
  groups.sort((a, b) => key(b[0]) - key(a[0]));
  return groups;
}

export function buildSlips(legs: SlipLeg[], opts: SlipBuildOptions): Slip[] {
  const strategies = opts.strategies ?? ['legnagyobb esély', 'kiegyensúlyozott', 'modell-előny'];
  const per = opts.perStrategy ?? 3;
  const beamWidth = opts.beamWidth ?? 400;
  const out: Slip[] = [];

  for (const strategy of strategies) {
    const groups = candidatesByMatch(legs, strategy, opts.minLegProb);
    if (groups.length < opts.legs) continue;

    // Nyaláb-keresés lábszámonként külön nyalábbal (különben a rövidebb, "olcsóbb" részszelvények kiszorítanák a teljeseket):
    // minden mérkőzésnél vagy kihagyjuk, vagy egy lábát hozzáadjuk.
    let beams: Partial[][] = Array.from({ length: opts.legs + 1 }, () => []);
    beams[0].push({ legs: [], logP: 0, logOdds: 0, logEv: 0 });
    for (const group of groups) {
      const next: Partial[][] = beams.map((b) => [...b]); // kihagyás: minden állapot megmarad
      for (let n = 0; n < opts.legs; n++) {
        for (const p of beams[n]) {
          for (const leg of group) {
            next[n + 1].push({
              legs: [...p.legs, leg],
              logP: p.logP + Math.log(leg.modelProb),
              logOdds: p.logOdds + Math.log(leg.odds),
              logEv: p.logEv + Math.log(leg.modelProb * leg.odds),
            });
          }
        }
      }
      beams = next.map((b) => b.sort((a, c) => scoreFor(strategy, c) - scoreFor(strategy, a)).slice(0, beamWidth));
    }
    const beam = beams[opts.legs];

    const complete = beam
      .filter((p) => p.legs.length === opts.legs && Math.exp(p.logOdds) >= opts.minTotalOdds)
      .sort((a, b) => scoreFor(strategy, b) - scoreFor(strategy, a));

    // Egymástól különböző szelvények (legalább egy eltérő láb)
    const chosen: Partial[] = [];
    for (const p of complete) {
      const sig = new Set(p.legs.map((l) => l.matchId + ':' + l.market));
      if (chosen.some((c) => c.legs.every((l) => sig.has(l.matchId + ':' + l.market)))) continue;
      chosen.push(p);
      if (chosen.length >= per) break;
    }
    chosen.forEach((p, i) => out.push(finalize(strategy, p, i + 1)));
  }
  return out;
}

/** Segéd: minimális adatminőség egy szelvényen (a felület címkéjéhez). */
export function slipMinQuality(slip: Slip): DataQualityLevel {
  return slip.legs.reduce<DataQualityLevel>((m, l) => (QUALITY_RANK[l.dataQuality] < QUALITY_RANK[m] ? l.dataQuality : m), 'magas');
}
