/**
 * 2D meccsanimáció (React + Canvas). SZEMLÉLTETÉS: a szerver által adott legvalószínűbb pontos
 * eredményhez igazított, előre generált eseménysor – nem új előrejelzés és nem a valós meccs kimenetele.
 * A logika a `lib/matchAnimation` tiszta függvényeiben van; ez a komponens csak rajzol és vezérel.
 */
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { GOAL, PITCH, frameAt, generateTimeline, playReducer, type Frame, type Pt, type Timeline } from '../lib/matchAnimation';

const COLORS = { home: '#2563eb', homeGk: '#1e3a8a', away: '#dc2626', awayGk: '#7f1d1d' };

export function MatchAnimation({ score, expectedGoals, seedKey, homeName, awayName }: {
  score: [number, number]; expectedGoals: { home: number; away: number }; seedKey: string; homeName: string; awayName: string;
}) {
  const [hs, as_] = score;
  const { home: xh, away: xa } = expectedGoals;
  const tl = useMemo<Timeline>(() => generateTimeline({ score: [hs, as_], expectedGoals: { home: xh, away: xa }, seedKey }), [hs, as_, xh, xa, seedKey]);
  const [st, dispatch] = useReducer(playReducer, { status: 'ready', elapsed: 0, durationMs: tl.durationMs });
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const frame = frameAt(tl, st.elapsed);

  // lejátszási ciklus: csak „playing” állapotban; leálláskor / bezáráskor a képkockakérés törlődik
  useEffect(() => {
    if (st.status !== 'playing') return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => { dispatch({ type: 'tick', dt: now - last }); last = now; raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [st.status]);

  // háttérbe kerülő fülnél szünet (a lejátszás nem fut tovább láthatatlanul)
  useEffect(() => {
    const onHide = () => { if (document.hidden) dispatch({ type: 'pause' }); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // rajzolás: a konténer szélességéhez igazítva, nagy felbontású kijelzőn is élesen
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const draw = () => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return; // nincs Canvas-támogatás: a pontszám és a játékidő a fenti sávban így is látszik
    const w = c.clientWidth || 320;
    const h = (w * PITCH.h) / PITCH.w;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    ctx.setTransform((dpr * w) / PITCH.w, 0, 0, (dpr * h) / PITCH.h, 0, 0);
    drawFrame(ctx, frameRef.current);
  };
  useEffect(draw);
  useEffect(() => {
    const c = canvas.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const playing = st.status === 'playing';
  return (
    <div className="space-y-2" data-anim data-anim-final={`${tl.final[0]}-${tl.final[1]}`}>
      <div className="flex items-center justify-between gap-2 rounded-xl bg-[#0f172a] px-3 py-2 text-white" data-anim-scoreboard>
        <span className="min-w-0 truncate text-sm font-extrabold"><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS.home }} />{homeName}</span>
        <span className="mono shrink-0 text-lg font-black" data-anim-score>{frame.score[0]} – {frame.score[1]}</span>
        <span className="min-w-0 truncate text-right text-sm font-extrabold">{awayName}<span className="ml-1.5 inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS.away }} /></span>
        <span className="mono shrink-0 rounded bg-white/15 px-1.5 py-0.5 text-xs font-bold" data-anim-minute>{frame.finished ? 'Vége' : `${frame.minute}'`}</span>
      </div>
      <canvas ref={canvas} className="block aspect-[105/68] w-full rounded-xl" role="img" aria-label={`Szemléltető meccsanimáció: ${homeName} – ${awayName}, ${frame.score[0]}–${frame.score[1]}, ${frame.finished ? 'vége' : `${frame.minute}. perc`}`} />
      <div className="flex flex-wrap items-center gap-2">
        {playing ? (
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: 'pause' })} data-anim-control="pause"><Pause className="h-4 w-4" /> Szünet</button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => dispatch({ type: 'play' })} data-anim-control="play">
            <Play className="h-4 w-4" /> {st.status === 'paused' ? 'Folytatás' : st.status === 'finished' ? 'Újra' : 'Lejátszás'}
          </button>
        )}
        {st.status !== 'ready' && (
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: 'replay' })} data-anim-control="replay"><RotateCcw className="h-4 w-4" /> Újrajátszás</button>
        )}
        <span className="text-xs text-muted">{Math.round(tl.durationMs / 1000)} mp-es gyorsított összefoglaló</span>
      </div>
      <p className="text-xs text-muted">
        Szemléltető animáció a szimuláció legvalószínűbb pontos eredményéhez ({tl.final[0]}–{tl.final[1]}). A mozgás és az események
        illusztrációk – nem előrejelzés, és nem a valós mérkőzés biztos kimenetele.
      </p>
    </div>
  );
}

function drawFrame(ctx: CanvasRenderingContext2D, f: Frame) {
  const W = PITCH.w, H = PITCH.h;
  // pálya csíkokkal
  for (let i = 0; i < 10; i++) { ctx.fillStyle = i % 2 ? '#2f8f46' : '#36a050'; ctx.fillRect((i * W) / 10, 0, W / 10, H); }
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 0.35;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.beginPath(); ctx.moveTo(W / 2, 0.5); ctx.lineTo(W / 2, H - 0.5); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 9.15, 0, Math.PI * 2); ctx.stroke();
  for (const x of [0.5, W - 0.5]) {
    const d = x < W / 2 ? 1 : -1;
    ctx.strokeRect(Math.min(x, x + d * 16.5), H / 2 - 20.16, 16.5, 40.32);
    ctx.strokeRect(Math.min(x, x + d * 5.5), H / 2 - 9.16, 5.5, 18.32);
    // kapu
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x < W / 2 ? -1.5 : W - 0.5, GOAL.top, 2, GOAL.bottom - GOAL.top);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(x < W / 2 ? -1.5 : W - 0.5, GOAL.top, 2, GOAL.bottom - GOAL.top);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  }
  const dot = (p: Pt, color: string, r: number) => {
    ctx.beginPath(); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.arc(p.x + 0.35, p.y + 0.45, r, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = color; ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 0.3; ctx.strokeStyle = '#fff'; ctx.stroke();
  };
  f.home.forEach((p, i) => dot(p, i === 0 ? COLORS.homeGk : COLORS.home, 1.5));
  f.away.forEach((p, i) => dot(p, i === 0 ? COLORS.awayGk : COLORS.away, 1.5));
  // labda
  ctx.beginPath(); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.arc(f.ball.x + 0.3, f.ball.y + 0.4, 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.fillStyle = '#fff'; ctx.arc(f.ball.x, f.ball.y, 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 0.15; ctx.strokeStyle = '#111'; ctx.stroke();
  if (f.overlay) {
    ctx.save();
    ctx.font = `900 ${f.overlay.text === 'GÓL!' ? 11 : 7}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillText(f.overlay.text, W / 2 + 0.5, H / 2 + 0.6);
    ctx.fillStyle = f.overlay.text === 'Vége' ? '#fff' : f.overlay.team === 'home' ? '#dbeafe' : '#fee2e2';
    ctx.fillText(f.overlay.text, W / 2, H / 2);
    ctx.restore();
  }
}
