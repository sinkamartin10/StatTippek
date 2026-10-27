-- ===========================================================================
-- 0024 – Ingyenes, 3 napos PRO próbaidőszak (admin-jóváhagyással)
--
-- MIT AD HOZZÁ:
--   * pro_trial_requests: a felhasználók próbaidőszak-igénylései. Fiókonként
--     ÖSSZESEN legfeljebb EGY igénylés lehet, állapottól függetlenül (unique user_id):
--     elutasítás vagy lejárat után sem igényelhető újra.
--   * approve_pro_trial_request(): az admin jóváhagyása EGY tranzakcióban –
--     az igénylés lezárása és a PRO aktiválása pontosan 3 napra (most + 72 óra).
--
-- A PRO-AKTIVÁLÁS UGYANAZ A MECHANIZMUS, mint a 0020 kézi befizetésnél: a szerver
-- service_role-lal írja a profiles két előfizetési mezőjét (subscription_status,
-- subscription_end). A jogosultság-ellenőrzés (profileIsPro / is_pro) változatlan:
-- status = 'pro' és a lejárat a jövőben → a lejárat után a fiók magától FREE,
-- ütemező nélkül.
--
-- MIT NEM TESZ:
--   * a profiles tábla szerkezetéhez, RLS-éhez, triggereihez nem nyúl,
--   * a Stripe-mezőket nem írja, Stripe-terhelést nem indít,
--   * a 0001–0023 migrációkhoz és a meglévő adatsorokhoz nem nyúl.
--
-- VÉDELMEK:
--   * a próbaidőszak nem írja felül és nem hosszabbítja a meglévő PRO-t:
--     már PRO fióknál already_pro (a profil és az igénylés változatlan),
--     élő / elmaradt Stripe-előfizetésnél stripe_conflict,
--   * a döntés végleges (trigger): lezárt igénylés nem módosítható, igénylés
--     nem törölhető, a kérelmező utólag nem írható át,
--   * a jóváhagyás FOR UPDATE zárral fut → ugyanaz az igénylés nem dolgozható fel kétszer.
--
-- JOGOK: RLS bekapcsolva, anon/authenticated semmit nem kap (a felhasználó csak a
-- szerver API-ján át igényelhet, a státuszt nem írhatja); service_role: SELECT/INSERT/UPDATE.
--
-- Újrafuttatható. Visszafordítás (a tábla tulajdonosaként):
--   drop function if exists public.approve_pro_trial_request(uuid, text);
--   drop table if exists public.pro_trial_requests;
--   drop function if exists public.pro_trial_requests_guard();
-- ALKALMAZÁS: kézzel, a kód kiadása ELŐTT.
-- ===========================================================================

create table if not exists public.pro_trial_requests (
  id          uuid        primary key default gen_random_uuid(),
  -- fiókonként EGYETLEN igénylés, örökre (párhuzamos igénylésnél is csak egy sor jöhet létre)
  user_id     uuid        not null unique references auth.users (id) on delete cascade,
  -- az igénylés idején a fiók e-mail-címe (a szerver írja a hitelesített tokenből)
  email       text        not null,
  status      text        not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text,
  -- jóváhagyáskor: a próbaidőszak kezdete és vége (vége = kezdete + 72 óra)
  trial_start timestamptz,
  trial_end   timestamptz,
  constraint pro_trial_requests_decision check (
    (status = 'pending' and decided_at is null and decided_by is null and trial_start is null and trial_end is null)
    or (status = 'rejected' and decided_at is not null and decided_by is not null and trial_start is null and trial_end is null)
    or (status = 'approved' and decided_at is not null and decided_by is not null
        and trial_start is not null and trial_end = trial_start + interval '72 hours'))
);

comment on table public.pro_trial_requests is 'Ingyenes 3 napos PRO próbaidőszak igénylései – fiókonként egy. Az igénylés NEM aktivál PRO-t; azt kizárólag az admin jóváhagyása (approve_pro_trial_request) teszi.';

create index if not exists idx_pro_trial_requests_status_created
  on public.pro_trial_requests (status, created_at desc);

