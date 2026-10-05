/**
 * TippStats avatar – rajzolt, részekből összerakott focista-figura.
 * NINCS feltöltött profilkép és nincs generált portré: minden elem a katalógusból jön
 * (src/shared/progression.ts), így egységes marad a vizuális stílus.
 */
import { AVATAR_PARTS, BORDERS, DEFAULT_SETTINGS, type AvatarSlot } from '@shared/progression';

const colorOf = (slot: AvatarSlot, key: string, fallback: string): string =>
  AVATAR_PARTS[slot].find((o) => o.key === key)?.value ?? fallback;

function Background({ kind, shirt }: { kind: string; shirt: string }) {
  if (kind === 'rays') {
    return (
      <g>
        <rect width="100" height="100" fill="var(--color-primary-soft)" />
        {[0, 45, 90, 135].map((a) => (
          <rect key={a} x="48" y="-40" width="4" height="180" fill="#ffffff" opacity="0.55" transform={`rotate(${a} 50 50)`} />
        ))}
      </g>
    );
  }
  if (kind === 'pitch') {
    return (
      <g>
        <rect width="100" height="100" fill="#d8f0df" />
        {[0, 20, 40, 60, 80].map((y) => <rect key={y} x="0" y={y} width="100" height="10" fill="#c6e8d1" />)}
        <circle cx="50" cy="50" r="22" fill="none" stroke="#ffffff" strokeWidth="2.5" />
      </g>
    );
  }
  if (kind === 'confetti') {
    return (
      <g>
        <rect width="100" height="100" fill="var(--color-secondary-soft)" />
        {[[12, 18], [78, 14], [22, 72], [84, 64], [52, 10], [68, 86]].map(([x, y], i) => (
          <rect key={i} x={x} y={y} width="6" height="6" rx="1.5" fill={i % 2 ? shirt : '#f0b429'} opacity="0.8" transform={`rotate(${i * 35} ${x} ${y})`} />
        ))}
      </g>
    );
  }
  return <rect width="100" height="100" fill="var(--color-surface)" />;
}

function Hair({ style, color }: { style: string; color: string }) {
  switch (style) {
    case 'bald':
      return null;
    case 'buzz':
      return <path d="M30 40 Q50 22 70 40 Q50 32 30 40 Z" fill={color} />;
    case 'curly':
      return (
        <g fill={color}>
          <circle cx="34" cy="36" r="9" /><circle cx="46" cy="30" r="10" />
          <circle cx="58" cy="31" r="9" /><circle cx="67" cy="38" r="8" />
        </g>
      );
    case 'long':
      return (
        <g fill={color}>
          <path d="M28 42 Q28 22 50 22 Q72 22 72 42 L72 60 Q68 48 50 46 Q32 48 28 60 Z" />
        </g>
      );
    case 'mohawk':
      return <path d="M44 20 Q50 12 56 20 L56 40 Q50 34 44 40 Z" fill={color} />;
    default: // short
      return <path d="M29 42 Q29 23 50 23 Q71 23 71 42 Q62 32 50 32 Q38 32 29 42 Z" fill={color} />;
  }
}

function Shirt({ style, color }: { style: string; color: string }) {
  const body = <path d="M24 100 Q24 76 38 70 L62 70 Q76 76 76 100 Z" fill={color} />;
  return (
    <g>
      {body}
      {style === 'stripes' && (
        <g opacity="0.9">
          {[34, 46, 58].map((x) => <rect key={x} x={x} y="70" width="6" height="30" fill="#ffffff" opacity="0.55" />)}
        </g>
      )}
      {style === 'hoops' && (
        <g opacity="0.9">
          {[78, 88].map((y) => <rect key={y} x="24" y={y} width="52" height="6" fill="#ffffff" opacity="0.55" />)}
        </g>
      )}
      {style === 'sash' && <path d="M30 100 L62 70 L72 74 L42 100 Z" fill="#ffffff" opacity="0.6" />}
    </g>
  );
}

function Accessory({ kind, shirt }: { kind: string; shirt: string }) {
  if (kind === 'headband') return <rect x="29" y="38" width="42" height="6" rx="3" fill="#e23d4b" />;
  if (kind === 'shades') {
    return (
      <g>
        <rect x="33" y="46" width="14" height="9" rx="4" fill="#2b3245" />
        <rect x="53" y="46" width="14" height="9" rx="4" fill="#2b3245" />
        <rect x="47" y="49" width="6" height="2.5" fill="#2b3245" />
      </g>
    );
  }
  if (kind === 'captain') {
    return (
      <g>
        <rect x="66" y="78" width="12" height="8" rx="2" fill="#f0b429" />
        <text x="72" y="84.5" textAnchor="middle" fontSize="6" fontWeight="800" fill="#5a3c00">C</text>
      </g>
    );
  }
  return null;
}

export interface AvatarProps {
  avatar?: Partial<Record<AvatarSlot, string>>;
  border?: string;
  /** képpont-méret */
  size?: number;
  className?: string;
}

/** Avatar a kiválasztott kerettel. A keret finom animációt kaphat (lásd styles.css). */
export function Avatar({ avatar, border = 'classic', size = 96, className = '' }: AvatarProps) {
  const a = { ...DEFAULT_SETTINGS.avatar, ...(avatar ?? {}) };
  const skin = colorOf('skin', a.skin, '#f2c6a0');
  const hairColor = colorOf('hairColor', a.hairColor, '#2b2b33');
  const shirtColor = colorOf('shirtColor', a.shirtColor, '#4f6ef7');
  const frame = BORDERS.find((b) => b.key === border) ?? BORDERS[1];
  const ring = frame.key === 'none' ? 'transparent' : (frame.value ?? '#cdd5ea');

  return (
    <span
      className={`avatar-frame ${frame.animation ? `avatar-anim-${frame.animation}` : ''} ${className}`}
      style={{ width: size, height: size, ['--avatar-ring' as string]: ring }}
      aria-hidden
    >
      <svg viewBox="0 0 100 100" width="100%" height="100%" className="avatar-svg">
        <defs>
          <clipPath id={`avatar-clip-${size}`}><circle cx="50" cy="50" r="50" /></clipPath>
        </defs>
        <g clipPath={`url(#avatar-clip-${size})`}>
          <Background kind={a.background} shirt={shirtColor} />
          <Shirt style={a.shirt} color={shirtColor} />
          {/* nyak */}
          <rect x="44" y="60" width="12" height="14" fill={skin} />
          {/* fej */}
          <circle cx="50" cy="48" r="21" fill={skin} />
          {/* szemek és mosoly */}
          <circle cx="43" cy="48" r="2.4" fill="#2b3245" />
          <circle cx="57" cy="48" r="2.4" fill="#2b3245" />
          <path d="M44 56 Q50 61 56 56" stroke="#2b3245" strokeWidth="2" fill="none" strokeLinecap="round" />
          <Hair style={a.hair} color={hairColor} />
          <Accessory kind={a.accessory} shirt={shirtColor} />
        </g>
      </svg>
    </span>
  );
}
