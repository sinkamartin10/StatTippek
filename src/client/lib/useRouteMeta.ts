/**
 * Kliensoldali navigáció utáni metaadat-frissítés ugyanabból az útvonaltáblából, amelyből a Worker az első
 * betöltéskor dolgozik (src/shared/seo.ts). Az indexelés mérvadó forrása a szerver (Worker) – ez csak
 * összhangban tartja a fejlécet SPA-navigáció után (cím, leírás, robots, canonical).
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { SITE_ORIGIN, metaForPath } from '@shared/seo';

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.content = content;
}

export function useRouteMeta(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const m = metaForPath(pathname);
    document.title = m.title;
    setMeta('name', 'description', m.description);
    setMeta('name', 'robots', m.index && location.host === new URL(SITE_ORIGIN).host ? 'index, follow' : m.status === 404 ? 'noindex' : 'noindex, follow');
    setMeta('property', 'og:title', m.title);
    setMeta('property', 'og:description', m.description);
    const canon = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (m.canonicalPath) {
      const href = SITE_ORIGIN + m.canonicalPath;
      if (canon) canon.href = href;
      else { const l = document.createElement('link'); l.rel = 'canonical'; l.href = href; document.head.appendChild(l); }
    } else canon?.remove();
  }, [pathname]);
}

/** Dinamikus oldal (meccs, csapat) valódi címe, amint az adat betöltött. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => { if (title) document.title = title; }, [title]);
}
