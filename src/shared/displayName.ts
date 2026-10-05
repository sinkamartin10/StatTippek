/**
 * Megjelenítési név (Display Name) – normalizálás, ellenőrzés és tiltólista.
 *
 * EZ A TILTÓLISTA EGYETLEN HELYE a projektben. Új tiltott kifejezést kizárólag ide kell felvenni.
 *
 * A szerver ezt a modult használja mérvadóként (a mentés előtt kötelezően lefut),
 * a kliens ugyanezt csak azonnali visszajelzésre (UX) – a biztonsági döntés mindig szerveroldali.
 *
 * Megkerülés elleni védelem: az ellenőrzés nem a nyers szövegen fut, hanem egy
 * „kanonikus” alakon (kisbetű, ékezet nélkül, leet-karakterek visszafejtve, elválasztó
 * karakterek eltávolítva), így az „A d m i n”, „ADMIN”, „@dm1n”, „a.d.m.i.n” alakok is kiszűrődnek.
 */

export const DISPLAY_NAME_MIN = 3;
export const DISPLAY_NAME_MAX = 20;

/** Engedélyezett karakterek a megjelenített (nem kanonikus) néven: betű, szám, szóköz, _ . - */
const ALLOWED = /^[\p{L}\p{N}](?:[\p{L}\p{N} _.\-]*[\p{L}\p{N}])?$/u;

// ---------------------------------------------------------------------------
// Tiltólista – EGYETLEN konfigurációs hely
// ---------------------------------------------------------------------------

/**
 * `exact: true`  → csak akkor tilt, ha a kanonikus név PONTOSAN ez (rövid, egyébként
 *                  ártatlan szavakban is előforduló tövek téves tiltásának elkerülésére).
 * `exact` nélkül → a kanonikus névben bárhol előfordulva tilt.
 */
export interface BlockedTerm { term: string; exact?: boolean }

/** Trágár, szexuálisan explicit, sértő és gyűlöletkeltő kifejezések (magyar és angol). */
export const PROFANITY: BlockedTerm[] = [
  // magyar
  { term: 'fasz' }, { term: 'geci' }, { term: 'kurva' }, { term: 'kurv' }, { term: 'picsa' },
  { term: 'pina' }, { term: 'segg' }, { term: 'szar', exact: true }, { term: 'baszd' }, { term: 'bazdmeg' },
  { term: 'baszas' }, { term: 'baszni' }, { term: 'kefel' }, { term: 'buzi' }, { term: 'cigany' },
  { term: 'ciganyoz' }, { term: 'zsidoz' }, { term: 'niggerez' }, { term: 'anyadat' }, { term: 'anyad' },
  { term: 'kocsog' }, { term: 'retkes' }, { term: 'pedofil' }, { term: 'nemiszerv' },
  // angol
  { term: 'fuck' }, { term: 'shit' }, { term: 'bitch' }, { term: 'cunt' }, { term: 'dick', exact: true },
  { term: 'cock', exact: true }, { term: 'pussy' }, { term: 'whore' }, { term: 'slut' }, { term: 'rape' },
  { term: 'porn' }, { term: 'sex', exact: true }, { term: 'nigger' }, { term: 'nigga' }, { term: 'faggot' },
  { term: 'retard' }, { term: 'nazi' }, { term: 'hitler' }, { term: 'kkk', exact: true },
  { term: 'killyourself' }, { term: 'killurself' }, { term: 'suicide' },
];

/** Megtévesztésre alkalmas, hivatalos szerepkört sugalló nevek. */
export const RESERVED: BlockedTerm[] = [
  { term: 'admin' }, { term: 'administrator' }, { term: 'adminisztrator' },
  { term: 'moderator' }, { term: 'moderador' }, { term: 'mod', exact: true },
  { term: 'support' }, { term: 'ugyfelszolgalat' }, { term: 'official' }, { term: 'hivatalos' },
  { term: 'tippstats' }, { term: 'tippmix' }, { term: 'staff' }, { term: 'system' }, { term: 'rendszer' },
  { term: 'owner', exact: true }, { term: 'root', exact: true }, { term: 'superuser' },
  { term: 'tulajdonos' }, { term: 'szerkeszto' }, { term: 'csapat', exact: true },
];

