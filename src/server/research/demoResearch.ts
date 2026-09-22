/**
 * DEMO kutatómotor. Determinisztikus, egyértelműen "DEMO ADAT"-ként jelölt híreket, hiányzókat és
 * külső tippeket állít elő, hogy a felület külső keresőszolgáltatás nélkül is tesztelhető legyen.
 * Minden forrás url = null (nincs ellenőrizhető hivatkozás), sourceName "DEMO – …" előtaggal.
 * Nem használ valódi játékosneveket és nem hivatkozik valódi médiumokra.
 */
import type { ExternalPrediction, NewsItem, ResearchResult, SourceRecord, TeamAvailability } from '../../shared/types';
import { poissonModel } from '../../shared/engine/models';
import { marketLabel } from '../../shared/engine/markets';
import { hashString, makeRng } from '../data/demo/generate';
import type { DemoMatchDataProvider } from '../data/demoProvider';
import type { ResearchContext, ResearchProvider } from './provider';

const POSITIONS = ['kapus', 'középhátvéd', 'szélső hátvéd', 'védekező középpályás', 'irányító középpályás', 'szélső támadó', 'középcsatár'];
const INJURY_TYPES = ['izomsérülés', 'bokasérülés', 'térdsérülés', 'combhajlító-sérülés', 'betegség'];

export class DemoResearchProvider implements ResearchProvider {
  readonly name = 'DEMO kutatómotor (beépített)';

  constructor(private data: DemoMatchDataProvider) {}

