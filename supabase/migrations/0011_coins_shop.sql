-- ===========================================================================
-- 0011 – Coin + Customization Shop (5a szakasz: séma és vásárlás-RPC)
--
-- MIT HOZ LÉTRE:
--   public.user_coins          – egyenleg felhasználónként (egy sor / user)
--   public.coin_transactions   – auditálható tranzakciós napló
--   public.shop_items          – az item-katalógus (az admin itt szerkeszt)
--   public.user_shop_items     – a felhasználó készlete (mi van meg)
--   public.purchase_shop_item()– ATOMIKUS vásárlás
--
-- KOMPETITÍV INTEGRITÁS: a coin kizárólag kozmetikumra váltható. Ez a migráció
-- nem nyúl az XP-hez, a Tippverseny-pontozáshoz, a FREE napi kvótához, a
-- küldetésekhez és a Stripe-hoz. A `shop_items` kategóriái mind megjelenésiek.
--
-- MIT NEM TESZ:
--   * egyetlen meglévő táblát, oszlopot, constraintet, indexet vagy policy-t
--     sem módosít és nem töröl,
--   * egyetlen meglévő adatsort sem ír,
--   * nem nyúl a 0001–0010 migrációk semmijéhez,
--   * nem módosítja a user_profile_settings-et (az equip-slotok bővítése az
--     5e szakasz feladata lesz, külön migrációban).
--
-- Újrafuttatható: `if not exists` / `or replace`, és a katalógus-vetőmag
-- `on conflict (item_key) do nothing` – tehát egy ismételt futtatás NEM írja
-- felül az admin által módosított árat vagy állapotot.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) user_coins – egyenleg
--    Egy sor felhasználónként. A `balance >= 0` CHECK az utolsó védőháló:
--    negatív egyenleg adatbázis-szinten sem jöhet létre.
-- ---------------------------------------------------------------------------
create table if not exists public.user_coins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  balance    bigint not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_coins is 'Coin-egyenleg felhasználónként. A coin KIZÁRÓLAG kozmetikumra váltható; sem XP-t, sem Tippverseny-pontot, sem PRO hozzáférést nem ad. Írni csak a szerver tud (service_role).';
comment on column public.user_coins.balance is 'Aktuális egyenleg. A CHECK (balance >= 0) adatbázis-szinten zárja ki a negatív egyenleget.';

-- ---------------------------------------------------------------------------
-- 2) coin_transactions – auditálható napló
--
--    IDEMPOTENCIA: a `(user_id, source_key)` páros EGYEDI. Ugyanaz a tipp,
--    meccs vagy verseny sosem fizethet kétszer, akárhányszor fut újra a
--    kiértékelés, a szinkron vagy egy API-újrapróbálkozás. Ez a
--    `progression_events_unique_source` bevált mintája.
-- ---------------------------------------------------------------------------
create table if not exists public.coin_transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- pozitív = jóváírás, negatív = terhelés. A 0 értelmetlen, ezért tiltott.
  amount        bigint not null check (amount <> 0 and abs(amount) <= 1000000),
  -- A típusok katalógusa a kódban van (src/shared/shop.ts), ezért új
  -- jutalomtípus nem igényel migrációt; itt csak a hossz ellenőrzött.
  type          text not null check (char_length(type) between 3 and 48),
  -- Emberi olvasatú megnevezés a naplóhoz (pl. „Pontos eredmény”)
  label         text not null check (char_length(label) between 1 and 120),
  -- IDEMPOTENCIA-KULCS, pl. 'prediction:<id>:exact_score'
  source_key    text not null check (char_length(source_key) between 3 and 200),
  -- Az egyenleg a tranzakció UTÁN – így a napló önmagában is auditálható
  balance_after bigint not null check (balance_after >= 0),
  created_at    timestamptz not null default now(),
  constraint coin_transactions_unique_source unique (user_id, source_key)
);

