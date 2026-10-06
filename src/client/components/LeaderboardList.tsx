/**
 * Tippverseny ranglista – avatarral, profilkerettel és címmel.
 *
 * A megjelenítendő profilt a SZERVER adja (`row.profile`), már ellenőrzött állapotban:
 * fel nem oldott vagy ismeretlen kozmetikum helyén az alapértelmezés érkezik.
 * A kliens itt semmit nem dönt el – a sorrend és a pontszám is a szerverről jön.
 */
import { TITLES, type AvatarSlot } from '@shared/progression';
import type { LeaderboardRow } from '@shared/competition';
import { Avatar } from './Avatar';

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

/** A cím kulcsából a megjelenítendő név; ismeretlen vagy „none" esetén nincs cím. */
function titleName(key: string | undefined): string | null {
  if (!key || key === 'none') return null;
  return TITLES.find((t) => t.key === key)?.name ?? null;
}

export function LeaderboardList({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <ol className="divide-y divide-border">
      {rows.map((row) => {
        const title = titleName(row.profile?.titleKey);
        return (
          <li
            key={row.rank}
            className={`flex items-center gap-3 py-3 first:pt-0 last:pb-0 ${row.isMe ? 'font-extrabold' : ''}`}
          >
            <span className="w-7 shrink-0 text-center text-sm font-extrabold text-text-muted">
              {MEDAL[row.rank] ?? <span className="mono">{row.rank}.</span>}
            </span>

            <Avatar
              avatar={row.profile?.avatar as Partial<Record<AvatarSlot, string>> | undefined}
              border={row.profile?.borderKey ?? 'classic'}
              size={40}
            />

            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-extrabold">{row.displayName}</span>
                {row.isMe && <span className="badge badge-blue shrink-0">te</span>}
              </span>
              <span className="block truncate text-xs font-bold text-text-muted">
                {title ?? `${row.predictions} tipp`}
              </span>
            </span>

            <span className="mono shrink-0 text-right text-sm font-extrabold">{row.points} pont</span>
          </li>
        );
      })}
    </ol>
  );
}
