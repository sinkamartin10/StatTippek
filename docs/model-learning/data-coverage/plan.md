# Történeti adatlefedettség – javítási terv

Mérés: [`report.md`](report.md) (`npx tsx scripts/coverageAudit.ts`), több ligás modell: [`../cross-league/report.md`](../cross-league/report.md).

## Mit találtunk

| Hiányosság | Típus | Hatás (2025-26, újonnan elemezhető) |
|---|---|---|
| Az előző BL/EL/KL-idény nem töltődik be (a csapat-menetrend és a kupa liga-átlaga is csak az aktuális idényből) | **a forrásban megvan, nincs betöltve** | 180 meccsnél hoz új adatot |
| UEFA-kupás klubok hazai bajnoksága (portugál, holland, skót, belga, török, svájci, osztrák, görög, skandináv, ciprusi, izraeli, román, észak-ír, walesi, máltai) | **a forrásban megvan (`por.1`, `ned.1`, `sco.1`, …), nincs konfigurálva** | 158 |
| Válogatott: az éles szolgáltató a vb-selejtező és a barátságos meccsek idényét júliusi szabállyal számolja, az ESPN viszont naptári évvel – január–június között az előző naptári év kimarad | **betöltési hiba** | 102 |
| Kiesett csapat előző élvonalbeli idénye (a feljutóra van szabály, a kiesőre nincs) | **betöltési hiba** | 65 |
| A lefedettség a szerverfolyamat előzményeitől függ: a letöltött menetrendekből a csapatok más sorozatokhoz is hozzárendelődnek, így egy frissen indult és egy bemelegedett szerver ugyanarra a meccsre más adatkört lát | **nem determinisztikus éles viselkedés** | 65 meccs eltérés (frissen indult vs. bemelegedett) |
| Cseh, lengyel, horvát, szerb, ukrán, magyar, bolgár, szlovák stb. bajnokság | **az ESPN-ben a kipróbált azonosítókkal nem érhető el** | 101 meccs továbbra is kevés adattal |

Csapatazonosító-eltérés nem mutatható ki (az ESPN-azonosító sorozatokon át ugyanazt a csapatot jelöli; a bemutató-meccsek – MLS All-Stars – kizárva).

## A legfontosabb korlát

Az újonnan elemezhetővé váló meccseken a **változatlan `xg-poisson-1` rosszabb, mint a naiv alap** (2025-26: Δ 1X2 log loss +0,086, 95% CI +0,032 … +0,144; O2,5: +0,078). Ok: a modell a csapat más sorozatban szerzett gólátlagát a célsorozat (kupa/válogatott) liga-átlagához normálja, ligaerősség-korrekció nélkül. **A bővített adatkör ezért a mostani éles modellel NEM élesíthető** – több adat itt rosszabb tippet adna. A korábban is elemezhető meccseken a bővítés nem rontott és nem javított érdemben (1X2 Δ +0,0015, CI átfedi a 0-t).

## Terv (mindegyik lépés külön jóváhagyással)

1. **Kész, éles hatás nélkül** – `src/server/data/historyPlan.ts` (tiszta tervező; a „baseline”-t teszt veti össze a valódi szolgáltató kéréseivel) és `EspnProvider.getResultsForAnalysisExtended` (kísérleti; regisztráció nélküli feldolgozás, a szolgáltató közös állapotát nem módosítja – teszttel igazolva). Az éles `getResultsForAnalysis`, a tippek és a valószínűségek változatlanok.
2. **Árnyék-adatgyűjtés** az `xs-strength-1`-hez: a bővített adatkör naplózása a futó 2026-27-es idényben, a tippek nélkül. Ez adja az érintetlen holdoutot a több ligás modell és a küszöbök megerősítéséhez.
3. **Döntés a modellről**: ha az `xs-strength-1` a friss holdouton is jobb (és a „kevés adat” kategóriák bizonyítottan értékesek), a bővített adatkör az ÚJ modellel együtt élesíthető – a modellverzió emelésével (új `ENGINE_VERSION`), hogy az archívumban a régi és az új tippek ne keveredjenek.
4. **Determinizmus**: az éles adatkört a szerverfolyamat előzményeitől függetlenné kell tenni (a `historyPlan` explicit kérései alapján). Ez az `xg-poisson-1` kimenetét is megváltoztatja egyes meccseken, ezért ugyanannak a verzióemelésnek a része legyen.
5. **Terhelés**: a bővítés meccsenként átlagosan +10–18 egyedi csapat-menetrend kérést jelent (kupameccsen ~+37); a lezárt idények menetrendje nem változik, ezért hosszú TTL-lel cache-elhető (jelenleg 3 óra) – ezt a bevezetéskor külön kell beállítani.
6. **Migráció nem kell**: a bővítés csak letöltési szabály; adatbázis-változás nincs.
