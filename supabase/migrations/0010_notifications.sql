-- ===========================================================================
-- 0010 – In-app értesítések (Activity Center)
--
-- V1: kizárólag PULL-alapú, alkalmazáson belüli értesítés. Nincs e-mail, nincs
-- push, nincs websocket, nincs ütemező és nincs háttérfeladat – az értesítés
-- akkor jelenik meg, amikor a kliens lekérdezi.
--
-- ÁLTALÁNOS, NEM BATTLE-SPECIFIKUS:
-- A `type` szándékosan rövid szöveg, nem enum: a típus-katalógus a kódban lakik
-- (src/shared/notifications.ts), ahogy a küldetéseknél és az achievementeknél.
-- Így új értesítés-típus felvétele NEM igényel migrációt.
--
-- IDEMPOTENCIA:
-- A `(user_id, source_key)` pár EGYEDI. Ugyanaz az esemény ugyanannak a
-- felhasználónak csak egyszer jelenhet meg, akárhányszor próbáljuk beszúrni
-- (`insert ... on conflict do nothing`). Ez a `progression_events_unique_source`
-- bevált mintája. Erre épül a lusta újraszármaztatás is: a lista-végpont
-- újrapróbálja a hiányzó értesítéseket, duplikáció veszélye nélkül.
--
-- MIT NEM TESZ EZ A MIGRÁCIÓ:
--   * egyetlen meglévő táblát, oszlopot, constraintet, indexet vagy policy-t
--     sem módosít és nem töröl,
--   * egyetlen meglévő adatsort sem ír,
--   * nem nyúl a 0001–0009 migrációk semmijéhez,
--   * nem hoz létre függvényt, és nem kér advisory lockot (minden írás egyetlen
--     sorra irányul, az egyedi index dönt),
--   * nem érinti a Stripe-ot, a progressiont, a küldetéseket és a Tippversenyt.
--
-- Újrafuttatható: minden utasítás `if not exists` / `or replace` / `drop …; create`.
-- ===========================================================================

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- A típus katalógusa a kódban van; itt csak a hossz ellenőrzött.
  type        text not null check (char_length(type) between 2 and 64),
  title       text not null check (char_length(title) between 1 and 200),
  body        text check (body is null or char_length(body) <= 500),
  -- Mire mutat a kattintás. Külön oszlop (nem a metadata-ban), mert a felület
  -- MINDEN soron ebből épít linket, típusonkénti ágazás nélkül.
  -- SZÁNDÉKOSAN NINCS idegen kulcs: az értesítés túlélheti a hivatkozott
  -- entitást, és az általánosíthatóságot egy FK elvágná.
  entity_type text check (entity_type is null or char_length(entity_type) between 2 and 32),
  entity_id   uuid,
  -- IDEMPOTENCIA-KULCS (pl. 'battle:<id>:settled')
  source_key  text not null check (char_length(source_key) between 3 and 200),
  -- A megjelenítéshez szükséges, de nem kereshető extrák (pl. ellenfél neve,
  -- pontszámok) – így a lista EGYETLEN lekérdezésből kirajzolható.
  metadata    jsonb not null default '{}'::jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint notifications_unique_source unique (user_id, source_key)
);

comment on table public.notifications is 'In-app értesítések. Pull-alapú: nincs e-mail, push, websocket vagy ütemező. A (user_id, source_key) egyediség biztosítja, hogy ugyanaz az esemény csak egyszer jelenjen meg. Írni csak a szerver tud (service_role).';
comment on column public.notifications.type is 'Értesítés-típus. A katalógus a kódban van: src/shared/notifications.ts – új típus nem igényel migrációt.';
comment on column public.notifications.source_key is 'Idempotencia-kulcs, pl. "battle:<battleId>:settled". A lezárás kulcsa kimenet-független, ezért utólagos eredmény-korrekció sem hozhat létre ellentmondó második értesítést.';
comment on column public.notifications.entity_id is 'A hivatkozott entitás azonosítója a kattintás-célhoz. Szándékosan FK nélkül.';

-- A lista mindig user + idő szerint csökkenő sorrendben kérdez (cursor-lapozás)
create index if not exists idx_notifications_user
  on public.notifications (user_id, created_at desc);

-- Az olvasatlanok számlálása a jelvényhez – részleges index, hogy csak a
-- releváns sorokat tartalmazza
create index if not exists idx_notifications_unread
  on public.notifications (user_id, created_at desc)
  where read_at is null;

-- Az újraszármaztatás a meglévő forráskulcsokat kérdezi le kötegelten
create index if not exists idx_notifications_source
  on public.notifications (user_id, source_key);

-- ---------------------------------------------------------------------------
-- Tulajdonos-védelem: a user_id utólag nem írható át.
-- A 0003/0004-ben létrehozott függvénnyel azonos; itt is definiáljuk, hogy ez
-- a migráció önmagában is futtatható legyen. A törzs bitre ugyanaz.
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

drop trigger if exists protect_notifications_owner on public.notifications;
create trigger protect_notifications_owner before update on public.notifications
  for each row execute function public.protect_owner_column();

-- ---------------------------------------------------------------------------
-- Row Level Security
--    SELECT: a felhasználó KIZÁRÓLAG a saját értesítéseit látja.
--    INSERT/UPDATE/DELETE: nincs policy az authenticated szerepkörnek – írni
--            (és olvasottra állítani) kizárólag a hitelesített szerver API-n
--            keresztül, service_role-lal lehet. Így a kliens nem tudja sem
--            idegen értesítést olvasni, sem a sajátját meghamisítani.
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;

drop policy if exists "notifications: saját értesítések olvasása" on public.notifications;
create policy "notifications: saját értesítések olvasása"
  on public.notifications for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Jogosultságok: az API szerepkörök csak olvasást kapnak (az RLS tovább szűr)
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
