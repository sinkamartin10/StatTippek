-- ============================================================================
-- TIPPMIX AI – felhasználói profil + előfizetés adatszerkezet
-- Futtatás: Supabase Dashboard → SQL Editor → New query → beillesztés → Run
-- (vagy: supabase db push, ha a Supabase CLI-t használod)
-- ============================================================================

-- 1) profiles tábla – 1:1 az auth.users-szel
create table if not exists public.profiles (
  id                     uuid primary key references auth.users (id) on delete cascade,
  email                  text,
  subscription_status    text not null default 'free'
                         check (subscription_status in ('free', 'pro', 'past_due', 'canceled')),
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  subscription_end       timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table  public.profiles is 'Felhasználói profil és előfizetés-állapot (auth.users 1:1). Az előfizetési mezőket csak a szerver (service_role / Stripe webhook) módosíthatja.';
comment on column public.profiles.subscription_status is 'free | pro | past_due | canceled – csak szerveroldalról írható';

-- 2) Profil automatikus létrehozása regisztrációkor (auth.users insert trigger)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer          -- a triggernek joga van a profiles-ba írni, a felhasználónak nem kell
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- E-mail-változás követése (ha a felhasználó megváltoztatja az e-mail-címét)
create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email, updated_at = now() where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.handle_user_email_updated();

-- Már meglévő felhasználókhoz is legyen profil (a trigger csak az újakra fut)
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- 3) Row Level Security
alter table public.profiles enable row level security;

-- 4) Olvasás: mindenki csak a saját profilját
drop policy if exists "profiles: saját profil olvasása" on public.profiles;
create policy "profiles: saját profil olvasása"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

-- 5) Írás a frontendről: NINCS insert/update/delete policy az authenticated szerepkörnek,
--    így RLS mellett a felhasználó semmit sem módosíthat. Az előfizetési mezőket a szerver írja
--    (service_role – az RLS-t megkerüli), később a Stripe webhook.
--    Védőháló: ha valaha bekerülne egy update policy, ez a trigger akkor is megakadályozza,
--    hogy nem service_role szerepkör a védett mezőket módosítsa.
create or replace function public.protect_subscription_columns()
returns trigger
language plpgsql
as $$
declare
  jwt_role text := current_setting('request.jwt.claim.role', true);
begin
  -- Csak az API-n keresztül érkező felhasználói kéréseket (anon / authenticated) tiltjuk;
  -- a service_role, a SQL Editor (postgres) és a Stripe webhook szerveroldali írása átmegy.
  if jwt_role in ('anon', 'authenticated') or current_user in ('anon', 'authenticated') then
    if new.subscription_status    is distinct from old.subscription_status
    or new.stripe_customer_id     is distinct from old.stripe_customer_id
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.subscription_end       is distinct from old.subscription_end
    or new.id                     is distinct from old.id
    or new.created_at             is distinct from old.created_at then
      raise exception 'Az előfizetési mezők csak szerveroldalról módosíthatók';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_profile_subscription on public.profiles;
create trigger protect_profile_subscription
  before update on public.profiles
  for each row execute function public.protect_subscription_columns();

-- Jogosultságok: az API szerepkörök csak SELECT-et kapnak (a RLS tovább szűr a saját sorra)
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- 6) Segédfüggvény: aktív PRO-e a BEJELENTKEZETT felhasználó (paraméter nélkül – más felhasználó állapota nem kérdezhető le)
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
