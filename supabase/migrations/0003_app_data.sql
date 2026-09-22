-- ============================================================================
-- TIPPMIX AI – alkalmazásadatok Supabase PostgreSQL-ben (hibrid architektúra)
--
--   Postgres  : predictions, slips, settings, manual_odds, stripe_events
--   SQLite     : http_cache, research_cache, sources  (eldobható cache – NEM migráljuk)
--
-- Futtatás: Supabase Dashboard → SQL Editor → New query → beillesztés → Run
-- Megjegyzés: a régi, helyi SQLite adatokat NEM migráljuk – éles induláskor tiszta lappal kezdünk.
-- ============================================================================

-- gen_random_uuid() a pgcrypto/pg_catalog része a Supabase-en (PG13+ beépített)
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) predictions – felhasználónkénti mentett tippek
--    Az azonosító surrogate uuid: a korábbi "matchId:market" kulcs több felhasználónál ütközne.
--    Az egyediséget a (user_id, match_id, market) hármas adja.
-- ---------------------------------------------------------------------------
create table if not exists public.predictions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  created_at       timestamptz not null default now(),
  match_id         text not null,
  match_label      text not null,
  kickoff          timestamptz not null,
  league_id        text not null,
  league_name      text not null,
  market           text not null,
  market_label     text not null,
  model_prob       double precision not null check (model_prob >= 0 and model_prob <= 1),
  odds             double precision check (odds is null or odds > 1),
  category         text not null,
  prediction_type  text not null check (prediction_type in ('modell', 'manuális')),
  outcome          text not null default 'függőben'
                   check (outcome in ('függőben', 'nyert', 'vesztett', 'érvénytelen')),
  home_goals       integer,
  away_goals       integer,
  settled_at       timestamptz,
  origin           text not null check (origin in ('demo', 'live')),
  constraint predictions_user_match_market_unique unique (user_id, match_id, market)
);

comment on table public.predictions is 'Felhasználónkénti mentett tippek. Írni csak a szerver tud (service_role); a felhasználó csak a saját sorait olvashatja.';

create index if not exists idx_predictions_user_kickoff on public.predictions (user_id, kickoff desc, created_at desc);
create index if not exists idx_predictions_user_outcome on public.predictions (user_id, outcome);
create index if not exists idx_predictions_user_league  on public.predictions (user_id, league_id);

-- ---------------------------------------------------------------------------
-- 2) slips – felhasználónkénti szelvények (lábak = predictions id-k)
-- ---------------------------------------------------------------------------
create table if not exists public.slips (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  created_at          timestamptz not null default now(),
  strategy            text not null check (strategy in ('legnagyobb esély', 'kiegyensúlyozott', 'modell-előny')),
  label               text not null,
  leg_prediction_ids  uuid[] not null check (array_length(leg_prediction_ids, 1) between 2 and 8),
  total_odds          double precision not null check (total_odds > 1),
  joint_prob          double precision not null check (joint_prob >= 0 and joint_prob <= 1),
  origin              text not null check (origin in ('demo', 'live'))
);

comment on table public.slips is 'Felhasználónkénti szelvények. A kimenet a lábakból (predictions) számolódik.';

create index if not exists idx_slips_user_created on public.slips (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) settings – globális alkalmazás-beállítások (pl. modell zsugorítási paraméter)
--    Csak admin írhatja az API-n keresztül; a DB-ben service_role.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4) manual_odds – kézzel megadott odds mérkőzésenként (globális, admin)
-- ---------------------------------------------------------------------------
create table if not exists public.manual_odds (
  match_id   text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5) stripe_events – webhook idempotencia (csak service_role)
-- ---------------------------------------------------------------------------
create table if not exists public.stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

create index if not exists idx_stripe_events_received on public.stripe_events (received_at desc);

-- ---------------------------------------------------------------------------
-- 6) Row Level Security
--
--    Elv: a szerver service_role kulccsal ír (az RLS-t megkerüli), és MINDEN lekérdezésbe
--    beteszi a hitelesített user_id-t. Az RLS a védelem második rétege arra az esetre,
--    ha valaha anon/authenticated kulccsal (pl. a frontendből) érkezne lekérdezés.
--
--    SELECT: csak a saját sorok.
--    INSERT/UPDATE/DELETE: NINCS policy az authenticated szerepkörnek – szándékosan.
--      Ha a felhasználó közvetlenül írhatna, átírhatná a saját 'outcome' mezőjét,
--      és hamis lenne az „őszinte előzmény” statisztika. Írni csak a hitelesített API-n át lehet.
-- ---------------------------------------------------------------------------
alter table public.predictions   enable row level security;
alter table public.slips         enable row level security;
alter table public.app_settings  enable row level security;
alter table public.manual_odds   enable row level security;
alter table public.stripe_events enable row level security;

drop policy if exists "predictions: saját sorok olvasása" on public.predictions;
create policy "predictions: saját sorok olvasása"
  on public.predictions for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "slips: saját sorok olvasása" on public.slips;
create policy "slips: saját sorok olvasása"
  on public.slips for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- app_settings / manual_odds / stripe_events: semmilyen policy → kizárólag service_role fér hozzá.

-- Jogosultságok: az API szerepkörök csak olvasást kapnak a saját táblákra (az RLS tovább szűr)
revoke all on public.predictions, public.slips, public.app_settings, public.manual_odds, public.stripe_events from anon, authenticated;
grant select on public.predictions, public.slips to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Védőháló: a user_id utólag nem írható át (sorok „átadása” más fióknak)
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

drop trigger if exists protect_predictions_owner on public.predictions;
create trigger protect_predictions_owner
  before update on public.predictions
  for each row execute function public.protect_owner_column();

drop trigger if exists protect_slips_owner on public.slips;
create trigger protect_slips_owner
  before update on public.slips
  for each row execute function public.protect_owner_column();
