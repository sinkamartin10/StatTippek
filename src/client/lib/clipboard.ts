/**
 * Szöveg vágólapra másolása. Elsődlegesen a Clipboard API; ha az nem érhető el
 * (régebbi böngésző, nem biztonságos környezet), egy rejtett szövegmezős tartalék.
 * true = sikerült. A paraméterek a tesztekhez injektálhatók.
 */
export async function copyText(
  text: string,
  clipboard: { writeText(t: string): Promise<void> } | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): Promise<boolean> {
  try {
    if (clipboard?.writeText) { await clipboard.writeText(text); return true; }
  } catch { /* tartalékra váltunk */ }
  if (!doc) return false;
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
