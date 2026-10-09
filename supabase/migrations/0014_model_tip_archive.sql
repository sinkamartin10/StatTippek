-- ===========================================================================
-- 0014 – Modell-tipp archívum
--
-- MIÉRT KELL: a statisztikai motor (determinisztikus xG + Poisson, NEM nyelvi
-- modell és NEM önmagát tanító rendszer) tippjei eddig sehol nem rögzültek –
-- csak kéréskor számolódtak, és 5 perces memóriacache-ben éltek. A
-- teljesítményük ezért utólag nem volt ellenőrizhető. Ez a tábla minden
-- ténylegesen előállított modell-tippet megőriz, és a meglévő
-- `evaluateMarket()` szabállyal lezárja a valós végeredmény alapján.
--
-- A meglévő `public.predictions` tábla NEM alkalmas erre: felhasználóhoz
-- kötött (user_id not null), és (user_id, match_id, market) egyedi – egy
-- modell-tipp több verzióját nem tudná megőrizni.
--
-- VERZIÓZÁS:
--   * (match_id, market, version_no) egyedi: ugyanannak a piacnak minden
--     LÉNYEGI változása új, sorszámozott, időbélyeges sort kap,
--   * a tartalmilag azonos újraszámolás NEM hoz létre új sort (a szerver a
--     legutolsó verzió `content_hash`-ével hasonlít),
--   * az odds változása önmagában NEM új tipp (az odds nincs a hash-ben, és a
--     modell-valószínűséget sem befolyásolja),
--   * a tipp-mezők a beszúrás után MEGVÁLTOZTATHATATLANOK (trigger) – csak az
--     elszámolási mezők írhatók, és azok is csak egyszer (függő → lezárt).
--
-- STATISZTIKA: mérkőzés + piac szerint KIZÁRÓLAG a kezdés előtt rögzített
-- utolsó verzió számít (`model_tip_archive_counted` nézet). A kezdés után
-- keletkezett sor megmarad az archívumban, de a teljesítménybe nem számít.
--
-- NYILVÁNOSSÁG: a sorban tárolt `kickoff` a GENERÁLÁSKOR ismert kezdés
-- (audit, sosem írjuk át). Hogy egy meccs tippjei nyilvánosak lehetnek-e, azt
-- a meccs AKTUÁLIS, hitelesen megfigyelt állapota dönti el
-- (`model_tip_archive_match_state`): csak a ténylegesen elkezdődött (`live`)
-- vagy lejátszott (`finished`) meccs látszik. Elhalasztott, átütemezett vagy
-- ismeretlen állapotú meccs egyetlen verziója sem jelenik meg.
--
-- MEGŐRZÉS: a sorok nem törölhetők és a táblák nem üríthetők (DELETE és
-- TRUNCATE trigger + a service_role-tól visszavont jogok). Adminisztratív
-- helyreállítás KIZÁRÓLAG a tábla tulajdonosaként (Supabase SQL Editor,
-- `postgres` szerep), dokumentált lépésekkel – lásd a 6) szakaszt. Ehhez
-- nincs és nem is lesz API-végpont.
--
-- MIT NEM TESZ:
--   * egyetlen meglévő táblát, oszlopot, megszorítást, indexet, policy-t vagy
--     triggert sem módosít és nem töröl; a 0001–0013 migrációkhoz nem nyúl,
--   * nem visszamenőleges: régi tippeket nem tölt fel – az archívum a
--     bevezetés pillanatától indul,
--   * nem tárol felhasználói adatot, kérés-részletet vagy indoklás-szöveget,
--   * nem érint számlázást, jogosultságot, versenyt, battle-t vagy pontozást.
--
-- VISSZAFORDÍTHATÓ (a táblák tulajdonosaként):
--   drop view if exists public.model_tip_archive_counted_listing;
--   drop view if exists public.model_tip_archive_listing;
--   drop view if exists public.model_tip_archive_counted;
--   drop function if exists public.model_tip_archive_observe(text, timestamptz, text, timestamptz);
--   drop table if exists public.model_tip_archive_match_state;
--   drop table if exists public.model_tip_archive;
--   drop function if exists public.model_tip_archive_guard();
--   drop function if exists public.model_tip_archive_block_removal();
--
-- Újrafuttatható: `create … if not exists`, `create or replace`, valamint
-- feltételesen létrehozott triggerek és nézet-opciók.
--
-- POSTGRESQL-VERZIÓ: a nézetek PG 15+ esetén `security_invoker` opcióval
-- jönnek létre (a lekérdező jogaival futnak), régebbi szerveren nélküle. A
-- biztonság egyik esetben sem ezen múlik: a kliens szerepeknek (anon,
-- authenticated) a nézetekre sincs semmilyen joguk.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Tábla
-- ---------------------------------------------------------------------------
create table if not exists public.model_tip_archive (
  id                    uuid        primary key default gen_random_uuid(),

  -- azonosítás és verzió
  match_id              text        not null,
  market                text        not null,
  version_no            integer     not null,
  content_hash          text        not null,
  engine_version        text        not null,
  generated_at          timestamptz not null default now(),
  origin                text        not null,

  -- a tipp a generálás pillanatában (MEGVÁLTOZTATHATATLAN)
  match_label           text        not null,
  league_id             text        not null,
  league_name           text        not null,
  kickoff               timestamptz not null,
  market_label          text        not null,
  market_type           text        not null,
  category              text        not null,
  model_prob            double precision not null,
  odds_at_generation    numeric(8,2),
  implied_prob          double precision,
  data_quality          text        not null,
  sample_size           integer     not null,
  supporting_indicators integer     not null,
  pre_kickoff           boolean     not null,

  -- közzétételi állapot
  availability          text        not null default 'pro_on_request',
  archive_visible       boolean     not null default true,

  -- elszámolás (egyszer írható: függő → lezárt)
  settlement_status     text        not null default 'pending',
  home_goals            smallint,
  away_goals            smallint,
  result_kickoff        timestamptz,
  settled_at            timestamptz,

  constraint model_tip_archive_version_uniq unique (match_id, market, version_no),
  constraint model_tip_archive_version_pos  check (version_no >= 1),
  constraint model_tip_archive_hash_len     check (char_length(content_hash) = 64),
  constraint model_tip_archive_origin       check (origin in ('demo', 'live')),
  constraint model_tip_archive_category     check (category in ('konzervatív', 'mérsékelt', 'magas variancia')),
  constraint model_tip_archive_prob         check (model_prob >= 0 and model_prob <= 1),
  constraint model_tip_archive_odds         check (odds_at_generation is null or odds_at_generation > 1),
  constraint model_tip_archive_implied      check (implied_prob is null or (implied_prob >= 0 and implied_prob <= 1)),
  constraint model_tip_archive_quality      check (data_quality in ('magas', 'közepes', 'kevés')),
  constraint model_tip_archive_counts       check (sample_size >= 0 and supporting_indicators >= 0),
  -- a „kezdés előtti" jelzőt nem lehet a valóságtól eltérően beállítani
  constraint model_tip_archive_pre_kickoff  check (pre_kickoff = (generated_at < kickoff)),
  constraint model_tip_archive_availability check (availability in ('pro_on_request', 'not_published')),
  constraint model_tip_archive_status       check (settlement_status in ('pending', 'won', 'lost', 'void', 'unsupported')),
  -- függő sorban nincs eredmény; lezárt sorban mindig van eredmény és időpont
  constraint model_tip_archive_settlement   check (
    (settlement_status = 'pending'
      and home_goals is null and away_goals is null and settled_at is null and result_kickoff is null)
    or
    (settlement_status <> 'pending'
      and home_goals is not null and away_goals is not null and settled_at is not null
      and home_goals >= 0 and away_goals >= 0)
  )
);

