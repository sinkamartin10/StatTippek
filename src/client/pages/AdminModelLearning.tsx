/**
 * Modell-tanulás – admin irányítópult (V1, CSAK MEGFIGYELŐ).
 *
 * Kizárólag a meglévő, csak olvasó admin végpontokat hívja:
 *   GET /api/admin/model-learning/status       – állapot, jelöltek, események, küszöbök
 *   GET /api/admin/model-learning/diagnostics  – az alap motor hibaelemzése
 * Nincs kiértékelést, aktiválást vagy visszaállítást indító gomb. A felületi
 * védelem csak kényelmi: a jogosultságot a szerver ellenőrzi (requireAdmin,
 * ADMIN_EMAILS) – jogosulatlan hívásra 401/403.
 */
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, ErrorBar, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import type { DiagnosticsGroup, DiagnosticsReport, LearningStatus } from '@shared/modelLearning';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import {
  CANDIDATE_STATUS_LABEL, EVENT_LABEL, NOT_AVAILABLE, NO_DATA, eventSummary, fmtCi, fmtInt, fmtNum, fmtPct, fmtTime, lastEventAt,
  naiveComparable, parseCandidate, promotionRequirements, smallSample,
} from '../lib/learningDashboard';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';

const AX = { stroke: '#6d7894', fontSize: 11, fontWeight: 700 };
const GRID = '#e2e7f3';

export default function AdminModelLearning() {
  const status = useAsync(() => api.adminLearningStatus(), []);
  const diag = useAsync(() => api.adminLearningDiagnostics(), []);
  const busy = status.loading || diag.loading;
  // a frissítés csak a két csak olvasó GET-et ismétli – modellt, tippet, adatbázist nem érint
  const refresh = () => { if (!busy) { status.reload(); diag.reload(); } };

  if (status.loading && !status.data) return <Loading text="Jogosultság és modellállapot ellenőrzése…" />;
  if (status.error && !status.data) return <AccessError message={status.error} onRetry={status.reload} />;
  const s = status.data!;
  const d = diag.data;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🧪"
        title="Modell-tanulás – admin"
        text="Megfigyelő nézet: az éles modell (xg-poisson-1) tényleges teljesítménye, hibái és a jelöltmodellek állapota. Ez az oldal semmit nem módosít."
        right={(
          <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy} aria-busy={busy}>
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> {busy ? 'Frissítés…' : 'Diagnosztika frissítése'}
          </button>
        )}
      />

      {status.error && <ErrorBox message={`Az állapot frissítése sikertelen: ${status.error}`} onRetry={status.reload} />}
      {diag.error && <ErrorBox message={`A diagnosztika nem tölthető be: ${diag.error}`} onRetry={diag.reload} />}

      <TopCards s={s} d={d} diagLoading={diag.loading} />

      {d && !d.sufficiency.enoughForConclusions && (
        <Note tone="warn">
          <strong>A minta nem elegendő következtetéshez.</strong> A látható különbségek véletlen ingadozásból is adódhatnak – javulás vagy romlás nem állítható.
          <ul className="mt-1 list-disc pl-5">{d.sufficiency.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </Note>
      )}

      {diag.loading && !d ? <Card title="Modellminőség"><Loading text="Diagnosztika számítása…" /></Card> : d && (
        <>
          <Quality d={d} />
          <Calibration d={d} />
          <Breakdown d={d} s={s} />
        </>
      )}

      <CandidateSection s={s} />
      <Events s={s} />

      <Card title="Mi kell ahhoz, hogy egy jelölt egyáltalán szóba jöhessen élesítésre?">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">{promotionRequirements(s).map((r) => <li key={r}>{r}</li>)}</ol>
      </Card>

      <p className="text-xs text-muted">
        Módszertani megjegyzés: a mérőszámok (log loss, Brier, kalibráció) a tippek EREDETI, rögzített modell-valószínűségéből számolnak; a találati arány önmagában nem minőségi mérce, és egy vesztes tipp nem modellhiba. Pénzügyi eredményességről (odds, megtérülés) ez az oldal nem állít semmit.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Hiba / jogosulatlan hozzáférés: érzékeny adat nélkül. */
export function AccessError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const forbidden = /jogosultság|Bejelentkezés/i.test(message);
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader emoji="🔒" title="Modell-tanulás – admin" />
      <ErrorBox message={message} onRetry={onRetry} />
      {forbidden && <Note tone="warn">Ehhez az oldalhoz adminisztrátori fiók szükséges. Az adminisztrátorokat a szerver <code>ADMIN_EMAILS</code> beállítása határozza meg.</Note>}
      <Link to="/" className="btn">Vissza a kezdőlapra</Link>
    </div>
  );
}

