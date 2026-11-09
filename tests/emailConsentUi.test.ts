/**
 * Marketing-hozzájárulás a felületen: a regisztrációs jelölőnégyzet alapból üres, és bejelöletlenül nem kerül
 * hozzájárulási metaadat a fiókba; a profilkártya egy kattintással fel- és leiratkoztat.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/client/auth/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/auth/AuthContext')>()),
  useAuth: () => ({ configured: true, loading: false, user: null, session: null }),
}));

import { RegisterPage } from '../src/client/auth/AuthPages';
import { signUpMetadata } from '../src/client/auth/AuthContext';
import { MarketingConsentView } from '../src/client/components/MarketingConsent';
import { CONSENT_TEXT, CONSENT_TEXT_VERSION } from '../src/shared/email';

describe('Regisztrációs űrlap', () => {
  it('a marketing-jelölőnégyzet megjelenik, alapból NEM bejelölt, és nem kötelező', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RegisterPage)));
    const box = html.match(/<input[^>]*name="marketingOptIn"[^>]*>/)?.[0];
    expect(box).toBeDefined();
    expect(box).not.toMatch(/checked/);
    expect(box).not.toMatch(/required/);
    expect(html).toContain(CONSENT_TEXT);
    expect(html).toContain('Fiók létrehozása');
  });

  it('metaadat csak kifejezett választásnál: bejelöletlenül semmi nem kerül a fiókba', () => {
    expect(signUpMetadata(false)).toBeUndefined();
    expect(signUpMetadata(true)).toEqual({ marketing_opt_in: true, marketing_opt_in_version: CONSENT_TEXT_VERSION });
  });
});

describe('Profil: feliratkozási kártya', () => {
  const view = (consented: boolean) => renderToStaticMarkup(createElement(MarketingConsentView, {
    consent: { consented, consentedAt: consented ? '2026-11-09T10:00:00.000Z' : null, consentSource: consented ? 'profile' : null, revokedAt: null },
    text: CONSENT_TEXT, onToggle: () => {},
  }));

  it('nem feliratkozott felhasználó: jól látható felhívás és egy elsődleges „Feliratkozás” gomb', () => {
    const html = view(false);
    expect(html).toContain('Iratkozz fel a TippStats emailekre!');
    expect(html).toMatch(/class="btn btn-primary"[^>]*>(?:(?!<\/button>).)*Feliratkozás<\/button>/);
    expect(html).not.toContain('Leiratkozás');
    expect(html).toContain('data-consented="false"');
  });

  it('feliratkozott felhasználó: állapot az időponttal és egy „Leiratkozás” gomb', () => {
    const html = view(true);
    expect(html).toContain('Feliratkoztál a TippStats emailekre');
    expect(html).toContain('Feliratkozva:');
    expect(html).toMatch(/Leiratkozás<\/button>/);
    expect(html).not.toMatch(/Feliratkozás<\/button>/);
  });
});
