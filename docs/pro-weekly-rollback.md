# Heti PRO – a 0022 visszafordítása (rollback-terv)

> **Állapot:** a terv helyben, eldobható PostgreSQL 17 adatbázison tesztelve (lásd 8. pont).
> **Élesben NEM igazolt** – amíg az éles előellenőrzés (3. pont) nem igazolja a tulajdonost, az ACL-t,
> a PostgreSQL-verziót, a megszorítást, a függvénytörzset és a rekordokat, a rollback élesben nem
> tekinthető végrehajthatónak. A helyi tesztek az éles Supabase-állapotot nem bizonyítják.

> **Fontos figyelmeztetések**
> - **A 0022 fájl a repóban marad.** A rollback után a `supabase/migrations/0022_pro_payment_weekly.sql`
>   továbbra is a repóban van, és nincs migrációs napló: ha bárki (kézzel vagy egy „összes migráció”
>   futtatással) újra lefuttatja, a heti séma visszaáll (helyben igazolva: a 0022 a rollback után
>   hibátlanul újrafuttatható).
> - **Az ACL a 0022 utáni marad.** A rollback a függvény jelenlegi (0022 utáni) ACL-jét tartja meg. Ez csak
>   akkor egyenértékű a 0022 előtti éles ACL-lel, ha az a 0020 elvárásának (tulajdonos + `service_role`
>   EXECUTE) valóban megfelelt – ezt utólag nem lehet ellenőrizni, ha nincs róla mentés.
> - **Új OID a megszorításnak.** A megszorítás törlése és újralétrehozása miatt új OID-t kap (és a
>   katalógusbeli sorrendje is változhat). Ez nem szemantikai eltérés: a név, a teljes definíció és a
>   validált állapot azonos a 0020-éval – a terv ezeket ellenőrzi, az OID-t nem.
> - **Az alkalmazáskódról külön döntés kell.** A rollback csak a sémát állítja vissza; a heti csomagot
>   kezelő alkalmazáskód (és a `PRO_WEEKLY_ENABLED` kapcsoló) a helyén marad. Az eltávolításáról a
>   rollback és az utóellenőrzés után külön kell dönteni (lásd 7. pont).
> - A [`pro-weekly.md`](pro-weekly.md) erre a dokumentumra jelenleg **nem hivatkozik linkkel**.

Kapcsolódó: [`pro-weekly.md`](pro-weekly.md) (a `PRO_WEEKLY_ENABLED` kapcsoló),
`supabase/migrations/0022_pro_payment_weekly.sql`, `supabase/migrations/0020_pro_payment_requests.sql`.

## 1. Cél és hatókör

A `0022_pro_payment_weekly.sql` **sémaszintű** visszafordítása a 0020 állapotra:

- a `public.pro_payment_requests_billing_interval_check` megszorítás vissza: `('month', 'year')`;
- a `public.approve_pro_payment_request(uuid, text)` függvény vissza a 0020 törzsére (heti ág nélkül),
  ugyanazzal a fejléccel (`returns jsonb`, `plpgsql`, `security invoker`, `set search_path = ''`);
- a függvény megjegyzése vissza a 0020 szövegére.

A kettőt **együtt, egy tranzakcióban** kell visszaállítani: csak a függvény visszaállítása mellett a
megszorítás továbbra is engedné a `'week'` értéket, és egy heti kérelem jóváhagyása 1 hónapot adna;
csak a megszorításé mellett a függvény heti ága halott kód lenne. (A 0020 egyszerű újrafuttatása ezért
NEM rollback: a `create table if not exists` a megszorítást nem állítja vissza.)

**Nem tesz:** fizetési kérelmet nem töröl, nem módosít, `'week'` értéket **nem ír át** `'month'`-ra;
a `profiles` táblához (előfizetésekhez) nem nyúl; jogot nem ad és nem von el (a függvény ACL-je a
`create or replace` alatt megmarad – ezt a terv ellenőrzi); az őr-triggerhez, indexekhez nem nyúl.

**Biztonságos alapállapot:** ha bármely előfeltétel hiányzik, NINCS sémaszintű rollback – a heti
rendelés letiltva (`PRO_WEEKLY_ENABLED` ki), a 0022 séma marad. Ez az állapot korlátlan ideig
biztonságos: a havi csomag és a meglévő heti kérelmek kezelése működik.

## 2. Előfeltételek és leállási feltételek

Az alábbiak MIND teljesüljenek, különben **állj meg** (a 0022 marad):

1. Az éles backend az a verzió, amelyben a `PRO_WEEKLY_ENABLED` kapcsoló létezik (lásd 7. pont), és a
   kapcsoló KI van kapcsolva; igazolva: a heti rendelés `503 PLAN_UNAVAILABLE`, a `GET /api/pro-payments`
   `plans` listájában csak `month` van.
2. Az előellenőrzés (3. pont) minden lekérdezése az elvárt értéket adja:
   - nincs `'week'`, `NULL` vagy ismeretlen `billing_interval` értékű kérelem (E3);
   - a `billing_interval` oszlop `NOT NULL`, típusa `text` (E4);
   - pontosan **egy** `billing_interval` CHECK van, a várt névvel és 0022-es definícióval (E5);
   - a függvényből pontosan egy van, a törzse a 0022-é, a metaadatai a vártak (E6);
   - az effektív ACL pontosan: tulajdonos + `service_role` EXECUTE, grant option nélkül (E7);
   - a tábla és a függvény tulajdonosa ugyanaz a szerepkör, a futtató felhasználó annak jogaival bír, és
     van `CREATE` joga a `public` sémán (E2);
   - nincs a táblán hosszan futó, zárat tartó munkamenet (E9).
3. A végrehajtandó fájl SHA-256 ellenőrzése a 4. pont szerint, a **függetlenül rögzített** jóváhagyott
   értékkel.
4. Karbantartási ablak: a rollback idejére a tábla `ACCESS EXCLUSIVE` zár alatt van (lásd 5. pont).

**Leállási feltételek** – a rollback SQL ezeket maga is ellenőrzi; bármelyiknél kivételt dob, a `DO`
utasítás hibával ér véget, és a tranzakciót kezelő kliensnek (a javasolt futtatónál: automatikusan)
vissza kell görgetnie – így semmi nem változik:

