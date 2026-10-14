/**
 * Tippverseny – helyi tippvázlat a tömeges beküldéshez (TISZTA logika, DOM nélkül).
 *
 * A felhasználó választásai a beküldésig CSAK itt élnek; mentési kérés nem
 * indul választásonként. A beküldésre kerülő csomag kizárólag az ÚJ és a
 * ténylegesen MÓDOSÍTOTT tippeket tartalmazza – a változatlan, már mentett
 * tipp nem kerül újra a csomagba, így semmit nem írunk felül automatikusan.
 * A zárolást (locked) és a mentett tippet a szerver adja; mindent a szerver
 * ellenőriz újra.
 */
import type { BatchItemError, BatchPredictionInput, CompetitionMatchView } from '@shared/competition';

/** Egy meccs helyi, még be nem küldött tippje (szövegként, ahogy a mezőben áll). */
export interface DraftEntry { home: string; away: string }
export type Drafts = Record<string, DraftEntry>;

/**
 * A meccs állapota a felületen:
 *  - locked     : nem tippelhető (szerver döntése)
 *  - saved      : van mentett tipp, és nincs eltérő vázlat
 *  - changed    : van mentett tipp, a vázlat érvényes és eltér tőle → beküldésre vár
 *  - new        : nincs mentett tipp, a vázlat érvényes → beküldésre vár
 *  - incomplete : a vázlat hiányos (csak az egyik gólszám van megadva) → nem küldhető
 *  - missing    : tippelhető, de nincs se mentett tipp, se vázlat
 */
export type DraftStatus = 'locked' | 'saved' | 'changed' | 'new' | 'incomplete' | 'missing';

const SCORE = /^\d{1,2}$/;

/** A beviteli mező tisztítása: csak számjegy, legfeljebb 2 (0–99). */
export const cleanScore = (v: string) => v.replace(/\D/g, '').slice(0, 2);

export function draftStatus(m: CompetitionMatchView, d: DraftEntry | undefined): DraftStatus {
  if (m.locked) return 'locked';
  const h = d?.home ?? '', a = d?.away ?? '';
  if (h === '' && a === '') return m.myPrediction ? 'saved' : 'missing';
  if (!SCORE.test(h) || !SCORE.test(a)) return 'incomplete';
  const home = Number(h), away = Number(a);
  if (!m.myPrediction) return 'new';
  return m.myPrediction.predictedHomeScore === home && m.myPrediction.predictedAwayScore === away ? 'saved' : 'changed';
}

export interface DraftSummary {
  /** tippelhető (nem zárolt) meccsek */
  open: number;
  /** tippelhető meccs, amelyre van mentett VAGY érvényes vázlat-tipp */
  withTip: number;
  /** a beküldendő csomag (csak új + módosított) */
  toSend: BatchPredictionInput[];
  newCount: number;
  changedCount: number;
  /** tippelhető, de tipp nélküli meccsek */
  missing: CompetitionMatchView[];
  /** hiányosan kitöltött vázlatok – amíg vannak, nem küldhető be a csomag */
  incomplete: CompetitionMatchView[];
}

export function summarize(matches: CompetitionMatchView[], drafts: Drafts): DraftSummary {
  const s: DraftSummary = { open: 0, withTip: 0, toSend: [], newCount: 0, changedCount: 0, missing: [], incomplete: [] };
  for (const m of matches) {
    const st = draftStatus(m, drafts[m.id]);
    if (st === 'locked') continue;
    s.open++;
    if (st === 'missing') { s.missing.push(m); continue; }
    if (st === 'incomplete') { s.incomplete.push(m); if (m.myPrediction) s.withTip++; continue; }
    s.withTip++;
    if (st === 'new' || st === 'changed') {
      const d = drafts[m.id]!;
      s.toSend.push({ competitionMatchId: m.id, predictedHomeScore: Number(d.home), predictedAwayScore: Number(d.away) });
      if (st === 'new') s.newCount++; else s.changedCount++;
    }
  }
  return s;
}

/**
 * Elfér-e a csomag a FREE napi keretben? (A szerver ugyanezt kényszeríti ki;
 * itt csak előre jelezzük.) PRO-nál (quota null) mindig igen.
 */
export function quotaShortfall(summary: DraftSummary, quota: { remaining: number } | null): number {
  if (!quota) return 0;
  return Math.max(0, summary.newCount - quota.remaining);
}

/** Beküldhető-e most a csomag, és ha nem, miért. */
export function submitBlocker(summary: DraftSummary, quota: { remaining: number } | null): string | null {
  if (summary.incomplete.length) return `${summary.incomplete.length} mérkőzésnél csak az egyik gólszám van megadva – egészítsd ki vagy töröld.`;
  if (!summary.toSend.length) return 'Nincs új vagy módosított tipp a beküldéshez.';
  const over = quotaShortfall(summary, quota);
  if (over > 0) return `Ma még ${quota!.remaining} új tippet adhatsz le, a csomagban ${summary.newCount} új tipp van. Törölj ${over} új tippet, vagy próbáld holnap.`;
  return null;
}

/**
 * Sikeres mentés után: a szerver által IGAZOLT tételek vázlata törlődik
 * (onnantól a mentett állapot látszik), a többi választás megmarad.
 */
export function clearConfirmed(drafts: Drafts, confirmedMatchIds: string[]): Drafts {
  const out: Drafts = { ...drafts };
  for (const id of confirmedMatchIds) delete out[id];
  return out;
}

/** A szerver tételes hibáinak meccsenkénti térképe (a felület a kártyán mutatja). */
export function errorsByMatch(errors: BatchItemError[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors ?? []) if (e.competitionMatchId) out[e.competitionMatchId] = e.message;
  return out;
}

// A meglévő egyfutásos kapu újrahasznosítva (nincs második implementáció).
export { singleFlight } from './learningDashboard';
