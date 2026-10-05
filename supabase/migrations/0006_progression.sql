-- ============================================================================
-- TippStats – Tipster Progression (XP, achievementek, profil-kozmetikumok)
--
-- NON-DESTRUCTIVE: kizárólag ÚJ táblákat hoz létre. A meglévő profiles,
-- predictions, slips, app_settings, manual_odds, stripe_events, competition_rounds,
-- competition_matches, user_predictions és competition_rewards táblákhoz NEM nyúl,
-- adatot nem töröl és nem módosít.
--
-- Tervezési elv – NINCS adatduplikáció:
--   • Az XP forrása az esemény-napló (progression_events). A összes XP ennek az
--     összege, a SZINT pedig ebből SZÁMÍTOTT érték – nincs külön „xp/level” oszlop,
--     amely elromolhatna.
--   • A statisztikák (helyes tippek, pontos eredmények, sorozat, helyezések) a már
--     meglévő user_predictions és competition_rewards táblákból számolódnak.
--   • A kozmetikumok feloldása SZÁMÍTOTT (szint + achievement + statisztika), ezért
--     nincs „user_cosmetics” tábla – nem lehet kicsúszni a szinkronból.
--   • Tárolni csak azt kell, ami nem számítható: az achievement feloldás IDEJÉT és a
--     felhasználó saját VÁLASZTÁSÁT (avatar/keret/cím/kiemelt achievementek).
--
-- Jogosultsági elv (azonos a 0003/0004-gyel): a szerver service_role kulccsal ír,
-- a felhasználó csak a SAJÁT sorait olvashatja; INSERT/UPDATE/DELETE policy
-- SZÁNDÉKOSAN nincs az authenticated szerepkörnek, így XP-t, achievementet vagy
-- feloldást a felületről adni magának nem lehet.
--
-- Futtatás: Supabase Dashboard → SQL Editor → New query → beillesztés → Run
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) progression_events – az XP egyetlen forrása (napló)
--
--    Az idempotenciát az (user_id, type, source_key) egyediség adja:
--    ugyanaz a tipp, ugyanaz a sorozat-bónusz vagy ugyanaz a helyezés
--    SOHA nem adhat XP-t kétszer, akárhányszor fut újra a kiértékelés.
-- ---------------------------------------------------------------------------
create table if not exists public.progression_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  type       text not null
             check (type in ('prediction', 'streak_bonus', 'exact_milestone', 'placement')),
  -- amiből az esemény származik: tipp azonosító, verseny azonosító + helyezés, mérföldkő kulcs
  source_key text not null,
  xp         integer not null check (xp > 0),
  created_at timestamptz not null default now(),
  constraint progression_events_unique_source unique (user_id, type, source_key)
);

comment on table public.progression_events is 'XP-események naplója. Az összes XP ezek összege; a szint ebből számolódik. Írni csak a szerver tud (service_role).';
comment on column public.progression_events.source_key is 'Idempotencia-kulcs: tipp azonosító, "competitionId:placement" vagy mérföldkő kulcs. Ugyanaz a forrás csak egyszer adhat XP-t.';

create index if not exists idx_progression_events_user on public.progression_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2) user_achievements – feloldott achievementek (a feloldás IDEJÉVEL)
--    A feltételeket a szerver értékeli ki; ide csak a tény és az időbélyeg kerül.
-- ---------------------------------------------------------------------------
create table if not exists public.user_achievements (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  achievement_key text not null check (char_length(achievement_key) between 2 and 64),
  unlocked_at     timestamptz not null default now(),
  constraint user_achievements_unique unique (user_id, achievement_key)
);

comment on table public.user_achievements is 'Feloldott achievementek. Egy felhasználó egy achievementet csak egyszer oldhat fel (unique). A katalógus a kódban van: src/shared/progression.ts';

create index if not exists idx_user_achievements_user on public.user_achievements (user_id, unlocked_at desc);

-- ---------------------------------------------------------------------------
-- 3) user_profile_settings – a felhasználó VÁLASZTÁSA
--    Csak választás tárolódik; hogy az adott elem jár-e neki, azt a szerver
--    minden mentésnél és minden olvasásnál újraszámolja.
-- ---------------------------------------------------------------------------
create table if not exists public.user_profile_settings (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  -- avatar: {"skin":"light","hair":"short","hairColor":"black","shirt":"plain","shirtColor":"blue","accessory":"none","background":"solid"}
  avatar      jsonb not null default '{}'::jsonb,
  border_key  text not null default 'classic',
  title_key   text not null default 'none',
  -- legfeljebb 3 kiemelt achievement
  showcase    text[] not null default '{}'::text[]
              check (array_length(showcase, 1) is null or array_length(showcase, 1) <= 3),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.user_profile_settings is 'A profil testreszabása (avatar, keret, cím, kiemelt achievementek). A szerver minden választást ellenőriz a feloldott elemek ellen.';

-- ---------------------------------------------------------------------------
-- 4) updated_at karbantartás (a 0004-ben létrehozott függvénnyel – itt is
--    definiáljuk, hogy ez a migráció önmagában is futtatható legyen)
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

drop trigger if exists touch_user_profile_settings on public.user_profile_settings;
create trigger touch_user_profile_settings before update on public.user_profile_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5) Védőháló: a tulajdonos utólag nem írható át
--    (a 0003/0004 migrációban létrehozott függvénnyel azonos)
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

drop trigger if exists protect_progression_events_owner on public.progression_events;
create trigger protect_progression_events_owner before update on public.progression_events
  for each row execute function public.protect_owner_column();

drop trigger if exists protect_user_achievements_owner on public.user_achievements;
create trigger protect_user_achievements_owner before update on public.user_achievements
  for each row execute function public.protect_owner_column();

drop trigger if exists protect_user_profile_settings_owner on public.user_profile_settings;
create trigger protect_user_profile_settings_owner before update on public.user_profile_settings
  for each row execute function public.protect_owner_column();

-- ---------------------------------------------------------------------------
-- 6) Row Level Security
--    SELECT: kizárólag a saját sorok (a profil-testreszabás is privát; a ranglistán
--            megjelenő adatokat a szerver adja ki, nem a kliens olvassa közvetlenül).
--    INSERT/UPDATE/DELETE: nincs policy az authenticated szerepkörnek – XP-t,
--            achievementet és feloldást a felületről adni magának nem lehet.
-- ---------------------------------------------------------------------------
alter table public.progression_events    enable row level security;
alter table public.user_achievements     enable row level security;
alter table public.user_profile_settings enable row level security;

drop policy if exists "progression_events: saját sorok olvasása" on public.progression_events;
create policy "progression_events: saját sorok olvasása"
  on public.progression_events for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_achievements: saját sorok olvasása" on public.user_achievements;
create policy "user_achievements: saját sorok olvasása"
  on public.user_achievements for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "user_profile_settings: saját sorok olvasása" on public.user_profile_settings;
create policy "user_profile_settings: saját sorok olvasása"
  on public.user_profile_settings for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Jogosultságok: az API szerepkörök csak olvasást kapnak (az RLS tovább szűr)
revoke all on public.progression_events, public.user_achievements, public.user_profile_settings
  from anon, authenticated;

grant select on public.progression_events, public.user_achievements, public.user_profile_settings
  to authenticated;

-- Ellenőrzés (futtatás után):
--   select table_name from information_schema.tables
--   where table_schema = 'public'
--     and table_name in ('progression_events', 'user_achievements', 'user_profile_settings');