| Címke a hibaüzenetben | Feltétel |
|---|---|
| `[mod]` | nem tranzakcióblokkban fut: a három `SET LOCAL` nem hatott (ez NEM azonosítja a futtatót, lásd 5. pont) |
| `[elvaras]` | az elvárás-állandók (megszorítás-kifejezés és -definíciók, megjegyzések, metaadat-elvárás, törzs-hash-ek) md5-je nem a rögzített `c_spec_md5` – a terv szövege módosult |
| `[torzs]` | a visszaállítandó 0020 törzs md5-je nem `c70b0c06c0516ab7fe26b36b86c8cc32` |
| `[objektum]` | a tábla vagy a függvény hiányzik |
| `[tulajdonos]` | a helyőrző nincs kitöltve, vagy a tábla / függvény tulajdonosa eltér |
| `[jogosultsag]` | a futtató felhasználó nem rendelkezik a tulajdonos jogaival |
| `[adat]` | van `NULL`, `'week'` vagy ismeretlen `billing_interval` értékű sor |
| `[oszlop]` | a `billing_interval` nem `NOT NULL` vagy nem `text` |
| `[megszoritas]` | nem pontosan egy `billing_interval` CHECK, vagy nem a várt név / definíció / validált állapot |
| `[fuggveny]` | nem egy példány, vagy a törzs md5-je nem a 0022-é (`2797b02b96e1aa460973bb93e82f7ff9`) |
| `[metaadat]` | bármely ellenőrzött függvény-metaadat eltér (lásd a 4. pont táblázatát; pl. `STRICT`, `SECURITY DEFINER`, `search_path`, költség, `PARALLEL`, `LEAKPROOF`, `SUPPORT`, `TRANSFORM`, argumentum-alapértékek) |
| `[acl]` | az effektív ACL eltér (a `proacl IS NULL` = alapértelmezett, PUBLIC EXECUTE-tal → eltérés) |
| `[megjegyzes]` | a függvény megjegyzése nem a 0022-é |
| `[utoellenorzes]` | a csere utáni (COMMIT előtti) ellenőrzés bármely eltérése – köztük a teljes `pg_proc` sor összevetése |
| (PostgreSQL) `lock timeout` | a zár 5 mp alatt nem szerezhető meg |
| (PostgreSQL) `statement timeout` | egy utasítás 60 mp-en túl fut |
| (PostgreSQL) `idle-in-transaction timeout` | a tranzakció 30 mp-nél tovább tétlen a rollback után (pl. elmaradó `COMMIT`) – a szerver bontja a kapcsolatot, a tranzakció visszagördül |

Eltérésnél **ne javítsd kézzel a tervet a hiba elnémítására** – az eltérés okát manuálisan kell
felülvizsgálni (pl. kézzel módosított metaadat vagy jog), és csak utána dönteni.

## 3. Éles előellenőrzés (KIZÁRÓLAG olvasás)

Mind `select`; semmit nem módosít. Futtatható a Supabase SQL Editorban vagy `psql`-lel. Az eredményeket
mentsd el (a 6. pont összevetéséhez).

```sql
-- E1 – szerver, verzió, felhasználó
select version(), current_setting('server_version_num') as ver, current_user, session_user,
       (select rolsuper from pg_roles where rolname = current_user) as superuser,
       current_setting('standard_conforming_strings') as scs, current_setting('statement_timeout') as stmt_to,
       current_setting('idle_in_transaction_session_timeout') as idle_to;
-- elvárt: scs = on; ver >= 120000 (a terv közvetlenül használja a prosupport mezőt, amely a PG 12-től létezik;
-- a prosqlbody-t csak a to_jsonb soron át, hiánya esetén NULL-ként). Tesztelve KIZÁRÓLAG PG 17-en.

-- E2 – tulajdonosok és a futtató jogai
select c.relowner::regrole as table_owner, p.proowner::regrole as function_owner,
       c.relowner = p.proowner as same_owner,
       pg_has_role(current_user, p.proowner, 'USAGE') as can_act_as_owner,
       has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
       has_language_privilege(current_user, 'plpgsql', 'USAGE') as plpgsql_usage
  from pg_class c, pg_proc p
 where c.oid = 'public.pro_payment_requests'::regclass
   and p.oid = 'public.approve_pro_payment_request(uuid, text)'::regprocedure;
-- elvárt: same_owner = true, can_act_as_owner = true, schema_create = true, plpgsql_usage = true.
-- A function_owner értéke kerül a rollback SQL c_owner helyőrzőjébe.

-- E3 – érintett rekordok (NULL-biztosan, külön-külön)
select count(*) as total,
       count(*) filter (where billing_interval is null) as null_rows,
       count(*) filter (where billing_interval = 'week') as week_rows,
       count(*) filter (where billing_interval is not null and billing_interval not in ('week', 'month', 'year')) as unknown_rows,
       count(*) filter (where billing_interval in ('month', 'year')) as month_year_rows
  from public.pro_payment_requests;
-- elvárt: null_rows = 0, week_rows = 0, unknown_rows = 0, month_year_rows = total.

-- E4 – az oszlop a katalógusból
select attnotnull, atttypid::regtype from pg_attribute
 where attrelid = 'public.pro_payment_requests'::regclass and attname = 'billing_interval' and not attisdropped;
-- elvárt: true | text

-- E5 – a billing_interval oszlopra (vagy az egész sorra) hivatkozó ÖSSZES CHECK megszorítás
select conname, pg_get_constraintdef(oid) as def, convalidated
  from pg_constraint
 where conrelid = 'public.pro_payment_requests'::regclass and contype = 'c'
   and (conkey @> array[(select attnum from pg_attribute where attrelid = 'public.pro_payment_requests'::regclass and attname = 'billing_interval')]
        or 0 = any(conkey));  -- 0 = egész soros hivatkozás (pl. (pro_payment_requests.*)::text)
-- elvárt: PONTOSAN egy sor:
--   pro_payment_requests_billing_interval_check |
--   CHECK ((billing_interval = ANY (ARRAY['week'::text, 'month'::text, 'year'::text]))) | true

-- E6 – a függvény: példányszám, törzs, metaadatok
select count(*) over () as instances, p.oid::regprocedure,
       md5(replace(p.prosrc, E'\r', '')) as body_md5, p.prosqlbody is null as no_sql_body,
       concat_ws('|', p.prosecdef, coalesce(p.proconfig::text, 'NULL'), p.provolatile, p.proparallel, p.proleakproof, p.proisstrict,
                 p.prorettype::regtype, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prokind,
                 (select lanname from pg_language where oid = p.prolang), p.proretset, p.pronargs, p.pronargdefaults,
                 coalesce(pg_get_expr(p.proargdefaults, 0), 'NULL'), p.prosupport::text, coalesce(p.protrftypes::text, 'NULL'),
                 coalesce(p.proargmodes::text, 'NULL'), coalesce(p.proallargtypes::text, 'NULL'), coalesce(p.proargnames::text, 'NULL'),
                 p.procost, p.prorows) as meta
  from pg_proc p
 where p.proname = 'approve_pro_payment_request' and p.pronamespace = 'public'::regnamespace;
-- elvárt: instances = 1, body_md5 = 2797b02b96e1aa460973bb93e82f7ff9, no_sql_body = true,
--   meta = f|{"search_path=\"\""}|v|u|f|f|jsonb|p_request_id uuid, p_admin text|jsonb|f|plpgsql|f|2|0|NULL|-|NULL|NULL|NULL|{p_request_id,p_admin}|100|0

-- E7 – a függvény EFFEKTÍV ACL-je (proacl IS NULL esetén az alapértelmezett, PUBLIC-kal)
select p.proacl is null as acl_is_null,
       case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
       a.grantor::regrole as grantor, a.privilege_type, a.is_grantable
  from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where p.oid = 'public.approve_pro_payment_request(uuid, text)'::regprocedure
 order by 2;
-- elvárt: acl_is_null = false, és PONTOSAN két sor:
--   <tulajdonos>  | <tulajdonos> | EXECUTE | false
--   service_role  | <tulajdonos> | EXECUTE | false
-- Nincs PUBLIC, anon, authenticated sor, és nincs is_grantable = true.

-- E8 – a függvény megjegyzése
select obj_description('public.approve_pro_payment_request(uuid, text)'::regprocedure, 'pg_proc');
-- elvárt: a 0022 megjegyzése (a „(heti: 7 nap = 168 óra, havi: 1 hónap, éves: 1 év)” résszel).

-- E9 – a táblán most zárat tartó / váró munkamenetek
select a.pid, a.state, l.mode, l.granted, now() - a.xact_start as xact_age, left(a.query, 80) as query
  from pg_locks l join pg_stat_activity a on a.pid = l.pid
 where l.relation = 'public.pro_payment_requests'::regclass and a.pid <> pg_backend_pid();
-- elvárt: nincs sor, vagy csak rövid életű (másodperces) tranzakciók.
```

