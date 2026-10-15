# xs-strength-1 – több ligás erősségmodell: adatlefedettség és időrendi összehasonlítás

Futtatva: 2026-10-15T13:20:04.783Z · éles modell: `xg-poisson-1` (változatlan) · kísérleti: `xs-strength-1` (állapot: **shadow**, nem szolgál ki tippet).

Adat: 612 havi ESPN-scoreboard a helyi cache-ből (hálózat nélkül), 15528 befejezett meccs 17 sorozatból (2023-07 – 2026-06), ebből 15435 rendes játékidős. Adatkészlet-ujjlenyomat (sha256): `7b00462df8c4919052472da7481bcb708bcdef7e7f95595de077cf84f129cc46`. Kihagyva: not_completed: 65, exhibition_all_stars: 3.

Időrend: validáció 2024-07-01 – 2025-07-01 (hiperparaméterek, küszöbök), teszt 2025-07-01 – 2026-07-01 (egyszeri értékelés). Minden előrejelzés csak a kezdés (kísérleti modellnél: a heti újrabecslés) előtt legalább 3 órával kezdődött meccseket lát. A célmeccsek rendes játékidővel zárultak (hosszabbítás/tizenegyesek kizárva, mert a forrás eredménye azokban nem a 90 perces).

## 1. Miért kevés az adat? (éles adatkör, xg-poisson-1)

### Validáció (2024-25): 5195 célmeccs, ebből „kevés adat”: **679 (13.1%)**

Ok (a meccs akkor is egyszer számít, ha több csapatnál/szinten hibázik):

| ok | meccs |
|---|---|
| adat_letezik_de_az_eles_adatkor_nem_tartalmazza | 250 |
| szigoru_kuszob_hazai_idegen_bontas | 186 |
| forras_nem_szolgaltatja_a_hazai_bajnoksagot | 132 |
| valoban_nincs_eleg_tortenet | 74 |
| szigoru_kuszob_hazai_idegen_bontas+valoban_nincs_eleg_tortenet | 23 |
| szigoru_kuszob_liga_atlag | 14 |

A motor által jelzett feltételek (egy meccs több feltételen is elbukhat):

| feltétel | előfordulás |
|---|---|
| kevesebb_mint_3_meccs_osszesen | 421 |
| hazai_csapat_kevesebb_mint_3_hazai | 460 |
| vendeg_csapat_kevesebb_mint_3_idegen | 471 |
| liga_atlag_kevesebb_mint_10 | 78 |

### Teszt (2025-26): 5281 célmeccs, ebből „kevés adat”: **773 (14.6%)**

Ok (a meccs akkor is egyszer számít, ha több csapatnál/szinten hibázik):

| ok | meccs |
|---|---|
| adat_letezik_de_az_eles_adatkor_nem_tartalmazza | 462 |
| szigoru_kuszob_hazai_idegen_bontas | 141 |
| forras_nem_szolgaltatja_a_hazai_bajnoksagot | 92 |
| valoban_nincs_eleg_tortenet | 68 |
| szigoru_kuszob_hazai_idegen_bontas+valoban_nincs_eleg_tortenet | 10 |

A motor által jelzett feltételek (egy meccs több feltételen is elbukhat):

| feltétel | előfordulás |
|---|---|
| vendeg_csapat_kevesebb_mint_3_idegen | 545 |
| hazai_csapat_kevesebb_mint_3_hazai | 516 |
| kevesebb_mint_3_meccs_osszesen | 465 |
| liga_atlag_kevesebb_mint_10 | 63 |

### Teszt: ok × sorozat

| sorozat | adat_letezik_de_az_eles_adatkor_nem_tartalmazza | forras_nem_szolgaltatja_a_hazai_bajnoksagot | szigoru_kuszob_hazai_idegen_bontas | szigoru_kuszob_hazai_idegen_bontas+valoban_nincs_eleg_tortenet | valoban_nincs_eleg_tortenet |
|---|---|---|---|---|---|
| eng-ch | 19 | – | 6 | – | 6 |
| esp-l2 | 19 | – | 9 | – | 9 |
| fifa-friendly | 140 | – | 101 | 10 | 28 |
| fifa-wcq-uefa | 50 | – | – | – | – |
| fra-l2 | 15 | – | 9 | – | 8 |
| ger-b2 | 11 | – | 6 | – | 5 |
| ita-sb | 13 | – | 10 | – | 12 |
| uefa-nl | 4 | – | – | – | – |
| uefa-ucl | 69 | 6 | – | – | – |
| uefa-uecl | 43 | 63 | – | – | – |
| uefa-uel | 79 | 23 | – | – | – |

