/**
 * Duplázó – kezdőösszegből célösszeg felé, lépésenként kb. 2,00-s összoddsú szelvényekkel.
 *
 * A szelvényeket a MEGLÉVŐ szelvényépítő adja (`GET /api/slips`, PRO – a szerver dönti el); a felület
 * csak kiválasztja a duplázáshoz illő, megfelelő adatú jelöltet, és lépésekbe rendezi (lásd
 * `lib/doubler`). Oddsot, mérkőzést vagy tippet nem pótol: ahol nincs megfelelő szelvény, azt jelzi.
 * A kifizetés becslés; fogadást nem ad fel, pénzt nem kezel.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, fmtTime, odds as fo, pct, todayKey } from '../lib/format';
import {
  DEFAULT_STAKE, MAX_STEPS, SEARCH_DAYS, TARGET_PRESETS, buildChain, chainProbability, firstKickoff, fmtFt, jointProbOf, legReason, parseAmount, planSteps,
  type ChainStep, type Plan,
} from '../lib/doubler';
import { LockedBlock, usePlan } from '../auth/PlanContext';
import { Card, ChipGroup, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { Matchup, splitMatchLabel } from '../components/TeamCrest';

const dayLabel = (date: string) => (date === todayKey() ? 'ma' : date === todayKey(1) ? 'holnap' : fmtDate(`${date}T12:00:00`));

/** A tervezett lépések táblázata (a duplázás matematikája – tipp nélkül is látható). */
export function PlanTable({ plan, target }: { plan: Plan; target: number | null }) {
  if (!plan.ok) return <p role="alert" className="text-sm font-semibold text-danger">{plan.error}</p>;
  return (
    <div className="space-y-3">
      <div className="-mx-5 overflow-x-auto px-5">
        <table className="table">
          <thead><tr><th>Lépés</th><th className="text-right">Kezdőösszeg</th><th className="text-right">Célösszeg</th></tr></thead>
          <tbody>
            {plan.rows.map((r) => (
              <tr key={r.step}>
                <td className="font-bold">{r.step}.</td>
                <td className="mono text-right">{fmtFt(r.stake)}</td>
                <td className="mono text-right font-extrabold">{fmtFt(r.goal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm font-semibold text-text-muted">
        {plan.steps} lépés szükséges{plan.exact ? '.' : ' – a cél pontos duplázással nem érhető el.'}
        {!plan.exact && target != null && (
          <> Legközelebbi elérhető összegek: {plan.lower != null && <><b className="text-text">{fmtFt(plan.lower)}</b> ({plan.steps - 1} lépés) és </>}
            <b className="text-text">{fmtFt(plan.upper)}</b> ({plan.steps} lépés). A terv a {fmtFt(plan.upper)}-ig számol.</>
        )}
      </p>
    </div>
  );
}

/** Egy lépés szelvénye – vagy annak őszinte jelzése, hogy nincs megfelelő szelvény. */
export function StepCard({ step, isLast }: { step: ChainStep; isLast: boolean }) {
  const { row, slip } = step;
  return (
    <Card
      title={<span>{row.step}. lépés · {fmtFt(row.stake)} → kb. {fmtFt(row.goal)}</span>}
      right={slip
        ? <span className="text-xs font-bold text-text">Kezdés: {dayLabel(step.date)}, {fmtTime(firstKickoff(slip))}</span>
        : step.searched && <span className="text-xs font-semibold text-text-muted">Vizsgált napok: {dayLabel(step.searched.from)} – {dayLabel(step.searched.to)}</span>}
    >
      {!slip ? (
        <EmptyState emoji="🧩" title="Nincs megfelelő szelvény" text={step.note ?? undefined} />
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2">
            {slip.legs.map((l) => (
              <li key={l.matchId + l.market} className="rounded-xl border border-border bg-card-2 p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/meccs/${encodeURIComponent(l.matchId)}#tippek`} className="flex min-w-0 font-extrabold transition hover:text-primary">
                      <Matchup home={splitMatchLabel(l.matchLabel)[0]} away={splitMatchLabel(l.matchLabel)[1]} homeLogo={l.homeLogo} awayLogo={l.awayLogo} />
                    </Link>
                    <div className="text-xs font-semibold text-text-muted">{l.leagueName} · {fmtDateTime(l.kickoff)}</div>
                  </div>
                  <div className="mono shrink-0 text-right text-base font-extrabold" title="A tipp oddsa">{fo(l.odds)}</div>
                </div>
                <div className="mt-1.5 font-extrabold">{l.label}</div>
                <div className="mt-0.5 text-xs font-semibold text-text-muted">{legReason(l)}</div>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-card-2 p-2.5"><div className="text-[10px] font-extrabold uppercase tracking-wide text-text-muted">Összodds</div><div className="mono text-lg font-extrabold">{fo(step.totalOdds)}</div></div>
            <div className="rounded-xl bg-card-2 p-2.5"><div className="text-[10px] font-extrabold uppercase tracking-wide text-text-muted">Tét</div><div className="mono text-lg font-extrabold">{fmtFt(row.stake)}</div></div>
            <div className="rounded-xl bg-primary-soft p-2.5"><div className="text-[10px] font-extrabold uppercase tracking-wide text-primary-strong">Becsült kifizetés</div><div className="mono text-lg font-extrabold">{fmtFt(step.payout!)}</div></div>
          </div>
          <p className="text-xs font-semibold text-text-muted">
            {fmtFt(row.stake)} × {fo(step.totalOdds)} = {fmtFt(step.payout!)} bruttó – becslés, nem garantált nyeremény.
            {' '}A modell szerint a szelvény esélye {pct(jointProbOf(slip.legs), 0)}.
          </p>
          {!isLast && (
            <p className="text-xs font-bold text-warning-text">
              A {row.step + 1}. lépés csak akkor indulhat {fmtFt(row.goal)}-tal, ha ez a szelvény nyert. Egy vesztes szelvény megszakítja a sorozatot.
              {' '}Az időrend becsült lezárással számol (kezdés + kb. 2,5 óra); hosszabbítás, csúszás vagy halasztás esetén várd meg a szelvény tényleges elszámolását.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Doubler() {
  const { pro } = usePlan();
  const [stakeText, setStakeText] = useState(String(DEFAULT_STAKE));
  const [targetChoice, setTargetChoice] = useState<string>(String(TARGET_PRESETS[0]));
  const [customText, setCustomText] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [chain, setChain] = useState<ChainStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stake = parseAmount(stakeText);
  const target = targetChoice === 'custom' ? parseAmount(customText) : Number(targetChoice);
  const plan = planSteps(stake, target);
  const running = progress != null;

  const generate = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!plan.ok || running) return;
    setError(null);
    setChain(null);
    try {
      setChain(await buildChain(plan.rows, todayKey, api.slips, setProgress));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ismeretlen hiba.');
    } finally {
      setProgress(null);
    }
  };

  const chance = chain ? chainProbability(chain) : null;
  const complete = chain != null && chance != null;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="✌️"
        title="Duplázó"
        text="Add meg a kezdő- és a célösszeget: lépésenként egy-egy kb. 2,00-s összoddsú szelvényt állítunk össze a meglévő elemzésekből és valódi oddsokból."
      />

      <Note tone="warn">
        <b>Minden lépés egy újabb kockázat.</b> A következő lépés csak az előző szelvény nyerése után indulhat; egyetlen vesztes szelvény az egész
        sorozatot megszakítja, és a tét elveszik. A kifizetések becslések, nem garantált nyeremények. Legfeljebb {MAX_STEPS} lépés tervezhető.
      </Note>

      <Card title="Beállítások">
        <form onSubmit={generate} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="field-label min-w-0">Kezdőösszeg (Ft)
              <input className="input mt-1.5" inputMode="numeric" value={stakeText} onChange={(e) => { setStakeText(e.target.value); setChain(null); }} />
            </label>
            <div className="min-w-0">
              <span className="field-label">Célösszeg</span>
              <div className="mt-1.5">
                <ChipGroup
                  ariaLabel="Célösszeg"
                  value={targetChoice}
                  onChange={(v) => { setTargetChoice(v); setChain(null); }}
                  options={[...TARGET_PRESETS.map((t) => ({ value: String(t), label: fmtFt(t) })), { value: 'custom', label: 'Egyéni' }]}
                />
              </div>
              {targetChoice === 'custom' && (
                <label className="field-label mt-3 block">Egyéni célösszeg (Ft)
                  <input className="input mt-1.5" inputMode="numeric" placeholder="pl. 10 000" value={customText} onChange={(e) => { setCustomText(e.target.value); setChain(null); }} />
                </label>
              )}
            </div>
          </div>

          <PlanTable plan={plan} target={target} />

          {pro ? (
            <div className="flex justify-end">
              <button type="submit" className="btn btn-primary" disabled={!plan.ok || running}>
                <Sparkles className="h-4 w-4" aria-hidden /> {running ? `${progress}. lépés összeállítása…` : 'Szelvény generálása'}
              </button>
            </div>
          ) : null}
        </form>
      </Card>

      {!pro ? (
        <LockedBlock title="Duplázó – PRO" text="A szelvényeket a PRO szelvényépítő állítja össze a teljes elemzésből és valódi oddsokból – PRO előfizetéssel." />
      ) : running && !chain ? (
        <Card><Loading text={`${progress}. lépés: szelvény keresése napról napra (legfeljebb ${SEARCH_DAYS} nap) – első alkalommal ez eltarthat egy ideig…`} /></Card>
      ) : error ? (
        <ErrorBox message={error} />
      ) : chain && (
        <section aria-label="Lépések" className="space-y-4">
          {complete ? (
            <Note>
              Mind a(z) {chain.length} lépéshez van szelvény. A teljes sorozat esélye a modell szerint <b>{pct(chance, 1)}</b> – a lépések
              esélyeinek szorzata, ezért minden további lépéssel csökken.
            </Note>
          ) : (
            <Note tone="warn">
              Nem minden lépéshez állítható össze megfelelő szelvény – a sorozat a jelzett lépésnél megszakad. Kitalált tippeket nem jelenítünk meg;
              próbáld újra később, vagy válassz kisebb célösszeget.
            </Note>
          )}
          <Note tone="warn">
            Az oddsok a generálás pillanatában érvényesek (a meglévő elemzésből). A későbbi lépések oddsai a fogadás idejéig változhatnak,
            ezért a becsült kifizetés is – fogadás előtt mindig ellenőrizd az aktuális oddsot.
          </Note>
          {chain.map((s, i) => <StepCard key={s.row.step} step={s} isLast={i === chain.length - 1} />)}
        </section>
      )}

      <Disclaimer />
    </div>
  );
}
