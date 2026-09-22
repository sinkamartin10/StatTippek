/** Mérkőzés részletes oldala: áttekintés, statisztika, összehasonlítás, hírek, külső tippek, modell, piacok, kockázatok, források. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Bookmark, CheckCircle2, ExternalLink, RefreshCw, XCircle } from 'lucide-react';
import type { FormSummary, MatchAnalysis, TipSuggestion, TipCategory } from '@shared/types';
import { api } from '../lib/api';
import { fmtDateTime, num, odds as fo, pct, pct100, signed, useAsync } from '../lib/format';
import { Card, Disclaimer, EmptyState, ErrorBox, FormPills, ImportanceBadge, Loading, Note, OriginBadge, ProbBar, QualityBadge, Stat, TeamLink } from '../components/ui';
import { CorrectScoreChart, FormGoalsChart, FormTrendChart, GoalDistChart, OneXTwoChart, OverUnderChart } from '../components/charts';
import { LockedBlock, ProLock, useFreeDay, usePlan } from '../auth/PlanContext';
import { localDateKey } from '../lib/dates';

const SECTIONS = [
  ['attekintes', 'Áttekintés'], ['statisztika', 'Statisztika'], ['osszehasonlitas', 'Összehasonlítás'], ['hirek', 'Hírek'],
  ['kulso', 'Külső előrejelzések'], ['modell', 'Modell'], ['ertek', 'Odds és érték'], ['tippek', 'Lehetséges piacok'], ['kockazatok', 'Kockázatok'], ['forrasok', 'Források'], ['modszer', 'Elemzési módszer'],
];

/** Kapuőr: FREE csomagban csak a nap kvótájába eső meccsek elemzése nyílik meg. */
export default function MatchDetail() {
  const { id = '' } = useParams();
  const { pro } = usePlan();
  const m = useAsync(() => api.match(id), [id]);
  const free = useFreeDay(m.data ? localDateKey(m.data.kickoff) : null);
  if (pro) return <MatchDetailInner id={id} pro />;
  if (m.loading || free.loading) return <Loading text="Mérkőzés betöltése…" />;
  if (m.error || !m.data) return <ErrorBox message={m.error ?? 'Ismeretlen hiba'} onRetry={m.reload} />;
  if (!free.allowed(id)) {
    const match = m.data;
    return (
      <div className="space-y-6">
        <div className="card p-5">
          <div className="text-xs text-muted">{match.league?.name} · {match.league?.country} · {fmtDateTime(match.kickoff)}</div>
          <div className="mt-2 text-2xl font-extrabold tracking-tight">{match.homeTeam?.name} <span className="text-muted">vs</span> {match.awayTeam?.name}</div>
        </div>
        <LockedBlock title="Ez a mérkőzés PRO előfizetéssel elemezhető" text={`A FREE csomagban ezen a napon ${free.total} mérkőzésből ${free.quota} elemzése ingyenes (a kezdési idő szerinti első ${free.quota}). PRO előfizetéssel minden mérkőzés teljes elemzése, a modell indoklásai és a részletes statisztikák is elérhetők.`} />
        <Disclaimer />
      </div>
    );
  }
  return <MatchDetailInner id={id} pro={false} />;
}

