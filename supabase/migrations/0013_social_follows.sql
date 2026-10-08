-- ===========================================================================
-- 0013 – Követés (follow) a játékosok között
--
-- MIÉRT KELL: a „kedvenc játékos" mechanizmus. A projektben MA SEMMILYEN
-- social kapcsolat-tábla nincs, és a meglévő táblák egyike sem tudja
-- biztonságosan kifejezni egy felhasználó→felhasználó irányított kapcsolatát:
--   * `profiles`                → egy sor / felhasználó, nincs reláció,
--   * `user_profile_settings`   → a SAJÁT megjelenés, nem kapcsolat,
--   * `battles`                 → párbaj-életciklus, nem tartós kapcsolat.
-- Ezért kap a követés saját, minimális táblát.
--
-- MIT NEM TESZ:
--   * egyetlen meglévő táblát, oszlopot, megszorítást, indexet, policy-t vagy
--     triggert sem módosít és nem töröl,
--   * egyetlen meglévő adatsort sem ír át,
--   * nem nyúl a 0001–0012 migrációk semmijéhez,
--   * nem ad XP-t, coint, kozmetikumot és nem befolyásol semmilyen pontozást:
--     a követés tisztán social, versenyelőnyt nem ad.
--
-- ADATVÉDELEM: a tábla CSAK két azonosítót és egy időbélyeget tárol. A
-- követés ténye a nyilvános profil ÖSSZESÍTETT számlálóiban jelenik meg
-- (hány követő / hány követés); a kapcsolatok listáját kizárólag az érintett
-- felhasználó olvashatja.
--
-- VISSZAFORDÍTHATÓ: `drop table public.user_follows;` – más rendszer nem
-- hivatkozik rá, ezért a korábbi állapot pontosan visszaáll.
--
-- Újrafuttatható: `create … if not exists` + feltételesen létrehozott policy.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Tábla
--
-- Az összetett elsődleges kulcs EGYSZERRE adja az egyediséget (ugyanaz a pár
-- csak egyszer szerepelhet → nincs duplikált követés) és a követő szerinti
-- gyors keresést. Külön unique index ezért NEM kell.
--
-- A CHECK adatbázis-szinten zárja ki az önkövetést: a szerveroldali
-- ellenőrzés mellett ez a végső garancia.
--
-- `on delete cascade`: ha egy fiók megszűnik, a kapcsolatai is megszűnnek –
-- árva sor nem maradhat.
-- ---------------------------------------------------------------------------
create table if not exists public.user_follows (
  follower_user_id uuid        not null references auth.users(id) on delete cascade,
  followed_user_id uuid        not null references auth.users(id) on delete cascade,
  created_at       timestamptz not null default now(),

  constraint user_follows_pkey primary key (follower_user_id, followed_user_id),
  constraint user_follows_no_self check (follower_user_id <> followed_user_id)
);

-- ---------------------------------------------------------------------------
-- 2) Indexek
--
-- Az elsődleges kulcs lefedi a „kit követek" irányt, de a lista
-- LEGFRISSEBB ELŐL sorrendet nem – ezért kap mindkét irány egy
-- (azonosító, created_at desc) indexet. Több index nem kell: a tábla csak
-- ezen a két irányon kérdezhető le.
-- ---------------------------------------------------------------------------
create index if not exists idx_user_follows_follower
  on public.user_follows (follower_user_id, created_at desc);

create index if not exists idx_user_follows_followed
  on public.user_follows (followed_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) RLS – a 0009 / 0011 / 0012 mintája szerint
--
-- CSAK OLVASÁSI policy van, és az is csak a SAJÁT kapcsolatokra. INSERT /
-- UPDATE / DELETE policy SZÁNDÉKOSAN NINCS: így a kliens kulccsal (anon vagy
-- authenticated) semmilyen írás nem lehetséges. Írni kizárólag a szerver tud
-- a service_role kulccsal, amely megkerüli az RLS-t – a követő azonosítója
-- pedig ott MINDIG a hitelesített tokenből jön, soha nem a kérés törzséből.
-- ---------------------------------------------------------------------------
alter table public.user_follows enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_follows'
      and policyname = 'user_follows: saját kapcsolatok olvasása'
  ) then
    create policy "user_follows: saját kapcsolatok olvasása"
      on public.user_follows
      for select
      to authenticated
      using (follower_user_id = auth.uid() or followed_user_id = auth.uid());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Jogosultságok – a kliens kulcs semmit nem írhat
-- ---------------------------------------------------------------------------
revoke all on public.user_follows from anon, authenticated;
grant select on public.user_follows to authenticated;
