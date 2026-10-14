/**
 * PRO előfizetés kézi fizetéssel (banki átutalás / Revolut) – közös típusok és adatok.
 *
 * A fizetés NEM automatikus: a felhasználó jelzi a befizetést (függő kérelem),
 * az admin a beérkezett összeg ellenőrzése után hagyja jóvá. A PRO-t KIZÁRÓLAG
 * a szerver aktiválja az admin jóváhagyásakor – a kérelem elküldése önmagában
 * semmit nem változtat a jogosultságon.
 */

/** A kedvezményezett adatai – a felületen megjelenítve, másolható formában. */
export const PAYEE = {
  bank: {
    beneficiary: 'Sinka Martin',
    /** megjelenítés (8-8-8 jegyű tagolás) */
    accountNumber: '30200014 19913410 31395146',
  },
  revolut: {
    username: '@martin2pal',
    /**
     * A Revolut nyilvános profil-linkje (revolut.me/<felhasználónév>, a Revolut
     * hivatalos formátuma; a profil létezése ellenőrizve). Összeget NEM töltünk elő.
     */
    profileUrl: 'https://revolut.me/martin2pal',
  },
} as const;

/** Számlaszám a másoláshoz: csak számjegyek (a banki űrlapok így biztosan elfogadják). */
export const accountNumberDigits = (s: string = PAYEE.bank.accountNumber) => s.replace(/\D/g, '');

export type PaymentMethod = 'bank_transfer' | 'revolut';
export const PAYMENT_METHODS: PaymentMethod[] = ['bank_transfer', 'revolut'];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = { bank_transfer: 'Banki átutalás', revolut: 'Revolut' };

export type PaymentRequestStatus = 'pending' | 'approved' | 'rejected';
export const PAYMENT_STATUS_LABEL: Record<PaymentRequestStatus, string> = {
  pending: 'Ellenőrzésre vár',
  approved: 'Elfogadva – PRO aktiválva',
  rejected: 'Elutasítva',
};

export type BillingInterval = 'month' | 'year';

/** Az érvényes PRO-ár (a szerver adja; a kérelembe is a szerver írja be, nem a kliens). */
export interface ProPrice {
  amount: number;
  currency: string;
  interval: BillingInterval;
  /** pl. „2 990 Ft/hó” */
  label: string;
  /** honnan jön: a Stripe ár-azonosítóból, vagy az alkalmazás eddigi tartalék árából */
  source: 'stripe' | 'app';
}

/**
 * Az alkalmazás eddigi, a felületen „jelenlegi ár”-ként mutatott tartalék ára
 * (korábban `Pro.tsx`: PRO_PRICE = '2 990 Ft/hó'). Akkor érvényes, ha a Stripe
 * ár nincs beállítva – élesben jelenleg ez a helyzet. Nem új összeg: ugyanaz
 * az érték került egyetlen, szerver és kliens által közösen használt helyre.
 */
export const APP_PRO_PRICE: ProPrice = { amount: 2990, currency: 'HUF', interval: 'month', label: '2 990 Ft/hó', source: 'app' };

export const INTERVAL_LABEL: Record<BillingInterval, string> = { month: '1 hónap', year: '1 év' };

/** Egy kérelem a felhasználó saját nézetében. */
export interface PaymentRequestView {
  id: string;
  method: PaymentMethod;
  amount: number;
  currency: string;
  interval: BillingInterval;
  /** a közlemény, amit a kérelem rögzített (a fiók e-mail-címe) */
  reference: string;
  status: PaymentRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  /** jóváhagyáskor: meddig szól a PRO (null = már korlátlan PRO volt, nem rövidítettük) */
  activatedUntil: string | null;
  decisionNote: string | null;
}

/** Admin nézet: a kérelmező fiókja is. */
export interface AdminPaymentRequestView extends PaymentRequestView {
  userId: string;
  email: string;
  decidedBy: string | null;
  /** a kérelmező JELENLEGI profilállapota (a döntéshez) */
  profile: { status: string; subscriptionEnd: string | null; stripeManaged: boolean } | null;
}

export interface ProPaymentInfo {
  price: ProPrice;
  payee: typeof PAYEE;
  /** bejelentkezve: a saját kérelmek (legújabb elöl); különben üres */
  requests: PaymentRequestView[];
  /** bejelentkezve: a közlemény (a fiók e-mail-címe), a szerver által ismert érték */
  reference: string | null;
}

/**
 * Megjelenítés: „2 990 Ft” – ezres tagolással, nem törhető szóközzel. Szándékosan
 * nem `toLocaleString('hu-HU')`: a böngészők a négyjegyű számot nem tagolják
 * (2990), a Node igen – így a felület és a tesztek eltérhetnének.
 */
export function formatAmount(amount: number, currency: string): string {
  if (currency.toUpperCase() === 'HUF') return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Ft`;
  return `${amount} ${currency.toUpperCase()}`;
}
