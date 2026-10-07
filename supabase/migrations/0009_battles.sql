-- ===========================================================================
-- 0009 – 1v1 Tipp Battle
--
-- C HIBRID MODELL:
--   competition_matches
--         ├── Tippverseny → user_predictions      (VÁLTOZATLAN)
--         └── 1v1 Battle  → battle_matches → battle_predictions
--
-- A battle a meglévő mérkőzés-rekordokat HIVATKOZZA (nem másolja), de saját
-- életciklusa, saját tipptáblája és saját pontszáma van.
--
-- MIÉRT KÜLÖN TIPPTÁBLA (ez a migráció legfontosabb döntése):
-- A `user_predictions` táblán `unique (user_id, competition_match_id)` van, és a
-- Tippverseny-ranglista, a FREE napi kvóta, a küldetés-haladás és a progression XP
-- MIND szűrő nélkül olvassa azt a táblát. Ha a battle-tipp oda kerülne, azonnal
-- megjelenne a ranglistán, fogyasztaná a FREE kvótát, beszámítana a küldetésekbe,
-- XP-t adna, és felülírná a felhasználó normál Tippverseny-tippjét ugyanarra a
-- mérkőzésre. A külön tábla ezért nem stílusdöntés: ez adja az izolációt
-- SZERKEZETILEG, szűrők nélkül.
--
-- MIT NEM TESZ EZ A MIGRÁCIÓ:
--   * egyetlen meglévő táblát, oszlopot, constraintet, indexet vagy policy-t
--     sem módosít és nem töröl,
--   * egyetlen meglévő adatsort sem ír,
--   * nem nyúl a 0004–0008 migrációk semmijéhez,
--   * NEM bővíti a progression_events type CHECK-jét: a battle V1-ben 0 XP-t ad,
--     ezért progression esemény egyáltalán nem keletkezik.
--
-- Újrafuttatható: minden utasítás `if not exists` / `or replace` / `drop …; create`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) battles – egy 1v1 párbaj
-- ---------------------------------------------------------------------------
create table if not exists public.battles (
  id                 uuid primary key default gen_random_uuid(),
  challenger_id      uuid not null references auth.users (id) on delete cascade,
  opponent_id        uuid not null references auth.users (id) on delete cascade,
  status             text not null default 'pending'
                     check (status in ('pending', 'active', 'settled', 'declined', 'cancelled', 'expired')),
  -- A kihívás lejárata. A lejárást LUSTÁN értékeljük ki (nincs ütemező): az
  -- elfogadás feltételes UPDATE-je tartalmazza az időfeltételt is.
  invite_expires_at  timestamptz not null,
  -- null = döntetlen VAGY még nincs lezárva; a status dönti el, melyik.
  -- SZÁNDÉKOSAN tárolt és nem számított: egy utólagos eredmény-korrekció sem
  -- írhatja át a már kiosztott győzelmet.
  winner_user_id     uuid references auth.users (id) on delete set null,
  challenger_points  integer check (challenger_points is null or challenger_points >= 0),
  opponent_points    integer check (opponent_points is null or opponent_points >= 0),
  settled_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Önmagát senki nem hívhatja ki – adatbázis-szinten is
  constraint battles_distinct_players check (challenger_id <> opponent_id),
  -- A győztes csak a két résztvevő egyike lehet (vagy null = döntetlen)
  constraint battles_winner_is_player check (
    winner_user_id is null or winner_user_id = challenger_id or winner_user_id = opponent_id
  ),
  -- Lezárt battle-nek van pontja és időbélyege; nem lezártnak nincs
  constraint battles_settled_shape check (
    (status = 'settled' and settled_at is not null
      and challenger_points is not null and opponent_points is not null)
    or
    (status <> 'settled' and settled_at is null
      and challenger_points is null and opponent_points is null and winner_user_id is null)
  )
);

