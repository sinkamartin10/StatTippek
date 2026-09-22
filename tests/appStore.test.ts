/**
 * Tartós adatréteg tesztek (SQLite tartalék store – ugyanaz az interfész, mint a Postgres store).
 * Kiemelt cél: a felhasználói izoláció és a konkurencia-biztos műveletek bizonyítása.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { SqliteAppStore, outcomeFromLegs, type NewPrediction } from '../src/server/db/appStore';

// A node:sqlite beépített modul – createRequire-rel töltjük be, hogy a Vite ne próbálja feloldani
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import type { PredictionRecord } from '../src/shared/types';

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const draft = (userId: string, matchId = 'm1', market = 'O2.5'): NewPrediction => ({
  userId,
  createdAt: new Date().toISOString(),
  matchId,
  matchLabel: 'A – B',
  kickoff: '2026-10-01T18:00:00.000Z',
  leagueId: 'eng-pl',
  leagueName: 'Premier League',
  market,
  marketLabel: 'Gólszám több mint 2,5',
  modelProb: 0.62,
  odds: 1.9,
  category: 'mérsékelt',
  predictionType: 'modell',
  origin: 'live',
});

let store: SqliteAppStore;
beforeEach(() => { store = new SqliteAppStore(new DatabaseSync(':memory:')); });

describe('AppStore – felhasználói izoláció', () => {
  it('A user nem látja B user tippjeit', async () => {
    await store.savePrediction(draft(USER_A, 'm1'));
    await store.savePrediction(draft(USER_B, 'm2'));
    const a = await store.listPredictions(USER_A);
    const b = await store.listPredictions(USER_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].matchId).toBe('m1');
    expect(b[0].matchId).toBe('m2');
    expect(a[0].userId).toBe(USER_A);
  });

  it('A user nem éri el B user tippjét azonosító alapján sem', async () => {
    const pb = await store.savePrediction(draft(USER_B, 'm9'));
    expect(await store.getPredictions(USER_A, [pb.id])).toEqual([]);
    expect(await store.getPredictionByMarket(USER_A, 'm9', 'O2.5')).toBeNull();
  });

  it('A user nem tudja lezárni B user tippjét', async () => {
    const pb = await store.savePrediction(draft(USER_B, 'm3'));
    expect(await store.settlePrediction(USER_A, pb.id, 3, 0)).toBeNull();
    const fresh = await store.getPredictionByMarket(USER_B, 'm3', 'O2.5');
    expect(fresh!.outcome).toBe('függőben');
  });

  it('A user nem látja B user szelvényeit', async () => {
    const p = await store.savePrediction(draft(USER_B, 'm4'));
    await store.saveSlip({ id: 'slip-b', userId: USER_B, createdAt: new Date().toISOString(), strategy: 'legnagyobb esély', label: 'B szelvénye', legPredictionIds: [p.id], totalOdds: 1.9, jointProb: 0.62, origin: 'live' });
    expect(await store.listSlips(USER_A)).toEqual([]);
    expect(await store.listSlips(USER_B)).toHaveLength(1);
  });

  it('a függőben lévő tippek felhasználóra szűrhetők', async () => {
    await store.savePrediction(draft(USER_A, 'm1'));
    await store.savePrediction(draft(USER_B, 'm2'));
    expect(await store.pendingPredictions(USER_A)).toHaveLength(1);
    expect(await store.pendingPredictions()).toHaveLength(2); // szerveroldali karbantartáshoz
  });
});

describe('AppStore – konkurencia és integritás', () => {
  it('ugyanaz a meccs+piac felhasználónként csak egyszer (párhuzamos mentésnél is)', async () => {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.savePrediction(draft(USER_A, 'm5'))));
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(await store.listPredictions(USER_A)).toHaveLength(1);
  });

  it('két felhasználó ugyanarra a meccsre és piacra külön rekordot kap', async () => {
    const a = await store.savePrediction(draft(USER_A, 'm6'));
    const b = await store.savePrediction(draft(USER_B, 'm6'));
    expect(a.id).not.toBe(b.id);
  });

  it('lezárt tippet nem ír felül újabb lezárás', async () => {
    const p = await store.savePrediction(draft(USER_A, 'm7'));
    const first = await store.settlePrediction(USER_A, p.id, 3, 1); // O2.5 → nyert
    expect(first!.outcome).toBe('nyert');
    const second = await store.settlePrediction(USER_A, p.id, 0, 0);
    expect(second).toBeNull();
    expect((await store.getPredictionByMarket(USER_A, 'm7', 'O2.5'))!.outcome).toBe('nyert');
  });

  it('Stripe esemény igénylése atomi: csak az első hívás kapja meg', async () => {
    const claims = await Promise.all([1, 2, 3].map(() => store.claimStripeEvent('evt_1', 'checkout.session.completed')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.releaseStripeEvent('evt_1');
    expect(await store.claimStripeEvent('evt_1', 'checkout.session.completed')).toBe(true); // hiba után újrapróbálható
  });

  it('globális beállítás és kézi odds írható/olvasható', async () => {
    await store.setSetting('shrinkageK', '5');
    expect(await store.getSetting('shrinkageK')).toBe('5');
    await store.saveManualOdds({ matchId: 'm8', source: 'manual', retrievedAt: new Date().toISOString(), markets: { '1': 2.1 } });
    expect((await store.getManualOdds('m8'))!.markets['1']).toBe(2.1);
    await store.deleteManualOdds('m8');
    expect(await store.getManualOdds('m8')).toBeNull();
  });
});

describe('Szelvény kimenete a lábakból', () => {
  const leg = (outcome: PredictionRecord['outcome']): PredictionRecord => ({ ...draft(USER_A), id: 'x', outcome, homeGoals: null, awayGoals: null, settledAt: null });
  it('egy vesztes láb = vesztett szelvény', () => {
    expect(outcomeFromLegs([leg('nyert'), leg('vesztett')])).toBe('vesztett');
  });
  it('minden láb nyert = nyert', () => {
    expect(outcomeFromLegs([leg('nyert'), leg('nyert')])).toBe('nyert');
  });
  it('függőben lévő láb = függőben', () => {
    expect(outcomeFromLegs([leg('nyert'), leg('függőben')])).toBe('függőben');
  });
  it('csak érvénytelen lábak = érvénytelen', () => {
    expect(outcomeFromLegs([leg('érvénytelen'), leg('érvénytelen')])).toBe('érvénytelen');
  });
});
