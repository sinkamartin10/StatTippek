-- ===========================================================================
-- 0015 – Modell-kalibráció (tanulási réteg) – verziók, állapot, audit
--
-- MIÉRT KELL: a 0014 Modell-tipp archívum lezárt, kezdés előtti tippjeiből
-- egy KÜLÖN, verziózott kalibrációs réteg tanulhat. A jelöltek, a kiértékelések,
-- az aktív verzió mutatója és minden döntés auditálhatóan, tartósan tárolódik.
--
-- MIT NEM TESZ:
--   * egyetlen meglévő táblát, oszlopot, megszorítást, indexet, policy-t,
--     triggert vagy függvényt sem módosít és nem töröl; a 0001–0014-hez nem nyúl,
--   * a `model_tip_archive` sorait nem írja (a tanulás csak olvassa őket),
--   * nem érint előfizetést, Stripe-ot, felhasználói tippeket vagy pontozást,
--   * nem kapcsol be semmilyen kalibrációt: az alap motor (`xg-poisson-1`)
--     marad a kiszolgált modell; az aktív mutató kezdetben NULL (= alap motor).
--
-- BIZTONSÁG: RLS bekapcsolva, policy nincs, a kliens szerepek (anon,
-- authenticated) minden joga visszavonva. Kizárólag a szerver (service_role)
-- éri el, a legszűkebb szükséges jogokkal. Törlés / TRUNCATE tiltva (trigger +
-- visszavont jog); az audit-napló csak bővíthető.
--
-- VISSZAFORDÍTHATÓ (a táblák tulajdonosaként):
--   drop table if exists public.model_learning_events;
--   drop table if exists public.model_learning_state;
--   drop table if exists public.model_calibration_versions;
--   drop function if exists public.model_calibration_versions_guard();
--   drop function if exists public.model_learning_events_guard();
--   drop function if exists public.model_learning_block_removal();
--
-- Újrafuttatható: `create … if not exists`, `create or replace`, feltételes
-- triggerek, `on conflict do nothing` a kezdő állapotsorra.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Kalibrációs modellverziók (jelöltek) – a paraméterek megváltoztathatatlanok
-- ---------------------------------------------------------------------------
create table if not exists public.model_calibration_versions (
  id                  text        primary key,
  base_engine_version text        not null,
  method              text        not null,
  params              jsonb       not null,
  data_fingerprint    text        not null,
  training_window     jsonb       not null,
  metrics             jsonb       not null,
  gate_result         jsonb       not null,
  status              text        not null,
  status_reason       text,
  created_at          timestamptz not null default now(),
  status_changed_at   timestamptz not null default now(),

  constraint model_calibration_versions_id      check (id ~ '^cal-[0-9a-f]{12}$'),
  constraint model_calibration_versions_fp      check (char_length(data_fingerprint) = 64),
  constraint model_calibration_versions_status  check (status in ('shadow', 'eligible', 'active', 'rejected', 'rolled_back', 'retired'))
);

create index if not exists idx_model_calibration_versions_created
  on public.model_calibration_versions (created_at desc);

-- A jelölt tartalma (paraméterek, adat-ujjlenyomat, metrikák, kapuk) a
-- beszúrás után nem írható át – csak az életciklus-állapot változhat.
create or replace function public.model_calibration_versions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.id, new.base_engine_version, new.method, new.params, new.data_fingerprint,
      new.training_window, new.metrics, new.gate_result, new.created_at)
     is distinct from
     (old.id, old.base_engine_version, old.method, old.params, old.data_fingerprint,
      old.training_window, old.metrics, old.gate_result, old.created_at)
  then
    raise exception 'model_calibration_versions: a jelölt tartalma nem módosítható';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Egyetlen állapotsor: aktív mutató (CAS-számlálóval) + futás-zár (lease)
