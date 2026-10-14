-- ===========================================================================
-- 0018 – Modell-tanulás: diagnosztikai futások időbélyegzett előzménye
--
-- MIÉRT KELL: az alap motor (xg-poisson-1) hibaelemzése (diagnostics-v1)
-- eddig csak kéréskor számolódott, nem maradt nyoma. Ez a tábla minden
-- SIKERES, adminisztrátor által KIFEJEZETTEN indított diagnosztikai futás
-- aggregált eredményét őrzi, hogy a teljesítmény időbeli változása
-- visszakereshető legyen.
--
-- MIT NEM TESZ:
--   * egyetlen meglévő táblát, oszlopot, megszorítást, indexet, policy-t,
--     triggert vagy függvényt sem módosít és nem töröl; a 0001–0017-hez nem nyúl,
--   * a `model_tip_archive` sorait nem olvassa és nem írja (csak az alkalmazás
--     számolja a riportot), tippet vagy felhasználói adatot nem másol,
--   * nem érinti az aktív modellt, a kalibrációt vagy az aktiválást.
--
-- APPEND-ONLY: a sorok nem módosíthatók, nem törölhetők, a tábla nem
-- csonkolható (trigger + visszavont jog). Egy futás egyszer rögzül; az
-- `idempotency_key` egyedi, így ugyanannak a kérésnek az újrapróbálása nem
-- hoz létre második sort.
--
-- MEGŐRZÉS: minden futás megmarad (kézi, ritka admin-művelet – várhatóan
-- legfeljebb néhány ezer sor/év, soronként ~1 kB). Automatikus törlés nincs.
-- Ha valaha ritkítani kell, az csak külön, jóváhagyott migrációval történhet
-- (pl. archív táblába másolás), az append-only őr tudatos feloldásával.
--
-- FÜGGŐSÉG: a 0015 `model_learning_block_removal()` függvénye.
--
-- VISSZAFORDÍTHATÓ (a tábla tulajdonosaként):
--   drop table if exists public.model_learning_diagnostic_runs;
--   drop function if exists public.model_learning_diagnostic_runs_guard();
--
-- Újrafuttatható: `create … if not exists`, `create or replace`, feltételes triggerek.
-- ALKALMAZÁS: kézzel, külön kiadási lépésben (`npm run migrate -- supabase/migrations/0018_model_learning_diagnostic_runs.sql`).
-- A 0018 nélkül az alkalmazás működik; csak a diagnosztika rögzítése és az
-- előzmények lekérése ad (jelzett) hibát.
-- ===========================================================================

create table if not exists public.model_learning_diagnostic_runs (
  id                          uuid        primary key default gen_random_uuid(),
  created_at                  timestamptz not null default now(),
  idempotency_key             text        not null,
  actor                       text,
  status                      text        not null default 'succeeded',
  base_engine_version         text        not null,
  method                      text        not null,
  data_fingerprint            text        not null,
  observations                integer     not null,
  matches                     integer     not null,
  first_kickoff               timestamptz,
  last_kickoff                timestamptz,
  distinct_kickoff_days       integer,
  log_loss                    double precision,
  brier                       double precision,
  ece                         double precision,
  naive_covered_matches       integer,
  naive_covered_observations  integer,
  naive_model_log_loss        double precision,
  naive_baseline_log_loss     double precision,
  naive_model_brier           double precision,
  naive_baseline_brier        double precision,
  naive_advantage             double precision,
  naive_advantage_ci_lo       double precision,
  naive_advantage_ci_hi       double precision,
  naive_brier_advantage       double precision,
  enough_for_conclusions      boolean     not null,
  notes                       jsonb       not null default '[]'::jsonb,
  excluded                    jsonb       not null default '{}'::jsonb,

  constraint model_learning_diagnostic_runs_key     unique (idempotency_key),
  constraint model_learning_diagnostic_runs_key_fmt check (idempotency_key ~ '^[A-Za-z0-9-]{8,100}$'),
  constraint model_learning_diagnostic_runs_status  check (status = 'succeeded'),
  constraint model_learning_diagnostic_runs_fp      check (char_length(data_fingerprint) = 64),
  constraint model_learning_diagnostic_runs_counts  check (observations >= 0 and matches >= 0 and matches <= observations),
  constraint model_learning_diagnostic_runs_period  check (
    (first_kickoff is null and last_kickoff is null and distinct_kickoff_days is null)
    or (first_kickoff is not null and last_kickoff is not null and first_kickoff <= last_kickoff and distinct_kickoff_days >= 1)),
  constraint model_learning_diagnostic_runs_ci      check (
    (naive_advantage_ci_lo is null) = (naive_advantage_ci_hi is null)
    and (naive_advantage_ci_lo is null or naive_advantage_ci_lo <= naive_advantage_ci_hi)),
  constraint model_learning_diagnostic_runs_notes   check (jsonb_typeof(notes) = 'array'),
  constraint model_learning_diagnostic_runs_excl    check (jsonb_typeof(excluded) = 'object')
);

-- a legújabb futások lekéréséhez
create index if not exists idx_model_learning_diagnostic_runs_created
  on public.model_learning_diagnostic_runs (created_at desc, id);

create or replace function public.model_learning_diagnostic_runs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'model_learning_diagnostic_runs: a rögzített diagnosztikai futás nem módosítható';
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'model_learning_diagnostic_runs_guard'
                 and tgrelid = 'public.model_learning_diagnostic_runs'::regclass) then
    create trigger model_learning_diagnostic_runs_guard
      before update on public.model_learning_diagnostic_runs
      for each row execute function public.model_learning_diagnostic_runs_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'model_learning_diagnostic_runs_no_delete'
                 and tgrelid = 'public.model_learning_diagnostic_runs'::regclass) then
    create trigger model_learning_diagnostic_runs_no_delete
      before delete on public.model_learning_diagnostic_runs
      for each row execute function public.model_learning_block_removal();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'model_learning_diagnostic_runs_no_truncate'
                 and tgrelid = 'public.model_learning_diagnostic_runs'::regclass) then
    create trigger model_learning_diagnostic_runs_no_truncate
      before truncate on public.model_learning_diagnostic_runs
      for each statement execute function public.model_learning_block_removal();
  end if;
end $$;

alter table public.model_learning_diagnostic_runs enable row level security;
revoke all on public.model_learning_diagnostic_runs from anon, authenticated;
revoke all on function public.model_learning_diagnostic_runs_guard() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update, delete, truncate, trigger, references on public.model_learning_diagnostic_runs from service_role;
    grant select, insert on public.model_learning_diagnostic_runs to service_role;
  end if;
end $$;
