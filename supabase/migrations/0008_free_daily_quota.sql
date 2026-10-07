-- ===========================================================================
-- 0008 – FREE napi Tippverseny-kvóta: ATOMIKUS tippbeküldés
--
-- MIÉRT KELL ADATBÁZIS-FÜGGVÉNY?
-- A szerver PostgREST-en (supabase-js) ír, ahol nincs tranzakció, ezért a
-- „számold meg a mai tippeket, és csak akkor szúrj be, ha < limit" művelet
-- az alkalmazásból nem atomizálható. 2/3 állapotból két párhuzamos kérés
-- 4/3-ot eredményezne. A plpgsql függvénytörzs EGY implicit tranzakcióban
-- fut, így itt a feltétel és az írás nem választható szét.
--
-- MIT NEM TESZ EZ A MIGRÁCIÓ:
--   * nem hoz létre táblát,
--   * nem ad hozzá oszlopot, constraintet vagy indexet,
--   * nem módosít és nem töröl egyetlen adatsort sem,
--   * nem nyúl az RLS-hez,
--   * nem tartalmazza a „3" értéket és nem dönt FREE/PRO kérdésben –
--     a limitet és a napablakot a hívó szerver adja be, hogy az üzleti
--     szabály egyetlen helyen (src/shared/freeQuota.ts) maradjon, és az
--     adatbázis ne legyen második előfizetés-hatóság.
--
-- Újrafuttatható (create or replace), tehát idempotens.
-- ===========================================================================

create or replace function public.submit_competition_prediction(
  p_user_id     uuid,
  p_match_id    uuid,
  p_home        integer,
  p_away        integer,
  -- null = nincs napi limit (PRO). Egyébként a FREE csomag napi ÚJ tipp limitje.
  p_daily_limit integer,
  -- A budapesti nap félig nyitott intervalluma: [p_day_start, p_day_end)
  p_day_start   timestamptz,
  p_day_end     timestamptz
)
returns jsonb
language plpgsql
security invoker
-- Üres search_path: minden objektum teljes névvel szerepel (a pg_catalog implicit).
set search_path = ''
as $$
declare
  v_row   public.user_predictions;
  v_used  integer;
begin
  if p_user_id is null or p_match_id is null then
    raise exception 'A felhasználó és a mérkőzés azonosítója kötelező.' using errcode = '22023';
  end if;
  if p_day_start is null or p_day_end is null or p_day_end <= p_day_start then
    raise exception 'Érvénytelen napi időablak.' using errcode = '22023';
  end if;
  -- Ugyanaz a korlát, mint a tábla CHECK megszorításaiban – itt is ellenőrizzük,
  -- hogy a függvény önmagában se engedjen át érvénytelen gólszámot.
  if p_home is null or p_away is null
     or p_home < 0 or p_home > 99 or p_away < 0 or p_away > 99 then
    raise exception 'Érvénytelen tipp: a gólszám 0 és 99 közötti egész szám lehet.' using errcode = '22023';
  end if;

  -- ---------------------------------------------------------------------
  -- A VERSENYHELYZET KIZÁRÁSA
  -- Tranzakciós advisory lock a FELHASZNÁLÓRA. Ugyanazon user párhuzamos
  -- kérései sorba állnak (a második már látja az első commitolt beszúrását),
  -- különböző userek viszont nem blokkolják egymást. A lock a tranzakció
  -- végén automatikusan felszabadul, hiba esetén is.
  -- ---------------------------------------------------------------------
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- Van már tippje erre a mérkőzésre? (a unique constraint miatt legfeljebb egy)
  select * into v_row
    from public.user_predictions
   where user_id = p_user_id and competition_match_id = p_match_id;

  -- A mai ÚJ tippek száma: a létrehozás idejét a submitted_at őrzi
  select count(*)::integer into v_used
    from public.user_predictions
   where user_id = p_user_id
     and submitted_at >= p_day_start
     and submitted_at <  p_day_end;

  -- ---------------------------------------------------------------------
  -- 1) MÓDOSÍTÁS – nem fogyaszt napi kvótát
  --    A submitted_at (a létrehozás ideje) és a points SZÁNDÉKOSAN érintetlen:
  --    a kvótaszámítás és a pontozás alapja nem változhat módosításkor.
  --    Az updated_at-et a touch_user_predictions trigger írja.
  -- ---------------------------------------------------------------------
  if v_row.id is not null then
    update public.user_predictions
       set predicted_home_score = p_home,
           predicted_away_score = p_away
     where id = v_row.id
    returning * into v_row;

    return jsonb_build_object('outcome', 'updated', 'used', v_used, 'prediction', to_jsonb(v_row));
  end if;

  -- ---------------------------------------------------------------------
  -- 2) ÚJ TIPP, de a napi kvóta elfogyott – NEM írunk.
  --    Nem kivételt dobunk: a hívó így tudja felépíteni a 403-as választ
  --    a limit / used / remaining / resetAt értékekkel.
  -- ---------------------------------------------------------------------
  if p_daily_limit is not null and v_used >= p_daily_limit then
    return jsonb_build_object('outcome', 'limit_reached', 'used', v_used, 'prediction', null);
  end if;

  -- ---------------------------------------------------------------------
  -- 3) ÚJ TIPP létrehozása. A submitted_at a tábla default now() értékét kapja,
  --    ami a függvény tranzakciójának idejével a [p_day_start, p_day_end)
  --    ablakba esik, ezért a következő kérés már beleszámolja.
  -- ---------------------------------------------------------------------
  insert into public.user_predictions
    (competition_match_id, user_id, predicted_home_score, predicted_away_score)
  values
    (p_match_id, p_user_id, p_home, p_away)
  returning * into v_row;

  return jsonb_build_object('outcome', 'created', 'used', v_used + 1, 'prediction', to_jsonb(v_row));
end;
$$;

comment on function public.submit_competition_prediction(uuid, uuid, integer, integer, integer, timestamptz, timestamptz) is
  'Tippverseny-tipp atomikus létrehozása vagy módosítása napi kvótával. A kvóta user-szintű és versenyfüggetlen; a módosítás nem fogyaszt kvótát. A limitet és a napi időablakot a hívó szerver adja be (az üzleti szabály nem itt lakik). Csak a service_role hívhatja.';

-- ---------------------------------------------------------------------------
-- Jogosultság: a függvényt KIZÁRÓLAG a szerver (service_role) hívhatja.
-- Postgresben a függvényekre alapértelmezés szerint PUBLIC execute jog van,
-- ezért ezt kifejezetten visszavonjuk.
-- ---------------------------------------------------------------------------
revoke all on function public.submit_competition_prediction(uuid, uuid, integer, integer, integer, timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function public.submit_competition_prediction(uuid, uuid, integer, integer, integer, timestamptz, timestamptz)
  to service_role;
