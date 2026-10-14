/**
 * Nyilvános PRO-felhasználószám.
 *
 *  GET /api/pro-stats          nyilvános, csak olvas: { show, count } – count a TÉNYLEGES aktív PRO-k száma
 *  GET /api/admin/pro-stats    csak admin: tényleges szám + a megjelenítési beállítás
 *  PUT /api/admin/pro-stats    csak admin: { showPublic: boolean } – a megjelenítés ki/be kapcsolása
 *
 * A nyilvános szám nem állítható kézzel: mindig a profiles táblából, a PRO-
 * jogosultsággal AZONOS szabállyal számolódik. Ez a modul a profiles táblát
 * csak OLVASSA (darabszám) – előfizetési mezőt, lejáratot, billinget nem ír.
 * A beállítás az `app_settings` táblában él (tartós, minden szerverpéldány
 * ugyanazt látja; új deploy után is megmarad).
 */
import { Router, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { planOf } from './entitlement';
import { ACTIVE_PRO_DEFINITION, PRO_COUNTER_SETTING_KEY, type AdminProStats, type PublicProCount } from '../../shared/proStats';

/** A beállítások tára – a meglévő `Database` (app_settings) felülete. */
export interface SettingsStore {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

/** A ténylegesen aktív PRO-k számát adja (null: nem számolható, pl. Supabase nélküli helyi mód). */
export type ActiveProCounter = () => Promise<number>;

interface CounterSetting { showPublic: boolean; updatedAt: string | null; updatedBy: string | null }
const DEFAULT_SETTING: CounterSetting = { showPublic: true, updatedAt: null, updatedBy: null };

/** A tárolt beállítás szigorú értelmezése; sérült/hiányzó érték → alapértelmezés (megjelenítés bekapcsolva). */
function parseSetting(raw: string | null): CounterSetting {
  if (!raw) return { ...DEFAULT_SETTING };
  try {
    const v = JSON.parse(raw) as Partial<CounterSetting>;
    return {
      showPublic: typeof v.showPublic === 'boolean' ? v.showPublic : DEFAULT_SETTING.showPublic,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
      updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
    };
  } catch { return { ...DEFAULT_SETTING }; }
}

/**
 * Aktív PRO-k száma a Supabase-ből: subscription_status = 'pro' ÉS (nincs lejárat VAGY a lejárat a jövőben).
 * Ugyanaz a szabály, mint a `profileIsPro` és az `is_pro()` – csak darabszám, személyes adat nélkül.
 */
export function supabaseActiveProCounter(db: SupabaseClient, now: () => Date = () => new Date()): ActiveProCounter {
  return async () => {
    const { count, error } = await db.from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('subscription_status', 'pro')
      .or(`subscription_end.is.null,subscription_end.gt.${now().toISOString()}`);
    if (error) throw new Error(`[pro-stats] aktív PRO-k száma: ${error.message}`);
    return count ?? 0;
  };
}

/** A nyilvános végpont rövid gyorsítótára (ne fusson darabszám-lekérdezés minden oldalbetöltésre). */
const PUBLIC_TTL_MS = 60_000;

export function proStatsRouters(settings: SettingsStore, counter: ActiveProCounter | null, now: () => number = Date.now) {
  let cache: { at: number; value: PublicProCount } | null = null;

  const pub = Router();
  pub.get('/', async (_req, res) => {
    try {
      if (cache && now() - cache.at < PUBLIC_TTL_MS) return res.json(cache.value);
      const s = parseSetting(await settings.getSetting(PRO_COUNTER_SETTING_KEY));
      const value: PublicProCount = s.showPublic && counter ? { show: true, count: await counter() } : { show: false, count: null };
      cache = { at: now(), value };
      res.json(value);
    } catch (e) {
      // hiba esetén SEMMILYEN számot nem mutatunk (nincs tartalék/kitalált érték)
      console.error('[pro-stats] nyilvános:', (e as Error).message);
      res.status(503).json({ error: 'A PRO-felhasználók száma most nem érhető el.' });
    }
  });

  const admin = Router();
  admin.get('/', async (_req, res) => {
    try {
      const s = parseSetting(await settings.getSetting(PRO_COUNTER_SETTING_KEY));
      const out: AdminProStats = { activeProCount: counter ? await counter() : null, ...s, definition: ACTIVE_PRO_DEFINITION };
      res.json(out);
    } catch (e) {
      console.error('[pro-stats] admin:', (e as Error).message);
      res.status(500).json({ error: 'A PRO-statisztika nem tölthető be.' });
    }
  });

  /**
   * A megjelenítés ki/be kapcsolása. A törzsből KIZÁRÓLAG a `showPublic` (boolean)
   * olvasódik ki – számot nem fogad el. Az írás idempotens célállapot-beállítás,
   * így két egyidejű admin-művelet sem okozhat köztes, hibás értéket.
   */
  admin.put('/', async (req, res: Response) => {
    const showPublic = req.body?.showPublic;
    if (typeof showPublic !== 'boolean') {
      return res.status(400).json({ error: 'A showPublic mező kötelező, és csak true/false lehet.', code: 'BAD_REQUEST' });
    }
    try {
      const next: CounterSetting = { showPublic, updatedAt: new Date(now()).toISOString(), updatedBy: planOf(res).user?.id ?? 'local-admin' };
      await settings.setSetting(PRO_COUNTER_SETTING_KEY, JSON.stringify(next));
      cache = null; // a nyilvános oldal azonnal az új beállítást lássa
      const stored = parseSetting(await settings.getSetting(PRO_COUNTER_SETTING_KEY));
      const out: AdminProStats = { activeProCount: counter ? await counter() : null, ...stored, definition: ACTIVE_PRO_DEFINITION };
      res.json(out);
    } catch (e) {
      console.error('[pro-stats] mentés:', (e as Error).message);
      res.status(500).json({ error: 'A beállítás nem mentődött.', code: 'SAVE_FAILED' });
    }
  });

  return { pub, admin };
}
