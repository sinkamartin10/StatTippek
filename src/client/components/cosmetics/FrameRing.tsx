/**
 * Shop keret – SVG gyűrű SAJÁT sziluettel.
 *
 * Minden `FrameShape` külön geometriát rajzol (lángnyelv, pikkely, korona,
 * kristály, áramkör…), ezért a 15 keret nem 15 egyforma karika. A mozgás
 * visszafogott, és `prefers-reduced-motion` esetén a CSS kikapcsolja.
 *
 * A komponens CSAK megjelenít: az itemKey → vizuális leírás feloldása a
 * `lib/cosmeticVisuals.ts` dolga, az pedig a katalógus adatait nem írja felül.
 */
import { useId } from 'react';
import type { FrameVisual } from '../../lib/cosmeticVisuals';

/** A gyűrű sugara a 100×100-as nézetben, a vastagság figyelembevételével. */
const R = (t: number) => 50 - (t * 100) / 2 - 1;

/** Egyenletesen elosztott pontok a körön (részecskékhez, ornamentikához). */
function ringPoints(count: number, radius: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + offset;
    return { x: 50 + Math.cos(a) * radius, y: 50 + Math.sin(a) * radius, a: (a * 180) / Math.PI };
  });
}

/** Csipkézett/lángnyelves körvonal: a sugár szabályosan hullámzik. */
function wavyPath(radius: number, lobes: number, amp: number, sharp = false): string {
  const steps = lobes * (sharp ? 2 : 12);
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * Math.PI * 2 - Math.PI / 2;
    const wave = sharp ? (i % 2 === 0 ? 1 : -1) : Math.sin(t * Math.PI * 2 * lobes);
    const r = radius + wave * amp;
    pts.push(`${(50 + Math.cos(a) * r).toFixed(2)},${(50 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
}

export function FrameRing({ visual, size }: { visual: FrameVisual; size: number }) {
  const uid = useId().replace(/:/g, '');
  const { shape, colors, particles, particleCount, motion, thickness } = visual;
  const r = R(thickness);
  const stroke = thickness * 100;
  const gradId = `fg-${uid}`;
  const multi = colors.length > 1;
  const paint = multi ? `url(#${gradId})` : colors[0];

  // A mozgást a CSS adja (osztálynév), hogy a reduced-motion kikapcsolhassa
  const spin = motion === 'rotate' || motion === 'sweep' ? `cos-spin cos-spin-${motion}` : '';
  const breathe = motion === 'pulse' ? 'cos-pulse' : motion === 'flicker' ? 'cos-flicker' : '';

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`cos-frame ${breathe}`}
      aria-hidden
      focusable="false"
    >
      <defs>
        {multi && (
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            {colors.map((c, i) => (
              <stop key={c + i} offset={`${(i / (colors.length - 1)) * 100}%`} stopColor={c} />
            ))}
          </linearGradient>
        )}
        <radialGradient id={`glow-${uid}`}>
          <stop offset="60%" stopColor={colors[0]} stopOpacity="0" />
          <stop offset="100%" stopColor={colors[colors.length - 1]} stopOpacity="0.45" />
        </radialGradient>
      </defs>

      {/* A forgó rétegek külön csoportban, hogy a belső tartalom álljon */}
      <g className={spin} style={{ transformOrigin: '50px 50px' }}>
        {shape === 'ring' && (
          <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke} />
        )}

        {shape === 'wave' && (
          <>
            <path d={wavyPath(r, 9, stroke * 0.22)} fill="none" stroke={paint} strokeWidth={stroke * 0.9} strokeLinejoin="round" />
            <circle cx="50" cy="50" r={r - stroke * 0.55} fill="none" stroke={colors[0]} strokeWidth={stroke * 0.18} opacity="0.5" />
          </>
        )}

        {shape === 'flame' && (
          <>
            <path d={wavyPath(r, 11, stroke * 0.42)} fill={paint} opacity="0.92" />
            <path d={wavyPath(r - stroke * 0.42, 11, stroke * 0.26)} fill={colors[colors.length - 1]} opacity="0.75" />
          </>
        )}

        {shape === 'bolt' && (
          <>
            <path d={wavyPath(r, 14, stroke * 0.38, true)} fill="none" stroke={paint} strokeWidth={stroke * 0.7} strokeLinejoin="miter" />
            <circle cx="50" cy="50" r={r - stroke * 0.5} fill="none" stroke={colors[1] ?? colors[0]} strokeWidth={stroke * 0.16} opacity="0.7" />
          </>
        )}

        {shape === 'crystal' && (
          <>
            <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke * 0.5} opacity="0.75" />
            {ringPoints(8, r).map((p, i) => (
              <polygon
                key={i}
                points={`${p.x},${p.y - stroke * 0.85} ${p.x + stroke * 0.5},${p.y} ${p.x},${p.y + stroke * 0.85} ${p.x - stroke * 0.5},${p.y}`}
                fill={colors[i % colors.length]}
                opacity="0.95"
                transform={`rotate(${p.a} ${p.x} ${p.y})`}
              />
            ))}
          </>
        )}

        {shape === 'facet' && (
          <>
            <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke * 0.55} />
            {ringPoints(12, r).map((p, i) => (
              <polygon
                key={i}
                points={`${p.x},${p.y - stroke * 0.6} ${p.x + stroke * 0.42},${p.y + stroke * 0.3} ${p.x - stroke * 0.42},${p.y + stroke * 0.3}`}
                fill={colors[i % colors.length]}
                opacity={i % 2 ? 0.95 : 0.6}
                transform={`rotate(${p.a + 90} ${p.x} ${p.y})`}
              />
            ))}
          </>
        )}

        {shape === 'orbit' && (
          <>
            <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke * 0.5} opacity="0.8" />
            <ellipse cx="50" cy="50" rx={r} ry={r * 0.42} fill="none" stroke={colors[2] ?? colors[0]} strokeWidth={stroke * 0.2} opacity="0.75" transform="rotate(-24 50 50)" />
            <ellipse cx="50" cy="50" rx={r} ry={r * 0.42} fill="none" stroke={colors[1] ?? colors[0]} strokeWidth={stroke * 0.16} opacity="0.55" transform="rotate(34 50 50)" />
          </>
        )}

        {shape === 'nebula' && (
          <>
            <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke} opacity="0.9" />
            <circle cx="50" cy="50" r={r} fill="none" stroke={colors[2] ?? colors[0]} strokeWidth={stroke * 0.45}
              strokeDasharray={`${r * 0.9} ${r * 0.5}`} opacity="0.85" />
            <circle cx="50" cy="50" r={r - stroke * 0.6} fill="none" stroke={colors[1] ?? colors[0]} strokeWidth={stroke * 0.22}
              strokeDasharray={`${r * 0.3} ${r * 0.8}`} opacity="0.6" />
          </>
        )}

        {shape === 'crown' && (
          <>
            <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke * 0.8} />
            {ringPoints(10, r).map((p, i) => (
              <polygon
                key={i}
                points={`${p.x - stroke * 0.42},${p.y + stroke * 0.3} ${p.x},${p.y - stroke * 0.95} ${p.x + stroke * 0.42},${p.y + stroke * 0.3}`}
                fill={i % 2 ? colors[1] ?? colors[0] : colors[0]}
                transform={`rotate(${p.a + 90} ${p.x} ${p.y})`}
              />
            ))}
            {ringPoints(5, r, Math.PI / 5).map((p, i) => (
              <circle key={`g${i}`} cx={p.x} cy={p.y} r={stroke * 0.3} fill={colors[2] ?? colors[1] ?? colors[0]} />
            ))}
          </>
        )}

        {shape === 'scale' && (
          <>
            <circle cx="50" cy="50" r={r} fill="none" stroke={colors[0]} strokeWidth={stroke * 0.9} />
            {ringPoints(14, r).map((p, i) => (
              <path
                key={i}
                d={`M${p.x - stroke * 0.4},${p.y} a${stroke * 0.4},${stroke * 0.5} 0 0 1 ${stroke * 0.8},0 z`}
                fill={colors[(i % 2) + 1] ?? colors[1] ?? colors[0]}
                opacity="0.95"
                transform={`rotate(${p.a + 90} ${p.x} ${p.y})`}
              />
            ))}
            {ringPoints(7, r + stroke * 0.5).map((p, i) => (
              <polygon
                key={`s${i}`}
                points={`${p.x - stroke * 0.22},${p.y} ${p.x},${p.y - stroke * 0.75} ${p.x + stroke * 0.22},${p.y}`}
                fill={colors[2] ?? colors[0]}
                transform={`rotate(${p.a + 90} ${p.x} ${p.y})`}
              />
            ))}
          </>
        )}

        {shape === 'aura' && (
          <>
            <circle cx="50" cy="50" r={r + stroke * 0.55} fill="none" stroke={colors[colors.length - 1]} strokeWidth={stroke * 0.3} opacity="0.35" />
            <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke * 0.8} />
            <circle cx="50" cy="50" r={r - stroke * 0.6} fill="none" stroke={colors[0]} strokeWidth={stroke * 0.28} opacity="0.55" />
          </>
        )}

        {shape === 'spectrum' && (
          <circle cx="50" cy="50" r={r} fill="none" stroke={paint} strokeWidth={stroke}
            strokeDasharray={`${r * 0.55} ${r * 0.08}`} strokeLinecap="round" />
        )}

        {/* Részecskék – a ritkasággal nő a számuk */}
        {particles !== 'none' && ringPoints(particleCount, r + stroke * 0.85, 0.4).map((p, i) => {
          const c = colors[i % colors.length];
          if (particles === 'star') {
            return (
              <path key={`p${i}`} d={`M${p.x},${p.y - 2.4} L${p.x + 0.8},${p.y - 0.8} L${p.x + 2.4},${p.y} L${p.x + 0.8},${p.y + 0.8} L${p.x},${p.y + 2.4} L${p.x - 0.8},${p.y + 0.8} L${p.x - 2.4},${p.y} L${p.x - 0.8},${p.y - 0.8} Z`} fill={c} opacity="0.9" />
            );
          }
          if (particles === 'frost') {
            return (
              <g key={`p${i}`} stroke={c} strokeWidth="0.7" opacity="0.85">
                <line x1={p.x - 2} y1={p.y} x2={p.x + 2} y2={p.y} />
                <line x1={p.x} y1={p.y - 2} x2={p.x} y2={p.y + 2} />
              </g>
            );
          }
          if (particles === 'shine') {
            return <circle key={`p${i}`} cx={p.x} cy={p.y} r={i % 2 ? 1.5 : 1} fill={c} opacity="0.95" />;
          }
          if (particles === 'bubble') {
            return <circle key={`p${i}`} cx={p.x} cy={p.y} r={1.8} fill="none" stroke={c} strokeWidth="0.7" opacity="0.8" />;
          }
          if (particles === 'spark') {
            return <rect key={`p${i}`} x={p.x - 0.5} y={p.y - 2} width="1" height="4" rx="0.5" fill={c} opacity="0.9" transform={`rotate(${p.a} ${p.x} ${p.y})`} />;
          }
          // ember
          return <circle key={`p${i}`} cx={p.x} cy={p.y} r={i % 2 ? 1.6 : 1.1} fill={c} opacity="0.85" />;
        })}
      </g>
    </svg>
  );
}
