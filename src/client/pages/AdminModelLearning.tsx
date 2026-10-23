/**
 * Modell-tanulás – admin irányítópult (MEGFIGYELŐ).
 *
 * Hívott admin végpontok:
 *   GET  /api/admin/model-learning/status       – állapot, jelöltek, események, küszöbök
 *   GET  /api/admin/model-learning/diagnostics  – az alap motor hibaelemzése (oldalbetöltéskor; nem rögzít)
 *   GET  /api/admin/model-learning/history      – a rögzített diagnosztikai futások
 *   POST /api/admin/model-learning/snapshots    – CSAK a „Diagnosztika frissítése” gomb: kiszámítás + egyszeri rögzítés
 * Nincs kiértékelést, aktiválást vagy visszaállítást indító gomb. A felületi
 * védelem csak kényelmi: a jogosultságot a szerver ellenőrzi (requireAdmin,
 * ADMIN_EMAILS) – jogosulatlan hívásra 401/403.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, ErrorBar, Legend, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import type { DiagnosticRun, DiagnosticsGroup, DiagnosticsReport, LearningStatus } from '@shared/modelLearning';
import { api } from '../lib/api';
import { useAsync } from '../lib/format';
import {
  CANDIDATE_STATUS_LABEL, EVENT_LABEL, NOT_AVAILABLE, NO_DATA, eventSummary, fmtCi, fmtInt, fmtNum, fmtPct, fmtTime, lastEventAt,
  historyPoints, historyRows, naiveComparable, newIdempotencyKey, parseCandidate, promotionRequirements, singleFlight, smallSample,
} from '../lib/learningDashboard';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';

const AX = { stroke: '#6d7894', fontSize: 11, fontWeight: 700 };
const GRID = '#e2e7f3';

export default function AdminModelLearning() {
  const status = useAsync(() => api.adminLearningStatus(), []);
  // oldalbetöltéskor csak olvasunk: a riport nem rögzül, és az előzmény is csak lekérdezés
  const diag = useAsync(() => api.adminLearningDiagnostics(), []);
  const history = useAsync(() => api.adminLearningHistory(30), []);
  const [snap, setSnap] = useState<{ running: boolean; error: string | null; message: string | null; fresh: DiagnosticsReport | null }>(
    { running: false, error: null, message: null, fresh: null });
  const busy = snap.running || status.loading || diag.loading;

  /**
   * „Diagnosztika frissítése”: EGY kattintás = EGY idempotencia-kulcs = legfeljebb EGY rögzített futás.
   * Futás közben a gomb tiltott; hiba esetén kifejezetten jelezzük, hogy nem történt rögzítés.
   */
  const run = async () => {
    const key = newIdempotencyKey();
    setSnap((x) => ({ ...x, running: true, error: null, message: null }));
    try {
      const out = await api.adminLearningSnapshot(key);
      setSnap({
        running: false, error: null, fresh: out.report ?? null,
        message: out.replayed ? `Ez a futás már rögzült (${fmtTime(out.run.createdAt)}) – új rekord nem készült.` : `A diagnosztikai futás rögzült (${fmtTime(out.run.createdAt)}).`,
      });
      if (!out.report) diag.reload();
    } catch (e) {
      setSnap((x) => ({ ...x, running: false, message: null, error: `A diagnosztika NEM rögzült: ${(e as Error).message}` }));
    } finally {
      history.reload();
      status.reload();
    }
  };
  // szinkron kapu: a gyors ismételt kattintás sem indít második futást (a React-állapot frissülése előtt sem)
  const runRef = useRef(run);
  runRef.current = run;
  const gate = useRef<(() => Promise<unknown>) | null>(null);
  gate.current ??= singleFlight(() => runRef.current());
  const refresh = () => { if (!busy) void gate.current!(); };

  if (status.loading && !status.data) return <Loading text="Jogosultság és modellállapot ellenőrzése…" />;
  if (status.error && !status.data) return <AccessError message={status.error} onRetry={status.reload} />;
  const s = status.data!;
  const d = snap.fresh ?? diag.data;
  const lastRecorded = history.data?.runs[0]?.createdAt ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        emoji="🧪"
        title="Modell-tanulás – admin"
        text="Megfigyelő nézet: az éles modell (xg-poisson-1) tényleges teljesítménye, hibái és a jelöltmodellek állapota. Ez az oldal semmit nem módosít."
        right={(
          <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy} aria-busy={busy}>
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> {snap.running ? 'Számítás és rögzítés…' : busy ? 'Betöltés…' : 'Diagnosztika frissítése'}
          </button>
        )}
      />

      {snap.error && <ErrorBox message={snap.error} />}
      {snap.message && <Note>{snap.message}</Note>}
      {status.error && <ErrorBox message={`Az állapot frissítése sikertelen: ${status.error}`} onRetry={status.reload} />}
      {diag.error && <ErrorBox message={`A diagnosztika nem tölthető be: ${diag.error}`} onRetry={diag.reload} />}

      <TopCards s={s} d={d} diagLoading={diag.loading} lastRecorded={lastRecorded} />

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

      <HistorySection runs={history.data?.runs ?? null} error={history.error} loading={history.loading} />

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

