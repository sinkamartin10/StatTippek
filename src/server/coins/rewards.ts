/**
 * Coin jutalom-hookok (5c). EGYETLEN központi hely, ahol a már meglévő
 * TippStats eseményekből coin keletkezik.
 *
 * ALAPELVEK
 *
 *  1) NINCS PÁRHUZAMOS SZÁMÍTÁS. Minden feltétel a MÁR MEGLÉVŐ rendszerek
 *     eredményéből jön:
 *       - tipp leadása / módosítása → a Tippverseny beküldés kimenete,
 *       - helyes 1X2 és pontos eredmény → a MEGLÉVŐ `scorePrediction()` pontja
 *         (3 / 5), ahogy a tipp sorában áll,
 *       - 3-as sorozat → a MEGLÉVŐ `streakBonusPredictionIds()` algoritmus,
 *         rövidebb küszöbbel hívva,
 *       - napi 3 és heti 10 tipp → a MEGLÉVŐ `daily_prediction_3` és
 *         `weekly_prediction_10` küldetés átvétele (saját számláló NINCS),
 *       - Top 10 és 1. hely → a MEGLÉVŐ verseny-ranglista a verseny
 *         `finished` állapotba kerülése után.
 *
 *  2) MINDEN JUTALOM A CoinService-EN KERESZTÜL MEGY. Ebben a modulban nincs
 *     egyetlen közvetlen adatbázis-írás sem, és nincs saját egyenleg-kezelés.
 *
 *  3) HÁRMAS VÉDELEM minden jutalomnál:
 *       a) üzleti feltétel (az esemény tényleg megtörtént),
 *       b) determinisztikus forráskulcs (`shared/shop.ts` kulcs-építői),
 *       c) adatbázis-idempotencia (`award_coins()` + `(user_id, source_key)`).
 *     Ez a modul NEM végez saját SELECT + INSERT idempotencia-ellenőrzést.
 *
 *  4) A COIN SOHA NEM TÖRHETI MEG AZ ÜZLETI MŰVELETET. Minden hook elnyeli a
 *     saját hibáját (naplózva), mert a coin mellékes a tipphez, a
 *     kiértékeléshez és a verseny lezárásához képest. Ezt az teszi
 *     biztonságossá, hogy minden tipp-alapú jutalom ÚJRASZÁRMAZTATHATÓ:
 *     a következő kiértékelés pótolja az elmaradt jóváírást.
 *
 *  5) FREE és PRO UGYANANNYIT KAP. A coin szándékosan nem ismétli meg az XP
 *     PRO-kapuját: a jóváhagyott gazdasági modell egy AKTÍV FREE felhasználóra
 *     készült. A FREE napi tippkeretet továbbra is a meglévő rendszer tartja.
 */
import {
  STREAK_TARGET, TOP10_PLACEMENT,
  competitionSourceKey, dailySourceKey, predictionSourceKey, streakSourceKey, weeklySourceKey,
  type CoinRewardType,
} from '../../shared/shop';
import { isCorrect, isExact, streakBonusPredictionIds } from '../../shared/progression';
import type { CoinService } from './service';

/**
 * A küldetés-kulcsok, amelyekhez coin tartozik. A küldetés-katalógus a
 * `shared/missions.ts`-ben él; itt CSAK a leképezés van, új küldetés nélkül.
 */
export const DAILY_TIPS_MISSION_KEY = 'daily_prediction_3';
export const WEEKLY_TIPS_MISSION_KEY = 'weekly_prediction_10';

/**
 * A tipp-adat, amiből az újraszármaztatás dolgozik. A `ProgressionStore`
 * `allPredictions()` metódusa szerkezetileg megfelel ennek – szándékosan szűk
 * felület, hogy ez a modul ne függjön a progression modultól.
 */
export interface CoinPredictionRow {
  predictionId: string;
  kickoff: string;
  /** null = még nincs kiértékelve */
  points: number | null;
}

export interface CoinPredictionSource {
  allPredictions(userId: string): Promise<CoinPredictionRow[]>;
}

/** Mit írtunk jóvá egy hívásban – naplózáshoz és teszthez. */
export interface CoinRewardSummary {
  /** a MOST jóváírt coin (0, ha minden esemény már korábban kifizetődött) */
  awarded: number;
  /** jutalomtípus → most jóváírt coin */
  byType: Partial<Record<CoinRewardType, number>>;
}

const empty = (): CoinRewardSummary => ({ awarded: 0, byType: {} });