Az okok jelentése:

- **adat_letezik_de_az_eles_adatkor_nem_tartalmazza**: a lefedett forrásban (17 sorozat, 3 idény) van elég korábbi meccs, és az éles motor a SAJÁT küszöbeivel elemezné is, de az éles szolgáltató ezeket nem tölti le / nem kapcsolja a meccshez (pl. a nemzetközi kupák előző idényei nem kerülnek be; kupameccsnél a liga-átlag csak az aktuális kupaidényből számol).
- **forras_nem_szolgaltatja_a_hazai_bajnoksagot**: nemzetközi kupameccs, ahol a csapat hazai bajnoksága nincs a beállított ESPN-sorozatok között (pl. portugál, holland, skót, belga… klubok) – az adat létezik a világban, de a forrásunkból nem érhető el.
- **valoban_nincs_eleg_tortenet**: a csapatnak a teljes lefedett adatban sincs legalább 3 korábbi meccse.
- **szigoru_kuszob_hazai_idegen_bontas / szigoru_kuszob_liga_atlag**: van elég összesített adat, de a motor hazai/idegen bontásban kér ≥3 meccset, illetve a sorozatból ≥10 liga-átlagmeccset.
- Csapat-/ligaazonosító eltérés: az adatkészletben **0** olyan csapatnév van, amely több ESPN-azonosítóhoz tartozna, és ugyanaz az ESPN-azonosító minden sorozatban ugyanazt a csapatot jelöli – ilyen hiba ebben az adatkörben nem mutatható ki. A magyar NB I/NB II nincs az ESPN-ben, ezért nem mérhető.

## 2. A kísérleti modell

> **Optimalizáló-javítás az első futáshoz képest:** az első változat a paraméterezés likelihood szempontjából „lapos” irányai (csoportszint ↔ a csoport csapatai, konstans ↔ csoportszintek, közös támadás/védekezés-eltolás) mentén nem konvergált a körlimiten belül. Ezek az irányok a likelihoodot – így az ismert csapatok előrejelzését – nem változtatják, csak az erősség liga- és csapatszint közötti felosztását; ezért a mérőszámok gyakorlatilag változatlanok (a teszt Δ 1X2 öt tizedesig azonos). A javítás (az irányok – összefüggő komponensenként is – pontos, zárt alakú optimalizálása minden körben) az ismeretlen csapatoknál használt csoportátlagot és a ligaszintek értelmezhetőségét teszi helyessé. A maradék lassú konvergenciát egy adatminőségi hiba okozta: az ESPN MLS-scoreboardja bemutató-meccseket (MLS All-Stars – Liga MX All-Stars) bajnokiként ad; ezeket kizártuk (az éles szolgáltató sem látja őket). A hangolási rács, az időszakok és a küszöbszabály változatlan. Konvergencia: 1091 heti becslés, átlagosan 37.1 kör, legfeljebb 500; a körlimitet elérte: **0**.

Hierarchikus, regularizált Poisson támadó/védekező erősség (lásd `src/shared/engine/experimental/crossLeague.ts`). Csoport = a csapat legtöbbet játszott hazai bajnoksága; a csapat a csoportja, a csoport a globális szint felé húzódik. A ligák közti szintet a nemzetközi kupameccsek és a ligák között mozgó csapatok kötik össze; a ligaerősség egyszer szerepel. Bizonytalanság: Laplace-diagonális szórások, Gauss–Hermite keverékkel a valószínűségekben. Heti újrabecslés, időrendben.

### Hiperparaméter-választás (CSAK validáció, elsődleges mérőszám: 1X2 log loss)

