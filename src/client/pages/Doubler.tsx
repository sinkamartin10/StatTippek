/**
 * Duplázó – kezdőösszegből célösszeg felé, lépésenként kb. 2,00-s összoddsú szelvényekkel, KIZÁRÓLAG a
 * felhasználó által kiválasztott nap mérkőzéseiből (alapértelmezés: ma). Másik napra soha nem keres.
 *
 * A szelvényeket a MEGLÉVŐ szelvényépítő adja (`GET /api/slips`, PRO – a szerver dönti el); a felület
 * csak kiválasztja a duplázáshoz illő, megfelelő adatú jelöltet, és lépésekbe rendezi (lásd
 * `lib/doubler`). Oddsot, mérkőzést vagy tippet nem pótol: ahol nincs megfelelő szelvény, azt jelzi.
 * A kifizetés becslés; fogadást nem ad fel, pénzt nem kezel.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate, fmtDateTime, fmtTime, odds as fo, pct, todayKey } from '../lib/format';
import {
  DEFAULT_STAKE, MAX_DAYS_AHEAD, MAX_STEPS, NO_DOUBLER_TEXT, RETRY_DELAYS_MS, TARGET_PRESETS, buildChain, chainForDate, chainProbability,
  checkDoublerDate, firstKickoff, fmtFt, jointProbOf, legReason, parseAmount, planSteps,
  type ChainProgress, type ChainResult, type ChainStep, type Plan,
} from '../lib/doubler';
import { LockedBlock, usePlan } from '../auth/PlanContext';
import { Card, ChipGroup, Disclaimer, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';
import { Matchup, splitMatchLabel } from '../components/TeamCrest';

/** A nap felirata: „ma”, „holnap”, különben a dátum. */
export const dayLabel = (date: string) => (date === todayKey() ? 'ma' : date === todayKey(1) ? 'holnap' : fmtDate(`${date}T12:00:00`));
/** A nap teljes felirata a dátummal (pl. „ma, 2026. 10. 25.”). */
const dayFull = (date: string) => {
  const d = fmtDate(`${date}T12:00:00`);
  const l = dayLabel(date);
  return l === d ? d : `${l}, ${d}`;
};

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
      right={slip && <span className="text-xs font-bold text-text">Kezdés: {dayLabel(step.date)}, {fmtTime(firstKickoff(slip))}</span>}
    >
      {!slip ? (
        step.incomplete
          ? <EmptyState emoji="⚠️" title="A keresés nem fejeződött be" text={step.note ?? undefined} />
          : <EmptyState emoji="🧩" title={step.note === NO_DOUBLER_TEXT ? NO_DOUBLER_TEXT : 'Nincs megfelelő szelvény'} text={step.note === NO_DOUBLER_TEXT ? undefined : step.note ?? undefined} />
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
                    <div className="text-xs font-semibold text-text-muted">{l.leagueName} · kezdés: {fmtDateTime(l.kickoff)}</div>
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
  const [date, setDate] = useState(todayKey());
  const [stakeText, setStakeText] = useState(String(DEFAULT_STAKE));
  const [targetChoice, setTargetChoice] = useState<string>(String(TARGET_PRESETS[0]));
  const [customText, setCustomText] = useState('');
  const [progress, setProgress] = useState<ChainProgress | null>(null);
  const [result, setResult] = useState<ChainResult | null>(null);
  const [error, setError] = useState<{ date: string; message: string } | null>(null);
  /** a legutóbb indított generálás – egy korábbi, később befejeződő futás nem írhatja felül az újabbat */
  const runId = useRef(0);

  const today = todayKey();
  const lastDay = todayKey(MAX_DAYS_AHEAD);
  const dateError = checkDoublerDate(date, today, lastDay);
  const stake = parseAmount(stakeText);
  const target = targetChoice === 'custom' ? parseAmount(customText) : Number(targetChoice);
  const plan = planSteps(stake, target);
  const running = progress != null;
  const chain = chainForDate(result, date);
  const shownError = error && error.date === date ? error.message : null;

  /** Bármely beállítás változásakor a korábbi eredmény eltűnik (a régi szelvények nem maradhatnak félrevezetően). */
  const reset = () => { setResult(null); setError(null); };

  const run = async () => {
    if (!plan.ok || running || dateError) return;
    const id = ++runId.current;
    const forDate = date;
    reset();
    setProgress({ step: 1, attempt: 1 });
    try {
      // a lekérés időkorlátja a `signal`-on át érvényesül (lásd lib/doubler: fetchDayWithRetry)
      const steps = await buildChain(plan.rows, forDate, (params, signal) => api.slips(params, { signal }), (p) => { if (id === runId.current) setProgress(p); });
      if (id === runId.current) setResult({ date: forDate, chain: steps });
    } catch (e) {
      if (id === runId.current) setError({ date: forDate, message: e instanceof Error ? e.message : 'Ismeretlen hiba.' });
    } finally {
      if (id === runId.current) setProgress(null);
    }
  };

  const generate = (ev: FormEvent) => { ev.preventDefault(); void run(); };

  const chance = chain ? chainProbability(chain) : null;
  const complete = chain != null && chance != null;
  const incomplete = chain?.some((s) => s.incomplete) ?? false;
  const noneAtAll = chain != null && !chain[0]?.slip && !incomplete;
  const progressText = progress && `${progress.step}. lépés összeállítása (${dayFull(date)})${progress.attempt > 1 ? ` – újrapróbálkozás (${progress.attempt}/${RETRY_DELAYS_MS.length + 1})` : ''}`;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="✌️"
        title="Duplázó"
        text="Válassz napot, add meg a kezdő- és a célösszeget: a kiválasztott nap mérkőzéseiből lépésenként egy-egy kb. 2,00-s összoddsú szelvényt állítunk össze a meglévő elemzésekből és valódi oddsokból."
      />

      <Note tone="warn">
        <b>Minden lépés egy újabb kockázat.</b> A következő lépés csak az előző szelvény nyerése után indulhat; egyetlen vesztes szelvény az egész
        sorozatot megszakítja, és a tét elveszik. A kifizetések becslések, nem garantált nyeremények. Legfeljebb {MAX_STEPS} lépés tervezhető.
      </Note>

      <Card title="Beállítások">
        <form onSubmit={generate} className="space-y-4">
          <label className="field-label block max-w-xs">
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4 text-primary" aria-hidden /> Nap</span>
            <input
              type="date"
              className="input mt-1.5"
              value={date}
              min={today}
              max={lastDay}
              disabled={running}
              onChange={(e) => { setDate(e.target.value); reset(); }}
            />
          </label>
          {dateError && <p role="alert" className="text-sm font-semibold text-danger">{dateError}</p>}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="field-label min-w-0">Kezdőösszeg (Ft)
              <input className="input mt-1.5" inputMode="numeric" value={stakeText} onChange={(e) => { setStakeText(e.target.value); reset(); }} />
            </label>
            <div className="min-w-0">
              <span className="field-label">Célösszeg</span>
              <div className="mt-1.5">
                <ChipGroup
                  ariaLabel="Célösszeg"
                  value={targetChoice}
                  onChange={(v) => { setTargetChoice(v); reset(); }}
                  options={[...TARGET_PRESETS.map((t) => ({ value: String(t), label: fmtFt(t) })), { value: 'custom', label: 'Egyéni' }]}
                />
              </div>
              {targetChoice === 'custom' && (
                <label className="field-label mt-3 block">Egyéni célösszeg (Ft)
                  <input className="input mt-1.5" inputMode="numeric" placeholder="pl. 10 000" value={customText} onChange={(e) => { setCustomText(e.target.value); reset(); }} />
                </label>
              )}
            </div>
          </div>

          <PlanTable plan={plan} target={target} />

          {!dateError && (
            <p className="text-sm font-semibold text-text-muted" data-doubler-day>
              A szelvények erre a napra készülnek: <b className="text-text">{dayFull(date)}</b> – kizárólag ennek a napnak a még el nem kezdődött mérkőzéseiből.
            </p>
          )}

          {pro ? (
            <div className="flex justify-end">
              <button type="submit" className="btn btn-primary" disabled={!plan.ok || running || !!dateError}>
                <Sparkles className="h-4 w-4" aria-hidden /> {running ? 'Keresés folyamatban…' : 'Szelvény generálása'}
              </button>
            </div>
          ) : null}
        </form>
      </Card>

      {!pro ? (
        <LockedBlock title="Duplázó – PRO" text="A szelvényeket a PRO szelvényépítő állítja össze a teljes elemzésből és valódi oddsokból – PRO előfizetéssel." />
      ) : running && !chain ? (
        <Card><Loading text={`${progressText} – egy forgalmas nap első elemzése akár percekig is tarthat…`} /></Card>
      ) : shownError ? (
        <ErrorBox message={shownError} />
      ) : chain && (
        <section aria-label="Lépések" className="space-y-4">
          {incomplete ? (
            <Note tone="warn">
              <span className="block">
                A szelvények lekérése többszöri próbálkozás után sem sikerült (a szerver nem válaszolt időben, vagy megszakadt a kapcsolat).
                Ez nem azt jelenti, hogy nincs megfelelő tipp: a szerver közben jellemzően befejezi az elemzést, így néhány perc múlva az újrapróbálás gyors lehet.
              </span>
              <button type="button" className="btn btn-sm mt-2" onClick={() => void run()}>Újrapróbálás</button>
            </Note>
          ) : noneAtAll ? (
            <Note tone="warn">{NO_DOUBLER_TEXT}</Note>
          ) : complete ? (
            <Note>
              Mind a(z) {chain.length} lépéshez van szelvény ({dayFull(date)}). A teljes sorozat esélye a modell szerint <b>{pct(chance, 1)}</b> – a lépések
              esélyeinek szorzata, ezért minden további lépéssel csökken.
            </Note>
          ) : (
            <Note tone="warn">
              A kiválasztott napon nincs elég megfelelő mérkőzés minden lépéshez – a sorozat a jelzett lépésnél megáll. Másik napra nem keresünk;
              válassz kisebb célösszeget vagy másik napot.
            </Note>
          )}
          {!noneAtAll && !incomplete && (
            <Note tone="warn">
              Az oddsok a generálás pillanatában érvényesek (a meglévő elemzésből). A fogadás idejéig változhatnak, ezért a becsült kifizetés is –
              fogadás előtt mindig ellenőrizd az aktuális oddsot.
            </Note>
          )}
          {chain.map((s, i) => <StepCard key={s.row.step} step={s} isLast={i === chain.length - 1} />)}
        </section>
      )}

      <Disclaimer />
    </div>
  );
}
