/**
 * End-to-end biztonsági ellenőrzés a FUTÓ szerver ellen (fejlesztői szkript).
 *
 *   npx tsx scripts/verify-security.ts
 *
 * Mit ellenőriz:
 *   1. Hitelesítés nélkül nincs hozzáférés a PRO végpontokhoz
 *   2. FREE felhasználó nem kap PRO adatot (szerveroldali kitakarás)
 *   3. User A nem látja/nem módosítja User B tippjeit és szelvényeit  ← kiemelt
 *   4. A kliens által küldött user_id-t a szerver figyelmen kívül hagyja
 *   5. RLS: a felhasználó saját tokenjével is csak a saját sorait látja
 *   6. Stripe webhook: aláírás-ellenőrzés + idempotencia
 *
 * Két ideiglenes teszt-felhasználót hoz létre, és a végén TÖRLI őket.
 * A service_role kulcsot csak a szkript (szerveroldal) használja, kimenetbe sosem írja.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const API = process.env.VERIFY_API ?? 'http://localhost:3001';
const SUPA_URL = (process.env.SUPABASE_URL ?? '').trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ANON_KEY = (process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

const admin = createClient(SUPA_URL, SERVICE_KEY, { auth: { persistSession: false } });

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}

async function api(path: string, token?: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as Record<string, unknown> & unknown[] };
}

async function makeUser(email: string, password: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`teszt-felhasználó létrehozása: ${error.message}`);
  const anon = createClient(SUPA_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: s, error: e2 } = await anon.auth.signInWithPassword({ email, password });
  if (e2 || !s.session) throw new Error(`teszt-bejelentkezés: ${e2?.message}`);
  return { id: data.user!.id, token: s.session.access_token };
}

const stamp = Date.now();
const emailA = `teszt.a.${stamp}@example.com`;
const emailB = `teszt.b.${stamp}@example.com`;
let userA: { id: string; token: string } | null = null;
let userB: { id: string; token: string } | null = null;

try {
  console.log(`API: ${API}\n`);

  // ---------------------------------------------------------------- 1
  console.log('1) Hitelesítés nélkül:');
  check('GET /api/history → 401', (await api('/api/history')).status === 401);
  check('GET /api/slips/saved → 401', (await api('/api/slips/saved')).status === 401);
  check('POST /api/matches/x/predictions → 401', (await api('/api/matches/x/predictions', undefined, { method: 'POST', body: JSON.stringify({ market: '1' }) })).status === 401);
  check('POST /api/settings (admin) → 401', (await api('/api/settings', undefined, { method: 'POST', body: JSON.stringify({ shrinkageK: 9 }) })).status === 401);

  userA = await makeUser(emailA, `Teszt-${stamp}-A!`);
  userB = await makeUser(emailB, `Teszt-${stamp}-B!`);
  console.log(`\n  (teszt-felhasználók létrehozva: A=${userA.id.slice(0, 8)}…, B=${userB.id.slice(0, 8)}…)\n`);

  // ---------------------------------------------------------------- 2
  console.log('2) FREE felhasználó PRO adathoz:');
  const hist = await api('/api/history', userA.token);
  check('GET /api/history FREE tokennel → 403 PRO_REQUIRED', hist.status === 403, `kapott: ${hist.status}`);
  const slips = await api('/api/slips?from=2026-09-26&to=2026-09-26', userA.token);
  check('GET /api/slips FREE tokennel → 403', slips.status === 403, `kapott: ${slips.status}`);
  const tips = await api('/api/tips?date=2026-09-26', userA.token);
  const tipList = (tips.body as unknown as { tip: { reasonsFor: string[] } }[]) ?? [];
  check('GET /api/tips FREE: legfeljebb 3 tipp', Array.isArray(tipList) && tipList.length <= 3, `kapott: ${tipList.length}`);
  check('GET /api/tips FREE: nincs modell-indoklás', tipList.every((t) => t.tip.reasonsFor.length === 0));

  // ---------------------------------------------------------------- 3
  console.log('\n3) PRO jogosultság + felhasználói izoláció:');
  // Mindkét felhasználót PRO-ra állítjuk (szerveroldalról, ahogy a Stripe webhook tenné)
  for (const u of [userA, userB]) {
    const { error } = await admin.from('profiles').update({ subscription_status: 'pro', subscription_end: new Date(Date.now() + 30 * 86400000).toISOString() }).eq('id', u.id);
    if (error) throw new Error(`profil PRO-ra állítása: ${error.message}`);
  }
  await new Promise((r) => setTimeout(r, 61_000)); // a szerver jogosultság-cache TTL-je 60 mp

  const day = await api('/api/matches?date=2026-09-26');
  const matches = (day.body as unknown as { id: string }[]) ?? [];
  if (matches.length < 2) throw new Error('nincs elég mérkőzés a teszthez');
  const matchA = matches[0].id, matchB = matches[1].id;

  const saveA = await api(`/api/matches/${encodeURIComponent(matchA)}/predictions`, userA.token, { method: 'POST', body: JSON.stringify({ market: 'O1.5' }) });
  check('A user menthet tippet (PRO) → 200', saveA.status === 200, `kapott: ${saveA.status} ${JSON.stringify(saveA.body).slice(0, 120)}`);
  const saveB = await api(`/api/matches/${encodeURIComponent(matchB)}/predictions`, userB.token, { method: 'POST', body: JSON.stringify({ market: 'O1.5' }) });
  check('B user menthet tippet (PRO) → 200', saveB.status === 200, `kapott: ${saveB.status}`);

  const histA = await api('/api/history', userA.token);
  const histB = await api('/api/history', userB.token);
  const predsA = ((histA.body as unknown as { predictions: { matchId: string; userId: string }[] }).predictions) ?? [];
  const predsB = ((histB.body as unknown as { predictions: { matchId: string; userId: string }[] }).predictions) ?? [];
  check('A user csak a SAJÁT tippjét látja', predsA.length === 1 && predsA[0].matchId === matchA, `A: ${predsA.map((p) => p.matchId).join(',')}`);
  check('B user csak a SAJÁT tippjét látja', predsB.length === 1 && predsB[0].matchId === matchB, `B: ${predsB.map((p) => p.matchId).join(',')}`);
  check('A user nem látja B tippjét', !predsA.some((p) => p.matchId === matchB));
  check('minden sor a helyes tulajdonoshoz tartozik', predsA.every((p) => p.userId === userA!.id) && predsB.every((p) => p.userId === userB!.id));

  // Szelvény A-nak: csak oddsszal rendelkező lábak kerülhetnek rá
  const withOdds: { matchId: string; market: string }[] = [];
  for (const m of matches.slice(0, 12)) {
    const an = await api(`/api/matches/${encodeURIComponent(m.id)}/analysis`, userA.token);
    const tips = ((an.body as unknown as { tips?: { market: string; odds: number | null }[] }).tips) ?? [];
    const t = tips.find((x) => x.odds != null && x.odds > 1);
    if (t) withOdds.push({ matchId: m.id, market: t.market });
    if (withOdds.length === 2) break;
  }
  check('van legalább 2 oddsszal rendelkező láb a szelvényteszthez', withOdds.length === 2, `talált: ${withOdds.length}`);
  const slipLegs = withOdds;
  const slipA = await api('/api/slips', userA.token, { method: 'POST', body: JSON.stringify({ strategy: 'legnagyobb esély', label: 'A szelvénye', legs: slipLegs }) });
  check('A user menthet szelvényt → 200', slipA.status === 200, `kapott: ${slipA.status} ${JSON.stringify(slipA.body).slice(0, 120)}`);
  const savedA = await api('/api/slips/saved', userA.token);
  const savedB = await api('/api/slips/saved', userB.token);
  check('A user látja a saját szelvényét', Array.isArray(savedA.body) && savedA.body.length === 1);
  check('B user NEM látja A szelvényét', Array.isArray(savedB.body) && savedB.body.length === 0, `B: ${JSON.stringify(savedB.body).slice(0, 80)}`);
  // odds nélküli láb elutasítása (adatintegritás)
  const badSlip = await api('/api/slips', userA.token, { method: 'POST', body: JSON.stringify({ strategy: 'legnagyobb esély', label: 'hibás', legs: [{ matchId: matchA, market: 'CS_9-9' }, { matchId: matchB, market: 'CS_9-9' }] }) });
  check('odds nélküli lábakkal a szelvény elutasítva → 400', badSlip.status === 400, `kapott: ${badSlip.status}`);

  // ---------------------------------------------------------------- 4
  console.log('\n4) Hamisított user_id a kérésben:');
  const forged = await api(`/api/matches/${encodeURIComponent(matchB)}/predictions`, userA.token, {
    method: 'POST',
    body: JSON.stringify({ market: 'O2.5', user_id: userB!.id, userId: userB!.id }),
  });
  check('a beküldött user_id-t figyelmen kívül hagyja', forged.status === 200);
  const histB2 = await api('/api/history', userB.token);
  const predsB2 = ((histB2.body as unknown as { predictions: { market: string }[] }).predictions) ?? [];
  check('a tipp NEM B userhez került', !predsB2.some((p) => p.market === 'O2.5'), `B tippjei: ${predsB2.map((p) => p.market).join(',')}`);

  // ---------------------------------------------------------------- 5
  console.log('\n5) RLS közvetlen adatbázis-hozzáférésnél (felhasználói token):');
  const asA = createClient(SUPA_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${userA.token}` } }, auth: { persistSession: false } });
  const { data: rlsRows } = await asA.from('predictions').select('*');
  check('A user saját tokennel csak a saját sorait látja', (rlsRows ?? []).every((r: { user_id: string }) => r.user_id === userA!.id), `sorok: ${(rlsRows ?? []).length}`);
  const { error: rlsWrite } = await asA.from('predictions').update({ outcome: 'nyert' }).eq('user_id', userA.id);
  const { data: afterWrite } = await asA.from('predictions').select('outcome');
  check('A user saját tokennel NEM írhatja át a kimenetet', !!rlsWrite || (afterWrite ?? []).every((r: { outcome: string }) => r.outcome !== 'nyert'), rlsWrite ? rlsWrite.message.slice(0, 60) : 'az update átment!');
  const { data: bRows } = await asA.from('slips').select('*');
  check('A user saját tokennel nem lát idegen szelvényt', (bRows ?? []).every((r: { user_id: string }) => r.user_id === userA!.id));

  // ---------------------------------------------------------------- 6
  console.log('\n6) Stripe webhook:');
  const whSecret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  const stripe = new Stripe((process.env.STRIPE_SECRET_KEY ?? 'sk_test_dummy').trim());
  const bad = await fetch(`${API}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=hamis' }, body: '{"id":"evt_x","type":"ping"}' });
  check('érvénytelen aláírás → 400', bad.status === 400, `kapott: ${bad.status}`);
  if (whSecret) {
    const payload = JSON.stringify({ id: `evt_verify_${stamp}`, object: 'event', type: 'ping', data: { object: {} } });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: whSecret });
    const first = await fetch(`${API}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
    const firstBody = await first.json();
    const second = await fetch(`${API}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
    const secondBody = await second.json();
    check('érvényes aláírás → 200', first.status === 200 && firstBody.received === true);
    check('ismételt esemény → duplikátumként felismerve', secondBody.duplicate === true, JSON.stringify(secondBody));
    await admin.from('stripe_events').delete().eq('id', `evt_verify_${stamp}`);
  } else {
    console.log('  (STRIPE_WEBHOOK_SECRET nincs beállítva – az aláírt teszt kimarad)');
  }
} catch (e) {
  failed++;
  console.error('\n!!! A verifikáció megszakadt:', (e as Error).message);
} finally {
  // Takarítás: teszt-felhasználók törlése (a predictions/slips cascade-del törlődik)
  for (const u of [userA, userB]) {
    if (u) {
      const { error } = await admin.auth.admin.deleteUser(u.id);
      console.log(error ? `\n  (figyelem: a teszt-felhasználó törlése sikertelen: ${error.message})` : `\n  (teszt-felhasználó törölve: ${u.id.slice(0, 8)}…)`);
    }
  }
  console.log(`\n=== Eredmény: ${passed} sikeres, ${failed} sikertelen ===`);
  process.exitCode = failed ? 1 : 0;
}
