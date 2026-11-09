-- ===========================================================================
-- 0025 – Email Center: marketing-hozzájárulás, leiratkozás, kampányok, küldési napló
--
-- MIT AD HOZZÁ:
--   * email_marketing_consents: a felhasználó JELENLEGI marketing-hozzájárulása (egy sor / fiók).
--     Sor nélkül NINCS hozzájárulás – a meglévő felhasználók így nem válnak automatikusan
--     hozzájárulóvá (ez a migráció egyetlen sort sem tölt fel).
--   * email_consent_events: a hozzájárulás minden változásának AUDITÁLHATÓ, csak hozzáfűzhető naplója
--     (mikor, milyen forrásból, melyik hozzájárulási szöveg-verzióval). Nem módosítható, nem törölhető.
--   * set_marketing_consent(): a változás és a napló EGY tranzakcióban; ha az állapot nem változik,
--     nem ír semmit (ismételt leiratkozás nem szemetel a naplóban). Ezen át hozzájárulást CSAK a profilban lehet adni.
--   * email_registration_consent trigger (auth.users, CSAK beszúráskor): a regisztrációs jelölőnégyzet hozzájárulását
--     a regisztrációval EGY tranzakcióban rögzíti, a hozzájárulás idejeként a Supabase által írt auth.users.created_at-tal
--     (a bejelölt négyzetet hozó regisztrációs kérés ideje – kliens-időbélyeget nem fogad el). A metaadat későbbi
--     módosítása (UPDATE) soha nem ad hozzájárulást, így visszadátumozás és leiratkozás felülírása sem lehetséges.
--   * email_recipients nézet: a címzettek KIZÁRÓLAG megerősített email-címmel (auth.users.email_confirmed_at) – idegen
--     címmel regisztrált, meg nem erősített fiók nem kaphat levelet. Csak a service_role olvashatja.
--   * email_campaigns / email_deliveries: kampányok és címzettenkénti küldési állapot. Egy kampányban
--     egy fiók (és egy e-mail-cím) legfeljebb egyszer szerepelhet → duplikált küldés kizárva.
--
-- MIT NEM TESZ: a profiles táblához, a Stripe-hoz és a meglévő táblákhoz nem nyúl; az auth.users-en csak egy
-- beszúrás utáni triggert vesz fel (mint a 0001), amely semmit nem módosít az auth-ban, és hibája nem akasztja
-- meg a regisztrációt.
--
-- JOGOK: RLS bekapcsolva, anon/authenticated semmit nem kap (a felhasználó a saját hozzájárulását
-- a szerver API-ján át kezeli); service_role: SELECT/INSERT/UPDATE (törlés nincs).
--
-- Újrafuttatható. Visszafordítás (a táblák tulajdonosaként):
--   drop trigger if exists on_auth_user_created_email_consent on auth.users;
--   drop function if exists public.email_registration_consent();
--   drop view if exists public.email_recipients;
--   drop function if exists public.set_marketing_consent(uuid, boolean, text, text);
--   drop table if exists public.email_deliveries, public.email_campaigns,
--     public.email_consent_events, public.email_marketing_consents;
--   drop function if exists public.email_consent_events_guard(), public.email_campaigns_guard();
-- ALKALMAZÁS: kézzel, a kód kiadása ELŐTT.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Marketing-hozzájárulás: jelenlegi állapot + csak hozzáfűzhető napló
-- ---------------------------------------------------------------------------
create table if not exists public.email_marketing_consents (
  user_id        uuid        primary key references auth.users (id) on delete cascade,
  consented      boolean     not null,
  -- az utolsó megadás ideje és forrása (visszavonás után is megmarad a nyomon követhetőséghez)
  consented_at   timestamptz,
  consent_source text,
  revoked_at     timestamptz,
  revoke_source  text,
  updated_at     timestamptz not null default now(),
  constraint email_marketing_consents_state check (not consented or (consented_at is not null and consent_source is not null))
);

create table if not exists public.email_consent_events (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  granted      boolean     not null,
  source       text        not null check (source in ('profile', 'registration', 'unsubscribe_link', 'one_click')),
  -- a felhasználónak megmutatott hozzájárulási szöveg verziója
  text_version text        not null check (char_length(text_version) between 1 and 32),
  created_at   timestamptz not null default now()
);
create index if not exists idx_email_consent_events_user on public.email_consent_events (user_id, created_at desc);

