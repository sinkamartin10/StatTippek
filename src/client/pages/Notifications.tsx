/**
 * Értesítések oldal (`/ertesitesek`).
 *
 * Olvasatlanok előre, alattuk az olvasottak. Kattintás = olvasott, majd
 * navigálás a célra; kártyánkénti „megjelölöm olvasottként" gomb szándékosan
 * nincs. Az oldal tetején egy „Összes megjelölése olvasottként" gomb van.
 *
 * Lapozás cursorral (`before`), nem offsettel: a lista eleje folyamatosan nő,
 * offsettel a lapok elcsúsznának és duplikált sort adnának.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck } from 'lucide-react';
import type { NotificationRow } from '@shared/notifications';
import { iconOf, relativeTime, targetPath } from '@shared/notifications';
import { api } from '../lib/api';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';

export default function Notifications() {
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  const load = useCallback(() => {
    setLoading(true); setError(null);
    api.notifications()
      .then((r) => { setRows(r.notifications); setUnread(r.unreadCount); setNextBefore(r.nextBefore); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setMore(true);
    try {
      const r = await api.notifications({ before: nextBefore });
      setRows((cur) => [...cur, ...r.notifications]);
      setUnread(r.unreadCount);
      setNextBefore(r.nextBefore);
    } catch (e) { setError((e as Error).message); } finally { setMore(false); }
  };

  const markAll = async () => {
    setBusy(true);
    const at = new Date().toISOString();
    try {
      await api.markAllNotificationsRead();
      setRows((cur) => cur.map((n) => (n.readAt ? n : { ...n, readAt: at })));
      setUnread(0);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  /** Kattintás = olvasott, majd navigálás. A megjelölés hibája nem blokkolja a navigációt. */
  const activate = async (n: NotificationRow) => {
    if (!n.readAt) {
      setRows((cur) => cur.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnread((c) => Math.max(0, c - 1));
      try { await api.markNotificationRead(n.id); } catch { /* a navigáció ettől nem múlhat */ }
    }
    const to = targetPath(n);
    if (to) nav(to);
  };

  if (loading) return <Loading text="Értesítések betöltése…" />;
  if (error && !rows.length) return <ErrorBox message={error} onRetry={load} />;

  const unreadRows = rows.filter((n) => !n.readAt);
  const readRows = rows.filter((n) => n.readAt);

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🔔"
        title="Értesítések"
        text={unread > 0 ? `${unread} olvasatlan értesítésed van.` : 'Minden értesítésedet elolvastad.'}
        right={unread > 0 ? (
          <button className="btn btn-sm" onClick={markAll} disabled={busy}>
            <CheckCheck className="h-4 w-4" /> {busy ? 'Mentés…' : 'Összes megjelölése olvasottként'}
          </button>
        ) : undefined}
      />

      {error && <ErrorBox message={error} onRetry={load} />}

      {!rows.length ? (
        <EmptyState
          emoji="🔔"
          title="Még nincs értesítésed"
          text="Itt jelennek meg a Tippcsata eseményei: kihívások, elfogadások és a párbajok eredménye."
        />
      ) : (
        <>
          {unreadRows.length > 0 && (
            <Card title="Új értesítések" right={<span className="text-xs font-bold text-text-muted">{unreadRows.length}</span>}>
              <ul className="divide-y divide-border">
                {unreadRows.map((n) => <NotificationItem key={n.id} n={n} onActivate={activate} />)}
              </ul>
            </Card>
          )}

          {readRows.length > 0 && (
            <Card title="Korábbiak">
              <ul className="divide-y divide-border">
                {readRows.map((n) => <NotificationItem key={n.id} n={n} onActivate={activate} />)}
              </ul>
            </Card>
          )}

          {nextBefore && (
            <button className="btn w-full" onClick={loadMore} disabled={more}>
              {more ? 'Betöltés…' : 'További betöltése'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function NotificationItem({ n, onActivate }: { n: NotificationRow; onActivate: (n: NotificationRow) => void }) {
  const clickable = !!targetPath(n);
  return (
    <li>
      <button
        type="button"
        onClick={() => onActivate(n)}
        className={`flex w-full items-start gap-3 py-3 text-left transition first:pt-0 last:pb-0 ${clickable ? 'hover:opacity-80' : ''}`}
      >
        {/* Olvasatlan jelzés: bal oldali sáv + félkövér szöveg */}
        <span aria-hidden className={`mt-1 h-10 w-1 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-primary'}`} />
        <span aria-hidden className="mt-0.5 shrink-0 text-xl">{iconOf(n.type)}</span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm ${n.readAt ? 'font-semibold' : 'font-extrabold'}`}>{n.title}</span>
          {n.body && <span className="block text-xs font-semibold text-text-muted">{n.body}</span>}
          <span className="mt-0.5 block text-[11px] font-bold text-text-muted">
            {relativeTime(n.createdAt)}{n.readAt ? '' : ' · új'}
          </span>
        </span>
      </button>
    </li>
  );
}
