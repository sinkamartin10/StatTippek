# Heti PRO-csomag (kézi fizetés)

A heti PRO (1 490 Ft / 7 nap = pontosan 168 óra) csak kézi fizetéssel (banki átutalás / Revolut)
rendelhető, admin-jóváhagyással, automatikus megújulás nélkül. A havi csomag (ajánlott, alapértelmezett)
ettől függetlenül mindig rendelhető.

## Kapcsoló: `PRO_WEEKLY_ENABLED`
- **Alapértelmezés: TILTVA.** Csak `true` / `1` / `on` / `yes` engedélyezi – kis-nagybetű és a körülötte
  lévő szóközök mindegy (pl. ` TRUE ` is engedélyez). Hiányzó, üres vagy bármilyen más érték
  (pl. `false`, `0`, `enabled`) → tiltva.
- Csak a szerver környezeti változójából olvasódik (kérésenként); a kliens (törzs, query, fejléc) nem
  írhatja felül.
- **Tiltva:**
  - a `GET /api/pro-payments` válaszában a `plans` csak a havi csomagot tartalmazza;
  - a heti új rendelés (`POST /api/pro-payments`, `plan: 'week'`) **503 `PLAN_UNAVAILABLE`** választ
    kap, és **nem jön létre** fizetési kérelem – a heti rendelésből soha nem lesz csendben havi;
  - a `plan` nélküli (régi) kliens változatlanul havi rendelést ad le; érvénytelen `plan` továbbra is
    400 `INVALID_PLAN`.
- **A meglévő heti kérelmek adminisztrációja a kapcsolótól független:** az admin lista
  (`/admin/pro-befizetesek`), a jóváhagyás (pontosan 168 óra PRO) és az elutasítás tiltott állapotban is
  működik.
- Indításkor a szervernapló kiírja: `Heti PRO-csomag: rendelhető` / `Heti PRO-csomag: TILTVA …`.

## Éles engedélyezés – sorrend
1. A `supabase/migrations/0022_pro_payment_weekly.sql` migráció **sikeresen lefutott** az éles adatbázison.
2. Az **adatbázis utóellenőrzése sikeres** (csak olvasó lekérdezések, lent). Ha bármelyik eltér,
   a kapcsolót NE kapcsold be.
3. Ezután: Render → backend szolgáltatás → *Environment* → `PRO_WEEKLY_ENABLED` = `true` → *Save*
   (a Render újraindítja a szolgáltatást). Ellenőrzés: a fenti naplósor, és a `GET /api/pro-payments`
   `plans` listájában megjelenik a `week`.

A 0022 nélkül bekapcsolt kapcsoló mellett a heti rendelést az adatbázis-megszorítás utasítaná el
(503 `PLAN_UNAVAILABLE`) – ezért a sorrend kötelező, nem csak ajánlott.

### Utóellenőrzés a 0022 után (csak olvasás)
```sql
-- 1) a megszorítás engedi a 'week' értéket (pontosan egy billing_interval CHECK)
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.pro_payment_requests'::regclass and contype = 'c'
   and pg_get_constraintdef(oid) like '%billing_interval%';
-- elvárt: egy sor, pro_payment_requests_billing_interval_check,
--         CHECK ((billing_interval = ANY (ARRAY['week'::text, 'month'::text, 'year'::text])))

-- 2) a függvény törzse a 0022-é, biztonsági beállításai változatlanok
select md5(replace(prosrc, E'\r', '')) as body_md5, prosecdef, proconfig
  from pg_proc where oid = 'public.approve_pro_payment_request(uuid, text)'::regprocedure;
-- elvárt: 2797b02b96e1aa460973bb93e82f7ff9 | false | {search_path=""}

-- 3) jogok: csak a service_role hívhatja
select has_function_privilege('anon', 'public.approve_pro_payment_request(uuid, text)', 'EXECUTE') as anon,
       has_function_privilege('authenticated', 'public.approve_pro_payment_request(uuid, text)', 'EXECUTE') as authenticated,
       has_function_privilege('service_role', 'public.approve_pro_payment_request(uuid, text)', 'EXECUTE') as service_role;
-- elvárt: false | false | true
```

## Letiltás (vészkikapcsolás)
Render → *Environment* → `PRO_WEEKLY_ENABLED` = `false` (vagy a változó törlése) → *Save*. Adatbázis-művelet
nem kell; a meglévő heti kérelmek továbbra is jóváhagyhatók / elutasíthatók, a havi csomag változatlan.
A 0022 sémaszintű visszafordítása külön, ellenőrzött rollback-terv szerint történik – annak első lépése ez
a letiltás (a backend ezen változatával).

A kapcsoló a Renderen jelenleg NINCS beállítva (ezt ez a dokumentum nem állítja be).
