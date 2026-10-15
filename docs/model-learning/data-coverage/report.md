# Adatlefedettség – eredeti és bővített történeti adatkör

Futtatva: 2026-10-15T13:22:18.878Z · éles modell: `xg-poisson-1` (VÁLTOZATLAN – minden adatkörre ugyanaz a kód fut). Adat: 1224 havi ESPN-scoreboard a helyi cache-ből, 26366 befejezett meccs, ebből a csak-előzmény hazai bajnokságokból 10838. Kihagyva: not_completed: 69, exhibition_all_stars: 3.

Adatkörök:

- **eredeti / frissen indult szerver**: amit az éles `getResultsForAnalysis` letölt, ha a szerver épp elindult (csak az aktuális idény csapatlistái ismertek) – alsó korlát;
- **eredeti / bemelegedett szerver**: ugyanez, miután a szerver korábbi elemzésekhez már letöltötte a ligák előző idényeit, és a csapatokat azokhoz a sorozatokhoz is hozzárendelte – felső korlát. Az éles lefedettség a folyamat előzményeitől függ (a Render minden deploy és alvás után újraindul);
- **bővített**: frissen indult szerver + a `historyPlan` bővítései (determinisztikus, a folyamat előzményeitől független).

Ellenőrzések a bővített adatkörön: duplikált meccs **0**, a kezdés előtti 3 órán belüli vagy későbbi meccs **0**.

## 2024-25: 5195 célmeccs

| adatkör | elemezhető | kevés adat |
|---|---|---|
| eredeti / frissen indult | 4516 (86.9%) | 679 |
| eredeti / bemelegedett | 4586 (88.3%) | 609 |
| bővített | **4788 (92.2%)** | 407 |

Újonnan elemezhető (frissen indult → bővített): **272**; elemezhetőségét elvesztő: 0.

Terhelés (egyedi csapat-menetrend kérés meccsenként, cache nélkül): eredeti átlagosan 49.8, a bővítés többlete átlagosan 10.3 (kupameccsen 37.5). A lezárt idények menetrendje nem változik, ezért ezek hosszú ideig cache-elhetők.

### Sorozatonként

| sorozat | célmeccs | eredeti friss | eredeti bemeleg. | bővített | új |
|---|---|---|---|---|---|
| eng-ch | 556 | 524 | 538 | 538 | 14 |
| eng-pl | 380 | 380 | 380 | 380 | 0 |
| esp-l2 | 467 | 430 | 445 | 445 | 15 |
| esp-ll | 380 | 380 | 380 | 380 | 0 |
| fifa-friendly | 166 | 46 | 46 | 67 | 21 |
| fifa-wcq-uefa | 48 | 31 | 31 | 36 | 5 |
| fra-l1 | 306 | 306 | 306 | 306 | 0 |
| fra-l2 | 306 | 279 | 294 | 294 | 15 |
| ger-b2 | 306 | 278 | 290 | 290 | 12 |
| ger-bl | 306 | 306 | 306 | 306 | 0 |
| ita-sa | 380 | 380 | 380 | 380 | 0 |
| ita-sb | 390 | 354 | 368 | 368 | 14 |
| uefa-nl | 179 | 86 | 86 | 86 | 0 |
| uefa-ucl | 185 | 113 | 113 | 168 | 55 |
| uefa-uecl | 146 | 39 | 39 | 83 | 44 |
| uefa-uel | 184 | 80 | 80 | 157 | 77 |
| usa-mls | 510 | 504 | 504 | 504 | 0 |

### Az újonnan elemezhető meccsek – milyen forrás hozta az új adatot

| forrás (bővítés) | meccs, amelynél új adatot hozott |
|---|---|
| elozo_nemzetkozi_kupaidény | 176 |
| hazai_bajnoksag_csak_elozmeny_forrasbol | 152 |
| kieso_elozo_elsoosztaly | 70 |
| valogatott_naptari_ablak | 26 |

### A bővítés után is „kevés adat” – miért

| ok | meccs |
|---|---|
| kuszob_hazai_idegen_bontas | 193 |
| a_hazai_bajnoksag_nem_erheto_el_az_espn_ben | 89 |
| valoban_keves_meccs_a_forrasban | 80 |
| kuszob_hazai_idegen_bontas+valoban_keves_meccs_a_forrasban | 24 |
| kuszob_liga_atlag | 14 |
| a_hazai_bajnoksag_nem_erheto_el_az_espn_ben+valoban_keves_meccs_a_forrasban | 4 |
| a_hazai_bajnoksag_nem_erheto_el_az_espn_ben+kuszob_hazai_idegen_bontas | 3 |

### Minőség (tájékoztató – a modell NEM változik)

- Az újonnan elemezhető meccseken a változatlan xg-poisson-1 a naiv alaphoz képest: Δ 1X2 log loss 0.05545 (95% CI -0.00204 … 0.11317; n=272); Δ O2,5 log loss 0.03885 (95% CI -0.00159 … 0.08042; n=272) (negatív = a modell jobb).
- A korábban is elemezhető meccseken a bővített adat az eredetihez képest: Δ 1X2 log loss 0.00260 (95% CI 0.00007 … 0.00515; n=4516); Δ O2,5 log loss -0.00140 (95% CI -0.00325 … 0.00030; n=4516) (negatív = a bővített adattal jobb).