comment on table public.battles is '1v1 Tipp Battle. A battle életciklusa FÜGGETLEN a szülő verseny állapotától; csak a mérkőzés szintű szabályok számítanak. Írni csak a szerver tud (service_role).';
comment on column public.battles.winner_user_id is 'A győztes azonosítója, vagy NULL döntetlen esetén (lezárt battle-nél). Tárolt érték: utólagos eredmény-korrekció sem írja át.';

create index if not exists idx_battles_challenger on public.battles (challenger_id, status, created_at desc);
create index if not exists idx_battles_opponent   on public.battles (opponent_id, status, created_at desc);

-- Ugyanaz a kihívó → ugyanaz az ellenfél párosra EGYSZERRE csak egy NYITOTT kihívás
-- lehet. Részleges egyedi index: adatbázis-szintű garancia, nem szolgáltatás-szintű
-- ellenőrzés, ezért párhuzamos kérés sem tudja megkerülni.
create unique index if not exists idx_battles_one_pending_pair
  on public.battles (challenger_id, opponent_id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 2) battle_matches – a battle 3 mérkőzése (HIVATKOZÁS, nem másolat)
-- ---------------------------------------------------------------------------
create table if not exists public.battle_matches (
  id                   uuid primary key default gen_random_uuid(),
  battle_id            uuid not null references public.battles (id) on delete cascade,
  competition_match_id uuid not null references public.competition_matches (id) on delete cascade,
  created_at           timestamptz not null default now(),
  constraint battle_matches_unique unique (battle_id, competition_match_id)
);

comment on table public.battle_matches is 'A battle-hez tartozó mérkőzések. A competition_matches rekordokat HIVATKOZZA – a mérkőzésadat (kickoff, status, eredmény) továbbra is egyetlen helyen, a meglévő szinkronon keresztül él.';

create index if not exists idx_battle_matches_battle on public.battle_matches (battle_id);
create index if not exists idx_battle_matches_match  on public.battle_matches (competition_match_id);

-- ---------------------------------------------------------------------------
-- 3) battle_predictions – a battle tippjei. TELJESEN elkülönítve a
--    user_predictions táblától (lásd a fejléc magyarázatát).
-- ---------------------------------------------------------------------------
create table if not exists public.battle_predictions (
  id                   uuid primary key default gen_random_uuid(),
  battle_id            uuid not null references public.battles (id) on delete cascade,
  user_id              uuid not null references auth.users (id) on delete cascade,
  competition_match_id uuid not null references public.competition_matches (id) on delete cascade,
  predicted_home_score integer not null check (predicted_home_score between 0 and 99),
  predicted_away_score integer not null check (predicted_away_score between 0 and 99),
  -- null = még nincs kiértékelve; a szerver számolja a meglévő 5/3/0 szabállyal
  points               integer check (points is null or points >= 0),
  submitted_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- A battle_id a kulcs RÉSZE: ugyanarra a mérkőzésre párhuzamosan létezhet
  -- Tippverseny-tipp (user_predictions) ÉS battle-tipp, sőt több battle-ben is.
  constraint battle_predictions_unique unique (battle_id, user_id, competition_match_id)
);

comment on table public.battle_predictions is 'Battle tippek. KÜLÖN tábla a user_predictions-től: így a battle nem jelenik meg a Tippverseny ranglistán, nem fogyaszt FREE napi kvótát, nem számít küldetés-haladásba, nem ad Tippverseny XP-t vagy helyezést, és nem írja felül a normál Tippverseny-tippet.';
comment on column public.battle_predictions.points is 'Szerveroldalon számolt pont (5 / 3 / 0) a meglévő scorePrediction() szabállyal. A kliens sosem írhatja.';

create index if not exists idx_battle_predictions_battle on public.battle_predictions (battle_id);
create index if not exists idx_battle_predictions_user   on public.battle_predictions (user_id);
create index if not exists idx_battle_predictions_match  on public.battle_predictions (competition_match_id);

-- ---------------------------------------------------------------------------
-- 4) updated_at karbantartás (a 0004-ben létrehozott függvénnyel)
--    Itt is definiáljuk, hogy ez a migráció önmagában is futtatható legyen.
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