export const BLOCKED_TERMS: BlockedTerm[] = [...PROFANITY, ...RESERVED];

// ---------------------------------------------------------------------------
// Normalizálás
// ---------------------------------------------------------------------------

/** Láthatatlan / irányító karakterek, amelyekkel a szűrés megkerülhető lenne. */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁯﻿]/g;

/**
 * A TÁROLT alak: Unicode NFKC, láthatatlan karakterek eltávolítása,
 * a szóközök egyetlen szóközzé vonása, körbevágás. Ez kerül az adatbázisba.
 */
export function normalizeDisplayName(raw: string): string {
  return (raw ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l',
};

/**
 * Az ELLENŐRZÉSI alak: kisbetű, ékezetek nélkül, leet-karakterek visszafejtve,
 * minden elválasztó és írásjel eltávolítva. Csak összehasonlításra szolgál, nem tároljuk.
 */
export function canonicalDisplayName(raw: string): string {
  const base = normalizeDisplayName(raw).toLowerCase();
  const deLeet = [...base].map((ch) => LEET[ch] ?? ch).join('');
  return deLeet
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // ékezetek
    .replace(/[^a-z0-9]/g, '');      // szóköz, pont, kötőjel, aláhúzás, egyéb írásjel
}

/** Ugyanaz a név-e (az egyediség szempontjából)? Kis-nagybetű nem számít. */
export function sameDisplayName(a: string, b: string): boolean {
  return normalizeDisplayName(a).toLowerCase() === normalizeDisplayName(b).toLowerCase();
}

// ---------------------------------------------------------------------------
// Ellenőrzés
// ---------------------------------------------------------------------------

export type DisplayNameError =
  | 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_CHARS' | 'BLOCKED' | 'NO_LETTER_OR_DIGIT';

export interface DisplayNameCheck {
  ok: boolean;
  /** a mentendő, normalizált alak (csak ok = true esetén érdemleges) */
  value: string;
  error?: DisplayNameError;
  /** a felhasználónak mutatható üzenet – tiltott szó esetén szándékosan NEM árulja el, melyik szó miatt */
  message?: string;
}

function isBlocked(canonical: string): boolean {
  if (!canonical) return false;
  return BLOCKED_TERMS.some((b) => (b.exact ? canonical === b.term : canonical.includes(b.term)));
}

export function validateDisplayName(raw: string): DisplayNameCheck {
  const value = normalizeDisplayName(raw);

  if (value.length < DISPLAY_NAME_MIN) {
    return { ok: false, value, error: 'TOO_SHORT', message: `A megjelenítési név legalább ${DISPLAY_NAME_MIN} karakter legyen.` };
  }
  if (value.length > DISPLAY_NAME_MAX) {
    return { ok: false, value, error: 'TOO_LONG', message: `A megjelenítési név legfeljebb ${DISPLAY_NAME_MAX} karakter lehet.` };
  }
  if (!ALLOWED.test(value)) {
    return { ok: false, value, error: 'INVALID_CHARS', message: 'A megjelenítési név csak betűt, számot, szóközt, pontot, kötőjelet és aláhúzást tartalmazhat, és betűvel vagy számmal kezdődjön és végződjön.' };
  }
  const canonical = canonicalDisplayName(value);
  if (!canonical) {
    return { ok: false, value, error: 'NO_LETTER_OR_DIGIT', message: 'A megjelenítési névnek tartalmaznia kell betűt vagy számot.' };
  }
  if (isBlocked(canonical)) {
    // Szándékosan általános üzenet: nem áruljuk el, melyik kifejezés miatt lett elutasítva
    return { ok: false, value, error: 'BLOCKED', message: 'Ez a megjelenítési név nem használható.' };
  }
  return { ok: true, value };
}

/** A felületen mutatható szabályok (a Profil oldal és a Tippverseny használja). */
export const DISPLAY_NAME_RULES = [
  `${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} karakter`,
  'betű, szám, szóköz, pont, kötőjel, aláhúzás',
  'egyedi a TippStats felhasználói között (a kis- és nagybetű nem különbözteti meg)',
  'nem lehet sértő, és nem utalhat hivatalos szerepkörre',
];
