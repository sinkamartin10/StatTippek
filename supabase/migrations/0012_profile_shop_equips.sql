-- ===========================================================================
-- 0012 – A megvásárolt shop kozmetikumok FELVÉTELE (equip)
--
-- MIÉRT KELL: a felvett shop item slotonkénti választás, amit tárolni kell.
-- A `user_profile_settings` meglévő oszlopai a MEGSZOLGÁLT kozmetikumokhoz
-- vannak kötve (`border_key` → BORDERS, `title_key` → TITLES, `avatar` →
-- AVATAR_PARTS), és a szerver ott a megszolgált katalógusokhoz méri a
-- választást (`sanitizeSettings()`). A shop kulcsainak odaírása vagy nem
-- működne, vagy a megszolgált kozmetikumok ellenőrzését gyengítené – ezért a
-- shop a SAJÁT hat oszlopát kapja.
--
-- A KÉT RENDSZER KÜLÖN MARAD:
--   border_key          (megszolgált keret)   ≠  shop_frame_key
--   title_key           (megszolgált cím)     ≠  shop_title_key
--   avatar->>'background' (avatar háttere)    ≠  shop_profile_background_key
--
-- MIT NEM TESZ:
--   * egyetlen meglévő oszlopot, megszorítást, indexet, policy-t vagy triggert
--     sem módosít és nem töröl,
--   * egyetlen meglévő adatsort sem ír át (minden új oszlop NULL-lal indul),
--   * nem nyúl a 0001–0011 migrációk semmijéhez,
--   * nem tesz idegen kulcsot a `shop_items`-re: a felvett item érvényessége a
--     KÉSZLETBŐL dől el futásidőben, és egy FK a katalógus szerkesztését is
--     megkötné (kivont item nem lenne törölhető/átnevezhető).
--
-- VISSZAFORDÍTHATÓ: a hat oszlop eldobásával az előző állapot pontosan
-- visszaáll, mert a megszolgált testreszabás egyetlen mezőjét sem érinti.
--   alter table public.user_profile_settings
--     drop column if exists shop_frame_key, …;
--
-- Újrafuttatható: `add column if not exists` + nevesített megszorítások
-- feltételes létrehozása.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Hat nullable oszlop – NULL = ebben a slotban nincs felvett shop item
-- ---------------------------------------------------------------------------
alter table public.user_profile_settings
  add column if not exists shop_frame_key              text,
  add column if not exists shop_name_color_key         text,
  add column if not exists shop_name_effect_key        text,
  add column if not exists shop_title_key              text,
  add column if not exists shop_avatar_key             text,
  add column if not exists shop_profile_background_key text;

comment on column public.user_profile_settings.shop_frame_key is
  'A felvett shop KERET item_key-e, vagy NULL. KÜLÖN a megszolgált border_key-től.';
comment on column public.user_profile_settings.shop_name_color_key is
  'A felvett shop NÉVSZÍN item_key-e, vagy NULL.';
comment on column public.user_profile_settings.shop_name_effect_key is
  'A felvett shop NÉV-EFFEKT item_key-e, vagy NULL.';
comment on column public.user_profile_settings.shop_title_key is
  'A felvett shop CÍM item_key-e, vagy NULL. KÜLÖN a megszolgált title_key-től; a shop-cím nem ad achievementet, XP-t, rangot vagy PRO státuszt.';
comment on column public.user_profile_settings.shop_avatar_key is
  'A felvett shop AVATAR-EMBLÉMA item_key-e, vagy NULL. Megjelenítésnél a meglévő avatar-kompozíció accessory rétegére kerül; az AVATAR_PARTS katalógust NEM módosítja.';
comment on column public.user_profile_settings.shop_profile_background_key is
  'A felvett shop PROFIL-HÁTTÉR item_key-e, vagy NULL. KÜLÖN az avatar background mezőjétől – egyik sem írja felül a másikat.';

-- ---------------------------------------------------------------------------
-- 2) Alaki megszorítás: ugyanaz a minta, mint a shop_items.item_key-nél.
--    Idegen kulcs SZÁNDÉKOSAN nincs (lásd a fejlécet); a birtoklást és a
--    kategória-egyezést a szerver ellenőrzi a készletből, minden írásnál és
--    minden olvasásnál.
-- ---------------------------------------------------------------------------
do $$
declare
  col text;
  cols text[] := array[
    'shop_frame_key', 'shop_name_color_key', 'shop_name_effect_key',
    'shop_title_key', 'shop_avatar_key', 'shop_profile_background_key'
  ];
begin
  foreach col in array cols loop
    if not exists (
      select 1 from pg_constraint
       where conname = 'ups_' || col || '_format'
         and conrelid = 'public.user_profile_settings'::regclass
    ) then
      execute format(
        'alter table public.user_profile_settings add constraint %I check (%I is null or %I ~ ''^[a-z0-9_]{3,64}$'')',
        'ups_' || col || '_format', col, col
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Jogosultságok: VÁLTOZATLANOK.
--    A `user_profile_settings` RLS-e, policy-ja és grantjei a 0006-ban élnek;
--    ez a migráció nem kapcsol ki RLS-t, nem hoz létre új policy-t, és nem ad
--    új jogot. Új oszlop az `authenticated` szerepkörnek automatikusan a tábla
--    meglévő SELECT jogával látszik – írni továbbra is kizárólag a
--    service_role tud. Védőhálóként itt is kimondjuk a szűkítést: a
--    kliens szerepkörök semmilyen írási jogot nem kapnak ezekre az oszlopokra.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.user_profile_settings from anon, authenticated;
