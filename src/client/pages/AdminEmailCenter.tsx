/**
 * Admin: Email Center – marketingkampányok és rendszerüzenetek.
 *
 * A címzetteket és címeiket kizárólag a szerver ismeri: a felület csak a darabszámot látja. Küldés csak
 * előnézet után, a szerver által számolt címzettszám visszaigazolásával; rendszerüzenetnél kötelező nyilatkozattal.
 * Az admin jogot a szerver dönti el (ADMIN_EMAILS) – nem admin fiók 403-at kap.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, RotateCcw, Save, Send, TestTube2 } from 'lucide-react';
import {
  AUDIENCES_FOR, CAMPAIGN_STATUS_LABEL, EMAIL_AUDIENCE_LABEL, EMAIL_KIND_LABEL,
  type CampaignPreview, type CampaignStatus, type CampaignView, type EmailAudience, type EmailKind,
} from '@shared/email';
import { api, ApiError } from '../lib/api';
import { fmtDateTime, useAsync } from '../lib/format';
import { singleFlight } from '../lib/learningDashboard';
import { Card, EmptyState, ErrorBox, Loading, Note, PageHeader } from '../components/ui';

const STATUS_BADGE: Record<CampaignStatus, string> = { draft: 'badge-muted', sending: 'badge-blue', sent: 'badge-green', partial: 'badge-yellow', failed: 'badge-red' };
type Draft = { kind: EmailKind; audience: EmailAudience; subject: string; html: string };
const EMPTY: Draft = { kind: 'marketing', audience: 'all', subject: '', html: '' };

export default function AdminEmailCenter() {
  const status = useAsync(() => api.adminEmailStatus(), []);
  const list = useAsync(() => api.adminEmailCampaigns(), []);
  const [current, setCurrent] = useState<CampaignView | null>(null);
  // A szerkesztő példánya CSAK megnyitáskor / új emailnél cserélődik – mentéskor nem. (Korábban a kulcs a kampány
  // azonosítója volt: egy új email első mentése – amit az Előnézet gomb is elvégez – újraszerkesztette a szerkesztőt,
  // és a frissen kapott előnézet a küldés gombbal együtt elveszett.)
  const [editorKey, setEditorKey] = useState(0);
  const openEditor = (c: CampaignView | null) => { setCurrent(c); setEditorKey((k) => k + 1); };

  // küldés közben a lista néhány másodpercenként frissül (a statisztika a szerverről jön)
  const sending = (list.data ?? []).some((c) => c.status === 'sending');
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(list.reload, 4000);
    return () => clearInterval(t);
  }, [sending, list.reload]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader emoji="✉️" title="Email Center" text="Marketingkampányok (csak hozzájárulóknak, leiratkozással) és szolgáltatási célú rendszerüzenetek."
        right={<Link to="/admin/pro-befizetesek" className="btn btn-sm">PRO befizetések</Link>} />
      {status.data && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4" data-testid="consent-count">
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Marketinghez hozzájáruló felhasználók</div>
            <div className="mt-1 text-2xl font-black">{status.data.marketingConsentCount ?? '–'}</div>
            <div className="text-xs font-semibold text-text-muted">Csak nekik küldhető marketingkampány.</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-text-muted">Kampányonkénti küldési korlát</div>
            <div className="mt-1 text-2xl font-black">{status.data.maxRecipients}</div>
            <div className="text-xs font-semibold text-text-muted">Rendszerüzenet minden érintett felhasználónak kimehet.</div>
          </div>
        </div>
      )}
      {status.data && !status.data.sendingConfigured && (
        <Note tone="warn">Az emailküldés nincs beállítva ezen a szerveren (hiányzik: {status.data.missing.join(', ')}). Piszkozat és előnézet készíthető, küldeni nem lehet.</Note>
      )}
      <Editor key={editorKey} campaign={current} maxRecipients={status.data?.maxRecipients ?? null}
        sendingConfigured={status.data ? status.data.sendingConfigured : null}
        onSaved={(c) => { setCurrent(c); list.reload(); }} onNew={() => openEditor(null)} />
      <Card title="Korábbi kampányok">
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} />
          : !list.data?.length ? <EmptyState emoji="📭" title="Még nincs kampány" />
            : <div className="space-y-2">{list.data.map((c) => <CampaignRow key={c.id} c={c} onOpen={() => openEditor(c)} onChanged={list.reload} />)}</div>}
      </Card>
    </div>
  );
}

/**
 * Miért nem indítható most a küldés – a felület ezt KIÍRJA, nem rejti el szó nélkül a gombot. Csak tájékoztat:
 * minden feltételt a szerver is ellenőriz a megerősítéskor (piszkozat, tartalom, címzettszám, korlát, beállítás).
 */