| felezési idő (nap) | σ csapat | σ csoport | 1X2 log loss | O2,5 log loss | BTTS log loss | n |
|---|---|---|---|---|---|---|
| 365 | 0.5 | 0.35 | 1.01622 | 0.68881 | 0.69200 | 5195 |
| 365 | 0.3 | 0.35 | 1.01655 | 0.68526 | 0.69025 | 5195 |
| 730 | 0.3 | 0.35 | 1.01680 | 0.68568 | 0.69068 | 5195 |
| 180 | 0.5 | 0.35 | 1.01681 | 0.68914 | 0.69182 | 5195 |
| 730 | 0.5 | 0.35 | 1.01686 | 0.68913 | 0.69245 | 5195 |
| 365 | 0.5 | 0.15 | 1.01757 | 0.68875 | 0.69193 | 5195 |
| 180 | 0.3 | 0.35 | 1.01795 | 0.68514 | 0.68989 | 5195 |
| 365 | 0.3 | 0.15 | 1.01806 | 0.68518 | 0.69018 | 5195 |
| 730 | 0.5 | 0.15 | 1.01815 | 0.68907 | 0.69239 | 5195 |
| 180 | 0.5 | 0.15 | 1.01815 | 0.68909 | 0.69174 | 5195 |
| 730 | 0.3 | 0.15 | 1.01827 | 0.68559 | 0.69062 | 5195 |
| 180 | 0.3 | 0.15 | 1.01934 | 0.68507 | 0.68978 | 5195 |
| 730 | 0.15 | 0.35 | 1.02285 | 0.68281 | 0.68922 | 5195 |
| 730 | 0.15 | 0.15 | 1.02371 | 0.68269 | 0.68916 | 5195 |
| 365 | 0.15 | 0.35 | 1.02435 | 0.68265 | 0.68912 | 5195 |
| 365 | 0.15 | 0.15 | 1.02524 | 0.68255 | 0.68903 | 5195 |
| 180 | 0.15 | 0.35 | 1.02901 | 0.68293 | 0.68912 | 5195 |
| 180 | 0.15 | 0.15 | 1.02970 | 0.68281 | 0.68896 | 5195 |

Kiválasztott: **felezési idő 365 nap, σ_csapat 0.5, σ_csoport 0.35**.

### Adatminőségi kategóriák és küszöbeik (validációból, nem önkényes)

Mérőszám: a meccs log-várhatógól-rátáinak összevont bizonytalansága (sdLog).
- **Elegendő, jó minőségű történeti adat**: sdLog ≤ 0.290 – a validáción az éles motor által elemzett meccsek bizonytalanságának mediánja.
- **Korlátozott, de használható adat**: ≤ 0.387 – ugyanezek 90. percentilise.
- **Kevés adat, erős regularizációval**: ≤ 0.387 – a 0.387 feletti tartomány kvintilis-sávjai közül csak azok, amelyekben a modell a validáción BIZONYÍTOTTAN (95% CI teljesen 0 alatt) jobb volt a naiv alapnál, balról folytonosan.
- **Elégtelen vagy megbízhatatlan adat – nem indokolt előrejelzés**: e felett, vagy ha bármelyik csapatnak nincs egyetlen lezárt meccse sem (adathiány ≠ gyengeség).

| sáv felső határa (sdLog) | n | Δ 1X2 log loss a naiv alaphoz (validáció) |
|---|---|---|
| 0.438 | 201 | -0.04813 (95% CI -0.10299 … 0.01185; n=201) |
| 0.521 | 201 | -0.10177 (95% CI -0.15632 … -0.04881; n=201) |
| 0.581 | 201 | -0.08772 (95% CI -0.13683 … -0.03714; n=201) |
| 0.665 | 201 | -0.04865 (95% CI -0.09774 … 0.00323; n=201) |
| 0.918 | 201 | -0.04488 (95% CI -0.08586 … -0.00279; n=201) |

## 3. Teszt (2025-26) – egyszeri értékelés

Célmeccsek: 5281 · az éles motor elemzi: **4508** · „kevés adat” az élesben: **773**.

### 3.1 Ahol az éles motor is elemez – kísérleti vs. éles (páros, Δ = kísérleti − éles; negatív = a kísérleti jobb)

