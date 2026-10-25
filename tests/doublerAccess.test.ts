/**
 * Duplázó – PRO-jogosultság. A szelvényeket kizárólag a meglévő, szerveroldalon PRO-hoz kötött
 * `GET /api/slips` adja; a felület FREE-nek a meglévő PRO-zárat mutatja. A csomagot itt a
 * `usePlan` helyettesítése adja (ugyanaz a minta, mint a többi felületi tesztnél: DOM nincs).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const plan = vi.hoisted(() => ({ pro: false }));
vi.mock('../src/client/auth/PlanContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/auth/PlanContext')>()),
  usePlan: () => ({ configured: true, loggedIn: true, loading: false, pro: plan.pro, profile: null, error: null, reload: async () => {} }),
}));

import Doubler from '../src/client/pages/Doubler';
import { requirePro } from '../src/server/billing/entitlement';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const page = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Doubler)));

describe('Duplázó – FREE / PRO megjelenítés', () => {
  it('FREE: a lépésterv látszik, a szelvények helyén a meglévő PRO-zár; generáló gomb nincs', () => {
    plan.pro = false;
    const out = page();
    expect(out).toContain('Duplázó – PRO');
    expect(out).toContain('PRO kipróbálása');
    expect(out).toContain('2 000 Ft'); // a duplázás matematikája tipp nélkül is látható
    expect(out).not.toContain('Szelvény generálása');
  });

  it('PRO: a generáló gomb elérhető, PRO-zár nincs', () => {
    plan.pro = true;
    const out = page();
    expect(out).toContain('Szelvény generálása');
    expect(out).not.toContain('Duplázó – PRO');
  });

  it('a Duplázó kizárólag a meglévő `api.slips` végpontot hívja (nincs PRO-t megkerülő kliensútvonal)', () => {
    const calls = new Set([...read('src/client/pages/Doubler.tsx').matchAll(/\bapi\.(\w+)/g), ...read('src/client/lib/doubler.ts').matchAll(/\bapi\.(\w+)/g)].map((m) => m[1]));
    expect([...calls]).toEqual(['slips']);
  });
});

describe('Duplázó – szerveroldali jogosultság (változatlan)', () => {
  it('az index.ts a `/api/slips` útvonalat a meglévő `requirePro` mögé teszi, az API-router előtt', () => {
    const src = read('src/server/index.ts');
    const guard = src.indexOf("app.use(['/api/slips', '/api/history'], requirePro);");
    const router = src.indexOf("app.use('/api', apiRouter(");
    expect(guard).toBeGreaterThan(-1);
    expect(router).toBeGreaterThan(guard);
  });

  it('a valódi `requirePro`: vendég 401, FREE 403, PRO 200 – a szelvény FREE-nek nem jut ki', async () => {
    const app = express();
    app.use('/api', (req, res, next) => {
      const who = req.header('x-test-plan');
      res.locals.plan = { enforced: true, user: who ? { id: 'u1', email: 'x@pelda.hu' } : null, pro: who === 'pro', admin: false };
      next();
    });
    app.use(['/api/slips'], requirePro);
    app.get('/api/slips', (_req, res) => { res.json({ slips: ['PRO-TARTALOM'] }); });
    const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/slips`;
    try {
      const as = async (who?: string) => {
        const res = await fetch(url, { headers: who ? { 'x-test-plan': who } : {} });
        return { status: res.status, text: await res.text() };
      };
      const guest = await as();
      const free = await as('free');
      const pro = await as('pro');
      expect(guest.status).toBe(401);
      expect(free.status).toBe(403);
      expect(free.text).toContain('PRO_REQUIRED');
      expect(free.text).not.toContain('PRO-TARTALOM');
      expect(pro.status).toBe(200);
      expect(pro.text).toContain('PRO-TARTALOM');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
