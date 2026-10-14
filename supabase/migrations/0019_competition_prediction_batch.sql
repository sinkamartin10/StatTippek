-- ===========================================================================
-- 0019 – Tippverseny: több tipp ATOMIKUS beküldése egyetlen művelettel
--
-- MIÉRT KELL ADATBÁZIS-FÜGGVÉNY?
-- A szerver PostgREST-en (supabase-js) ír, ahol nincs tranzakció. Ha a csomag
-- tippjeit egyenként mentenénk, egy közbenső hiba (zárolt meccs, elfogyott
-- napi keret, hálózat) RÉSZBEN mentett csomagot hagyna maga után. A plpgsql
-- függvénytörzs EGY tranzakcióban fut: vagy minden tipp rögzül, vagy egy sem.
--
-- UGYANAZOK A SZABÁLYOK, mint a 0008 `submit_competition_prediction` esetén:
--   * ugyanaz a felhasználó-szintű advisory lock (a két függvény egymással is
--     sorba áll, így a napi kvóta párhuzamos kérésekkel sem léphető át),
--   * a napi kvóta csak az ÚJ tippeket számolja; a módosítás nem fogyaszt,
--   * módosításkor a submitted_at és a points érintetlen,
--   * a limitet és a napablakot a hívó szerver adja be (az üzleti szabály
--     a src/shared/freeQuota.ts-ben marad; null = nincs limit, PRO).
-- Az alkalmazás MINDENT előre ellenőriz; az itteni verseny-/meccs-ellenőrzés
-- a mérvadó adatbázis-idővel ismételt védőháló (src/shared/competition.ts
-- `predictionWindow` megfelelője), hogy a kezdés pillanatában érkező csomag se
-- csússzon át.
--
-- KIMENET (jsonb):
--   {outcome:'saved', used, results:[{competitionMatchId, outcome:'created'|'updated'|'unchanged', prediction}]}
--   {outcome:'limit_reached', used, newCount}       – NEM történt írás
--   {outcome:'rejected', errors:[{competitionMatchId, code, message}]} – NEM történt írás
-- Formailag hibás bemenet: kivétel (22023) → a tranzakció visszagörgetődik.
--
-- MIT NEM TESZ: nem hoz létre és nem módosít táblát, oszlopot, constraintet,
-- indexet, RLS-t; a 0008 függvényhez nem nyúl; adatsort nem töröl.
-- Újrafuttatható (create or replace). Visszafordítás:
--   drop function if exists public.submit_competition_predictions_batch(uuid, uuid, jsonb, integer, timestamptz, timestamptz);
-- ALKALMAZÁS: kézzel, a kód kiadása ELŐTT. A függvény nélkül a tömeges
-- beküldés hibát ad (az egyenkénti végpont változatlanul működik).
-- ===========================================================================