create or replace function public.email_consent_events_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'email_consent_events: a hozzájárulási napló nem módosítható és nem törölhető';
end;
$$;
drop trigger if exists email_consent_events_guard on public.email_consent_events;
create trigger email_consent_events_guard before update or delete on public.email_consent_events
  for each row execute function public.email_consent_events_guard();

-- a változás és a naplóbejegyzés egy tranzakcióban; változatlan állapotnál no-op
create or replace function public.set_marketing_consent(p_user uuid, p_granted boolean, p_source text, p_text_version text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  cur public.email_marketing_consents;
begin
  if p_user is null or p_granted is null or coalesce(p_source, '') = '' or coalesce(p_text_version, '') = '' then
    raise exception 'Hiányzó paraméter.' using errcode = '22023';
  end if;
  -- itt csak a profilban adható hozzájárulás (a regisztrációs a trigger útján, a regisztráció tranzakciójában);
  -- leiratkozó linkkel csak visszavonni lehet
  if p_granted and p_source <> 'profile' then
    raise exception 'Hozzájárulást csak a profilban lehet adni.' using errcode = '22023';
  end if;
  if p_source = 'registration' then
    raise exception 'A regisztrációs hozzájárulást csak a regisztráció rögzítheti.' using errcode = '22023';
  end if;
  select * into cur from public.email_marketing_consents where user_id = p_user for update;
  if coalesce(cur.consented, false) = p_granted then
    return jsonb_build_object('changed', false, 'state', to_jsonb(cur));
  end if;
  insert into public.email_consent_events (user_id, granted, source, text_version) values (p_user, p_granted, p_source, p_text_version);
  if p_granted then
    insert into public.email_marketing_consents as c (user_id, consented, consented_at, consent_source, revoked_at, revoke_source, updated_at)
    values (p_user, true, now(), p_source, null, null, now())
    on conflict (user_id) do update set consented = true, consented_at = now(), consent_source = p_source, updated_at = now()
    returning * into cur;
  else
    insert into public.email_marketing_consents as c (user_id, consented, revoked_at, revoke_source, updated_at)
    values (p_user, false, now(), p_source, now())
    on conflict (user_id) do update set consented = false, revoked_at = now(), revoke_source = p_source, updated_at = now()
    returning * into cur;
  end if;
  return jsonb_build_object('changed', true, 'state', to_jsonb(cur));
end;
$$;

-- ---------------------------------------------------------------------------
-- Regisztrációs hozzájárulás: a regisztrációval EGY tranzakcióban, a Supabase regisztrációs idejével
-- ---------------------------------------------------------------------------
create or replace function public.email_registration_consent()
returns trigger
language plpgsql
security definer          -- a triggernek joga van a hozzájárulási táblákba írni, a felhasználónak nem kell
set search_path = ''
as $$
declare
  v_version text := new.raw_user_meta_data ->> 'marketing_opt_in_version';
  v_at      timestamptz := coalesce(new.created_at, now());
begin
  -- KIZÁRÓLAG a bejelölt négyzet (JSON true) számít; minden más érték (hiány, false, 'true' szöveg) nem hozzájárulás
  if (new.raw_user_meta_data -> 'marketing_opt_in') is distinct from 'true'::jsonb then
    return new;
  end if;
  if v_version is null or v_version !~ '^v[0-9]{1,4}$' then v_version := 'v1'; end if;
  begin
    insert into public.email_consent_events (user_id, granted, source, text_version, created_at)
    values (new.id, true, 'registration', v_version, v_at);
    insert into public.email_marketing_consents (user_id, consented, consented_at, consent_source, updated_at)
    values (new.id, true, v_at, 'registration', v_at)
    on conflict (user_id) do nothing;
  exception when others then
    -- a hozzájárulás rögzítésének hibája nem akaszthatja meg a regisztrációt (a felhasználó a profilban feliratkozhat)
    raise warning 'email_registration_consent: a hozzájárulás nem rögzült (%): %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_email_consent on auth.users;
-- CSAK beszúráskor: a metaadat későbbi módosítása soha nem ad hozzájárulást
create trigger on_auth_user_created_email_consent
  after insert on auth.users
  for each row execute function public.email_registration_consent();

-- ---------------------------------------------------------------------------
-- Címzettek: csak megerősített email-címmel (a szerver service_role-lal olvassa)
-- ---------------------------------------------------------------------------
create or replace view public.email_recipients as
  select p.id, p.email, p.subscription_status, p.subscription_end, (u.email_confirmed_at is not null) as email_confirmed
  from public.profiles p
  join auth.users u on u.id = p.id;

comment on view public.email_recipients is 'Email Center címzettjei: profil + az email-cím megerősítettsége. Csak a service_role olvashatja.';

-- ---------------------------------------------------------------------------
-- Kampányok és címzettenkénti küldési állapot
-- ---------------------------------------------------------------------------
create table if not exists public.email_campaigns (
  id              uuid        primary key default gen_random_uuid(),
  kind            text        not null check (kind in ('marketing', 'system')),
  audience        text        not null check (audience in ('all', 'free', 'pro', 'marketing_consent')),
  subject         text        not null check (char_length(subject) between 1 and 200),
  html            text        not null check (char_length(html) between 1 and 200000),
  status          text        not null default 'draft' check (status in ('draft', 'sending', 'sent', 'partial', 'failed')),
  created_by      text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  confirmed_by    text,
  confirmed_at    timestamptz,
  finished_at     timestamptz,
  recipient_count integer     not null default 0,
  sent_count      integer     not null default 0,
  failed_count    integer     not null default 0,
  skipped_count   integer     not null default 0,
  -- rendszerüzenetnél az admin kifejezett nyilatkozata, hogy szolgáltatási / biztonsági célú
  system_attested boolean     not null default false,
  -- rendszerüzenet nem célozhatja a marketing-hozzájárulókat (az marketing lenne)
  constraint email_campaigns_system_audience check (kind = 'marketing' or audience <> 'marketing_consent'),
  constraint email_campaigns_system_attested check (kind = 'marketing' or status = 'draft' or system_attested)
);
create index if not exists idx_email_campaigns_created on public.email_campaigns (created_at desc);

-- elküldés után a tartalom és a célzás nem írható át
create or replace function public.email_campaigns_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'email_campaigns: a kampányok nem törölhetők'; end if;
  if old.status <> 'draft' and (new.kind is distinct from old.kind or new.audience is distinct from old.audience
     or new.subject is distinct from old.subject or new.html is distinct from old.html or new.created_by is distinct from old.created_by) then
    raise exception 'email_campaigns: elküldött kampány tartalma nem módosítható';
  end if;
  if old.status <> 'draft' and new.status = 'draft' then
    raise exception 'email_campaigns: elküldött kampány nem állítható vissza piszkozatra';
  end if;
  return new;
end;
$$;
drop trigger if exists email_campaigns_guard on public.email_campaigns;
create trigger email_campaigns_guard before update or delete on public.email_campaigns
  for each row execute function public.email_campaigns_guard();

create table if not exists public.email_deliveries (
  id                  uuid        primary key default gen_random_uuid(),
  campaign_id         uuid        not null references public.email_campaigns (id),
  user_id             uuid        not null,
  email               text        not null,
  status              text        not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts            integer     not null default 0,
  last_error          text        check (last_error is null or char_length(last_error) <= 500),
  provider_message_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  sent_at             timestamptz,
  -- egy kampányban egy fiók és egy cím legfeljebb egyszer → nincs duplikált email
  constraint email_deliveries_once unique (campaign_id, user_id)
);
create unique index if not exists uq_email_deliveries_campaign_email on public.email_deliveries (campaign_id, lower(email));
create index if not exists idx_email_deliveries_campaign_status on public.email_deliveries (campaign_id, status);

-- ---------------------------------------------------------------------------
-- Jogok
-- ---------------------------------------------------------------------------
alter table public.email_marketing_consents enable row level security;
alter table public.email_consent_events enable row level security;
alter table public.email_campaigns enable row level security;
alter table public.email_deliveries enable row level security;
revoke all on public.email_marketing_consents, public.email_consent_events, public.email_campaigns, public.email_deliveries from anon, authenticated;
revoke all on function public.set_marketing_consent(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.email_registration_consent() from public, anon, authenticated;
revoke all on public.email_recipients from public, anon, authenticated;
revoke all on function public.email_consent_events_guard(), public.email_campaigns_guard() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke delete, truncate, references, trigger on public.email_marketing_consents, public.email_consent_events, public.email_campaigns, public.email_deliveries from service_role;
    grant select, insert, update on public.email_marketing_consents, public.email_campaigns, public.email_deliveries to service_role;
    -- a napló csak hozzáfűzhető (az őr-trigger tiltja a módosítást és a törlést); a set_marketing_consent() tölti
    grant select, insert on public.email_consent_events to service_role;
    grant execute on function public.set_marketing_consent(uuid, boolean, text, text) to service_role;
    revoke all on public.email_recipients from service_role;
    grant select on public.email_recipients to service_role;
  end if;
end $$;
