/**
 * Edge Radar API (KÍSÉRLETI) – GET /api/edge-radar?date=YYYY-MM-DD
 *
 * Jogosultság: a mountoló (index.ts) a meglévő `requirePro` mögé köti – FREE: 403 PRO_REQUIRED,
 * nem hitelesített: 401 AUTH_REQUIRED (a meglévő formátum). A modellváltozatot KIZÁRÓLAG a
 * szerveroldali csomag (planOf) dönti el, ugyanúgy, mint a /matches/:id/analysis: PRO → 'pro'.
 * A kliens query-paraméterei (variant, isPro, plan, …) figyelmen kívül maradnak.
 *
 * A válasz NEM tartalmaz EV-t / várható nyereséget, modell-valószínűséget, belső hibaüzenetet.
 * Az `edgePp` és a `modelId` csak a szolgáltatás által érvényesnek minősített sorokban szerepel.
 */
import { Router } from 'express';
import { planOf } from '../billing/entitlement';
import { EDGE_RADAR_MAX_DAYS_AHEAD, addCalendarDays, edgeDateRange } from '../../shared/edgeDates';
import type { EdgeRow, EdgeService } from '../edge/edgeService';
import type { EdgeRadarItem, EdgeRadarResponse } from '../../shared/types';

export const EDGE_RADAR_VERSION = 1;

/**
 * Szerveroldali kapcsoló (EDGE_RADAR_ENABLED). BIZTONSÁGOS alapértelmezés: hiányzó vagy ismeretlen
 * érték → KIKAPCSOLVA. Bekapcsolva csak 'true' / '1' / 'on' / 'yes' (kis-nagybetű és szóköz mindegy).
 */
export function edgeRadarEnabled(env: { EDGE_RADAR_ENABLED?: string }): boolean {
  return ['true', '1', 'on', 'yes'].includes(String(env.EDGE_RADAR_ENABLED ?? '').trim().toLowerCase());
}

/**
 * A kérhető napok (a mai BUDAPESTI nap + 7 naptári nap) a közös `shared/edgeDates` modulból –
 * ugyanazt használja a felület dátumválasztója, így a szerver és a böngésző ugyanazt a napot érti.
 */
export { EDGE_RADAR_MAX_DAYS_AHEAD, edgeDateRange };
export const addDays = addCalendarDays;

/** Szigorú YYYY-MM-DD, és létező naptári nap (2026-02-30 → érvénytelen). Időzónától független. */
export function parseIsoDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? v : null;
}

/** A publikálható mezők (whitelist) – a közös EdgeRadarItem típus; minden más mező kimarad. */
export type { EdgeRadarItem };

export function toItem(r: EdgeRow): EdgeRadarItem {
  const usable = !r.excluded && r.edgePp != null;
  return {
    matchId: r.matchId, leagueId: r.leagueId, kickoff: r.kickoff, market: r.market, outcome: r.outcome,
    odds: r.odds, bookmaker: r.bookmaker, source: r.source, observedAt: r.observedAt, ageMs: r.ageMs,
    rawImplied: r.rawImplied, devig: r.devig, devigReason: r.devigReason,
    modelId: usable ? r.modelId : null, edgePp: usable ? r.edgePp : null,
    excluded: !usable, excludeReason: r.excludeReason,
  };
}

export const EDGE_RADAR_NOTICE = [
  'Kísérleti funkció.',
  'A százalékpontos különbség (edgePp) nem garantál nyereséget; a modell kalibrációja nincs igazolva.',
  'Az observedAt a saját lekérésünk ideje, nem az odds tényleges változásáé.',
  'Az árrésmentesítés arányos normalizálással készült – közelítés, nem a valódi piaci valószínűség.',
  'Az odds-lefedettség bajnokságonként változik (egyes sorozatokhoz nincs odds).',
];

export interface EdgeRadarRouterOptions {
  /** a kapcsoló állapota kérésenként (alapból az EDGE_RADAR_ENABLED környezeti változó) */
  enabled?: () => boolean;
  /** a „mai nap” kulcsa (alapból a budapesti `dayKey`) – tesztekhez injektálható */
  todayOf?: (now: Date) => string;
}

export function edgeRadarRouter(edge: Pick<EdgeService, 'buildEdgeResult'>, now: () => Date = () => new Date(), opts: EdgeRadarRouterOptions = {}): Router {
  const enabled = opts.enabled ?? (() => edgeRadarEnabled(process.env));
  const r = Router();
  r.get('/', async (req, res) => {
    // kapcsoló: kikapcsolva semmilyen Edge-adat nem számolódik és nem kerül ki (503, mint a többi „nem elérhető” funkció)
    if (!enabled()) return res.status(503).json({ error: 'Az Edge Radar jelenleg nincs bekapcsolva.', code: 'EDGE_RADAR_DISABLED' });
    // dátum: kötelező (nincs alapértelmezés), szigorúan YYYY-MM-DD, létező nap
    if (req.query.date === undefined) return res.status(400).json({ error: 'A date paraméter kötelező (YYYY-MM-DD).', code: 'DATE_REQUIRED' });
    const date = parseIsoDate(req.query.date);
    if (!date) return res.status(400).json({ error: 'Érvénytelen dátum: YYYY-MM-DD formátumú, létező napot adj meg.', code: 'INVALID_DATE' });
    // dátumkorlát: a mai nap és a következő 7 naptári nap (a szerver dönt; a felület csak tükrözi)
    const range = edgeDateRange(now(), opts.todayOf);
    if (date < range.min || date > range.max) {
      return res.status(400).json({ error: `A dátum a mai nap és a következő ${EDGE_RADAR_MAX_DAYS_AHEAD} nap közé essen (${range.min} – ${range.max}).`, code: 'DATE_OUT_OF_RANGE', min: range.min, max: range.max });
    }
    // modellváltozat: csak a szerveroldali csomag szerint (a requirePro mögött élesben mindig PRO)
    const variant = planOf(res).pro ? 'pro' : 'base';
    const at = now();
    try {
      const out = await edge.buildEdgeResult(date, variant, at);
      // ha minden meccs számítása hibás volt, az nem „üres, sikeres” eredmény
      if (out.matchCount > 0 && out.failedMatchIds.length === out.matchCount) {
        return res.status(500).json({ error: 'Az Edge Radar most nem számolható.', code: 'EDGE_UNAVAILABLE' });
      }
      const items = out.rows.map(toItem);
      const body: EdgeRadarResponse = {
        version: EDGE_RADAR_VERSION,
        date,
        generatedAt: at.toISOString(),
        items,
        meta: {
          experimental: true,
          modelVariant: variant,
          matches: out.matchCount,
          rows: items.length,
          usable: items.filter((i) => !i.excluded).length,
          excluded: items.filter((i) => i.excluded).length,
          partial: out.failedMatchIds.length > 0,
          failedMatchIds: out.failedMatchIds,
          devigMethod: 'proportional',
          notice: EDGE_RADAR_NOTICE,
        },
      };
      res.json(body);
    } catch (e) {
      console.error('[edge-radar]', (e as Error).message);
      res.status(500).json({ error: 'Az Edge Radar most nem számolható.', code: 'EDGE_UNAVAILABLE' });
    }
  });
  return r;
}
