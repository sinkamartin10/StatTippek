# corners-nb-1 – időrendi visszateszt

Futtatva: 2026-10-13T22:13:44.806Z · adatforrás: ESPN nyilvános scoreboard (havi lekérés), 612 hónap-lekérés · 13743 érvényes meccs (202307–202606).

Szabályok: csak befejezett, rendes játékidős meccs; mindkét csapat szögletszáma kell; hiányzó érték soha nem nulla; az üres (csupa nulla, pl. 0%–0% labdabirtoklású) statisztika-blokk hiányzó adatnak számít; duplikátum event ID szerint kiszűrve. A becslések a kezdés előtt 3 órával lezárt adatokból készülnek.

> **Adatminőségi javítás:** az első futás ÉRVÉNYTELEN volt – a parser az ESPN üres statisztika-blokkjainak „0” helyőrzőit valódi 0 szögletként fogadta el (Championship: a meccsek közel fele; EPL/MLS: néhány meccs). A hibát adat-szabállyal javítottuk (`empty_stats`), a hangolási rács, a holdout-időszak és a kiadási kapu változatlan; paramétert a holdout alapján nem módosítottunk.

## Kiadási kapu

**ÁTMENT** – a modell a rögzített holdouton jobb a baseline-nál.


## Lefedettség ligánként és idényenként (érvényes / befejezett rendes játékidős+kizárt)

| Liga | 2023-24 | 2024-25 | 2025-26 |
|---|---|---|---|
| Premier League (eng-pl) | 380/380 (100.0%) | 368/380 (96.8%) | 380/380 (100.0%) |
| La Liga (esp-ll) | 380/380 (100.0%) | 376/380 (98.9%) | 380/380 (100.0%) |
| Serie A (ita-sa) | 379/380 (99.7%) | 375/380 (98.7%) | 380/380 (100.0%) |
| Bundesliga (ger-bl) | 306/306 (100.0%) | 305/306 (99.7%) | 306/306 (100.0%) |
| Ligue 1 (fra-l1) | 304/306 (99.3%) | 296/306 (96.7%) | 305/305 (100.0%) |
| Bajnokok Ligája (uefa-ucl) | 122/125 (97.6%) | 185/189 (97.9%) | 186/189 (98.4%) |
| Európa-liga (uefa-uel) | 137/141 (97.2%) | 183/189 (96.8%) | 184/189 (97.4%) |
| Konferencia-liga (uefa-uecl) | 134/141 (95.0%) | 146/153 (95.4%) | 151/153 (98.7%) |
| MLS (usa-mls) | 530/536 (98.9%) | 508/521 (97.5%) | 457/468 (97.6%) |
| Championship (eng-ch) | 557/557 (100.0%) | 25/557 (4.5%) | 556/557 (99.8%) |
| LaLiga 2 (esp-l2) | 468/468 (100.0%) | 467/468 (99.8%) | 468/468 (100.0%) |
| Serie B (ita-sb) | 5/390 (1.3%) | 390/390 (100.0%) | 390/390 (100.0%) |
| 2. Bundesliga (ger-b2) | 126/126 (100.0%) | 306/306 (100.0%) | 306/306 (100.0%) |
| Ligue 2 (fra-l2) | 4/380 (1.1%) | 306/306 (100.0%) | 306/306 (100.0%) |
| Nemzetek Ligája (uefa-nl) | 2/2 (100.0%) | 179/184 (97.3%) | 4/4 (100.0%) |
| Vb-selejtező (UEFA) (fifa-wcq-uefa) | 0/0 (–) | 48/48 (100.0%) | 152/156 (97.4%) |
| Válogatott barátságos (fifa-friendly) | 239/368 (64.9%) | 79/168 (47.0%) | 217/377 (57.6%) |

Kizárási okok összesítve:

- empty_stats: 1695
- extra_time: 93

- A magyar NB I nincs az ESPN-ben – nem támogatott, nem mérhető.
- Barátságos válogatott: a modell nem fut rá (CORNER_UNSUPPORTED_LEAGUES).

## Hangolás (2024–25, csak hangolási célmeccsek)

Célmeccsek: 4463. Rács: k ∈ {0,2,5,10,20}, ablak ∈ {5,10,20}, eloszlás ∈ {negbin, poisson}. Választás: átlagos log loss.

