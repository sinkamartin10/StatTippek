/**
 * Profil-háttér – SVG jelenet, nem puszta színátmenet.
 *
 * Mind a hét háttér saját kompozíciót kap (stadion reflektorokkal, pálya
 * felülnézetből, galaxis, vulkán, fagy, napkelte, üres tér), így a profil
 * hangulata ténylegesen megváltozik. A jelenet dekoratív: `aria-hidden`.
 */
import { useId } from 'react';
import type { BackgroundVisual } from '../../lib/cosmeticVisuals';

/** Determinisztikus ál-véletlen: ugyanaz a jelenet mindig ugyanúgy néz ki. */
function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

export function BackgroundScene({ visual, className = '' }: { visual: BackgroundVisual; className?: string }) {
  const uid = useId().replace(/:/g, '');
  const { scene, colors } = visual;
  const g = `bg-${uid}`;
  const rand = rng(scene.length * 7919);

  return (
    <svg
      viewBox="0 0 160 100"
      preserveAspectRatio="xMidYMid slice"
      className={`cos-scene ${className}`}
      aria-hidden
      focusable="false"
    >
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="0.4" y2="1">
          {colors.map((c, i) => (
            <stop key={c + i} offset={`${(i / (colors.length - 1)) * 100}%`} stopColor={c} />
          ))}
        </linearGradient>
        <radialGradient id={`${g}-halo`} cx="50%" cy="20%">
          <stop offset="0%" stopColor={colors[colors.length - 1]} stopOpacity="0.55" />
          <stop offset="100%" stopColor={colors[0]} stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="160" height="100" fill={`url(#${g})`} />

      {scene === 'stadium' && (
        <g>
          <rect width="160" height="100" fill={`url(#${g}-halo)`} />
          {/* reflektorok */}
          {[26, 80, 134].map((x) => (
            <g key={x}>
              <rect x={x - 9} y="10" width="18" height="7" rx="1.5" fill="#f8fafc" opacity="0.9" />
              <rect x={x - 1} y="17" width="2" height="12" fill="#94a3b8" opacity="0.7" />
              <polygon points={`${x - 9},17 ${x + 9},17 ${x + 26},62 ${x - 26},62`} fill="#ffffff" opacity="0.07" />
            </g>
          ))}
          {/* lelátó + pálya */}
          <path d="M0 60 Q80 48 160 60 L160 100 L0 100 Z" fill="#0b1324" opacity="0.55" />
          <ellipse cx="80" cy="92" rx="66" ry="18" fill="#17b877" opacity="0.28" />
          <ellipse cx="80" cy="92" rx="20" ry="6" fill="none" stroke="#ffffff" strokeWidth="0.8" opacity="0.35" />
        </g>
      )}

      {scene === 'pitch' && (
        <g>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x={i * 27} y="0" width="27" height="100" fill="#ffffff" opacity={i % 2 ? 0.07 : 0} />
          ))}
          <circle cx="80" cy="50" r="22" fill="none" stroke="#ffffff" strokeWidth="1.2" opacity="0.5" />
          <circle cx="80" cy="50" r="2.5" fill="#ffffff" opacity="0.6" />
          <line x1="80" y1="0" x2="80" y2="100" stroke="#ffffff" strokeWidth="1.2" opacity="0.4" />
          <rect x="0" y="28" width="22" height="44" fill="none" stroke="#ffffff" strokeWidth="1.2" opacity="0.4" />
          <rect x="138" y="28" width="22" height="44" fill="none" stroke="#ffffff" strokeWidth="1.2" opacity="0.4" />
        </g>
      )}

      {scene === 'galaxy' && (
        <g>
          <rect width="160" height="100" fill={`url(#${g}-halo)`} />
          {Array.from({ length: 46 }, (_, i) => {
            const x = rand() * 160, y = rand() * 100, r = rand() * 0.9 + 0.3;
            return <circle key={i} cx={x} cy={y} r={r} fill="#ffffff" opacity={0.35 + rand() * 0.6} />;
          })}
          <ellipse cx="96" cy="38" rx="52" ry="16" fill="#c4b5fd" opacity="0.16" transform="rotate(-18 96 38)" />
          <ellipse cx="96" cy="38" rx="30" ry="8" fill="#f0abfc" opacity="0.18" transform="rotate(-18 96 38)" />
        </g>
      )}

      {scene === 'volcano' && (
        <g>
          <path d="M0 100 L52 44 L74 66 L104 30 L160 100 Z" fill="#450a0a" opacity="0.65" />
          <path d="M104 30 L112 48 L96 48 Z" fill="#fbbf24" opacity="0.8" />
          {Array.from({ length: 16 }, (_, i) => {
            const x = 60 + rand() * 80, y = 14 + rand() * 60, r = rand() * 1.4 + 0.5;
            return <circle key={i} cx={x} cy={y} r={r} fill={i % 3 ? '#f59e0b' : '#ef4444'} opacity={0.5 + rand() * 0.5} />;
          })}
          <rect y="88" width="160" height="12" fill="#ef4444" opacity="0.25" />
        </g>
      )}

      {scene === 'frost' && (
        <g>
          {Array.from({ length: 9 }, (_, i) => {
            const x = 10 + rand() * 140, y = 10 + rand() * 80, s = 3 + rand() * 5;
            return (
              <g key={i} stroke="#ffffff" strokeWidth="0.8" opacity={0.3 + rand() * 0.4}>
                <line x1={x - s} y1={y} x2={x + s} y2={y} />
                <line x1={x} y1={y - s} x2={x} y2={y + s} />
                <line x1={x - s * 0.7} y1={y - s * 0.7} x2={x + s * 0.7} y2={y + s * 0.7} />
                <line x1={x - s * 0.7} y1={y + s * 0.7} x2={x + s * 0.7} y2={y - s * 0.7} />
              </g>
            );
          })}
          <path d="M0 100 L28 70 L54 92 L84 62 L116 88 L146 66 L160 100 Z" fill="#e0f2fe" opacity="0.28" />
        </g>
      )}

      {scene === 'sunrise' && (
        <g>
          <circle cx="80" cy="74" r="30" fill="#fde68a" opacity="0.5" />
          <circle cx="80" cy="74" r="18" fill="#fbbf24" opacity="0.75" />
          {Array.from({ length: 10 }, (_, i) => (
            <rect key={i} x="78.5" y="10" width="3" height="128" fill="#fde68a" opacity="0.12"
              transform={`rotate(${i * 18} 80 74)`} />
          ))}
          <path d="M0 100 Q40 86 80 94 Q120 102 160 88 L160 100 Z" fill="#78350f" opacity="0.5" />
        </g>
      )}

      {scene === 'void' && (
        <g>
          <rect width="160" height="100" fill="#06070f" opacity="0.45" />
          {Array.from({ length: 30 }, (_, i) => {
            const x = rand() * 160, y = rand() * 100;
            return <circle key={i} cx={x} cy={y} r={rand() * 0.8 + 0.25} fill="#ffffff" opacity={0.25 + rand() * 0.5} />;
          })}
          {[30, 22, 14].map((r, i) => (
            <circle key={r} cx="80" cy="50" r={r} fill="none"
              stroke={i === 0 ? colors[2] ?? '#db2777' : colors[1] ?? '#312e81'}
              strokeWidth={0.9 - i * 0.2} opacity={0.5 - i * 0.1} />
          ))}
          <circle cx="80" cy="50" r="9" fill="#06070f" />
          <circle cx="80" cy="50" r="9" fill="none" stroke={colors[2] ?? '#db2777'} strokeWidth="1.1" opacity="0.8" />
        </g>
      )}
    </svg>
  );
}