/**
 * A levél előnézete. A levél HTML-jét NEM vizsgáljuk és NEM írjuk át – a biztonságot a megjelenítés adja:
 * a `sandbox=""` (egyetlen engedély nélkül) miatt a keretben szkript nem fut, a dokumentum egyedi, átlátszatlan
 * eredetű (nem éri el a felület DOM-ját, cookie-jait, localStorage-ban tárolt munkamenet-tokenjét és állapotát, és
 * nem indíthat hitelesített API-kérést – az admin API Bearer tokent kér, cookie-t nem), űrlap nem küldhető, felugró
 * ablak nem nyitható, a felső ablak nem navigálható. Képek és stíluslapok betöltődnek, ahogy egy levelezőben.
 * SOHA ne kerüljön ide `allow-scripts` / `allow-same-origin` (a kettő együtt a sandbox teljes feloldása).
 */
export function EmailPreviewFrame({ html }: { html: string }) {
  return <iframe title="Email előnézet" sandbox="" srcDoc={html} className="h-[520px] w-full rounded-xl border border-border bg-white" />;
}

/** a szerver biztonságos hibaüzenete + HTTP-státusz és hibakód (a hibabejelentéshez); stack trace soha */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const dbCode = typeof e.details?.dbCode === 'string' ? `, adatbázis-kód: ${e.details.dbCode}` : '';
    return `${e.message} (HTTP ${e.status}${e.code ? `, ${e.code}` : ''}${dbCode})`;
  }
  return e instanceof Error && e.message ? e.message : 'Ismeretlen hiba.';
}

export function sendBlockers(a: { campaign: CampaignView | null; preview: CampaignPreview; kind: EmailKind; sendingConfigured: boolean | null }): string[] {
  const out: string[] = [];
  if (!a.campaign) out.push('Előbb mentsd el a kampányt.');
  else if (a.campaign.status !== 'draft') out.push(`Ez a kampány már nem piszkozat (${CAMPAIGN_STATUS_LABEL[a.campaign.status].toLowerCase()}), újra nem indítható.`);
  if (a.sendingConfigured === false) out.push('Az emailküldés nincs beállítva ezen a szerveren.');
  if (a.preview.issues.length) out.push('Javítsd a fent jelzett beállítási hibát, majd kérj új előnézetet.');
  if (a.preview.recipientCount === 0) {
    out.push(a.kind === 'marketing'
      ? 'Nincs címzett: marketing csak megerősített email-című, marketinghez hozzájáruló felhasználónak küldhető, és a kiválasztott szűrőben jelenleg nincs ilyen. (Hozzájárulni a profilban vagy a regisztrációkor lehet.)'
      : 'Nincs címzett: a kiválasztott szűrőben nincs megerősített email-című felhasználó.');
  }
  if (a.preview.recipientCount > a.preview.maxRecipients) out.push(`A címzettek száma (${a.preview.recipientCount}) meghaladja a kampányonkénti korlátot (${a.preview.maxRecipients}).`);
  return out;
}

