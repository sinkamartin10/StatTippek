/**
 * Modell-kalibráció – KIZÁRÓLAG ADMIN végpontok (a `requireAdmin` alá kötve).
 *
 *   GET  /status            – aktív/jelölt verziók, utolsó futás, metrikák, okok
 *   POST /evaluate          – korlátos, zárral védett kiértékelés indítása
 *   POST /shadow-evaluate/:modelId – prospektív, mintán kívüli kiértékelés
 *   POST /promote/:modelId  – explicit aktiválás (élesben jelenleg tiltva)
 *   POST /rollback          – visszaállítás az utolsó ismert jó állapotra
 *
 * Nyilvános végpont nincs: a nyilvános felület nem állítja, hogy a modell
 * „tanul”. A belső hiba részlete nem kerül a válaszba.
 */
import { Router, type Response } from 'express';
import { planOf } from '../billing/entitlement';
import type { ModelLearningService } from '../modelLearning/service';

const ID = /^cal-[0-9a-f]{12}$/;

/** Az auditba kerülő szereplő: a hitelesített felhasználó azonosítója (e-mail nem). */
function actorOf(res: Response): string {
  const plan = planOf(res);
  return plan.user?.id ?? (plan.enforced ? 'unknown' : 'local-admin');
}

function fail(res: Response, e: unknown): void {
  console.error('[model-learning]', e);
  res.status(500).json({ error: 'A művelet most nem hajtható végre.', code: 'MODEL_LEARNING_ERROR' });
}

export function modelLearningRouter(svc: ModelLearningService): Router {
  const r = Router();

  r.get('/status', async (_req, res) => {
    try { res.json(await svc.status()); } catch (e) { fail(res, e); }
  });

  r.post('/evaluate', async (_req, res) => {
    try {
      const result = await svc.evaluate(actorOf(res));
      if (result.status === 'locked') {
        res.status(409).json({ error: 'Már fut egy kiértékelés.', code: 'EVALUATION_RUNNING' });
        return;
      }
      res.status(result.status === 'failed' ? 500 : 200).json(result);
    } catch (e) { fail(res, e); }
  });

  // Prospektív (árnyék) kiértékelés egy meglévő jelöltre – a felhasználói kimenet nem változik
  r.post('/shadow-evaluate/:modelId', async (req, res) => {
    const id = String(req.params.modelId ?? '');
    if (!ID.test(id)) { res.status(400).json({ error: 'Érvénytelen modell-azonosító.', code: 'BAD_REQUEST' }); return; }
    try {
      const out = await svc.evaluateShadow(id, actorOf(res));
      if (out.status === 'locked') { res.status(409).json({ error: 'Már fut egy kiértékelés.', code: 'EVALUATION_RUNNING' }); return; }
      if (out.status === 'not_found') { res.status(404).json({ error: 'Ismeretlen jelölt.', code: 'NOT_FOUND' }); return; }
      if (out.status === 'invalid') { res.status(409).json({ error: 'A jelölt nem kompatibilis vagy érvénytelen.', code: 'INVALID' }); return; }
      res.status(out.status === 'failed' ? 500 : 200).json(out);
    } catch (e) { fail(res, e); }
  });

  r.post('/promote/:modelId', async (req, res) => {
    const id = String(req.params.modelId ?? '');
    if (!ID.test(id)) { res.status(400).json({ error: 'Érvénytelen modell-azonosító.', code: 'BAD_REQUEST' }); return; }
    try {
      const out = await svc.promote(id, actorOf(res));
      res.status(out.ok ? 200 : out.code === 'NOT_FOUND' ? 404 : 409).json(out);
    } catch (e) { fail(res, e); }
  });

  r.post('/rollback', async (_req, res) => {
    try {
      const out = await svc.rollback(actorOf(res));
      res.status(out.ok ? 200 : 409).json(out);
    } catch (e) { fail(res, e); }
  });

  return r;
}
