/**
 * In-app értesítések API.
 *
 * Biztonsági elvek (a meglévő rendszerrel azonosak):
 *  - a hívót KIZÁRÓLAG a hitelesített Supabase token azonosítja
 *    (res.locals.plan.user.id); a kérés törzsében küldött user_id / userId
 *    mezőt SOHA nem olvassuk ki,
 *  - a type / title / body / read_at / metadata mezőket a kérésből figyelmen
 *    kívül hagyjuk – értesítést kizárólag a szerver hoz létre,
 *  - FREE és PRO egyaránt használhatja: csak bejelentkezés kell.
 */
import { Router, type Response } from 'express';
import { planOf, requireAuthenticated } from '../billing/entitlement';
import { NotificationError, type NotificationService } from '../notifications/service';
import { NOTIFICATION_DEFAULT_LIMIT, NOTIFICATION_MAX_LIMIT } from '../../shared/notifications';

const UUID = /^[0-9a-fA-F-]{36}$/;
const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

/** A művelet tulajdonosa: kizárólag a hitelesített tokenből. */
function ownerId(res: Response): string | null {
  const plan = planOf(res);
  if (!plan.enforced) return LOCAL_USER_ID;
  return plan.user?.id ?? null;
}

/** Az útvonal :id paramétere ellenőrzött alakban (Express 5 string | string[]-et ad). */
const idOf = (req: { params: Record<string, unknown> }): string =>
  (typeof req.params.id === 'string' ? req.params.id : '');

const needAuth = (res: Response) => res.status(401).json({ error: 'Bejelentkezés szükséges.', code: 'AUTH_REQUIRED' });
const badId = (res: Response) => res.status(400).json({ error: 'Érvénytelen azonosító.', code: 'INVALID_ID' });

function handle(res: Response, e: unknown): void {
  if (e instanceof NotificationError) { res.status(e.status).json({ error: e.message, code: e.code }); return; }
  console.error('[notifications]', e);
  res.status(500).json({ error: 'Szerverhiba az értesítések feldolgozásakor.' });
}

const q = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function notificationsRouter(svc: NotificationService): Router {
  const r = Router();

  /**
   * Saját értesítések egy lapja + az olvasatlanok száma UGYANEBBEN a válaszban.
   * Cursor-alapú lapozás (`before`), nem offset: a lista eleje folyamatosan nő,
   * offsettel a lapok elcsúsznának és duplikált sort adnának.
   * A lusta újraszármaztatás itt fut le (lásd notifications/service.ts).
   */
  r.get('/', requireAuthenticated, async (req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);

    const raw = parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, NOTIFICATION_MAX_LIMIT) : NOTIFICATION_DEFAULT_LIMIT;

    const before = q(req.query.before);
    if (before && Number.isNaN(new Date(before).getTime())) {
      return res.status(400).json({ error: 'Érvénytelen cursor.', code: 'INVALID_CURSOR' });
    }

    try { res.json(await svc.list(userId, { limit, before })); } catch (e) { handle(res, e); }
  });

  /** Egy értesítés olvasottra állítása. Idegen értesítés nem jelölhető meg. */
  r.post('/:id/read', requireAuthenticated, async (req, res) => {
    const id = idOf(req);
    if (!UUID.test(id)) return badId(res);
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json({ notification: await svc.markRead(userId, id) }); } catch (e) { handle(res, e); }
  });

  /** Minden olvasatlan megjelölése olvasottként. */
  r.post('/read-all', requireAuthenticated, async (_req, res) => {
    const userId = ownerId(res);
    if (!userId) return needAuth(res);
    try { res.json({ updated: await svc.markAllRead(userId) }); } catch (e) { handle(res, e); }
  });

  return r;
}