export class CoinRewardService {
  constructor(
    private coins: CoinService,
    /**
     * A tipp-adatok forrása az újraszármaztatáshoz. Ha nincs megadva, a
     * kiértékelés-alapú jutalmak kimaradnak (a tipp leadása és a küldetések
     * ettől függetlenül működnek) – így a modul részlegesen is bekötheto.
     */
    private predictions?: CoinPredictionSource,
  ) {}

  /**
   * Egy jutalom kibocsátása. SOHA NEM DOB: a coin mellékes a kiváltó
   * művelethez képest. A tipp-alapú jutalmak hibája a következő
   * újraszármaztatáskor pótlódik.
   */
  private async give(summary: CoinRewardSummary, userId: string, type: CoinRewardType, sourceKey: string): Promise<void> {
    try {
      const r = await this.coins.awardReward(userId, type, sourceKey);
      if (r.outcome === 'awarded' && r.amount > 0) {
        summary.awarded += r.amount;
        summary.byType[type] = (summary.byType[type] ?? 0) + r.amount;
      }
    } catch (e) {
      console.error(`[coins] jutalom sikertelen (${type}, ${sourceKey}):`, (e as Error).message);
    }
  }

  // --------------------------------------------------------------------------
  // 1) Tipp leadása – +10
  // --------------------------------------------------------------------------

  /**
   * SIKERES Tippverseny-tippbeküldés után. A hívó akkor hív, amikor a tipp már
   * létezik az adatbázisban (a beküldő RPC commitolt), ezért érvénytelen,
   * zárolt, kvótán kívüli vagy visszagörgetett kérés sosem fizet.
   *
   * A MÓDOSÍTÁS nem fizet újra: a forráskulcs a tipp azonosítója, és a
   * módosítás ugyanazt a sort (ugyanazt az azonosítót) frissíti.
   */
  async onPredictionSubmitted(userId: string, predictionId: string): Promise<CoinRewardSummary> {
    const s = empty();
    if (!predictionId) return s;
    await this.give(s, userId, 'PREDICTION_SUBMITTED', predictionSourceKey('PREDICTION_SUBMITTED', predictionId));
    return s;
  }

  // --------------------------------------------------------------------------
  // 2–4) Kiértékelés-alapú jutalmak – ÚJRASZÁRMAZTATÁS
  // --------------------------------------------------------------------------

  /**
   * A felhasználó tipp-alapú coin jutalmainak utánvezetése a MÁR KIÉRTÉKELT
   * tippekből. A kiértékelés eseményéhez kötődik (a Tippverseny `settle()`
   * hívja), NEM oldalmegtekintéshez: a ranglista és a többi GES sosem hívja.
   *
   * Amit kifizet:
   *   - minden tipphez a beküldési jutalmat (pótlás, ha a beküldéskor elmaradt),
   *   - 3 pont  → helyes 1X2  (+75),
   *   - 5 pont  → pontos eredmény (+150) és NEM jár mellé a helyes 1X2,
   *               mert a meglévő XP-szabály is kizárólagos
   *               (`xpForPredictionPoints`: 5 pont → 50 XP, a +25 nem adódik hozzá),
   *   - minden befejezett 3-as helyes sorozat (+150), SORSZÁM szerinti kulccsal.
   *
   * IDEMPOTENS: minden jutalomnak determinisztikus forráskulcsa van, ezért a
   * többszöri futás (ismételt meccs-szinkron, ismételt lezárás) nem fizet újra.
   */
  async reconcileUser(userId: string): Promise<CoinRewardSummary> {
    const s = empty();
    if (!this.predictions) return s;

    let rows: CoinPredictionRow[];
    try {
      rows = await this.predictions.allPredictions(userId);
    } catch (e) {
      console.error('[coins] újraszármaztatás – tippek olvasása sikertelen:', (e as Error).message);
      return s;
    }

    // a) Beküldési jutalom minden tippre (pótlás; ismétlésnél already_awarded)
    for (const r of rows) {
      await this.give(s, userId, 'PREDICTION_SUBMITTED', predictionSourceKey('PREDICTION_SUBMITTED', r.predictionId));
    }

    // b) Kiértékelt tippek: a pontos eredmény és a helyes 1X2 KIZÁRÓLAGOS
    const settled = rows.filter((r) => r.points != null);
    for (const r of settled) {
      if (isExact(r.points)) {
        await this.give(s, userId, 'EXACT_SCORE', predictionSourceKey('EXACT_SCORE', r.predictionId));
      } else if (isCorrect(r.points)) {
        await this.give(s, userId, 'CORRECT_OUTCOME', predictionSourceKey('CORRECT_OUTCOME', r.predictionId));
      }
    }

    // c) 3-as sorozatok – a MEGLÉVŐ algoritmus, rövidebb küszöbbel.
    //    A kulcs SORSZÁM (streak:1, streak:2, …), nem a kiváltó tipp: így ha egy
    //    eredmény utólag módosul és a sorozatok átrendeződnek, a kifizetett
    //    bónuszok száma sosem haladhatja meg az elért sorozatok számát.
    const streaks = streakBonusPredictionIds(
      settled.map((r) => ({ predictionId: r.predictionId, points: r.points!, kickoff: r.kickoff, leagueKey: '' })),
      STREAK_TARGET,
    ).length;
    for (let i = 1; i <= streaks; i++) {
      await this.give(s, userId, 'STREAK_3', streakSourceKey(i));
    }

    return s;
  }

