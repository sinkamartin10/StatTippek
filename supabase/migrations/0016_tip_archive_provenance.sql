-- ===========================================================================
-- 0016 – Modell-tipp archívum: valószínűség-eredet (provenance)
--
-- MIÉRT KELL: a 0014 archívum `model_prob` oszlopa az alap motor
-- (xg-poisson-1) NYERS kimenete. Egy kalibrált modell kiszolgálásához azt is
-- rögzíteni kell, MILYEN valószínűséget kapott a felhasználó, és MELYIK
-- modell/kalibráció állította elő – különben a kiszolgált modell kiértékelése
-- és a tanító adat tisztasága nem garantálható.
--
-- JELENTÉS (a meglévő oszlopok jelentése NEM változik):
--   model_prob    – az alap motor nyers valószínűsége (mint eddig),
--   served_prob   – a felhasználónak ténylegesen kiszolgált valószínűség,
--   served_model  – a kiszolgáló modell: az alap motor verziója
--                   (pl. 'xg-poisson-1'), vagy '<alap>+cal-<12 hex>',
--   provenance    – 'recorded': a kiszolgált értéket a generáláskor rögzítettük;
--                   'legacy_baseline': a provenance-rögzítés előtti sor.
--
-- MEGLÉVŐ SOROK: 'legacy_baseline' jelölést kapnak, `served_prob` és
-- `served_model` NULL marad – kiszolgált értéket NEM találunk ki. A jelölést a
-- tárolt bizonyíték támasztja alá: a repository teljes története szerint a
-- kiszolgálási útban soha nem volt valószínűség-transzformáció (kalibráció),
-- és minden sor `engine_version`-je az alap motor. A `model_prob` értelmezése
-- ezért ezeknél a soroknál is „az alap motor nyers kimenete”.
-- Ugyanez az alapérték érvényes a migráció UTÁN, de a régi alkalmazás-
-- verzióval beszúrt sorokra is (azok sem rögzítik a kiszolgált értéket).
--
-- MIT NEM TESZ: meglévő értéket nem ír át; a 0001–0015 migrációkhoz nem nyúl;
-- a megváltoztathatatlansági őrt kibővíti az új oszlopokkal (a régi oszlopok
-- védelme változatlan); a nyilvános listázó nézeteket nem módosítja.
--
-- Újrafuttatható: `add column if not exists`, feltételesen hozzáadott
-- megszorítások, `create or replace`.
--
-- FIGYELEM – SORREND: a 0016 után a 0014-et NEM szabad újrafuttatni. A 0014
-- listázó nézetei (`a.*`) ütköznek az új oszlopokkal, és ha a 0014-et
-- utasításonként (nem egy tranzakcióban) futtatják, a hiba ELŐTT a 0014-es
-- őrfüggvényt is visszaírja – az új oszlopok védelme elveszne. Egy
-- tranzakcióban (Supabase SQL Editor, scripts/run-migration.ts) a hiba mindent
-- visszagörget. Ha mégis megtörtént: a 0016 újrafuttatása helyreállítja az őrt.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Új oszlopok – a meglévő sorok 'legacy_baseline' jelölést kapnak
--    (állandó alapérték: PG 11+ alatt nincs tábla-újraírás)
-- ---------------------------------------------------------------------------
alter table public.model_tip_archive add column if not exists provenance   text not null default 'legacy_baseline';
alter table public.model_tip_archive add column if not exists served_prob  double precision;
alter table public.model_tip_archive add column if not exists served_model text;

-- ---------------------------------------------------------------------------
-- 2) Megszorítások
--  * legacy sor: nincs (kitalált) kiszolgált érték,
--  * rögzített sor: van kiszolgált érték és modell, 0..1 közötti valószínűség,
--  * a kiszolgáló modell vagy maga az alap motor, vagy annak kalibrációja,
--  * ha az alap motor szolgált ki, a kiszolgált érték PONTOSAN a nyers érték.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'model_tip_archive_provenance') then
    alter table public.model_tip_archive add constraint model_tip_archive_provenance check (
      (provenance = 'legacy_baseline' and served_prob is null and served_model is null)
      or
      (provenance = 'recorded'
        and served_prob is not null and served_prob >= 0 and served_prob <= 1
        and served_model is not null
        and (served_model = engine_version
             or (left(served_model, char_length(engine_version) + 5) = engine_version || '+cal-'
                 and substr(served_model, char_length(engine_version) + 6) ~ '^[0-9a-f]{12}$'))
        and (served_model <> engine_version or served_prob = model_prob))
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Megváltoztathatatlanság – az új oszlopok is a védett tipp-mezők közé
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
      new.implied_prob, new.data_quality, new.sample_size, new.supporting_indicators, new.pre_kickoff,
      new.provenance, new.served_prob, new.served_model)
     is distinct from
     (old.id, old.match_id, old.market, old.version_no, old.content_hash, old.engine_version,
      old.generated_at, old.origin, old.match_label, old.league_id, old.league_name, old.kickoff,
      old.market_label, old.market_type, old.category, old.model_prob, old.odds_at_generation,
      old.implied_prob, old.data_quality, old.sample_size, old.supporting_indicators, old.pre_kickoff,
      old.provenance, old.served_prob, old.served_model)
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

revoke all on function public.model_tip_archive_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) A „statisztikába számító” nézet az új oszlopokkal
--    (`create or replace` csak a VÉGÉRE vehet fel oszlopot – a `*` most az új
--    oszlopokat a meglévők után hozza; a ráépülő counted_listing nézet
--    változatlan marad)
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
end $$;

revoke all on public.model_tip_archive_counted from anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select on public.model_tip_archive_counted to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5) A nézetek jogainak szűkítése (legszűkebb jogkör)
--
-- A Supabase alapértelmezett jogosztása minden új relációra – a 0014 nézeteire
-- is – ALL jogot ad a service_role-nak, és a 0014 csak a SELECT-et adta meg,
-- a többit nem vonta vissza. A nézetek (DISTINCT ON, illetve join) nem
-- frissíthetők, így írni rajtuk át nem lehet – de a szándékolt jogkör csak
-- SELECT. A nézet-definíciókhoz ez a szakasz nem nyúl.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke insert, update, delete, truncate, references, trigger
      on public.model_tip_archive_counted, public.model_tip_archive_listing, public.model_tip_archive_counted_listing
      from service_role;
  end if;
end $$;
