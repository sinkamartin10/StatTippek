-- ============================================================================
-- TippStats – Tippverseny (Prediction League) modul
--
-- NON-DESTRUCTIVE: kizárólag ÚJ táblákat hoz létre. A meglévő profiles,
-- predictions, slips, app_settings, manual_odds és stripe_events táblákhoz
-- NEM nyúl, adatot nem töröl és nem módosít.
--
-- Táblák:
--   competition_rounds   – maga a tippverseny (több verseny futhat egyszerre)
--   competition_matches  – a versenyhez tartozó mérkőzések (provider id szerint egyedi)
--   user_predictions     – felhasználói tippek (meccsenként egy, felhasználónként)
--   competition_rewards  – jutalom-nyilvántartás (CSAK nyilvántartás, Stripe-ot nem érint)
--
-- Jogosultsági elv (azonos a 0003-mal):
--   A szerver service_role kulccsal ír, és minden lekérdezésbe beteszi a hitelesített
--   user_id-t. Az RLS a második védelmi réteg: a felhasználó csak OLVASHAT, és csak
--   a saját sorait. INSERT/UPDATE/DELETE policy SZÁNDÉKOSAN nincs az authenticated
--   szerepkörnek – így a pontszám, a helyezés és a verseny státusza a felületről
--   semmilyen módon nem írható át.
--
-- Futtatás: Supabase Dashboard → SQL Editor → New query → beillesztés → Run
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) competition_rounds – egy-egy tippverseny
-- ---------------------------------------------------------------------------
create table if not exists public.competition_rounds (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 120),
  -- Strukturált liga-azonosító: a meccsadat-szolgáltató liga kulcsa (pl. 'eng-pl'),
  -- a megjelenítendő név és a szolgáltató neve. Így új liga felvétele csak adat kérdése.
  league_key  text not null,
  league_name text not null,
  provider    text not null default 'espn',
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  status      text not null default 'draft'
              check (status in ('draft', 'scheduled', 'active', 'finished', 'cancelled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint competition_rounds_period_valid check (ends_at > starts_at)
);

comment on table public.competition_rounds is 'Tippversenyek. Egyszerre több, egymástól független verseny futhat. Írni csak a szerver tud (service_role).';

create index if not exists idx_competition_rounds_status on public.competition_rounds (status, starts_at desc);
create index if not exists idx_competition_rounds_league on public.competition_rounds (league_key);

-- ---------------------------------------------------------------------------
-- 2) competition_matches – a versenyhez tartozó mérkőzések
--    Az egyediséget a (competition_id, external_match_id) pár adja: a „Meccsek
--    szinkronizálása” így tetszőleges sokszor futtatható duplikáció nélkül.
-- ---------------------------------------------------------------------------
create table if not exists public.competition_matches (
  id                uuid primary key default gen_random_uuid(),
  competition_id    uuid not null references public.competition_rounds (id) on delete cascade,
  external_match_id text not null,
  home_team         text not null,
  away_team         text not null,
  kickoff           timestamptz not null,
  home_score        integer check (home_score is null or home_score >= 0),
  away_score        integer check (away_score is null or away_score >= 0),
  status            text not null default 'scheduled'
                    check (status in ('scheduled', 'live', 'finished', 'postponed', 'cancelled')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint competition_matches_unique_external unique (competition_id, external_match_id)
);

comment on table public.competition_matches is 'Tippversenyhez rendelt mérkőzések. A (competition_id, external_match_id) egyediség teszi idempotenssé a szinkronizálást.';

create index if not exists idx_competition_matches_comp on public.competition_matches (competition_id, kickoff);
create index if not exists idx_competition_matches_status on public.competition_matches (competition_id, status);

-- ---------------------------------------------------------------------------
-- 3) user_predictions – felhasználói tippek
--    Meccsenként és felhasználónként pontosan egy tipp (kickoff előtt módosítható).
--    A points mezőt KIZÁRÓLAG a szerver írja az eredmény ismeretében.
-- ---------------------------------------------------------------------------
create table if not exists public.user_predictions (
  id                    uuid primary key default gen_random_uuid(),
  competition_match_id  uuid not null references public.competition_matches (id) on delete cascade,
  user_id               uuid not null references auth.users (id) on delete cascade,
  predicted_home_score  integer not null check (predicted_home_score between 0 and 99),
  predicted_away_score  integer not null check (predicted_away_score between 0 and 99),
  -- null = még nincs kiértékelve; a szerver számolja (5 / 3 / 0)
  points                integer check (points is null or points >= 0),
  submitted_at          timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint user_predictions_unique_per_match unique (user_id, competition_match_id)
);