comment on table public.coin_transactions is 'Coin-tranzakciók auditálható naplója. A (user_id, source_key) egyediség zárja ki a duplikált jutalmazást (tipp-módosítás, újraszinkron, ismételt verseny-lezárás, API-retry esetén is).';
comment on column public.coin_transactions.source_key is 'Idempotencia-kulcs, pl. "prediction:<id>:exact_score", "streak:3", "daily:2026-10-07", "competition:<id>:competition_first".';
comment on column public.coin_transactions.balance_after is 'Az egyenleg a tranzakció után – a napló önmagában levezethetővé teszi az egyenleget.';

create index if not exists idx_coin_tx_user on public.coin_transactions (user_id, created_at desc);
create index if not exists idx_coin_tx_source on public.coin_transactions (user_id, source_key);

-- ---------------------------------------------------------------------------
-- 3) shop_items – a katalógus. Az ADMIN ezt szerkeszti; a szerver futásidőben
--    innen olvas, nem a kód vetőmagjából.
-- ---------------------------------------------------------------------------
create table if not exists public.shop_items (
  id              uuid primary key default gen_random_uuid(),
  -- Stabil, egyedi azonosító, pl. 'frame_fire'. A kliens KIZÁRÓLAG ezt küldi.
  item_key        text not null unique check (item_key ~ '^[a-z0-9_]{3,64}$'),
  category        text not null
                  check (category in ('frame', 'name_color', 'name_effect', 'title', 'avatar', 'profile_background')),
  name            text not null check (char_length(name) between 1 and 80),
  description     text check (description is null or char_length(description) <= 300),
  rarity          text not null
                  check (rarity in ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  -- Az ár SOHA nem a kliensből jön: a szerver mindig ebből a sorból olvassa.
  price_coins     bigint not null check (price_coins >= 0 and price_coins <= 1000000),
  metadata        jsonb not null default '{}'::jsonb,
  is_active       boolean not null default true,
  is_limited      boolean not null default false,
  available_until timestamptz,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Időszakos itemnek kell lejárat, nem időszakosnak nem lehet
  constraint shop_items_limited_shape check (
    (is_limited and available_until is not null) or (not is_limited and available_until is null)
  )
);

comment on table public.shop_items is 'Shop item-katalógus. Az ár, a ritkaság és az aktivitás KIZÁRÓLAG itt él – a kliens sosem küld árat vagy ritkaságot. Írni csak a szerver tud (service_role), az admin a saját API-ján keresztül.';
comment on column public.shop_items.item_key is 'Stabil, egyedi kulcs (pl. frame_fire). A kliens kizárólag ezt küldheti; arbitrary CSS vagy színkód nem fogadható el.';
comment on column public.shop_items.available_until is 'Időszakos item lejárata. Lejárat után nem vásárolható, de a MÁR MEGVETT item a készletben marad.';

create index if not exists idx_shop_items_category on public.shop_items (category, sort_order, price_coins);
create index if not exists idx_shop_items_active on public.shop_items (is_active, category) where is_active;

-- ---------------------------------------------------------------------------
-- 4) user_shop_items – készlet
--    A (user_id, item_id) egyediség zárja ki, hogy ugyanazt az itemet kétszer
--    meg lehessen venni – ez a dupla vásárlás elleni ADATBÁZIS-szintű védelem.
-- ---------------------------------------------------------------------------
create table if not exists public.user_shop_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  item_id      uuid not null references public.shop_items (id) on delete cascade,
  -- Mennyit fizetett érte – az ár később változhat, a napló maradjon hű
  paid_coins   bigint not null check (paid_coins >= 0),
  purchased_at timestamptz not null default now(),
  constraint user_shop_items_unique unique (user_id, item_id)
);

comment on table public.user_shop_items is 'Felhasználói készlet. A (user_id, item_id) egyediség zárja ki a dupla vásárlást, párhuzamos kérés esetén is. A lejárt időszakos item is a készletben marad.';

create index if not exists idx_user_shop_items_user on public.user_shop_items (user_id, purchased_at desc);
create index if not exists idx_user_shop_items_item on public.user_shop_items (item_id);