-- Őr: a lezárt igénylés végleges; a kérelmező adatai nem írhatók át
create or replace function public.pro_trial_requests_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pro_trial_requests: az igénylések nem törölhetők';
  end if;
  if old.status <> 'pending' then
    raise exception 'pro_trial_requests: a lezárt igénylés nem módosítható';
  end if;
  if new.user_id is distinct from old.user_id or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at then
    raise exception 'pro_trial_requests: az igénylés adatai nem módosíthatók';
  end if;
  return new;
end;
$$;

drop trigger if exists pro_trial_requests_guard on public.pro_trial_requests;
create trigger pro_trial_requests_guard
  before update or delete on public.pro_trial_requests
  for each row execute function public.pro_trial_requests_guard();

-- ---------------------------------------------------------------------------
-- Jóváhagyás + 3 napos PRO-aktiválás EGY tranzakcióban
-- ---------------------------------------------------------------------------
create or replace function public.approve_pro_trial_request(p_request_id uuid, p_admin text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r       public.pro_trial_requests;
  p       public.profiles;
  v_start timestamptz := now();
  -- pontosan 72 óra: az 'interval 3 days' a munkamenet időzónájától függően nyáriidő-váltáskor 71/73 óra lenne
  v_end   timestamptz := now() + interval '72 hours';
begin
  if p_request_id is null or coalesce(p_admin, '') = '' then
    raise exception 'Az igénylés és az admin azonosítója kötelező.' using errcode = '22023';
  end if;

  -- az igénylés zárolása: párhuzamos jóváhagyás/elutasítás sorba áll, a második már lezártnak látja
  select * into r from public.pro_trial_requests where id = p_request_id for update;
  if r.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('outcome', 'already_processed', 'request', to_jsonb(r));
  end if;

  select * into p from public.profiles where id = r.user_id for update;
  if p.id is null then
    return jsonb_build_object('outcome', 'profile_missing', 'request', to_jsonb(r));
  end if;

  -- Stripe által kezelt előfizetés (élő vagy elmaradt fizetésű): a próbaidőszak nem írhatja felül
  if p.stripe_subscription_id is not null
     and (p.subscription_status = 'past_due'
          or (p.subscription_status = 'pro' and (p.subscription_end is null or p.subscription_end > now()))) then
    return jsonb_build_object('outcome', 'stripe_conflict', 'request', to_jsonb(r));
  end if;

  -- már PRO (fizetős vagy korlátlan): a próbaidőszak nem hosszabbít és nem rövidít – semmi nem változik
  if p.subscription_status = 'pro' and (p.subscription_end is null or p.subscription_end > now()) then
    return jsonb_build_object('outcome', 'already_pro', 'request', to_jsonb(r));
  end if;

  update public.profiles
     set subscription_status = 'pro', subscription_end = v_end
   where id = r.user_id;

  update public.pro_trial_requests
     set status = 'approved', decided_at = v_start, decided_by = p_admin, trial_start = v_start, trial_end = v_end
   where id = r.id
  returning * into r;

  return jsonb_build_object('outcome', 'approved', 'request', to_jsonb(r));
end;
$$;

comment on function public.approve_pro_trial_request(uuid, text) is
  'Ingyenes PRO próbaidőszak jóváhagyása: az igénylés lezárása és a PRO aktiválása pontosan 3 napra, egy tranzakcióban; lezárt igénylésre already_processed, már PRO fiókra already_pro, Stripe-előfizetésre stripe_conflict. Csak a service_role hívhatja.';

-- ---------------------------------------------------------------------------
-- Jogok
-- ---------------------------------------------------------------------------
alter table public.pro_trial_requests enable row level security;
revoke all on public.pro_trial_requests from anon, authenticated;
revoke all on function public.pro_trial_requests_guard() from public, anon, authenticated;
revoke all on function public.approve_pro_trial_request(uuid, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke delete, truncate, references, trigger on public.pro_trial_requests from service_role;
    grant select, insert, update on public.pro_trial_requests to service_role;
    grant execute on function public.approve_pro_trial_request(uuid, text) to service_role;
  end if;
end $$;