| mérőszám | kísérleti | éles | naiv | Δ kísérleti − éles |
|---|---|---|---|---|
| ll1x2 | 1.01581 | 1.05260 | 1.06930 | -0.03679 (95% CI -0.04545 … -0.02837; n=4508) |
| br1x2 | 0.60826 | 0.63309 | 0.64646 | -0.02483 (95% CI -0.03087 … -0.01874; n=4508) |
| llO25 | 0.68623 | 0.71720 | 0.68700 | -0.03097 (95% CI -0.03879 … -0.02316; n=4508) |
| brO25 | 0.24654 | 0.26012 | 0.24694 | -0.01357 (95% CI -0.01720 … -0.00992; n=4508) |
| llBtts | 0.68882 | 0.70861 | 0.68534 | -0.01980 (95% CI -0.02581 … -0.01391; n=4508) |
| brBtts | 0.24781 | 0.25692 | 0.24611 | -0.00911 (95% CI -0.01192 … -0.00611; n=4508) |

Viszonyítás – éles vs. naiv alap ugyanezeken a meccseken:

- ll1x2: Δ éles − naiv = -0.01670 (95% CI -0.02792 … -0.00548; n=4508)
- br1x2: Δ éles − naiv = -0.01337 (95% CI -0.02088 … -0.00574; n=4508)
- llO25: Δ éles − naiv = 0.03020 (95% CI 0.02063 … 0.03937; n=4508)
- brO25: Δ éles − naiv = 0.01318 (95% CI 0.00904 … 0.01745; n=4508)
- llBtts: Δ éles − naiv = 0.02328 (95% CI 0.01581 … 0.03106; n=4508)
- brBtts: Δ éles − naiv = 0.01081 (95% CI 0.00728 … 0.01432; n=4508)

Bontás a kísérleti modell kategóriája szerint (Δ 1X2 log loss, kísérleti − éles):

| kategória | n | Δ |
|---|---|---|
| Elegendő, jó minőségű történeti adat | 3641 | -0.03883 (95% CI -0.04894 … -0.02912; n=3641) |
| Korlátozott, de használható adat | 520 | -0.00502 (95% CI -0.02889 … 0.01983; n=520) |
| Kevés adat, erős regularizációval | 0 | – |
| Elégtelen vagy megbízhatatlan adat – nem indokolt előrejelzés | 347 | -0.06301 (95% CI -0.10059 … -0.02573; n=347) |

### 3.2 Ahol az éles motor „kevés adatot” jelez – kísérleti vs. naiv alap (éles előrejelzés itt nincs)

| kategória | meccs | 1X2 log loss kísérleti | naiv | Δ 1X2 (95% CI) | Δ O2,5 (95% CI) |
|---|---|---|---|---|---|
| Elegendő, jó minőségű történeti adat | 52 | 1.06799 | 1.05621 | 0.01178 (95% CI -0.06193 … 0.08960; n=52) | -0.01668 (95% CI -0.06213 … 0.02718; n=52) |
| Korlátozott, de használható adat | 97 | 0.94329 | 1.00238 | -0.05909 (95% CI -0.14227 … 0.03466; n=97) | 0.02913 (95% CI -0.01286 … 0.07187; n=97) |
| Kevés adat, erős regularizációval | 0 | n. a. | n. a. | – | – |
| Elégtelen vagy megbízhatatlan adat – nem indokolt előrejelzés | 624 | 0.99459 | 1.04247 | -0.04788 (95% CI -0.07805 … -0.01665; n=624) | 0.00126 (95% CI -0.01610 … 0.01993; n=624) |

Az „elégtelen” kategória bontása: valódi adathiány (legalább az egyik csapatnak nincs lezárt meccse) **43**, túl nagy bizonytalanság **581**.

**Megalapozottan elemezhető további meccs (teszt, előre rögzített szabály):** 149 a 773 „kevés adat” meccsből (nem „elégtelen” kategória). Ezeken a kísérleti modell a naiv alaphoz képest:

- ll1x2: Δ = -0.03436 (95% CI -0.09394 … 0.03099; n=149)
- br1x2: Δ = -0.02999 (95% CI -0.07334 … 0.01634; n=149)
- llO25: Δ = 0.01314 (95% CI -0.02022 … 0.04477; n=149)
- brO25: Δ = 0.00525 (95% CI -0.00922 … 0.01998; n=149)
- llBtts: Δ = 0.01626 (95% CI -0.00773 … 0.04013; n=149)
- brBtts: Δ = 0.00789 (95% CI -0.00290 … 0.01965; n=149)

