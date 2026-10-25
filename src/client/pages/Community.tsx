/**
 * Közösség – egyszerű Feed (MVP): szöveges bejegyzések és lájkok.
 *
 * Minden adat a SZERVERTŐL jön, kulcsalapú lapozással („Továbbiak betöltése”). A szerzőt, a
 * lájkolót és a törlés jogosultságát a szerver dönti el a hitelesített tokenből – a felület csak
 * megjeleníti a `mine` / `likedByMe` jelzőket. A szerző megjelenése UGYANAZ a `CosmeticProfile`,
 * mint a profilon és a social listákban.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Send, Trash2 } from 'lucide-react';
import type { AvatarSlot } from '@shared/progression';
import type { ShopEquips } from '@shared/shop';
import { POST_MAX_LENGTH, normalizePostBody, type FeedPost, type FeedView } from '@shared/community';
import { api, ApiError } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { usePlan } from '../auth/PlanContext';
import { CosmeticProfile } from '../components/CosmeticProfile';
import { Card, ChipGroup, EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Ismeretlen hiba.');

/** Egy bejegyzés kártyája. A lájk és a törlés a hívótól jön; a jogosultságot a szerver ellenőrzi. */
export function PostCard({ post, canLike, busy = false, onLike, onDelete }: {
  post: FeedPost;
  /** bejelentkezve lájkolhat */
  canLike: boolean;
  busy?: boolean;
  onLike?: (post: FeedPost) => void;
  onDelete?: (post: FeedPost) => void;
}) {
  const a = post.author;
  const profile = (
    <CosmeticProfile
      displayName={a.displayName ?? 'Ismeretlen játékos'}
      avatar={a.avatar as Partial<Record<AvatarSlot, string>>}
      borderKey={a.borderKey}
      titleKey={a.titleKey}
      shop={a.shop as Partial<ShopEquips> | undefined}
      size={40}
      variant="row"
      className="min-w-0"
    />
  );
  return (
    <article className="card p-4" aria-label={`${a.displayName ?? 'Ismeretlen játékos'} bejegyzése`}>
      <header className="flex items-start justify-between gap-3">
        {a.displayName
          ? <Link to={`/jatekos/${encodeURIComponent(a.displayName)}`} className="min-w-0 flex-1" aria-label={`${a.displayName} profilja`}>{profile}</Link>
          : <div className="min-w-0 flex-1">{profile}</div>}
        <time dateTime={post.createdAt} className="shrink-0 pt-1 text-xs font-semibold text-text-muted">{fmtDateTime(post.createdAt)}</time>
      </header>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm font-semibold leading-relaxed text-text">{post.body}</p>
      <footer className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
        <button
          type="button"
          className={`btn btn-sm ${post.likedByMe ? 'border-danger/30 bg-danger-soft text-danger' : ''}`}
          aria-pressed={post.likedByMe}
          aria-label={post.likedByMe ? 'Lájk visszavonása' : 'Lájkolás'}
          title={canLike ? undefined : 'A lájkoláshoz jelentkezz be'}
          disabled={!canLike || busy}
          onClick={() => onLike?.(post)}
        >
          <Heart className="h-4 w-4" fill={post.likedByMe ? 'currentColor' : 'none'} aria-hidden />
          <span className="mono">{post.likeCount}</span>
        </button>
        {post.mine && (
          <button type="button" className="btn btn-sm btn-ghost text-text-muted" disabled={busy} onClick={() => onDelete?.(post)}>
            <Trash2 className="h-4 w-4" aria-hidden /> Törlés
          </button>
        )}
      </footer>
    </article>
  );
}

/** Üres Feed – nézetenként más szöveg. */
export function FeedEmpty({ view }: { view: FeedView }) {
  return view === 'following'
    ? <EmptyState emoji="👥" title="Még nincs bejegyzés a követettjeidtől" text="Kövess játékosokat, és az ő bejegyzéseik itt jelennek meg." action={<Link to="/felfedezes" className="btn btn-sm">Játékosok keresése</Link>} />
    : <EmptyState emoji="💬" title="Még nincs bejegyzés" text="Légy te az első, aki megosztja a gondolatait!" />;
}

