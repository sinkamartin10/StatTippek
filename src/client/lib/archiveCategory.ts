/**
 * Modell-tipp archívum – kategóriaszűrő segédfüggvényei (tiszta függvények,
 * hogy DOM nélkül is tesztelhetők legyenek).
 *
 * A kategória a motor által adott és az archívumban tárolt `category` érték
 * (`TipCategory`) – itt semmit nem osztályozunk újra.
 */
import { CATEGORY_LABEL, parseCategory } from '@shared/tipArchive';
import type { TipCategory } from '@shared/types';

/** Az URL-ben tárolt kategória. Ismeretlen vagy hiányzó érték → nincs szűrés (összes kategória). */
export const categoryFromParam = (raw: string | null | undefined): TipCategory | null => parseCategory(raw);

/** Kategória-felirat; ismeretlen (pl. jövőbeli) érték esetén maga az érték. */
export const categoryLabel = (c: string): string => CATEGORY_LABEL[c as TipCategory] ?? c;

/** Az üres lista üzenete a kategória és a többi szűrő függvényében. */
export function archiveEmptyState(category: TipCategory | null, otherFilters: boolean): { title: string; text: string } {
  if (category) {
    const label = CATEGORY_LABEL[category];
    return otherFilters
      ? { title: `Nincs a szűrőknek megfelelő „${label}” tipp`, text: 'Lazíts a szűrőkön, vagy válts másik kategóriára.' }
      : { title: `Még nincs „${label}” kategóriájú archivált tipp`, text: 'Ebben a kategóriában még nincs elkezdődött mérkőzéshez rögzített tipp. Válassz másik kategóriát, vagy nézd meg az összeset.' };
  }
  return otherFilters
    ? { title: 'Nincs a szűrőknek megfelelő tipp', text: 'Lazíts a szűrőkön, vagy válassz másik időszakot.' }
    : { title: 'Még nincs archivált tipp', text: 'A tippek a mérkőzések elemzésekor rögzülnek, és a kezdés után jelennek meg itt.' };
}