  // --------------------------------------------------------------------------
  // 5–6) Napi 3 és heti 10 tipp – a MEGLÉVŐ küldetésekre kapcsolva
  // --------------------------------------------------------------------------

  /**
   * Küldetés ÁTVÉTELE után. Csak a két mennyiségi küldetés fizet coint, és
   * csak akkor, ha az átvétel MOST jött létre (a `mission_claims` egyedisége
   * dönt: `(user_id, mission_key, period_key)`).
   *
   * A periódus-kulcs a MEGLÉVŐ `shared/missions.ts`-ből jön, Europe/Budapest
   * szerint, ezért a napi határ és a heti váltás nem válhat el a küldetésekétől.
   * Nincs második napi/heti számláló.
   *
   * FREE felhasználó XP-t nem kap a küldetésért, coint IGEN – ez a jóváhagyott
   * D2 döntés (3 tipp, nem 5, épp azért, hogy FREE-nek is elérhető legyen).
   */
  async onMissionClaimed(userId: string, missionKey: string, periodKey: string): Promise<CoinRewardSummary> {
    const s = empty();
    if (!periodKey) return s;
    if (missionKey === DAILY_TIPS_MISSION_KEY) {
      await this.give(s, userId, 'DAILY_TIPS', dailySourceKey(periodKey));
    } else if (missionKey === WEEKLY_TIPS_MISSION_KEY) {
      await this.give(s, userId, 'WEEKLY_TIPS', weeklySourceKey(periodKey));
    }
    return s;
  }

  // --------------------------------------------------------------------------
  // 7–8) Top 10 és 1. hely – a LEZÁRT versenyből
  // --------------------------------------------------------------------------

  /**
   * Egy résztvevő helyezési jutalma a VÉGLEGESEN lezárt versenyből. A hívó
   * akkor hív, amikor a verseny `finished` állapotba kerülése már sikeresen
   * megtörtént – érvénytelenített (`cancelled`) vagy még nyitott versenyből
   * sosem fizet.
   *
   * A két jutalom KÜLÖN forráskulcsot kap, ezért az 1. helyezett mindkettőt
   * megkapja (400 + 1500): a jóváhagyott konfigurációban két önálló jutalom
   * szerepel, és semmi nem teszi őket kizárólagossá.
   *
   * A helyezés a MEGLÉVŐ verseny-ranglistából jön, amely FREE és PRO
   * résztvevőt egyaránt tartalmaz. (A `competition_rewards` PRO-only
   * jutalomrangsora ettől külön rendszer, és változatlan.)
   */
  async onCompetitionFinished(userId: string, competitionId: string, rank: number): Promise<CoinRewardSummary> {
    const s = empty();
    if (!competitionId || !Number.isInteger(rank) || rank < 1) return s;
    if (rank <= TOP10_PLACEMENT) {
      await this.give(s, userId, 'COMPETITION_TOP10', competitionSourceKey(competitionId, 'COMPETITION_TOP10'));
    }
    if (rank === 1) {
      await this.give(s, userId, 'COMPETITION_FIRST', competitionSourceKey(competitionId, 'COMPETITION_FIRST'));
    }
    return s;
  }
}

/**
 * A Tippverseny és a küldetés-szolgáltatás felé mutató, szándékosan szűk
 * felület. Így azok a modulok nem a teljes coin-rendszert látják, csak a
 * jutalom-eseményeket, és a hook hiánya esetén bitre a korábbi működést adják.
 */
export interface CoinRewardHook {
  onPredictionSubmitted(userId: string, predictionId: string): Promise<unknown>;
  reconcileUser(userId: string): Promise<unknown>;
  onCompetitionFinished(userId: string, competitionId: string, rank: number): Promise<unknown>;
}

export interface MissionCoinHook {
  onMissionClaimed(userId: string, missionKey: string, periodKey: string): Promise<unknown>;
}
