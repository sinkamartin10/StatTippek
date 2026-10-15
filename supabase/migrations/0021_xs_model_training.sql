-- ===========================================================================
-- 0021 – Több ligás erősségmodell (xs-strength-1): tartós tanítóadat és becslésnapló
--
-- MIÉRT: a PRO-tippeket kiszolgáló `xs-strength-1` modell minden ESPN-sorozat
-- (bajnokságok, nemzetközi kupák, válogatott sorozatok, csak-előzmény hazai bajnokságok)
-- elmúlt ~3 évének lezárt meccseiből tanul. A Render fájlrendszere nem tartós, ezért
-- tábla nélkül minden újraindulás után újra le kellene tölteni (~1250 ESPN-kérés).
--
--   xs_training_matches : a lezárt meccsek végeredménye (ESPN eseményazonosítóval; egy meccs egyszer)
--   xs_training_months  : mely (sorozat, hónap) van már teljesen eltárolva (a lezárt hónap nem változik)
--   xs_model_fits       : minden modellbecslés naplója (APPEND-ONLY) – a kiszolgált elemzés `fitId`-ja
--                         ide mutat: tanítóadat-ujjlenyomat + paraméterek + időhatár → reprodukálható
--
-- MIT NEM TESZ: meglévő táblához, megszorításhoz, policy-hoz nem nyúl; a model_tip_archive
-- (az xs-tippek ott engine_version = 'xs-strength-1' sorokként rögzülnek, a 0016 szabályai szerint)
-- és a 0001–0020 migrációk változatlanok. Felhasználói adatot nem tárol.
-- FÜGGŐSÉG: a 0015 `model_learning_block_removal()` függvénye (törlés/csonkolás tiltása).
--
-- Újrafuttatható. Visszafordítás (tulajdonosként):
--   drop table if exists public.xs_model_fits, public.xs_training_months, public.xs_training_matches;
--   drop function if exists public.xs_model_fits_guard();
-- ALKALMAZÁS: kézzel. A tábla nélkül a szerver működik (memóriából + ESPN-ből), csak nem tartós.
-- ===========================================================================

create table if not exists public.xs_training_matches (
  id             text        primary key check (id ~ '^espn-[a-z0-9._]+-[0-9]+$'),
  competition_id text        not null,
  match_date     timestamptz not null,
  home_team_id   text        not null check (home_team_id ~ '^espn-[0-9]+$'),
  away_team_id   text        not null check (away_team_id ~ '^espn-[0-9]+$'),
  home_goals     integer     not null check (home_goals >= 0),
  away_goals     integer     not null check (away_goals >= 0),
  -- false: hosszabbítás/tizenegyesek – a forrás eredménye nem a 90 perces, a modell nem tanul belőle
  regulation     boolean     not null,
  source_month   text        not null check (source_month ~ '^[0-9]{6}$'),
  fetched_at     timestamptz not null default now(),
  constraint xs_training_matches_teams check (home_team_id <> away_team_id)
);
create index if not exists idx_xs_training_matches_date on public.xs_training_matches (match_date);

create table if not exists public.xs_training_months (
  competition_id text        not null,
  month          text        not null check (month ~ '^[0-9]{6}$'),
  -- true: a hónap vége óta legalább 3 nap telt el – az adat már nem változik, nem kérjük le újra
  closed         boolean     not null,
  match_count    integer     not null check (match_count >= 0),
  fetched_at     timestamptz not null default now(),
  primary key (competition_id, month)
);

create table if not exists public.xs_model_fits (
  fit_id          text        primary key check (fit_id ~ '^[0-9a-f]{64}$'),
  model_id        text        not null check (model_id = 'xs-strength-1'),
  created_at      timestamptz not null default now(),
  -- a tanítóadat időhatára: csak az ennél legalább `closed_hours` órával korábban kezdődött meccsek
  cutoff          timestamptz not null,
  closed_hours    integer     not null check (closed_hours >= 0),
  params          jsonb       not null check (jsonb_typeof(params) = 'object'),
  dataset_sha256  text        not null check (dataset_sha256 ~ '^[0-9a-f]{64}$'),
  trained_matches integer     not null check (trained_matches >= 0),
  sweeps          integer     not null check (sweeps >= 0)
);

-- becslésnapló: append-only
create or replace function public.xs_model_fits_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'xs_model_fits: a becslésnapló sorai nem módosíthatók';
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'xs_model_fits_guard' and tgrelid = 'public.xs_model_fits'::regclass) then
    create trigger xs_model_fits_guard before update on public.xs_model_fits for each row execute function public.xs_model_fits_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'xs_model_fits_no_delete' and tgrelid = 'public.xs_model_fits'::regclass) then
    create trigger xs_model_fits_no_delete before delete on public.xs_model_fits for each row execute function public.model_learning_block_removal();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'xs_model_fits_no_truncate' and tgrelid = 'public.xs_model_fits'::regclass) then
    create trigger xs_model_fits_no_truncate before truncate on public.xs_model_fits for each statement execute function public.model_learning_block_removal();
  end if;
end $$;

alter table public.xs_training_matches enable row level security;
alter table public.xs_training_months  enable row level security;
alter table public.xs_model_fits       enable row level security;
revoke all on public.xs_training_matches, public.xs_training_months, public.xs_model_fits from anon, authenticated;
revoke all on function public.xs_model_fits_guard() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke delete, truncate, references, trigger on public.xs_training_matches, public.xs_training_months, public.xs_model_fits from service_role;
    grant select, insert, update on public.xs_training_matches, public.xs_training_months to service_role;
    revoke update on public.xs_model_fits from service_role;
    grant select, insert on public.xs_model_fits to service_role;
  end if;
end $$;
