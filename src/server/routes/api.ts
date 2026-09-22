/**
 * REST API. Minden végpont JSON-t ad vissza; hiba esetén { error: string } magyar üzenettel.
 * Az API kulcsok itt sem jelennek meg – a /api/status csak azt mondja meg, hogy konfigurálva vannak-e.
 */
import { Router } from 'express';
import type { Container } from '../container';
import { AnalysisService } from '../services/analysisService';
import { computeForm, computeStandings, computeLeagueAverages } from '../../shared/engine/stats';
import { localDateKey } from '../data/demoProvider';
import type { MatchOdds, SlipStrategy } from '../../shared/types';
import { freeMatchIds, redactAnalysisForFree, redactTipsForFree } from '../../shared/engine/plan';
import { planOf } from '../billing/entitlement';

const VALID_MARKET = /^([12X]|1X|X2|12|DNB_[12]|[OU]\d\.5|BTTS_[YN]|(HOME|AWAY)_O\d\.5|AH_HOME_-1|CS_\d+-\d+)$/;

export function apiRouter(c: Container, svc: AnalysisService): Router {
  const r = Router();
  const q = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  // Bemenet-ellenőrzés: dátum csak YYYY-MM-DD, azonosítók csak biztonságos karakterek – a külső szolgáltatók URL-jébe kerülnek
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const ID = /^[a-zA-Z0-9._:-]{1,80}$/;
  const qd = (v: unknown): string | undefined => { const d = q(v); return d && DATE.test(d) ? d : undefined; };
  const qid = (v: unknown): string | undefined => { const d = q(v); return d && ID.test(d) ? d : undefined; };
  const badId = (res: import('express').Response) => res.status(400).json({ error: 'Érvénytelen azonosító.' });
  /**
   * A művelet tulajdonosa: KIZÁRÓLAG a hitelesített Supabase tokenből (attachPlan → res.locals.plan.user.id).
   * A kérés törzsében/queryjében küldött user_id-t sosem fogadjuk el.
   * Ha a hitelesítés nincs bekapcsolva a szerveren (helyi, egyfelhasználós mód), rögzített helyi azonosítót adunk.
   */
  const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';
  const ownerId = (res: import('express').Response): string | null => {
    const plan = planOf(res);
    if (!plan.enforced) return LOCAL_USER_ID;
    return plan.user?.id ?? null;
  };
  const needAuth = (res: import('express').Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });

  r.get('/status', (_req, res) => res.json(c.status()));

  r.get('/leagues', async (_req, res) => res.json(await c.data.getLeagues()));

  r.get('/matches', async (req, res) => {
    const date = qd(req.query.date);
    if ((req.query.date && !date) || (req.query.from && !qd(req.query.from)) || (req.query.to && !qd(req.query.to))) return res.status(400).json({ error: 'Érvénytelen dátum (YYYY-MM-DD).' });
    const matches = await c.data.getMatches({
      date: date && !qd(req.query.from) ? date : undefined,
      from: qd(req.query.from), to: qd(req.query.to),
      leagueId: qid(req.query.leagueId), country: q(req.query.country)?.slice(0, 40), teamId: qid(req.query.teamId),
      importance: q(req.query.importance)?.slice(0, 10), status: q(req.query.status)?.slice(0, 10),
    });
    const [leagues, teams] = await Promise.all([c.data.getLeagues(), c.data.getTeams()]);
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const leagueById = new Map(leagues.map((l) => [l.id, l]));
    res.json(matches.map((m) => ({ ...m, homeTeam: teamById.get(m.homeTeamId) ?? null, awayTeam: teamById.get(m.awayTeamId) ?? null, league: leagueById.get(m.leagueId) ?? null })));
  });

  r.get('/matches/:id', async (req, res) => {
    if (!ID.test(req.params.id)) return badId(res);
    const m = await c.data.getMatch(req.params.id);
    if (!m) return res.status(404).json({ error: 'A mérkőzés nem található.' });
    const [home, away, leagues] = await Promise.all([c.data.getTeam(m.homeTeamId), c.data.getTeam(m.awayTeamId), c.data.getLeagues()]);
    res.json({ ...m, homeTeam: home, awayTeam: away, league: leagues.find((l) => l.id === m.leagueId) ?? null });
  });

  r.get('/matches/:id/analysis', async (req, res) => {
    if (!ID.test(req.params.id)) return badId(res);
    const plan = planOf(res);
    try {
      if (!plan.pro) {
        // FREE napi kvóta – a szerver a saját (szűretlen) napi listájából számol, ugyanazzal a szabállyal, mint a felület
        const m = await c.data.getMatch(req.params.id);
        if (!m) return res.status(404).json({ error: 'A mérkőzés nem található.' });
        const day = await c.data.getMatches({ date: localDateKey(m.kickoff) });
        if (!freeMatchIds(day).has(m.id)) return res.status(403).json({ error: 'Ez a mérkőzés PRO előfizetéssel elemezhető.', code: 'PRO_REQUIRED' });
      }
      // A kutatás kényszerített frissítése külső hívásokat indít – csak PRO kérheti
      const a = await svc.analyze(req.params.id, { forceResearch: plan.pro && req.query.refresh === '1' });
      if (!a) return res.status(404).json({ error: 'A mérkőzés nem található.' });
      res.json(plan.pro ? a : redactAnalysisForFree(a));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Az elemzés nem futtatható: ' + (e as Error).message });
    }
  });

  r.post('/matches/:id/odds', async (req, res) => {
    if (!ID.test(req.params.id)) return badId(res);
    const m = await c.data.getMatch(req.params.id);
    if (!m) return res.status(404).json({ error: 'A mérkőzés nem található.' });
    const raw = (req.body?.markets ?? {}) as Record<string, unknown>;
    const markets: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
      if (!VALID_MARKET.test(k)) return res.status(400).json({ error: `Ismeretlen piac: ${k}` });
      if (!Number.isFinite(n) || n <= 1 || n > 1000) return res.status(400).json({ error: `Érvénytelen odds a(z) ${k} piacon: az oddsnak 1,00-nál nagyobb számnak kell lennie.` });
      markets[k] = Math.round(n * 100) / 100;
    }
    if (!Object.keys(markets).length) return res.status(400).json({ error: 'Legalább egy oddsot adj meg.' });
    const odds: MatchOdds = { matchId: m.id, source: 'manual', bookmaker: q(req.body?.bookmaker) ?? 'kézi bevitel', retrievedAt: new Date().toISOString(), markets };
    await c.db.saveManualOdds(odds);
    svc.invalidate(m.id);
    res.json(odds);
  });

  r.delete('/matches/:id/odds', async (req, res) => {
    await c.db.deleteManualOdds(req.params.id);
    svc.invalidate(req.params.id);
    res.json({ ok: true });
  });

  r.post('/matches/:id/predictions', async (req, res) => {
    if (!ID.test(req.params.id)) return badId(res);
    const market = q(req.body?.market);
    if (!market || !VALID_MARKET.test(market)) return res.status(400).json({ error: 'Érvénytelen piac.' });
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    if (await c.db.hasPrediction(userId, req.params.id, market)) return res.status(409).json({ error: 'Ez a tipp már el van mentve ehhez a mérkőzéshez.' });
    const rec = await svc.savePrediction(userId, req.params.id, market, 'manuális');
    if (!rec) return res.status(400).json({ error: 'A tipp nem menthető (nincs modell-eredmény ehhez a mérkőzéshez).' });
    res.json(rec);
  });

  r.get('/tips', async (req, res) => {
    const date = qd(req.query.date) ?? localDateKey(new Date().toISOString());
    try {
      const list = await svc.tipsForDate(date);
      res.json(planOf(res).pro ? list : redactTipsForFree(list));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'A tippek nem állíthatók elő: ' + (e as Error).message });
    }
  });

  r.get('/slips', async (req, res) => {
    const from = qd(req.query.from) ?? localDateKey(new Date().toISOString());
    const to = qd(req.query.to) ?? from;
    const num = (v: unknown, d: number) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : d; };
    const legs = Math.min(8, Math.max(2, Math.round(num(req.query.legs, 3))));
    const minTotalOdds = Math.max(1, num(req.query.minOdds, 1.5));
    const minLegProb = Math.min(0.99, Math.max(0, num(req.query.minLegProb, 0.5)));
    const strategy = q(req.query.strategy) as SlipStrategy | undefined;
    const days = (new Date(to + 'T12:00:00').getTime() - new Date(from + 'T12:00:00').getTime()) / 86400000;
    if (!Number.isFinite(days) || days < 0 || days > 10) return res.status(400).json({ error: 'Az időszak legfeljebb 10 nap lehet.' });
    try {
      res.json(await svc.buildSlips(from, to, { legs, minTotalOdds, minLegProb, strategies: strategy ? [strategy] : undefined, perStrategy: 3 }));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'A szelvények nem állíthatók össze: ' + (e as Error).message });
    }
  });

  r.get('/slips/saved', async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    await svc.settlePending(userId);
    res.json(await c.db.listSlips(userId));
  });

  r.post('/slips', async (req, res) => {
    const legs = Array.isArray(req.body?.legs) ? (req.body.legs as { matchId: string; market: string }[]) : [];
    const strategy = q(req.body?.strategy) as SlipStrategy | undefined;
    if (legs.length < 2 || legs.length > 8 || !legs.every((l) => typeof l?.matchId === 'string' && VALID_MARKET.test(String(l?.market)))) return res.status(400).json({ error: 'Érvénytelen szelvény: 2–8 láb, érvényes piacokkal.' });
    if (new Set(legs.map((l) => l.matchId)).size !== legs.length) return res.status(400).json({ error: 'Egy mérkőzés csak egyszer szerepelhet a szelvényen.' });
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    const rec = await svc.saveSlip(userId, strategy ?? 'legnagyobb esély', q(req.body?.label) ?? `${legs.length} lábú szelvény`, legs);
    if (!rec) return res.status(400).json({ error: 'A szelvény nem menthető: valamelyik lábhoz nincs modell-eredmény vagy nincs elérhető odds.' });
    res.json(rec);
  });

  r.get('/standings/:leagueId', async (req, res) => {
    if (!ID.test(req.params.leagueId)) return badId(res);
    const leagues = await c.data.getLeagues();
    const league = leagues.find((l) => l.id === req.params.leagueId);
    if (!league) return res.status(404).json({ error: 'A bajnokság nem található.' });
    const all = await c.data.getLeagueResults(league.id);
    const seasonStart = await c.data.getSeasonStart?.(league.id);
    const results = seasonStart ? all.filter((r) => r.date >= seasonStart) : all;
    const teams = await c.data.getTeams();
    const standings = computeStandings(league.id, results);
    const averages = computeLeagueAverages(league.id, results);
    const teamById = new Map(teams.map((t) => [t.id, t]));
    res.json({
      league,
      averages,
      seasonStart: seasonStart ?? null,
      origin: c.data.origin,
      // FREE: csak a liga-átlagok; a tabella és a forma PRO (a szerver takarja ki, nem a felület)
      standings: planOf(res).pro ? standings.map((s) => ({ ...s, team: teamById.get(s.teamId) ?? null, form: computeForm(s.teamId, results, 5).formString })) : [],
    });
  });

  r.get('/teams/:id', async (req, res) => {
    if (!ID.test(req.params.id)) return badId(res);
    const team = await c.data.getTeam(req.params.id);
    if (!team) return res.status(404).json({ error: 'A csapat nem található.' });
    const [results, leagues, teams, upcoming] = await Promise.all([
      c.data.getTeamResults(team.id),
      c.data.getLeagues(),
      c.data.getTeams(),
      c.data.getMatches({ teamId: team.id, status: 'scheduled' }),
    ]);
    const teamById = new Map(teams.map((t) => [t.id, t]));
    res.json({
      team,
      league: leagues.find((l) => l.id === team.leagueId) ?? null,
      origin: c.data.origin,
      last10: computeForm(team.id, results, 10),
      home: computeForm(team.id, results, 10, 'hazai'),
      away: computeForm(team.id, results, 10, 'idegen'),
      upcoming: upcoming.slice(0, 5).map((m) => ({ ...m, homeTeam: teamById.get(m.homeTeamId), awayTeam: teamById.get(m.awayTeamId), league: leagues.find((l) => l.id === m.leagueId) })),
      recent: results.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10).map((m) => ({ ...m, homeTeam: teamById.get(m.homeTeamId), awayTeam: teamById.get(m.awayTeamId), league: leagues.find((l) => l.id === m.leagueId) })),
    });
  });

  r.get('/search', async (req, res) => {
    const term = (q(req.query.q) ?? '').slice(0, 60).toLowerCase();
    if (term.length < 2) return res.json({ teams: [], leagues: [], matches: [] });
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const t = norm(term);
    const [teams, leagues] = await Promise.all([c.data.getTeams(), c.data.getLeagues()]);
    const teamHits = teams.filter((x) => norm(x.name).includes(t) || norm(x.shortName).includes(t)).slice(0, 10);
    const leagueHits = leagues.filter((x) => norm(x.name).includes(t) || norm(x.country).includes(t)).slice(0, 5);
    const today = new Date();
    const to = new Date(today.getTime() + 3 * 86400000);
    const upcoming = await c.data.getMatches({ from: localDateKey(today.toISOString()), to: localDateKey(to.toISOString()) });
    const teamById = new Map(teams.map((x) => [x.id, x]));
    const leagueById = new Map(leagues.map((x) => [x.id, x]));
    const matchHits = upcoming
      .filter((m) => {
        const h = teamById.get(m.homeTeamId), a = teamById.get(m.awayTeamId), l = leagueById.get(m.leagueId);
        const label = norm(`${h?.name ?? ''} ${a?.name ?? ''} ${h?.shortName ?? ''} ${a?.shortName ?? ''} ${l?.name ?? ''} ${l?.country ?? ''}`);
        return label.includes(t);
      })
      .slice(0, 20)
      .map((m) => ({ ...m, homeTeam: teamById.get(m.homeTeamId), awayTeam: teamById.get(m.awayTeamId), league: leagueById.get(m.leagueId) }));
    res.json({ teams: teamHits, leagues: leagueHits, matches: matchHits });
  });

  r.get('/history', async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    await svc.settlePending(userId);
    const num = (v: unknown) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : undefined; };
    const list = await c.db.listPredictions(userId, {
      leagueId: q(req.query.leagueId), market: q(req.query.market), from: q(req.query.from), to: q(req.query.to),
      minProb: num(req.query.minProb), maxProb: num(req.query.maxProb), origin: q(req.query.origin),
    });
    res.json({ predictions: list, summary: c.db.summarize(list), origin: c.data.origin });
  });

  r.post('/history/settle', async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    res.json({ settled: await svc.settlePending(userId) });
  });

  r.get('/sources', async (req, res) => {
    res.json(c.db.listSources(qid(req.query.matchId), q(req.query.origin)?.slice(0, 10)));
  });

  r.get('/settings', async (_req, res) => {
    res.json({ shrinkageK: parseFloat((await c.db.getSetting('shrinkageK')) ?? '3'), status: c.status() });
  });

  r.post('/settings', async (req, res) => {
    const k = parseFloat(String(req.body?.shrinkageK));
    if (!Number.isFinite(k) || k < 0 || k > 20) return res.status(400).json({ error: 'A zsugorítási paraméter 0 és 20 közötti szám legyen.' });
    await c.db.setSetting('shrinkageK', String(k));
    svc.invalidateAll(); // minden elemzés újraszámolandó az új paraméterrel
    res.json({ shrinkageK: k });
  });

  return r;
}
