# Utólagos eredmény-korrekció – migrációs terv (NEM futtatva)

Állapot: **terv**. SQL-tervezet: `0018_settlement_corrections.draft.sql` (szándékosan nem a
`supabase/migrations/` mappában). Productionben nem alkalmaztuk; meglévő adatot nem módosít.

## Probléma (a kódból igazolva)

- A `model_tip_archive` lezárt sora a 0014 triggere miatt **nem írható át**
  („a lezárt tipp eredménye nem írható át”). Ez védi a visszakövethetőséget, de
  ha a szolgáltató egy végeredményt utólag javít, a hibás eredmény a tanító
  adatban marad, és nincs hivatalos korrekciós út.
- A félbeszakadt / törölt / halasztott meccs nem gond: a szolgáltatónál nem
  `finished`, ezért a tipp függő marad (nem vereség) – ezt a meglévő tesztek igazolják.

## Javasolt megoldás

1. **Hozzáfűzéses korrekciós napló** (`model_tip_archive_settlement_corrections`):
   archív sor + korrigált állapot/eredmény + forrás + ok + időpont. Nem módosítható,
   nem törölhető. Az eredeti sor (model_prob, engine_version, eredeti elszámolás)
   változatlan marad.
2. **Érvényes-eredmény nézet** (`model_tip_archive_counted_effective`): az eredeti
   mezők mellett az utolsó korrekcióval felülírt eredmény.
3. **Tanítás**: a `loadArchive` a nézet `effective_*` mezőit használná. Mivel az
   adat-ujjlenyomat a kimenetekből (`y`) is képződik, egy korrekció **új
   jelölt-azonosítót** ad – a régi jelölt és a régi metrikák megmaradnak.
4. **Korrekció felderítése** (külön lépés): a frissítési kör a lezárt meccseket is
   újraolvashatná (pl. 7 napig, ritkítva); eltérésnél korrekciós sort írna – csak
   a szolgáltató ismételt, `finished` állapotú megfigyelése alapján.

## Bevezetés feltételei

- Jóváhagyás; helyi eldobható adatbázison a szerződéstesztek bővítése és futtatása.
- A nyilvános archívum-statisztika (találati arány) ugyanarra a nézetre álljon át,
  hogy a nyilvános és a tanító szám ne térjen el.
- Production: kizárólag kézzel, külön kiadási lépésben (`npm run migrate -- <fájl>`).