comment on table public.user_predictions is 'Tippversenyes tippek. Egy felhasználó egy mérkőzésre egy tippet adhat; a pontot a szerver számolja.';
comment on column public.user_predictions.points is 'Szerveroldalon számolt pont (5 = pontos eredmény, 3 = helyes 1X2, 0 = nem talált). A kliens sosem írhatja.';

create index if not exists idx_user_predictions_match on public.user_predictions (competition_match_id);
create index if not exists idx_user_predictions_user on public.user_predictions (user_id);

-- ---------------------------------------------------------------------------
-- 4) competition_rewards – jutalom-nyilvántartás
--    FONTOS: ez CSAK nyilvántartás. A rendszer NEM módosít Stripe előfizetést,
--    és nem ad automatikusan PRO-t – az admin manuálisan osztja ki.
--    A (competition_id, placement) egyediség teszi idempotenssé a verseny lezárását.
-- ---------------------------------------------------------------------------
create table if not exists public.competition_rewards (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competition_rounds (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  placement      integer not null check (placement between 1 and 3),
  reward_type    text not null check (reward_type in ('free_pro_1_month', 'free_pro_2_weeks', 'free_pro_1_week')),
  reward_label   text not null,
  status         text not null default 'pending'
                 check (status in ('pending', 'granted', 'used', 'cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint competition_rewards_unique_placement unique (competition_id, placement),
  constraint competition_rewards_unique_user unique (competition_id, user_id)
);

comment on table public.competition_rewards is 'Tippverseny jutalmak nyilvántartása. Kizárólag adminisztratív nyilvántartás – NEM módosít Stripe előfizetést és nem ad automatikusan PRO hozzáférést.';

create index if not exists idx_competition_rewards_comp on public.competition_rewards (competition_id, placement);
create index if not exists idx_competition_rewards_user on public.competition_rewards (user_id, status);

-- ---------------------------------------------------------------------------
-- 5) updated_at karbantartás
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

drop trigger if exists touch_competition_rounds on public.competition_rounds;
create trigger touch_competition_rounds before update on public.competition_rounds
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_competition_matches on public.competition_matches;
create trigger touch_competition_matches before update on public.competition_matches
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_user_predictions on public.user_predictions;
create trigger touch_user_predictions before update on public.user_predictions
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_competition_rewards on public.competition_rewards;
create trigger touch_competition_rewards before update on public.competition_rewards
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6) Védőháló: a tipp és a jutalom tulajdonosa utólag nem írható át
--    (a 0003 migrációban létrehozott függvénnyel azonos – itt is definiáljuk,
--     hogy ez a migráció önmagában is futtatható legyen)
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

drop trigger if exists protect_user_predictions_owner on public.user_predictions;
create trigger protect_user_predictions_owner before update on public.user_predictions
  for each row execute function public.protect_owner_column();

drop trigger if exists protect_competition_rewards_owner on public.competition_rewards;
create trigger protect_competition_rewards_owner before update on public.competition_rewards
  for each row execute function public.protect_owner_column();

-- ---------------------------------------------------------------------------
-- 7) Row Level Security
--    SELECT: a meghirdetett versenyek (a piszkozat kivételével) és a meccsek olvashatók
--            a bejelentkezett felhasználóknak; a tippek és a jutalmak CSAK sajátok.
--    INSERT/UPDATE/DELETE: nincs policy az authenticated szerepkörnek – írni
--            kizárólag a hitelesített API-n keresztül, service_role-lal lehet.
-- ---------------------------------------------------------------------------
alter table public.competition_rounds  enable row level security;
alter table public.competition_matches enable row level security;
alter table public.user_predictions    enable row level security;
alter table public.competition_rewards enable row level security;

drop policy if exists "competition_rounds: olvasás" on public.competition_rounds;
create policy "competition_rounds: olvasás"
  on public.competition_rounds for select
  to authenticated
  -- A piszkozat (draft) csak az adminnak létezik: a szerver service_role-lal olvassa,
  -- közvetlen REST-hívással a felhasználó nem látja. A többi állapot olvasható.
  using (status <> 'draft');

drop policy if exists "competition_matches: olvasás" on public.competition_matches;
create policy "competition_matches: olvasás"
  on public.competition_matches for select
  to authenticated
  using (true);

drop policy if exists "user_predictions: saját sorok olvasása" on public.user_predictions;
create policy "user_predictions: saját sorok olvasása"
  on public.user_predictions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "competition_rewards: saját sorok olvasása" on public.competition_rewards;
create policy "competition_rewards: saját sorok olvasása"
  on public.competition_rewards for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Jogosultságok: az API szerepkörök csak olvasást kapnak (az RLS tovább szűr)
revoke all on public.competition_rounds, public.competition_matches,
              public.user_predictions, public.competition_rewards
  from anon, authenticated;

grant select on public.competition_rounds, public.competition_matches,
                public.user_predictions, public.competition_rewards
  to authenticated;
