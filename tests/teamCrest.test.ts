/**
 * Csapatcímerek: forrás (csak az ESPN által közölt, a.espncdn.com-os URL), adatfolyam a
 * tipplistáig és a szelvényekig, valamint a TeamCrest komponens viselkedése (létező címer,
 * hiányzó URL, hibás kép, helyettesítő ikon, a név és a tipp a címer hibájakor is látszik).
 * DOM nélkül: a hibakezelést az állapotmentes `crestElement` onError-ján át hívjuk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { safeTeamLogo, espnTeamLogo } from '../src/shared/teamLogo';
import { crestElement, crestFailed, Matchup, resetCrestFailures, TeamCrest, TeamName } from '../src/client/components/TeamCrest';
import { TipCard } from '../src/client/components/TipCard';
import { MatchCard } from '../src/client/components/MatchList';
import { EspnProvider } from '../src/server/data/espnProvider';
import { DemoMatchDataProvider } from '../src/server/data/demoProvider';
import { DemoResearchProvider } from '../src/server/research/demoResearch';
import { AnalysisService } from '../src/server/services/analysisService';
import { redactTipsForFree } from '../src/shared/engine/plan';
import type { Container } from '../src/server/container';
import type { Team, TipListEntry } from '../src/shared/types';
import type { MatchWithTeams } from '../src/client/lib/api';

const ARSENAL = 'https://a.espncdn.com/i/teamlogos/soccer/500/359.png';
const html = (el: ReactElement) => renderToStaticMarkup(el);
const inRouter = (el: ReactElement) => html(createElement(MemoryRouter, null, el));

beforeEach(() => resetCrestFailures());

describe('Címer-URL: csak az adatforrás saját CDN-je', () => {
  it('safeTeamLogo: https://a.espncdn.com elfogadva; más hoszt, http, javascript:, névből gyártott cím elutasítva', () => {
    expect(safeTeamLogo(ARSENAL)).toBe(ARSENAL);
    expect(safeTeamLogo('https://a.espncdn.com/i/teamlogos/soccer/500-dark/359.png')).toBeDefined();
    for (const bad of ['http://a.espncdn.com/i/teamlogos/soccer/500/359.png', 'https://evil.example/i/359.png', 'https://a.espncdn.com.evil.example/x.png',
      'javascript:alert(1)', 'https://a.espncdn.com/i/teamlogos/soccer/500/Arsenal FC.png', '', null, undefined, 42]) {
      expect(safeTeamLogo(bad), String(bad)).toBeUndefined();
    }
  });

  it('espnTeamLogo: scoreboard `logo`; teams/schedule `logos[]` alapértelmezett (nem sötét) képe; ha nincs, undefined', () => {
    expect(espnTeamLogo({ id: '359', logo: ARSENAL })).toBe(ARSENAL);
    expect(espnTeamLogo({ id: '349', logos: [
      { href: 'https://a.espncdn.com/i/teamlogos/soccer/500-dark/349.png', rel: ['full', 'dark'] },
      { href: 'https://a.espncdn.com/i/teamlogos/soccer/500/349.png', rel: ['full', 'default'] },
    ] })).toBe('https://a.espncdn.com/i/teamlogos/soccer/500/349.png');
    expect(espnTeamLogo({ id: '1', logos: [{ href: 'https://a.espncdn.com/i/teamlogos/soccer/500-dark/1.png', rel: ['full', 'dark'] }] })).toBeUndefined();
    expect(espnTeamLogo({ id: '1', logo: 'https://evil.example/1.png' })).toBeUndefined();
    expect(espnTeamLogo({ id: '1' })).toBeUndefined();
    expect(espnTeamLogo(null)).toBeUndefined();
  });

  it('EspnProvider: a csapat a közölt címert kapja; címer nélküli első ismeretség után pótolja; idegen hosztot nem vesz át', () => {
    const p = new EspnProvider() as unknown as { registerTeam(raw: unknown, leagueId: string, slug: string): Team };
    expect(p.registerTeam({ id: '359', displayName: 'Arsenal', logo: ARSENAL }, 'eng-pl', 'eng.1').logo).toBe(ARSENAL);
    expect(p.registerTeam({ id: '363', displayName: 'Chelsea' }, 'eng-pl', 'eng.1').logo).toBeUndefined();
    expect(p.registerTeam({ id: '363', displayName: 'Chelsea', logos: [{ href: 'https://a.espncdn.com/i/teamlogos/soccer/500/363.png', rel: ['default'] }] }, 'eng-pl', 'eng.1').logo)
      .toBe('https://a.espncdn.com/i/teamlogos/soccer/500/363.png');
    expect(p.registerTeam({ id: '364', displayName: 'Liverpool', logo: 'https://evil.example/364.png' }, 'eng-pl', 'eng.1').logo).toBeUndefined();
  });
});

describe('TeamCrest komponens', () => {
  it('létező címer: kép fix méretben, arányőrzően (object-contain), alt szöveggel, lustán töltve, hivatkozó nélkül', () => {
    const out = html(createElement(TeamCrest, { name: 'Arsenal', logo: ARSENAL, size: 'md' }));
    expect(out).toContain(`src="${ARSENAL}"`);
    expect(out).toContain('alt="Arsenal címere"');
    expect(out).toContain('width="28"');
    expect(out).toContain('height="28"');
    expect(out).toContain('object-contain');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('referrerPolicy="no-referrer"');
    expect(out).toContain('width:28px;height:28px'); // a doboz mérete a betöltés előtt is fix → nincs ugrás
    expect(out).not.toContain('data-crest="fallback"');
  });

  it('hiányzó logó-URL: semleges labda-ikon, akadálymentes címkével, kép nélkül, ugyanakkora dobozban', () => {
    for (const logo of [undefined, null, '']) {
      const out = html(createElement(TeamCrest, { name: 'Ferencváros', logo, size: 'md' }));
      expect(out).not.toContain('<img');
      expect(out).toContain('data-crest="fallback"');
      expect(out).toContain('role="img"');
      expect(out).toContain('aria-label="Ferencváros – címer nem érhető el"');
      expect(out).toContain('width:28px;height:28px');
    }
  });

  it('nem engedélyezett hoszt: nem tölti be, helyettesítő ikon', () => {
    const out = html(createElement(TeamCrest, { name: 'X', logo: 'https://evil.example/x.png' }));
    expect(out).not.toContain('<img');
    expect(out).toContain('data-crest="fallback"');
  });

  it('hibás kép: az onError egyszer jelöl, utána helyettesítő ikon – újratöltés nélkül (más címer továbbra is betölt)', () => {
    let fails = 0;
    const el = crestElement('Arsenal', ARSENAL, 'sm', false, () => { fails++; }) as ReactElement<{ children: ReactElement<{ onError?: () => void }> }>;
    const img = el.props.children;
    expect(img.type).toBe('img');
    img.props.onError!();
    expect(fails).toBe(1);
    expect(crestFailed(ARSENAL)).toBe(true);
    // újrarenderelés (akár új komponenspéldány): nincs újabb <img> ugyanarra a hibás URL-re
    const again = html(createElement(TeamCrest, { name: 'Arsenal', logo: ARSENAL }));
    expect(again).not.toContain('<img');
    expect(again).toContain('aria-label="Arsenal – címer nem érhető el"');
    const after = crestElement('Arsenal', ARSENAL, 'sm', false, () => { fails++; }) as ReactElement<{ children: ReactElement }>;
    expect(after.props.children.type).not.toBe('img');
    expect(fails).toBe(1);
    expect(html(createElement(TeamCrest, { name: 'Chelsea', logo: 'https://a.espncdn.com/i/teamlogos/soccer/500/363.png' }))).toContain('<img');
  });

  it('TeamName / Matchup: a név a címer mellett marad (hibás címernél is), a hazai és vendég elválasztva', () => {
    expect(html(createElement(TeamName, { name: 'Arsenal', logo: ARSENAL }))).toMatch(/<img[^>]+>.*Arsenal<\/span>/);
    const m = html(createElement(Matchup, { home: 'Arsenal', away: 'Chelsea', homeLogo: ARSENAL }));
    expect(m).toContain('Arsenal');
    expect(m).toContain('Chelsea');
    expect(m).toContain('aria-label="ellen"');
    expect(m).toContain('aria-label="Chelsea – címer nem érhető el"');
  });
});

describe('Kártyák: a csapatnév és a tipp a címer hibájakor is megjelenik', () => {
  const entry: TipListEntry = {
    tip: { market: '1', label: 'Hazai győzelem', category: 'mérsékelt', modelProb: 0.55, odds: 1.9, impliedProb: 0.52, diffPoints: 3, valueRating: null,
      supportingIndicators: 2, supportingStats: ['a', 'b'], reasonsFor: ['Erős hazai forma'], reasonsAgainst: [], risks: [] } as unknown as TipListEntry['tip'],
    matchId: 'espn-1', matchLabel: 'Arsenal – Chelsea', kickoff: '2026-10-20T18:00:00.000Z', leagueId: 'eng-pl', leagueName: 'Premier League',
    dataQuality: { level: 'magas', score: 80, notes: [] } as unknown as TipListEntry['dataQuality'], origin: 'live',
    homeLogo: ARSENAL, awayLogo: undefined,
  };

  it('TipCard: működő és hiányzó címer mellett is látszik mindkét név, a tipp és az odds', () => {
    const out = inRouter(createElement(TipCard, { entry, pro: true }));
    expect(out).toContain(`src="${ARSENAL}"`);
    expect(out).toContain('aria-label="Chelsea – címer nem érhető el"');
    for (const s of ['Arsenal', 'Chelsea', 'Hazai győzelem', '1,90']) expect(out).toContain(s);
  });

  it('TipCard: ha a címer betöltése meghiúsult, a kártya ugyanúgy megjelenik (ikon a kép helyén)', () => {
    // nincs DOM: a kép hibáját a valódi onError-kezelő meghívásával idézzük elő
    (crestElement('Arsenal', ARSENAL, 'md', false, () => {}) as ReactElement<{ children: ReactElement<{ onError: () => void }> }>).props.children.props.onError();
    const out = inRouter(createElement(TipCard, { entry, pro: false }));
    expect(out).not.toContain('<img');
    for (const s of ['Arsenal', 'Chelsea', 'Hazai győzelem', '1,90']) expect(out).toContain(s);
  });

  it('MatchCard: címer a csapatnevek mellett; hiányzó címernél ikon, a név és a kezdés megmarad', () => {
    const m = { id: 'espn-1', leagueId: 'eng-pl', homeTeamId: 'espn-359', awayTeamId: 'espn-363', kickoff: '2026-10-20T18:00:00.000Z', status: 'scheduled',
      importance: 'normal', importanceReasons: [], origin: 'live', homeGoals: null, awayGoals: null,
      homeTeam: { id: 'espn-359', name: 'Arsenal', shortName: 'ARS', country: 'Anglia', leagueId: 'eng-pl', logo: ARSENAL },
      awayTeam: { id: 'espn-363', name: 'Chelsea', shortName: 'CHE', country: 'Anglia', leagueId: 'eng-pl' },
      league: { id: 'eng-pl', name: 'Premier League', country: 'Anglia' } } as unknown as MatchWithTeams;
    const out = inRouter(createElement(MatchCard, { m }));
    expect(out).toContain('alt="Arsenal címere"');
    expect(out).toContain('aria-label="Chelsea – címer nem érhető el"');
    expect(out).toContain('Arsenal');
    expect(out).toContain('Chelsea');
  });
});

describe('Adatfolyam: Team.logo → tipplista és szelvénylábak (új külső hívás nélkül)', () => {
  it('tipsForDate és buildSlips a csapat címerét viszi; a FREE-redakció is megtartja; címer nélküli csapatnál üres', async () => {
    const demo = new DemoMatchDataProvider();
    const teams = await demo.getTeams();
    const logoOf = new Map(teams.slice(0, Math.floor(teams.length / 2)).map((t) => [t.id, `https://a.espncdn.com/i/teamlogos/soccer/500/${t.id.replace(/\D/g, '') || '1'}.png`]));
    const data = Object.create(demo) as DemoMatchDataProvider;
    data.getTeam = async (id: string) => { const t = await demo.getTeam(id); return t ? { ...t, logo: logoOf.get(t.id) } : t; };
    const c = { data, research: new DemoResearchProvider(demo), oddsApi: null,
      db: { getSetting: async () => null, getManualOdds: async () => null, getResearch: () => null, saveResearch: () => undefined } } as unknown as Container;
    const svc = new AnalysisService(c);
    const m = (await demo.getMatches({ status: 'scheduled' }))[0];
    const date = new Date(m.kickoff).toLocaleDateString('sv-SE');
    const list = await svc.tipsForDate(date);
    expect(list.length).toBeGreaterThan(0);
    const all = await demo.getMatches({ date, status: 'scheduled' });
    for (const e of list) {
      const mm = all.find((x) => x.id === e.matchId)!;
      expect(e.homeLogo).toBe(logoOf.get(mm.homeTeamId));
      expect(e.awayLogo).toBe(logoOf.get(mm.awayTeamId));
    }
    expect(list.some((e) => e.homeLogo) && list.some((e) => !e.homeLogo || !e.awayLogo)).toBe(true);
    for (const e of redactTipsForFree(list)) expect(e.homeLogo).toBe(list.find((x) => x.matchId === e.matchId)!.homeLogo);
    const slips = await svc.buildSlips(date, date, { legs: 2, minTotalOdds: 1.01, minLegProb: 0 });
    for (const leg of slips.slips.flatMap((s) => s.legs)) {
      const mm = all.find((x) => x.id === leg.matchId)!;
      expect(leg.homeLogo).toBe(logoOf.get(mm.homeTeamId));
      expect(leg.awayLogo).toBe(logoOf.get(mm.awayTeamId));
    }
  });
});