export function TopCards({ s, d, diagLoading, lastRecorded = null }: { s: LearningStatus; d: DiagnosticsReport | null; diagLoading: boolean; lastRecorded?: string | null }) {
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
        <Kv k="Utolsó rögzített diagnosztika" v={lastRecorded ? fmtTime(lastRecorded) : 'Még nincs rögzített futás'} />
        <Kv k="Megjelenített riport" v={d ? fmtTime(d.generatedAt) : NOT_AVAILABLE} sub="az oldalbetöltéskori számítás nem rögzül" />
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

// ---------------------------------------------------------------------------
// Diagnosztikai előzmények
// ---------------------------------------------------------------------------

function HistoryChart({ runs, metric, title }: { runs: DiagnosticRun[]; metric: 'logLoss' | 'brier' | 'ece' | 'advantage'; title: string }) {
  const { enough, insufficient } = historyPoints(runs, metric);
  if (!enough.length && !insufficient.length) {
    return <div><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{title}</div><div className="py-6 text-center text-sm font-semibold text-text-muted">{NO_DATA}</div></div>;
  }
  const fmtT = (v: number) => new Date(v).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' });
  const tip = ({ active, payload }: { active?: boolean; payload?: { payload: { t: number; value: number; matches: number; observations: number; enough: boolean; err?: [number, number] } }[] }) => {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="rounded-lg border border-border bg-card p-2 text-xs shadow-soft">
        <div className="font-bold">{fmtTime(new Date(p.t).toISOString())}</div>
        <div className="mono">{fmtNum(p.value, metric === 'advantage' ? 5 : 4)}{p.err ? ` (CI ${fmtNum(p.value - p.err[0], 5)} … ${fmtNum(p.value + p.err[1], 5)})` : ''}</div>
        <div>minta: {p.matches} meccs · {p.observations} tipp</div>
        {!p.enough && <div className="font-bold text-warning-text">kis minta – nem értelmezhető trendként</div>}
      </div>
    );
  };
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{title}</div>
      <ResponsiveContainer width="100%" height={200}>
        <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis type="number" dataKey="t" domain={['dataMin', 'dataMax']} tickFormatter={fmtT} tick={AX} scale="time" />
          <YAxis type="number" dataKey="value" tick={AX} domain={['auto', 'auto']} tickFormatter={(v) => fmtNum(v, 3)} width={52} />
          {metric === 'advantage' && <ReferenceLine y={0} stroke="#6d7894" strokeDasharray="4 4" />}
          <Tooltip content={tip as never} />
          <Scatter isAnimationActive={false} name="elegendő minta" data={enough} fill="#4f6ef7">
            {metric === 'advantage' && <ErrorBar dataKey="err" direction="y" stroke="#4f6ef7" width={4} />}
          </Scatter>
          <Scatter isAnimationActive={false} name="kis minta" data={insufficient} fill="#f5a524" shape="diamond">
            {metric === 'advantage' && <ErrorBar dataKey="err" direction="y" stroke="#f5a524" width={4} />}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HistorySection({ runs, error, loading }: { runs: DiagnosticRun[] | null; error: string | null; loading: boolean }) {
  if (loading && !runs) return <Card title="Diagnosztikai előzmények"><Loading text="Előzmények betöltése…" /></Card>;
  if (error && !runs) {
    return (
      <Card title="Diagnosztikai előzmények">
        <ErrorBox message={`Az előzmények nem tölthetők be: ${error}`} />
        <p className="mt-2 text-xs text-muted">Ha a 0018-as migráció még nincs alkalmazva, az előzmény-tábla nem létezik – a diagnosztika ettől még megtekinthető, de nem rögzíthető.</p>
      </Card>
    );
  }
  const list = runs ?? [];
  if (!list.length) {
    return (
      <Card title="Diagnosztikai előzmények">
        <EmptyState title="Még nincs rögzített diagnosztikai futás" text="A „Diagnosztika frissítése” gomb egy futást kiszámol és rögzít. Az oldal megnyitása nem rögzít semmit." />
      </Card>
    );
  }
  const rows = historyRows(list);
  const anySmall = list.some((r) => !r.enoughForConclusions);
  return (
    <Card title={`Diagnosztikai előzmények (legutóbbi ${list.length})`}>
      {anySmall && (
        <Note tone="warn">Narancs ◆ jelölés: kis vagy időben koncentrált minta. Ezeknél a változás véletlen ingadozás is lehet – javulás vagy romlás nem állítható.</Note>
      )}
      <p className="mt-2 text-xs text-muted">
        A pontok szándékosan nincsenek összekötve: minden futás a futás idején elérhető TELJES mintán mért, és a minta futásról futásra bővülhet, ezért két pont nem ugyanannak a mintának az ismételt mérése. Azonos ujjlenyomatú futások azonos mintán készültek (a táblában jelölve).
      </p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <HistoryChart runs={list} metric="logLoss" title="Log loss (kisebb = jobb)" />
        <HistoryChart runs={list} metric="brier" title="Brier-score (kisebb = jobb)" />
        <HistoryChart runs={list} metric="ece" title="Kalibrációs hiba – ECE (kisebb = jobb)" />
        <HistoryChart runs={list} metric="advantage" title="Előny a naiv baseline-hoz (log loss, páros minta; 0 fölött a modell jobb)" />
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="table">
          <thead><tr><th>Időpont</th><th>Modell</th><th>Meccs / tipp</th><th>Időszak</th><th>Log loss</th><th>Brier</th><th>ECE</th><th>Baseline-hoz képest</th><th>Minta</th><th>Megfelelőség</th></tr></thead>
          <tbody>
            {rows.map(({ run: r, sameSampleAsPrevious }) => (
              <tr key={r.id}>
                <td className="mono whitespace-nowrap">{fmtTime(r.createdAt)}</td>
                <td className="mono">{r.baseEngineVersion}</td>
                <td className="mono">{fmtInt(r.matches)} / {fmtInt(r.observations)}</td>
                <td className="text-xs">{r.period ? `${fmtTime(r.period.firstKickoff)} – ${fmtTime(r.period.lastKickoff)} (${r.period.distinctKickoffDays} nap)` : NO_DATA}</td>
                <td className="mono">{fmtNum(r.logLoss)}</td>
                <td className="mono">{fmtNum(r.brier)}</td>
                <td className="mono">{fmtNum(r.ece)}</td>
                <td className="mono text-xs">{r.naive ? `${fmtNum(r.naive.modelLogLossAdvantage, 5)} [${fmtCi(r.naive.modelLogLossAdvantageCi, 5)}] · ${r.naive.coveredMatches} meccs` : NO_DATA}</td>
                <td className="mono text-xs" title={r.dataFingerprint}>{r.dataFingerprint.slice(0, 8)}{sameSampleAsPrevious && <span className="badge badge-muted ml-1.5">azonos az előzővel</span>}</td>
                <td>{r.enoughForConclusions ? <span className="badge badge-green">elegendő</span> : <span className="badge badge-yellow" title={r.notes.join(' ')}>kis minta</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
