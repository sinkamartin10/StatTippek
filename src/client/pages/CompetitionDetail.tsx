/**
 * Tippverseny részletek: mérkőzések tippelő mezőkkel, ranglista, szabályok.
 * A zárolást (locked) a SZERVER adja meg – itt csak megjelenítjük; a beküldést a backend újra ellenőrzi.
 *
 * Tömeges tippelés: a választások a beküldésig HELYBEN maradnak (választásonként
 * nincs mentési kérés); a csomag – csak az új és a módosított tippek – egyetlen,
 * atomikus kéréssel megy a szerverre, megerősítés után.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Lock, Send, Trophy, Undo2 } from 'lucide-react';
import type { BatchItemError, CompetitionMatchView } from '@shared/competition';
import { ApiError, api } from '../lib/api';
import { fmtDateTime, fmtTime, useAsync } from '../lib/format';
import { quotaLabel } from '@shared/freeQuota';
import { Card, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { usePlan } from '../auth/PlanContext';
import { ParticipationBox, useParticipation } from '../components/Participation';
import { LeaderboardList } from '../components/LeaderboardList';
import { CompetitionStatusBadge, remainingText } from './Competitions';
import {
  cleanScore, clearConfirmed, draftStatus, errorsByMatch, singleFlight, submitBlocker, summarize,
  type DraftEntry, type DraftStatus, type DraftSummary, type Drafts,
} from '../lib/competitionDraft';

type Msg = { tone: 'info' | 'warn'; text: string };
type Confirmed = Record<string, { predictedHomeScore: number; predictedAwayScore: number; points: number | null }>;

export default function CompetitionDetail() {
  const { id = '' } = useParams();
  const detail = useAsync(() => api.competition(id), [id]);
  const matches = useAsync(() => api.competitionMatches(id), [id]);
  const board = useAsync(() => api.competitionLeaderboard(id), [id]);
  const { loggedIn, configured } = usePlan();
  const participation = useParticipation();
  const canPlay = participation.canPlay;
  const me = useAsync(() => (loggedIn || !configured ? api.competitionMyStats(id) : Promise.resolve(null)), [id, loggedIn, configured]);

  // Helyi vázlat – a beküldésig csak itt él
  const [drafts, setDrafts] = useState<Drafts>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  // A szerver által IGAZOLT mentés – amíg a lista újratöltése be nem fut, ezt mutatjuk (nincs ellentmondó állapot)
  const [confirmed, setConfirmed] = useState<Confirmed>({});
  useEffect(() => {
    setConfirmed({});
    // a szerver állapotával MÁR egyező vázlat (pl. hálózati hiba után mégis mentett csomag) fölösleges
    const list = matches.data ?? [];
    setDrafts((d) => {
      const stale = list.filter((m) => d[m.id] && draftStatus(m, d[m.id]) === 'saved').map((m) => m.id);
      return stale.length ? clearConfirmed(d, stale) : d;
    });
  }, [matches.data]);
  useEffect(() => { setDrafts({}); setItemErrors({}); setMsg(null); setConfirmOpen(false); }, [id]);

  const reload = () => { matches.reload(); board.reload(); me.reload(); participation.reload(); };

  const view = useMemo(() => (matches.data ?? []).map((m) => (confirmed[m.id] ? { ...m, myPrediction: confirmed[m.id] } : m)), [matches.data, confirmed]);
  const quota = me.data?.dailyQuota ?? null;
  const summary = useMemo(() => summarize(view, drafts), [view, drafts]);

  // A beküldés egyfutásos kapun át: dupla kattintás sem indít két kérést
  const submitRef = useRef<() => Promise<void>>(async () => {});
  submitRef.current = async () => {
    const items = summary.toSend;
    if (!items.length) return;
    setBusy(true); setMsg(null); setItemErrors({});
    try {
      const r = await api.submitCompetitionPredictions(id, items);
      const next: Confirmed = {};
      for (const s of r.saved) next[s.competitionMatchId] = { predictedHomeScore: s.prediction.predictedHomeScore, predictedAwayScore: s.prediction.predictedAwayScore, points: s.prediction.points };
      setConfirmed((c) => ({ ...c, ...next }));
      setDrafts((d) => clearConfirmed(d, r.saved.map((s) => s.competitionMatchId)));
      setConfirmOpen(false);
      const parts = [r.created && `${r.created} új`, r.updated && `${r.updated} módosított`, r.unchanged && `${r.unchanged} változatlan`].filter(Boolean).join(', ');
      setMsg({ tone: 'info', text: `${r.saved.length} tipp elmentve (${parts}).` });
      reload();
    } catch (e) {
      // A választások MEGMARADNAK; a szerver tételes hibáit a kártyákon jelezzük
      const err = e as ApiError;
      setItemErrors(errorsByMatch((err.details?.errors as BatchItemError[] | undefined)));
      setMsg({ tone: 'warn', text: `${err.message || 'A beküldés nem sikerült.'} A választásaid megmaradtak${err instanceof ApiError ? '' : ' – az ismételt beküldés nem hoz létre duplikált tippet'}.` });
      matches.reload(); me.reload();
    } finally { setBusy(false); }
  };
  const gate = useRef(singleFlight(() => submitRef.current()));
  const submit = () => { if (!busy) void gate.current(); };

  if (detail.loading) return <Loading text="Verseny betöltése…" />;
  if (detail.error) return <ErrorBox message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <EmptyState emoji="🏁" title="A tippverseny nem található" />;

  const c = detail.data.competition;
  // A napi tippkeretet a SZERVER adja (PRO-nál null). Itt csak megjelenítjük.
  const quotaUsedUp = !!quota && quota.remaining <= 0;
  const setDraft = (matchId: string, d: DraftEntry | null) => {
    setDrafts((all) => { const n = { ...all }; if (d) n[matchId] = d; else delete n[matchId]; return n; });
    setItemErrors((e) => { if (!(matchId in e)) return e; const n = { ...e }; delete n[matchId]; return n; });
    setConfirmOpen(false);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🏆"
        title={c.name}
        text={`${c.leagueName} · ${fmtDateTime(c.startsAt)} – ${fmtDateTime(c.endsAt)}`}
        right={<div className="flex items-center gap-2"><CompetitionStatusBadge status={c.status} /><Link to="/tippverseny" className="btn btn-sm">Összes verseny</Link></div>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="⏳" tone="primary" label={c.status === 'finished' ? 'Verseny' : 'Hátralévő idő'} value={c.status === 'finished' ? 'Lezárva' : remainingText(c.endsAt)} sub={c.status === 'active' ? 'a tippelési időszak vége' : 'kezdés: ' + fmtDateTime(c.startsAt)} />
        <StatCard icon="⚽" tone="neutral" label="Mérkőzés" value={matches.data?.length ?? '…'} sub="a versenyben" />
        <StatCard icon="🎯" tone="success" label="Saját pont" value={me.data?.points ?? '–'} sub={me.data ? `${me.data.predictions} tipp · ${me.data.exactHits} pontos találat` : 'bejelentkezés után'} />
        <StatCard icon="📊" tone="warning" label="Helyezés" value={me.data?.rank != null ? `${me.data.rank}.` : '–'} sub={me.data ? `${me.data.participants} résztvevő` : ''} />
      </div>

      <ParticipationBox p={participation} />

      {/* FREE napi tippkeret – tájékoztatás; a kikényszerítés a szerveren történik */}
      {quota && (
        <Note tone={quotaUsedUp ? 'warn' : 'info'}>
          <b>{quotaLabel(quota)}</b>{' '}
          {quotaUsedUp
            ? 'Új mérkőzésre ma már nem tudsz tippet leadni, a meglévő tippjeidet viszont a kezdésig módosíthatod. A keret holnap újraindul.'
            : `Még ${quota.remaining} új tippet adhatsz le ma. A már leadott tippek módosítása nem fogyasztja a keretet.`}
          <Link to="/pro" className="btn btn-sm btn-primary ml-2 mt-2 sm:mt-0">PRO: korlátlan tippelés</Link>
        </Note>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Mérkőzések */}
        <section className="min-w-0 space-y-3">
          <h2 className="section-title mb-0">Mérkőzések</h2>
          {canPlay && summary.open > 0 && (
            <p className="text-xs font-semibold text-text-muted">
              Add meg a tippjeidet, majd küldd be őket egyszerre a lenti <b>Tippek beküldése</b> gombbal. Nem kötelező minden mérkőzésre tippelni – a hiányzókat a kezdésig később is pótolhatod.
            </p>
          )}
          {msg && <Note tone={msg.tone}>{msg.text}</Note>}
          {matches.loading && !matches.data ? <Card><Loading /></Card>
            : matches.error ? <ErrorBox message={matches.error} onRetry={matches.reload} />
              : !view.length ? <EmptyState emoji="⚽" title="Még nincsenek mérkőzések" text="Az adminisztrátor hamarosan szinkronizálja a verseny mérkőzéseit." />
                : view.map((m) => (
                  <MatchCard
                    key={m.id} m={m} draft={drafts[m.id]} canPlay={canPlay} quotaUsedUp={quotaUsedUp}
                    disabled={busy} error={itemErrors[m.id] ?? null} onChange={(d) => setDraft(m.id, d)}
                  />
                ))}

          {canPlay && summary.open > 0 && (
            <div className="sticky bottom-3 z-20 space-y-3">
              {confirmOpen && (
                <ConfirmPanel summary={summary} matches={view} quota={quota} busy={busy} onCancel={() => setConfirmOpen(false)} onConfirm={submit} />
              )}
              <BatchBar summary={summary} blocker={submitBlocker(summary, quota)} busy={busy} confirmOpen={confirmOpen} onReview={() => setConfirmOpen(true)} />
            </div>
          )}
        </section>

        {/* Ranglista és szabályok */}
        <div className="space-y-4">
          <Card title="Ranglista">
            {board.loading ? <Loading /> : board.error ? <ErrorBox message={board.error} onRetry={board.reload} />
              : !board.data?.length ? <p className="text-sm font-semibold text-text-muted">Még senki nem adott le tippet.</p> : (
                <LeaderboardList rows={board.data} />
              )}
            <p className="mt-3 text-[11px] font-semibold text-text-muted">A ranglistán azonosításra alkalmas adat (pl. e-mail) nem jelenik meg.</p>
          </Card>

          <Card title="Pontozás">
            <ul className="space-y-2">
              {detail.data.scoring.map((s) => (
                <li key={s.label} className="flex items-start gap-2 text-sm font-semibold">
                  <span className="badge badge-blue shrink-0">{s.points} pont</span>
                  <span className="min-w-0"><b>{s.label}</b><span className="block text-xs font-semibold text-text-muted">{s.text}</span></span>
                </li>
              ))}
            </ul>
            <div className="mt-4 text-xs font-semibold text-text-muted">
              <b className="text-text">Holtverseny esetén</b> a sorrendet ez dönti el:
              <ol className="mt-1 list-decimal pl-4">{detail.data.tieBreak.map((t) => <li key={t}>{t}</li>)}</ol>
            </div>
          </Card>

          <Card title="Jutalmak">
            <ul className="space-y-1.5 text-sm font-semibold">
              <li className="flex items-center gap-2"><Trophy className="h-4 w-4 text-warning" /> 1. helyezett: 1 hónap PRO</li>
              <li className="flex items-center gap-2"><Trophy className="h-4 w-4 text-text-muted" /> 2. helyezett: 2 hét PRO</li>
              <li className="flex items-center gap-2"><Trophy className="h-4 w-4 text-[#b06a2c]" /> 3. helyezett: 1 hét PRO</li>
            </ul>
            <p className="mt-3 text-xs font-semibold text-text-muted">A jutalmat a verseny lezárása után az adminisztrátor adja át.</p>
          </Card>
        </div>
      </div>

      <Disclaimer />
    </div>
  );
}

