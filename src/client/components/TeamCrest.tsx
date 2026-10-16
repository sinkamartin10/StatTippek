/**
 * Csapatcímer egységes méretben. Csak az adatforrás (ESPN CDN) által közölt képet tölti be;
 * hiányzó, nem engedélyezett vagy hibás kép helyett semleges labda-ikon jelenik meg.
 *
 *  - fix méretű doboz (width/height) → betöltéskor nincs elrendezés-ugrás;
 *  - `object-fit: contain` → a címer nem torzul;
 *  - hibás URL-t egyszer jelölünk meg (folyamaton belüli lista), utána nem kérjük újra →
 *    nincs újratöltési ciklus, és ugyanaz a rossz kép máshol sem töltődik újra;
 *  - a kép hibája soha nem érinti a mellette lévő csapatnevet vagy tippadatot.
 */
import { useState } from 'react';
import { safeTeamLogo } from '@shared/teamLogo';

export type CrestSize = 'xs' | 'sm' | 'md' | 'lg';
const PX: Record<CrestSize, number> = { xs: 18, sm: 22, md: 28, lg: 44 };

/** az ebben a böngészőfolyamatban már sikertelenül betöltött címer-URL-ek */
const failedLogos = new Set<string>();
export const markCrestFailed = (url: string) => { failedLogos.add(url); };
export const crestFailed = (url: string) => failedLogos.has(url);
/** csak tesztekhez */
export const resetCrestFailures = () => failedLogos.clear();

/** semleges futball-ikon (a hiányzó címer helyett) */
export function CrestFallback({ px, label }: { px: number; label: string }) {
  return (
    <svg role="img" aria-label={label} width={px} height={px} viewBox="0 0 24 24" className="text-text-muted" data-crest="fallback">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.2l3.2 2.3-1.2 3.8H10l-1.2-3.8z" fill="currentColor" />
      <path d="M12 7.2V3.5M15.2 9.5l3.6-1.2M14 13.3l2.3 3.1M10 13.3l-2.3 3.1M8.8 9.5L5.2 8.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A címer megjelenítése állapot nélkül (tesztelhető DOM nélkül is): `onFail` a kép hibájakor fut.
 * A TeamCrest ezt használja, saját „hibás” állapottal.
 */
export function crestElement(name: string, logo: string | undefined | null, size: CrestSize, failed: boolean, onFail: () => void) {
  const px = PX[size];
  const src = safeTeamLogo(logo);
  const show = !!src && !failed && !crestFailed(src);
  return (
    <span className="inline-flex shrink-0 items-center justify-center overflow-hidden" style={{ width: px, height: px }} data-crest-size={size}>
      {show ? (
        <img
          src={src}
          alt={`${name} címere`}
          width={px}
          height={px}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className="h-full w-full object-contain"
          onError={() => { markCrestFailed(src!); onFail(); }}
        />
      ) : (
        <CrestFallback px={Math.round(px * 0.86)} label={`${name} – címer nem érhető el`} />
      )}
    </span>
  );
}

export function TeamCrest({ name, logo, size = 'md' }: { name: string; logo?: string | null; size?: CrestSize }) {
  // a hibát a (logó-URL-hez kötött) állapot jelzi: új URL esetén újra megpróbálja, ugyanazt nem
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = !!logo && failedFor === logo;
  return crestElement(name, logo, size, failed, () => setFailedFor(logo ?? null));
}

/** „Hazai – Vendég” címke szétbontása (a tipp- és szelvénysorok csak a címkét kapják). */
export function splitMatchLabel(label: string): [string, string] {
  const m = label.split(/\s+[–-]\s+/);
  return [m[0] ?? label, m[1] ?? ''];
}

/** Kompakt párosítás egy sorban: [címer] Hazai – [címer] Vendég (a nevek szükség esetén levágódnak). */
export function Matchup({ home, away, homeLogo, awayLogo, size = 'xs' }: { home: string; away: string; homeLogo?: string | null; awayLogo?: string | null; size?: CrestSize }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <TeamName name={home} logo={homeLogo} size={size} className="gap-1.5" />
      <span className="shrink-0 text-text-muted" aria-label="ellen">–</span>
      <TeamName name={away} logo={awayLogo} size={size} className="gap-1.5" />
    </span>
  );
}

/** Csapatnév címerrel, egy sorban (a név szükség esetén levágódik, a címer nem nyomja össze). */
export function TeamName({ name, logo, size = 'sm', wrap = false, className = '' }: { name: string; logo?: string | null; size?: CrestSize; wrap?: boolean; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-2 ${className}`}>
      <TeamCrest name={name} logo={logo} size={size} />
      <span className={`min-w-0 ${wrap ? 'break-words' : 'truncate'}`}>{name}</span>
    </span>
  );
}
