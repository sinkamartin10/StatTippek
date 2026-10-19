-- ===========================================================================
-- 0022 – Heti PRO (7 nap) a kézi fizetéshez (banki átutalás / Revolut)
--
-- MIT VÁLTOZTAT:
--   * pro_payment_requests.billing_interval: a 'week' érték is megengedett
--     (eddig: 'month' | 'year'). A meglévő sorokhoz nem nyúl.
--   * approve_pro_payment_request(): a heti kérelem jóváhagyása 7 napot (pontosan 168 órát) ad. Minden más
--     szabály VÁLTOZATLAN (ugyanaz a függvénytest, mint a 0020-ban):
--       - zárolt (FOR UPDATE) feldolgozás → ugyanaz a kérelem nem hagyható jóvá kétszer,
--       - élő Stripe-előfizetésre stripe_conflict, a profil érintetlen,
--       - korlátlan PRO nem rövidül; érvényes PRO a lejárattól hosszabbodik, különben mától,
--       - havi: naptári 1 hónap; éves: 1 év.
--
-- MIT NEM TESZ: a 0020-at nem írja át; a táblát, az őr-triggert, az indexeket, a jogokat,
-- a profiles táblát és a Stripe-mezőket nem módosítja; adatsort nem változtat.
--
-- Újrafuttatható. ALKALMAZÁS: kézzel, a heti csomagot kínáló kód kiadása ELŐTT (nélküle a
-- szerver a heti igénylésre 503 PLAN_UNAVAILABLE-t ad; a havi csomag változatlanul működik).
-- Visszafordítás: a 0022 NEM fordítható vissza biztonságosan pusztán a 0020 újrafuttatásával – a 0020
-- `create table if not exists`-e a billing_interval megszorítást nem állítja vissza ('week' engedélyezett
-- marad), a függvényből viszont eltűnik a heti ág, így egy heti kérelem jóváhagyása 1 hónapot adna.
-- Visszaállítás előtt ellenőrizni kell, hogy a public.pro_payment_requests táblában nincs 'week' értékű
-- sor. A billing_interval megszorítást és az approve_pro_payment_request függvényt ÖSSZEHANGOLTAN, egy
-- tranzakcióban kell visszaállítani. A heti csomagot kezelő alkalmazáskód nem adható ki olyan sémára,
-- amely a heti időtartamot nem támogatja. A pontos SQL-lépéseket külön, ellenőrzött rollback-terv rögzíti.
-- ===========================================================================

alter table public.pro_payment_requests drop constraint if exists pro_payment_requests_billing_interval_check;
alter table public.pro_payment_requests add constraint pro_payment_requests_billing_interval_check
  check (billing_interval in ('week', 'month', 'year'));

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
    v_end := v_base + case r.billing_interval
                        when 'year' then interval '1 year'
                        -- heti: pontosan 7 × 24 óra – a session időzónájától független (az '7 days'
                        -- nyári/téli időszámítás-váltáskor 167/169 órát adna a session TimeZone szerint)
                        when 'week' then interval '168 hours'
                        else interval '1 month' end;
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
  'Kézi PRO-befizetés jóváhagyása: a kérelem lezárása és a PRO aktiválása/meghosszabbítása egy tranzakcióban (heti: 7 nap = 168 óra, havi: 1 hónap, éves: 1 év); lezárt kérelemre already_processed, élő Stripe-előfizetésre stripe_conflict. Csak a service_role hívhatja.';

-- Jogok (a create or replace megőrzi őket; a biztonság kedvéért megismételve)
revoke all on function public.approve_pro_payment_request(uuid, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.approve_pro_payment_request(uuid, text) to service_role;
  end if;
end $$;