-- ---------------------------------------------------------------------------
-- 2) Indexek – az archívum szűrőihez és az elszámolás kereséséhez
-- ---------------------------------------------------------------------------
create index if not exists idx_model_tip_archive_kickoff
  on public.model_tip_archive (kickoff desc, match_id, market, version_no desc);
create index if not exists idx_model_tip_archive_match_market
  on public.model_tip_archive (match_id, market, version_no desc);
create index if not exists idx_model_tip_archive_pending
  on public.model_tip_archive (kickoff) where settlement_status = 'pending';
create index if not exists idx_model_tip_archive_league
  on public.model_tip_archive (league_id, kickoff desc);
create index if not exists idx_model_tip_archive_market_type
  on public.model_tip_archive (market_type, kickoff desc);

-- ---------------------------------------------------------------------------
-- 3) Megváltoztathatatlanság
--
-- A tipp-mezők a beszúrás után nem írhatók felül – még a service_role sem
-- tudja (a trigger az RLS-től függetlenül fut). Elszámolni csak függő sort
-- lehet, és csak egyszer: a lezárt sor eredménye sem írható át.
-- ---------------------------------------------------------------------------
create or replace function public.model_tip_archive_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.id, new.match_id, new.market, new.version_no, new.content_hash, new.engine_version,
      new.generated_at, new.origin, new.match_label, new.league_id, new.league_name, new.kickoff,
      new.market_label, new.market_type, new.category, new.model_prob, new.odds_at_generation,
      new.implied_prob, new.data_quality, new.sample_size, new.supporting_indicators, new.pre_kickoff)
     is distinct from
     (old.id, old.match_id, old.market, old.version_no, old.content_hash, old.engine_version,
      old.generated_at, old.origin, old.match_label, old.league_id, old.league_name, old.kickoff,
      old.market_label, old.market_type, old.category, old.model_prob, old.odds_at_generation,
      old.implied_prob, old.data_quality, old.sample_size, old.supporting_indicators, old.pre_kickoff)
  then
    raise exception 'model_tip_archive: a rögzített tipp nem módosítható';
  end if;
  if old.settlement_status <> 'pending'
     and (new.settlement_status, new.home_goals, new.away_goals, new.result_kickoff, new.settled_at)
         is distinct from
         (old.settlement_status, old.home_goals, old.away_goals, old.result_kickoff, old.settled_at)
  then
    raise exception 'model_tip_archive: a lezárt tipp eredménye nem írható át';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'model_tip_archive_guard'
      and tgrelid = 'public.model_tip_archive'::regclass
  ) then
    create trigger model_tip_archive_guard
      before update on public.model_tip_archive
      for each row execute function public.model_tip_archive_guard();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) A meccsek aktuális, hitelesen megfigyelt állapota
