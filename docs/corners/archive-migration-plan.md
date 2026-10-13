# Szöglettippek archiválása – migrációs terv (NEM futtatva)

Állapot: **terv**. A tervezett SQL a `0018_corner_tip_archive.draft.sql` fájlban van, szándékosan
**nem** a `supabase/migrations/` mappában, hogy véletlenül se fusson le. Productionben nem
alkalmaztuk, és a meglévő archívumtáblákat (`model_tip_archive`, nézetek, `match_state`) nem módosítja.

## Miért külön tábla

- A meglévő `model_tip_archive` gólpiaci tippekre készült: a `category` CHECK, az elszámolás
  (`evaluateMarket`, gólszám alapján) és a tanulási réteg (`model_learning_*`, kalibráció) mind
  gólpiaci feltételezésekre épül. Szöglettipp ide kerülve vagy „nem elszámolható” lenne, vagy –
  rossz piackód esetén – gólszám szerint számolódna el.
- A szöglettippek elszámolásához meccsvégi **szögletszám** kell, amit a meglévő tábla nem tárol.
- A szögletmodell **nem** kapcsolódhat automatikusan a gólmodell tanulási rétegéhez.

## Tervezett séma (lásd a draft SQL-t)

`corner_tip_archive` – a `model_tip_archive` mintájára, de független:

- azonosítás: `match_id`, `market` (csak `CRN_` kód, CHECK-kel), `version_no`, `content_hash`;
- modell: `model_version` (`corners-nb-1`), `model_prob`, `home_expected`, `away_expected`,
  `sample_home`, `sample_away`, `sample_league`;
- időzítés: `generated_at`, `kickoff`, `pre_kickoff` (CHECK: `generated_at < kickoff`);
- elszámolás: `settlement_status` (`pending`/`won`/`lost`/`unsupported`), `home_corners`,
  `away_corners`, `settled_at` – CHECK: lezárt állapothoz kötelező mindkét szögletszám;
- változtathatatlanság: trigger tiltja a tipp-mezők módosítását és a törlést (mint a 0014-ben);
- RLS bekapcsolva, csak `service_role` ír; nyilvános olvasás csak egy kezdés utáni nézeten át.

## Elszámolás

- Kizárólag `evaluateCornerMarket()` (src/shared/engine/corners/markets.ts) – hiteles,
  meccsvégi szögletszámból. Hiányzó/érvénytelen szögletszám → a tipp **függőben marad**.
- Hosszabbítással/tizenegyesekkel zárult meccs → `unsupported` (a piac a rendes játékidőre szól,
  az ESPN-szám a teljes mérkőzésé).
- A szögletszám forrása ugyanaz az ESPN-parser (`parseScoreboardCorners`), az üres
  statisztika-blokk szabállyal.

## Bekötés feltételei (mind kell)

1. `CORNER_RELEASE.validated` és a piaccsoport szerepel a `validatedScopes`-ban.
2. `CORNER_TIPS_ENABLED=1` szerveroldali kapcsoló (`cornerTipsEnabled`).
3. A migráció jóváhagyott, helyi eldobható adatbázison tesztelt, majd kézzel alkalmazott.
4. FREE/PRO: a szöglettippek PRO-funkciók; a FREE tipplista redakciója kiterjesztve.
5. Külön tesztek: elszámolás, változtathatatlanság, RLS/jogosultság, kezdés előtti láthatatlanság.

## Futtatás (csak jóváhagyás után)

1. Helyi, eldobható PostgreSQL-en: a draft átnevezése `supabase/migrations/0018_*.sql`-re, a
   szerződéstesztek bővítése és futtatása.
2. Production: kizárólag kifejezett jóváhagyással, kézzel (`npm run migrate -- <fájl>`).
