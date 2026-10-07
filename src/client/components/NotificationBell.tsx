/**
 * Értesítés-csengő a fejlécben: jelvény + legördülő.
 *
 * Egyetlen `GET /api/notifications` szolgálja ki a jelvényt és a legördülőt is
 * (a válasz tartalmazza az `unreadCount`-ot), ezért nincs külön count-kérés.
 * Ez váltotta fel a Phase 4-es, battle-specifikus jelvényt.
 *
 * Kattintás = olvasott: a szerverre megy a megjelölés, és utána navigálunk a
 * célra. Külön „megjelölöm olvasottként" gomb a kártyákon szándékosan nincs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import type { NotificationRow } from '@shared/notifications';
import { NOTIFICATION_PREVIEW_LIMIT, badgeLabel, iconOf, relativeTime, targetPath } from '@shared/notifications';
import { api } from '../lib/api';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const load = useCallback(() => {
    setLoading(true); setError(false);
    api.notifications({ limit: NOTIFICATION_PREVIEW_LIMIT })
      .then((r) => { setRows(r.notifications); setUnread(r.unreadCount); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Kívülre kattintás / Escape zárja – a „Továbbiak" legördülő mintája
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const openPanel = () => { setOpen((v) => !v); if (!open) load(); };

  /** Kattintás = olvasott, utána navigálás. A megjelölés hibája nem blokkolja a navigációt. */
  const activate = async (n: NotificationRow) => {
    setOpen(false);
    if (!n.readAt) {
      setRows((cur) => cur.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnread((c) => Math.max(0, c - 1));
      try { await api.markNotificationRead(n.id); } catch { /* a navigáció ettől nem múlhat */ }
    }
    const to = targetPath(n);
    if (to) nav(to);
  };

  const badge = badgeLabel(unread);

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        className="nav-link relative"
        aria-label={unread > 0 ? `Értesítések – ${unread} olvasatlan` : 'Értesítések'}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={openPanel}
      >
        <Bell className="h-4 w-4" />
        {badge && (
          <span className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-primary px-1 text-center text-[10px] font-extrabold leading-[1.1rem] text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-2 w-80 overflow-hidden rounded-2xl border border-border bg-card shadow-lift">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs font-extrabold uppercase tracking-wide text-text-muted">Értesítések</span>
            {unread > 0 && <span className="badge badge-blue">{unread} új</span>}
          </div>

          {loading ? (
            <p className="px-4 py-6 text-center text-sm font-semibold text-text-muted">Betöltés…</p>
          ) : error ? (
            <div className="px-4 py-5 text-center">
              <p className="text-sm font-semibold text-text-muted">Az értesítések nem tölthetők be.</p>
              <button className="btn btn-sm mt-2" onClick={load}>Újra</button>
            </div>
          ) : !rows.length ? (
            <p className="px-4 py-6 text-center text-sm font-semibold text-text-muted">
              <span aria-hidden className="mb-1 block text-2xl">🔔</span>
              Még nincs értesítésed.
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {rows.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void activate(n)}
                    className={`flex w-full items-start gap-2.5 px-4 py-3 text-left transition hover:bg-card-2 ${n.readAt ? '' : 'bg-primary-soft/40'}`}
                  >
                    <span aria-hidden className="mt-0.5 shrink-0 text-base">{iconOf(n.type)}</span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${n.readAt ? 'font-semibold' : 'font-extrabold'}`}>{n.title}</span>
                      {n.body && <span className="block truncate text-xs font-semibold text-text-muted">{n.body}</span>}
                      <span className="mt-0.5 block text-[11px] font-bold text-text-muted">{relativeTime(n.createdAt)}</span>
                    </span>
                    {!n.readAt && <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-border p-2">
            <Link to="/ertesitesek" className="btn btn-sm w-full" onClick={() => setOpen(false)}>
              Összes megtekintése
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