const STATUS_BADGE: Record<DraftStatus, { cls: string; text: string } | null> = {
  locked: null,
  saved: { cls: 'badge-green', text: 'Tipp mentve' },
  changed: { cls: 'badge-yellow', text: 'Módosítva – beküldésre vár' },
  new: { cls: 'badge-blue', text: 'Új tipp – beküldésre vár' },
  incomplete: { cls: 'badge-red', text: 'Hiányos tipp' },
  missing: { cls: 'badge-muted', text: 'Nincs tipp' },
};

/** Egy mérkőzés kártyája: eredmény, mentett tipp, helyi tippmezők vagy zárolás. Mentési kérést NEM indít. */
export function MatchCard({ m, draft, canPlay, quotaUsedUp, disabled, error, onChange }: {
  m: CompetitionMatchView; draft: DraftEntry | undefined; canPlay: boolean;
  /** a mai FREE tippkeret elfogyott – ÚJ tipp nem adható le, a meglévő módosítható */
  quotaUsedUp: boolean;
  disabled: boolean;
  /** a szerver tételes hibája erre a meccsre (elutasított csomag) */
  error: string | null;
  onChange: (d: DraftEntry | null) => void;
}) {
  const status = draftStatus(m, draft);
  const hasResult = m.homeScore != null && m.awayScore != null;
  const editable = canPlay && !m.locked && !(quotaUsedUp && !m.myPrediction);
  const saved = m.myPrediction;
  const home = draft?.home ?? (saved ? String(saved.predictedHomeScore) : '');
  const away = draft?.away ?? (saved ? String(saved.predictedAwayScore) : '');
  const set = (h: string, a: string) => {
    // a mentett értékre visszaírt vázlat nem marad „módosított”
    if (saved && h === String(saved.predictedHomeScore) && a === String(saved.predictedAwayScore)) onChange(null);
    else if (!saved && h === '' && a === '') onChange(null);
    else onChange({ home: h, away: a });
  };
  const badge = editable ? STATUS_BADGE[status] : null;

  return (
    <div className={`card p-4 ${error ? 'border-danger/40' : status === 'new' || status === 'changed' ? 'border-primary/40' : ''}`} data-status={status}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-text-muted">
        <span>{fmtDateTime(m.kickoff).slice(0, 13)} {fmtTime(m.kickoff)}</span>
        {hasResult
          ? <span className="badge badge-blue">Eredmény: {m.homeScore}–{m.awayScore}</span>
          : m.locked ? <span className="badge badge-muted"><Lock className="h-3 w-3" /> Tippelés lezárva</span>
            : badge ? <span className={`badge ${badge.cls}`}>{badge.text}</span>
              : <span className="badge badge-green">Tippelhető</span>}
      </div>

      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
        <div className="truncate text-right text-base font-extrabold">{m.homeTeam}</div>
        <div className="text-xs font-extrabold uppercase tracking-widest text-text-muted">vs</div>
        <div className="truncate text-base font-extrabold">{m.awayTeam}</div>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {editable ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <input className="input !w-16 text-center" inputMode="numeric" value={home} disabled={disabled}
              onChange={(e) => set(cleanScore(e.target.value), away)} aria-label={`${m.homeTeam} tippelt gólszáma`} />
            <span className="font-extrabold text-text-muted">–</span>
            <input className="input !w-16 text-center" inputMode="numeric" value={away} disabled={disabled}
              onChange={(e) => set(home, cleanScore(e.target.value))} aria-label={`${m.awayTeam} tippelt gólszáma`} />
            {draft && (
              <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange(null)}>
                <Undo2 className="h-3.5 w-3.5" /> {saved ? `Vissza: ${saved.predictedHomeScore}–${saved.predictedAwayScore}` : 'Törlés'}
              </button>
            )}
            {saved && status !== 'changed' && saved.points != null && <span className="badge badge-green">{saved.points} pont</span>}
          </div>
        ) : saved ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold">
              Saját tipped: <span className="mono text-base font-extrabold">{saved.predictedHomeScore}–{saved.predictedAwayScore}</span>
            </span>
            {saved.points != null && <span className="badge badge-green">{saved.points} pont</span>}
          </div>
        ) : (
          <p className="text-center text-sm font-semibold text-text-muted">
            {m.locked
              ? (m.lockReason ?? 'Erre a mérkőzésre már nem lehet tippelni.')
              : !canPlay
                ? 'A részvételhez jelentkezz be, és állíts be egy megjelenítési nevet.'
                : 'Mai tippkereted elfogyott – erre a mérkőzésre holnap tudsz tippelni.'}
          </p>
        )}
        {status === 'incomplete' && editable && <p className="mt-2 text-center text-xs font-bold text-danger">Add meg mindkét csapat gólszámát, vagy töröld a tippet.</p>}
        {error && <div className="mt-2"><Note tone="warn">{error}</Note></div>}
      </div>
    </div>
  );
}