## 4. A rollback SQL

### 4.1 Mit ellenőriz – külön, egyértelmű elvárásokként

| Elvárás | Előtte (a csere előtt) | Utána (COMMIT előtt) |
|---|---|---|
| Tulajdonos | a tábla és a függvény tulajdonosa = `c_owner` (a kitöltött helyőrző) | változatlan, = `c_owner` |
| ACL | effektív ACL = tulajdonos + `service_role` EXECUTE, grant option nélkül (a `proacl IS NULL` alapértelmezett ACL-ként, PUBLIC-kal értékelve) | a `proacl` bájtra azonos a csere előttivel |
| Megjegyzés | = a 0022 megjegyzése (`c_cmt_0022`) | = a 0020 megjegyzése (`c_cmt_0020`) |
| Törzs | md5 = `2797b02b…` (0022) | md5 = `c70b0c06…` (0020) |
| Metaadat (`c_meta`) | `prosecdef`, `proconfig`, `provolatile`, `proparallel`, `proleakproof`, `proisstrict`, visszatérési típus, argumentumok (identitás, nevek, módok, típusok), `prokind`, nyelv, `proretset`, `pronargs`, `pronargdefaults`, `pg_get_expr(proargdefaults, 0)`, `prosupport`, `protrftypes`, `procost`, `prorows` = a 0020/0022 fejlécéből adódó érték | ugyanez **újra a `c_meta` állandóhoz** mérve (nem a csere előtti értékhez) |
| Teljes `pg_proc` sor | rögzítve (`to_jsonb`, a `prosrc` kivételével) | a `prosrc`-n kívül **minden** oszlop azonos – a mezőlistától független ellenőrzés (pl. `prosqlbody`, `probin`, `provariadic`) |
| Megszorítás | pontosan egy CHECK hivatkozik a `billing_interval` oszlopra vagy az egész sorra (`conkey` tartalmazza az oszlopot vagy a 0-t), név + teljes definíció (0022) + validált | ugyanígy pontosan egy, név + teljes definíció (0020) + validált |

A `create or replace function` a fejlécben nem szereplő tulajdonságokat (pl. `STRICT`, `COST`) az
alapértékre állítja – ezért a terv nem feltételezi, hogy minden metaadat megmarad, hanem a csere előtt
megáll, ha bármelyik eltér a várttól.

### 4.2 Integritás (SHA-256)

A lenti SQL-blokk SHA-256 értéke (a blokk sorai, mindegyik LF sorvéggel lezárva, a helyőrzővel
**kitöltetlen** állapotban):

```text
3edf1711f8707a965d4b754840cae536287444d6e52608e9a78e0181cbba0be5
```

**Kinyerés és ellenőrzés** (bash; a dokumentum CRLF sorvégeit is kezeli):

```bash
tr -d '\r' < docs/pro-weekly-rollback.md \
  | sed -n '/^<!-- PRO-WEEKLY-ROLLBACK-SQL:BEGIN -->$/,/^<!-- PRO-WEEKLY-ROLLBACK-SQL:END -->$/p' \
  | sed '1,2d' | head -n -2 > /a/repón/kívüli/rollback-0022.sql
sha256sum /a/repón/kívüli/rollback-0022.sql
```

A helyőrző kitöltése (`<<ELLENORZOTT_TULAJDONOS>>` → az E2 `function_owner` értéke) után a fájl hash-e
**megváltozik**. A kitöltött fájlt úgy ellenőrizd, hogy a tulajdonos értékét visszacseréled a
helyőrzőre – ennek a hash-e meg kell egyezzen a jóváhagyott értékkel (így bizonyítható, hogy a
kitöltésen kívül semmi nem változott):

```bash
sed "s/^\(  c_owner      constant text := \)'[^']*'/\1'<<ELLENORZOTT_TULAJDONOS>>'/" /a/repón/kívüli/rollback-0022.sql | sha256sum
```

Bármely más módosítás után új hash keletkezik, és **új jóváhagyás** kell.

**A hash korlátai – fontos:**
- A fenti érték ugyanebben a fájlban áll, mint az SQL. Aki a dokumentumot módosíthatja, az SQL-t és a
  hash-t is átírhatja; a dokumentumbeli hash ezért **önmagában nem hitelesít**. Csak a véletlen
  (másolási, mentési, kódolási) eltérést mutatja ki.
- Integritásvédelmet csak akkor ad, ha a jóváhagyott értéket a végrehajtott fájltól **függetlenül**
  rögzítik és vetik össze (pl. a jóváhagyó saját feljegyzése vagy a jóváhagyási üzenet, a commit, amelyben
  a dokumentum jóváhagyott állapota rögzül).

**Belső összhang (`[elvaras]`):** a megszorítás visszaállított kifejezése (`c_check_0020`), a várt
definíciók (`c_def_0020`, `c_def_0022`), a megjegyzések (`c_cmt_0020`, `c_cmt_0022`), a metaadat-elvárás
(`c_meta`) és a két törzs-hash együttes md5-je a `c_spec_md5` állandóban rögzített. Egyetlen állandó
véletlen módosítása (pl. elírt megjegyzés, vagy a kifejezés és a definíció közül csak az egyik) így a
futás elején, módosítás nélkül megállítja a rollbacket. **Ez nem teljes megoldás:** ha valaki a
kifejezést, a hozzá tartozó definíciót ÉS a `c_spec_md5`-öt is összehangoltan átírja, az SQL ezt nem
ismerheti fel – az adatbázisban nincs a 0020-ra vonatkozó független referencia. Ez ellen csak a
függetlenül rögzített SHA-256 összevetése véd (és helyben a tesztkörnyezet, amely a rollback utáni
állapotot egy csak 0020-ig migrált adatbázishoz méri).

### 4.3 Az SQL

Mentsd a blokkot **a repón kívüli** fájlba (4.2), és a `<<ELLENORZOTT_TULAJDONOS>>` helyőrzőt cseréld
az E2 `function_owner` értékére. Más változtatás nem szabad.

