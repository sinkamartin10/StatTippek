/**
 * Tipster Progression kártya a profil oldalon: avatar + keret, szint, XP-sáv,
 * statisztikák, achievementek és a testreszabás.
 *
 * Minden érték a SZERVERTŐL jön (XP, szint, feloldások). A kliens csak megjelenít,
 * és a felhasználó választását küldi vissza – azt a szerver újra ellenőrzi.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Crown, Lock, Palette } from 'lucide-react';
import type { ProfileSettings } from '@shared/progression';
import { AVATAR_SLOTS, AVATAR_SLOT_LABEL, type AvatarSlot } from '@shared/progression';
import { api, type ProgressionProfileResponse } from '../lib/api';
import { useAsync } from '../lib/format';
import { Accordion, Card, ErrorBox, Loading, Note } from './ui';
import { Avatar } from './Avatar';

const nf = (n: number) => n.toLocaleString('hu-HU');

export function ProgressionCard({ displayName }: { displayName: string | null }) {
  const me = useAsync(() => api.progressionMe(), []);

  if (me.loading) return <Card title="Tipster profil"><Loading text="Profil betöltése…" /></Card>;
  if (me.error) return <ErrorBox message={me.error} onRetry={me.reload} />;
  if (!me.data) return null;

  return me.data.pro
    ? <ProProgression p={me.data} displayName={displayName} onSaved={me.reload} />
    : <LockedProgression p={me.data} />;
}

/* ------------------------------------------------------------------ PRO ---- */