create or replace function public.submit_competition_predictions_batch(
  p_user_id        uuid,
  p_competition_id uuid,
  -- [{"competitionMatchId": uuid, "home": 0..99, "away": 0..99}, ...]
  p_items          jsonb,
  p_daily_limit    integer,
  p_day_start      timestamptz,
  p_day_end        timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item     jsonb;
  v_match_id uuid;
  v_home     integer;
  v_away     integer;
  v_n        integer;
  v_comp     public.competition_rounds;
  v_m        public.competition_matches;
  v_row      public.user_predictions;
  v_used     integer;
  v_new      integer := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_outcome  text;
begin
  if p_user_id is null or p_competition_id is null then
    raise exception 'A felhasználó és a verseny azonosítója kötelező.' using errcode = '22023';
  end if;
  if p_day_start is null or p_day_end is null or p_day_end <= p_day_start then
    raise exception 'Érvénytelen napi időablak.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'A tippcsomag listája hiányzik.' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 200 then
    raise exception 'A tippcsomag 1–200 tippet tartalmazhat.' using errcode = '22023';
  end if;

  -- 1) Formai ellenőrzés: minden elem egész gólszám 0–99, azonosító uuid
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'home') <> 'number' or jsonb_typeof(v_item -> 'away') <> 'number'
       or (v_item ->> 'home')::numeric <> floor((v_item ->> 'home')::numeric)
       or (v_item ->> 'away')::numeric <> floor((v_item ->> 'away')::numeric)
       or (v_item ->> 'home')::numeric not between 0 and 99
       or (v_item ->> 'away')::numeric not between 0 and 99
       or coalesce(v_item ->> 'competitionMatchId', '') !~* '^[0-9a-f-]{36}$' then
      raise exception 'Érvénytelen tipp a csomagban.' using errcode = '22023';
    end if;
  end loop;
  -- 2) Ugyanaz a mérkőzés legfeljebb egyszer
  if (select count(distinct value ->> 'competitionMatchId') from jsonb_array_elements(p_items)) <> v_n then
    raise exception 'Ugyanarra a mérkőzésre csak egy tipp küldhető egy csomagban.' using errcode = '22023';
  end if;

  -- Ugyanaz a zár, mint a 0008-ban: a felhasználó minden tippírása sorba áll
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- 3) Verseny és meccsek – mérvadó adatbázis-idővel (predictionWindow megfelelője)
  select * into v_comp from public.competition_rounds where id = p_competition_id;
  if v_comp.id is null or v_comp.status = 'draft' then
    return jsonb_build_object('outcome', 'rejected', 'errors',
      jsonb_build_array(jsonb_build_object('competitionMatchId', null, 'code', 'COMPETITION_NOT_FOUND', 'message', 'A tippverseny nem található.')));
  end if;
  if v_comp.status <> 'active' or now() < v_comp.starts_at or now() >= v_comp.ends_at then
    return jsonb_build_object('outcome', 'rejected', 'errors',
      jsonb_build_array(jsonb_build_object('competitionMatchId', null, 'code', 'COMPETITION_CLOSED', 'message', 'A verseny jelenleg nem fogad tippet.')));
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_match_id := (v_item ->> 'competitionMatchId')::uuid;
    select * into v_m from public.competition_matches where id = v_match_id and competition_id = p_competition_id;
    if v_m.id is null then
      v_errors := v_errors || jsonb_build_object('competitionMatchId', v_match_id, 'code', 'MATCH_NOT_FOUND',
        'message', 'A mérkőzés nem ehhez a tippversenyhez tartozik.');
    elsif v_m.status <> 'scheduled' or now() >= v_m.kickoff then
      v_errors := v_errors || jsonb_build_object('competitionMatchId', v_match_id, 'code', 'PREDICTION_CLOSED',
        'message', 'A mérkőzés kezdése után már nem lehet tippelni.');
    elsif not exists (select 1 from public.user_predictions where user_id = p_user_id and competition_match_id = v_match_id) then
      v_new := v_new + 1;
    end if;
  end loop;
  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('outcome', 'rejected', 'errors', v_errors);
  end if;

  -- 4) Napi kvóta – a csomag ÚJ tippjei együtt férjenek bele, különben semmi sem íródik
  select count(*)::integer into v_used
    from public.user_predictions
   where user_id = p_user_id and submitted_at >= p_day_start and submitted_at < p_day_end;
  if p_daily_limit is not null and v_used + v_new > p_daily_limit then
    return jsonb_build_object('outcome', 'limit_reached', 'used', v_used, 'newCount', v_new);
  end if;

  -- 5) Írás – egy tranzakcióban; a változatlan tipphez nem nyúlunk
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_match_id := (v_item ->> 'competitionMatchId')::uuid;
    v_home := (v_item ->> 'home')::integer;
    v_away := (v_item ->> 'away')::integer;
    v_row := null;
    select * into v_row from public.user_predictions where user_id = p_user_id and competition_match_id = v_match_id;
    if v_row.id is null then
      insert into public.user_predictions (competition_match_id, user_id, predicted_home_score, predicted_away_score)
      values (v_match_id, p_user_id, v_home, v_away)
      returning * into v_row;
      v_outcome := 'created';
    elsif v_row.predicted_home_score = v_home and v_row.predicted_away_score = v_away then
      v_outcome := 'unchanged';
    else
      update public.user_predictions set predicted_home_score = v_home, predicted_away_score = v_away
       where id = v_row.id
      returning * into v_row;
      v_outcome := 'updated';
    end if;
    v_results := v_results || jsonb_build_object('competitionMatchId', v_match_id, 'outcome', v_outcome, 'prediction', to_jsonb(v_row));
  end loop;

  return jsonb_build_object('outcome', 'saved', 'used', v_used + v_new, 'results', v_results);
end;
$$;

comment on function public.submit_competition_predictions_batch(uuid, uuid, jsonb, integer, timestamptz, timestamptz) is
  'Tippverseny-tippcsomag atomikus létrehozása/módosítása napi kvótával: vagy minden tipp rögzül, vagy egy sem. Ugyanazt a felhasználó-szintű zárat használja, mint a submit_competition_prediction. Csak a service_role hívhatja.';

revoke all on function public.submit_competition_predictions_batch(uuid, uuid, jsonb, integer, timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function public.submit_competition_predictions_batch(uuid, uuid, jsonb, integer, timestamptz, timestamptz)
  to service_role;