function Kv({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-border/60 py-1.5 first:border-t-0">
      <span className="text-xs font-semibold text-text-muted">{k}</span>
      <span className="mono text-right text-sm font-bold">{v}{sub && <span className="block text-[11px] font-semibold text-text-muted">{sub}</span>}</span>
    </div>
  );
}

export function TopCards({ s, d, diagLoading }: { s: LearningStatus; d: DiagnosticsReport | null; diagLoading: boolean }) {
  const latest = s.candidates[0] ? parseCandidate(s.candidates[0]) : null;
  const run = s.lastRun.summary;
  const stateChange = lastEventAt(s.recentEvents, ['promotion', 'rollback']);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card title="Éles modell">
        <Kv k="Kiszolgált modell" v={s.servedModel} />
        <Kv k="Aktív kalibráció" v={s.activeModelId ?? 'nincs (alap motor)'} />
        <Kv k="Állapotverzió" v={fmtInt(s.stateVersion)} />
        <Kv k="Utolsó állapotváltás" v={stateChange ? fmtTime(stateChange) : 'Nem volt (nincs rögzített aktiválás/visszaállítás)'} />
      </Card>
      <Card title="Adatmennyiség">
        {d ? (
          <>
            <Kv k="Kiértékelhető tipp" v={fmtInt(d.sizes.observations)} />
            <Kv k="Különálló mérkőzés" v={fmtInt(d.sizes.matches)} />
            <Kv k="Lefedett időszak" v={d.period ? `${fmtTime(d.period.firstKickoff)} – ${fmtTime(d.period.lastKickoff)}` : NO_DATA} sub={d.period ? `${d.period.distinctKickoffDays} kezdési nap` : undefined} />
            <Kv k="Utolsó eredményfeldolgozás" v={NOT_AVAILABLE} sub="az elszámolás ideje nincs a tanulási végpontokon" />
          </>
        ) : <div className="text-sm font-semibold text-text-muted">{diagLoading ? 'Betöltés…' : NOT_AVAILABLE}</div>}
      </Card>
      <Card title="Jelöltmodell">
        {latest ? (
          <>
            <Kv k="Jelölt" v={latest.id} />
            <Kv k="Állapot" v={CANDIDATE_STATUS_LABEL[latest.status] ?? latest.status} />
            <Kv k="Tanító / valid. / holdout meccs" v={`${fmtInt(latest.sizes.trainMatches)} / ${fmtInt(latest.sizes.validationMatches)} / ${fmtInt(latest.sizes.holdoutMatches)}`} />
          </>
        ) : (
          <>
            <Kv k="Jelölt" v="Nincs jelölt" />
            <Kv k="Utolsó kiértékelés" v={run ? run.outcome : 'Még nem futott'} sub={run?.sizes ? `minta: ${fmtInt(run.sizes.trainMatches)} / ${fmtInt(run.sizes.validationMatches)} / ${fmtInt(run.sizes.holdoutMatches)} meccs` : undefined} />
          </>
        )}
        {(latest?.statusReason || (!latest && run?.reasons?.length)) && (
          <p className="mt-2 text-xs font-semibold text-text-muted">{latest?.statusReason ?? run!.reasons[run!.reasons.length - 1]}</p>
        )}
      </Card>
      <Card title="Biztonság">
        <Kv k="Automatikus előléptetés" v="Nincs (csak explicit admin-döntés)" />
        <Kv k="Aktiválás a szerveren" v={s.promotionEnabled ? 'Engedélyezett' : 'Tiltva'} />
        <Kv k="Futó művelet" v={s.locked ? 'Fut egy kiértékelés (zár aktív)' : 'Nincs'} />
        <Kv k="Utolsó kiértékelés" v={s.lastRun.finishedAt ? fmtTime(s.lastRun.finishedAt) : 'Még nem futott'} sub={s.lastRun.status ?? undefined} />
        <Kv k="Diagnosztika" v={d ? fmtTime(d.generatedAt) : NOT_AVAILABLE} sub="kéréskor számolva, nem tárolt" />
      </Card>
    </div>
  );
}

