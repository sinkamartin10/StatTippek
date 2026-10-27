/**
 * A statisztikai motor verziója – a Modell-tipp archívum minden sora ezt rögzíti.
 *
 * A motor determinisztikus (xG + Poisson), NEM nyelvi modell és nem tanul
 * magától: ugyanabból az adatból mindig ugyanazt a tippet adja. A verziót
 * KÉZZEL kell emelni, ha a tippek számítása vagy kiválasztása megváltozik
 * (models.ts, tips.ts, analysis.ts xG/Poisson része) – így az archívumban
 * a régi és az új motor tippjei nem keverednek össze.
 */
export const ENGINE_VERSION = 'xg-poisson-1';

/**
 * Kupasorozatok (hazai és nemzetközi kupa, válogatott sorozat, barátságos meccsek) elemzéseinek
 * motorverziója. Ugyanaz az xG + Poisson motor, de a liga-alapérték a csapatok bajnokságából jön, és
 * nincs tabella-alapú mutató (lásd engine/baseline, competitionFormat) – ezért a kupatippek külön
 * verzión rögzülnek, és a bajnoki (`xg-poisson-1`) archívum / kalibráció nem keveri őket.
 * A bajnoki elemzések verziója változatlanul `ENGINE_VERSION`.
 */
export const CUP_ENGINE_VERSION = 'xg-poisson-cup-1';