### 3.3 Sorozatonként (teszt)

| sorozat | célmeccs | éles elemzi | éles: kevés adat | ebből a kísérleti használható | 1X2 log loss kísérleti / éles (közös) | Δ (95% CI) |
|---|---|---|---|---|---|---|
| eng-ch | 556 | 525 | 31 | 19 | 1.0581 / 1.0896 | -0.03152 (95% CI -0.05591 … -0.00709; n=525) |
| eng-pl | 380 | 380 | 0 | 0 | 1.0430 / 1.0832 | -0.04024 (95% CI -0.07459 … -0.00916; n=380) |
| esp-l2 | 468 | 431 | 37 | 18 | 1.0550 / 1.0866 | -0.03163 (95% CI -0.05851 … -0.00931; n=431) |
| esp-ll | 380 | 380 | 0 | 0 | 0.9748 / 1.0100 | -0.03515 (95% CI -0.06526 … -0.00264; n=380) |
| fifa-friendly | 367 | 88 | 279 | 0 | 0.9251 / 0.9371 | -0.01196 (95% CI -0.09375 … 0.06946; n=88) |
| fifa-wcq-uefa | 152 | 102 | 50 | 0 | 0.7629 / 0.8607 | -0.09782 (95% CI -0.16740 … -0.02721; n=102) |
| fra-l1 | 305 | 305 | 0 | 0 | 0.9934 / 1.0523 | -0.05887 (95% CI -0.09600 … -0.02219; n=305) |
| fra-l2 | 306 | 274 | 32 | 15 | 1.0781 / 1.1014 | -0.02331 (95% CI -0.05250 … 0.00656; n=274) |
| ger-b2 | 306 | 284 | 22 | 11 | 1.0496 / 1.0653 | -0.01571 (95% CI -0.04729 … 0.01077; n=284) |
| ger-bl | 306 | 306 | 0 | 0 | 0.9709 / 1.0328 | -0.06190 (95% CI -0.09546 … -0.02646; n=306) |
| ita-sa | 380 | 380 | 0 | 0 | 1.0049 / 1.0454 | -0.04057 (95% CI -0.07026 … -0.01008; n=380) |
| ita-sb | 390 | 355 | 35 | 13 | 1.0414 / 1.0527 | -0.01129 (95% CI -0.03407 … 0.01102; n=355) |
| uefa-nl | 4 | 0 | 4 | 0 | n. a. / n. a. | – |
| uefa-ucl | 186 | 111 | 75 | 45 | 0.9473 / 1.0123 | -0.06494 (95% CI -0.12629 … -0.00130; n=111) |
| uefa-uecl | 151 | 45 | 106 | 1 | 0.9962 / 1.1988 | -0.20261 (95% CI -0.33628 … -0.07825; n=45) |
| uefa-uel | 184 | 82 | 102 | 27 | 0.9451 / 0.9643 | -0.01917 (95% CI -0.10082 … 0.05720; n=82) |
| usa-mls | 460 | 460 | 0 | 0 | 1.0228 / 1.0466 | -0.02376 (95% CI -0.04991 … 0.00305; n=460) |

### 3.4 Kalibráció (teszt)

1X2 (egy-a-többi ellen, közös meccsek) – ECE kísérleti 0.0089, éles 0.0322; a „kevés adat”, de használható meccseken kísérleti 0.0258. O2,5 – ECE kísérleti 0.0345, éles 0.0930.

| sáv | n kís. | átl. p | tényl. | n éles | átl. p | tényl. |
|---|---|---|---|---|---|---|
| 0.0–0.1 | 168 | 0.070 | 0.048 | 261 | 0.074 | 0.123 |
| 0.1–0.2 | 1215 | 0.165 | 0.161 | 1781 | 0.162 | 0.222 |
| 0.2–0.3 | 5807 | 0.250 | 0.257 | 5142 | 0.249 | 0.268 |
| 0.3–0.4 | 2552 | 0.348 | 0.333 | 2540 | 0.345 | 0.331 |
| 0.4–0.5 | 2000 | 0.446 | 0.443 | 1692 | 0.447 | 0.424 |
| 0.5–0.6 | 1098 | 0.543 | 0.539 | 1163 | 0.546 | 0.494 |
| 0.6–0.7 | 461 | 0.643 | 0.672 | 587 | 0.644 | 0.574 |
| 0.7–0.8 | 163 | 0.744 | 0.755 | 290 | 0.741 | 0.624 |
| 0.8–0.9 | 46 | 0.838 | 0.870 | 59 | 0.845 | 0.746 |
| 0.9–1.0 | 14 | 0.932 | 0.786 | 9 | 0.925 | 0.556 |

