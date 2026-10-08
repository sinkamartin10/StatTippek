/**
 * 1v1 Tipp Battle – lista és új párbaj indítása.
 *
 * Minden állapotot, korlátot és jogosultságot a SZERVER ad meg; a felület csak
 * megjelenít, és a gombokkal kérést indít. A választható ellenfelek köre is
 * szerveroldali (a Tippverseny ranglistáján szereplő, nevet beállított
 * játékosok), ezért itt nincs és nem is lehet felhasználó-keresés.
 *
 * A párbaj NEM PRO funkció: FREE és PRO felhasználó ugyanazt teheti.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Swords } from 'lucide-react';
import type { BattleView, EligibleMatch, EligibleOpponent } from '@shared/battles';
import { sameDisplayName } from '@shared/displayName';
import { BATTLE_MATCH_COUNT, BATTLE_OUTCOME_LABEL } from '@shared/battles';
import type { AvatarSlot } from '@shared/progression';
import { TITLES } from '@shared/progression';
import { api, ApiError } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { Avatar } from '../components/Avatar';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader, StatCard } from '../components/ui';
import { usePlan } from '../auth/PlanContext';

export const titleName = (key?: string): string | null =>
  (!key || key === 'none' ? null : TITLES.find((t) => t.key === key)?.name ?? null);

/** Résztvevő megjelenítése: kizárólag display name, avatar, keret és cím. */
export function Player({ p, size = 40 }: { p: BattleView['challenger']; size?: number }) {
  const title = titleName(p.titleKey);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar avatar={p.avatar as Partial<Record<AvatarSlot, string>>} border={p.borderKey} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-extrabold">{p.displayName}</span>
        {title && <span className="block truncate text-xs font-bold text-text-muted">{title}</span>}
      </span>
    </span>
  );
}

function remaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'lejárt';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h} óra ${m} perc` : `${m} perc`;
}

export default function Battles() {
  const { loggedIn, configured } = usePlan();
  // A nyilvános profilról érkező kihívás: `?kihivas=<megjelenítési név>`.
  // CSAK előválasztás – a jogosultságot és a párosítást a szerver dönti el.
  const [params] = useSearchParams();
  const invited = params.get('kihivas') ?? '';
  const data = useAsync(() => api.battles(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const act = async (id: string, what: 'accept' | 'decline' | 'cancel') => {
    setBusy(id + what); setMsg(null);
    try {
      if (what === 'accept') await api.acceptBattle(id);
      else if (what === 'decline') await api.declineBattle(id);
      else await api.cancelBattle(id);
      setMsg({ tone: 'info', text: what === 'accept' ? 'Párbaj elfogadva – jöhetnek a tippek!' : 'Rendben.' });
      data.reload();
    } catch (e) {
      setMsg({ tone: 'warn', text: (e as Error).message });
      data.reload();
    } finally { setBusy(null); }
  };

  if (!loggedIn && configured) {
    return (
      <div className="space-y-6">
        <PageHeader emoji="⚔️" title="1v1 Battle" text="Hívj ki egy másik tippelőt 3 mérkőzésre." />
        <Note>
          A párbajokhoz jelentkezz be.
          <Link to="/bejelentkezes" className="btn btn-sm btn-primary ml-2 mt-2 sm:mt-0">Bejelentkezés</Link>
        </Note>
      </div>
    );
  }

  if (data.loading) return <Loading text="Párbajok betöltése…" />;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!data.data) return null;

  const d = data.data;
  const total = d.incoming.length + d.outgoing.length + d.active.length + d.settled.length;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="⚔️"
        title="1v1 Battle"
        text={`Hívj ki egy másik tippelőt ${d.limits.matchCount} mérkőzésre. Aki több pontot szerez, nyer.`}
        right={<Link to="/tippverseny" className="btn btn-sm">Tippverseny</Link>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="📥" tone="warning" label="Bejövő kihívás" value={d.incoming.length} sub="rád várnak" />
        <StatCard icon="📤" tone="neutral" label="Kimenő kihívás" value={d.outgoing.length} sub={`max ${d.limits.maxPending} nyitott`} />
        <StatCard icon="⚔️" tone="primary" label="Folyamatban" value={d.active.length} sub="aktív párbaj" />
        <StatCard icon="🏁" tone="success" label="Lezárva" value={d.settled.length} sub="befejezett" />
      </div>

      {msg && <Note tone={msg.tone}>{msg.text}</Note>}

      <NewBattle invited={invited} onCreated={() => { data.reload(); setMsg({ tone: 'info', text: 'Kihívás elküldve.' }); }} />

      {d.incoming.length > 0 && (
        <Card title="📥 Bejövő kihívások">
          <ul className="space-y-3">
            {d.incoming.map((b) => (
              <li key={b.id} className="rounded-xl border border-warning/30 bg-warning-soft p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Player p={b.challenger} />
                  <span className="text-xs font-bold text-text-muted">kihívott · lejár: {remaining(b.inviteExpiresAt)}</span>
                  <span className="ml-auto flex gap-2">
                    <Link to={`/battles/${b.id}`} className="btn btn-sm">Megnézem</Link>
                    <button className="btn btn-sm btn-primary" onClick={() => act(b.id, 'accept')} disabled={busy === b.id + 'accept'}>
                      {busy === b.id + 'accept' ? 'Elfogadás…' : 'Elfogadom'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => act(b.id, 'decline')} disabled={busy === b.id + 'decline'}>
                      Elutasítom
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.outgoing.length > 0 && (
        <Card title="📤 Elküldött kihívások">
          <ul className="space-y-3">
            {d.outgoing.map((b) => (
              <li key={b.id} className="rounded-xl border border-border bg-card-2 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Player p={b.opponent} />
                  <span className="text-xs font-bold text-text-muted">válaszra vár · lejár: {remaining(b.inviteExpiresAt)}</span>
                  <span className="ml-auto flex gap-2">
                    <Link to={`/battles/${b.id}`} className="btn btn-sm">Megnézem</Link>
                    <button className="btn btn-sm btn-ghost" onClick={() => act(b.id, 'cancel')} disabled={busy === b.id + 'cancel'}>
                      Visszavonom
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {d.active.length > 0 && (
        <Card title="⚔️ Folyamatban">
          <ul className="space-y-3">{d.active.map((b) => <BattleRow key={b.id} b={b} />)}</ul>
        </Card>
      )}

      {d.settled.length > 0 && (
        <Card title="🏁 Lezárt párbajok">
          <ul className="space-y-3">{d.settled.map((b) => <BattleRow key={b.id} b={b} />)}</ul>
        </Card>
      )}

      {total === 0 && (
        <EmptyState
          emoji="⚔️"
          title="Még nincs párbajod"
          text={`Válassz ki egy ellenfelet és ${BATTLE_MATCH_COUNT} mérkőzést, és indulhat a párbaj.`}
        />
      )}
    </div>
  );
}

function BattleRow({ b }: { b: BattleView }) {
  const mine = b.iAmChallenger ? b.challenger : b.opponent;
  const other = b.iAmChallenger ? b.opponent : b.challenger;
  const tone = b.myOutcome === 'win' ? 'border-success/30 bg-success-soft'
    : b.myOutcome === 'loss' ? 'border-danger/25 bg-danger-soft'
      : 'border-border bg-card-2';
  return (
    <li className={`rounded-xl border p-3 ${tone}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Player p={mine} size={32} />
        <span className="mono text-sm font-extrabold">
          {mine.points ?? '–'} : {other.points ?? '–'}
        </span>
        <Player p={other} size={32} />
        <span className="ml-auto flex items-center gap-2">
          {b.myOutcome && <span className="badge badge-blue">{BATTLE_OUTCOME_LABEL[b.myOutcome]}</span>}
          {!b.myOutcome && <span className="badge badge-muted">{b.statusLabel}</span>}
          <Link to={`/battles/${b.id}`} className="btn btn-sm">Részletek</Link>
        </span>
      </div>
    </li>
  );
}