drop trigger if exists touch_battles on public.battles;
create trigger touch_battles before update on public.battles
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_battle_predictions on public.battle_predictions;
create trigger touch_battle_predictions before update on public.battle_predictions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5) Tulajdonos-védelem: a résztvevők és a tipp tulajdonosa utólag nem írható át
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

drop trigger if exists protect_battle_predictions_owner on public.battle_predictions;
create trigger protect_battle_predictions_owner before update on public.battle_predictions
  for each row execute function public.protect_owner_column();

create or replace function public.protect_battle_players()
returns trigger
language plpgsql
as $$
begin
  if new.challenger_id is distinct from old.challenger_id
     or new.opponent_id is distinct from old.opponent_id then
    raise exception 'A battle résztvevői nem módosíthatók';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_battles_players on public.battles;
create trigger protect_battles_players before update on public.battles
  for each row execute function public.protect_battle_players();

-- ---------------------------------------------------------------------------
-- 6) A battle létrehozása ATOMIKUSAN
--
--    Miért függvény? A létrehozás három, egymástól elválaszthatatlan dolgot
--    követel meg, amit PostgREST-en (tranzakció nélkül) nem lehet együtt
--    garantálni:
--      a) a battle és a PONTOSAN 3 mérkőzése együtt jöjjön létre (különben
--         maradhatna 0 vagy 2 mérkőzéses battle),
--      b) a „legfeljebb 5 nyitott kihívás" korlát párhuzamos kérésnél se
--         léphető túl (count + insert nem választható szét),
--      c) a már létező nyitott kihívás ne duplázódjon.
--    A plpgsql törzs EGY implicit tranzakcióban fut, és a kihívóra vett
--    advisory lock sorba állítja ugyanazon felhasználó párhuzamos kéréseit.
--
--    A „pontosan 3" szabály így ADATBÁZIS-SZINTEN is ki van kényszerítve, nem
--    csak a szolgáltatásban és nem csak a felületen.
-- ---------------------------------------------------------------------------
create or replace function public.create_battle(
  p_challenger_id uuid,
  p_opponent_id   uuid,
  p_match_ids     uuid[],
  p_expires_at    timestamptz,
  p_match_count   integer,
  p_max_pending   integer,
  p_now           timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_battle   public.battles;
  v_distinct uuid[];
  v_valid    integer;
  v_pending  integer;
  v_match    uuid;
begin
  if p_challenger_id is null or p_opponent_id is null then
    raise exception 'A résztvevők azonosítója kötelező.' using errcode = '22023';
  end if;
  if p_challenger_id = p_opponent_id then
    raise exception 'Önmagadat nem hívhatod ki.' using errcode = '22023';
  end if;

  -- Pontosan N KÜLÖNBÖZŐ mérkőzés (a duplikált azonosító nem "tölti fel" a hármat)
  select array_agg(distinct m) into v_distinct from unnest(p_match_ids) as m;
  if v_distinct is null or array_length(v_distinct, 1) <> p_match_count then
    raise exception 'A battle pontosan % különböző mérkőzésből állhat.', p_match_count using errcode = '22023';
  end if;

  -- Mindhárom mérkőzés létezzen, legyen 'scheduled', és a kezdése legyen a jövőben
  select count(*)::integer into v_valid
    from public.competition_matches cm
   where cm.id = any(v_distinct)
     and cm.status = 'scheduled'
     and cm.kickoff > p_now;
  if v_valid <> p_match_count then
    raise exception 'A kiválasztott mérkőzések közül nem mindegyik tippelhető.' using errcode = '22023';
  end if;

  -- A számolás és a beszúrás elválaszthatatlansága a kihívóra vett lockkal
  perform pg_advisory_xact_lock(hashtextextended(p_challenger_id::text, 0));

  -- A kihívó LEJÁRT, de még 'pending' kihívásainak utánvezetése.
  -- Enélkül egy lejárt sor véglegesen blokkolná ugyanannak az ellenfélnek az
  -- újbóli kihívását (a lenti páros-ellenőrzés és a részleges egyedi index is
  -- a 'pending' státuszra épül, a lejáratra nem). A lock alatt végezzük, ezért
  -- párhuzamos kéréssel sem csúszhat el.
  update public.battles
     set status = 'expired'
   where challenger_id = p_challenger_id
     and status = 'pending'
     and invite_expires_at <= p_now;

  select count(*)::integer into v_pending
    from public.battles b
   where b.challenger_id = p_challenger_id
     and b.status = 'pending'
     and b.invite_expires_at > p_now;
  if p_max_pending is not null and v_pending >= p_max_pending then
    return jsonb_build_object('outcome', 'pending_limit', 'pending', v_pending, 'battle', null);
  end if;

  -- Nyitott kihívás ugyanerre a párosra? (a részleges egyedi index is védi)
  if exists (
    select 1 from public.battles b
     where b.challenger_id = p_challenger_id
       and b.opponent_id = p_opponent_id
       and b.status = 'pending'
  ) then
    return jsonb_build_object('outcome', 'already_challenged', 'pending', v_pending, 'battle', null);
  end if;

  insert into public.battles (challenger_id, opponent_id, status, invite_expires_at)
  values (p_challenger_id, p_opponent_id, 'pending', p_expires_at)
  returning * into v_battle;

  foreach v_match in array v_distinct loop
    insert into public.battle_matches (battle_id, competition_match_id)
    values (v_battle.id, v_match);
  end loop;

  return jsonb_build_object('outcome', 'created', 'pending', v_pending + 1, 'battle', to_jsonb(v_battle));
end;
$$;

comment on function public.create_battle(uuid, uuid, uuid[], timestamptz, integer, integer, timestamptz) is
  '1v1 battle atomikus létrehozása a pontosan N mérkőzés, a nyitott-kihívás korlát és a páros-duplikáció egyidejű kikényszerítésével. A korlátokat és az időt a hívó szerver adja be (az üzleti szabály a src/shared/battles.ts-ben lakik). Csak a service_role hívhatja.';

revoke all on function public.create_battle(uuid, uuid, uuid[], timestamptz, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_battle(uuid, uuid, uuid[], timestamptz, integer, integer, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7) Row Level Security
--    SELECT: a battle-t csak a két résztvevő látja; a tippet KÖZVETLENÜL csak a
--            saját tulajdonosa. Így az ellenfél a Supabase REST API-n keresztül
--            NEM tudja kiolvasni a másik tippjét – azt kizárólag a saját szerver
--            API adhatja vissza, és csak a mérkőzés kezdése után.
--    INSERT/UPDATE/DELETE: nincs policy az authenticated szerepkörnek – írni
--            kizárólag a hitelesített API-n keresztül, service_role-lal lehet.
-- ---------------------------------------------------------------------------
alter table public.battles            enable row level security;
alter table public.battle_matches     enable row level security;
alter table public.battle_predictions enable row level security;

drop policy if exists "battles: saját párbajok olvasása" on public.battles;
create policy "battles: saját párbajok olvasása"
  on public.battles for select
  to authenticated
  using ((select auth.uid()) = challenger_id or (select auth.uid()) = opponent_id);

drop policy if exists "battle_matches: a szülő battle-en keresztül" on public.battle_matches;
create policy "battle_matches: a szülő battle-en keresztül"
  on public.battle_matches for select
  to authenticated
  using (exists (
    select 1 from public.battles b
     where b.id = battle_matches.battle_id
       and ((select auth.uid()) = b.challenger_id or (select auth.uid()) = b.opponent_id)
  ));

drop policy if exists "battle_predictions: csak a saját tipp" on public.battle_predictions;
create policy "battle_predictions: csak a saját tipp"
  on public.battle_predictions for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Jogosultságok: az API szerepkörök csak olvasást kapnak (az RLS tovább szűr)
revoke all on public.battles, public.battle_matches, public.battle_predictions
  from anon, authenticated;

grant select on public.battles, public.battle_matches, public.battle_predictions
  to authenticated;
