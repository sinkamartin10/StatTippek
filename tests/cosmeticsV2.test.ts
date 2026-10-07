/**
 * Kozmetikumok V2, nyilvános profil és navigáció (frontend fázis).
 *
 * A projektben nincs DOM-futtató, ezért itt a vizuális REGISZTER teljességét,
 * a leképezések helyességét és a komponensek forrás-szerződését ellenőrizzük.
 * A tényleges megjelenést és a reszponzivitást valódi böngészőben néztem meg
 * négy képernyőméreten (lásd a reportot).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  RARITY_WEIGHT, VISUAL_KEYS, backgroundVisual, effectVisual, emblemVisual,
  frameVisual, hasVisual, nameVisual, titleVisual,
} from '../src/client/lib/cosmeticVisuals';
import { RARITIES, SHOP_CATEGORIES, SHOP_SEED, type ShopCategory } from '../src/shared/shop';

const read = (p: string) => readFileSync(p, 'utf8');
/**
 * A forrás KÓD-része, kommentek nélkül. A fejléc-kommentek szándékosan
 * megnevezik a tiltott mezőket („user_id SOHA”), ezért a „nincs privát adat"
 * típusú állításokat csak a kódra mérjük.
 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
const seedOf = (c: ShopCategory) => SHOP_SEED.filter((i) => i.category === c);

// ===========================================================================
// 1) Minden item kapott vizuális leírást
// ===========================================================================

describe('Kozmetikumok V2 – teljesség', () => {
  it('H1. MIND az 53 shop itemnek van vizuális konfigurációja', () => {
    const missing = SHOP_SEED.filter((i) => !hasVisual(i.itemKey, i.category));
    expect(missing.map((i) => `${i.category}/${i.itemKey}`)).toEqual([]);
    expect(SHOP_SEED).toHaveLength(53);
  });

  it('H2. a regiszter PONTOSAN a katalógus kulcsait tartalmazza (nincs árva bejegyzés)', () => {
    for (const c of SHOP_CATEGORIES) {
      const seedKeys = seedOf(c).map((i) => i.itemKey).sort();
      const visualKeys = [...VISUAL_KEYS[c]].sort();
      expect(visualKeys, c).toEqual(seedKeys);
    }
  });

  it('H3. minden kategória feloldója a saját itemeire ad találatot', () => {
    for (const i of seedOf('frame')) expect(frameVisual(i.itemKey), i.itemKey).toBeTruthy();
    for (const i of seedOf('name_color')) expect(nameVisual(i.itemKey), i.itemKey).toBeTruthy();
    for (const i of seedOf('name_effect')) expect(effectVisual(i.itemKey), i.itemKey).toBeTruthy();
    for (const i of seedOf('title')) expect(titleVisual(i.itemKey), i.itemKey).toBeTruthy();
    for (const i of seedOf('avatar')) expect(emblemVisual(i.itemKey), i.itemKey).toBeTruthy();
    for (const i of seedOf('profile_background')) expect(backgroundVisual(i.itemKey), i.itemKey).toBeTruthy();
  });

  it('H4. ismeretlen kulcs nem dönti el a felületet', () => {
    expect(frameVisual('nincs_ilyen')).toBeTruthy();      // biztonságos alapértelmezés
    expect(nameVisual('nincs_ilyen')).toBeNull();
    expect(effectVisual('nincs_ilyen')).toBeNull();
    expect(titleVisual('nincs_ilyen')).toBeNull();
    expect(emblemVisual('nincs_ilyen')).toBeNull();
    expect(backgroundVisual('nincs_ilyen')).toBeNull();
    for (const f of [frameVisual, nameVisual, effectVisual, titleVisual, emblemVisual, backgroundVisual]) {
      expect(f(null)).toBeNull();
      expect(f(undefined)).toBeNull();
    }
  });
});

// ===========================================================================
// 2) Az itemek vizuálisan MEGKÜLÖNBÖZTETHETŐK
// ===========================================================================

describe('Kozmetikumok V2 – megkülönböztethetőség', () => {
  it('H5. a 15 keret nem ugyanannak a karikának a színváltozata', () => {
    const frames = seedOf('frame').map((i) => frameVisual(i.itemKey)!);
    const shapes = new Set(frames.map((f) => f.shape));
    expect(shapes.size, `csak ${shapes.size} különböző sziluett`).toBeGreaterThanOrEqual(8);
    // minden keret teljes leírása egyedi (sziluett + szín + részecske + mozgás)
    const sigs = frames.map((f) => `${f.shape}|${f.colors.join(',')}|${f.particles}|${f.motion}`);
    expect(new Set(sigs).size).toBe(frames.length);
  });

  it('H6. a 9 névszín nem kilenc puszta CSS-szín', () => {
    const colors = seedOf('name_color').map((i) => nameVisual(i.itemKey)!);
    expect(colors.filter((c) => c.colors.length > 1).length, 'többszínű kezelés').toBeGreaterThanOrEqual(5);
    expect(colors.some((c) => c.sheen)).toBe(true);
    expect(colors.some((c) => c.perCharacter)).toBe(true);
    expect(new Set(colors.map((c) => c.colors.join(','))).size).toBe(colors.length);
  });

  it('H7. a 6 név-effekt mind más fajta', () => {
    const kinds = seedOf('name_effect').map((i) => effectVisual(i.itemKey)!.kind);
    expect(new Set(kinds).size).toBe(6);
  });

  it('H8. a 8 embléma mind más ikont kap', () => {
    const icons = seedOf('avatar').map((i) => emblemVisual(i.itemKey)!.icon);
    expect(new Set(icons).size).toBe(8);
  });

  it('H9. a 7 háttér mind más jelenet', () => {
    const scenes = seedOf('profile_background').map((i) => backgroundVisual(i.itemKey)!.scene);
    expect(new Set(scenes).size).toBe(7);
  });

  it('H10. a 8 cím fokozatot kap, a GOAT a legerősebbet', () => {
    const tiers = seedOf('title').map((i) => ({ key: i.itemKey, tier: titleVisual(i.itemKey)!.tier }));
    expect(new Set(tiers.map((t) => t.tier)).size).toBeGreaterThanOrEqual(3);
    expect(tiers.find((t) => t.key === 'title_goat')!.tier).toBe('elite');
    expect(tiers.find((t) => t.key === 'title_predictor')!.tier).toBe('plain');
  });
});

// ===========================================================================
// 3) Ritkaság-hierarchia (az ADAT változatlan)
// ===========================================================================

describe('Kozmetikumok V2 – ritkaság-hierarchia', () => {
  it('H11. a ritkaság súlya monoton', () => {
    expect(RARITY_WEIGHT.common).toBeLessThan(RARITY_WEIGHT.rare);
    expect(RARITY_WEIGHT.rare).toBeLessThan(RARITY_WEIGHT.epic);
    expect(RARITY_WEIGHT.epic).toBeLessThan(RARITY_WEIGHT.legendary);
    for (const r of RARITIES) expect(typeof RARITY_WEIGHT[r]).toBe('number');
  });

  it('H12. a ritkább keret ÁTLAGOSAN több réteget és részecskét kap', () => {
    const avg = (rarity: string) => {
      const f = seedOf('frame').filter((i) => i.rarity === rarity).map((i) => frameVisual(i.itemKey)!);
      return f.reduce((s, x) => s + x.particleCount + x.thickness * 100, 0) / f.length;
    };
    expect(avg('rare')).toBeGreaterThan(avg('common'));
    expect(avg('epic')).toBeGreaterThan(avg('rare'));
    expect(avg('legendary')).toBeGreaterThan(avg('epic'));
  });

  it('H13. a common keretek letisztultak: nincs részecske és nincs mozgás', () => {
    for (const i of seedOf('frame').filter((x) => x.rarity === 'common')) {
      const f = frameVisual(i.itemKey)!;
      expect(f.particleCount, i.itemKey).toBe(0);
      expect(f.motion, i.itemKey).toBe('none');
    }
  });

  it('H14. a legendary keretek mind kapnak mozgást és részecskét', () => {
    for (const i of seedOf('frame').filter((x) => x.rarity === 'legendary')) {
      const f = frameVisual(i.itemKey)!;
      expect(f.particleCount, i.itemKey).toBeGreaterThan(0);
      expect(f.motion, i.itemKey).not.toBe('none');
    }
  });

  it('H15. a vizuális regiszter NEM tartalmaz katalógus-adatot (ár, ritkaság, név)', () => {
    const src = read('src/client/lib/cosmeticVisuals.ts');
    expect(src).not.toMatch(/priceCoins|\b(300|750|1500|2500|5000|12500|20000)\b/);
    expect(src).not.toMatch(/rarity:\s*'(common|rare|epic|legendary)'/);
  });
});

// ===========================================================================
// 4) Mozgás és akadálymentesség
// ===========================================================================

describe('Kozmetikumok V2 – mozgás és akadálymentesség', () => {
  const css = read('src/client/styles.css');

  it('H16. minden kozmetikum-animáció leáll reduced-motion esetén', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.cos-figure')));
    for (const cls of ['cos-spin-rotate', 'cos-spin-sweep', 'cos-pulse', 'cos-flicker',
      'cos-name-sheen', 'cos-effect-burning', 'cos-effect-electric', 'cos-effect-rainbow', 'cos-title-elite']) {
      expect(block, cls).toContain(cls);
    }
    expect(block).toContain('animation: none !important');
  });

  it('H17. a dekoratív SVG-k aria-hidden-ek', () => {
    for (const f of ['src/client/components/cosmetics/FrameRing.tsx', 'src/client/components/cosmetics/BackgroundScene.tsx']) {
      const src = read(f);
      expect(src, f).toContain('aria-hidden');
      expect(src, f).toContain('focusable="false"');
    }
  });

  it('H18. a kattintható ranglista-sornak van fókusz-állapota és címkéje', () => {
    const src = read('src/client/components/LeaderboardList.tsx');
    expect(src).toContain('aria-label');
    expect(css).toContain('.lb-row:focus-visible');
    expect(css).toContain('.lb-row:hover');
  });

  it('H19. a navigációs legördülő billentyűzettel használható', () => {
    const src = read('src/client/components/Layout.tsx');
    expect(src).toContain('aria-expanded');
    expect(src).toContain('aria-haspopup="menu"');
    expect(src).toContain("role=\"menu\"");
    expect(src).toContain("e.key === 'Escape'");
    expect(css).toContain('.nav-menu-item:focus-visible');
  });
});

// ===========================================================================
// 5) EGY renderer – nincs második kozmetikum-rendszer
// ===========================================================================

describe('Kozmetikumok V2 – egyetlen renderer', () => {
  it('H20. a Shop, a profil, a nyilvános profil és a ranglista UGYANAZT használja', () => {
    for (const f of [
      'src/client/pages/Shop.tsx',
      'src/client/components/ShopCosmeticsCard.tsx',
      'src/client/pages/PublicProfile.tsx',
      'src/client/components/LeaderboardList.tsx',
    ]) {
      expect(read(f), f).toContain('CosmeticProfile');
    }
  });

  it('H21. a kozmetikum-rajzolás nincs duplikálva: a vizuális feloldás egy helyen él', () => {
    const consumers = [
      'src/client/pages/Shop.tsx', 'src/client/pages/PublicProfile.tsx',
      'src/client/components/LeaderboardList.tsx', 'src/client/components/ShopCosmeticsCard.tsx',
    ];
    for (const f of consumers) {
      const src = read(f);
      expect(src, `${f} nem oldhat fel vizuált közvetlenül`).not.toMatch(/frameVisual|backgroundVisual|emblemVisual\(/);
    }
    // a renderer viszont igen
    expect(read('src/client/components/CosmeticProfile.tsx')).toContain('frameVisual');
  });

  it('H22. a megszolgált avatar-katalógust a V2 sem írja át', () => {
    const src = read('src/client/components/CosmeticProfile.tsx');
    expect(src).toContain("import { Avatar }");
    expect(src).not.toMatch(/AVATAR_PARTS\s*(\[|\.)/);
  });

  it('H23. nincs második coin-rendszer: a kozmetikum-réteg nem ismer egyenleget', () => {
    for (const f of ['src/client/lib/cosmeticVisuals.ts', 'src/client/components/CosmeticProfile.tsx',
      'src/client/components/cosmetics/FrameRing.tsx', 'src/client/components/cosmetics/BackgroundScene.tsx']) {
      expect(read(f), f).not.toMatch(/balance|coinBalance|purchase/i);
    }
  });
});

// ===========================================================================
// 6) Nyilvános profil – adatforrás és adatvédelem
// ===========================================================================

describe('Nyilvános játékosprofil', () => {
  const src = read('src/client/pages/PublicProfile.tsx');

  it('H24. KIZÁRÓLAG a meglévő nyilvános ranglista-API-t használja', () => {
    expect(src).toContain('api.competitions()');
    expect(src).toContain('api.competitionLeaderboard(');
    // nem hív saját/hitelesített végpontot
    expect(src).not.toMatch(/progressionMe|coinBalance|shopInventory|customization|profileMe/);
  });

  it('H25. nem jelenít meg privát adatot', () => {
    // a KÓD-ban nincs privát mező; a fejléc-komment szándékosan megnevezi őket
    expect(code('src/client/pages/PublicProfile.tsx'))
      .not.toMatch(/\bemail\b|user_id|userId|coinBalance|purchase|inventory/i);
  });

  it('H26. az azonosító a megjelenítési NÉV, nem a user_id', () => {
    expect(src).toContain('useParams');
    expect(src).toContain('decodeURIComponent(name)');
    const lb = read('src/client/components/LeaderboardList.tsx');
    expect(lb).toContain('/jatekos/${encodeURIComponent(row.displayName)}');
    expect(code('src/client/components/LeaderboardList.tsx')).not.toMatch(/userId|user_id/);
  });

  it('H27. a saját sor a SAJÁT profilra visz', () => {
    const lb = read('src/client/components/LeaderboardList.tsx');
    expect(lb).toContain("row.isMe ? '/profil'");
    expect(src).toContain("to=\"/profil\"");
  });

  it('H28. a lekérdezett versenyek száma korlátos (nincs N+1 robbanás)', () => {
    expect(src).toContain('MAX_COMPETITIONS');
    expect(src).toMatch(/MAX_COMPETITIONS\s*=\s*\d+/);
    expect(src).toContain('Promise.all');
  });

  it('H29. a route regisztrálva van', () => {
    const app = read('src/client/App.tsx');
    expect(app).toContain('path="/jatekos/:name"');
    expect(app).toContain('PublicProfile');
  });
});

// ===========================================================================
// 7) Navigáció
// ===========================================================================

describe('Navigáció V2', () => {
  const src = read('src/client/components/Layout.tsx');
  const app = read('src/client/App.tsx');

  it('H30. a sáv három elsődleges célpontot tart kint', () => {
    const primary = src.slice(src.indexOf('const PRIMARY'), src.indexOf('const PLAY'));
    expect((primary.match(/to: '/g) ?? []).length).toBe(3);
    for (const r of ['/tippek', '/tippverseny', '/shop']) expect(primary).toContain(r);
  });

  it('H31. EGYETLEN korábbi útvonal sem veszett el', () => {
    const routes = [
      '/tippek', '/elozmenyek', '/szelvenyek', '/tippverseny', '/battles', '/shop', '/pro',
      '/dashboard', '/statisztikaim', '/meccsek', '/elemzes', '/statisztikak', '/forrasok', '/beallitasok',
    ];
    for (const r of routes) {
      const inNav = src.includes(`'${r}'`) || src.includes(`to="${r}"`);
      expect(inNav, `${r} hiányzik a navigációból`).toBe(true);
    }
    // és mindegyikhez tartozik route is
    for (const r of routes) expect(app, `${r} route hiányzik`).toContain(`path="${r}"`);
  });

  it('H32. a másodlagos elemek két csoportba kerültek', () => {
    expect(src).toContain('const PLAY');
    expect(src).toContain('const EXPLORE');
    expect(src).toContain('NavMenu');
    expect(src).toContain('Felfedezés');
  });

  it('H33. mobilon minden útvonal elérhető, csoportosítva', () => {
    expect(src).toContain('MOBILE_GROUPS');
    const groups = src.slice(src.indexOf('const MOBILE_GROUPS'), src.indexOf('function NavMenu'));
    for (const g of ['PRIMARY', 'PLAY', 'EXPLORE']) expect(groups).toContain(g);
    expect(src).toContain('nav-link-mobile');
  });

  it('H34. a coin-jelvény a szerver egyenlegéből dolgozik, és nincs második rendszer', () => {
    const pill = read('src/client/components/CoinsProvider.tsx');
    expect(pill).toContain('(await api.coinBalance()).balance');
    expect(pill).not.toMatch(/balance\s*[-+]=|localStorage|sessionStorage/);
    expect(src).toContain('<CoinBalancePill />');   // mobilon sem rejtjük el
    expect(src).not.toContain('CoinBalancePill className="hidden');
  });

  it('H35. a coin-jelvény a Shopra visz és címkézett', () => {
    const pill = read('src/client/components/CoinsProvider.tsx');
    expect(pill).toContain("to=\"/shop\"");
    expect(pill).toContain('aria-label');
  });
});
