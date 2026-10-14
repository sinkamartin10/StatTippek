# Diagnosztikai előzmények (0018) – séma, kiadás, megőrzés

## Mit rögzít

Minden **sikeres, admin által kifejezetten indított** diagnosztikai futás (`POST /api/admin/model-learning/snapshots`)
egyetlen, aggregált sort: időpont (UTC), alap motor (`xg-poisson-1`), módszer (`diagnostics-v1`), a kiértékelt
minta ujjlenyomata, tipp- és mérkőzésszám, időszak, log loss / Brier / ECE, a naiv baseline-nal közös páros minta
mérete, a baseline és a modell értékei, a modell-előny és 95%-os bootstrap-intervalluma, a mintamegfelelőség és a
figyelmeztetések. Ami nem számolódott ki, az `NULL`. Tippet, felhasználói adatot nem másol; az indító azonosítója
(`actor`) és az idempotencia-kulcs csak az auditban van, az API nem adja ki.

Az oldal megnyitása, a `GET /diagnostics`, a `GET /history` és a `GET /status` **nem** ír.

## Séma

- Postgres: `supabase/migrations/0018_model_learning_diagnostic_runs.sql`
- SQLite (helyi/tesztek): `SqliteModelLearningStore` konstruktora – azonos oszlopok, megszorítások, triggerek.

Garanciák: append-only (UPDATE/DELETE/TRUNCATE trigger + visszavont jog), egyedi `idempotency_key`,
CHECK-ek (időszak, CI-sorrend, ujjlenyomat, darabszámok), RLS, `service_role`: csak SELECT + INSERT,
index: `(created_at desc, id)`.

## Duplikáció elleni védelem

- Kötelező `Idempotency-Key` fejléc (8–100 karakter, `[A-Za-z0-9-]`). A kliens kattintásonként egy kulcsot
  generál; ugyanazzal a kulccsal ismételt kérés (újrapróbálás, időtúllépés) **nem** számol újra és nem ír új sort
  – a meglévő futást adja vissza (`200`, `replayed: true`). Párhuzamos azonos kulcs: az egyedi index miatt egy sor.
- A gomb futás közben tiltott.
- Hibás számítás vagy sikertelen mentés: `500 SNAPSHOT_FAILED`, sor nem keletkezik; a felület kimondja, hogy
  nem történt rögzítés.

## Megőrzés

Minden futás megmarad; automatikus törlés nincs. Várható volumen: kézi indítás → legfeljebb néhány ezer sor/év
(~1 kB/sor). Ritkítás csak külön, jóváhagyott migrációval (archív táblába másolás, az őr tudatos feloldásával).

## Kiadási lépések (külön jóváhagyással)

1. A kód kiadható a 0018 nélkül is: ilyenkor a „Diagnosztika frissítése” hibát ad („nem rögzült”), az előzmény-szakasz
   hibát jelez – az irányítópult többi része és az éles modell működik.
2. A 0018 alkalmazása production adatbázison: **kézzel**, külön lépésben:
   `npm run migrate -- supabase/migrations/0018_model_learning_diagnostic_runs.sql`
   (újrafuttatható; csak új objektumot hoz létre; a 0015 `model_learning_block_removal()` függvényére épül).
3. Ellenőrzés: admin `POST /snapshots` → `201`, majd `GET /history` → a futás szerepel.

Megjegyzés: a `docs/` alatti két **tervezet** (szögletarchívum, eredmény-korrekció) szintén „0018” munkanevet
visel, de nincs a migrációs mappában; ha bevezetésre kerülnek, a következő szabad sorszámot kapják.