## 4. Post-hoc érzékenységvizsgálat – NEM megerősítő

> Az alábbiakat a teszteredmény megtekintése UTÁN adtuk hozzá. A paraméterek és küszöbök itt is csak a validációból jönnek, de a vizsgálat ötlete a teszt ismeretében született, ezért ezek az eredmények NEM bizonyítékok – elfogadásukhoz új, érintetlen időszak (pl. a 2026-27-es idény árnyék-üzemben) kell.

**(a) Halmozott küszöbszabály.** Az előre rögzített szabály balról folytonos sávonkénti bizonyítást kér, ezért az első, 195 meccses sáv határeseti CI-je (lásd a 2. pont táblázatát) a „kevés adat” kategóriát üresen hagyta, miközben a következő sávok bizonyítottan jobbak voltak a naiv alapnál. Halmozott szabállyal (a 0.387 feletti meccsek együtt, sávhatáronként; a legnagyobb határ, ahol a 95% CI teljesen 0 alatt van) a felső küszöb: **0.918**.

| halmozott határ (sdLog) | n | Δ 1X2 log loss a naivhoz (validáció) |
|---|---|---|
| 0.438 | 201 | -0.04813 (95% CI -0.10353 … 0.01137; n=201) |
| 0.521 | 402 | -0.07495 (95% CI -0.11261 … -0.03232; n=402) |
| 0.581 | 603 | -0.07921 (95% CI -0.11064 … -0.04724; n=603) |
| 0.665 | 804 | -0.07157 (95% CI -0.09860 … -0.04510; n=804) |
| 0.918 | 1005 | -0.06623 (95% CI -0.08977 … -0.04317; n=1005) |

Ezzel a teszten használható „kevés adat” meccs: **730** a 773-ből. A naiv alaphoz képest:

- ll1x2: Δ = -0.04719 (95% CI -0.07437 … -0.01829; n=730)
- br1x2: Δ = -0.03632 (95% CI -0.05620 … -0.01568; n=730)
- llO25: Δ = 0.00514 (95% CI -0.01063 … 0.02276; n=730)
- brO25: Δ = 0.00206 (95% CI -0.00566 … 0.01018; n=730)
- llBtts: Δ = 0.00524 (95% CI -0.00878 … 0.02024; n=730)
- brBtts: Δ = 0.00248 (95% CI -0.00427 … 0.00945; n=730)

**(b) Kibővített σ_csapat.** A választás a rács szélére (σ_csapat 0.5) esett. Validációs 1X2 log loss nagyobb σ-val: σ 0.75: 1.01725, σ 1: 1.01814 (a választotté 1.01622). Nagyobb σ a validáción nem javított.

## 5. Korlátok

- Egy adatforrás (ESPN, 17 sorozat), két kiértékelt idény; a mért különbség más ligákra/időszakokra nem garantáltan általánosítható.
- Hazai kupák, más országok bajnokságai és keretadatok nincsenek a forrásban – a modell ezeket nem látja, és nem is pótolja.
- Az éles adatkör szimuláció: a szolgáltató letöltési szabályait követi (`scripts/lib/espnDataset.ts` – `available`, a `historyPlan` alapján, amelyet teszt vet össze a valódi szolgáltatóval), frissen indult szerver állapotában (alsó korlát); az élő rendszer pillanatnyi hálózati hibáit nem modellezi.
- Az éles szolgáltató ma NEM tölti le a kísérleti modell tanítóadatát (több idény, minden sorozat); árnyék-üzemhez ehhez külön adatgyűjtés kell.
- A modell automatikusan nem kerül élesbe: állapota `shadow`; élesítés csak külön, kézi döntéssel.
