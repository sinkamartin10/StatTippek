-- TERVEZET – NEM FUTTATVA, NEM ALKALMAZVA, nincs a supabase/migrations/ mappában.
-- Lásd: docs/model-learning/settlement-corrections-plan.md
--
-- Cél: a már lezárt archív tipp eredményének utólagos KORREKCIÓJA úgy, hogy
--  - az eredeti sor (model_prob, engine_version, eredeti elszámolás) VÁLTOZATLAN marad,
--  - a korrekció hozzáfűzéses (append-only) naplóba kerül, ki/mikor/miért mezőkkel,
--  - a tanulás egy „érvényes eredmény” nézetből olvas (eredeti + legutolsó korrekció),
--  - minden korrekció új adat-ujjlenyomatot ad → új jelölt-azonosító (visszakövethető).
-- Az alkalmazás előtt: helyi, eldobható adatbázison tesztelni; production csak külön jóváhagyással.

begin;

create table if not exists public.model_tip_archive_settlement_corrections (
  id                 uuid        primary key default gen_random_uuid(),
  archive_id         uuid        not null references public.model_tip_archive (id),
  corrected_status   text        not null,
  corrected_home_goals integer,
  corrected_away_goals integer,
  -- a korrigált állapot forrása és oka (pl. 'espn-recheck', 'admin')
  source             text        not null,
  reason             text        not null,
  observed_at        timestamptz not null,
  created_at         timestamptz not null default now(),
  constraint mtasc_status check (corrected_status in ('won', 'lost', 'void', 'unsupported', 'pending')),
  constraint mtasc_goals  check (
    (corrected_status in ('won', 'lost') and corrected_home_goals >= 0 and corrected_away_goals >= 0)
    or (corrected_status in ('void', 'unsupported', 'pending'))
  ),
  constraint mtasc_reason check (char_length(reason) between 3 and 500)
);

create index if not exists idx_mtasc_archive on public.model_tip_archive_settlement_corrections (archive_id, observed_at desc, created_at desc);

-- Hozzáfűzéses napló: nem módosítható, nem törölhető.
create or replace function public.mtasc_guard() returns trigger language plpgsql as $$
begin
  raise exception 'model_tip_archive_settlement_corrections: a korrekciós napló nem módosítható és nem törölhető (%)', tg_op;
end $$;
drop trigger if exists mtasc_guard on public.model_tip_archive_settlement_corrections;
create trigger mtasc_guard before update or delete on public.model_tip_archive_settlement_corrections
  for each row execute function public.mtasc_guard();

-- Az érvényes elszámolás: az eredeti sor, a legutolsó korrekcióval felülírt eredmény-mezőkkel.
-- (A tanító olvasás – loadArchive – erre a nézetre állna át; az eredeti oszlopok is megmaradnak.)
create or replace view public.model_tip_archive_counted_effective with (security_invoker = true) as
  select c.*,
         coalesce(k.corrected_status, c.settlement_status)  as effective_status,
         case when k.id is null then c.home_goals else k.corrected_home_goals end as effective_home_goals,
         case when k.id is null then c.away_goals else k.corrected_away_goals end as effective_away_goals,
         k.id as correction_id
    from public.model_tip_archive_counted c
    left join lateral (
      select * from public.model_tip_archive_settlement_corrections x
       where x.archive_id = c.id
       order by x.observed_at desc, x.created_at desc
       limit 1
    ) k on true;

alter table public.model_tip_archive_settlement_corrections enable row level security;
revoke all on public.model_tip_archive_settlement_corrections from anon, authenticated;
grant select, insert on public.model_tip_archive_settlement_corrections to service_role;
revoke all on public.model_tip_archive_counted_effective from anon, authenticated;
grant select on public.model_tip_archive_counted_effective to service_role;

commit;
