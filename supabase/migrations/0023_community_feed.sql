-- ===========================================================================
-- 0023 – Közösségi Feed (MVP): szöveges bejegyzések és lájkok
--
-- MIÉRT KELL: a projektben nincs olyan tábla, amely felhasználói szöveges
-- bejegyzést vagy bejegyzésre adott reakciót tárolna. A követést (0013
-- `user_follows`) a Feed CSAK OLVASSA a „Követettek” nézethez – nem módosítja.
--
-- MIT NEM TESZ:
--   * egyetlen meglévő táblát, oszlopot, megszorítást, indexet, policy-t,
--     függvényt vagy triggert sem módosít és nem töröl,
--   * egyetlen meglévő adatsort sem ír át,
--   * nem ad XP-t, coint, kozmetikumot és nem befolyásol semmilyen pontozást.
--
-- BIZTONSÁG (a 0013 mintája szerint):
--   * RLS bekapcsolva, a kliens kulcsoknak (anon, authenticated) SEMMILYEN
--     joga nincs – se olvasás, se írás. Kizárólag a szerver éri el a
--     service_role kulccsal, és ott a szerző / lájkoló azonosítója MINDIG a
--     hitelesített tokenből jön, soha nem a kérés törzséből.
--   * Adatbázis-szintű garanciák: a lájk egyediségét az összetett elsődleges
--     kulcs, a szöveg hosszát CHECK, a szerző létezését idegen kulcs adja.
--     A saját bejegyzés törlése egyetlen, a szerzőre szűrt DELETE (a tulajdon
--     ellenőrzése és a törlés ugyanaz az atomi utasítás).
--
-- VISSZAFORDÍTHATÓ:
--   drop function if exists public.community_feed(uuid, boolean, timestamptz, uuid, integer);
--   drop function if exists public.community_post_stats(uuid[], uuid);
--   drop table if exists public.community_post_likes;
--   drop table if exists public.community_posts;
--
-- Újrafuttatható: `create … if not exists` / `create or replace`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Táblák
-- ---------------------------------------------------------------------------
create table if not exists public.community_posts (
  id             uuid        primary key default gen_random_uuid(),
  author_user_id uuid        not null references auth.users(id) on delete cascade,
  body           text        not null,
  created_at     timestamptz not null default now(),

  -- a szerver normalizál (trim, vezérlőkarakterek), ez a végső garancia
  constraint community_posts_body_len check (char_length(body) between 1 and 500 and body = btrim(body))
);

create table if not exists public.community_post_likes (
  post_id    uuid        not null references public.community_posts(id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),

  -- egy felhasználó egy bejegyzést csak EGYSZER lájkolhat
  constraint community_post_likes_pkey primary key (post_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 2) Indexek – a Feed (legújabb elöl, kulcsalapú lapozás) és a szerzőnkénti
--    lekérdezés („Követettek”, utolsó bejegyzés ideje) kiszolgálására
-- ---------------------------------------------------------------------------
create index if not exists idx_community_posts_created
  on public.community_posts (created_at desc, id desc);

create index if not exists idx_community_posts_author
  on public.community_posts (author_user_id, created_at desc, id desc);

-- a lájkoló szerinti keresés (fiók törlésekor a cascade is ezt használja)
create index if not exists idx_community_post_likes_user
  on public.community_post_likes (user_id);

-- ---------------------------------------------------------------------------
-- 3) RLS + jogosultságok – a kliens kulcs semmit nem olvashat és nem írhat
-- ---------------------------------------------------------------------------
alter table public.community_posts enable row level security;
alter table public.community_post_likes enable row level security;

revoke all on public.community_posts from anon, authenticated;
revoke all on public.community_post_likes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Feed-lekérdezés: legújabb elöl, (created_at, id) kulcsú lapozással.
--    `p_following_only`: csak a `p_viewer` által követett szerzők bejegyzései
--    (a 0013 `user_follows` táblájából, csak olvasva).
-- ---------------------------------------------------------------------------
create or replace function public.community_feed(
  p_viewer uuid,
  p_following_only boolean,
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
returns table (id uuid, author_user_id uuid, body text, created_at timestamptz)
language sql
stable
set search_path = public
as $$
  select p.id, p.author_user_id, p.body, p.created_at
  from public.community_posts p
  where (p_before_at is null or (p.created_at, p.id) < (p_before_at, p_before_id))
    and (not p_following_only or exists (
      select 1 from public.user_follows f
      where f.follower_user_id = p_viewer and f.followed_user_id = p.author_user_id
    ))
  order by p.created_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 51);
$$;

-- ---------------------------------------------------------------------------
-- 5) Lájk-összesítő egy lapnyi bejegyzésre: darabszám + a néző lájkolta-e
-- ---------------------------------------------------------------------------
create or replace function public.community_post_stats(p_post_ids uuid[], p_viewer uuid)
returns table (post_id uuid, like_count bigint, liked_by_viewer boolean)
language sql
stable
set search_path = public
as $$
  select l.post_id, count(*) as like_count, coalesce(bool_or(l.user_id = p_viewer), false) as liked_by_viewer
  from public.community_post_likes l
  where l.post_id = any(p_post_ids)
  group by l.post_id;
$$;

revoke all on function public.community_feed(uuid, boolean, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.community_post_stats(uuid[], uuid) from public, anon, authenticated;
grant execute on function public.community_feed(uuid, boolean, timestamptz, uuid, integer) to service_role;
grant execute on function public.community_post_stats(uuid[], uuid) to service_role;