<!-- PRO-WEEKLY-ROLLBACK-SQL:BEGIN -->
```sql
-- ===========================================================================
-- PRO_WEEKLY – a 0022 visszafordítása a 0020 állapotra (megszorítás + függvény EGYÜTT)
-- JAVASOLT FUTTATÁS:  npx tsx scripts/run-migration.ts <ez a fájl>
--   A futtató maga nyit és zár tranzakciót (BEGIN … COMMIT, hibánál ROLLBACK), ezért ebben a
--   fájlban NINCS begin / commit. Az SQL a futtatót NEM tudja azonosítani: csak azt ellenőrzi
--   (0. lépés), hogy tranzakcióblokkban fut-e – lásd a dokumentum 5. pontját.
-- Adatot nem töröl és nem módosít; 'week' értéket nem ír át; jogot nem változtat.
-- ===========================================================================
set local statement_timeout = '60s';
set local lock_timeout = '5s';
set local idle_in_transaction_session_timeout = '30s';

do $rb$
declare
  c_owner      constant text := '<<ELLENORZOTT_TULAJDONOS>>';   -- az E2 function_owner értéke
  c_md5_0020   constant text := 'c70b0c06c0516ab7fe26b36b86c8cc32';
  c_md5_0022   constant text := '2797b02b96e1aa460973bb93e82f7ff9';
  c_check_0020 constant text := 'billing_interval in (''month'', ''year'')';
  c_def_0020   constant text := 'CHECK ((billing_interval = ANY (ARRAY[''month''::text, ''year''::text])))';
  c_def_0022   constant text := 'CHECK ((billing_interval = ANY (ARRAY[''week''::text, ''month''::text, ''year''::text])))';
  c_meta       constant text := 'f|{"search_path=\"\""}|v|u|f|f|jsonb|p_request_id uuid, p_admin text|jsonb|f|plpgsql|f|2|0|NULL|-|NULL|NULL|NULL|{p_request_id,p_admin}|100|0';
  c_cmt_0020   constant text := 'Kézi PRO-befizetés jóváhagyása: a kérelem lezárása és a PRO aktiválása/meghosszabbítása egy tranzakcióban; lezárt kérelemre already_processed, élő Stripe-előfizetésre stripe_conflict. Csak a service_role hívhatja.';
  c_cmt_0022   constant text := 'Kézi PRO-befizetés jóváhagyása: a kérelem lezárása és a PRO aktiválása/meghosszabbítása egy tranzakcióban (heti: 7 nap = 168 óra, havi: 1 hónap, éves: 1 év); lezárt kérelemre already_processed, élő Stripe-előfizetésre stripe_conflict. Csak a service_role hívhatja.';
  -- a fenti nyolc elvárás együttes md5-je (sorrend: check_0020, def_0020, def_0022, cmt_0020, cmt_0022, meta, md5_0020, md5_0022)
  c_spec_md5   constant text := '44193cd225bd66f0e0485b0d3af85030';
  -- a 0020 migráció approve_pro_payment_request törzse VÁLTOZATLANUL (a $$ … $$ közötti szöveg)
  v_body text := $fn$
declare
  r      public.pro_payment_requests;
  p      public.profiles;
  v_base timestamptz;
  v_end  timestamptz;
begin
  if p_request_id is null or coalesce(p_admin, '') = '' then
    raise exception 'A kérelem és az admin azonosítója kötelező.' using errcode = '22023';
  end if;

  -- a kérelem zárolása: párhuzamos jóváhagyás/elutasítás sorba áll, a második már lezártnak látja
  select * into r from public.pro_payment_requests where id = p_request_id for update;
  if r.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('outcome', 'already_processed', 'request', to_jsonb(r));
  end if;

  select * into p from public.profiles where id = r.user_id for update;
  if p.id is null then
    return jsonb_build_object('outcome', 'profile_missing', 'request', to_jsonb(r));
  end if;

  -- Stripe által kezelt, élő előfizetés: kézzel NEM írjuk felül (a Stripe tovább terhelne / felülírná)
  if p.stripe_subscription_id is not null
     and (p.subscription_status = 'past_due'
          or (p.subscription_status = 'pro' and (p.subscription_end is null or p.subscription_end > now()))) then
    return jsonb_build_object('outcome', 'stripe_conflict', 'request', to_jsonb(r));
  end if;

  if p.subscription_status = 'pro' and p.subscription_end is null then
    -- már korlátlan PRO: nem rövidítjük le; a kérelem lezárul, a profil változatlan
    v_end := null;
  else
    -- meglévő, még érvényes PRO meghosszabbítása a lejárattól; különben mától
    v_base := case when p.subscription_status = 'pro' and p.subscription_end > now() then p.subscription_end else now() end;
    v_end := v_base + case r.billing_interval when 'year' then interval '1 year' else interval '1 month' end;
    update public.profiles
       set subscription_status = 'pro', subscription_end = v_end
     where id = r.user_id;
  end if;

  update public.pro_payment_requests
     set status = 'approved', decided_at = now(), decided_by = p_admin, activated_until = v_end
   where id = r.id
  returning * into r;

  return jsonb_build_object('outcome', 'approved', 'request', to_jsonb(r));
end;
$fn$;
  v_tbl oid; v_fn oid; v_owner oid; v_att int2; v_notnull boolean; v_type oid;
  v_rows bigint; v_null bigint; v_week bigint; v_other bigint; v_n bigint;
  v_def text; v_valid boolean; v_md5 text; v_meta text; v_acl aclitem[]; v_relacl aclitem[];
  v_row jsonb; v_diff text;
begin
  -- 0. tranzakcióblokk (H5): a SET LOCAL csak tranzakcióblokkban hat. Ez NEM azonosítja a futtatót.
  if current_setting('statement_timeout') <> '1min' or current_setting('lock_timeout') <> '5s'
     or current_setting('idle_in_transaction_session_timeout') <> '30s' then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [mod]: nem tranzakcióblokkban fut – a SET LOCAL nem hatott (statement_timeout=%, lock_timeout=%, idle_in_transaction_session_timeout=%)',
      current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('idle_in_transaction_session_timeout');
  end if;

  -- 1. a terv belső összhangja (K3) és a visszaállítandó törzs (H1) – MÓDOSÍTÁS ELŐTT
  if md5(concat_ws(E'\n', c_check_0020, c_def_0020, c_def_0022, c_cmt_0020, c_cmt_0022, c_meta, c_md5_0020, c_md5_0022)) <> c_spec_md5 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [elvaras]: az elvárás-állandók md5-je % (elvárt: %) – a terv szövege módosult',
      md5(concat_ws(E'\n', c_check_0020, c_def_0020, c_def_0022, c_cmt_0020, c_cmt_0022, c_meta, c_md5_0020, c_md5_0022)), c_spec_md5;
  end if;
  v_body := replace(v_body, E'\r', '');
  if md5(v_body) <> c_md5_0020 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [torzs]: a visszaállítandó törzs md5-je % (elvárt: %) – a terv szövege sérült', md5(v_body), c_md5_0020;
  end if;

  -- 2. objektumok, tulajdonos, jogosultság (H2)
  v_tbl := to_regclass('public.pro_payment_requests');
  v_fn  := to_regprocedure('public.approve_pro_payment_request(uuid, text)');
  if v_tbl is null or v_fn is null then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [objektum]: tábla=%, függvény=%', v_tbl, v_fn;
  end if;
  if c_owner like '<<%' then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [tulajdonos]: a c_owner helyőrző nincs kitöltve (E2 function_owner)';
  end if;
  select oid into v_owner from pg_roles where rolname = c_owner;
  if v_owner is null
     or (select relowner from pg_class where oid = v_tbl) <> v_owner
     or (select proowner from pg_proc where oid = v_fn) <> v_owner then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [tulajdonos]: tábla=%, függvény=% (elvárt: %)',
      (select relowner::regrole from pg_class where oid = v_tbl), (select proowner::regrole from pg_proc where oid = v_fn), c_owner;
  end if;
  if not pg_has_role(current_user, v_owner, 'USAGE') then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [jogosultsag]: % nem rendelkezik % jogaival', current_user, c_owner;
  end if;

  -- 3. zár: az ellenőrzés és a csere alatt nem jöhet létre / nem hagyható jóvá kérelem
  lock table public.pro_payment_requests in access exclusive mode;

  -- 4. adatok (H3) – NULL-biztosan, külön számolva, a zár ALATT
  select count(*),
         count(*) filter (where billing_interval is null),
         count(*) filter (where billing_interval = 'week'),
         count(*) filter (where billing_interval is not null and billing_interval not in ('week', 'month', 'year'))
    into v_rows, v_null, v_week, v_other
    from public.pro_payment_requests;
  if v_null <> 0 or v_week <> 0 or v_other <> 0
     or (select count(*) from public.pro_payment_requests where billing_interval in ('month', 'year')) <> v_rows then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [adat]: NULL: %, week: %, ismeretlen: % (összes: %)', v_null, v_week, v_other, v_rows;
  end if;

  -- 5. az oszlop a katalógusból (H3)
  select attnum, attnotnull, atttypid into v_att, v_notnull, v_type
    from pg_attribute where attrelid = v_tbl and attname = 'billing_interval' and not attisdropped;
  if v_att is null or v_notnull is distinct from true or v_type is distinct from 'text'::regtype then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [oszlop]: attnotnull=%, típus=%', v_notnull, v_type::regtype;
  end if;

  -- 6. megszorítás (H4): pontosan egy CHECK hivatkozik az oszlopra vagy az egész sorra (conkey 0), a várt névvel és 0022-es definícióval
  select count(*) into v_n from pg_constraint where conrelid = v_tbl and contype = 'c' and (conkey @> array[v_att] or 0 = any(conkey));
  select pg_get_constraintdef(oid), convalidated into v_def, v_valid
    from pg_constraint where conrelid = v_tbl and contype = 'c' and conname = 'pro_payment_requests_billing_interval_check' and conkey = array[v_att];
  if v_n <> 1 or v_def is distinct from c_def_0022 or v_valid is distinct from true then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [megszoritas]: db=%, definíció=%, validált=%', v_n, v_def, v_valid;
  end if;

  -- 7. függvény (H1, H2): egy példány, 0022-es törzs, teljes metaadat-elvárás, effektív ACL, megjegyzés
  select count(*) into v_n from pg_proc where proname = 'approve_pro_payment_request' and pronamespace = 'public'::regnamespace;
  if v_n <> 1 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [fuggveny]: % példány (elvárt: 1)', v_n;
  end if;
  select md5(replace(prosrc, E'\r', '')), proacl, to_jsonb(p) - 'prosrc',
         concat_ws('|', prosecdef, coalesce(proconfig::text, 'NULL'), provolatile, proparallel, proleakproof, proisstrict,
                   prorettype::regtype, pg_get_function_identity_arguments(oid), pg_get_function_result(oid), prokind,
                   (select lanname from pg_language where oid = prolang), proretset, pronargs, pronargdefaults,
                   coalesce(pg_get_expr(proargdefaults, 0), 'NULL'), prosupport::text, coalesce(protrftypes::text, 'NULL'),
                   coalesce(proargmodes::text, 'NULL'), coalesce(proallargtypes::text, 'NULL'), coalesce(proargnames::text, 'NULL'),
                   procost, prorows)
    into v_md5, v_acl, v_row, v_meta
    from pg_proc p where oid = v_fn;
  if v_md5 <> c_md5_0022 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [fuggveny]: a jelenlegi törzs md5-je % (elvárt, 0022: %)', v_md5, c_md5_0022;
  end if;
  if v_meta is distinct from c_meta or (v_row ->> 'prosqlbody') is not null then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [metaadat]: % (elvárt: %)', v_meta, c_meta;
  end if;
  with act as (select a.grantee, a.grantor, a.privilege_type, a.is_grantable
                 from aclexplode(coalesce(v_acl, acldefault('f', v_owner))) a),
       exp as (select v_owner as grantee, v_owner as grantor, 'EXECUTE'::text as privilege_type, false as is_grantable
               union all
               select r.oid, v_owner, 'EXECUTE'::text, false from pg_roles r where r.rolname = 'service_role')
  select count(*) into v_n
    from ((select * from act except select * from exp) union all (select * from exp except select * from act)) d;
  if v_n <> 0 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [acl]: az effektív ACL eltér (proacl=%)', coalesce(v_acl::text, 'NULL = alapértelmezett, PUBLIC EXECUTE');
  end if;
  if obj_description(v_fn, 'pg_proc') is distinct from c_cmt_0022 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [megjegyzes]: a függvény megjegyzése nem a 0022-é';
  end if;
  select relacl into v_relacl from pg_class where oid = v_tbl;

  -- 8. CSERE – megszorítás és függvény EGYÜTT (ugyanebben a tranzakcióban)
  alter table public.pro_payment_requests drop constraint pro_payment_requests_billing_interval_check;
  execute format('alter table public.pro_payment_requests add constraint pro_payment_requests_billing_interval_check check (%s)', c_check_0020);
  execute format('create or replace function public.approve_pro_payment_request(p_request_id uuid, p_admin text) returns jsonb language plpgsql security invoker set search_path = %L as %L', '', v_body);
  execute format('comment on function public.approve_pro_payment_request(uuid, text) is %L', c_cmt_0020);

  -- 9. utóellenőrzés – a COMMIT ELŐTT (bármely eltérés: kivétel, a tranzakciót vissza kell görgetni)
  if to_regprocedure('public.approve_pro_payment_request(uuid, text)') is distinct from v_fn
     or (select count(*) from pg_proc where proname = 'approve_pro_payment_request' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: a függvény azonossága megváltozott';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = v_fn) <> c_md5_0020 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: a visszaállított törzs md5-je nem a 0020-é';
  end if;
  -- a metaadat újra a RÖGZÍTETT elváráshoz mérve (nem a csere előtti értékhez) …
  if (select concat_ws('|', prosecdef, coalesce(proconfig::text, 'NULL'), provolatile, proparallel, proleakproof, proisstrict,
                       prorettype::regtype, pg_get_function_identity_arguments(oid), pg_get_function_result(oid), prokind,
                       (select lanname from pg_language where oid = prolang), proretset, pronargs, pronargdefaults,
                       coalesce(pg_get_expr(proargdefaults, 0), 'NULL'), prosupport::text, coalesce(protrftypes::text, 'NULL'),
                       coalesce(proargmodes::text, 'NULL'), coalesce(proallargtypes::text, 'NULL'), coalesce(proargnames::text, 'NULL'),
                       procost, prorows)
        from pg_proc where oid = v_fn) is distinct from c_meta then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: a függvény metaadatai nem a vártak';
  end if;
  -- … és a teljes pg_proc sor (a prosrc kivételével) a mezőlistától függetlenül
  select string_agg(e.key, ', ' order by e.key) into v_diff
    from jsonb_each(v_row) e, pg_proc p
   where p.oid = v_fn and (to_jsonb(p) -> e.key) is distinct from e.value;
  if v_diff is not null then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: a pg_proc sor a prosrc-n kívül megváltozott: %', v_diff;
  end if;
  if (select proowner from pg_proc where oid = v_fn) <> v_owner
     or (select proacl from pg_proc where oid = v_fn) is distinct from v_acl then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: a függvény tulajdonosa vagy ACL-je megváltozott';
  end if;
  if obj_description(v_fn, 'pg_proc') is distinct from c_cmt_0020 then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: a megjegyzés nem a 0020-é';
  end if;
  select count(*) into v_n from pg_constraint where conrelid = v_tbl and contype = 'c' and (conkey @> array[v_att] or 0 = any(conkey));
  select pg_get_constraintdef(oid), convalidated into v_def, v_valid
    from pg_constraint where conrelid = v_tbl and contype = 'c' and conname = 'pro_payment_requests_billing_interval_check' and conkey = array[v_att];
  if v_n <> 1 or v_def is distinct from c_def_0020 or v_valid is distinct from true then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: megszorítás db=%, definíció=%, validált=%', v_n, v_def, v_valid;
  end if;
  if (select attnotnull from pg_attribute where attrelid = v_tbl and attnum = v_att) is distinct from true
     or (select relowner from pg_class where oid = v_tbl) <> v_owner
     or (select relacl from pg_class where oid = v_tbl) is distinct from v_relacl
     or (select count(*) from public.pro_payment_requests) <> v_rows then
    raise exception 'PRO_WEEKLY_ROLLBACK MEGSZAKÍTVA [utoellenorzes]: az oszlop, a tábla jogai vagy a sorok száma megváltozott';
  end if;

  raise notice 'PRO_WEEKLY_ROLLBACK RENDBEN: megszorítás és függvény a 0020 állapotban (% kérelem, változatlanul)', v_rows;
end
$rb$;
```
<!-- PRO-WEEKLY-ROLLBACK-SQL:END -->

