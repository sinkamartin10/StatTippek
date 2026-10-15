/**
 * A PRO-modell (xs-strength-1) bekapcsolása és admin-állapota – az index.ts-ből kiemelve, hogy a
 * vészkapcsoló (XS_MODEL_ENABLED=false) és az admin-végpont automatikus teszttel ellenőrizhető legyen.
 *
 * Kikapcsolva NEM jön létre szolgáltatás: nincs ESPN-letöltés, nincs becslés, nincs tárírás; az
 * AnalysisService `proModel = null`-lal a PRO-nak is az alap motort (xg-poisson-1) adja. Adatbázis-
 * visszaállítás nem kell – a 0021 táblák érintetlenül maradnak, újrabekapcsoláskor onnan folytat.
 */
import { Router } from 'express';
import { XsModelService, type MonthlyResultsSource, type XsServiceOptions } from './xsService';
import type { XsTrainingStore } from './xsStore';

/** A kapcsoló értelmezése: 'false' / '0' / 'off' / 'no' (kis-nagybetű és szóköz mindegy) = kikapcsolva. */
export function xsSwitchOn(value: string | undefined): boolean {
  return !['false', '0', 'off', 'no'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * A szolgáltatás létrehozása, ha szabad: csak élő ESPN-forrásnál (`source` nem null) és bekapcsolt
 * kapcsolónál. A tár csak bekapcsolt állapotban jön létre (kikapcsolva a 0021 táblákhoz sem nyúl).
 */
export function createXsModel(env: { XS_MODEL_ENABLED?: string }, source: MonthlyResultsSource | null, store: () => XsTrainingStore | null, opts?: XsServiceOptions): XsModelService | null {
  if (!source || !xsSwitchOn(env.XS_MODEL_ENABLED)) return null;
  return new XsModelService(source, store(), opts);
}

export const XS_DISABLED_STATUS = {
  modelId: 'xs-strength-1', ready: false, disabled: true,
  reason: 'A több ligás modell ki van kapcsolva (nem élő ESPN-adat vagy XS_MODEL_ENABLED=false) – a PRO is az alap motort (xg-poisson-1) kapja.',
} as const;

/** GET / → állapot (a hívó `requireAdmin` mögé köti). Személyes adatot és titkot nem tartalmaz. */
export function xsAdminRouter(xsModel: Pick<XsModelService, 'status'> | null): Router {
  const r = Router();
  r.get('/', (_req, res) => { res.json(xsModel ? xsModel.status() : XS_DISABLED_STATUS); });
  return r;
}

/** Háttérfrissítés: indulás után 15 mp-cel, majd 6 óránként; a hiba csak naplózódik. */
export function scheduleXsRefresh(xsModel: XsModelService, delays = { firstMs: 15_000, everyMs: 6 * 3600_000 }): void {
  const run = () => { void xsModel.refresh().catch((e) => console.error('[xs] frissítés hiba:', (e as Error).message)); };
  setTimeout(run, delays.firstMs).unref();
  setInterval(run, delays.everyMs).unref();
}