export function Quality({ d }: { d: DiagnosticsReport }) {
  const nb = d.naiveBaseline;
  const comparable = naiveComparable(d);
  const chart = comparable && nb ? [
    { metric: 'Log loss', 'Éles modell': nb.model.logLoss, 'Naiv baseline': nb.baseline.logLoss },
    { metric: 'Brier', 'Éles modell': nb.model.brier, 'Naiv baseline': nb.baseline.brier },
  ] : [];
  return (
    <Card title="Modellminőség – log loss és Brier-score (kisebb = jobb)">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Éles modell – teljes kiértékelhető minta</div>
          {d.model ? (
            <>
              <Kv k="Minta" v={`${fmtInt(d.model.matches)} meccs · ${fmtInt(d.model.observations)} tipp`} />
              <Kv k="Log loss" v={fmtNum(d.model.logLoss)} />
              <Kv k="Brier-score" v={fmtNum(d.model.brier)} />
              <Kv k="Kalibrációs hiba (ECE)" v={fmtNum(d.model.ece)} />
            </>
          ) : <EmptyState title="Nincs kiértékelhető adat" text="Még nincs lezárt, kezdés előtti tipp." />}
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Páros összevetés a naiv baseline-nal – AZONOS mintán</div>
          {comparable && nb ? (
            <>
              <Kv k="Közös minta" v={`${fmtInt(nb.coveredMatches)} meccs · ${fmtInt(nb.coveredObservations)} tipp`} sub={`${fmtInt(nb.uncoveredObservations)} tippnél nem volt elég korábbi adat a baseline-hoz`} />
              <Kv k="Log loss: modell / baseline" v={`${fmtNum(nb.model.logLoss)} / ${fmtNum(nb.baseline.logLoss)}`} />
              <Kv k="Brier: modell / baseline" v={`${fmtNum(nb.model.brier)} / ${fmtNum(nb.baseline.brier)}`} />
              <Kv k="Modell-előny (log loss)" v={fmtNum(nb.modelLogLossAdvantage, 5)} sub={`95% CI: ${fmtCi(nb.modelLogLossAdvantageCi, 5)}`} />
              <p className="mt-2 text-xs font-semibold text-text-muted">
                {nb.modelLogLossAdvantageCi[0] > 0 ? 'A modell a közös mintán kimutathatóan jobb a naiv baseline-nál (az intervallum teljesen 0 fölött).'
                  : nb.modelLogLossAdvantageCi[1] < 0 ? 'A modell a közös mintán kimutathatóan gyengébb a naiv baseline-nál.'
                    : 'Nincs kimutatható különbség: az intervallum tartalmazza a 0-t.'}
              </p>
            </>
          ) : <EmptyState title="Nincs páros összevetés" text="A naiv baseline-hoz nincs elég korábbi, ismert kimenetelű adat." />}
        </div>
      </div>
      {chart.length > 0 && (
        <div className="mt-4">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="metric" tick={AX} />
              <YAxis tick={AX} />
              <Tooltip formatter={(v) => fmtNum(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar isAnimationActive={false} dataKey="Éles modell" fill="#4f6ef7" radius={[6, 6, 0, 0]} />
              <Bar isAnimationActive={false} dataKey="Naiv baseline" fill="#6d7894" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-muted">A grafikon csak a közös (páros) minta értékeit mutatja; a teljes mintás érték bal oldalt külön szerepel, mert más mintán mért.</p>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">{nb?.description ?? ''}</p>
    </Card>
  );
}

export function Calibration({ d }: { d: DiagnosticsReport }) {
  const pts = d.reliability.filter((b) => b.observations > 0 && b.meanPredicted != null && b.observedRate != null && b.observedCi)
    .map((b) => ({ x: b.meanPredicted!, y: b.observedRate!, n: b.observations, err: [b.observedRate! - b.observedCi![0], b.observedCi![1] - b.observedRate!] }));
  return (
    <Card title="Kalibráció – előrejelzett valószínűség vs. tényleges gyakoriság">
      {pts.length === 0 ? <EmptyState title="Nincs kalibrációs adat" text="Még nincs lezárt, kezdés előtti tipp." /> : (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <ScatterChart margin={{ top: 10, right: 16, bottom: 16, left: 0 }}>
              <CartesianGrid stroke={GRID} />
              <XAxis type="number" dataKey="x" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={AX} name="előrejelzett"
                label={{ value: 'előrejelzett valószínűség', position: 'insideBottom', offset: -8, fill: '#6d7894', fontSize: 11 }} />
              <YAxis type="number" dataKey="y" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={AX} name="tényleges" />
              <ZAxis type="number" dataKey="n" range={[40, 220]} name="minta" />
              <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#17b877" strokeDasharray="5 4" ifOverflow="extendDomain" />
              <Tooltip formatter={(v, name) => (name === 'minta' ? String(v) : fmtPct(Number(v)))} />
              <Scatter isAnimationActive={false} data={pts} fill="#4f6ef7">
                <ErrorBar dataKey="err" direction="y" stroke="#4f6ef7" width={4} />
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
          <p className="text-xs text-muted">A szaggatott átló a tökéletes kalibráció. Pont: sávonkénti átlagos előrejelzés és tényleges gyakoriság; függőleges vonal: 95%-os Wilson-intervallum; pontméret: minta.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="table">
              <thead><tr><th>Sáv</th><th>Tipp</th><th>Előrejelzett</th><th>Tényleges</th><th>95% intervallum</th></tr></thead>
              <tbody>
                {d.reliability.map((b) => (
                  <tr key={b.from}>
                    <td className="mono">{fmtPct(b.from, 0)}–{fmtPct(b.to, 0)}</td>
                    <td className="mono">{b.observations}{b.observations > 0 && b.observations < 30 && <span className="badge badge-yellow ml-1.5">kis minta</span>}</td>
                    <td className="mono">{fmtPct(b.meanPredicted)}</td>
                    <td className="mono">{fmtPct(b.observedRate)}</td>
                    <td className="mono">{b.observedCi ? `${fmtPct(b.observedCi[0])} – ${fmtPct(b.observedCi[1])}` : NO_DATA}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function GroupTable({ rows, s, empty }: { rows: DiagnosticsGroup[]; s: LearningStatus; empty: string }) {
  if (!rows.length) return <div className="py-3 text-sm font-semibold text-text-muted">{empty}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead><tr><th>Csoport</th><th>Meccs / tipp</th><th>Átl. előrejelzés</th><th>Tényleges</th><th>Log loss</th><th>Brier</th></tr></thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key}>
              <td>{g.key}{smallSample(g.matches, g.observations, s.thresholds) && <span className="badge badge-yellow ml-1.5" title={`Kevesebb mint ${s.thresholds.marketGuardMinMatches} meccs vagy ${s.thresholds.marketGuardMinObservations} tipp`}>kis minta</span>}</td>
              <td className="mono">{fmtInt(g.matches)} / {fmtInt(g.observations)}</td>
              <td className="mono">{fmtPct(g.meanPredicted)}</td>
              <td className="mono">{fmtPct(g.observedRate)}</td>
              <td className="mono">{fmtNum(g.logLoss)}</td>
              <td className="mono">{fmtNum(g.brier)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Breakdown({ d, s }: { d: DiagnosticsReport; s: LearningStatus }) {
  return (
    <Card title="Bontás piac és liga szerint">
      <p className="mb-2 text-xs text-muted">Ábécérendben, rangsor nélkül. A különböző piacok log loss-a eltérő alapgyakoriság miatt közvetlenül nem összevethető; „kis minta” jelöléssel a backend piac-őrének küszöbe alatti csoportok.</p>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Piactípus</div>
      <GroupTable rows={d.byMarketType} s={s} empty="Nincs adat." />
      <div className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-muted">Liga (csak legalább {s.thresholds.marketGuardMinMatches} meccsel)</div>
      <GroupTable rows={d.byLeague} s={s} empty={`Egyik ligában sincs legalább ${s.thresholds.marketGuardMinMatches} kiértékelhető meccs – ligabontás még nem értelmezhető.`} />
    </Card>
  );
}

export function CandidateSection({ s }: { s: LearningStatus }) {
  if (!s.candidates.length) {
    const run = s.lastRun.summary;
    return (
      <Card title="Jelöltmodell">
        <EmptyState title="Nincs jelöltmodell" text={run ? `Az utolsó kiértékelés eredménye: ${run.outcome}. ${run.reasons.join(' ')}` : 'Kiértékelés még nem futott. Jelölt csak admin által indított kiértékeléssel, elegendő adatnál jön létre.'} />
      </Card>
    );
  }
  const c = parseCandidate(s.candidates[0]);
  const h = c.holdout;
  return (
    <Card title={`Jelöltmodell – ${c.id}`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <Kv k="Állapot" v={CANDIDATE_STATUS_LABEL[c.status] ?? c.status} />
          <Kv k="Létrehozva" v={fmtTime(c.createdAt)} />
          <Kv k="Tanító / validációs / holdout meccs" v={`${fmtInt(c.sizes.trainMatches)} / ${fmtInt(c.sizes.validationMatches)} / ${fmtInt(c.sizes.holdoutMatches)}`} sub={`${fmtInt(c.sizes.holdoutObservations)} holdout-tipp`} />
          <Kv k="Kapuk" v={c.gatePassed == null ? NO_DATA : c.gatePassed ? 'Teljesültek' : 'Nem teljesültek'} />
        </div>
        <div>
          {h && h.samePairedSample ? (
            <>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Holdout – azonos mintán ({fmtInt(h.baseline.matches)} meccs)</div>
              <Kv k="Log loss: éles / jelölt" v={`${fmtNum(h.baseline.logLoss)} / ${fmtNum(h.candidate.logLoss)}`} />
              <Kv k="Brier: éles / jelölt" v={`${fmtNum(h.baseline.brier)} / ${fmtNum(h.candidate.brier)}`} />
              <Kv k="Log loss-különbség (éles − jelölt)" v={fmtNum(h.logLossDelta, 5)} sub={`95% CI: ${fmtCi(h.logLossDeltaCi, 5)}`} />
              <Kv k="Brier-különbség (éles − jelölt)" v={fmtNum(h.brierDelta, 5)} />
            </>
          ) : <EmptyState title="Nincs összevethető holdout" text="A jelölthöz nincs azonos mintán mért éles/jelölt összevetés." />}
        </div>
      </div>
      {c.marketWarnings.length > 0 && (
        <Note tone="warn">
          Romlás piactípusonként (holdout): {c.marketWarnings.map((m) => `${m.key} ${fmtPct(m.relativeChange)}${m.guarded ? '' : ' (kis minta, nem kapu)'}`).join(' · ')}
        </Note>
      )}
      {c.gateReasons.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs font-semibold text-text-muted">{c.gateReasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <p className="mt-2 text-xs text-muted">Aktiválás és visszaállítás erről az oldalról nem indítható.</p>
    </Card>
  );
}

export function Events({ s }: { s: LearningStatus }) {
  const tone = { ok: 'badge-green', warn: 'badge-yellow', error: 'badge-red', info: 'badge-muted' } as const;
  return (
    <Card title="Tanulási eseménynapló (legutóbbi 20)">
      {s.recentEvents.length === 0 ? (
        <EmptyState title="Nincs rögzített esemény" text="Kiértékelés, árnyék-kiértékelés vagy állapotváltás még nem történt." />
      ) : (
        <ul className="divide-y divide-border/60">
          {s.recentEvents.map((e, i) => {
            const sum = eventSummary(e);
            return (
              <li key={`${e.at}-${i}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2 text-sm">
                <span className="mono text-xs text-text-muted">{fmtTime(e.at)}</span>
                <span className="font-bold">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                <span className={`badge ${tone[sum.status]}`}>{sum.status === 'ok' ? 'rendben' : sum.status === 'warn' ? 'figyelem' : sum.status === 'error' ? 'hiba' : 'info'}</span>
                {e.modelId && <span className="mono text-xs text-text-muted">{e.modelId}</span>}
                {sum.text && <span className="basis-full text-xs font-semibold text-text-muted">{sum.text}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">Az eredmény-elszámolás és a diagnosztika nem kerül az eseménynaplóba (a diagnosztika kéréskor számolódik); teljes eseménytörténethez külön fejlesztés kell.</p>
    </Card>
  );
}
