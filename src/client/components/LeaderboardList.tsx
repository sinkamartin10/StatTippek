/**
 * Tippverseny ranglista – avatarral, profilkerettel és címmel.
 *
 * A megjelenítendő profilt a SZERVER adja (`row.profile`), már ellenőrzött állapotban:
 * fel nem oldott vagy ismeretlen kozmetikum helyén az alapértelmezés érkezik.
 * A kliens itt semmit nem dönt el – a sorrend és a pontszám is a szerverről jön.
 */
import type { AvatarSlot } from '@shared/progression';
import type { LeaderboardRow } from '@shared/competition';
import type { ShopEquips } from '@shared/shop';
import { CosmeticProfile } from './CosmeticProfile';

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

export function LeaderboardList({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <ol className="divide-y divide-border">
      {rows.map((row) => (
        <li
          key={row.rank}
          className={`flex items-center gap-3 py-3 first:pt-0 last:pb-0 ${row.isMe ? 'font-extrabold' : ''}`}
        >
          <span className="w-7 shrink-0 text-center text-sm font-extrabold text-text-muted">
            {MEDAL[row.rank] ?? <span className="mono">{row.rank}.</span>}
          </span>

          {/* UGYANAZ a megjelenítő, mint a profilon és a Shop előnézetében.
              A megszolgált réteg (avatar/keret/cím) és a shop réteg is a
              SZERVERTŐL jön, már ellenőrzött állapotban. */}
          <CosmeticProfile
            displayName={row.displayName}
            avatar={row.profile?.avatar as Partial<Record<AvatarSlot, string>> | undefined}
            borderKey={row.profile?.borderKey ?? 'classic'}
            titleKey={row.profile?.titleKey}
            shop={row.profile?.shop as Partial<ShopEquips> | undefined}
            size={40}
            variant="row"
            className="flex-1"
          />

          {row.isMe && <span className="badge badge-blue shrink-0">te</span>}
          <span className="mono shrink-0 text-right text-sm font-extrabold">{row.points} pont</span>
        </li>
      ))}
    </ol>
  );
}