## 2025-26: 5281 célmeccs

| adatkör | elemezhető | kevés adat |
|---|---|---|
| eredeti / frissen indult | 4508 (85.4%) | 773 |
| eredeti / bemelegedett | 4573 (86.6%) | 708 |
| bővített | **4855 (91.9%)** | 426 |

Újonnan elemezhető (frissen indult → bővített): **347**; elemezhetőségét elvesztő: 0.

Terhelés (egyedi csapat-menetrend kérés meccsenként, cache nélkül): eredeti átlagosan 52.8, a bővítés többlete átlagosan 17.7 (kupameccsen 37.4). A lezárt idények menetrendje nem változik, ezért ezek hosszú ideig cache-elhetők.

### Sorozatonként

| sorozat | célmeccs | eredeti friss | eredeti bemeleg. | bővített | új |
|---|---|---|---|---|---|
| eng-ch | 556 | 525 | 538 | 538 | 13 |
| eng-pl | 380 | 380 | 380 | 380 | 0 |
| esp-l2 | 468 | 431 | 444 | 444 | 13 |
| esp-ll | 380 | 380 | 380 | 380 | 0 |
| fifa-friendly | 367 | 88 | 88 | 182 | 94 |
| fifa-wcq-uefa | 152 | 102 | 102 | 110 | 8 |
| fra-l1 | 305 | 305 | 305 | 305 | 0 |
| fra-l2 | 306 | 274 | 289 | 289 | 15 |
| ger-b2 | 306 | 284 | 295 | 295 | 11 |
| ger-bl | 306 | 306 | 306 | 306 | 0 |
| ita-sa | 380 | 380 | 380 | 380 | 0 |
| ita-sb | 390 | 355 | 368 | 368 | 13 |
| uefa-nl | 4 | 0 | 0 | 0 | 0 |
| uefa-ucl | 186 | 111 | 111 | 167 | 56 |
| uefa-uecl | 151 | 45 | 45 | 79 | 34 |
| uefa-uel | 184 | 82 | 82 | 172 | 90 |
| usa-mls | 460 | 460 | 460 | 460 | 0 |

### Az újonnan elemezhető meccsek – milyen forrás hozta az új adatot

| forrás (bővítés) | meccs, amelynél új adatot hozott |
|---|---|
| elozo_nemzetkozi_kupaidény | 180 |
| hazai_bajnoksag_csak_elozmeny_forrasbol | 158 |
| valogatott_naptari_ablak | 102 |
| kieso_elozo_elsoosztaly | 65 |

### A bővítés után is „kevés adat” – miért

| ok | meccs |
|---|---|
| kuszob_hazai_idegen_bontas | 204 |
| a_hazai_bajnoksag_nem_erheto_el_az_espn_ben | 101 |
| valoban_keves_meccs_a_forrasban | 98 |
| kuszob_hazai_idegen_bontas+valoban_keves_meccs_a_forrasban | 19 |
| kuszob_liga_atlag | 4 |

### Minőség (tájékoztató – a modell NEM változik)

- Az újonnan elemezhető meccseken a változatlan xg-poisson-1 a naiv alaphoz képest: Δ 1X2 log loss 0.08644 (95% CI 0.03154 … 0.14446; n=347); Δ O2,5 log loss 0.07794 (95% CI 0.04216 … 0.11520; n=347) (negatív = a modell jobb).
- A korábban is elemezhető meccseken a bővített adat az eredetihez képest: Δ 1X2 log loss 0.00148 (95% CI -0.00128 … 0.00419; n=4508); Δ O2,5 log loss -0.00144 (95% CI -0.00321 … 0.00036; n=4508) (negatív = a bővített adattal jobb).

## Csak-előzmény hazai bajnokságok a cache-ben

| liga | meccs |
|---|---|
| por-pl (por.1) | 918 |
| ned-ed (ned.1) | 927 |
| sco-pr (sco.1) | 508 |
| bel-pl (bel.1) | 939 |
| tur-sl (tur.1) | 1028 |
| aut-bl (aut.1) | 585 |
| sui-sl (sui.1) | 498 |
| gre-sl (gre.1) | 712 |
| den-sl (den.1) | 579 |
| nor-el (nor.1) | 720 |
| swe-al (swe.1) | 703 |
| isr-pl (isr.1) | 480 |
| cyp-1d (cyp.1) | 240 |
| rou-l1 (rou.1) | 719 |
| nir-pr (nir.1) | 513 |
| wal-pr (wal.1) | 390 |
| mlt-pl (mlt.1) | 379 |

Az ESPN-ben a kipróbált azonosítókkal NEM érhető el (pl. cseh, lengyel, horvát, szerb, ukrán, magyar, bolgár, szlovák bajnokság) – ezek klubjainál az adat ténylegesen nem hozzáférhető ebből a forrásból.