/** Ragadós összesítő sáv: hány meccsre van tipp, mi vár beküldésre, és a beküldés gombja. */
export function BatchBar({ summary, blocker, busy, confirmOpen, onReview }: {
  summary: DraftSummary; blocker: string | null; busy: boolean; confirmOpen: boolean; onReview: () => void;
}) {
  const pending = summary.toSend.length;
  return (
    <div className="card border-primary/30 p-3 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold">
          <div><b>{summary.withTip}/{summary.open}</b> tippelhető mérkőzésre van tipped</div>
          <div className="text-xs text-text-muted">
            Beküldésre vár: <b className="text-text">{pending}</b>
            {pending > 0 && ` (${summary.newCount} új, ${summary.changedCount} módosított)`}
            {summary.missing.length > 0 && <> · Hiányzik: <b className="text-text">{summary.missing.length}</b></>}
          </div>
        </div>
        <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={onReview} disabled={busy || confirmOpen || !!blocker}>
          <Send className="h-4 w-4" /> {busy ? 'Beküldés…' : `Tippek beküldése${pending ? ` (${pending})` : ''}`}
        </button>
      </div>
      {blocker && pending + summary.incomplete.length > 0 && <p className="mt-2 text-xs font-bold text-warning">{blocker}</p>}
    </div>
  );
}

