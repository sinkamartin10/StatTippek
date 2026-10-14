/**
 * „X PRO-felhasználó” – visszafogott jelvény a nyitóoldalon és a főoldalon.
 *
 * A szám a szervertől jön, és mindig a TÉNYLEGES aktív PRO-előfizetők száma
 * (kézzel nem állítható). Betöltés közben, hibánál, kikapcsolt megjelenítésnél
 * vagy 0 esetén SEMMIT nem mutat – tartalék vagy kitalált szám nincs.
 */
import { Crown } from 'lucide-react';
import { formatProUsers, type PublicProCount } from '@shared/proStats';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';

/** Tiszta megjelenítés (tesztelhető): null, ha nincs mit mutatni. */
export function ProUserCountView({ data, className = '' }: { data: PublicProCount | null; className?: string }) {
  if (!data?.show || data.count == null || data.count <= 0) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-secondary/30 bg-card px-3 py-1 text-xs font-extrabold text-text ${className}`}>
      <Crown className="h-3.5 w-3.5 text-secondary" aria-hidden="true" />
      {formatProUsers(data.count)}
    </span>
  );
}

/** A szám betöltése a nyilvános végpontról; a hiba nem törheti el az oldalt. */
export function ProUserCount({ className = '' }: { className?: string }) {
  const stats = useAsync(() => api.proStats().catch(() => null), []);
  return <ProUserCountView data={stats.data} className={className} />;
}
