# TIPPMIX AI – labdarúgás elemző és tipp-kutató platform

Magyar nyelvű, kutatás- és elemzésközpontú webalkalmazás: internetes forrásokból gyűjtött információt (hírek, hiányzók, külső előrejelzések) vet össze saját, átlátható statisztikai modellekkel (forma, várható gól, Poisson), és minden állítás mellé forrást tesz.

> **Fontos elvek**
> - Egyetlen előrejelzés sem garantált – minden szám valószínűségi *becslés*.
> - Nincs kitalált statisztika, sérülés, odds, forrás vagy URL. Ha nincs adat, az alkalmazás ezt mondja: *„Ehhez a mérkőzéshez jelenleg nem áll rendelkezésre elegendő ellenőrizhető adat.”*
> - A DEMO ADAT és az ÉLŐ adat sosem keveredik; a demo mindenhol jelölve van.
> - Az alkalmazás elemző eszköz, nem fogadási tanácsadó. Felelős játék: 18+, Játékosvédelmi vonal 06 80 205 305.

---

## Tartalom

1. [Gyors indítás](#gyors-indítás)
2. [Környezeti változók](#környezeti-változók)
3. [Projektstruktúra](#projektstruktúra)
4. [Architektúra és adatáramlás](#architektúra-és-adatáramlás)
5. [A kutatómotor működése](#a-kutatómotor-működése)
6. [A statisztikai és előrejelző modellek](#a-statisztikai-és-előrejelző-modellek)
7. [Hogyan számolódnak a tippek?](#hogyan-számolódnak-a-tippek)
8. [Adatminőség-mutató](#adatminőség-mutató)
9. [Historikus teljesítmény követése](#historikus-teljesítmény-követése)
9b. [Oddsok és a szelvényépítő](#oddsok-és-a-szelvényépítő)
10. [Új adatforrás hozzáadása](#új-adatforrás-hozzáadása)
11. [Új bajnokság hozzáadása](#új-bajnokság-hozzáadása)
12. [API végpontok](#api-végpontok)
13. [Tesztek](#tesztek)
14. [Jogi és etikai keretek](#jogi-és-etikai-keretek)

---

## Gyors indítás

Követelmény: **Node.js 22.13+** (a beépített `node:sqlite` modul miatt; nincs natív fordítás).

```bash
npm install
npm run dev
```

- Felület: http://localhost:5173 (Vite dev szerver, az `/api` hívásokat a 3001-es portra proxyzza)
- API: http://localhost:3001/api/status

Az alkalmazás **kulcs nélkül is élő adattal** fut:

| Adat | Forrás (kulcs nélkül) | Megjegyzés |
|---|---|---|
| Mérkőzések, eredmények, tabella, odds | ESPN nyilvános scoreboard/schedule JSON végpontok | Premier League, La Liga, Serie A, Bundesliga, Ligue 1, a másodosztályok (Championship, LaLiga 2, Serie B, 2. Bundesliga, Ligue 2), BL, EL, Konferencia-liga, MLS, UEFA Nemzetek Ligája (a válogatottak formájához a vb-selejtezők és barátságos meccsek is), magyar csapatnevekkel a válogatottaknál. Odds: amit az ESPN közöl (DraftKings), amerikai formátumból tizedesre váltva. |
| Hírek, hiányzók, külső tippek | Bing News RSS + Google News RSS | valós idejű hírkeresés; minden találat eredeti URL-lel, forrásnévvel, dátummal |

Miért nem Sofascore / Flashscore? Mindkét oldal felhasználási feltételei tiltják az automatikus adatkinyerést, és anti-bot védelem mögött vannak (a Sofascore API nem böngészős kérésre 403-at ad). A specifikáció szerint ezeket nem kerüljük meg, ezért nyilvános, feed-/API-célú forrásokat használunk.

A magyar **NB I / NB II** nincs az ESPN adatbázisában – ehhez `API_FOOTBALL_KEY` szükséges (lásd lent). A beépített **DEMO ADAT** csak explicit `DATA_MODE=demo` esetén aktív (teszteléshez); demo és élő adat sosem keveredik.

Production build:

```bash
npm run build
npm start
```

A `npm start` a 3001-es porton a `dist/` mappát és az API-t együtt szolgálja ki.

## Környezeti változók

Másold a `.env.example` fájlt `.env` néven. **A kulcsok kizárólag a szerveren élnek; a frontend kód sosem tartalmazza őket** (a `/api/status` végpont csak azt közli, hogy be vannak-e állítva).

| Változó | Jelentés |
|---|---|
| `PORT` | API port (alapértelmezés 3001) |
| `DATA_MODE` | `live` (alapértelmezés; kulcs nélkül ESPN + hír-RSS) vagy `demo` (beépített DEMO ADAT, csak teszteléshez) |
| `API_FOOTBALL_KEY` | opcionális – [API-Football](https://www.api-football.com/): ha meg van adva, ez a meccsadat-szolgáltató (NB I / NB II is) |
| `TAVILY_API_KEY` | opcionális – [Tavily](https://tavily.com/) teljes webes keresés a hír-RSS helyett |
| `BRAVE_SEARCH_API_KEY` | opcionális – Brave Search API a hír-RSS helyett |
| `ODDS_API_KEY` | opcionális – [The Odds API](https://the-odds-api.com/): több fogadóiroda ára, piaconként a legjobb odds (BTTS is); nélküle az ESPN által közölt DraftKings odds |
| `DATABASE_PATH` | SQLite fájl (alapértelmezés `./data/tippmix-ai.db`) |

## Projektstruktúra

```
src/
  shared/                 # UI-tól és szervertől független, tiszta kód
    types.ts              # Közös típusok (a modulok közti szerződés)
    engine/
      stats.ts            # Forma, gólpiacok, egymás elleni, tabella, liga-átlagok
      models.ts           # Várható gól modell + Poisson-modell
      evaluation.ts       # Értékelemzés (odds), adatminőség, külső konszenzus
      tips.ts             # Tippgenerátor (konzervatív / mérsékelt / magas variancia)
      slips.ts            # Szelvényépítő (kombinációk nyaláb-kereséssel, csak valódi oddsszal)
      markets.ts          # Piackódok, magyar címkék, eredmény-kiértékelés, szövegfelismerés
      analysis.ts         # Orchestrátor: MatchAnalysis összeállítása
  server/
    index.ts              # Express belépési pont
    container.ts          # Szolgáltatók kiválasztása env alapján (demo/élő)
    routes/api.ts         # REST API
    services/analysisService.ts  # Adatgyűjtés + elemzés + cache + előzmények
    data/
      provider.ts         # MatchDataProvider interfész
      espnProvider.ts     # Élő adat kulcs nélkül (ESPN nyilvános API) – alapértelmezett
      apiFootballProvider.ts       # Élő adat API-Football kulccsal (NB I/NB II is)
      demoProvider.ts     # DEMO adatszolgáltató (csak DATA_MODE=demo)
      demo/leagues.ts     # Bajnokságok, csapatok, derbik (itt bővíthető)
      demo/generate.ts    # Determinisztikus demo-adat generátor
    research/
      provider.ts         # ResearchProvider interfész
      webSearchResearch.ts# Internetes kutatás (keresési backend-ekkel)
      rssSearch.ts        # Kulcs nélküli backend: Bing News + Google News RSS – alapértelmezett
      demoResearch.ts     # DEMO kutatómotor (csak DATA_MODE=demo)
    odds/theOddsApi.ts    # Opcionális több-irodás odds forrás (ODDS_API_KEY), csapatnév + kezdési idő alapján párosít
    db/database.ts        # SQLite (node:sqlite): előzmények, szelvények, források, kézi odds, beállítások, HTTP cache
  client/
    App.tsx, main.tsx, styles.css
    components/           # Layout, UI elemek, diagramok, mérkőzéslista
    pages/                # Dashboard, Mai meccsek, Elemzés, Tippek, Statisztikák,
                          # Előzmények, Források, Beállítások, Mérkőzés, Csapat, Keresés
    lib/api.ts, lib/format.ts
tests/engine.test.ts      # Vitest: statisztikai motor, modellek, piacok, elemzés
```

## Architektúra és adatáramlás

```
[MatchDataProvider] ──meccsek, eredmények, odds──┐
                                                  ├─► AnalysisService ─► analyzeMatch() ─► MatchAnalysis ─► REST ─► React UI
[ResearchProvider] ──hírek, hiányzók, külső tippek, források──┘        │
                                                                        └─► Database (előzmények, források, kézi odds)
```

- A **kutatómotor** és az **adatszolgáltató** interfészen keresztül cserélhető (`ResearchProvider`, `MatchDataProvider`).
- Az **elemzőmotor** (`src/shared/engine`) tiszta függvényekből áll: ugyanaz a bemenet mindig ugyanazt a kimenetet adja, ezért egységtesztelhető.
- A `container.ts` dönti el az induláskor, hogy demo vagy élő szolgáltatók futnak. Keverés nincs.

## A kutatómotor működése

`ResearchProvider.research({ match, league, homeTeam, awayTeam })` → `ResearchResult`:

- `news[]` – hírek (kategória: sérülés, eltiltás, felállás, edző, átigazolás, rotáció, menetrend, általános)
- `availability` – hiányzók, felállás státusza (`nincs adat` / `várható` / `megerősített`), pihenőnapok, hét közbeni kupameccs
- `externalPredictions[]` – külső tippek: forrás, eredeti szöveg, felismert piac (vagy `null`), bizalom (ha a forrás adja), URL, dátum
- `sources[]` – **minden** külső információ forrásrekordja: név, URL (vagy `null`), lekérés ideje, típus, kinyert szöveg, módszer, eredet
- `warnings[]` – ha kevés/semmi adat, magyar figyelmeztetés

Az **internetes kutató** (`webSearchResearch.ts`) cserélhető keresési backend-del fut. Alapértelmezés kulcs nélkül: `rssSearch.ts` – Bing News RSS (eredeti cikk-URL + kivonat + forrásnév) és Google News RSS (forrásnév, Google-átirányító link) egyesítve, cím szerint deduplikálva. Kulccsal Tavily vagy Brave. Négy lekérdezés fut meccsenként: `"<hazai> vs <vendég> prediction"`, `"<csapat> team news injury"` (mindkét csapatra), `"<hazai> <vendég> preview lineup"`. Elvek:

- csak a kereső által visszaadott valódi URL-eket tárolja; URL-t sosem generál,
- a találat szövegrészletét idézetként tárolja,
- a külső tipp piacát egyszerű, konzervatív szövegmintákkal ismeri fel (`parsePredictionText`, csapatnév-alapú „X to win” mintákkal is); ha bizonytalan, `market = null` és a felület „nem felismerhető”-t mutat; az `autoExtracted` mező jelzi, hogy gépi felismerés történt; „predicted line-up” cikkek felállás-hírként, nem tippként kerülnek be,
- sérülés-/eltiltás-listát **nem** állít elő szövegből (túl hibalehetőséges) – a találatok hírként jelennek meg, forrással,
- hívások között késleltetés (rate limit), az eredmény 30 percig cache-elve az adatbázisban,
- nem kerül meg CAPTCHA-t, bejelentkezést, fizetőfalat; csak a kereső API nyilvános válaszát használja.

A **demo kutató** determinisztikus, „DEMO – …” nevű forrásokat ad `url = null`-lal, valódi játékosnevek és valódi médiumok nélkül.

## A statisztikai és előrejelző modellek

### Forma és gólpiacok (`stats.ts`)
- Utolsó 5 és 10 mérkőzés (bármely sorozat), külön hazai (utolsó 10 hazai) és idegen (utolsó 10 idegen) bontás.
- Gy/D/V, pont/meccs, lőtt/kapott gól, kapott gól nélküli meccsek, több/kevesebb mint 0,5–4,5, BTTS, félidei gólátlag (csak ha minden meccsnél van félidei adat).
- Gólpiaci „kombinált mutató” = a két csapat historikus gyakoriságának egyszerű átlaga. **Múltbeli statisztika, nem előrejelzés.**
- Egymás elleni (utolsó 10), tabella, liga-átlagok (hazai/vendég gól, 1X2 arányok, O2.5, BTTS).
- Lejátszott meccs elemzésekor csak a meccs *előtti* adatok számítanak (nincs jövőbe látás) – ezt használja a demo előzmény-feltöltés.

### Várható gól modell (`models.ts › xgModel`)
```
hazai támadóerő  = hazai csapat hazai lőtt gól/meccs   ÷ liga hazai gólátlag
hazai védőerő    = hazai csapat hazai kapott gól/meccs ÷ liga vendég gólátlag
vendég támadóerő = vendég csapat idegen lőtt gól/meccs ÷ liga vendég gólátlag
vendég védőerő   = vendég csapat idegen kapott gól/meccs ÷ liga hazai gólátlag
λ_hazai  = hazai támadóerő  × vendég védőerő × liga hazai gólátlag
λ_vendég = vendég támadóerő × hazai védőerő  × liga vendég gólátlag
```
Kis mintánál minden erősségmutató a semleges 1,0 felé zsugorodik: `x' = (n·x + k·1) / (n + k)` (k alapértelmezés 3, a Beállításokban módosítható). A modell nem fut, ha bármelyik csapatnak 3-nál kevesebb hazai/idegen meccse van, vagy a ligából 10-nél kevesebb meccs érhető el – ilyenkor a felület „nincs elegendő adat” üzenetet ad.

### Poisson-modell (`models.ts › poissonModel`)
A két csapat gólszáma független Poisson-eloszlású (`P(k) = λ^k e^-λ / k!`), 0–8 gólig számolt mátrixból: 1X2, dupla esély, döntetlennél tét vissza, gólszám-vonalak, BTTS, csapat-gólszám, ázsiai hendikep −1 (nyer/tét vissza/veszít), 8 legvalószínűbb pontos eredmény, csapatonkénti 0–5+ eloszlás. A modell a döntetlent jellemzően enyhén alulbecsüli – ezt a felület jelzi.

### Értékelemzés (`evaluation.ts`)
- Implikált valószínűség = `1 / odds` (az árrést nem távolítjuk el, ezt a felület jelzi).
- Különbség = modell − implikált, százalékpontban. ≥ +3 pp: „Pozitív modellkülönbség”, ≤ −3 pp: „Negatív modellkülönbség”, egyébként „Semleges”. **Nem nyereségígéret.**
- Odds forrása sorrendben: kézi bevitel (felület) → szolgáltató (demo/élő). Nincs odds → az értékelemzés nem fut.

## Hogyan számolódnak a tippek?

`tips.ts › generateTips` három kategóriában javasol piacokat a Poisson-eredmény alapján:

| Kategória | Jelöltek |
|---|---|
| Konzervatív | Több mint 1,5; a favorit dupla esélye (1X/X2); favorit több mint 0,5 gól; döntetlennél tét vissza (ha ≥ 60%) |
| Mérsékelt | Több/kevesebb mint 2,5 (amelyiket a modell favorizálja); BTTS igen/nem; favorit győzelem (ha ≥ 45%) különben DNB |
| Magas variancia | 2 legvalószínűbb pontos eredmény; több mint 3,5 (vagy kevesebb mint 1,5); favorit több mint 1,5 gól; ázsiai hendikep −1; döntetlen (ha ≥ 27%) |

Minden tipphez: modell-valószínűség, odds és implikált valószínűség (ha van), **támogató statisztikai mutatók** (pl. „Arsenal utolsó 10 meccsén több mint 2,5 gól: 70%”), mellette/ellene érvek, kockázatok (felállás nem megerősített, hiányzók, kis minta, hét közbeni kupameccs…), a támogató mutatók száma és a mintanagyság. A „Mai tippek” oldal **nem rangsorol** – mérhető jellemzők (modell-valószínűség, modell−implikált különbség, minta, mutatók száma, piactípus, adatminőség) szerint szűrhető, és minden sornál látszik, miért szerepel.

## Adatminőség-mutató

`evaluation.ts › computeDataQuality` 0–100 pontot ad (🟢 magas ≥ 70, 🟡 közepes ≥ 40, 🔴 kevés adat) az alábbiak alapján: historikus meccsek száma, hazai/idegen minta, liga-minta, ellenőrizhető (URL-lel rendelkező) források száma, aktuális csapatinformáció, megerősített kezdőcsapatok, odds elérhetősége, adatok frissessége. **Ez adatminőség, nem nyerési esély.** A demo források URL nélküliek, ezért a „források” tényező demo módban sosem teljesül.

## Historikus teljesítmény követése

- Mérkőzés oldalon a „Mentés az előzményekhez” gomb rögzíti a tippet (dátum, mérkőzés, bajnokság, piac, modell-valószínűség, odds, kategória, típus, eredet).
- A függő tippek a meccs lejátszása után automatikusan lezáródnak (`evaluateMarket`: nyert / vesztett / érvénytelen, pl. döntetlennél tét vissza).
- Lezárt rekord soha nem módosul; a vesztes tippek nem rejthetők el.
- Összesítés: összes/lezárt/helyes/helytelen/érvénytelen, tényleges találati arány, átlagos modell-valószínűség (kalibráció-jelzés), ROI 1 egység téttel (csak oddsszal rendelkező tippeknél), találati arány modell-valószínűség sávonként.
- Demo módban induláskor az utolsó két lejátszott demo forduló meccseire a modell *meccs előtti adatokból* elmenti a konzervatív és mérsékelt kategória első tippjét, majd a demo eredménnyel lezárja – így az oldal őszinte demo statisztikát mutat (jellemzően negatív ROI a demo odds árrése miatt).

## Oddsok és a szelvényépítő

**Odds források (sorrendben):** kézi bevitel a mérkőzés oldalán → The Odds API (ha van `ODDS_API_KEY`; több iroda, piaconként a legjobb ár, az iroda neve feljegyezve) → az adatszolgáltató által közölt odds (ESPN: DraftKings 1X2 + egy gólszám-vonal). Odds-ot sosem találunk ki: amelyik piachoz nincs valódi odds, az nem kerül szelvényre és az értékelemzésben „nincs odds” marad.

**Szelvényépítő** (`src/shared/engine/slips.ts`, oldal: *Szelvények*): a megadott időszak (legfeljebb 10 nap, legfeljebb 60 meccs) még le nem játszott mérkőzéseit elemzi, a valódi oddsszal rendelkező tippekből lábakat képez (mérkőzésenként legfeljebb egy láb), és nyaláb-kereséssel (lábszámonként külön nyaláb) keresi a legjobb kombinációkat három stratégia szerint:

| Stratégia | Cél | Lábak szűrése |
|---|---|---|
| Legnagyobb esély | max Π p (modell-valószínűségek szorzata) az összodds alsó korlátja mellett | p ≥ küszöb |
| Kiegyensúlyozott | max Σ log p + 0,35·Σ log odds | p ≥ küszöb |
| Modell-előny | max Π (p × odds) | p ≥ küszöb és modell − implikált > 0 |

Minden szelvénynél: összodds, együttes modell-esély (Π p – függetlenséget feltételez), implikált együttes esély (1/összodds), különbség, várható visszatérülés 1 egységre (Π p × összodds), valamint figyelmeztetések (kevés adatú láb, kevés támogató mutató, negatív modellkülönbség, 15+ pp-os modell–piac eltérés – ami inkább a modell túlbecslését jelzi –, alacsony együttes esély). A „Szelvény mentése” minden lábat tippként rögzít; a szelvény kimenete a lábakból számolódik (egy vesztes láb = vesztett; érvénytelen láb kiesik), és az Előzményekben szelvény-találati arány és ROI is látszik.

**Fontos:** „a legnagyobb esély, hogy bejöjjön” a *modell szerinti* legnagyobb esélyt jelenti. A fogadóirodák oddsai általában jobban kalibráltak, mint egy gólstatisztikára épülő modell; a felület ezt minden szelvénynél jelzi.

## Regisztráció és bejelentkezés (Supabase Auth)

A hitelesítés a Supabase JavaScript klienssel, kizárólag a frontendben fut (`src/client/lib/supabase.ts`, `src/client/auth/`). Kulcs nélkül ki van kapcsolva és az app nyitva marad.

1. supabase.com → új projekt → **Authentication → Providers → Email** engedélyezve.
2. **Settings → API**: másold a Project URL-t és a **publishable** (vagy régi *anon public*) kulcsot a `.env`-be: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Ezek nyilvános értékek; a *service_role / secret* kulcsot soha ne használd a frontendben.
3. **Authentication → URL Configuration**: Site URL = `http://localhost:5173`, Redirect URLs: `http://localhost:5173/bejelentkezes`, `http://localhost:5173/uj-jelszo` (élesben a saját domainnel is).
4. Fejlesztéshez az e-mail-megerősítés kikapcsolható: Authentication → Providers → Email → „Confirm email” ki.

Útvonalak: `/regisztracio`, `/bejelentkezes`, `/elfelejtett-jelszo`, `/uj-jelszo` (a visszaállító link ide hoz). A dashboard (`/`) bejelentkezéshez kötött; bejelentkezett felhasználót a bejelentkező/regisztrációs oldal a dashboardra irányít. A munkamenet localStorage-ban perzisztens, a fejléc mutatja az e-mail-címet és a kijelentkezést.

### Profil és előfizetés (profiles tábla)

`supabase/migrations/0001_profiles.sql` – futtasd a Supabase SQL Editorban:
- `public.profiles` (id → auth.users, email, subscription_status `free|pro|past_due|canceled`, stripe_customer_id, stripe_subscription_id, subscription_end, created_at, updated_at)
- trigger: regisztrációkor automatikus profil-sor (és e-mail-változás követése); a már meglévő felhasználókhoz is létrejön
- RLS: a felhasználó csak a saját sorát olvashatja; **nincs** insert/update/delete policy a frontendnek – az előfizetési mezőket csak a szerver (service_role, később Stripe webhook) írhatja; védőháló-trigger a védett oszlopokra
- `is_pro()` segédfüggvény (a `subscription_end` figyelembevételével)

Frontend: `useProfile()` (csak olvasás), a Dashboard fiók-kártyája (e-mail, státusz, FREE/PRO jelvény), `/pro` oldal, PRO jelvény a fejlécben. Stripe még nincs bekötve.

### Stripe előfizetés (PRO)

Szerveroldali réteg: `src/server/billing/` – `stripeRoutes.ts` (Checkout, ügyfélportál, ár, webhook), `supabaseAdmin.ts` (service_role kliens + token-ellenőrzés), `entitlement.ts` (`requirePro` middleware a `/api/slips*` és `/api/history*` végpontokon). A frontend `api.ts` minden kéréshez csatolja a Supabase access tokent; a PRO/FREE állapotot a szerver a `profiles` táblából dönti el.

Env (csak szerver): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO`, `APP_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Helyi webhook: `stripe listen --forward-to localhost:3001/api/billing/webhook`. Kezelt események: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed` (aláírás-ellenőrzés, idempotencia a `stripe_events` táblában). Státusz-leképezés: active/trialing → `pro`, past_due/unpaid → `past_due`, canceled/expired → `canceled`; `subscription_end` = aktuális időszak vége.

### Biztonsági modell (összefoglaló)

- **Titkok** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, API-kulcsok) csak a szerveren, `.env`-ben (gitignore); a frontend csak a `VITE_SUPABASE_*` nyilvános értékeket kapja.
- **Jogosultság a szerveren dől el**: minden `/api` kérésnél a Supabase access tokenből + `profiles` táblából (`attachPlan`). A felület lakatai csak megjelenítés.
  - PRO-csak: `/api/slips*`, `/api/history*`, `POST /api/matches/:id/predictions` → 401/403.
  - FREE nézet szerveroldali kitakarással: `/api/tips` (napi 3, indoklás nélkül), `/api/matches/:id/analysis` (napi meccs-kvóta → 403; részletes statisztika és modell-indoklás nélkül), `/api/standings` (csak liga-átlag), `?refresh=1` csak PRO.
  - Admin (`ADMIN_EMAILS`): `POST /api/settings`, kézi odds.
- **profiles**: RLS – csak saját sor olvasható; írási policy nincs; trigger védi az előfizetési oszlopokat; `is_pro()` csak a saját állapotot adja. Írás kizárólag service_role-lal (Stripe webhook / sync).
- **Stripe**: webhook aláírás-ellenőrzés nyers body-n, idempotencia (`stripe_events`), ügyfél–felhasználó összerendelés szerveroldali metadata/`client_reference_id` alapján.
- Bemenet-ellenőrzés (dátum, azonosítók, piackódok), 100 kB body-limit, IP-nkénti kérés-korlát, biztonsági fejlécek.
- Helyi, Supabase nélküli futtatásnál (nincs `SUPABASE_SERVICE_ROLE_KEY`) minden nyitott – egyfelhasználós mód.

### Adatbázis-architektúra (hibrid)

| Adat | Hol | Miért |
|---|---|---|
| `predictions`, `slips`, `app_settings`, `manual_odds`, `stripe_events` | **Supabase PostgreSQL** (`supabase/migrations/0003_app_data.sql`) | tartós, felhasználóhoz kötött, mentendő; több szerverpéldány is elérheti |
| `http_cache`, `research_cache`, `sources` | **helyi SQLite** (`data/*.db`) | eldobható, TTL-es, nagy forgalmú (~125 MB) – hálózati körönként lassítaná az elemzést és felélné a Postgres kvótát |

- Kód: `src/server/db/database.ts` (homlokzat) → `appStore.ts` (Postgres/SQLite) + `cacheDb.ts` (cache).
- Ha nincs `SUPABASE_SERVICE_ROLE_KEY`, a tartós adat helyi SQLite-ba megy (`app_*` táblák) – csak fejlesztéshez; az indítási napló és az `/api/status` jelzi.
- **Felhasználói izoláció:** a `user_id` kizárólag a hitelesített Supabase tokenből jön (`res.locals.plan.user.id`); minden lekérdezés `user_id`-re szűr; RLS-ben a felhasználó csak a saját sorait olvashatja, írni csak a szerver tud service_role-lal.
- **Konkurencia:** `ON CONFLICT DO NOTHING` a tippekre (egyedi `user_id+match_id+market`), feltételes `UPDATE … WHERE outcome='függőben'` a lezárásra, atomi „claim” a Stripe eseményekre (hiba esetén felszabadítás).

Hasznos parancsok: `npm run migrate <sql>`, `npm run check:schema`, `npm run verify:security` (utóbbi két ideiglenes teszt-felhasználóval méri az izolációt, majd törli őket).

## Új adatforrás hozzáadása

**Meccsadat:** implementáld a `MatchDataProvider` interfészt (`src/server/data/provider.ts`): `getLeagues`, `getTeams`, `getTeam`, `getMatches`, `getMatch`, `getResultsForAnalysis`, `getTeamResults`, `getLeagueResults`, `getOdds`, opcionálisan `getSeasonStart` (tabella-szűréshez). Minden visszaadott rekord `origin: 'live'`. Regisztráld a `container.ts`-ben. Az ESPN-szolgáltató mintát ad a cache-elésre (memória + SQLite `http_cache`, legfeljebb 4 párhuzamos kérés) és a feljutott csapatok előző idényének (másodosztály) bevonására – ilyenkor az elemzés kockázatai között jelezzük az alacsonyabb osztályt.

**Kutatás:** implementáld a `ResearchProvider`-t (`src/server/research/provider.ts`). Szabályok: minden információhoz `SourceRecord` valódi URL-lel vagy `url: null`; ha nincs találat, üres lista + `warnings`. Új keresőmotorhoz elég egy `SearchBackend` (`search(query, max) → {title, url, snippet, publishedAt}[]`) a `webSearchResearch.ts`-ben.

## Új bajnokság hozzáadása

- **ESPN (alapértelmezett élő):** `src/server/data/espnProvider.ts` – vegyél fel egy `League` bejegyzést az `ESPN_LEAGUES` tömbbe és a hozzá tartozó ESPN slugot a `SLUG` táblába (pl. `'ned-ere': 'ned.1'`); másodosztálynál a `SECOND_TIER` táblát is bővítsd.
- **API-Football:** `src/server/data/demo/leagues.ts` `LEAGUES` tömbjében az `externalId` az API-Football liga id.
- **Demo:** ugyanott a `TEAMS` tömbbe a csapatok (`attack`, `defense`), opcionálisan `DERBIES` (ezt az élő mód is használja rangadó-felismeréshez, név alapján).

## API végpontok

| Végpont | Leírás |
|---|---|
| `GET /api/status` | adatmód, szolgáltatók, kulcsok konfigurálva-e (értékek nélkül) |
| `GET /api/leagues` | bajnokságok |
| `GET /api/matches?date=&from=&to=&leagueId=&country=&teamId=&importance=&status=` | mérkőzések csapatokkal |
| `GET /api/matches/:id` | egy mérkőzés |
| `GET /api/matches/:id/analysis[?refresh=1]` | teljes elemzés (kutatás + modellek + tippek + források) |
| `POST /api/matches/:id/odds` `{markets:{O2.5:"1.90"}}` / `DELETE` | kézi odds (validált: >1,00) |
| `POST /api/matches/:id/predictions` `{market}` | tipp mentése az előzményekhez |
| `GET /api/tips?date=` | a nap összes tippje (a szűrés a kliensen) |
| `GET /api/slips?from=&to=&legs=&minOdds=&minLegProb=&strategy=` | szelvényépítés (legfeljebb 10 napos időszak) |
| `GET /api/slips/saved` · `POST /api/slips` `{strategy,label,legs:[{matchId,market}]}` | mentett szelvények / mentés |
| `GET /api/standings/:leagueId` | tabella + liga-átlagok |
| `GET /api/teams/:id` | csapat forma, közelgő és legutóbbi meccsek |
| `GET /api/search?q=` | csapat / bajnokság / közelgő meccs keresés (ékezet-független) |
| `GET /api/history?leagueId=&market=&from=&to=&minProb=&maxProb=` | előzmények + összesítés |
| `POST /api/history/settle` | függő tippek lezárása |
| `GET /api/sources?matchId=&origin=` | forrásnapló |
| `GET/POST /api/settings` | modellparaméter (zsugorítás k) |

Hibák: `{ "error": "magyar üzenet" }` megfelelő HTTP státusszal (400 érvénytelen adat, 404 nincs ilyen, 409 duplikált tipp).

## Tesztek

```bash
npm test          # Vitest – statisztikai motor, Poisson, xG, piacok, érték, konszenzus, adatminőség, teljes elemzés, demo determinizmus
npm run typecheck # TypeScript
```

Kézi ellenőrző lista (elvégezve): minden oldal betölt; globális keresés; mérkőzés-elemzés; üres-adat állapot („nincs elegendő ellenőrizhető adat”); érvénytelen odds elutasítva; nem létező mérkőzés/oldal kezelése; mobil elrendezés (kártyák egymás alatt, diagramok átméreteződnek, nincs vízszintes görgetés); forráshivatkozások (demo: „nincs ellenőrizhető URL”); demo adat mindenhol jelölve; kulcsok nem szerepelnek a frontend buildben.

## Jogi és etikai keretek

- Az internetes kutatás csak nyilvános feedek/keresési API-k válaszát használja; tiszteletben tartja a rate limiteket (párhuzamosság-korlát, késleltetés, cache); nem kerül meg CAPTCHA-t, bejelentkezést, fizetőfalat vagy anti-bot védelmet; a találatokból csak rövid részletet tárol, forrásmegjelöléssel és eredeti linkkel.
- A Google News RSS feed a Google szabályzata szerint személyes, nem kereskedelmi feed-olvasásra használható – ez az alkalmazás személyes elemzőeszköz. Kereskedelmi használathoz állíts be Tavily/Brave kulcsot, és vedd ki a Google feedet a `CombinedRssBackend`-ből.
- Az ESPN végpontok nyilvánosak, de nem hivatalosan dokumentáltak – a szolgáltató bármikor módosíthatja őket; ilyenkor az alkalmazás üres listát és hibát mutat, nem pótol adatot.
- Sofascore/Flashscore adatot szándékosan nem használunk (ToS + anti-bot).
- Az alkalmazás nem ösztönöz tétemelésre és nem állít nyereséget. A „pozitív modellkülönbség” statisztikai megfigyelés, nem ajánlás.
- Felelős játék: a szerencsejáték függőséget okozhat. Csak 18 éven felülieknek. Segítség: Játékosvédelmi vonal 06 80 205 305.