function Editor({ campaign, maxRecipients, sendingConfigured, onSaved, onNew }: { campaign: CampaignView | null; maxRecipients: number | null; sendingConfigured: boolean | null; onSaved: (c: CampaignView) => void; onNew: () => void }) {
  const [d, setD] = useState<Draft>(campaign ? { kind: campaign.kind, audience: campaign.audience, subject: campaign.subject, html: campaign.html } : EMPTY);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [attest, setAttest] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const locked = !!campaign && campaign.status !== 'draft';
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setPreview(null); setConfirming(false); };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ tone: 'warn', text: errorText(e) }); } finally { setBusy(false); }
  };
  /** mentés (új vagy piszkozat), majd a mentett kampány */
  const save = async (): Promise<CampaignView> => {
    const c = campaign ? await api.adminUpdateEmailCampaign(campaign.id, d) : await api.adminCreateEmailCampaign(d);
    onSaved(c);
    return c;
  };
  const sendRef = useRef<() => Promise<void>>(async () => {});
  sendRef.current = () => run(async () => {
    if (!campaign || !preview) return;
    await api.adminEmailSend(campaign.id, { recipientCount: preview.recipientCount, attestSystem: d.kind === 'system' && attest });
    setConfirming(false);
    setMsg({ tone: 'info', text: `A küldés elindult ${preview.recipientCount} címzettnek. Az állapot a kampánylistában követhető.` });
    onSaved({ ...campaign, status: 'sending' });
  });
  const sendGate = useRef(singleFlight(() => sendRef.current()));
  const blockers = preview ? sendBlockers({ campaign, preview, kind: d.kind, sendingConfigured }) : [];

  return (
    <Card title={campaign ? (locked ? 'Kampány (elküldve – csak olvasható)' : 'Piszkozat szerkesztése') : 'Új email'}
      right={campaign ? <button type="button" className="btn btn-sm" onClick={onNew}>Új email</button> : undefined}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="field-label">Kategória</span>
            <div className="mt-1 flex flex-wrap gap-2" role="radiogroup" aria-label="Kategória">
              {(['marketing', 'system'] as EmailKind[]).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={d.kind === k} disabled={locked} className={`chip ${d.kind === k ? 'chip-active' : ''}`}
                  onClick={() => set({ kind: k, audience: AUDIENCES_FOR[k].includes(d.audience) ? d.audience : 'all' })}>{EMAIL_KIND_LABEL[k]}</button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="field-label">Címzettek</span>
            <select className="input mt-1" value={d.audience} disabled={locked} onChange={(e) => set({ audience: e.target.value as EmailAudience })}>
              {AUDIENCES_FOR[d.kind].map((a) => <option key={a} value={a}>{EMAIL_AUDIENCE_LABEL[a]}</option>)}
            </select>
          </label>
        </div>
        <Note tone={d.kind === 'marketing' ? 'info' : 'warn'}>
          {d.kind === 'marketing'
            ? 'Marketing: kizárólag a marketinghez hozzájáruló felhasználók kapják meg (a szűrőtől függetlenül), minden levél alján leiratkozó linkkel.'
            : 'Rendszerüzenet: minden érintett felhasználónak kimegy a marketing-hozzájárulástól függetlenül, mert a szolgáltatás nyújtásához szükséges tájékoztatás (pl. üzemszünet, fiókbiztonság, feltételek változása). Ajánlat, akció, kupon nem lehet benne – ezt a küldés előtti nyilatkozattal te igazolod.'}
        </Note>
        <label className="block">
          <span className="field-label">Tárgy</span>
          <input className="input mt-1" maxLength={200} value={d.subject} disabled={locked} onChange={(e) => set({ subject: e.target.value })} />
        </label>
        <label className="block">
          <span className="field-label">HTML tartalom</span>
          <textarea className="input mt-1 min-h-[220px] font-mono text-xs" value={d.html} disabled={locked} onChange={(e) => set({ html: e.target.value })}
            placeholder="<p>Szia!</p><p>…</p>" />
        </label>

        <div className="flex flex-wrap gap-2">
          {!locked && <button type="button" className="btn" disabled={busy} onClick={() => run(async () => { await save(); setMsg({ tone: 'info', text: 'Mentve.' }); })}><Save className="h-4 w-4" /> Mentés</button>}
          <button type="button" className="btn" disabled={busy || !d.subject.trim() || !d.html.trim()} onClick={() => run(async () => {
            const c = locked ? campaign! : await save();
            setPreview(await api.adminEmailPreview(c.id));
          })}><Eye className="h-4 w-4" /> {locked ? 'Előnézet' : 'Előnézet és küldés'}</button>
          {campaign && !locked && <button type="button" className="btn" disabled={busy} onClick={() => run(async () => {
            const c = await save();
            const r = await api.adminEmailTest(c.id);
            setMsg({ tone: 'info', text: `Teszt email elküldve ide: ${r.to}` });
          })}><TestTube2 className="h-4 w-4" /> Teszt email a saját címemre</button>}
        </div>
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        {!locked && !preview && d.subject.trim() && d.html.trim() && (
          <p className="text-xs font-semibold text-text-muted">A küldés az előnézetből indítható: a szerver ekkor számolja meg a címzetteket.</p>
        )}

        {preview && (
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-sm font-bold">Címzettek most: {preview.recipientCount}{maxRecipients ? ` (korlát: ${maxRecipients})` : ''}</p>
            {preview.issues.length > 0 && <Note tone="warn">{preview.issues.map((i) => <span key={i} className="block">{i}</span>)}</Note>}
            <EmailPreviewFrame html={preview.html} />
            {!locked && blockers.length > 0 && (
              <div className="space-y-2 rounded-xl border border-border bg-card-2 p-3" data-testid="send-blocked">
                <button type="button" className="btn btn-primary" disabled><Send className="h-4 w-4" /> Küldés</button>
                <Note tone="warn">{blockers.map((b) => <span key={b} className="block">{b}</span>)}</Note>
              </div>
            )}
            {campaign && !locked && blockers.length === 0 && (
              <div className="space-y-2 rounded-xl border border-border bg-card-2 p-3">
                {d.kind === 'system' && (
                  <label className="flex items-start gap-2 text-sm font-semibold">
                    <input type="checkbox" className="mt-1" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
                    Kijelentem, hogy ez az üzenet kizárólag szolgáltatási vagy biztonsági célú, és nem tartalmaz marketingelemet.
                  </label>
                )}
                {!confirming ? (
                  <button type="button" className="btn btn-primary" disabled={busy || (d.kind === 'system' && !attest)} onClick={() => setConfirming(true)}>
                    <Send className="h-4 w-4" /> Küldés {preview.recipientCount} címzettnek
                  </button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm font-bold">Biztosan elküldöd a(z) „{d.subject}” {EMAIL_KIND_LABEL[d.kind].toLowerCase()}t {preview.recipientCount} címzettnek? Ez nem vonható vissza.</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { if (!busy) void sendGate.current(); }}>{busy ? 'Indítás…' : 'Igen, küldés'}</button>
                      <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>Mégse</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function CampaignRow({ c, onOpen, onChanged }: { c: CampaignView; onOpen: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // „sending”: ha a szerver küldés közben újraindult, a megszakadt küldés folytatható (ha valóban fut, a szerver 409-et ad)
  const retryable = c.status === 'partial' || c.status === 'failed' || c.status === 'sending';
  return (
    <div className="rounded-xl border border-border bg-card-2 p-3" data-status={c.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-extrabold">{c.subject}</div>
          <div className="text-xs font-semibold text-text-muted">{EMAIL_KIND_LABEL[c.kind]} · {EMAIL_AUDIENCE_LABEL[c.audience]} · {fmtDateTime(c.createdAt)}</div>
        </div>
        <span className={`badge ${STATUS_BADGE[c.status]}`}>{CAMPAIGN_STATUS_LABEL[c.status]}</span>
      </div>
      {c.status !== 'draft' && (
        <p className="mt-1 text-xs font-semibold text-text-muted">
          Címzett: {c.recipientCount} · elküldve: {c.sentCount} · sikertelen: {c.failedCount} · kihagyva (leiratkozott): {c.skippedCount}
          {c.finishedAt && ` · befejezve: ${fmtDateTime(c.finishedAt)}`}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" onClick={onOpen}>{c.status === 'draft' ? 'Szerkesztés' : 'Megnyitás'}</button>
        {retryable && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => {
            setBusy(true); setErr(null);
            try { await api.adminEmailRetry(c.id); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
          }}><RotateCcw className="h-3.5 w-3.5" /> {c.status === 'sending' ? 'Folytatás (ha megszakadt)' : 'Sikertelenek újraküldése'}</button>
        )}
      </div>
      {err && <div className="mt-2"><Note tone="warn">{err}</Note></div>}
    </div>
  );
}