--
-- Soronként egy meccs: a szerver az adatszolgáltatótól (getMatch / elemzés)
-- kapott LEGFRISSEBB kezdési időt és állapotot írja ide. Régebbi megfigyelés
-- nem írhatja felül az újabbat (`model_tip_archive_observe`).
--
-- `match_status`:
--   scheduled – még nem kezdődött el (vagy nincs megerősítve),
--   live      – elkezdődött (befejezett, de végeredmény nélküli meccs is ez),
--   finished  – lejátszva, végeredménnyel,
--   postponed – elhalasztva / törölve / félbeszakadt.
-- Nyilvánosan CSAK live és finished meccs tippje látszik.
-- ---------------------------------------------------------------------------
create table if not exists public.model_tip_archive_match_state (
  match_id        text        primary key,
  current_kickoff timestamptz not null,
  match_status    text        not null,
  observed_at     timestamptz not null,

  constraint model_tip_archive_match_state_status
    check (match_status in ('scheduled', 'live', 'finished', 'postponed'))
);

create index if not exists idx_model_tip_archive_match_state_due
  on public.model_tip_archive_match_state (current_kickoff desc)
  where match_status <> 'finished';

-- Feltételes upsert: csak az ugyanolyan idejű vagy újabb megfigyelés írhat
-- felül. NEM security definer: a hívó (service_role) saját jogaival fut.
create or replace function public.model_tip_archive_observe(
  p_match_id text, p_kickoff timestamptz, p_status text, p_observed_at timestamptz
)
returns void
language sql
set search_path = public
as $$
  insert into public.model_tip_archive_match_state as s (match_id, current_kickoff, match_status, observed_at)
  values (p_match_id, p_kickoff, p_status, p_observed_at)
  on conflict (match_id) do update
    set current_kickoff = excluded.current_kickoff,
        match_status    = excluded.match_status,
        observed_at     = excluded.observed_at
    where s.observed_at <= excluded.observed_at;
$$;

-- ---------------------------------------------------------------------------
-- 5) Nézetek
--
-- model_tip_archive_counted: mérkőzés + piac szerint a KEZDÉS ELŐTT rögzített
-- utolsó verzió. A kezdés előttiséget a generáláskor ismert kezdési időhöz ÉS
-- – ha a meccs időpontja közben módosult – az elszámoláskor ismert kezdési
-- időhöz is mérjük; a szigorúbb feltétel dönt.
--
-- *_listing: a sorok a meccs AKTUÁLIS állapotával összekapcsolva (inner join:
-- állapot nélküli meccs nem jelenik meg). A szerver MINDEN nyilvános
-- lekérdezést ezeken át végez, és a `match_status` + `current_kickoff`
-- feltételt mindig rájuk teszi.
-- ---------------------------------------------------------------------------
do $$
declare
  opts text := case when current_setting('server_version_num')::int >= 150000
                    then ' with (security_invoker = true)' else '' end;
