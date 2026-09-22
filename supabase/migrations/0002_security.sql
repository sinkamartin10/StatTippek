-- ============================================================================
-- Biztonsági javítás: is_pro() csak a SAJÁT állapotot adja vissza (paraméter nélkül),
-- hogy más felhasználó előfizetés-állapota ne legyen lekérdezhető.
-- Futtatás: Supabase SQL Editor
-- ============================================================================

drop function if exists public.is_pro(uuid);

create or replace function public.is_pro()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select subscription_status = 'pro' and (subscription_end is null or subscription_end > now())
       from public.profiles where id = auth.uid()),
    false);
$$;

revoke all on function public.is_pro() from public, anon;
grant execute on function public.is_pro() to authenticated;

-- Ellenőrzés: a profiles-on csak SELECT jog van az API szerepköröknek, írás nincs
revoke insert, update, delete on public.profiles from anon, authenticated;
