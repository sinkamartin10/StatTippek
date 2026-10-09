/**
 * Modell-tipp archívum – NYILVÁNOS, csak olvasható API.
 *
 *  - bejelentkezés nélkül is elérhető: csak MÁR ELKEZDŐDÖTT meccsek tippjeit
 *    adja ki, így a jövőbeli (PRO) tippeket nem fedi fel, és a meglévő
 *    FREE/PRO szabályon nem változtat,
 *  - minden paraméter ellenőrzött; a lapméret és a lapozás mélysége kötött,
 *  - a válasz allowlist szerinti mezőket tartalmaz (lásd toEntry) – belső
 *    hash, felhasználói adat, kutatási forrás vagy indoklás nincs benne.
 *
 * A rate limitet a meglévő, globális `/api` korlát adja.
 */
import { Router } from 'express';
import { TipArchiveError, type TipArchiveService } from '../tipArchive/service';

export function tipArchiveRouter(svc: TipArchiveService): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    try {
      res.json(await svc.query(req.query as Record<string, unknown>));
    } catch (e) {
      if (e instanceof TipArchiveError) {
        res.status(e.status).json({ error: e.message, code: e.code });
        return;
      }
      // A belső hiba részlete SOHA nem megy ki a válaszba
      console.error('[tip-archive]', e);
      res.status(500).json({ error: 'Az archívum most nem érhető el.', code: 'TIP_ARCHIVE_ERROR' });
    }
  });

  return r;
}
