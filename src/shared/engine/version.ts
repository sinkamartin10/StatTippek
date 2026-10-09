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
