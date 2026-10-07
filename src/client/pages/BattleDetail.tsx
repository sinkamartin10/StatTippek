/**
 * 1v1 Tipp Battle – részletek.
 *
 * Az ellenfél tippjét KICKOFF ELŐTT a szerver egyáltalán nem adja vissza
 * (`opponentPrediction: null`), csak azt, hogy adott-e már tippet. A kitakarás
 * tehát szerveroldali; itt csak megjelenítjük, amit kapunk.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import type { BattleMatchView, BattleView } from '@shared/battles';
import { BATTLE_OUTCOME_LABEL } from '@shared/battles';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime, useAsync } from '../lib/format';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { Player } from './Battles';

export default function BattleDetail() {
  const { id = '' } = useParams();
  const data = useAsync(() => api.battle(id), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const act = async (what: 'accept' | 'decline' | 'cancel') => {
    setBusy(what); setMsg(null);
    try {
      if (what === 'accept') await api.acceptBattle(id);
      else if (what === 'decline') await api.declineBattle(id);
      else await api.cancelBattle(id);
      data.reload();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); data.reload(); }
    finally { setBusy(null); }
  };

  if (data.loading) return <Loading text="Párbaj betöltése…" />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!data.data) return <EmptyState emoji="⚔️" title="A párbaj nem található" />;

  const b: BattleView = data.data;
  const mine = b.iAmChallenger ? b.challenger : b.opponent;
  const other = b.iAmChallenger ? b.opponent : b.challenger;
  const myDone = b.matches.filter((m) => m.myPrediction).length;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="⚔️"
        title="1v1 Battle"
        text={`${b.matches.length} mérkőzés · ${b.statusLabel}`}
        right={<Link to="/battles" className="btn btn-sm">Összes párbaj</Link>}
      />

      {/* Fejléc: a két játékos és az állás */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Player p={mine} size={56} />
          <div className="text-center">
            <div className="mono text-2xl font-extrabold">
              {mine.points ?? '–'} : {other.points ?? '–'}
            </div>
            {b.myOutcome
              ? <span className={`badge ${b.myOutcome === 'win' ? 'badge-green' : b.myOutcome === 'loss' ? 'badge-muted' : 'badge-blue'}`}>
                {BATTLE_OUTCOME_LABEL[b.myOutcome]}
              </span>
              : <span className="badge badge-muted">{b.statusLabel}</span>}
          </div>
          <Player p={other} size={56} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="📝" tone="primary" label="Saját tippek" value={`${myDone} / ${b.matches.length}`} sub="leadva" />
        <StatCard icon="👤" tone="neutral" label="Ellenfél tippjei" value={`${other.predictions} / ${b.matches.length}`} sub="leadva" />
        <StatCard icon="⏳" tone="warning" label="Állapot" value={b.statusLabel} sub={b.status === 'pending' ? `lejár: ${fmtDateTime(b.inviteExpiresAt)}` : ''} />
        <StatCard icon="🏁" tone="success" label="Lezárva" value={b.settledAt ? fmtDateTime(b.settledAt) : '–'} sub={b.settledAt ? '' : 'még folyamatban'} />
      </div>

      {(b.canAccept || b.canDecline || b.canCancel) && (
        <div className="flex flex-wrap gap-2">
          {b.canAccept && <button className="btn btn-primary" onClick={() => act('accept')} disabled={busy === 'accept'}>Elfogadom</button>}
          {b.canDecline && <button className="btn" onClick={() => act('decline')} disabled={busy === 'decline'}>Elutasítom</button>}
          {b.canCancel && <button className="btn" onClick={() => act('cancel')} disabled={busy === 'cancel'}>Visszavonom</button>}
        </div>
      )}

      {msg && <Note tone={msg.tone}>{msg.text}</Note>}

      {b.status === 'pending' && (
        <Note>A tippeket a párbaj elfogadása után lehet leadni, a mérkőzések kezdéséig.</Note>
      )}

      <section className="space-y-3">
        <h2 className="section-title mb-0">Mérkőzések</h2>
        {b.matches.map((m) => (
          <MatchRow key={m.competitionMatchId} battleId={b.id} m={m} opponentName={other.displayName} onSaved={data.reload} />
        ))}
      </section>
    </div>
  );
}

