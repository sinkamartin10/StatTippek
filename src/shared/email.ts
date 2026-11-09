/**
 * Email Center – a kliens és a szerver közös típusai és szövegei.
 *
 * Két, SZIGORÚAN elkülönített kategória:
 *  - marketing: kizárólag dokumentált marketing-hozzájárulással rendelkezőknek, minden levélben leiratkozással,
 *  - system: csak szolgáltatási / biztonsági célú üzenet; marketingelem nélkül, leiratkozó link nélkül.
 */

export type EmailKind = 'marketing' | 'system';
export type EmailAudience = 'all' | 'free' | 'pro' | 'marketing_consent';
export type CampaignStatus = 'draft' | 'sending' | 'sent' | 'partial' | 'failed';
export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
export type ConsentSource = 'profile' | 'registration' | 'unsubscribe_link' | 'one_click';

/**
 * A regisztrációs jelölőnégyzet választása a Supabase felhasználói metaadataiban (bejelöletlen négyzetnél NEM kerül
 * be). A 0025 adatbázis-triggere a regisztrációval EGY tranzakcióban rögzíti, a hozzájárulás idejeként a Supabase
 * által írt auth.users.created_at-tal; a metaadat későbbi módosítása nem ad hozzájárulást.
 */
export const REGISTRATION_OPT_IN_META = 'marketing_opt_in';
export const REGISTRATION_OPT_IN_VERSION_META = 'marketing_opt_in_version';

/** a hozzájárulási szöveg verziója – a naplóba kerül, szövegváltozáskor növelni kell */
export const CONSENT_TEXT_VERSION = 'v1';
export const CONSENT_TEXT = 'Kérek marketing emaileket a TippStatstól (újdonságok, ajánlatok, akciók). Bármikor leiratkozhatok a profilomban vagy a levelek alján lévő linkkel.';

export const EMAIL_KIND_LABEL: Record<EmailKind, string> = { marketing: 'Marketingkampány', system: 'Rendszerüzenet' };
export const EMAIL_AUDIENCE_LABEL: Record<EmailAudience, string> = {
  all: 'Összes megfelelő címzett', free: 'FREE felhasználók', pro: 'PRO felhasználók', marketing_consent: 'Marketinghez hozzájáruló felhasználók',
};
/** rendszerüzenet nem célozhatja a marketing-hozzájárulókat (az marketing lenne) */
export const AUDIENCES_FOR: Record<EmailKind, EmailAudience[]> = {
  marketing: ['all', 'free', 'pro', 'marketing_consent'],
  system: ['all', 'free', 'pro'],
};
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Piszkozat', sending: 'Küldés folyamatban', sent: 'Elküldve', partial: 'Részben sikertelen', failed: 'Sikertelen',
};

export interface MarketingConsentView {
  consented: boolean;
  consentedAt: string | null;
  consentSource: string | null;
  revokedAt: string | null;
}

export interface CampaignView {
  id: string;
  kind: EmailKind;
  audience: EmailAudience;
  subject: string;
  html: string;
  status: CampaignStatus;
  createdBy: string;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  systemAttested: boolean;
}

export interface DeliveryStats { pending: number; sending: number; sent: number; failed: number; skipped: number }

export interface CampaignPreview {
  /** a végleges levél HTML-je (lábléccel; marketingnél minta leiratkozó linkkel) */
  html: string;
  /** a szűrésnek MOST megfelelő címzettek száma – a küldés megerősítésekor ezt kell visszaküldeni */
  recipientCount: number;
  /** a küldési korlát (ennél több címzettnek egy kampány nem mehet ki) */
  maxRecipients: number;
  /** a tartalom problémái (pl. rendszerüzenetben marketingelem) – üres lista esetén küldhető */
  issues: string[];
}

export interface EmailCenterStatus {
  /** van-e beállított küldőszolgáltatás (RESEND_API_KEY, EMAIL_FROM, leiratkozási titok, publikus API-cím) */
  sendingConfigured: boolean;
  /** a hiányzó beállítások nevei (értékek nélkül) */
  missing: string[];
  maxRecipients: number;
  /** a marketinghez JELENLEG hozzájáruló felhasználók száma (null, ha nincs adatbázis) */
  marketingConsentCount: number | null;
}