/** Új párbaj: ellenfél + pontosan 3 mérkőzés. A korlátot a szerver is kikényszeríti. */
function NewBattle({ invited = '', onCreated }: { invited?: string; onCreated: () => void }) {
  const opponents = useAsync<EligibleOpponent[]>(() => api.battleEligibleOpponents(), []);
  const matches = useAsync<EligibleMatch[]>(() => api.battleEligibleMatches(), []);
  const [opponent, setOpponent] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * A profilról hozott nevet a BETÖLTÖTT, szerveroldali listához kötjük. Ha a
   * név nincs a kihívhatók között, nem történik semmi – nem találunk ki
   * azonosítót, és a választás továbbra is a felhasználóé.
   */
  useEffect(() => {
    if (!invited || opponent || !opponents.data?.length) return;
    const match = opponents.data.find((o) => sameDisplayName(o.displayName, invited));
    if (match) setOpponent(match.userId);
  }, [invited, opponent, opponents.data]);

  const toggle = (id: string) => setPicked((cur) =>
    cur.includes(id) ? cur.filter((x) => x !== id)
      : cur.length >= BATTLE_MATCH_COUNT ? cur : [...cur, id]);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.createBattle(opponent, picked);
      setOpponent(''); setPicked([]);
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    } finally { setBusy(false); }
  };

  const ready = !!opponent && picked.length === BATTLE_MATCH_COUNT;

  return (
    <Card title="➕ Új párbaj" right={<span className="text-xs font-bold text-text-muted">{picked.length} / {BATTLE_MATCH_COUNT} mérkőzés</span>}>
      {opponents.loading || matches.loading ? <Loading text="Betöltés…" /> : (
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-extrabold uppercase tracking-wide text-text-muted" htmlFor="battle-opponent">
              Ellenfél
            </label>
            {!opponents.data?.length ? (
              <Note>Jelenleg nincs kihívható játékos. Kihívni a Tippverseny ranglistáján szereplő játékosokat lehet.</Note>
            ) : (
              <select id="battle-opponent" className="input" value={opponent} onChange={(e) => setOpponent(e.target.value)}>
                <option value="">Válassz ellenfelet…</option>
                {opponents.data.map((o) => <option key={o.userId} value={o.userId}>{o.displayName}</option>)}
              </select>
            )}
          </div>

          <div>
            <span className="mb-1 block text-xs font-extrabold uppercase tracking-wide text-text-muted">
              Válassz pontosan {BATTLE_MATCH_COUNT} mérkőzést
            </span>
            {!matches.data?.length ? (
              <Note>Jelenleg nincs tippelhető mérkőzés. Nézz vissza, ha indul új forduló.</Note>
            ) : (
              <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {matches.data.map((m) => {
                  const on = picked.includes(m.competitionMatchId);
                  return (
                    <li key={m.competitionMatchId}>
                      <label className={`flex cursor-pointer items-center gap-2.5 rounded-xl border p-2.5 text-sm font-semibold ${on ? 'border-primary/40 bg-primary-soft' : 'border-border bg-card-2'}`}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0"
                          checked={on}
                          onChange={() => toggle(m.competitionMatchId)}
                          disabled={!on && picked.length >= BATTLE_MATCH_COUNT}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-extrabold">{m.homeTeam} – {m.awayTeam}</span>
                          <span className="block truncate text-xs text-text-muted">{m.leagueName} · {fmtDateTime(m.kickoff)}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {err && <Note tone="warn">{err}</Note>}

          <button className="btn btn-primary" onClick={submit} disabled={!ready || busy}>
            <Swords className="h-4 w-4" /> {busy ? 'Kihívás küldése…' : 'Kihívás elküldése'}
          </button>
        </div>
      )}
    </Card>
  );
}