function ProProgression({ p, displayName, onSaved }: { p: ProgressionProfileResponse; displayName: string | null; onSaved: () => void }) {
  const title = p.catalog.titles.find((t) => t.key === p.settings.title);
  const unlockedAchievements = p.achievements.filter((a) => a.unlocked);
  const showcase = p.settings.showcase
    .map((k) => p.achievements.find((a) => a.key === k))
    .filter((a): a is ProgressionProfileResponse['achievements'][number] => !!a);

  return (
    <div className="space-y-4">
      <Card title="Tipster profil">
        {/* Fejléc: avatar + név + szint */}
        <div className="flex flex-wrap items-center gap-4">
          <Avatar avatar={p.settings.avatar} border={p.settings.border} size={96} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl font-extrabold tracking-tight">{displayName ?? 'Tipster'}</div>
            {title && title.key !== 'none' && (
              <div className="mt-0.5 text-sm font-extrabold text-primary">🏆 {title.name}</div>
            )}
            <div className="mt-1 text-sm font-bold text-text-muted">Level {p.level} · {p.levelTier}</div>

            <div className="mt-2.5">
              <div className="xp-bar" role="progressbar" aria-valuenow={p.xpIntoLevel} aria-valuemin={0} aria-valuemax={p.xpForNextLevel || p.xpIntoLevel} aria-label="XP haladás">
                <div className="xp-bar-fill" style={{ width: `${Math.round(p.progress * 100)}%` }} />
              </div>
              <div className="mono mt-1 text-xs font-bold text-text-muted">
                {p.xpForNextLevel ? <>{nf(p.xpIntoLevel)} / {nf(p.xpForNextLevel)} XP a következő szintig</> : <>Maximális szint · {nf(p.xp)} XP</>}
              </div>
            </div>
          </div>
        </div>

        {/* Kiemelt achievementek */}
        {showcase.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {showcase.map((a) => (
              <span key={a.key} className="badge badge-blue" title={a.description}>{a.icon} {a.name}</span>
            ))}
          </div>
        )}

        {/* Statisztika */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon="🎯" label="Pontos eredmény" value={p.stats.exactScores} />
          <Stat icon="✅" label="Helyes tipp" value={p.stats.correctPredictions} />
          <Stat icon="🔥" label="Leghosszabb sorozat" value={p.stats.bestStreak} />
          <Stat icon="🏆" label="Megnyert verseny" value={p.stats.competitionsWon} />
        </div>
      </Card>

      {/* Achievementek */}
      <Card title={`Eredmények (${unlockedAchievements.length}/${p.achievements.length})`}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {p.achievements.map((a) => (
            <div
              key={a.key}
              title={a.description}
              className={`flex items-start gap-2 rounded-xl border p-3 ${a.unlocked ? 'border-border bg-card-2' : 'border-dashed border-border bg-card opacity-60'}`}
            >
              <span aria-hidden className="text-lg">{a.unlocked ? a.icon : '🔒'}</span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-extrabold">{a.name}</span>
                <span className="block text-[11px] font-semibold text-text-muted">{a.description}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Customization p={p} onSaved={onSaved} />
    </div>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card-2 p-3">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">{icon} {label}</div>
      <div className="mono mt-0.5 text-xl font-extrabold">{nf(value)}</div>
    </div>
  );
}

/* --------------------------------------------------------- Testreszabás ---- */

function Customization({ p, onSaved }: { p: ProgressionProfileResponse; onSaved: () => void }) {
  const [draft, setDraft] = useState<ProfileSettings>(p.settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  const setAvatar = (slot: AvatarSlot, key: string) => { setMsg(null); setDraft({ ...draft, avatar: { ...draft.avatar, [slot]: key } }); };
  const toggleShowcase = (key: string) => {
    setMsg(null);
    const has = draft.showcase.includes(key);
    if (has) return setDraft({ ...draft, showcase: draft.showcase.filter((k) => k !== key) });
    if (draft.showcase.length >= p.catalog.maxShowcase) { setMsg({ tone: 'warn', text: `Legfeljebb ${p.catalog.maxShowcase} eredmény emelhető ki.` }); return; }
    setDraft({ ...draft, showcase: [...draft.showcase, key] });
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.saveProgressionSettings(draft);
      setDraft(r.settings);
      setMsg(r.rejected.length
        ? { tone: 'warn', text: 'Elmentve. Néhány elem még nincs feloldva, azokat nem állítottuk be.' }
        : { tone: 'info', text: 'A profilod frissítve.' });
      onSaved();
    } catch (e) { setMsg({ tone: 'warn', text: (e as Error).message }); } finally { setBusy(false); }
  };

  const unlockedAchievements = p.achievements.filter((a) => a.unlocked);

  return (
    <Card title={<span className="flex items-center gap-2"><Palette className="h-5 w-5 text-primary" /> Testreszabás</span>}>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar avatar={draft.avatar} border={draft.border} size={80} />
        <p className="min-w-0 flex-1 text-sm font-semibold text-text-muted">
          Az előnézet azonnal frissül. A zárolt elemek mellett látod, mi oldja fel őket – a feloldást mindig a szerver dönti el.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <Accordion label="Profilkép" defaultOpen>
          <div className="space-y-4">
            {AVATAR_SLOTS.map((slot) => (
              <div key={slot}>
                <div className="field-label mb-1.5">{AVATAR_SLOT_LABEL[slot]}</div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {(p.catalog.avatar[slot] ?? []).map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      disabled={!o.unlocked}
                      title={o.unlocked ? o.name : `Feloldás: ${o.requirementLabel}`}
                      onClick={() => setAvatar(slot, o.key)}
                      className={`cosmetic-tile ${draft.avatar[slot] === o.key ? 'cosmetic-tile-active' : ''}`}
                    >
                      {o.value
                        ? <span className="h-5 w-5 rounded-full border border-border" style={{ background: o.value }} />
                        : <span aria-hidden>{o.unlocked ? '🙂' : '🔒'}</span>}
                      <span className="truncate">{o.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Accordion>

        <Accordion label="Profilkeret">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {p.catalog.borders.map((b) => (
              <button
                key={b.key}
                type="button"
                disabled={!b.unlocked}
                title={b.unlocked ? b.name : `Feloldás: ${b.requirementLabel}`}
                onClick={() => { setMsg(null); setDraft({ ...draft, border: b.key }); }}
                className={`cosmetic-tile ${draft.border === b.key ? 'cosmetic-tile-active' : ''}`}
              >
                <Avatar avatar={draft.avatar} border={b.key} size={44} />
                <span className="truncate">{b.unlocked ? b.name : `🔒 ${b.name}`}</span>
                {!b.unlocked && <span className="text-[10px] font-semibold text-text-muted">{b.requirementLabel}</span>}
              </button>
            ))}
          </div>
        </Accordion>

        <Accordion label="Cím">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {p.catalog.titles.map((t) => (
              <button
                key={t.key}
                type="button"
                disabled={!t.unlocked}
                title={t.unlocked ? t.name : `Feloldás: ${t.requirementLabel}`}
                onClick={() => { setMsg(null); setDraft({ ...draft, title: t.key }); }}
                className={`cosmetic-tile ${draft.title === t.key ? 'cosmetic-tile-active' : ''}`}
              >
                <span className="truncate">{t.unlocked ? t.name : `🔒 ${t.name}`}</span>
                {!t.unlocked && <span className="text-[10px] font-semibold text-text-muted">{t.requirementLabel}</span>}
              </button>
            ))}
          </div>
        </Accordion>

        <Accordion label={`Kiemelt eredmények (${draft.showcase.length}/${p.catalog.maxShowcase})`}>
          {unlockedAchievements.length === 0 ? (
            <p className="text-sm font-semibold text-text-muted">Még nincs feloldott eredményed – tippelj a Tippversenyben!</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {unlockedAchievements.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => toggleShowcase(a.key)}
                  className={`cosmetic-tile ${draft.showcase.includes(a.key) ? 'cosmetic-tile-active' : ''}`}
                >
                  <span aria-hidden className="text-lg">{a.icon}</span>
                  <span className="truncate">{a.name}</span>
                </button>
              ))}
            </div>
          )}
        </Accordion>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Mentés…' : 'Profil mentése'}</button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setDraft(p.settings); setMsg(null); }} disabled={busy}>Visszaállítás</button>
      </div>
      {msg && <div className="mt-3"><Note tone={msg.tone}>{msg.text}</Note></div>}
    </Card>
  );
}

/* ----------------------------------------------------------------- FREE ---- */

function LockedProgression({ p }: { p: ProgressionProfileResponse }) {
  const preview = p.achievements.slice(0, 6);
  return (
    <Card title={<span className="flex items-center gap-2"><Lock className="h-5 w-5 text-warning" /> Tippmester progression</span>}>
      <div className="flex flex-wrap items-center gap-4">
        <Avatar border="classic" size={80} />
        <p className="min-w-0 flex-1 text-sm font-semibold text-text-muted">
          A Tippversenyben szerzett eredményeiddel XP-t gyűjthetsz, szinteket léphetsz, achievementeket oldhatsz fel,
          és testreszabhatod a profilodat.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[['XP', '📈'], ['Eredmények', '🏅'], ['Profilképek', '🙂'], ['Animált profilkeretek', '✨']].map(([label, icon]) => (
          <div key={label} className="rounded-xl border border-dashed border-border bg-card-2 p-3 text-center">
            <div aria-hidden className="text-lg">{icon}</div>
            <div className="mt-0.5 text-xs font-extrabold">{label}</div>
            <div className="text-[11px] font-bold text-text-muted">LEZÁRVA</div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {preview.map((a) => <span key={a.key} className="badge badge-muted" title={a.description}>🔒 {a.name}</span>)}
        <span className="badge badge-muted">+{Math.max(0, p.achievements.length - preview.length)} további</span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary-soft p-4">
        <p className="min-w-0 flex-1 text-sm font-bold text-text">
          Válts PRO csomagra, vegyél részt a Tippversenyben, szerezz XP-t és oldj fel egyedi profil-elemeket.
        </p>
        <Link to="/pro" className="btn btn-primary"><Crown className="h-4 w-4" /> PRO megtekintése</Link>
      </div>
    </Card>
  );
}