/** Új bejegyzés írása. A hosszt ugyanaz a szabály ellenőrzi, mint a szervert. */
function Composer({ onPosted }: { onPosted: (post: FeedPost) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const length = [...text.trim()].length;
  const valid = normalizePostBody(text) != null;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      onPosted(await api.createPost(text));
      setText('');
    } catch (e) {
      setError({ message: errorText(e), code: e instanceof ApiError ? e.code : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <label className="field-label" htmlFor="community-post">Új bejegyzés</label>
        <textarea
          id="community-post"
          className="input min-h-24 resize-y"
          placeholder="Oszd meg a gondolataidat vagy az előrejelzésedet…"
          value={text}
          maxLength={POST_MAX_LENGTH * 2}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={`mono text-xs font-bold ${length > POST_MAX_LENGTH ? 'text-danger' : 'text-text-muted'}`}>{length} / {POST_MAX_LENGTH}</span>
          <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
            <Send className="h-4 w-4" aria-hidden /> {busy ? 'Közzététel…' : 'Közzététel'}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error.message}
            {error.code === 'DISPLAY_NAME_REQUIRED' && <> <Link to="/profil" className="text-primary underline">Megjelenítési név beállítása</Link></>}
          </p>
        )}
      </form>
    </Card>
  );
}

export default function Community() {
  const { loggedIn, configured } = usePlan();
  // helyi (Supabase nélküli) futtatásban a szerver egy helyi felhasználóval dolgozik
  const canWrite = !configured || loggedIn;
  const [view, setView] = useState<FeedView>('all');
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const needsLogin = view === 'following' && !canWrite;

  useEffect(() => {
    if (needsLogin) { setPosts([]); setNextBefore(null); setLoading(false); setError(null); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    api.communityFeed(view).then(
      (r) => { if (alive) { setPosts(r.posts); setNextBefore(r.nextBefore); setLoading(false); } },
      (e) => { if (alive) { setError(errorText(e)); setLoading(false); } },
    );
    return () => { alive = false; };
  }, [view, needsLogin, tick]);

  const loadMore = async () => {
    if (!nextBefore || loading) return;
    setLoading(true);
    try {
      const r = await api.communityFeed(view, nextBefore);
      // ugyanaz a bejegyzés nem jelenhet meg kétszer (pl. ha közben új bejegyzés érkezett)
      setPosts((cur) => [...cur, ...r.posts.filter((p) => !cur.some((c) => c.id === p.id))]);
      setNextBefore(r.nextBefore);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleLike = async (post: FeedPost) => {
    setBusyId(post.id);
    setActionError(null);
    try {
      const r = post.likedByMe ? await api.unlikePost(post.id) : await api.likePost(post.id);
      setPosts((cur) => cur.map((p) => (p.id === post.id ? { ...p, likedByMe: r.liked, likeCount: r.likeCount } : p)));
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (post: FeedPost) => {
    if (!window.confirm('Biztosan törlöd ezt a bejegyzést? Ez nem vonható vissza.')) return;
    setBusyId(post.id);
    setActionError(null);
    try {
      await api.deletePost(post.id);
      setPosts((cur) => cur.filter((p) => p.id !== post.id));
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader emoji="💬" title="Közösség" text="Oszd meg a gondolataidat és az előrejelzéseidet, és reagálj mások bejegyzéseire." />

      {canWrite
        ? <Composer onPosted={(p) => { if (view === 'all') setPosts((cur) => [p, ...cur]); else setView('all'); }} />
        : (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-text-muted">Bejegyzés írásához és lájkoláshoz jelentkezz be.</p>
              <Link to="/bejelentkezes" state={{ from: '/kozosseg' }} className="btn btn-primary btn-sm">Bejelentkezés</Link>
            </div>
          </Card>
        )}

      <ChipGroup<FeedView>
        ariaLabel="Feed nézet"
        value={view}
        onChange={setView}
        options={[
          { value: 'all', label: 'Mindenki' },
          { value: 'following', label: 'Követettek' },
        ]}
      />

      {actionError && <ErrorBox message={actionError} />}

      {needsLogin ? (
        <EmptyState
          emoji="🔒"
          title="Jelentkezz be"
          text="A követett játékosaid bejegyzéseit bejelentkezés után látod."
          action={<Link to="/bejelentkezes" state={{ from: '/kozosseg' }} className="btn btn-primary">Bejelentkezés</Link>}
        />
      ) : error ? (
        <ErrorBox message={error} onRetry={() => setTick((t) => t + 1)} />
      ) : loading && posts.length === 0 ? (
        <Loading />
      ) : posts.length === 0 ? (
        <FeedEmpty view={view} />
      ) : (
        <div className="space-y-3">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} canLike={canWrite} busy={busyId === p.id} onLike={toggleLike} onDelete={remove} />
          ))}
          {nextBefore && (
            <div className="flex justify-center pt-2">
              <button type="button" className="btn" disabled={loading} onClick={loadMore}>{loading ? 'Betöltés…' : 'Továbbiak betöltése'}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