--
-- `active_model_id IS NULL` = az alap motor (xg-poisson-1) az aktív.
-- Az aktiválás/visszaállítás egyetlen feltételes UPDATE a `state_version`
-- egyezésére: két szerverpéldány nem állíthat be ütköző verziót.
-- ---------------------------------------------------------------------------
create table if not exists public.model_learning_state (
  id                   smallint    primary key default 1,
  active_model_id      text        references public.model_calibration_versions(id),
  previous_model_id    text        references public.model_calibration_versions(id),
  state_version        bigint      not null default 0,
  lock_owner           text,
  lock_until           timestamptz,
  last_run_started_at  timestamptz,
  last_run_finished_at timestamptz,
  last_run_status      text,
  last_run_error       text,
  last_run_summary     jsonb,
  updated_at           timestamptz not null default now(),

  constraint model_learning_state_singleton check (id = 1),
  constraint model_learning_state_run_status check (
    last_run_status is null or last_run_status in ('running', 'succeeded', 'failed', 'insufficient_data'))
);

insert into public.model_learning_state (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3) Audit-napló – csak bővíthető
-- ---------------------------------------------------------------------------
create table if not exists public.model_learning_events (
  id       uuid        primary key default gen_random_uuid(),
  at       timestamptz not null default now(),
  kind     text        not null,
  model_id text,
  actor    text,
  details  jsonb       not null default '{}'::jsonb,

  constraint model_learning_events_kind check (kind in (
    'evaluation', 'insufficient_data', 'candidate_rejected', 'candidate_eligible',
    'promotion', 'promotion_refused', 'rollback', 'failure', 'fallback', 'shadow_evaluation'))
);

create index if not exists idx_model_learning_events_at
  on public.model_learning_events (at desc);

create or replace function public.model_learning_events_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'model_learning_events: az audit-napló nem módosítható';
end;
$$;

create or replace function public.model_learning_block_removal()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'model_learning: a sorok nem törölhetők (%)', tg_op;
end;
$$;

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_trigger where tgname = 'model_calibration_versions_guard'
                 and tgrelid = 'public.model_calibration_versions'::regclass) then
    create trigger model_calibration_versions_guard
      before update on public.model_calibration_versions
      for each row execute function public.model_calibration_versions_guard();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'model_learning_events_guard'
                 and tgrelid = 'public.model_learning_events'::regclass) then
    create trigger model_learning_events_guard
      before update on public.model_learning_events
      for each row execute function public.model_learning_events_guard();
  end if;
  foreach t in array array['model_calibration_versions', 'model_learning_state', 'model_learning_events'] loop
    if not exists (select 1 from pg_trigger
                   where tgname = t || '_no_delete' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before delete on public.%I for each row '
                     'execute function public.model_learning_block_removal()', t || '_no_delete', t);
    end if;
    if not exists (select 1 from pg_trigger
                   where tgname = t || '_no_truncate' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before truncate on public.%I for each statement '
                     'execute function public.model_learning_block_removal()', t || '_no_truncate', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4) RLS és jogosultságok – legszűkebb jogkör
-- ---------------------------------------------------------------------------
alter table public.model_calibration_versions enable row level security;
alter table public.model_learning_state enable row level security;
alter table public.model_learning_events enable row level security;

revoke all on public.model_calibration_versions from anon, authenticated;
revoke all on public.model_learning_state from anon, authenticated;
revoke all on public.model_learning_events from anon, authenticated;
revoke all on function public.model_calibration_versions_guard() from public, anon, authenticated;
revoke all on function public.model_learning_events_guard() from public, anon, authenticated;
revoke all on function public.model_learning_block_removal() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke delete, truncate, trigger, references on public.model_calibration_versions from service_role;
    revoke insert, delete, truncate, trigger, references on public.model_learning_state from service_role;
    revoke update, delete, truncate, trigger, references on public.model_learning_events from service_role;
    grant select, insert, update on public.model_calibration_versions to service_role;
    grant select, update on public.model_learning_state to service_role;
    grant select, insert on public.model_learning_events to service_role;
  end if;
end $$;
