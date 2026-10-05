-- ============================================================================
-- TippStats – megjelenítési név (Display Name) a MEGLÉVŐ profiles táblában
--
-- NON-DESTRUCTIVE: egyetlen új, NULL-t megengedő oszlop + ellenőrzések és egy
-- egyedi index. Meglévő sort nem módosít, adatot nem töröl, a meglévő oszlopokhoz
-- (email, subscription_*, stripe_*) nem nyúl.
--
-- Nem készül külön user/profil tábla: a Tippverseny is ezt a mezőt használja.
--
-- Futtatás: Supabase Dashboard → SQL Editor → New query → beillesztés → Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Az oszlop
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists display_name text;

comment on column public.profiles.display_name is
  'Nyilvános megjelenítési név (pl. a Tippverseny ranglistáján). Kizárólag a szerver írja (service_role), a kliensnek nincs UPDATE joga. Egyedi, kis- és nagybetűtől függetlenül.';

-- ---------------------------------------------------------------------------
-- 2) Hossz- és karakterkorlát adatbázis szinten is
--    (a részletes, megkerülés-ellenes szűrés a szerveren fut: src/shared/displayName.ts)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_length') then
    alter table public.profiles
      add constraint profiles_display_name_length
      check (display_name is null or char_length(display_name) between 3 and 20);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_shape') then
    -- Betűvel/számmal kezdődik és végződik, közte betű, szám, szóköz, pont, kötőjel, aláhúzás.
    -- A '-' az osztály VÉGÉN áll, ezért literál (nem tartományjel), és nincs benne backslash:
    -- POSIX karakterosztályban a visszaper nem escape-karakter, hanem önmagát jelentené,
    -- ezért szándékosan nincs benne – visszapert tartalmazó név így nem menthető.
    alter table public.profiles
      add constraint profiles_display_name_shape
      check (display_name is null or display_name ~ '^[[:alnum:]][[:alnum:] _.-]*[[:alnum:]]$');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Egyediség – KIS- ÉS NAGYBETŰTŐL FÜGGETLENÜL, adatbázis szinten.
--    Ez zárja ki a versenyhelyzetet is: két párhuzamos mentés közül a második
--    23505 (unique_violation) hibát kap, amit az API 409-re fordít.
--    A NULL értékek egyediek maradnak, így több profil is lehet név nélkül.
-- ---------------------------------------------------------------------------
create unique index if not exists profiles_display_name_unique_ci
  on public.profiles (lower(display_name));

-- ---------------------------------------------------------------------------
-- 4) Jogosultságok
--    A 0001 migráció már elvette az írási jogot az anon/authenticated szerepkörtől
--    (revoke all + grant select), és nincs UPDATE policy sem. A display_name így a
--    felületről NEM írható – kizárólag a hitelesített API-n keresztül, service_role-lal.
--    A felhasználó a SAJÁT sorát továbbra is olvashatja (0001 SELECT policy), ezért
--    a profil oldalon látja a saját nevét. Külön grant nem szükséges.
-- ---------------------------------------------------------------------------

-- Ellenőrzés (futtatás után):
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'profiles' and column_name = 'display_name';