begin
  execute 'create or replace view public.model_tip_archive_counted' || opts || ' as
    select distinct on (match_id, market) *
    from public.model_tip_archive
    where pre_kickoff
      and (result_kickoff is null or generated_at < result_kickoff)
    order by match_id, market, generated_at desc, version_no desc';

  execute 'create or replace view public.model_tip_archive_listing' || opts || ' as
    select a.*, s.current_kickoff, s.match_status
    from public.model_tip_archive a
    join public.model_tip_archive_match_state s on s.match_id = a.match_id';

  execute 'create or replace view public.model_tip_archive_counted_listing' || opts || ' as
    select c.*, s.current_kickoff, s.match_status
    from public.model_tip_archive_counted c
    join public.model_tip_archive_match_state s on s.match_id = c.match_id';
end $$;

-- ---------------------------------------------------------------------------
-- 6) Megőrzés: DELETE és TRUNCATE tiltása
--
-- A sor-szintű DELETE trigger a TRUNCATE-ot NEM állítja meg, ezért külön
-- utasítás-szintű TRUNCATE trigger is van. A triggerek minden szerepre
-- vonatkoznak (a service_role-ra és a tulajdonosra is); kikapcsolni csak a
-- tábla tulajdonosa tudja (`alter table … disable trigger` tulajdonjogot
-- igényel, a service_role-nak ez nincs meg).
--
-- ADMINISZTRATÍV HELYREÁLLÍTÁS – csak a tábla tulajdonosaként (Supabase SQL
-- Editor), előzetes mentés után, egyetlen tranzakcióban. API-végpont NINCS.
--   begin;
--   alter table public.model_tip_archive disable trigger model_tip_archive_no_delete;
--   alter table public.model_tip_archive disable trigger model_tip_archive_no_truncate;
--   -- … a dokumentált, jóváhagyott javító művelet …
--   alter table public.model_tip_archive enable trigger model_tip_archive_no_delete;
--   alter table public.model_tip_archive enable trigger model_tip_archive_no_truncate;
--   commit;
-- (A model_tip_archive_match_state táblára ugyanígy, a saját triggereivel.)
-- ---------------------------------------------------------------------------
create or replace function public.model_tip_archive_block_removal()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'model_tip_archive: az archívum sorai nem törölhetők (%)', tg_op;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['model_tip_archive', 'model_tip_archive_match_state'] loop
    if not exists (select 1 from pg_trigger
                   where tgname = t || '_no_delete' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before delete on public.%I for each row '
                     'execute function public.model_tip_archive_block_removal()', t || '_no_delete', t);
    end if;
    if not exists (select 1 from pg_trigger
                   where tgname = t || '_no_truncate' and tgrelid = ('public.' || t)::regclass) then
      execute format('create trigger %I before truncate on public.%I for each statement '
                     'execute function public.model_tip_archive_block_removal()', t || '_no_truncate', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7) RLS és jogosultságok
--
-- Az archívum NYILVÁNOS oldala a szerveren át, a szerver szűrésével érhető el.
-- A kliens kulcsok (anon, authenticated) SEMMIT nem olvashatnak és nem
-- írhatnak közvetlenül: policy nincs, minden jog visszavonva.
--
-- service_role: pontosan annyi jog, amennyi a működéshez kell (olvasás,
-- beszúrás, elszámolás és állapot-frissítés). DELETE, TRUNCATE, TRIGGER és
-- REFERENCES kifejezetten visszavonva – a Supabase alapértelmezett
-- jogosztását (ALL) ez a migráció ezekre a táblákra szűkíti.
-- ---------------------------------------------------------------------------
alter table public.model_tip_archive enable row level security;
alter table public.model_tip_archive_match_state enable row level security;

revoke all on public.model_tip_archive from anon, authenticated;
revoke all on public.model_tip_archive_match_state from anon, authenticated;
revoke all on public.model_tip_archive_counted from anon, authenticated;
revoke all on public.model_tip_archive_listing from anon, authenticated;
revoke all on public.model_tip_archive_counted_listing from anon, authenticated;
revoke all on function public.model_tip_archive_guard() from public, anon, authenticated;
revoke all on function public.model_tip_archive_block_removal() from public, anon, authenticated;
revoke all on function public.model_tip_archive_observe(text, timestamptz, text, timestamptz) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke delete, truncate, trigger, references on public.model_tip_archive from service_role;
    revoke delete, truncate, trigger, references on public.model_tip_archive_match_state from service_role;
    grant select, insert, update on public.model_tip_archive to service_role;
    grant select, insert, update on public.model_tip_archive_match_state to service_role;
    grant select on public.model_tip_archive_counted, public.model_tip_archive_listing,
                    public.model_tip_archive_counted_listing to service_role;
    grant execute on function public.model_tip_archive_observe(text, timestamptz, text, timestamptz) to service_role;
  end if;
end $$;