## 5. Tranzakciós futtatás

**Javasolt (és a tervben egyedül leírt) futtatási mód:**

```bash
npx tsx scripts/run-migration.ts /a/repón/kívüli/rollback-0022.sql
```

**Forráskódból igazolt** (`scripts/run-migration.ts`, nem futtatva):
- a `.env` `SUPABASE_DB_URL` értékéhez kapcsolódik, és kiírja a célt
  (`Cél: host:port/adatbázis (felhasználó: …)`) – **futtatás előtt ellenőrizd, hogy az éles cél-e**;
- `BEGIN` → a fájl teljes tartalma **egyetlen**, paraméter nélküli lekérdezésként (nem darabolja) →
  `COMMIT`; bármely hibánál `ROLLBACK`, és kiírja: `✗ A migráció HIBÁRA futott (a változások
  visszagörgetve): <üzenet>` – az üzenetben a 2. pont címkéjével. Siker: `✓ A migráció sikeresen lefutott.`
- Ezért a rollback SQL-ben **nincs** `BEGIN` / `COMMIT`; a három `SET LOCAL` a futtató tranzakciójában hat.

**Amit az SQL bizonyít – és amit nem:**
- A teljes rollback **egyetlen `DO` utasítás**; a 0. lépés ellenőrzi, hogy **tranzakcióblokkban** fut
  (a `SET LOCAL` hatott). Autocommit módban (utasításonként külön tranzakció, pl. `psql -f` `-1`
  nélkül) ez nem teljesül, és a futás `[mod]` hibával, módosítás nélkül megáll.
