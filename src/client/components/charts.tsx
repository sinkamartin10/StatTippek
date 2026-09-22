/** Recharts alapú, reszponzív diagramok (sötét téma). */
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { FormSummary, PoissonResult } from '@shared/types';

const AX = { stroke: '#8b9bb0', fontSize: 11 };
const GRID = '#223041';
const fmtPct = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')}%`;

export function OneXTwoChart({ p, home, away }: { p: PoissonResult; home: string; away: string }) {
  const data = [
    { name: `1 – ${home}`, v: p.homeWin, c: '#22c55e' },
    { name: 'X – Döntetlen', v: p.draw, c: '#8b9bb0' },
    { name: `2 – ${away}`, v: p.awayWin, c: '#38bdf8' },
  ];
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} layout="vertical" margin={{ left: 10, right: 30 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={AX} />
        <YAxis type="category" dataKey="name" width={130} tick={AX} />
        <Tooltip formatter={(v) => fmtPct(Number(v))} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Bar isAnimationActive={false} dataKey="v" radius={[0, 6, 6, 0]} label={{ position: 'right', fill: '#e6edf3', fontSize: 12, formatter: (v: number) => fmtPct(v) }}>
          {data.map((d) => <Cell key={d.name} fill={d.c} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GoalDistChart({ p, home, away }: { p: PoissonResult; home: string; away: string }) {
  const data = p.homeGoalDist.map((v, i) => ({ g: i === 5 ? '5+' : String(i), [home]: v, [away]: p.awayGoalDist[i] }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="g" tick={AX} label={{ value: 'gólok száma', position: 'insideBottom', offset: -2, fill: '#8b9bb0', fontSize: 11 }} />
        <YAxis tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={AX} />
        <Tooltip formatter={(v) => fmtPct(Number(v))} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar isAnimationActive={false} dataKey={home} fill="#22c55e" radius={[4, 4, 0, 0]} />
        <Bar isAnimationActive={false} dataKey={away} fill="#38bdf8" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CorrectScoreChart({ p }: { p: PoissonResult }) {
  const data = p.correctScores.map((c) => ({ name: c.score, v: c.prob }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={AX} />
        <YAxis tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} tick={AX} />
        <Tooltip formatter={(v) => fmtPct(Number(v))} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Bar isAnimationActive={false} dataKey="v" fill="#22c55e" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function OverUnderChart({ p }: { p: PoissonResult }) {
  const data = ['0.5', '1.5', '2.5', '3.5', '4.5'].map((l) => ({ line: l.replace('.', ','), Több: p.over[l], Kevesebb: p.under[l] }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="line" tick={AX} />
        <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={AX} />
        <Tooltip formatter={(v) => fmtPct(Number(v))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line isAnimationActive={false} type="monotone" dataKey="Több" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} />
        <Line isAnimationActive={false} type="monotone" dataKey="Kevesebb" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Forma: az utolsó N meccs lőtt/kapott góljai (legrégebbi balra). */
export function FormGoalsChart({ form, name }: { form: FormSummary; name: string }) {
  const data = [...form.matches].reverse().map((m, i) => ({ i: i + 1, Lőtt: m.gf, Kapott: m.ga, res: m.result }));
  if (!data.length) return <div className="py-6 text-center text-sm text-muted">Nincs adat</div>;
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="i" tick={AX} />
        <YAxis allowDecimals={false} tick={AX} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} labelFormatter={(l) => `${name} – ${l}. meccs`} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar isAnimationActive={false} dataKey="Lőtt" fill="#22c55e" radius={[3, 3, 0, 0]} />
        <Bar isAnimationActive={false} dataKey="Kapott" fill="#ef4444" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Forma pontok görgetve (kumulált pont az utolsó N meccsből, legrégebbi balra). */
export function FormTrendChart({ home, away, homeName, awayName }: { home: FormSummary; away: FormSummary; homeName: string; awayName: string }) {
  const cum = (f: FormSummary) => {
    let s = 0;
    return [...f.matches].reverse().map((m) => (s += m.result === 'W' ? 3 : m.result === 'D' ? 1 : 0));
  };
  const h = cum(home), a = cum(away);
  const n = Math.max(h.length, a.length);
  const data = Array.from({ length: n }, (_, i) => ({ i: i + 1, [homeName]: h[i], [awayName]: a[i] }));
  if (!n) return <div className="py-6 text-center text-sm text-muted">Nincs adat</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="i" tick={AX} />
        <YAxis allowDecimals={false} tick={AX} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line isAnimationActive={false} type="monotone" dataKey={homeName} stroke="#22c55e" strokeWidth={2} dot={false} />
        <Line isAnimationActive={false} type="monotone" dataKey={awayName} stroke="#38bdf8" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function SimpleBarChart({ data, color = '#22c55e', height = 200, pctAxis = false }: { data: { name: string; v: number }[]; color?: string; height?: number; pctAxis?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="name" tick={AX} />
        <YAxis tick={AX} tickFormatter={pctAxis ? (v) => `${v}%` : undefined} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} formatter={(v) => (pctAxis ? `${Number(v).toFixed(1).replace('.', ',')}%` : Number(v).toFixed(2).replace('.', ','))} />
        <Bar isAnimationActive={false} dataKey="v" fill={color} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
