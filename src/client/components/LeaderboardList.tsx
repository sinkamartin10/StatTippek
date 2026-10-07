/**
 * Tippverseny ranglista – avatarral, kerettel, címmel, és kattintható
 * játékosokkal.
 *
 * A megjelenítendő profilt a SZERVER adja (`row.profile`), már ellenőrzött
 * állapotban: fel nem oldott vagy ismeretlen kozmetikum helyén az
 * alapértelmezés érkezik. A kliens itt semmit nem dönt el – a sorrend és a
 * pontszám is a szerverről jön.
 *
 * A sor egésze link: a saját sor a saját profilra, a többi a játékos
 * NYILVÁNOS profiljára visz. A link a megjelenítési nevet használja, nem a
 * felhasználó azonosítóját – a ranglista egyébként sem tartalmaz user_id-t.
 */
import { Link } from 'react-router-dom';
import type { AvatarSlot } from '@shared/progression';
import type { LeaderboardRow } from '@shared/competition';
import type { ShopEquips } from '@shared/shop';
import { CosmeticProfile } from './CosmeticProfile';

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

export function LeaderboardList({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <ol className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.rank}>
          <Link
            to={row.isMe ? '/profil' : `/jatekos/${encodeURIComponent(row.displayName)}`}
            className={`lb-row ${row.isMe ? 'font-extrabold' : ''}`}
            aria-label={`${row.displayName} profilja – ${row.rank}. hely, ${row.points} pont`}
          >
            <span className="w-7 shrink-0 text-center text-sm font-extrabold text-text-muted">
              {MEDAL[row.rank] ?? <span className="mono">{row.rank}.</span>}
            </span>

            {/* UGYANAZ a megjelenítő, mint a profilon és a Shop előnézetében */}
            <CosmeticProfile
              displayName={row.displayName}
              avatar={row.profile?.avatar as Partial<Record<AvatarSlot, string>> | undefined}
              borderKey={row.profile?.borderKey ?? 'classic'}
              titleKey={row.profile?.titleKey}
              shop={row.profile?.shop as Partial<ShopEquips> | undefined}
              size={40}
              variant="row"
              className="min-w-0 flex-1"
            />

            {row.isMe && <span className="badge badge-blue shrink-0">te</span>}
            <span className="mono shrink-0 text-right text-sm font-extrabold">{row.points} pont</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
