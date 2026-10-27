/**
 * Ingyenes, 3 napos PRO próbaidőszak – a kliens és a szerver közös típusai és szövegei.
 *
 * Fiókonként egyetlen igénylés, admin-jóváhagyással. A jóváhagyás a meglévő
 * előfizetési mezőkkel (profiles.subscription_status / subscription_end) aktivál,
 * ezért a lejárat után a fiók magától FREE – a jogosultságot mindig a szerver dönti el.
 */

export const PRO_TRIAL_DAYS = 3;

export type TrialRequestStatus = 'pending' | 'approved' | 'rejected';

/**
 * A felhasználó próbaidőszak-állapota (a szerver számolja):
 *  - available   : még nem igényelt, igényelhet
 *  - pending     : elbírálás alatt
 *  - rejected    : elutasítva – újra nem igényelhet
 *  - active      : a próbaidőszak fut (trialEnd-ig)
 *  - used        : a próbaidőszak lejárt – újra nem igényelhet
 *  - pro_member  : fizetős (vagy más módon aktív) PRO – próbaidőszak nem jár
 *  - unavailable : ezen a példányon nincs bejelentkezés / adatbázis
 */
export type TrialState = 'available' | 'pending' | 'rejected' | 'active' | 'used' | 'pro_member' | 'unavailable';

export interface ProTrialStatus {
  state: TrialState;
  requestedAt: string | null;
  trialEnd: string | null;
}

export interface AdminTrialRequestView {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  status: TrialRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  profile: { status: string; subscriptionEnd: string | null; stripeManaged: boolean } | null;
}

export const TRIAL_STATUS_LABEL: Record<TrialRequestStatus, string> = {
  pending: 'Függőben', approved: 'Jóváhagyva', rejected: 'Elutasítva',
};

export const TRIAL_TEXT = {
  title: 'Próbáld ki ingyen a PRO-t 3 napig!',
  description: 'Igényeld az ingyenes próbaidőszakot, és fedezd fel a TippStats PRO funkcióit!',
  button: 'Ingyenes próbaidőszak igénylése',
  pending: 'Igénylésed elbírálás alatt áll. Értesítünk, amint döntés születik.',
  rejected: 'Az ingyenes próbaidőszak igénylését nem fogadtuk el.',
  active: 'Aktív PRO próbaidőszak',
  proMember: 'Már PRO tag vagy, köszönjük!',
} as const;

/** Dátum + időpont magyar formában, budapesti idő szerint (pl. „2026. 10. 30. 14:05”) – a szerveren is egyértelmű. */
export function formatBudapestDateTime(iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('hu-HU', {
    timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}. ${parts.month}. ${parts.day}. ${parts.hour}:${parts.minute}`;
}

/** Az aktiválási értesítés idempotencia-kulcsa: igénylésenként egyetlen értesítés. */
export const trialSourceKey = (requestId: string): string => `pro_trial:${requestId}:activated`;

/** Az aktiválási értesítés szövege (cím + törzs együtt adja ki a teljes üzenetet). */
export function trialActivatedText(trialEnd: string): { title: string; body: string } {
  return {
    title: 'Jó hír! Aktiváltuk számodra a TippStats PRO hozzáférést 3 napra.',
    body: `A próbaidőszak lejárata: ${formatBudapestDateTime(trialEnd)}. Jó szórakozást a PRO funkciók használatához!`,
  };
}