function MatchDetailInner({ id, pro }: { id: string; pro: boolean }) {
  const loc = useLocation();
  const [refreshing, setRefreshing] = useState(false);
  const a = useAsync(() => api.analysis(id), [id]);

  useEffect(() => {
    if (a.data && loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
  }, [a.data, loc.hash]);

  if (a.loading) return <Loading text="Kutatás és modellszámítás folyamatban…" />;
  if (a.error || !a.data) return <ErrorBox message={a.error ?? 'Ismeretlen hiba'} onRetry={a.reload} />;
  const an = a.data;

  const refresh = async () => {
    setRefreshing(true);
    try { await api.analysis(id, true); a.reload(); } finally { setRefreshing(false); }
  };

  return (
    <div className="space-y-6">
      <Header an={an} onRefresh={refresh} refreshing={refreshing} />
      <nav className="sticky top-16 z-10 -mx-4 overflow-x-auto border-b border-border bg-bg px-4 py-2 lg:-mx-8 lg:px-8">
        <div className="flex gap-1 whitespace-nowrap">
          {SECTIONS.map(([k, l]) => <a key={k} href={`#${k}`} className="rounded-md px-3 py-1.5 text-xs font-medium text-muted hover:bg-card-2 hover:text-text">{l}</a>)}
        </div>
      </nav>

      {an.insufficientData && (
        <Note tone="warn">
          <strong>Ehhez a mérkőzéshez jelenleg nem áll rendelkezésre elegendő ellenőrizhető adat.</strong> A modell nem futtatható; az alábbiakban csak a meglévő adatok jelennek meg.
          <ul className="mt-1 list-disc pl-5">{an.insufficientReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </Note>
      )}

      <Overview an={an} />
      <Statistics an={an} pro={pro} />
      <Comparison an={an} pro={pro} />
      <News an={an} />
      <External an={an} />
      <Model an={an} />
      <OddsValue an={an} onSaved={a.reload} />
      <Tips an={an} />
      <Risks an={an} />
      <Sources an={an} />
      <Methodology an={an} />
      <Disclaimer />
    </div>
  );
}

function Header({ an, onRefresh, refreshing }: { an: MatchAnalysis; onRefresh: () => void; refreshing: boolean }) {
  const m = an.match;
  return (
    <div className="card overflow-hidden">
      <div className="bg-gradient-to-r from-accent/10 via-transparent to-info/10 p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-semibold text-text/90">{an.league.name}</span><span>· {an.league.country}</span>{m.round && <span>· {m.round}</span>}
          <ImportanceBadge importance={m.importance} /><OriginBadge origin={an.origin} /><QualityBadge q={an.dataQuality} showScore />
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
          <TeamLink id={an.homeTeam.id} name={an.homeTeam.name} className="text-right text-2xl font-extrabold tracking-tight md:text-3xl" />
          <div className="text-center">
            {m.status === 'finished' && m.homeGoals != null ? <div className="mono text-3xl font-black">{m.homeGoals}–{m.awayGoals}</div> : <div className="text-xl font-bold text-muted">vs</div>}
            <div className="mono mt-1 text-xs text-muted">{fmtDateTime(m.kickoff)}</div>
          </div>
          <TeamLink id={an.awayTeam.id} name={an.awayTeam.name} className="text-2xl font-extrabold tracking-tight md:text-3xl" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {m.importanceReasons.map((r) => <span key={r} className="badge badge-muted">{r}</span>)}
          <div className="flex-1" />
          <button className="btn btn-sm" onClick={onRefresh} disabled={refreshing}><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Kutatás frissítése</button>
        </div>
      </div>
    </div>
  );
}

function Overview({ an }: { an: MatchAnalysis }) {
  const { homeLast5, awayLast5, homeLast10, awayLast10, homeAtHome, awayAtAway } = an.form;
  const ppg = (f: FormSummary) => (f.sampleSize ? num(f.points / f.sampleSize) : '–');
  return (
    <Card id="attekintes" title="Gyors áttekintés">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border border-border bg-bg-2/60 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Forma (utolsó 5)</div>
          <div className="mt-2 space-y-1.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="truncate text-xs">{an.homeTeam.shortName}</span><FormPills form={homeLast5.formString} /></div>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="truncate text-xs">{an.awayTeam.shortName}</span><FormPills form={awayLast5.formString} /></div>
          </div>
        </div>
        <Stat label="Gólátlag (utolsó 10)" value={<span className="text-lg">{num(homeLast10.avgGoalsFor)}–{num(homeLast10.avgGoalsAgainst)} <span className="text-muted">|</span> {num(awayLast10.avgGoalsFor)}–{num(awayLast10.avgGoalsAgainst)}</span>} sub="lőtt–kapott, hazai | vendég" />
        <Stat label="Hazai / idegen pont/meccs" value={<span className="text-lg">{ppg(homeAtHome)} <span className="text-muted">|</span> {ppg(awayAtAway)}</span>} sub={`${an.homeTeam.shortName} otthon (${homeAtHome.sampleSize}) | ${an.awayTeam.shortName} idegenben (${awayAtAway.sampleSize})`} />
        <Stat label="Mindkét csapat szerez gólt" value={<span className="text-lg">{pct100(homeLast10.btts)} <span className="text-muted">|</span> {pct100(awayLast10.btts)}</span>} sub="historikus gyakoriság, utolsó 10" />
        <Stat label="Több mint 2,5 gól" value={<span className="text-lg">{pct100(homeLast10.over25)} <span className="text-muted">|</span> {pct100(awayLast10.over25)}</span>} sub="historikus gyakoriság, utolsó 10" />
      </div>
      {an.poisson && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">1X2 modell-becslés</div>
            <ProbBar label={`Hazai győzelem`} value={an.poisson.homeWin} />
            <div className="h-1.5" /><ProbBar label="Döntetlen" value={an.poisson.draw} color="bg-muted" />
            <div className="h-1.5" /><ProbBar label="Vendég győzelem" value={an.poisson.awayWin} color="bg-info" />
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Gólpiacok modell-becslés</div>
            <ProbBar label="Több mint 2,5" value={an.poisson.over['2.5']} />
            <div className="h-1.5" /><ProbBar label="Több mint 1,5" value={an.poisson.over['1.5']} />
            <div className="h-1.5" /><ProbBar label="Mindkét csapat gólt szerez" value={an.poisson.bttsYes} color="bg-info" />
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">A modell-becslések statisztikai valószínűségek (Poisson), nem garantált kimenetek. A historikus gyakoriságok múltbeli adatok.</p>
    </Card>
  );
}

function FormTable({ f, name }: { f: FormSummary; name: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-2/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">{name} <span className="text-xs font-normal text-muted">({f.venue}, {f.sampleSize} meccs)</span></div>
        <FormPills form={f.formString} />
      </div>
      {f.sampleSize === 0 ? <div className="text-xs text-muted">Nincs elérhető mérkőzés.</div> : (
        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
          <div><span className="text-muted">Gy–D–V:</span> <b className="mono">{f.wins}–{f.draws}–{f.losses}</b></div>
          <div><span className="text-muted">Pont/meccs:</span> <b className="mono">{num(f.points / f.sampleSize)}</b></div>
          <div><span className="text-muted">Lőtt/kapott:</span> <b className="mono">{f.goalsFor}/{f.goalsAgainst}</b></div>
          <div><span className="text-muted">Kapott gól nélkül:</span> <b className="mono">{f.cleanSheets}</b></div>
          <div><span className="text-muted">Gól nélkül:</span> <b className="mono">{f.failedToScore}</b></div>
          <div><span className="text-muted">Több mint 1,5:</span> <b className="mono">{pct100(f.over15)}</b></div>
          <div><span className="text-muted">Több mint 2,5:</span> <b className="mono">{pct100(f.over25)}</b></div>
          <div><span className="text-muted">Több mint 3,5:</span> <b className="mono">{pct100(f.over35)}</b></div>
          <div><span className="text-muted">Kevesebb mint 2,5:</span> <b className="mono">{pct100(f.under25)}</b></div>
          <div><span className="text-muted">BTTS:</span> <b className="mono">{pct100(f.btts)}</b></div>
          <div><span className="text-muted">1. félidei gól/meccs:</span> <b className="mono">{f.firstHalfGoalsAvg != null ? num(f.firstHalfGoalsAvg) : 'n. a.'}</b></div>
          <div><span className="text-muted">2. félidei gól/meccs:</span> <b className="mono">{f.secondHalfGoalsAvg != null ? num(f.secondHalfGoalsAvg) : 'n. a.'}</b></div>
        </div>
      )}
    </div>
  );
}

function Statistics({ an, pro }: { an: MatchAnalysis; pro: boolean }) {
  const { homeLast5, homeLast10, awayLast5, awayLast10, homeAtHome, awayAtAway, interpretation } = an.form;
  if (!pro) {
    return (
      <Card id="statisztika" title="Statisztikai elemzés" right={<ProLock />}>
        <LockedBlock title="Részletes statisztikák – PRO" text="Utolsó 5/10 meccs, hazai/idegen bontás, gólpiaci mutatók, egymás elleni mérkőzések és diagramok PRO előfizetéssel érhetők el. A gyors áttekintés fent ingyenes." />
      </Card>
    );
  }
  return (
    <Card id="statisztika" title="Statisztikai elemzés">
      <div className="grid gap-3 lg:grid-cols-2">
        <FormTable f={homeLast5} name={`${an.homeTeam.shortName} – utolsó 5`} />
        <FormTable f={awayLast5} name={`${an.awayTeam.shortName} – utolsó 5`} />
        <FormTable f={homeLast10} name={`${an.homeTeam.shortName} – utolsó 10`} />
        <FormTable f={awayLast10} name={`${an.awayTeam.shortName} – utolsó 10`} />
        <FormTable f={homeAtHome} name={`${an.homeTeam.shortName} – hazai forma`} />
        <FormTable f={awayAtAway} name={`${an.awayTeam.shortName} – idegenbeli forma`} />
      </div>
      <div className="mt-4 rounded-lg border border-border bg-bg-2/60 p-3 text-sm">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Mit jelent ez statisztikailag?</div>
        <ul className="list-disc space-y-1 pl-5">{interpretation.map((t) => <li key={t}>{t}</li>)}</ul>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{an.homeTeam.shortName} – lőtt/kapott gólok (utolsó 10)</div><FormGoalsChart form={homeLast10} name={an.homeTeam.shortName} /></div>
        <div><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{an.awayTeam.shortName} – lőtt/kapott gólok (utolsó 10)</div><FormGoalsChart form={awayLast10} name={an.awayTeam.shortName} /></div>
      </div>
      <div className="mt-4"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Kumulált pontok az utolsó 10 meccsből</div><FormTrendChart home={homeLast10} away={awayLast10} homeName={an.homeTeam.shortName} awayName={an.awayTeam.shortName} /></div>

      <h4 className="mt-6 text-sm font-semibold">Gólpiaci historikus mutatók (utolsó 10 meccs)</h4>
      <p className="mb-2 text-xs text-muted">Múltbeli gyakoriság – NEM jövőbeli valószínűség. A kombinált mutató a két csapat értékének egyszerű átlaga.</p>
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Piac</th><th>{an.homeTeam.shortName} meccsei</th><th>{an.awayTeam.shortName} meccsei</th><th>Kombinált mutató</th><th>Minta</th></tr></thead>
          <tbody>
            {an.goalMarkets.map((g) => (
              <tr key={g.market}><td>{g.label}</td><td className="mono">{pct100(g.homePct)}</td><td className="mono">{pct100(g.awayPct)}</td><td className="mono font-semibold">{pct100(g.combinedPct)}</td><td className="mono text-muted">{g.sampleSize}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="mt-6 text-sm font-semibold">Egymás elleni mérkőzések</h4>
      {an.h2h.sampleSize === 0 ? <div className="text-sm text-muted">Nincs elérhető egymás elleni mérkőzés az adatkészletben.</div> : (
        <>
          <div className="my-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label={`${an.homeTeam.shortName} győzelem`} value={an.h2h.homeTeamWins} />
            <Stat label="Döntetlen" value={an.h2h.draws} />
            <Stat label={`${an.awayTeam.shortName} győzelem`} value={an.h2h.awayTeamWins} />
            <Stat label="Gólátlag" value={num(an.h2h.avgGoals)} />
            <Stat label="BTTS / Több mint 2,5" value={<span className="text-lg">{pct100(an.h2h.bttsPct)} / {pct100(an.h2h.over25Pct)}</span>} />
          </div>
          <ul className="text-sm">
            {an.h2h.matches.map((m) => (
              <li key={m.date + m.homeTeamId} className="flex items-center justify-between border-t border-border/60 py-1.5">
                <span className="text-muted">{fmtDateTime(m.date).slice(0, 13)}</span>
                <span>{m.homeTeamId === an.homeTeam.id ? an.homeTeam.shortName : an.awayTeam.shortName} – {m.awayTeamId === an.awayTeam.id ? an.awayTeam.shortName : an.homeTeam.shortName}</span>
                <span className="mono font-semibold">{m.hg}–{m.ag}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function Comparison({ an, pro }: { an: MatchAnalysis; pro: boolean }) {
  const h = an.form.homeLast10, a = an.form.awayLast10;
  if (!pro) return <Card id="osszehasonlitas" title="Csapat-összehasonlítás" right={<ProLock />}><LockedBlock title="Csapat-összehasonlítás – PRO" compact /></Card>;
  const rows: [string, string | number, string | number][] = [
    ['Tabella-pozíció', an.standings.home ? `${an.standings.home.position}. / ${an.standings.total}` : '–', an.standings.away ? `${an.standings.away.position}. / ${an.standings.total}` : '–'],
    ['Pontok (bajnokság)', an.standings.home?.points ?? '–', an.standings.away?.points ?? '–'],
    ['Gólkülönbség (bajnokság)', an.standings.home ? signed(an.standings.home.gd, 0) : '–', an.standings.away ? signed(an.standings.away.gd, 0) : '–'],
    ['Forma (utolsó 10) pont', h.points, a.points],
    ['Lőtt gól / meccs', num(h.avgGoalsFor), num(a.avgGoalsFor)],
    ['Kapott gól / meccs', num(h.avgGoalsAgainst), num(a.avgGoalsAgainst)],
    ['Kapott gól nélküli meccsek', `${h.cleanSheets}/${h.sampleSize}`, `${a.cleanSheets}/${a.sampleSize}`],
    ['Több mint 2,5 gól', pct100(h.over25), pct100(a.over25)],
    ['Mindkét csapat szerez gólt', pct100(h.btts), pct100(a.btts)],
    ['Hazai / idegen pont/meccs', an.form.homeAtHome.sampleSize ? num(an.form.homeAtHome.points / an.form.homeAtHome.sampleSize) : '–', an.form.awayAtAway.sampleSize ? num(an.form.awayAtAway.points / an.form.awayAtAway.sampleSize) : '–'],
    ['Várható gól (modell)', an.xg ? num(an.xg.homeExpected) : '–', an.xg ? num(an.xg.awayExpected) : '–'],
    ['Támadóerő / védőerő (modell)', an.xg ? `${num(an.xg.homeAttack)} / ${num(an.xg.homeDefense)}` : '–', an.xg ? `${num(an.xg.awayAttack)} / ${num(an.xg.awayDefense)}` : '–'],
  ];
  return (
    <Card id="osszehasonlitas" title="Csapat-összehasonlítás">
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr><th className="text-right">{an.homeTeam.name}</th><th className="text-center">Mutató</th><th>{an.awayTeam.name}</th></tr></thead>
          <tbody>{rows.map(([l, x, y]) => <tr key={l}><td className="mono text-right font-semibold">{x}</td><td className="text-center text-xs text-muted">{l}</td><td className="mono font-semibold">{y}</td></tr>)}</tbody>
        </table>
      </div>
    </Card>
  );
}

function News({ an }: { an: MatchAnalysis }) {
  const r = an.research;
  const Avail = ({ teamName, av }: { teamName: string; av: MatchAnalysis['research']['availability']['home'] }) => (
    <div className="rounded-lg border border-border bg-bg-2/60 p-3 text-sm">
      <div className="mb-1 font-semibold">{teamName} – hiányzók és felállás</div>
      <div className="text-xs text-muted">Kezdőcsapat: <b className="text-text">{av.lineupStatus}</b>{av.lineupNote && ` – ${av.lineupNote}`}{av.restDays != null && ` · pihenőnapok: ${av.restDays}`}{av.midweekEuropeanMatch && ' · hét közbeni nemzetközi meccs'}</div>
      {av.injuries.length + av.suspensions.length === 0 ? <div className="mt-1 text-xs text-muted">Nincs ismert sérült vagy eltiltott játékos az elérhető forrásokban.</div> : (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {av.injuries.map((i, k) => <li key={'i' + k}><b>Sérülés:</b> {i.player} – {i.detail}</li>)}
          {av.suspensions.map((i, k) => <li key={'s' + k}><b>Eltiltás:</b> {i.player} – {i.detail}</li>)}
        </ul>
      )}
      {av.notes.map((n) => <div key={n} className="mt-1 text-xs text-muted">{n}</div>)}
    </div>
  );
  return (
    <Card id="hirek" title="Hírek és csapatinformációk" right={<OriginBadge origin={r.origin} small />}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Avail teamName={an.homeTeam.shortName} av={r.availability.home} />
        <Avail teamName={an.awayTeam.shortName} av={r.availability.away} />
      </div>
      {r.news.length === 0 ? <div className="mt-4"><EmptyState title="Nincs elérhető hír" text="Ehhez a mérkőzéshez jelenleg nem áll rendelkezésre elegendő ellenőrizhető adat." /></div> : (
        <ul className="mt-4 divide-y divide-border/60">
          {r.news.map((n) => (
            <li key={n.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2"><span className="badge badge-muted">{n.category}</span><span className="font-semibold">{n.title}</span></div>
              <div className="mt-1 text-sm text-text/85">{n.summary}</div>
              <div className="mt-1 text-xs text-muted">Forrás: {n.sourceName}{n.publishedAt && ` · ${fmtDateTime(n.publishedAt)}`} · {n.url ? <a href={n.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent">megnyitás <ExternalLink className="h-3 w-3" /></a> : <span className="text-warn">nincs ellenőrizhető URL</span>}</div>
            </li>
          ))}
        </ul>
      )}
      {r.warnings.map((w) => <div key={w} className="mt-3"><Note tone="warn">{w}</Note></div>)}
    </Card>
  );
}

function External({ an }: { an: MatchAnalysis }) {
  const preds = an.research.externalPredictions;
  const c = an.consensus;
  return (
    <Card id="kulso" title="Más források tippjei" right={<OriginBadge origin={an.research.origin} small />}>
      {preds.length === 0 ? <EmptyState title="Nem található külső előrejelzés" text="A kutatómotor nem talált ellenőrizhető külső tippet ehhez a mérkőzéshez." /> : (
        <>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Forrás</th><th>Eredeti tipp</th><th>Felismert piac</th><th>Bizalom</th><th>Dátum</th><th>URL</th></tr></thead>
              <tbody>
                {preds.map((p) => (
                  <tr key={p.id}>
                    <td className="font-semibold">{p.sourceName}</td>
                    <td className="max-w-md text-xs">{p.originalText}</td>
                    <td>{p.market ? <span className="badge badge-green">{c.byMarket.find((b) => b.market === p.market)?.label ?? p.market}</span> : <span className="badge badge-muted">nem felismerhető</span>}{p.autoExtracted && <div className="text-[10px] text-muted">automatikus szövegelemzés</div>}</td>
                    <td className="mono">{p.confidence ?? '–'}</td>
                    <td className="text-xs text-muted">{p.publishedAt ? fmtDateTime(p.publishedAt) : '–'}</td>
                    <td>{p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener" className="text-accent"><ExternalLink className="h-4 w-4" /></a> : <span className="text-xs text-warn">nincs</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-border bg-bg-2/60 p-3 text-sm">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Egyetértő források piaconként</div>
              {c.byMarket.map((b) => <div key={b.market} className="flex justify-between py-0.5"><span>{b.label}</span><span className="mono">{b.count}/{c.totalSources} forrás</span></div>)}
            </div>
            <div className="space-y-2">
              {c.agreementNote && <Note>{c.agreementNote} Ez megfigyelés, nem bizonyíték arra, hogy a tipp nyer.</Note>}
              {c.disagreementNote && <Note tone="warn">{c.disagreementNote}</Note>}
              {!c.agreementNote && !c.disagreementNote && <Note>Nincs kimutatható egyetértés a források között.</Note>}
              {an.poisson && c.byMarket[0] && (
                <div className="text-xs text-muted">Összevetés a saját modellel: a leggyakoribb külső piac ({c.byMarket[0].label}) modell-becslése {pct(an.value.find((v) => v.market === c.byMarket[0].market)?.modelProb ?? null)}.</div>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function Model({ an }: { an: MatchAnalysis }) {
  const { pro } = usePlan();
  if (!an.xg || !an.poisson) return <Card id="modell" title="Modell"><EmptyState title="A modell nem futtatható" text="Nincs elegendő hazai/idegen mérkőzés vagy liga-adat a várható gól becsléshez." /></Card>;
  const { xg, poisson: p } = an;
  return (
    <Card id="modell" title="Várható gól és Poisson-modell">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`${an.homeTeam.shortName} várható gól`} value={num(xg.homeExpected)} sub={`támadó ${num(xg.homeAttack)} × vendég védő ${num(xg.awayDefense)} × liga hazai átlag ${num(an.leagueAverages.avgHomeGoals)}`} />
        <Stat label={`${an.awayTeam.shortName} várható gól`} value={num(xg.awayExpected)} sub={`támadó ${num(xg.awayAttack)} × hazai védő ${num(xg.homeDefense)} × liga vendég átlag ${num(an.leagueAverages.avgAwayGoals)}`} />
        <Stat label="Összes várható gól" value={num(xg.totalExpected)} sub={`minta: ${xg.homeSample} hazai / ${xg.awaySample} idegen meccs, k=${xg.shrinkageK}`} />
        <Stat label="Liga-átlag" value={num(an.leagueAverages.avgTotalGoals)} sub={`${an.leagueAverages.matches} meccs · hazai ${an.leagueAverages.homeWinPct}% / X ${an.leagueAverages.drawPct}% / vendég ${an.leagueAverages.awayWinPct}%`} />
      </div>
      {xg.notes.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-muted">{xg.notes.map((n) => <li key={n}>{n}</li>)}</ul>}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h4 className="mb-1 text-sm font-semibold">1X2 valószínűség-eloszlás</h4>
          <OneXTwoChart p={p} home={an.homeTeam.shortName} away={an.awayTeam.shortName} />
          <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-md bg-bg-2 p-2"><div className="text-muted">Dupla esély 1X</div><div className="mono font-semibold">{pct(p.doubleChance['1X'], 1)}</div></div>
            <div className="rounded-md bg-bg-2 p-2"><div className="text-muted">Dupla esély 12</div><div className="mono font-semibold">{pct(p.doubleChance['12'], 1)}</div></div>
            <div className="rounded-md bg-bg-2 p-2"><div className="text-muted">Dupla esély X2</div><div className="mono font-semibold">{pct(p.doubleChance.X2, 1)}</div></div>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-bg-2/60 p-3 text-sm">
            <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted">A becslés fő tényezői {!pro && <ProLock />}</div>
            {pro ? <ul className="list-disc space-y-1 pl-5">{an.oneXtwoFactors.map((t) => <li key={t}>{t}</li>)}</ul> : <LockedBlock title="A modell indoklása – PRO" compact />}
          </div>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Gólszám-piacok (Poisson)</h4>
          <OverUnderChart p={p} />
          <div className="mt-2 overflow-x-auto">
            <table className="table">
              <thead><tr><th>Vonal</th><th>Több mint</th><th>Kevesebb mint</th></tr></thead>
              <tbody>{['0.5', '1.5', '2.5', '3.5', '4.5'].map((l) => <tr key={l}><td className="mono">{l.replace('.', ',')}</td><td className="mono">{pct(p.over[l], 1)}</td><td className="mono">{pct(p.under[l], 1)}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-center text-xs">
            <div className="rounded-md bg-bg-2 p-2"><div className="text-muted">BTTS igen</div><div className="mono font-semibold">{pct(p.bttsYes, 1)}</div></div>
            <div className="rounded-md bg-bg-2 p-2"><div className="text-muted">BTTS nem</div><div className="mono font-semibold">{pct(p.bttsNo, 1)}</div></div>
          </div>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Gólszám-eloszlás csapatonként</h4>
          <GoalDistChart p={p} home={an.homeTeam.shortName} away={an.awayTeam.shortName} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Legvalószínűbb pontos eredmények</h4>
          <CorrectScoreChart p={p} />
          <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
            {p.correctScores.map((c) => <div key={c.score} className="rounded-md bg-bg-2 p-2"><div className="mono text-base font-bold">{c.score}</div><div className="mono text-muted">{pct(c.prob, 1)}</div></div>)}
          </div>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted">Minden érték a Poisson-modellből számított becslés a fenti λ paraméterekkel – nem garantált valószínűség. Ázsiai hendikep hazai −1: nyer {pct(p.asianHome1.win)}, tét vissza {pct(p.asianHome1.push)}, veszít {pct(p.asianHome1.lose)}.</p>
    </Card>
  );
}

const ODDS_INPUTS = ['1', 'X', '2', '1X', 'X2', 'O1.5', 'O2.5', 'O3.5', 'U2.5', 'U3.5', 'BTTS_Y', 'BTTS_N', 'DNB_1', 'DNB_2'];

function OddsValue({ an, onSaved }: { an: MatchAnalysis; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = useMemo(() => Object.fromEntries(an.value.map((v) => [v.market, v.label])), [an.value]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const markets = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim()));
      await api.saveOdds(an.match.id, markets);
      setForm({}); onSaved();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const clear = async () => { setBusy(true); try { await api.deleteOdds(an.match.id); onSaved(); } finally { setBusy(false); } };

  return (
    <Card id="ertek" title="Odds és értékelemzés">
      <div className="mb-3 text-sm text-muted">
        {an.odds ? <>Odds forrása: <b className="text-text">{an.odds.bookmaker ?? an.odds.source}</b> ({an.odds.source === 'manual' ? 'kézi bevitel' : an.odds.source === 'demo' ? 'DEMO ADAT' : 'élő'}) · lekérve: {fmtDateTime(an.odds.retrievedAt)}</> : 'Nincs elérhető odds – add meg kézzel az értékelemzéshez.'}
      </div>
      {an.value.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Piac</th><th>Modell</th><th>Odds</th><th>Implikált (1/odds)</th><th>Különbség</th><th>Értékelés</th></tr></thead>
            <tbody>
              {an.value.map((v) => (
                <tr key={v.market}>
                  <td>{v.label}</td>
                  <td className="mono font-semibold">{pct(v.modelProb, 1)}</td>
                  <td className="mono">{fo(v.odds)}{an.odds?.bookmakers?.[v.market] && <div className="text-[10px] text-muted">{an.odds.bookmakers[v.market]}</div>}</td>
                  <td className="mono">{v.impliedProb != null ? pct(v.impliedProb, 2) : '–'}</td>
                  <td className={`mono font-semibold ${v.diffPoints == null ? '' : v.diffPoints >= 3 ? 'text-accent' : v.diffPoints <= -3 ? 'text-danger' : ''}`}>{v.diffPoints != null ? `${signed(v.diffPoints)} pp` : '–'}</td>
                  <td>{v.verdict ? <span className={`badge ${v.verdict.startsWith('Pozitív') ? 'badge-green' : v.verdict.startsWith('Negatív') ? 'badge-red' : 'badge-muted'}`}>{v.verdict}</span> : <span className="text-xs text-muted">nincs odds</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">Az implikált valószínűség 1 ÷ odds, a fogadóiroda árrésével együtt. A „pozitív modellkülönbség” azt jelenti, hogy a modell magasabb esélyt becsül, mint amit az odds tükröz – nem azt, hogy a fogadás nyereséges.</p>

      <details className="mt-4 rounded-lg border border-border bg-bg-2/60 p-3">
        <summary className="cursor-pointer text-sm font-semibold">Odds kézi megadása / felülírása</summary>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {ODDS_INPUTS.map((m) => (
            <label key={m} className="text-[11px] text-muted">{labels[m] ?? m}
              <input className="input mt-1" inputMode="decimal" placeholder={an.odds?.markets[m] ? fo(an.odds.markets[m]) : '1,90'} value={form[m] ?? ''} onChange={(e) => setForm({ ...form, [m]: e.target.value })} />
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>Mentés</button>
          {an.odds?.source === 'manual' && <button className="btn btn-sm" onClick={clear} disabled={busy}>Kézi odds törlése</button>}
          {msg && <span className="text-sm text-danger">{msg}</span>}
        </div>
      </details>
    </Card>
  );
}

function TipCard({ t, matchId }: { t: TipSuggestion; matchId: string }) {
  const { pro } = usePlan();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const save = async () => {
    try { await api.savePrediction(matchId, t.market); setSaved('Mentve az előzményekbe.'); } catch (e) { setSaved((e as Error).message); }
  };
  return (
    <div className="rounded-lg border border-border bg-bg-2/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">{t.label}</div>
        <div className="flex items-center gap-2 text-xs">
          <span className="mono rounded-md bg-accent/15 px-2 py-0.5 font-bold text-accent">{pct(t.modelProb, 1)}</span>
          {t.odds != null && <span className="mono rounded-md bg-card px-2 py-0.5">odds {fo(t.odds)}</span>}
          {t.diffPoints != null && <span className={`mono rounded-md px-2 py-0.5 ${t.diffPoints >= 3 ? 'bg-accent/15 text-accent' : t.diffPoints <= -3 ? 'bg-danger/15 text-danger' : 'bg-card'}`}>{signed(t.diffPoints)} pp</span>}
          <span className="badge badge-muted">{t.supportingIndicators}/{t.supportingStats.length} mutató</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {pro ? <button className="btn btn-sm" onClick={() => setOpen(!open)}>{open ? 'Indoklás elrejtése' : 'Tipp indoklása'}</button> : <ProLock label="Tipp indoklása" />}
        <button className="btn btn-sm" onClick={save}><Bookmark className="h-3.5 w-3.5" /> Mentés az előzményekhez</button>
        {saved && <span className="self-center text-xs text-muted">{saved}</span>}
      </div>
      {pro && open && (
        <div className="mt-3 grid gap-3 text-sm">
          <div><div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-accent"><CheckCircle2 className="h-3.5 w-3.5" /> Mellette</div><ul className="list-disc space-y-1 pl-4 text-xs">{t.reasonsFor.map((r) => <li key={r}>{r}</li>)}</ul></div>
          <div><div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-danger"><XCircle className="h-3.5 w-3.5" /> Ellene</div>{t.reasonsAgainst.length ? <ul className="list-disc space-y-1 pl-4 text-xs">{t.reasonsAgainst.map((r) => <li key={r}>{r}</li>)}</ul> : <div className="text-xs text-muted">Nincs ellenérv a vizsgált mutatók között.</div>}</div>
          <div><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-warn">Bizonytalansági tényezők</div><ul className="list-disc space-y-1 pl-4 text-xs">{t.risks.map((r) => <li key={r}>{r}</li>)}</ul></div>
          <div><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Támogató statisztikák</div><ul className="space-y-0.5 text-xs">{t.supportingStats.map((s) => <li key={s} className={s.startsWith('✔') ? 'text-accent' : 'text-muted'}>{s}</li>)}</ul><div className="mt-1 text-[11px] text-muted">Minta: {t.sampleSize} meccs.</div></div>
        </div>
      )}
    </div>
  );
}

function Tips({ an }: { an: MatchAnalysis }) {
  const cats: TipCategory[] = ['konzervatív', 'mérsékelt', 'magas variancia'];
  return (
    <Card id="tippek" title="Lehetséges piacok (tippgenerátor)">
      <Note>A javaslatok elemzési kiindulópontok, nem ajánlások. A magasabb modell-valószínűség nem indok a tét emelésére.</Note>
      {an.tips.length === 0 ? <div className="mt-3"><EmptyState title="Nincs generálható tipp" text="A modell nem futtatható elegendő adat hiányában." /></div> : (
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          {cats.map((c) => (
            <div key={c}>
              <h4 className="mb-2 text-sm font-semibold capitalize">{c}</h4>
              <div className="space-y-2">{an.tips.filter((t) => t.category === c).map((t) => <TipCard key={t.id} t={t} matchId={an.match.id} />)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Risks({ an }: { an: MatchAnalysis }) {
  return (
    <Card id="kockazatok" title="Kockázatok – mi teheti tévessé az elemzést?">
      <ul className="list-disc space-y-1 pl-5 text-sm">{an.risks.map((r) => <li key={r}>{r}</li>)}</ul>
      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Adatminőség részletei ({an.dataQuality.score}/100 – nem nyerési esély)</div>
        <div className="grid gap-1 sm:grid-cols-2">
          {an.dataQuality.factors.map((f) => (
            <div key={f.label} className="flex items-start gap-2 text-sm">{f.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-accent" /> : <XCircle className="mt-0.5 h-4 w-4 text-danger" />}<span><b>{f.label}:</b> <span className="text-muted">{f.detail}</span></span></div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Sources({ an }: { an: MatchAnalysis }) {
  const s = an.research.sources;
  return (
    <Card id="forrasok" title={`Források (${s.length})`} right={<Link to={`/forrasok?matchId=${encodeURIComponent(an.match.id)}`} className="btn btn-sm">Forrásnapló</Link>}>
      {s.length === 0 ? <EmptyState title="Nincs rögzített forrás" /> : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Forrás</th><th>Típus</th><th>Kinyert információ</th><th>Lekérve</th><th>Módszer</th><th>URL</th></tr></thead>
            <tbody>
              {s.map((x) => (
                <tr key={x.id}>
                  <td className="font-semibold">{x.sourceName}</td>
                  <td><span className="badge badge-muted">{x.type}</span></td>
                  <td className="max-w-lg text-xs">„{x.extracted}”</td>
                  <td className="text-xs text-muted">{fmtDateTime(x.retrievedAt)}</td>
                  <td className="text-xs text-muted">{x.method}</td>
                  <td>{x.url ? <a href={x.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent">link <ExternalLink className="h-3 w-3" /></a> : <span className="text-xs text-warn">nincs ellenőrizhető URL</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">URL nélküli forrás nem tekinthető ellenőrzöttnek; az abból származó információ nem tény, csak jelzés.</p>
    </Card>
  );
}

function Methodology({ an }: { an: MatchAnalysis }) {
  return (
    <Card id="modszer" title="Elemzési módszer">
      <ol className="list-decimal space-y-2 pl-5 text-sm">{an.methodology.map((m) => <li key={m}>{m}</li>)}</ol>
      <div className="mt-3 text-xs text-muted">Elemzés ideje: {fmtDateTime(an.generatedAt)} · kutatás: {an.research.provider} ({fmtDateTime(an.research.performedAt)})</div>
    </Card>
  );
}
