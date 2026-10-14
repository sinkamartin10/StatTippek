-- ===========================================================================
-- 0020 – PRO előfizetés kézi fizetéssel (banki átutalás / Revolut)
--
-- MIT AD HOZZÁ:
--   * pro_payment_requests: a felhasználók „befizettem, kérem ellenőrizni”
--     jelzései. Egy felhasználónak egyszerre legfeljebb EGY függő kérelme lehet.
--   * approve_pro_payment_request(): az admin jóváhagyása EGY tranzakcióban –
--     a kérelem lezárása és a PRO aktiválása (profiles.subscription_status /
--     subscription_end) vagy együtt történik meg, vagy egyik sem.
--
-- A PRO-AKTIVÁLÁS UGYANAZ A MECHANIZMUS, mint eddig: a szerver service_role-lal
-- írja a profiles két előfizetési mezőjét (a 0001 protect_subscription_columns
-- triggere ezt engedi, a felhasználói szerepkörökét nem). A jogosultság-
-- ellenőrzés (profileIsPro / is_pro) változatlan: status = 'pro' és a lejárat a jövőben.
--
-- MIT NEM TESZ:
--   * a profiles tábla szerkezetéhez, RLS-éhez, triggereihez nem nyúl,
--   * a Stripe-mezőket (stripe_customer_id, stripe_subscription_id) nem írja,
--     a stripe_events táblát nem érinti, Stripe-terhelést nem indít,
--   * meglévő adatsort nem módosít; a 0001–0019 migrációkhoz nem nyúl.
--
-- VÉDELMEK:
--   * a döntés (approved/rejected) végleges: lezárt kérelem nem módosítható
--     (trigger), kérelem nem törölhető, a kérelmező/összeg utólag nem írható át,
--   * a jóváhagyás FOR UPDATE zárral fut → ugyanaz a kérelem nem dolgozható fel kétszer,
--   * aktív Stripe-előfizetésű fiókot a függvény nem aktivál kézzel (stripe_conflict):
--     előbb a Stripe-előfizetést kell rendezni, nehogy kétszer fizessen a felhasználó.
--
-- JOGOK: RLS bekapcsolva, anon/authenticated semmit nem kap (a felhasználó a
-- szerver API-ján át éri el a saját kérelmeit); service_role: SELECT/INSERT/UPDATE.
--
-- Újrafuttatható. Visszafordítás (a tábla tulajdonosaként):
--   drop function if exists public.approve_pro_payment_request(uuid, text);
--   drop table if exists public.pro_payment_requests;
--   drop function if exists public.pro_payment_requests_guard();
-- ALKALMAZÁS: kézzel, a kód kiadása ELŐTT.
-- ===========================================================================

create table if not exists public.pro_payment_requests (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users (id) on delete cascade,
  -- a kérelem idején a fiók e-mail-címe (a szerver írja a hitelesített tokenből)
  email            text        not null,
  method           text        not null check (method in ('bank_transfer', 'revolut')),
  plan             text        not null default 'pro' check (plan = 'pro'),
  -- az ÉRVÉNYES ár a kérelem idején (a szerver írja, nem a kliens)
  amount           numeric(12, 2) not null check (amount > 0),
  currency         text        not null check (currency ~ '^[A-Z]{3}$'),
  billing_interval text        not null check (billing_interval in ('month', 'year')),
  -- az utalás közleménye (a fiók e-mail-címe)
  reference        text        not null,
  status           text        not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       text,
  decision_note    text        check (decision_note is null or char_length(decision_note) <= 300),
  -- jóváhagyáskor: meddig szól a PRO (null: már korlátlan PRO volt, nem rövidítettük)
  activated_until  timestamptz,
  constraint pro_payment_requests_decision check (
    (status = 'pending' and decided_at is null and decided_by is null)
    or (status <> 'pending' and decided_at is not null and decided_by is not null))
);

comment on table public.pro_payment_requests is 'PRO előfizetés kézi fizetési kérelmei (banki átutalás / Revolut). A kérelem NEM aktivál PRO-t; azt kizárólag az admin jóváhagyása (approve_pro_payment_request) teszi.';

-- egyszerre legfeljebb EGY függő kérelem felhasználónként (dupla kattintás / ismételt küldés ellen)
create unique index if not exists uq_pro_payment_requests_one_pending
  on public.pro_payment_requests (user_id) where status = 'pending';
