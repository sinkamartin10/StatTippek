-- ============================================================================
-- TippStats – Napi és heti küldetések (Missions)
--
-- NON-DESTRUCTIVE: egyetlen ÚJ táblát hoz létre, és a progression_events tábla
-- type-ellenőrzését kibővíti a 'mission' értékkel (adatot NEM töröl és NEM módosít).
-- A többi meglévő táblához – profiles, predictions, slips, app_settings, manual_odds,
-- stripe_events, competition_*, user_predictions, user_achievements,
-- user_profile_settings – egyáltalán nem nyúl.
--
-- Tervezési elv – NINCS adatduplikáció:
--   • A küldetés HALADÁSA nem tárolt érték: a már meglévő user_predictions
--     adatokból számolódik minden lekérdezéskor (lásd src/shared/missions.ts).
--     Így nem lehet elavult vagy a valósággal ütköző állapot.
--   • Tárolni csak azt kell, ami nem számítható: a jutalom ÁTVÉTELÉNEK tényét.
--   • Az XP továbbra is a MEGLÉVŐ progression_events táblába kerül
--     (source_key = 'mission:<kulcs>:<periódus>'), nincs külön küldetés-XP rendszer.
--
-- Jogosultsági elv (azonos a 0003/0004/0006-tal): a szerver service_role kulccsal ír,
-- a felhasználó csak a SAJÁT sorait olvashatja; INSERT/UPDATE/DELETE policy
-- SZÁNDÉKOSAN nincs az authenticated szerepkörnek, így küldetést teljesítettnek
-- jelölni vagy jutalmat adni magának a felületről nem lehet.
--
-- Futtatás: Supabase Dashboard → SQL Editor → New query → beillesztés → Run
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- mission_claims – a jutalom átvételének nyilvántartása
--
--    Az idempotenciát az (user_id, mission_key, period_key) egyediség adja:
--    ugyanaz a küldetés ugyanabban a periódusban SOHA nem jutalmazható kétszer,
--    akárhányszor fut le az átvételi kérés.
-- ---------------------------------------------------------------------------
create table if not exists public.mission_claims (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  mission_key   text not null check (char_length(mission_key) between 2 and 64),
  -- napi: 'YYYY-MM-DD' · heti: 'YYYY-Www' – mindkettő Europe/Budapest szerint
  period_key    text not null check (char_length(period_key) between 7 and 10),
  period_type   text not null check (period_type in ('daily', 'weekly')),
  -- az állás az átvétel pillanatában (audit célra; a haladás egyébként számított)
  progress      integer not null check (progress >= 0),
  -- a ténylegesen jóváírt XP: PRO-nál a katalógus értéke, FREE-nél 0
  xp_awarded    integer not null default 0 check (xp_awarded >= 0),
  claimed_at    timestamptz not null default now(),
  constraint mission_claims_unique unique (user_id, mission_key, period_key)
);

comment on table public.mission_claims is
  'Küldetés-jutalmak átvételének naplója. A haladás NEM itt tárolódik – azt a szerver a user_predictions adatokból számolja. Az XP a progression_events táblába kerül.';
comment on column public.mission_claims.period_key is
  'Europe/Budapest szerinti periódus: napi YYYY-MM-DD, heti YYYY-Www (ISO hét).';
comment on column public.mission_claims.xp_awarded is
  'FREE felhasználónál mindig 0 – küldetésből competitive XP nem szerezhető.';

create index if not exists idx_mission_claims_user on public.mission_claims (user_id, claimed_at desc);
create index if not exists idx_mission_claims_period on public.mission_claims (user_id, period_key);

-- ---------------------------------------------------------------------------
-- A küldetés-XP a MEGLÉVŐ progression_events naplóba kerül, ezért az esemény-típus
-- ellenőrzését ki kell egészíteni a 'mission' értékkel.
--
-- FIGYELEM: ez az EGYETLEN pont, ahol ez a migráció meglévő táblához nyúl.
-- A művelet NEM destruktív: egyetlen sort sem töröl és nem módosít, csak a
-- megengedett értékek körét bővíti. A régi és az új ellenőrzés egyetlen atomi
-- ALTER TABLE utasításban cserélődik, így nincs olyan pillanat, amikor a tábla
-- ellenőrzés nélkül maradna. Újrafuttatás-biztos: ha már bővített, nem csinál semmit.
-- ---------------------------------------------------------------------------
do $$
declare
  current_def text;
begin
  select pg_get_constraintdef(oid) into current_def
    from pg_constraint
   where conrelid = 'public.progression_events'::regclass
     and conname = 'progression_events_type_check';

  if current_def is null then
    -- a megszorítás más néven jöhetett létre; ilyenkor nevesítve hozzuk létre
    alter table public.progression_events
      add constraint progression_events_type_check
      check (type in ('prediction', 'streak_bonus', 'exact_milestone', 'placement', 'mission'));
  elsif position('mission' in current_def) = 0 then
    alter table public.progression_events
      drop constraint progression_events_type_check,
      add  constraint progression_events_type_check
      check (type in ('prediction', 'streak_bonus', 'exact_milestone', 'placement', 'mission'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Védőháló: a tulajdonos utólag nem írható át
-- (a 0003/0004/0006 migrációban létrehozott függvénnyel azonos)
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

drop trigger if exists protect_mission_claims_owner on public.mission_claims;
create trigger protect_mission_claims_owner before update on public.mission_claims
  for each row execute function public.protect_owner_column();

-- ---------------------------------------------------------------------------
-- Row Level Security
--   SELECT: kizárólag a saját sorok.
--   INSERT/UPDATE/DELETE: nincs policy az authenticated szerepkörnek – küldetést
--   teljesítettnek jelölni vagy jutalmat írni a felületről nem lehet.
-- ---------------------------------------------------------------------------
alter table public.mission_claims enable row level security;

drop policy if exists "mission_claims: saját sorok olvasása" on public.mission_claims;
create policy "mission_claims: saját sorok olvasása"
  on public.mission_claims for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Jogosultságok: az API szerepkörök csak olvasást kapnak (az RLS tovább szűr)
revoke all on public.mission_claims from anon, authenticated;
grant select on public.mission_claims to authenticated;

-- Ellenőrzés (futtatás után):
--   select table_name from information_schema.tables
--   where table_schema = 'public' and table_name = 'mission_claims';