function MatchRow({ battleId, m, opponentName, onSaved }: {
  battleId: string; m: BattleMatchView; opponentName: string; onSaved: () => void;
}) {
  const [home, setHome] = useState(String(m.myPrediction?.predictedHomeScore ?? ''));
  const [away, setAway] = useState(String(m.myPrediction?.predictedAwayScore ?? ''));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [editing, setEditing] = useState(!m.myPrediction);

  const save = async () => {
    const h = parseInt(home, 10), a = parseInt(away, 10);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) {
      setMsg({ tone: 'warn', text: 'Adj meg mindkét csapatnak egy 0 vagy annál nagyobb egész számot.' });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      await api.submitBattlePrediction(battleId, m.competitionMatchId, h, a);
      setMsg({ tone: 'info', text: 'Tipp elmentve.' });
      setEditing(false);
      onSaved();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const hasResult = m.homeScore != null && m.awayScore != null;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-text-muted">
        <span>{fmtDateTime(m.kickoff).slice(0, 13)} {fmtTime(m.kickoff)}</span>
        {hasResult
          ? <span className="badge badge-blue">Eredmény: {m.homeScore}–{m.awayScore}</span>
          : m.open ? <span className="badge badge-green">Tippelhető</span>
            : <span className="badge badge-muted"><Lock className="h-3 w-3" /> Lezárva</span>}
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="truncate text-right text-base font-extrabold">{m.homeTeam}</div>
        <div className="text-xs font-extrabold uppercase tracking-widest text-text-muted">vs</div>
        <div className="truncate text-base font-extrabold">{m.awayTeam}</div>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {m.open && editing ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <input className="input !w-16 text-center" inputMode="numeric" value={home}
              onChange={(e) => setHome(e.target.value.replace(/\D/g, '').slice(0, 2))}
              aria-label={`${m.homeTeam} tippelt gólszáma`} />
            <span className="font-extrabold text-text-muted">–</span>
            <input className="input !w-16 text-center" inputMode="numeric" value={away}
              onChange={(e) => setAway(e.target.value.replace(/\D/g, '').slice(0, 2))}
              aria-label={`${m.awayTeam} tippelt gólszáma`} />
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Mentés…' : m.myPrediction ? 'Tipp módosítása' : 'Tipp leadása'}
            </button>
            {m.myPrediction && <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Mégse</button>}
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-card-2 p-2.5">
              <span className="block text-xs font-bold text-text-muted">Saját tipp</span>
              {m.myPrediction ? (
                <span className="flex items-center gap-2">
                  <span className="mono text-base font-extrabold">
                    {m.myPrediction.predictedHomeScore}–{m.myPrediction.predictedAwayScore}
                  </span>
                  {m.myPrediction.points != null && <span className="badge badge-green">{m.myPrediction.points} pont</span>}
                  {m.open && <button className="btn btn-sm ml-auto" onClick={() => setEditing(true)}>Módosítás</button>}
                </span>
              ) : (
                <span className="text-sm font-semibold text-text-muted">
                  {m.open ? 'Még nem tippeltél.' : (m.lockReason ?? 'Nem adtál tippet.')}
                </span>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card-2 p-2.5">
              <span className="block truncate text-xs font-bold text-text-muted">{opponentName} tippje</span>
              {m.opponentPrediction ? (
                <span className="flex items-center gap-2">
                  <span className="mono text-base font-extrabold">
                    {m.opponentPrediction.predictedHomeScore}–{m.opponentPrediction.predictedAwayScore}
                  </span>
                  {m.opponentPrediction.points != null && <span className="badge badge-green">{m.opponentPrediction.points} pont</span>}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-sm font-semibold text-text-muted">
                  <Lock className="h-3.5 w-3.5" />
                  {m.opponentHasPredicted ? 'Tippelt – a kezdés után látható.' : 'Még nem tippelt.'}
                </span>
              )}
            </div>
          </div>
        )}
        {msg && <div className="mt-2"><Note tone={msg.tone}>{msg.text}</Note></div>}
      </div>
    </div>
  );
}
