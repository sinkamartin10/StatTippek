-- TERVEZET – NEM FUTTATVA, NEM ALKALMAZVA. Lásd: docs/corners/archive-migration-plan.md
-- Szöglettippek archívuma (corners-nb-1). A meglévő model_tip_archive táblát NEM érinti.
-- Futtatás csak kifejezett jóváhagyás után, előbb helyi eldobható adatbázison.

begin;

create table if not exists public.corner_tip_archive (
  id                 uuid        primary key default gen_random_uuid(),
  match_id           text        not null,
  market             text        not null,
  version_no         integer     not null,
  content_hash       text        not null,
  model_version      text        not null,
  origin             text        not null,
  league_id          text        not null,
  kickoff            timestamptz not null,
  generated_at       timestamptz not null,
  pre_kickoff        boolean     not null,
  model_prob         double precision not null,
  home_expected      double precision not null,
  away_expected      double precision not null,
  sample_home        integer     not null,
  sample_away        integer     not null,
  sample_league      integer     not null,
  settlement_status  text        not null default 'pending',
  home_corners       integer,
  away_corners       integer,
  settled_at         timestamptz,
  created_at         timestamptz not null default now(),
  constraint corner_tip_archive_unique        unique (match_id, market, version_no),
  constraint corner_tip_archive_market        check (market ~ '^CRN_((HOME|AWAY)_)?[OU][0-9]{1,2}\.5$'),
  constraint corner_tip_archive_model         check (model_version ~ '^corners-'),
  constraint corner_tip_archive_origin        check (origin in ('demo', 'live')),
  constraint corner_tip_archive_version_pos   check (version_no >= 1),
  constraint corner_tip_archive_hash_len      check (char_length(content_hash) = 64),
  constraint corner_tip_archive_prob          check (model_prob >= 0 and model_prob <= 1),
  constraint corner_tip_archive_expected      check (home_expected >= 0 and away_expected >= 0),
  constraint corner_tip_archive_samples       check (sample_home >= 0 and sample_away >= 0 and sample_league >= 0),
  constraint corner_tip_archive_pre_kickoff   check (pre_kickoff = (generated_at < kickoff)),
  constraint corner_tip_archive_status        check (settlement_status in ('pending', 'won', 'lost', 'unsupported')),
  constraint corner_tip_archive_corners_valid check (
    (home_corners is null or home_corners >= 0) and (away_corners is null or away_corners >= 0)
  ),
  -- lezárt (nyert/vesztett) tipphez kötelező a hiteles meccsvégi szögletszám
  constraint corner_tip_archive_settlement    check (
    (settlement_status in ('won', 'lost') and home_corners is not null and away_corners is not null and settled_at is not null)
    or (settlement_status = 'pending' and home_corners is null and away_corners is null and settled_at is null)
    or (settlement_status = 'unsupported' and settled_at is not null)
  )
);

create index if not exists idx_corner_tip_archive_kickoff on public.corner_tip_archive (kickoff desc);

-- Változtathatatlanság: a tipp-mezők nem írhatók át, csak a függő tipp zárható le egyszer.
create or replace function public.corner_tip_archive_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'corner_tip_archive: a sorok nem törölhetők';
  end if;
  if (new.match_id, new.market, new.version_no, new.content_hash, new.model_version, new.origin, new.league_id,
      new.kickoff, new.generated_at, new.pre_kickoff, new.model_prob, new.home_expected, new.away_expected,
      new.sample_home, new.sample_away, new.sample_league)
     is distinct from
     (old.match_id, old.market, old.version_no, old.content_hash, old.model_version, old.origin, old.league_id,
      old.kickoff, old.generated_at, old.pre_kickoff, old.model_prob, old.home_expected, old.away_expected,
      old.sample_home, old.sample_away, old.sample_league) then
    raise exception 'corner_tip_archive: a rögzített tipp-mezők nem módosíthatók';
  end if;
  if old.settlement_status <> 'pending' then
    raise exception 'corner_tip_archive: a lezárt tipp nem írható át';
  end if;
  return new;
end $$;

drop trigger if exists corner_tip_archive_guard on public.corner_tip_archive;
create trigger corner_tip_archive_guard before update or delete on public.corner_tip_archive
  for each row execute function public.corner_tip_archive_guard();

alter table public.corner_tip_archive enable row level security;
revoke all on public.corner_tip_archive from anon, authenticated;
grant select, insert, update on public.corner_tip_archive to service_role;

commit;