/** Beküldés előtti összesítés: mi megy be, mi hiányzik, mennyit fogyaszt a napi keretből. */
export function ConfirmPanel({ summary, matches, quota, busy, onCancel, onConfirm }: {
  summary: DraftSummary; matches: CompetitionMatchView[]; quota: { remaining: number; limit: number } | null;
  busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  return (
    <div className="card max-h-[60vh] overflow-y-auto p-4 shadow-lg" role="dialog" aria-label="Tippek beküldésének összesítése">
      <h3 className="text-base font-extrabold">Beküldés előtt ellenőrizd</h3>
      <p className="mt-1 text-sm font-semibold">
        <b>{summary.toSend.length}</b> tipp kerül beküldésre ({summary.newCount} új, {summary.changedCount} módosított).
        {quota && summary.newCount > 0 && ` Az új tippek ${summary.newCount}-et használnak fel a mai ${quota.remaining} szabad helyből.`}
      </p>
      <ul className="mt-3 divide-y divide-border text-sm font-semibold">
        {summary.toSend.map((t) => {
          const m = byId.get(t.competitionMatchId);
          return (
            <li key={t.competitionMatchId} className="flex items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 truncate">{m ? `${m.homeTeam} – ${m.awayTeam}` : t.competitionMatchId}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className={`badge ${m?.myPrediction ? 'badge-yellow' : 'badge-blue'}`}>{m?.myPrediction ? 'Módosított' : 'Új'}</span>
                <span className="mono font-extrabold">{t.predictedHomeScore}–{t.predictedAwayScore}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {summary.missing.length > 0 && (
        <div className="mt-3">
          <Note tone="warn">
            <b>{summary.missing.length} tippelhető mérkőzésre nincs tipped:</b>{' '}
            {summary.missing.map((m) => `${m.homeTeam} – ${m.awayTeam}`).join(', ')}. Ezekre most nem küldesz tippet – a kezdésig később is pótolhatod.
          </Note>
        </div>
      )}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Vissza a tippekhez</button>
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
          <Send className="h-4 w-4" /> {busy ? 'Beküldés…' : `${summary.toSend.length} tipp beküldése`}
        </button>
      </div>
    </div>
  );
}