create index if not exists idx_pro_payment_requests_status_created
  on public.pro_payment_requests (status, created_at desc);
create index if not exists idx_pro_payment_requests_user
  on public.pro_payment_requests (user_id, created_at desc);

-- Őr: a lezárt kérelem végleges; a kérelem adatai (kérelmező, összeg, mód) nem írhatók át
create or replace function public.pro_payment_requests_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pro_payment_requests: a kérelmek nem törölhetők';
  end if;
  if old.status <> 'pending' then
    raise exception 'pro_payment_requests: a lezárt kérelem nem módosítható';
  end if;
  if new.user_id is distinct from old.user_id or new.email is distinct from old.email
     or new.method is distinct from old.method or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency or new.billing_interval is distinct from old.billing_interval
     or new.reference is distinct from old.reference or new.created_at is distinct from old.created_at
     or new.plan is distinct from old.plan then
    raise exception 'pro_payment_requests: a kérelem adatai nem módosíthatók';
  end if;
  return new;
end;
$$;

drop trigger if exists pro_payment_requests_guard on public.pro_payment_requests;
create trigger pro_payment_requests_guard
  before update or delete on public.pro_payment_requests
  for each row execute function public.pro_payment_requests_guard();

-- ---------------------------------------------------------------------------
-- Jóváhagyás + PRO-aktiválás EGY tranzakcióban
-- ---------------------------------------------------------------------------
create or replace function public.approve_pro_payment_request(p_request_id uuid, p_admin text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r      public.pro_payment_requests;
  p      public.profiles;
  v_base timestamptz;
  v_end  timestamptz;
begin
  if p_request_id is null or coalesce(p_admin, '') = '' then
    raise exception 'A kérelem és az admin azonosítója kötelező.' using errcode = '22023';
  end if;

  -- a kérelem zárolása: párhuzamos jóváhagyás/elutasítás sorba áll, a második már lezártnak látja
  select * into r from public.pro_payment_requests where id = p_request_id for update;
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

  -- Stripe által kezelt, élő előfizetés: kézzel NEM írjuk felül (a Stripe tovább terhelne / felülírná)
  if p.stripe_subscription_id is not null
     and (p.subscription_status = 'past_due'
          or (p.subscription_status = 'pro' and (p.subscription_end is null or p.subscription_end > now()))) then
    return jsonb_build_object('outcome', 'stripe_conflict', 'request', to_jsonb(r));
  end if;

  if p.subscription_status = 'pro' and p.subscription_end is null then
    -- már korlátlan PRO: nem rövidítjük le; a kérelem lezárul, a profil változatlan
    v_end := null;
  else
    -- meglévő, még érvényes PRO meghosszabbítása a lejárattól; különben mától
    v_base := case when p.subscription_status = 'pro' and p.subscription_end > now() then p.subscription_end else now() end;
    v_end := v_base + case r.billing_interval when 'year' then interval '1 year' else interval '1 month' end;
    update public.profiles
       set subscription_status = 'pro', subscription_end = v_end
     where id = r.user_id;
  end if;

  update public.pro_payment_requests
     set status = 'approved', decided_at = now(), decided_by = p_admin, activated_until = v_end
   where id = r.id
  returning * into r;

  return jsonb_build_object('outcome', 'approved', 'request', to_jsonb(r));
end;
$$;

comment on function public.approve_pro_payment_request(uuid, text) is
  'Kézi PRO-befizetés jóváhagyása: a kérelem lezárása és a PRO aktiválása/meghosszabbítása egy tranzakcióban; lezárt kérelemre already_processed, élő Stripe-előfizetésre stripe_conflict. Csak a service_role hívhatja.';

-- ---------------------------------------------------------------------------
-- Jogok
-- ---------------------------------------------------------------------------
alter table public.pro_payment_requests enable row level security;
revoke all on public.pro_payment_requests from anon, authenticated;
revoke all on function public.pro_payment_requests_guard() from public, anon, authenticated;
revoke all on function public.approve_pro_payment_request(uuid, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke delete, truncate, references, trigger on public.pro_payment_requests from service_role;
    grant select, insert, update on public.pro_payment_requests to service_role;
    grant execute on function public.approve_pro_payment_request(uuid, text) to service_role;
  end if;
end $$;
