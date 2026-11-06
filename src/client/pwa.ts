/**
 * Service worker regisztrálása (public/sw.js) – csak production buildben, hogy fejlesztés közben ne
 * zavarjon a Vite-tal. Az `updateViaCache: 'none'` miatt a böngésző a sw.js frissítését mindig a hálózatról nézi.
 * A hibája nem érinti az alkalmazást: service worker nélkül minden ugyanúgy működik.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .catch((e: Error) => console.warn('[pwa] a service worker nem regisztrálható:', e.message));
  });
}