- Az SQL **nem tudja azonosítani a klienst**: a `psql --single-transaction`, a saját `BEGIN` és egy
  egyetlen többutasításos lekérdezésként küldött fájl (ahogy egy SQL-szerkesztő is küldheti) szintén
  tranzakcióblokk – ezeket a 0. lépés **nem** ismeri fel és **nem** tiltja (helyben igazolva). Ezek nem
  részei a tervnek; a Supabase SQL Editor tényleges viselkedése nincs ellenőrizve.
- A garancia: a `DO` utasítás bármely hibája kivételt dob, a tranzakció hibás állapotba kerül, és a
  tranzakciót kezelő kliensnek vissza kell görgetnie – a javasolt futtató ezt automatikusan megteszi.
  A terv a `COMMIT` utáni ellenőrzésre nem épít: minden ellenőrzés a `DO`-n belül, a csere előtt és után fut.

**Időkorlátok és ami ellen NEM véd:**
- `lock_timeout = 5s` (zárvárás), `statement_timeout = 60s` (utasításonként – a 13-as PostgreSQL-től a
  többutasításos lekérdezés minden utasítására külön), `idle_in_transaction_session_timeout = 30s`.
- Az utóbbi a sikeres `DO` utáni **tétlen, lezáratlan** tranzakcióra vonatkozik (pl. saját `BEGIN` után
  elmaradó `COMMIT`): 30 mp tétlenség után a szerver bontja a kapcsolatot, a tranzakció visszagördül, a
  zár felszabadul (helyben igazolva). A javasolt futtatónál a `DO` és a `COMMIT` között nincs tétlenség.
- A kliens vagy a hálózat megszakadásakor a PostgreSQL a lezáratlan tranzakciót visszagörgeti (helyben
  a szerveroldali kapcsolatbontással szimulálva igazolva). Ha viszont a kapcsolat a `COMMIT` elküldése
  után, a válasz előtt szakad meg, a kliens nem tudja, hogy a `COMMIT` megtörtént-e – ilyenkor a 6. pont
  utóellenőrzése dönt. Félig nyitva maradt TCP-kapcsolat (a szerver nem észleli a bontást) esetén a zár
  az operációs rendszer / TCP keepalive időkorlátjáig megmaradhat – ez ellen a terv nem véd; ilyenkor az
  E9 lekérdezéssel azonosítható és kézzel bontható a munkamenet.

## 6. Utóellenőrzés (a sikeres futás után, KIZÁRÓLAG olvasás)

Futtasd újra az E2–E9 lekérdezéseket. Elvárt eltérések a 3. ponthoz képest – **minden más egyezzen**:

- **E5:** pontosan egy sor: `pro_payment_requests_billing_interval_check |
  CHECK ((billing_interval = ANY (ARRAY['month'::text, 'year'::text]))) | true`
- **E6:** `body_md5 = c70b0c06c0516ab7fe26b36b86c8cc32`; a `meta` változatlan.
- **E7:** változatlan (ugyanaz a két sor).
- **E8:** a 0020 megjegyzése (a „(heti: …)” rész nélkül).
- **E3:** a darabszámok változatlanok.

