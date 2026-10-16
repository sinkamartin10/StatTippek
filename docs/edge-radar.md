# Edge Radar (kísérleti)

`GET /api/edge-radar?date=YYYY-MM-DD` – csak PRO (a meglévő `requirePro` mögött). Felület: `/edge-radar` (Felfedezés menü).

## Kapcsoló: `EDGE_RADAR_ENABLED`
- **Alapértelmezés: KIKAPCSOLVA.** Csak `true` / `1` / `on` / `yes` kapcsolja be (kis-nagybetű mindegy);
  hiányzó, üres vagy bármilyen más érték → kikapcsolva.
- Kikapcsolva a végpont **503 `EDGE_RADAR_DISABLED`** választ ad (a jogosultság-ellenőrzés után:
  nem bejelentkezve 401, FREE-vel 403 marad), és semmilyen Edge-számítás nem fut. A felület ezt
  „jelenleg nincs bekapcsolva” állapotként mutatja.
- Indításkor a szervernapló kiírja: `Edge Radar: bekapcsolva` / `Edge Radar: KIKAPCSOLVA …`.
- **Bekapcsolás Renderen:** a backend szolgáltatás → *Environment* → `EDGE_RADAR_ENABLED` = `true` →
  *Save* (a Render újraindítja a szolgáltatást). Ellenőrzés: a fenti naplósor, illetve PRO-munkamenettel
  a végpont 200-at ad.
- **Vészkikapcsolás:** ugyanott `EDGE_RADAR_ENABLED` = `false` (vagy a változó törlése) → *Save*.
  Adatbázis-művelet nem kell; a tippek, az archívum és az előfizetések nem érintettek.
- A kapcsoló a Renderen jelenleg NINCS beállítva (ezt ez a dokumentum nem állítja be).

## Dátum
`date` kötelező, szigorúan `YYYY-MM-DD`, létező nap, és **a mai nap + legfeljebb 7 naptári nap**
(különben 400: `DATE_REQUIRED` / `INVALID_DATE` / `DATE_OUT_OF_RANGE` – utóbbi a `min`/`max` mezőkkel).
A „mai nap” a **budapesti naptári nap** (`Europe/Budapest`, a meglévő közös `dayKey()` – ugyanaz, mint
a küldetéseknél), a napok hozzáadása naptári napokkal történik (`src/shared/edgeDates.ts`). A szerver és a
felület dátumválasztója ugyanezt a modult használja, így a gép / böngésző időzónájától függetlenül
ugyanazt a tartományt értik; a mérvadó a szerver. (A `/api/tips` és a meccsadat-réteg napértelmezése
ettől függetlenül változatlan.)

## Mit ad vissza
Napi bontásban minden oddsszal rendelkező piacra: odds, iroda, forrás, megfigyelési idő és kor, nyers
implikált valószínűség (`1/odds`), árrésmentesített valószínűség (ha igazolhatóan lehet), és a
modell–piac különbség százalékpontban (`edgePp`) – ez utóbbi csak a minden feltételnek megfelelő
sorokban. A többi sor kizárási okkal (`excludeReason`) szerepel. EV-t / várható nyereséget nem ad.

## Korlátok
- **Kísérleti funkció.** A százalékpontos különbség nem garantál nyereséget.
- **A modell kalibrációja nincs igazolva** (kevés, időben koncentrált elszámolt minta).
- **Megfigyelési idő ≠ odds-változás ideje.** Az `observedAt` a saját forráslekérésünk ideje
  (cache-találatnál az eredeti lekérésé); azt igazolja, hogy az odds legkésőbb ekkor így állt.
- **Az árrésmentesítés arányos normalizálás** – közelítés, nem a „valódi” piaci valószínűség; csak
  egy iroda egyetlen megfigyeléséből származó, teljes kimenetelkészletre fut (1X2, azonos vonalú O/U).
- **Az odds-lefedettség bajnokságonként változik** (pl. Európa-liga, Konferencialiga: jelenleg nincs
  ESPN-odds); a forrás gyakorlatilag egy iroda.
- A meccsek napi szűrését a meglévő meccsadat-réteg a szerver helyi ideje szerint végzi; ha a szerver UTC-ben fut, a budapesti éjfél körüli meccsek napja eltérhet (a `/api/tips`-et is ugyanígy érinti).
- Friss megfigyelésnél az elemzési cache (≤ 5 perc) miatt a sor átmenetileg `analysis_odds_mismatch`
  kizárást kaphat – ezt szándékosan nem kerüljük meg újraszámolással.