-- ---------------------------------------------------------------------------
-- 5) updated_at karbantartás (a 0004-ben létrehozott függvénnyel; a törzs
--    bitre ugyanaz, hogy ez a migráció önmagában is futtatható legyen)
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_user_coins on public.user_coins;
create trigger touch_user_coins before update on public.user_coins
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_shop_items on public.shop_items;
create trigger touch_shop_items before update on public.shop_items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6) Tulajdonos-védelem: a user_id utólag nem írható át
-- ---------------------------------------------------------------------------
create or replace function public.protect_owner_column()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'A user_id nem módosítható';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_user_coins_owner on public.user_coins;
create trigger protect_user_coins_owner before update on public.user_coins
  for each row execute function public.protect_owner_column();

drop trigger if exists protect_user_shop_items_owner on public.user_shop_items;
create trigger protect_user_shop_items_owner before update on public.user_shop_items
  for each row execute function public.protect_owner_column();

-- ---------------------------------------------------------------------------
-- 7) ATOMIKUS VÁSÁRLÁS
--
--    MIÉRT FÜGGVÉNY? A vásárlás négy, egymástól elválaszthatatlan lépés:
--      a) egyenleg-ellenőrzés,
--      b) coin levonása,
--      c) készlet-rekord létrehozása,
--      d) tranzakció naplózása.
--    A szerver PostgREST-en ír, ahol nincs tranzakció – négy külön kérésből
--    bármelyik meghiúsulhatna a többi után, és két párhuzamos vásárlás
--    kétszer vonhatná le ugyanazt az egyenleget. A plpgsql törzs EGY implicit
--    tranzakcióban fut, és a VÁSÁRLÓRA vett advisory lock sorba állítja
--    ugyanazon felhasználó párhuzamos kéréseit. (A 0008/0009 bevált mintája.)
--
--    AZ ÁR A TÁBLÁBÓL JÖN, nem a hívótól: a kliens kizárólag az item_key-t
--    küldheti, árat, ritkaságot vagy összeget soha.
-- ---------------------------------------------------------------------------
create or replace function public.purchase_shop_item(
  p_user_id  uuid,
  p_item_key text,
  p_now      timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item    public.shop_items;
  v_balance bigint;
  v_new     bigint;
  v_owned   boolean;
begin
  if p_user_id is null or p_item_key is null then
    raise exception 'A felhasználó és az item azonosítója kötelező.' using errcode = '22023';
  end if;

  -- Az item a KATALÓGUSBÓL; az árat sosem a hívó adja meg
  select * into v_item from public.shop_items where item_key = p_item_key;
  if v_item.id is null then
    return jsonb_build_object('outcome', 'not_found', 'balance', null, 'item', null);
  end if;
  if not v_item.is_active then
    return jsonb_build_object('outcome', 'inactive', 'balance', null, 'item', null);
  end if;
  if v_item.is_limited and v_item.available_until is not null and v_item.available_until <= p_now then
    return jsonb_build_object('outcome', 'expired', 'balance', null, 'item', null);
  end if;

  -- ---------------------------------------------------------------------
  -- A VERSENYHELYZET KIZÁRÁSA
  -- Tranzakciós advisory lock a VÁSÁRLÓRA: ugyanazon felhasználó párhuzamos
  -- kérései sorba állnak (a második már látja az első commitolt levonását),
  -- különböző felhasználók viszont nem blokkolják egymást. A lock a
  -- tranzakció végén automatikusan felszabadul, hiba esetén is.
  -- ---------------------------------------------------------------------
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- Már megvan? (a unique index is védi, de így tiszta kimenetet adunk)
  select exists (
    select 1 from public.user_shop_items u
     where u.user_id = p_user_id and u.item_id = v_item.id
  ) into v_owned;
  if v_owned then
    select c.balance into v_balance from public.user_coins c where c.user_id = p_user_id;
    return jsonb_build_object('outcome', 'already_owned', 'balance', coalesce(v_balance, 0), 'item', to_jsonb(v_item));
  end if;

  -- Egyenleg-sor létrehozása, ha még nincs (0-val)
  insert into public.user_coins (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select c.balance into v_balance from public.user_coins c where c.user_id = p_user_id for update;

  if v_balance < v_item.price_coins then
    return jsonb_build_object('outcome', 'insufficient_coins', 'balance', v_balance, 'item', to_jsonb(v_item));
  end if;

  v_new := v_balance - v_item.price_coins;

  update public.user_coins set balance = v_new where user_id = p_user_id;

  insert into public.user_shop_items (user_id, item_id, paid_coins)
  values (p_user_id, v_item.id, v_item.price_coins);

  -- A terhelés NEGATÍV összeg. A source_key tartalmazza az időbélyeget, mert
  -- egy item életében csak egyszer vásárolható (ezt a készlet-unique védi),
  -- így a kulcs egyedisége itt nem korlát, hanem nyomonkövethetőség.
  insert into public.coin_transactions (user_id, amount, type, label, source_key, balance_after)
  values (p_user_id, -v_item.price_coins, 'SHOP_PURCHASE', v_item.name,
          'purchase:' || v_item.item_key, v_new);

  return jsonb_build_object('outcome', 'purchased', 'balance', v_new, 'item', to_jsonb(v_item));
end;
$$;

comment on function public.purchase_shop_item(uuid, text, timestamptz) is
  'Shop item atomikus megvásárlása: egyenleg-ellenőrzés, levonás, készlet-rekord és tranzakció EGY tranzakcióban, a vásárlóra vett advisory lockkal. Az ár a shop_items táblából jön, sosem a hívótól. Csak a service_role hívhatja.';

revoke all on function public.purchase_shop_item(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.purchase_shop_item(uuid, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 8) ATOMIKUS JUTALMAZÁS
--
--    A jutalmazás ugyanazt a problémát hordozza: „ha még nem kapta meg ezt a
--    forráskulcsot, írd jóvá és növeld az egyenleget”. A `(user_id, source_key)`
--    egyedi index a duplikáció ellen véd, az advisory lock pedig azt
--    garantálja, hogy a `balance_after` érték konzisztens legyen párhuzamos
--    jóváírásoknál is. `false` = ezt a forráskulcsot már kifizettük.
--
--    AZ ÖSSZEG a hívó szerverből jön (a COIN_REWARDS kód-konfigurációból),
--    SOHA nem a kliensből. Ezért itt csak a határt ellenőrizzük.
-- ---------------------------------------------------------------------------
create or replace function public.award_coins(
  p_user_id    uuid,
  p_amount     bigint,
  p_type       text,
  p_label      text,
  p_source_key text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance bigint;
  v_new     bigint;
begin
  if p_user_id is null or p_source_key is null then
    raise exception 'A felhasználó és a forráskulcs kötelező.' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    raise exception 'A jutalom összege 1 és 1000000 közötti egész szám lehet.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- Már kifizettük ezt a forrást?
  if exists (
    select 1 from public.coin_transactions t
     where t.user_id = p_user_id and t.source_key = p_source_key
  ) then
    select c.balance into v_balance from public.user_coins c where c.user_id = p_user_id;
    return jsonb_build_object('outcome', 'already_awarded', 'balance', coalesce(v_balance, 0), 'amount', 0);
  end if;

  insert into public.user_coins (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select c.balance into v_balance from public.user_coins c where c.user_id = p_user_id for update;
  v_new := v_balance + p_amount;

  update public.user_coins set balance = v_new where user_id = p_user_id;

  insert into public.coin_transactions (user_id, amount, type, label, source_key, balance_after)
  values (p_user_id, p_amount, p_type, p_label, p_source_key, v_new);

  return jsonb_build_object('outcome', 'awarded', 'balance', v_new, 'amount', p_amount);
end;
$$;

comment on function public.award_coins(uuid, bigint, text, text, text) is
  'Coin jóváírása idempotensen: ha a forráskulcsot már kifizettük, nem ír újra. Az összeg a hívó szerver kód-konfigurációjából jön (src/shared/shop.ts), sosem a kliensből. Csak a service_role hívhatja.';

revoke all on function public.award_coins(uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.award_coins(uuid, bigint, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9) Row Level Security
--    SELECT: a felhasználó a saját egyenlegét, tranzakcióit és készletét látja;
--            a KATALÓGUS (shop_items) mindenki számára olvasható, de csak az
--            aktív itemek – a piszkozatokat az admin a szerver API-n látja.
--    INSERT/UPDATE/DELETE: nincs policy az authenticated szerepkörnek – írni
--            kizárólag a szerver tud (service_role). A kliens tehát nem tud
--            magának coint, itemet vagy ritkaságot adni.
-- ---------------------------------------------------------------------------
alter table public.user_coins        enable row level security;
alter table public.coin_transactions enable row level security;
alter table public.shop_items        enable row level security;
alter table public.user_shop_items   enable row level security;

drop policy if exists "user_coins: saját egyenleg olvasása" on public.user_coins;
create policy "user_coins: saját egyenleg olvasása"
  on public.user_coins for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "coin_transactions: saját tranzakciók olvasása" on public.coin_transactions;
create policy "coin_transactions: saját tranzakciók olvasása"
  on public.coin_transactions for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_shop_items: saját készlet olvasása" on public.user_shop_items;
create policy "user_shop_items: saját készlet olvasása"
  on public.user_shop_items for select to authenticated
  using ((select auth.uid()) = user_id);

-- A katalógus aktív része nyilvánosan olvasható: a bolt tartalma nem titok.
-- A nem aktív (piszkozat / kivont) itemeket a policy elrejti.
drop policy if exists "shop_items: aktív katalógus olvasása" on public.shop_items;
create policy "shop_items: aktív katalógus olvasása"
  on public.shop_items for select to authenticated
  using (is_active);

revoke all on public.user_coins, public.coin_transactions, public.shop_items, public.user_shop_items
  from anon, authenticated;

grant select on public.user_coins, public.coin_transactions, public.shop_items, public.user_shop_items
  to authenticated;

-- ---------------------------------------------------------------------------
-- 10) Induló katalógus (VETŐMAG)
--
--     `on conflict (item_key) do nothing`: az ismételt futtatás NEM írja felül
--     az admin által módosított árat, ritkaságot vagy aktivitást.
--     Az árak a jóváhagyott listából származnak, változtatás nélkül.
-- ---------------------------------------------------------------------------
insert into public.shop_items (item_key, category, name, description, rarity, price_coins, metadata, sort_order) values
  -- KERETEK
  ('frame_green',            'frame', 'Zöld keret',          'Letisztult zöld profilkeret.',                 'common',     500, '{"color":"#17b877"}',                                                                      10),
  ('frame_blue',             'frame', 'Kék keret',           'Letisztult kék profilkeret.',                  'common',     500, '{"color":"#4f6ef7"}',                                                                      11),
  ('frame_purple',           'frame', 'Lila keret',          'Letisztult lila profilkeret.',                 'common',     500, '{"color":"#8b5cf6"}',                                                                      12),
  ('frame_fire',             'frame', 'Tűz keret',           'Lángoló szegély, meleg derengéssel.',          'rare',      2500, '{"color":"#f5533d","animation":"flame"}',                                                  20),
  ('frame_lightning',        'frame', 'Villám keret',        'Elektromos kék, lüktető fénnyel.',             'rare',      2500, '{"color":"#38bdf8","animation":"pulse"}',                                                  21),
  ('frame_aqua',             'frame', 'Aqua keret',          'Hűvös víz-tónus, lágy mozgással.',             'rare',      2500, '{"color":"#22d3ee","animation":"glow"}',                                                   22),
  ('frame_rainbow',          'frame', 'Szivárvány keret',    'Körbefutó színátmenet.',                       'rare',      3000, '{"gradient":["#f5533d","#f0b429","#17b877","#4f6ef7","#8b5cf6"],"animation":"sweep"}',      23),
  ('frame_ice',              'frame', 'Jég keret',           'Kristályos jégszegély, hideg csillogással.',   'epic',      5000, '{"gradient":["#e0f2fe","#7dd3fc"],"animation":"glow"}',                                    30),
  ('frame_diamond',          'frame', 'Gyémánt keret',       'Csiszolt gyémánt-fény.',                       'epic',      5000, '{"gradient":["#e8f4ff","#a5c9ff"],"animation":"sweep"}',                                   31),
  ('frame_galaxy',           'frame', 'Galaxis keret',       'Mély űrszínek, finom csillagporral.',          'epic',      6000, '{"gradient":["#1e1b4b","#4c1d95","#7c3aed"],"animation":"sweep"}',                         32),
  ('frame_cosmic',           'frame', 'Kozmikus keret',      'Nebula-színátmenet lassú mozgással.',          'epic',      6000, '{"gradient":["#312e81","#db2777","#f59e0b"],"animation":"sweep"}',                         33),
  ('frame_golden_crown',     'frame', 'Arany korona',        'Arany korona-motívum, visszafogott csillogással.', 'legendary', 12500, '{"color":"#f0b429","animation":"shimmer","crown":true}',                             40),
  ('frame_dragon',           'frame', 'Sárkány keret',       'Sárkánypikkely-textúra, izzó éllel.',          'legendary', 15000, '{"gradient":["#7f1d1d","#f5533d","#f0b429"],"animation":"shimmer"}',                       41),
  ('frame_legendary_aura',   'frame', 'Legendás aura',       'Lélegző aura a profil körül.',                 'legendary', 15000, '{"gradient":["#f0b429","#fde68a"],"animation":"shimmer"}',                                 42),
  ('frame_animated_diamond', 'frame', 'Animált gyémánt',     'A legritkább keret: futó fény a gyémánt élein.', 'legendary', 20000, '{"gradient":["#ffffff","#a5c9ff","#8b5cf6"],"animation":"shimmer"}',                     43),
  -- NÉVSZÍNEK
  ('name_green',   'name_color', 'Zöld név',       'Zöld névszín.',                   'common',  300, '{"color":"#17b877"}',                                                                            10),
  ('name_blue',    'name_color', 'Kék név',        'Kék névszín.',                    'common',  300, '{"color":"#4f6ef7"}',                                                                            11),
  ('name_purple',  'name_color', 'Lila név',       'Lila névszín.',                   'common',  300, '{"color":"#8b5cf6"}',                                                                            12),
  ('name_red',     'name_color', 'Vörös név',      'Vörös névszín.',                  'common',  300, '{"color":"#e23d4b"}',                                                                            13),
  ('name_gold',    'name_color', 'Arany név',      'Arany névszín.',                  'rare',   1500, '{"color":"#f0b429"}',                                                                            20),
  ('name_cyan',    'name_color', 'Cián név',       'Cián névszín.',                   'rare',   1500, '{"color":"#22d3ee"}',                                                                            21),
  ('name_pink',    'name_color', 'Rózsaszín név',  'Rózsaszín névszín.',              'rare',   1500, '{"color":"#ec4899"}',                                                                            22),
  ('name_diamond', 'name_color', 'Gyémánt név',    'Hideg gyémánt-színátmenet.',      'epic',   4000, '{"gradient":["#e8f4ff","#a5c9ff"]}',                                                             30),
  ('name_rainbow', 'name_color', 'Szivárvány név', 'Karakterenként változó színátmenet.', 'epic', 5000, '{"gradient":["#f5533d","#f0b429","#17b877","#4f6ef7","#8b5cf6"],"perCharacter":true}',        31),
  -- NÉV-EFFEKTEK
  ('effect_glow',     'name_effect', 'Derengés',            'Lágy fény a név körül.',                   'rare',      1500, '{"effect":"glow"}',     10),
  ('effect_shimmer',  'name_effect', 'Csillámlás',          'Végigfutó csillanás.',                     'rare',      2000, '{"effect":"shimmer"}',  11),
  ('effect_fire',     'name_effect', 'Tűz effekt',          'Meleg, pislákoló fény.',                   'epic',      4000, '{"effect":"fire"}',     20),
  ('effect_ice',      'name_effect', 'Jég effekt',          'Hideg, kristályos ragyogás.',              'epic',      4000, '{"effect":"ice"}',      21),
  ('effect_electric', 'name_effect', 'Elektromos effekt',   'Elektromos lüktetés.',                     'epic',      4500, '{"effect":"electric"}', 22),
  ('effect_rainbow',  'name_effect', 'Szivárvány effekt',   'A legritkább effekt: folyamatos színhullám.', 'legendary', 8000, '{"effect":"rainbow"}',  30),
  -- CÍMEK (a megszolgálható címekkel SZÁNDÉKOSAN nem ütköznek – D1 döntés)
  ('title_predictor',     'title', 'Predictor',      'Aki rendszeresen tippel.',        'common',      750, '{}', 10),
  ('title_rising_star',   'title', 'Rising Star',    'Felfelé tartó forma.',            'rare',       1500, '{}', 20),
  ('title_hot_hand',      'title', 'Hot Hand',       'Aki épp nem hibázik.',            'rare',       2500, '{}', 21),
  ('title_risk_taker',    'title', 'Risk Taker',     'Bátor tippek kedvelője.',         'rare',       3000, '{}', 22),
  ('title_clutch',        'title', 'Clutch',         'Amikor a legnagyobb a nyomás.',   'epic',       5000, '{}', 30),
  ('title_streak_hunter', 'title', 'Streak Hunter',  'Sorozatokra játszik.',            'epic',       5000, '{}', 31),
  ('title_mastermind',    'title', 'Mastermind',     'Aki előre látja a meccset.',      'epic',       7500, '{}', 32),
  ('title_goat',          'title', 'GOAT',           'A legdrágább cím a shopban.',     'legendary',  20000, '{}', 40),
  -- AVATAROK (a MEGLÉVŐ avatar-rendszer slotjába; nincs második rendszer)
  ('avatar_football',  'avatar', 'Futball embléma',    'Klasszikus futball-motívum.', 'common',      750, '{"avatarSlot":"accessory","emblem":"football"}',  10),
  ('avatar_tipster',   'avatar', 'Tippmester embléma', 'A tippelő jelvénye.',         'common',     1000, '{"avatarSlot":"accessory","emblem":"tipster"}',   11),
  ('avatar_brain',     'avatar', 'Agy embléma',        'Az elemző jelvénye.',         'rare',       1500, '{"avatarSlot":"accessory","emblem":"brain"}',     20),
  ('avatar_fire',      'avatar', 'Tűz embléma',        'Forró forma.',                'rare',       2500, '{"avatarSlot":"accessory","emblem":"fire"}',      21),
  ('avatar_ai',        'avatar', 'AI embléma',         'Az algoritmus jelvénye.',     'epic',       5000, '{"avatarSlot":"accessory","emblem":"ai"}',        30),
  ('avatar_diamond',   'avatar', 'Gyémánt embléma',    'Csiszolt gyémánt-jelvény.',   'epic',       5000, '{"avatarSlot":"accessory","emblem":"diamond"}',   31),
  ('avatar_champion',  'avatar', 'Bajnok embléma',     'A győztesek jelvénye.',       'epic',       7500, '{"avatarSlot":"accessory","emblem":"champion"}',  32),
  ('avatar_goat',      'avatar', 'GOAT embléma',       'A legritkább embléma.',       'legendary', 10000, '{"avatarSlot":"accessory","emblem":"goat"}',      40),
  -- PROFIL-HÁTTEREK (KÜLÖN az avatar.background slottól – D4 döntés)
  ('bg_stadium', 'profile_background', 'Stadion',      'Esti stadion-hangulat.',     'rare',       1500, '{"gradient":["#0f172a","#1e293b"]}',             10),
  ('bg_pitch',   'profile_background', 'Futballpálya', 'Friss pálya felülről.',      'rare',       1500, '{"gradient":["#064e3b","#17b877"]}',             11),
  ('bg_galaxy',  'profile_background', 'Galaxis',      'Csillagos mély ég.',         'epic',       4000, '{"gradient":["#1e1b4b","#4c1d95"]}',             20),
  ('bg_fire',    'profile_background', 'Tűz',          'Izzó háttér.',               'epic',       4000, '{"gradient":["#7f1d1d","#f5533d"]}',             21),
  ('bg_ice',     'profile_background', 'Jég',          'Jeges, hűvös háttér.',       'epic',       4000, '{"gradient":["#0c4a6e","#7dd3fc"]}',             22),
  ('bg_gold',    'profile_background', 'Arany',        'Meleg arany tónus.',         'epic',       7500, '{"gradient":["#78350f","#f0b429"]}',             23),
  ('bg_cosmic',  'profile_background', 'Kozmikus',     'A legritkább háttér: nebula-színek.', 'legendary', 10000, '{"gradient":["#312e81","#db2777","#f59e0b"]}', 30)
on conflict (item_key) do nothing;