  async research(ctx: ResearchContext): Promise<ResearchResult> {
    const { match, homeTeam, awayTeam, league } = ctx;
    const rng = makeRng(hashString('research-' + match.id));
    const now = new Date().toISOString();
    const sources: SourceRecord[] = [];
    const news: NewsItem[] = [];
    let sid = 0;
    const addSource = (sourceName: string, type: SourceRecord['type'], extracted: string): SourceRecord => {
      const s: SourceRecord = {
        id: `${match.id}-src-${++sid}`,
        matchId: match.id,
        sourceName,
        url: null,
        retrievedAt: now,
        publishedAt: new Date(Date.now() - Math.floor(rng() * 3 * 86400000)).toISOString(),
        type,
        extracted,
        method: 'DEMO ADAT – generált, nem ellenőrizhető',
        origin: 'demo',
      };
      sources.push(s);
      return s;
    };

    const availabilityFor = (team: typeof homeTeam): TeamAvailability => {
      const injuries: TeamAvailability['injuries'] = [];
      const suspensions: TeamAvailability['suspensions'] = [];
      const nInj = Math.floor(rng() * 3);
      for (let i = 0; i < nInj; i++) {
        const pos = POSITIONS[Math.floor(rng() * POSITIONS.length)];
        const typ = INJURY_TYPES[Math.floor(rng() * INJURY_TYPES.length)];
        const s = addSource('DEMO – Csapathírek', 'demo', `${team.name}: egy ${pos} ${typ} miatt kihagyja a mérkőzést.`);
        injuries.push({ player: `Demo játékos (${pos})`, detail: typ, sourceId: s.id });
      }
      if (rng() < 0.25) {
        const s = addSource('DEMO – Szövetségi közlemény', 'demo', `${team.name}: egy játékos sárga lapos eltiltás miatt nem játszhat.`);
        suspensions.push({ player: 'Demo játékos (középpályás)', detail: 'sárga lapos eltiltás', sourceId: s.id });
      }
      const minutesToKickoff = (new Date(match.kickoff).getTime() - Date.now()) / 60000;
      const lineupStatus: TeamAvailability['lineupStatus'] = minutesToKickoff < 75 ? 'megerősített' : rng() < 0.7 ? 'várható' : 'nincs adat';
      const notes: string[] = [];
      const midweek = league.international || rng() < 0.2;
      if (midweek && !league.international) notes.push('Hét közben nemzetközi kupameccset játszott (demo).');
      const restDays = 3 + Math.floor(rng() * 5);
      notes.push(`${restDays} nap pihenő az előző mérkőzés óta (demo).`);
      return {
        teamId: team.id,
        injuries,
        suspensions,
        lineupStatus,
        lineupNote: lineupStatus === 'megerősített' ? 'DEMO: a kezdőcsapat közzétéve.' : lineupStatus === 'várható' ? 'DEMO: várható kezdő, nem megerősített.' : undefined,
        restDays,
        midweekEuropeanMatch: midweek && !league.international,
        notes,
      };
    };

    const home = availabilityFor(homeTeam);
    const away = availabilityFor(awayTeam);

    // Hírek
    const s1 = addSource('DEMO – Mérkőzés-előzetes', 'demo', `${homeTeam.name} – ${awayTeam.name}: ${match.importanceReasons[0] ?? 'bajnoki mérkőzés'}, ${league.name}.`);
    news.push({ id: `${match.id}-n1`, title: `DEMO: ${homeTeam.shortName} – ${awayTeam.shortName} előzetes`, summary: s1.extracted, url: null, sourceName: s1.sourceName, publishedAt: s1.publishedAt, category: 'általános', origin: 'demo', sourceId: s1.id });
    if (rng() < 0.5) {
      const s = addSource('DEMO – Edzői sajtótájékoztató', 'demo', `${homeTeam.name} vezetőedzője: „Teljes koncentrációval készülünk, a rotáció szóba jöhet.” (demo idézet)`);
      news.push({ id: `${match.id}-n2`, title: `DEMO: ${homeTeam.shortName} edzői nyilatkozat`, summary: s.extracted, url: null, sourceName: s.sourceName, publishedAt: s.publishedAt, teamId: homeTeam.id, category: 'edző', origin: 'demo', sourceId: s.id });
    }
    if (rng() < 0.4) {
      const s = addSource('DEMO – Átigazolási hírek', 'demo', `${awayTeam.name}: egy új igazolás bekerülhet a keretbe (demo).`);
      news.push({ id: `${match.id}-n3`, title: `DEMO: ${awayTeam.shortName} keretinformáció`, summary: s.extracted, url: null, sourceName: s.sourceName, publishedAt: s.publishedAt, teamId: awayTeam.id, category: 'átigazolás', origin: 'demo', sourceId: s.id });
    }
    for (const [team, av] of [[homeTeam, home], [awayTeam, away]] as const) {
      for (const inj of av.injuries) {
        const src = sources.find((s) => s.id === inj.sourceId)!;
        news.push({ id: `${match.id}-inj-${inj.sourceId}`, title: `DEMO: ${team.shortName} – hiányzó`, summary: src.extracted, url: null, sourceName: src.sourceName, publishedAt: src.publishedAt, teamId: team.id, category: 'sérülés', origin: 'demo', sourceId: src.id });
      }
    }

    // Külső tippek – a generátor "valódi" λ-ja alapján, zajjal (így néha eltérnek a modelltől)
    const externalPredictions: ExternalPrediction[] = [];
    const lam = this.data.dataset().trueLambda.get(match.id);
    if (lam) {
      const p = poissonModel(lam[0] * (0.85 + rng() * 0.3), lam[1] * (0.85 + rng() * 0.3));
      const candidates: [string, number][] = [
        ['O2.5', p.over['2.5']], ['U2.5', p.under['2.5']], ['BTTS_Y', p.bttsYes], ['BTTS_N', p.bttsNo],
        ['1', p.homeWin], ['2', p.awayWin], ['X', p.draw], ['1X', p.doubleChance['1X']], ['X2', p.doubleChance.X2], ['O1.5', p.over['1.5']],
      ];
      const siteNames = ['DEMO Tipp Oldal A', 'DEMO Tipp Oldal B', 'DEMO Tipp Oldal C', 'DEMO Tipp Oldal D'];
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        // valószínűséggel arányos választás, hogy jellemzően a magas esélyű piacok jelenjenek meg
        const weights = candidates.map(([, pr]) => pr ** 3);
        const total = weights.reduce((a, b) => a + b, 0);
        let r = rng() * total;
        let pick = candidates[0];
        for (let j = 0; j < candidates.length; j++) { r -= weights[j]; if (r <= 0) { pick = candidates[j]; break; } }
        const s = addSource(siteNames[i], 'demo', `Tipp: ${marketLabel(pick[0])}`);
        externalPredictions.push({
          id: `${match.id}-ep-${i}`,
          sourceName: siteNames[i],
          url: null,
          publishedAt: s.publishedAt,
          originalText: `${marketLabel(pick[0])} (demo tipp)`,
          market: pick[0],
          confidence: rng() < 0.5 ? `${Math.round(55 + rng() * 30)}%` : null,
          sourceId: s.id,
          origin: 'demo',
          autoExtracted: false,
        });
      }
    }

    return {
      matchId: match.id,
      origin: 'demo',
      performedAt: now,
      provider: this.name,
      news,
      availability: { home, away },
      externalPredictions,
      sources,
      warnings: ['DEMO ADAT: a hírek, hiányzók és külső tippek szemléltető célúak, nem valós források.'],
    };
  }
}