## 7. Vészhelyzeti kikapcsolás és az alkalmazásverziók sorrendje

**Kiadás (előre):**
1. A 0022 sikeresen lefut, és a migráció utóellenőrzése (lásd `pro-weekly.md`) megfelel.
2. Csak ezután: Render → `PRO_WEEKLY_ENABLED=true`.

**Vészhelyzet / rollback – kötelező sorrend:**
1. Render → `PRO_WEEKLY_ENABLED` = `false` (vagy törlés) → *Save* (újraindítás).
2. Ellenőrzés: a szervernapló `Heti PRO-csomag: TILTVA …`; a heti új rendelés `503 PLAN_UNAVAILABLE`;
   a `GET /api/pro-payments` `plans` listájában csak `month`.
3. Az éles backend az a verzió, amely a heti új rendeléseket tiltja, de a meglévő heti kérelmek
   adminisztrációját (lista, jóváhagyás: pontosan 168 óra, elutasítás) kezeli – ez igazolva legyen.
   **Itt a biztonságos alapállapot:** ha bármely heti kérelem létezik (függő VAGY lezárt), a
   sémaszintű rollback NEM folytatható – a 0022 marad, a heti rendelés tiltva.
4. Az E1–E9 éles előellenőrzés; bármely eltérésnél **állj meg**.
5. A SHA-256 ellenőrzése (4.2), majd a rollback a javasolt futtatóval (5. pont).
6. Utóellenőrzés (6. pont).
7. A backend **a kapcsolós verzión marad**. A heti csomaghoz tartozó alkalmazáskód eltávolításáról
   csak ezután, **külön** kell dönteni. Rollback után a `PRO_WEEKLY_ENABLED` NEM kapcsolható be (a heti
   rendelést az adatbázis elutasítaná – a szerver ezt `503 PLAN_UNAVAILABLE`-ként kezeli), amíg a 0022
   ellenőrzötten újra le nem fut.

**TILOS** közvetlenül olyan régi backend-verzióra visszaállni, amely a `PRO_WEEKLY_ENABLED` kapcsolót
nem ismeri. A kapcsoló előtti backend (pl. a `633c3c2` commit) a kérés törzséből a `plan` mezőt nem
olvassa, így egy (gyorsítótárazott) heti felületről érkező `plan: 'week'` kérést **csendben havi,
2 990 Ft-os rendelésként** rögzítene. A frontendet sem szabad a backend előtt visszaállítani.

## 8. Tesztelési eredmények és élesben ellenőrizetlen feltételek

### 8.1 Helyi teszt (2026-10-19) – a végleges dokumentumból kinyert SQL-lel

- **Környezet:** helyi, eldobható PostgreSQL 17.10 (`server_version_num = 170010`), cím ellenőrizve:
  `inet_server_addr() = 127.0.0.1`. A tesztkörnyezet minden `PG*` környezeti változót kiürít, `.env`-et
  nem olvas, külső adatbázishoz nem kapcsolódik. Minden esethez külön adatbázis; a végén mind törölve
  (maradék adatbázis és teszt-szerepkör: 0).
- **Séma:** Supabase-szerű bootstrap (`anon`, `authenticated`, `service_role`, `auth.users`, a Supabase
  alapértelmezett függvényjogai), majd `0001` + `0020` (a HEAD-ből) + `0022`. Referencia: egy külön,
  csak `0001` + `0020`-ig migrált adatbázis.
- **A tesztelt SQL:** a 4.3 blokk, a dokumentumból kiolvasva; a helyőrző helyén a helyi tulajdonos.
  A 4.2 bash-parancsai szó szerint futottak (csak az útvonal cserélve).
- **Futtatás:** alapesetben a `scripts/run-migration.ts` tranzakciós logikájának **másával** (`BEGIN` →
  a fájl egy lekérdezésként → `COMMIT`, hibánál `ROLLBACK`), `pg` klienssel, szuperfelhasználóként – a
  9a/9b eset nem szuperfelhasználóként. **A valódi futtató NEM futott:** kötelezően SSL-lel kapcsolódik,
  a helyi szerveren `ssl = off`. A mása nem azonos a futtató integrációs tesztjével.
- **„Változatlan”** = a tábla összes megszorítása (név, definíció, validált), az oszlopok NOT NULL-ja, a
  triggerek, a függvény törzse, metaadatai, tulajdonosa, ACL-je és megjegyzése, a tábla tulajdonosa és
  ACL-je, valamint a kérelmek és a profilok tartalma (md5) bájtra azonos a futás előttivel.

**Eredmény: 58 / 58 eset megfelelt** (minden felsorolt eset lefutott).