| k | ablak | eloszlás | értékelhető meccs | log loss | Brier |
|---|---|---|---|---|---|
| 20 | 20 | negbin | 3807 | 0.60154 | 0.20692 |
| 20 | 10 | negbin | 3807 | 0.60162 | 0.20697 |
| 20 | 5 | negbin | 3807 | 0.60372 | 0.20784 |
| 10 | 10 | negbin | 3807 | 0.60419 | 0.20803 |
| 10 | 20 | negbin | 3807 | 0.60450 | 0.20806 |
| 20 | 10 | poisson | 3807 | 0.60564 | 0.20813 |
| 20 | 20 | poisson | 3807 | 0.60615 | 0.20819 |
| 10 | 5 | negbin | 3807 | 0.60655 | 0.20902 |
| 20 | 5 | poisson | 3807 | 0.60780 | 0.20906 |
| 5 | 20 | negbin | 3807 | 0.60944 | 0.20987 |
| 10 | 10 | poisson | 3807 | 0.61055 | 0.20975 |
| 5 | 10 | negbin | 3807 | 0.61069 | 0.21058 |
| 10 | 20 | poisson | 3807 | 0.61154 | 0.20986 |
| 10 | 5 | poisson | 3807 | 0.61269 | 0.21075 |
| 5 | 5 | negbin | 3807 | 0.61586 | 0.21273 |
| 2 | 20 | negbin | 3807 | 0.61625 | 0.21221 |
| 5 | 20 | poisson | 3807 | 0.61969 | 0.21235 |
| 5 | 10 | poisson | 3807 | 0.62134 | 0.21324 |
| 2 | 10 | negbin | 3807 | 0.62190 | 0.21463 |
| 0 | 20 | negbin | 3807 | 0.62586 | 0.21517 |
| 5 | 5 | poisson | 3807 | 0.62737 | 0.21570 |
| 2 | 20 | poisson | 3807 | 0.63042 | 0.21547 |
| 2 | 5 | negbin | 3807 | 0.63807 | 0.22075 |
| 2 | 10 | poisson | 3807 | 0.63896 | 0.21858 |
| 0 | 10 | negbin | 3807 | 0.63955 | 0.22027 |
| 0 | 20 | poisson | 3807 | 0.64498 | 0.21929 |
| 2 | 5 | poisson | 3807 | 0.66101 | 0.22598 |
| 0 | 10 | poisson | 3807 | 0.66565 | 0.22578 |
| 0 | 5 | negbin | 3807 | 0.68947 | 0.23603 |
| 0 | 5 | poisson | 3807 | 0.73568 | 0.24462 |

Kiválasztott: **k=20, ablak=20, negbin**.

## Holdout (2025–26) – modell vs. liga-átlag baseline

Célmeccsek: 4911 · értékelhető (a modell adatminimumait teljesíti): **4657** · kihagyva hiány miatt: home_team: 140, away_team: 141, home_venue: 142, away_venue: 141 (egy meccs több okból is kimaradhat).

| | rekord | log loss modell | log loss baseline | Brier modell | Brier baseline |
|---|---|---|---|---|---|
| Összes | 74512 | 0.60325 | 0.60945 | 0.20774 | 0.21034 |
| total | 27942 | 0.61630 | 0.61679 | 0.21348 | 0.21365 |
| home | 23285 | 0.59677 | 0.60799 | 0.20509 | 0.20988 |
| away | 23285 | 0.59406 | 0.60211 | 0.20350 | 0.20685 |

Páros meccsenkénti bootstrap (1000 újramintavétel), Δ = modell − baseline (negatív = a modell jobb):

- log loss: Δ = -0.00620 (95% CI -0.00836 … -0.00414)
- Brier: Δ = -0.00260 (95% CI -0.00352 … -0.00174)
- log loss, total: Δ = -0.00048 (95% CI -0.00320 … 0.00245)
- log loss, home: Δ = -0.01122 (95% CI -0.01462 … -0.00763)
- log loss, away: Δ = -0.00804 (95% CI -0.01128 … -0.00461)

### Piaconként

| Piac | vonal | meccs | log loss modell | baseline | Brier modell | baseline |
|---|---|---|---|---|---|---|
| total | 7.5 | 4657 | 0.5947 | 0.5946 | 0.2027 | 0.2024 |
| total | 8.5 | 4657 | 0.6698 | 0.6707 | 0.2385 | 0.2389 |
| total | 9.5 | 4657 | 0.6912 | 0.6916 | 0.2490 | 0.2492 |
| total | 10.5 | 4657 | 0.6586 | 0.6603 | 0.2330 | 0.2338 |
| total | 11.5 | 4657 | 0.5909 | 0.5905 | 0.2008 | 0.2006 |
| total | 12.5 | 4657 | 0.4926 | 0.4930 | 0.1569 | 0.1569 |
| home | 2.5 | 4657 | 0.4412 | 0.4500 | 0.1360 | 0.1385 |
| home | 3.5 | 4657 | 0.5926 | 0.6032 | 0.2020 | 0.2063 |
| home | 4.5 | 4657 | 0.6697 | 0.6826 | 0.2385 | 0.2447 |
| home | 5.5 | 4657 | 0.6717 | 0.6842 | 0.2395 | 0.2455 |
| home | 6.5 | 4657 | 0.6087 | 0.6200 | 0.2094 | 0.2143 |
| away | 2.5 | 4657 | 0.5721 | 0.5798 | 0.1925 | 0.1955 |
| away | 3.5 | 4657 | 0.6736 | 0.6824 | 0.2404 | 0.2446 |
| away | 4.5 | 4657 | 0.6671 | 0.6772 | 0.2372 | 0.2421 |
| away | 5.5 | 4657 | 0.5853 | 0.5928 | 0.1986 | 0.2015 |
| away | 6.5 | 4657 | 0.4722 | 0.4784 | 0.1488 | 0.1505 |