| # | Eset | Eredmény |
|---|---|---|
| 1, 1b | Normál havi/éves adatok (függő + jóváhagyott): `COMMIT`, adatok bájtra változatlanok; utána a heti sor elutasítva, az éves jóváhagyás pontosan +1 év | MEGFELELT |
| 8 | A séma-pillanatkép **és a teljes `pg_proc` sor** (az `oid` kivételével) azonos a független, csak 0020-ig migrált adatbázisével; a megszorítás OID-ja eltér (nem része az elvárásnak) | MEGFELELT |
| 1c | A 0022 a rollback után hibátlanul újrafuttatható, és visszaállítja a heti sémát (a figyelmeztetés igazolása) | MEGFELELT |
| 12 | Ismételt futtatás a visszaállított sémán: `[megszoritas]`, változatlan | MEGFELELT |
| 2a, 2b | Egy függő / egy jóváhagyott `'week'` kérelem: `[adat] … week: 1` | MEGFELELT |
| 3a, 3b | `NULL` érték (szimulálva: `drop not null` + `NULL` sor): `[adat] NULL: 1`; `NOT NULL` nélkül, `NULL` sor nélkül: `[oszlop]` | MEGFELELT |
| 4 | Ismeretlen érték (szimulálva: CHECK eldobva, `'day'` sor, CHECK vissza `NOT VALID`-dal): `[adat] … ismeretlen: 1` | MEGFELELT |
| 5a–5g | Hiányzó / többlet / azonos nevű, eltérő definíciójú / `NOT VALID` / a várt név más oszlopon / egész soros (`conkey = {0}`) / `ROW(*)` (`conkey` = minden oszlop) CHECK: mind `[megszoritas]` | MEGFELELT |
| 6a–6d | Nem 0022-es jelenlegi törzs `[fuggveny]`; a terv törzse sérült `[torzs]`; törzs **és** `c_md5_0020` együtt átírva `[elvaras]`; túlterhelés `[fuggveny]` | MEGFELELT |
| 7a–7i | Kézzel: `STRICT`, `SECURITY DEFINER`, `SET search_path`, további `SET`, `COST 200`, `PARALLEL SAFE`, `IMMUTABLE`, `LEAKPROOF`, `SUPPORT`: mind `[metaadat]`, módosítás nélkül | MEGFELELT |
| 8a–8k | Más tulajdonos; kitöltetlen / üres / kis-nagybetűben eltérő helyőrző `[tulajdonos]`; EXECUTE `authenticated` / `anon` / PUBLIC; grant option; `proacl IS NULL`; visszavont `service_role` `[acl]`; módosított 0022-megjegyzés `[megjegyzes]` | MEGFELELT |
| 9a | **Nem szuperfelhasználó** tulajdonos, `CREATE` jog nélkül a `public` sémán: `permission denied for schema public`, teljes visszagörgetés | MEGFELELT |
| 9b | **Nem szuperfelhasználó** tulajdonos, `CREATE` joggal, a saját nevében: `COMMIT`; tulajdonos és ACL megmarad | MEGFELELT |
| 10a | Autocommit (`psql -f`, `-1` nélkül): `[mod]`, változatlan | MEGFELELT |
| 10b, 10d | Egyetlen többutasításos lekérdezés `BEGIN` nélkül, illetve `psql --single-transaction`: a `[mod]` **nem** ismeri fel – lefut, az eredmény a tiszta 0020 állapot (dokumentált viselkedés) | MEGFELELT |
| 10c | Ugyanez (egy lekérdezés) késői hibával: teljes visszagörgetés | MEGFELELT |
| 11a, 11b | `c_cmt_0020` elírása; a megszorítás-kifejezés **és** a `c_def_0020` együtt átírva: `[elvaras]`, változatlan | MEGFELELT |
| 11c | **Ismert korlát megerősítve:** kifejezés + definíció + `c_spec_md5` összehangoltan átírva → az SQL átengedi (a megszorítás `'week'`-et engedne); a hamisított blokk SHA-256-ja eltér a közzétettől | MEGFELELT (a korlát valós) |
| 12a | Valódi zárkonfliktus (másik munkamenet `ACCESS SHARE` zárat tart): `55P03 lock timeout` ≈5 s után, változatlan | MEGFELELT |
| 12b | Saját `BEGIN`, elmaradó `COMMIT`: 30 s tétlenség után a szerver bontja a kapcsolatot; a zár felszabadul, semmi nem változott | MEGFELELT |
| 12c | Kapcsolatbontás a `DO` után, `COMMIT` előtt (szerveroldali bontással szimulálva): változatlan, a zár felszabadul | MEGFELELT |
| 12d, 12e | Késői hiba a csere **után** (a végrehajtott `CREATE`-be csempészett `STRICT`; a 0022-es megjegyzés írása): `[utoellenorzes]` – a független metaadat-ellenőrzés megfogja; a már végrehajtott csere is visszagördül | MEGFELELT |
| 13a | CRLF sorvégű fájl: `COMMIT`, tiszta 0020 állapot | MEGFELELT |
| 13b | Az E1–E9 hibátlanul fut, nem módosít; az E6 `meta` = a `c_meta` elvárás | MEGFELELT |
| 14 | A 4.2 kinyerő parancsa a közzétett SHA-256-ot adja; a kitöltött fájl visszanormálva ugyanazt; egy további módosítás után mást; a kinyert fájl = a tesztelt SQL | MEGFELELT |

**H1 független ellenőrzése:** a 0020 migráció (HEAD) `$$ … $$` közötti szövege CR nélkül 2164 karakter,
md5 `c70b0c06c0516ab7fe26b36b86c8cc32`, és karakterre azonos a terv `v_body`-jával; a csak 0020-at
futtatott adatbázis katalógusában `md5(replace(prosrc, E'\r', ''))` ugyanez.

**NEM TESZTELT:**
- a valódi `scripts/run-migration.ts` (SSL kényszer, a helyi szerveren `ssl = off`);
- a Supabase SQL Editor (nem része a tervnek);
- PostgreSQL 17-től eltérő verzió (a katalógus-kimenetek, pl. `pg_get_constraintdef`, a `meta`, eltérhetnek);
- a 60 s-os `statement_timeout` tényleges kiváltása ezzel az SQL-lel (a mechanizmust – `SET LOCAL` +
  `DO` egy többutasításos lekérdezésben – egy külön helyi kísérlet 1 s-mal igazolta);
- a `TRANSFORM` (`protrftypes`) és a nem üres `prosqlbody` eltérés (`ALTER FUNCTION`-nel nem állítható
  be; az ellenőrzés a forrásban szerepel);
- félig nyitott TCP-kapcsolat, valódi hálózati hiba, `COMMIT` közbeni kapcsolatvesztés;
- a 6. pont utóellenőrző lekérdezései a rollback utáni állapoton (a 8. eset pillanatképe igazolja az állapotot).

A tesztkörnyezet szkriptjei nem részei a repónak.

### 8.2 Élesben MÉG NEM ellenőrzött – a rollback előtt kötelező

- a PostgreSQL-verzió (E1; legalább 12, tesztelve csak 17), `standard_conforming_strings = on`;
- a tábla és a függvény tulajdonosa, és hogy a futtató felhasználó a jogaival és `CREATE` joggal bír (E2);
- az érintett rekordok: `'week'`, `NULL`, ismeretlen értékek száma = 0 (E3);
- a `billing_interval` `NOT NULL` (E4);
- pontosan egy `billing_interval` (vagy egész soros) CHECK, a 0022-es definícióval (E5);
- a függvény példányszáma, törzse (`2797b02b…`), metaadatai (E6) – más PG-verzión a `meta` szöveges
  formája eltérhet; ilyenkor a rollback `[metaadat]` hibával megáll (biztonságos), és felülvizsgálat kell;
- a függvény effektív ACL-je, a tényleges szerepkörnevekkel és grantorral (E7);
- a megjegyzés (E8) és a táblán tartott zárak (E9);
- a végrehajtandó fájl SHA-256-ja a **függetlenül rögzített** jóváhagyott értékkel (4.2);
- hogy a futtató valóban az éles célhoz kapcsolódik (`Cél: …` sor).

Amíg ezek nincsenek igazolva, a rollback élesben **nem tekinthető végrehajthatónak**.

### 8.3 Fennmaradó kockázatok

- **Zár:** a futás idejére (helyben milliszekundumok; legfeljebb 5 s zárvárás + utasításonként 60 s) a
  kérelmek táblája `ACCESS EXCLUSIVE` zár alatt van: a fizetési oldal és az admin lista olvasása is vár.
  Karbantartási ablak ajánlott.
- **Integritás:** a dokumentumbeli SHA-256 és a `c_spec_md5` csak a véletlen eltérést szűri; a szándékos,
  összehangolt módosítás ellen csak a függetlenül rögzített SHA-256 véd (lásd 4.2 és a 11c eset).
- **Futtatási mód:** az SQL a klienst nem azonosítja; a javasolt futtatótól eltérő, de tranzakcióblokkot
  adó mód (10b, 10d) is lefut.
- **Egyirányúság:** az első eladott (akár elutasított) heti kérelem után a sémaszintű rollback nem
  lehetséges; ilyenkor a biztonságos állapot a tiltott kapcsoló + a 0022 séma.
- **Kézi lépés:** a tulajdonos helyőrzőjét kézzel kell kitölteni; elírásnál a rollback `[tulajdonos]`
  hibával megáll (biztonságos).