### Ligánként

| Liga | meccs | log loss modell | baseline | Brier modell | baseline |
|---|---|---|---|---|---|
| eng-ch | 523 | 0.6078 | 0.6081 | 0.2097 | 0.2097 |
| eng-pl | 380 | 0.6051 | 0.6134 | 0.2085 | 0.2121 |
| esp-l2 | 444 | 0.6065 | 0.6068 | 0.2090 | 0.2090 |
| esp-ll | 380 | 0.5957 | 0.6096 | 0.2045 | 0.2104 |
| fifa-wcq-uefa | 151 | 0.6018 | 0.6292 | 0.2074 | 0.2193 |
| fra-l1 | 305 | 0.6109 | 0.6160 | 0.2111 | 0.2132 |
| fra-l2 | 282 | 0.5898 | 0.5964 | 0.2016 | 0.2043 |
| ger-b2 | 290 | 0.6081 | 0.6095 | 0.2097 | 0.2103 |
| ger-bl | 306 | 0.6067 | 0.6105 | 0.2093 | 0.2108 |
| ita-sa | 380 | 0.5930 | 0.6002 | 0.2035 | 0.2064 |
| ita-sb | 358 | 0.6033 | 0.6088 | 0.2077 | 0.2101 |
| uefa-nl | 4 | 0.5354 | 0.6106 | 0.1798 | 0.2122 |
| uefa-ucl | 178 | 0.5936 | 0.6079 | 0.2037 | 0.2097 |
| uefa-uecl | 69 | 0.6021 | 0.6137 | 0.2073 | 0.2125 |
| uefa-uel | 151 | 0.5941 | 0.5957 | 0.2039 | 0.2043 |
| usa-mls | 456 | 0.6140 | 0.6195 | 0.2124 | 0.2148 |

### Kalibráció (holdout, minden vonal)

| sáv | n (modell) | átl. p | tényleges | n (baseline) | átl. p | tényleges |
|---|---|---|---|---|---|---|
| 0.0–0.1 | 270 | 0.086 | 0.100 | 0 | – | – |
| 0.1–0.2 | 5712 | 0.163 | 0.168 | 4819 | 0.176 | 0.171 |
| 0.2–0.3 | 11995 | 0.251 | 0.252 | 12782 | 0.257 | 0.254 |
| 0.3–0.4 | 12308 | 0.349 | 0.349 | 11928 | 0.348 | 0.346 |
| 0.4–0.5 | 11203 | 0.449 | 0.459 | 11352 | 0.442 | 0.447 |
| 0.5–0.6 | 10417 | 0.549 | 0.566 | 12446 | 0.556 | 0.569 |
| 0.6–0.7 | 10189 | 0.649 | 0.666 | 8436 | 0.657 | 0.681 |
| 0.7–0.8 | 8007 | 0.746 | 0.753 | 8111 | 0.734 | 0.735 |
| 0.8–0.9 | 4133 | 0.842 | 0.845 | 4601 | 0.836 | 0.832 |
| 0.9–1.0 | 278 | 0.914 | 0.910 | 37 | 0.904 | 0.757 |

## Függetlenségi feltételezés

A holdout meccseken a hazai és vendég szögletszám Pearson-korrelációja: **-0.248** (n = 4911). Az összes szöglet eloszlása a két oldal konvolúciója; ennek kalibrációja a „total” sorokban látható.

## Korlátok

- A visszateszt egy valós adatforráson, két idényen fut; a mért különbség más ligákra/időszakokra nem garantáltan általánosítható.
- A tesztek sikeressége nem bizonyítja a modell előrejelző pontosságát; erre csak ez a holdout-mérés utal.
- Szöglet-odds nincs a forrásban, ezért value/megtérülés nem mérhető.
