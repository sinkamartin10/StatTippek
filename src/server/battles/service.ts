/**
 * 1v1 Tipp Battle üzleti logika. MINDEN szabály itt (szerveroldalon) dől el:
 * életciklus, jogosultság, tippelési ablak, az ellenfél tippjének kitakarása,
 * pontozás és lezárás.
 *
 * A kliens által küldött points / winner / status / xp / user_id mezőket a
 * rendszer sosem veszi figyelembe – a hívót kizárólag a hitelesített token
 * azonosítja, és azt a route-réteg adja át.
 *
 * IZOLÁCIÓ: ez a szolgáltatás a `user_predictions` táblához SOHA nem nyúl, és a
 * Tippverseny/küldetés/progression szolgáltatásokat nem hívja. A versenyből
 * kizárólag OLVAS (mérkőzésadat és a ranglista résztvevői köre).
 */
import {
  BATTLE_MATCH_COUNT, BATTLE_STATUS_LABEL, BATTLE_TRANSITIONS, MAX_PENDING_BATTLES,
  INVITE_TTL_HOURS, battlePredictionWindow, battleWinner, effectiveStatus, inviteExpiryFrom,
  isInviteExpired, matchIsScorable, matchSelectable, opponentPredictionVisible, outcomeFor,
  scoreBattlePrediction, validScore,
  type BattleListResponse, type BattleMatchInfo, type BattleMatchView, type BattleParticipant,
  type BattlePredictionRow, type BattleRow, type BattleView, type EligibleMatch,
  type EligibleOpponent, type PredictionView,
} from '../../shared/battles';
import { displayNameFor, type PublicProfile } from '../../shared/competition';
import {
  battleChallengeAccepted, battleChallengeDeclined, battleChallengeExpired,
  battleChallengeReceived, battleSettled, battleSourceKey,
  type BattleNotificationEvent, type NewNotification,
} from '../../shared/notifications';
import type { CompetitionStore } from '../competition/store';
import type { DisplayNameDirectory } from '../profile/displayNameDirectory';
import type { BattleStore } from './store';

/** Üzleti hiba, amiből a route-réteg HTTP státuszt képez. */
export class BattleError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    /** a hibaválaszba beolvasztandó, SZERVER által számolt extra mezők */
    public details?: Record<string, unknown>,
  ) { super(message); }
}

const DEFAULT_PROFILE: PublicProfile = { avatar: {}, borderKey: 'none', titleKey: 'rookie' };

export class BattleService {
  constructor(
    private store: BattleStore,
    /** CSAK OLVASÁSRA: mérkőzésadat és a ranglista résztvevői köre. */
    private competitions: CompetitionStore,
    private names: DisplayNameDirectory,
    /** Szerveroldali PRO-ellenőrzés a meglévő entitlement rendszerből. */
    private isPro: (userId: string) => Promise<boolean>,
    /** Kötegelt PRO-ellenőrzés (nincs N+1). */
    private proUsers: (userIds: string[]) => Promise<Set<string>>,
    /** Opcionális: avatar / border / title a meglévő progression rendszerből. */
    private publicProfiles?: (userIds: string[]) => Promise<Map<string, PublicProfile>>,
    /**
     * Opcionális értesítés-kibocsátó. SOHA nem dobhat: az értesítés mellékes a
     * párbaj állapotátmenetéhez képest, ezért hibája nem bukhat vissza ide.
     * Ha nincs megadva, a párbaj működése bitre azonos a Phase 4-belivel.
     */
    private notify?: (n: NewNotification) => Promise<unknown>,
  ) {}

  // -------------------------------------------------------------------------
  // Értesítések (Phase 5) – mindig a feltételes írás GYŐZTESE bocsát ki,
  // ezért egy esemény egyszer keletkezik. A duplikációt ettől függetlenül a
  // (user_id, source_key) egyedi index is kizárja.
  // -------------------------------------------------------------------------

  /** A megjelenítendő név egy felhasználóhoz. SOHA nem e-mail vagy azonosító. */
  private async nameOf(userId: string): Promise<string> {
    try { return (await this.names.get(userId)) ?? displayNameFor(userId); }
    catch { return displayNameFor(userId); }
  }

  /** Értesítés összeállítása és kibocsátása. Hibát nem engedünk ki innen. */
  private async emit(
    userId: string,
    battleId: string,
    event: BattleNotificationEvent,
    text: { type: NewNotification['type']; title: string; body: string },
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.notify) return;
    try {
      await this.notify({
        userId,
        type: text.type,
        title: text.title,
        body: text.body,
        entityType: 'battle',
        entityId: battleId,
        sourceKey: battleSourceKey(battleId, event),
        metadata,
      });
    } catch (e) {
      // Az értesítés SOHA nem törheti meg a párbaj műveletét
      console.error('[battles] értesítés kibocsátása sikertelen:', battleId, event, (e as Error).message);
    }
  }

  /** A lezárás értesítése mindkét játékosnak, a saját szempontjából. */
  private async emitSettled(b: BattleRow): Promise<void> {
    if (!this.notify || b.challengerPoints == null || b.opponentPoints == null) return;
    const [cName, oName] = await Promise.all([this.nameOf(b.challengerId), this.nameOf(b.opponentId)]);
    const sides: [string, string, number, number][] = [
      [b.challengerId, oName, b.challengerPoints, b.opponentPoints],
      [b.opponentId, cName, b.opponentPoints, b.challengerPoints],
    ];
    for (const [userId, otherName, mine, theirs] of sides) {
      const outcome = outcomeFor(b, userId) ?? 'draw';
      await this.emit(userId, b.id, 'settled',
        battleSettled(outcome as 'win' | 'loss' | 'draw', otherName, mine, theirs),
        { opponentName: otherName, myPoints: mine, opponentPoints: theirs, outcome });
    }
  }

  /**
   * ÚJRASZÁRMAZTATÁS (Phase 5 / D2): milyen értesítések tartoznának a
   * felhasználóhoz a párbajok JELENLEGI állapota szerint. Tisztán olvasó.
   *
   * Miért kell: a kibocsátást a feltételes írás győztese végzi, de ha az a
   * kérés az értesítés beírása ELŐTT elhasal, az átmenetet senki nem nyerheti
   * meg újra – az értesítés véglegesen elveszne. Ez a metódus a terminális
   * állapotokból (settled, expired) pótolja. Az idempotenciát a
   * (user_id, source_key) egyedi index adja.
   */
  async notificationCandidates(userId: string, now: Date = new Date()): Promise<NewNotification[]> {
    const rows = await this.store.listBattlesForUser(userId);
    const out: NewNotification[] = [];

    for (const b of rows) {
      const status = effectiveStatus(b, now);

      if (status === 'settled' && b.challengerPoints != null && b.opponentPoints != null) {
        const iAmChallenger = b.challengerId === userId;
        const otherId = iAmChallenger ? b.opponentId : b.challengerId;
        const mine = iAmChallenger ? b.challengerPoints : b.opponentPoints;
        const theirs = iAmChallenger ? b.opponentPoints : b.challengerPoints;
        const outcome = (outcomeFor(b, userId) ?? 'draw') as 'win' | 'loss' | 'draw';
        const otherName = await this.nameOf(otherId);
        const text = battleSettled(outcome, otherName, mine, theirs);
        out.push({
          userId, type: text.type, title: text.title, body: text.body,
          entityType: 'battle', entityId: b.id,
          sourceKey: battleSourceKey(b.id, 'settled'),
          metadata: { opponentName: otherName, myPoints: mine, opponentPoints: theirs, outcome },
        });
      }

      // A lejárat értesítése KIZÁRÓLAG a kihívót érinti
      if (status === 'expired' && b.challengerId === userId) {
        const otherName = await this.nameOf(b.opponentId);
        const text = battleChallengeExpired(otherName);
        out.push({
          userId, type: text.type, title: text.title, body: text.body,
          entityType: 'battle', entityId: b.id,
          sourceKey: battleSourceKey(b.id, 'expired'),
          metadata: { opponentName: otherName },
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Segédek
  // -------------------------------------------------------------------------

  private async profiles(userIds: string[]): Promise<Map<string, PublicProfile>> {
    if (!this.publicProfiles || !userIds.length) return new Map();
    try { return await this.publicProfiles(userIds); } catch { return new Map(); }
  }

  /** A megjelenítendő név: a tárolt display name, vagy determinisztikus álnév. SOHA nem e-mail. */
  private async nameMap(userIds: string[]): Promise<Map<string, string>> {
    const stored = await this.names.getMany([...new Set(userIds)]);
    const out = new Map<string, string>();
    for (const id of new Set(userIds)) out.set(id, stored.get(id) ?? displayNameFor(id));
    return out;
  }

  private async matchInfo(matchIds: string[]): Promise<Map<string, BattleMatchInfo>> {
    const rows = await this.competitions.getMatchesByIds(matchIds);
    return new Map(rows.map((m) => [m.id, {
      competitionMatchId: m.id,
      homeTeam: m.homeTeam, awayTeam: m.awayTeam, kickoff: m.kickoff,
      status: m.status, homeScore: m.homeScore, awayScore: m.awayScore,
    }]));
  }

  /** A battle sor betöltése + jogosultság: csak a két résztvevő érheti el. */
  private async own(battleId: string, userId: string): Promise<BattleRow> {
    const b = await this.store.getBattle(battleId);
    if (!b) throw new BattleError('A párbaj nem található.', 404, 'BATTLE_NOT_FOUND');
    if (b.challengerId !== userId && b.opponentId !== userId) {
      // Szándékosan 403 és nem 404: a sor létezik, de nem a hívóé
      throw new BattleError('Ehhez a párbajhoz nincs hozzáférésed.', 403, 'NOT_YOUR_BATTLE');
    }
    return b;
  }

  // -------------------------------------------------------------------------
  // Nézet felépítése
  // -------------------------------------------------------------------------

  private view(
    b: BattleRow,
    userId: string,
    matches: Map<string, BattleMatchInfo>,
    matchIds: string[],
    predictions: BattlePredictionRow[],
    names: Map<string, string>,
    profs: Map<string, PublicProfile>,
    now: Date,
  ): BattleView {
    const status = effectiveStatus(b, now);
    const iAmChallenger = b.challengerId === userId;
    const otherId = iAmChallenger ? b.opponentId : b.challengerId;

    const mine = new Map(predictions.filter((p) => p.userId === userId).map((p) => [p.competitionMatchId, p]));
    const theirs = new Map(predictions.filter((p) => p.userId === otherId).map((p) => [p.competitionMatchId, p]));

    const toView = (p: BattlePredictionRow): PredictionView => ({
      predictedHomeScore: p.predictedHomeScore,
      predictedAwayScore: p.predictedAwayScore,
      points: p.points ?? null,
    });

    // A mérkőzések sorrendje KICKOFF szerint, nem a tároló sorrendje szerint:
    // a matchIdsFor() egyik tárolóban sem rendez, ezért a nyers sorrend
    // nem determinisztikus és a két tároló között is eltérhet.
    const orderedIds = [...matchIds].sort((a, b) => {
      const ka = matches.get(a)?.kickoff ?? '';
      const kb = matches.get(b)?.kickoff ?? '';
      return ka === kb ? a.localeCompare(b) : ka.localeCompare(kb);
    });

    const matchViews: BattleMatchView[] = orderedIds.map((id) => {
      const info = matches.get(id);
      const base: BattleMatchInfo = info ?? {
        competitionMatchId: id, homeTeam: '?', awayTeam: '?',
        kickoff: new Date(0).toISOString(), status: 'cancelled', homeScore: null, awayScore: null,
      };
      const w = battlePredictionWindow(status, base, now);
      const myP = mine.get(id) ?? null;
      const theirP = theirs.get(id) ?? null;
      // Az ellenfél tippje KICKOFF ELŐTT soha nem kerül a válaszba – szerveroldali kitakarás
      const reveal = opponentPredictionVisible(base, status, now);
      return {
        ...base,
        open: w.open,
        lockReason: w.open ? null : w.reason,
        finished: matchIsScorable(base),
        myPrediction: myP ? toView(myP) : null,
        opponentPrediction: reveal && theirP ? toView(theirP) : null,
        opponentHasPredicted: !!theirP,
      };
    });

    const participant = (id: string, points: number | null): BattleParticipant => {
      const p = profs.get(id) ?? DEFAULT_PROFILE;
      return {
        displayName: names.get(id) ?? displayNameFor(id),
        avatar: p.avatar, borderKey: p.borderKey, titleKey: p.titleKey,
        predictions: predictions.filter((x) => x.userId === id).length,
        points,
      };
    };

    const amOpponent = b.opponentId === userId;
    const canAct = status === 'pending';
    return {
      id: b.id,
      status,
      statusLabel: BATTLE_STATUS_LABEL[status],
      inviteExpiresAt: b.inviteExpiresAt,
      settledAt: b.settledAt,
      createdAt: b.createdAt,
      iAmChallenger,
      canAccept: canAct && amOpponent,
      canDecline: canAct && amOpponent,
      canCancel: canAct && iAmChallenger,
      challenger: participant(b.challengerId, b.challengerPoints),
      opponent: participant(b.opponentId, b.opponentPoints),
      myOutcome: outcomeFor(b, userId),
      matches: matchViews,
    };
  }

  // -------------------------------------------------------------------------
  // Lezárás (lusta, idempotens)
  // -------------------------------------------------------------------------

  /**
   * Ha a battle `active` és mindhárom mérkőzése lezárult eredménnyel, kiszámolja a
   * pontokat és lezárja. IDEMPOTENS:
   *  - a pont ÉRTÉKADÁSSAL íródik, és ha már pontosan annyi, nem írunk (a meglévő
   *    Tippverseny-kiértékelés mintája),
   *  - a lezárás FELTÉTELES UPDATE `active` állapotból, ezért két párhuzamos
   *    kísérlet közül pontosan egy ír.
   *
   * V1-ben a battle 0 XP-t ad, ezért progression esemény EGYÁLTALÁN nem keletkezik.
   */
  private async trySettle(b: BattleRow, matchIds: string[], now: Date): Promise<BattleRow> {
    if (b.status !== 'active') return b;
    const matches = await this.matchInfo(matchIds);
    const infos = matchIds.map((id) => matches.get(id)).filter((m): m is BattleMatchInfo => !!m);
    if (infos.length !== matchIds.length || !infos.every(matchIsScorable)) return b;

    const predictions = await this.store.listPredictions(b.id);
    let challengerPoints = 0;
    let opponentPoints = 0;
    for (const p of predictions) {
      const m = matches.get(p.competitionMatchId);
      if (!m || !matchIsScorable(m)) continue;
      const pts = scoreBattlePrediction(p, m.homeScore!, m.awayScore!);
      if (p.points !== pts) await this.store.setPredictionPoints(p.id, pts);
      if (p.userId === b.challengerId) challengerPoints += pts;
      else if (p.userId === b.opponentId) opponentPoints += pts;
    }

    const settled = await this.store.settle(b.id, {
      challengerPoints, opponentPoints,
      winnerUserId: battleWinner(b.challengerId, b.opponentId, challengerPoints, opponentPoints),
      settledAt: now.toISOString(),
    });
    // Értesítés: KIZÁROLAG az a kérés bocsát ki, amelyik megnyerte a lezárást.
    // A párhuzamos vesztes null-t kap, és nem jut el ide.
    if (settled) await this.emitSettled(settled);

    // null = egy másik, párhuzamos kérés már lezárta; akkor annak az eredménye érvényes
    return settled ?? (await this.store.getBattle(b.id)) ?? b;
  }

  /** A lejárt kihívás tárolt állapotának lusta utánvezetése. Nincs ütemező. */
  private async materializeExpiry(b: BattleRow, now: Date): Promise<BattleRow> {
    if (!isInviteExpired(b, now)) return b;
    const t = BATTLE_TRANSITIONS.expire;
    const updated = await this.store.transition(b.id, t.to, t.from);
    if (updated) {
      // A lejárat a KIHÍVÓT érinti: ő várt a válaszra
      await this.emit(updated.challengerId, updated.id, 'expired',
        battleChallengeExpired(await this.nameOf(updated.opponentId)),
        { opponentName: await this.nameOf(updated.opponentId) });
    }
    return updated ?? b;
  }

  // -------------------------------------------------------------------------
  // Lista
  // -------------------------------------------------------------------------

  async list(userId: string, now: Date = new Date()): Promise<BattleListResponse> {
    const rows = await this.store.listBattlesForUser(userId);
    const matchMap = await this.store.matchIdsFor(rows.map((b) => b.id));

    // Lusta állapot-utánvezetés: lejárat és lezárás
    const current: BattleRow[] = [];
    for (const b of rows) {
      let x = await this.materializeExpiry(b, now);
      x = await this.trySettle(x, matchMap.get(b.id) ?? [], now);
      current.push(x);
    }

    const allMatchIds = [...new Set([...matchMap.values()].flat())];
    const matches = await this.matchInfo(allMatchIds);
    const predictions = await this.store.listPredictionsMany(current.map((b) => b.id));
    const userIds = current.flatMap((b) => [b.challengerId, b.opponentId]);
    const [names, profs] = await Promise.all([this.nameMap(userIds), this.profiles([...new Set(userIds)])]);

    const views = current.map((b) =>
      this.view(b, userId, matches, matchMap.get(b.id) ?? [], predictions.get(b.id) ?? [], names, profs, now));

    const incoming = views.filter((v) => v.status === 'pending' && !v.iAmChallenger);
    const outgoing = views.filter((v) => v.status === 'pending' && v.iAmChallenger);
    const active = views.filter((v) => v.status === 'active');
    const settled = views.filter((v) => v.status === 'settled');

    return {
      incoming, outgoing, active, settled,
      pendingIncoming: incoming.length,
      limits: { maxPending: MAX_PENDING_BATTLES, matchCount: BATTLE_MATCH_COUNT, inviteTtlHours: INVITE_TTL_HOURS },
    };
  }

  // -------------------------------------------------------------------------
  // Részletek
  // -------------------------------------------------------------------------

  async get(userId: string, battleId: string, now: Date = new Date()): Promise<BattleView> {
    let b = await this.own(battleId, userId);
    const matchIds = (await this.store.matchIdsFor([b.id])).get(b.id) ?? [];
    b = await this.materializeExpiry(b, now);
    b = await this.trySettle(b, matchIds, now);

    const [matches, predictions] = await Promise.all([
      this.matchInfo(matchIds),
      this.store.listPredictions(b.id),
    ]);
    const userIds = [b.challengerId, b.opponentId];
    const [names, profs] = await Promise.all([this.nameMap(userIds), this.profiles(userIds)]);
    return this.view(b, userId, matches, matchIds, predictions, names, profs, now);
  }

  // -------------------------------------------------------------------------
  // Létrehozás
  // -------------------------------------------------------------------------

  async create(userId: string, opponentId: string, matchIds: string[], now: Date = new Date()): Promise<BattleView> {
    if (opponentId === userId) {
      throw new BattleError('Önmagadat nem hívhatod ki.', 422, 'OPPONENT_NOT_ELIGIBLE');
    }
    // A mérkőzésszám ELŐBB: így a hibás kérés nem terheli a jogosultság-lekérdezéseket
    const unique = [...new Set(matchIds)];
    if (matchIds.length !== BATTLE_MATCH_COUNT || unique.length !== BATTLE_MATCH_COUNT) {
      throw new BattleError(
        `A párbaj pontosan ${BATTLE_MATCH_COUNT} különböző mérkőzésből áll.`,
        422, 'BATTLE_MATCH_COUNT_INVALID', { required: BATTLE_MATCH_COUNT, received: unique.length },
      );
    }

    // Részvételi feltétel: a KIHÍVÓNAK legyen megjelenítési neve (a Tippverseny szabálya)
    if (!(await this.names.get(userId))) {
      throw new BattleError(
        'A párbajhoz előbb állíts be egy megjelenítési nevet a profilodban.',
        403, 'DISPLAY_NAME_REQUIRED',
      );
    }

    // Az ellenfél kizárólag a Tippverseny ranglistán MÁR LÁTHATÓ PRO résztvevők közül
    const eligible = await this.eligibleOpponents(userId);
    if (!eligible.some((o) => o.userId === opponentId)) {
      throw new BattleError(
        'Ez a játékos nem hívható ki: csak a Tippverseny ranglistáján szereplő PRO résztvevők közül választhatsz.',
        422, 'OPPONENT_NOT_ELIGIBLE',
      );
    }

    // A mérkőzések érvényessége (a tároló ezt atomikusan újra ellenőrzi)
    const infos = await this.matchInfo(unique);
    if (infos.size !== BATTLE_MATCH_COUNT || ![...infos.values()].every((m) => matchSelectable(m, now))) {
      throw new BattleError(
        'A kiválasztott mérkőzések közül nem mindegyik tippelhető (már elkezdődött vagy nem létezik).',
        422, 'INVALID_MATCH_SELECTION',
      );
    }

    const r = await this.store.createBattle({
      challengerId: userId, opponentId, matchIds: unique,
      expiresAt: inviteExpiryFrom(now),
      matchCount: BATTLE_MATCH_COUNT,
      maxPending: MAX_PENDING_BATTLES,
      now: now.toISOString(),
    });

    if (r.outcome === 'pending_limit') {
      throw new BattleError(
        `Egyszerre legfeljebb ${MAX_PENDING_BATTLES} nyitott kihívásod lehet. Várd meg a válaszokat, vagy vonj vissza egyet.`,
        409, 'PENDING_BATTLE_LIMIT', { maxPending: MAX_PENDING_BATTLES, pending: r.pending },
      );
    }
    if (r.outcome === 'already_challenged') {
      throw new BattleError(
        'Már van nyitott kihívásod ennél a játékosnál.',
        409, 'ALREADY_CHALLENGED',
      );
    }

    // Értesítés a KIHÍVOTTNAK – a kihívó nevével
    const challengerName = await this.nameOf(userId);
    await this.emit(opponentId, r.battle!.id, 'challenge',
      battleChallengeReceived(challengerName), { opponentName: challengerName });

    return this.get(userId, r.battle!.id, now);
  }

  // -------------------------------------------------------------------------
  // Állapotátmenetek – mind FELTÉTELES írás
  // -------------------------------------------------------------------------

  /** Elfogadás: csak az ellenfél, csak `pending`, és csak ha MÉG NEM járt le. */
  async accept(userId: string, battleId: string, now: Date = new Date()): Promise<BattleView> {
    const b = await this.own(battleId, userId);
    if (b.opponentId !== userId) {
      throw new BattleError('Csak a kihívott játékos fogadhatja el a párbajt.', 403, 'NOT_YOUR_BATTLE');
    }
    const t = BATTLE_TRANSITIONS.accept;
    // Az időfeltétel az ÍRÁS része (notExpiredAt), nem előzetes ellenőrzés
    const updated = await this.store.transition(b.id, t.to, t.from, {
      expectOpponent: userId, notExpiredAt: now.toISOString(),
    });
    if (!updated) {
      // Nem írt: vagy lejárt, vagy közben más állapotba került
      const fresh = await this.store.getBattle(b.id);
      if (fresh && isInviteExpired(fresh, now)) {
        await this.materializeExpiry(fresh, now);
        throw new BattleError('Ez a kihívás lejárt.', 409, 'CHALLENGE_EXPIRED');
      }
      throw new BattleError(
        `A párbaj állapota „${BATTLE_STATUS_LABEL[fresh?.status ?? 'expired']}" – már nem fogadható el.`,
        409, 'BATTLE_INVALID_STATE',
      );
    }

    // Értesítés a KIHÍVÓNAK – az elfogadó nevével
    const accepterName = await this.nameOf(userId);
    await this.emit(updated.challengerId, updated.id, 'accepted',
      battleChallengeAccepted(accepterName), { opponentName: accepterName });

    return this.get(userId, b.id, now);
  }

  /** Elutasítás: csak az ellenfél, csak `pending`. */
  async decline(userId: string, battleId: string, now: Date = new Date()): Promise<BattleView> {
    const b = await this.own(battleId, userId);
    if (b.opponentId !== userId) {
      throw new BattleError('Csak a kihívott játékos utasíthatja el a párbajt.', 403, 'NOT_YOUR_BATTLE');
    }
    const t = BATTLE_TRANSITIONS.decline;
    const updated = await this.store.transition(b.id, t.to, t.from, { expectOpponent: userId });
    if (!updated) throw this.invalidState(await this.store.getBattle(b.id), 'már nem utasítható el');

    // Értesítés a KIHÍVÓNAK – az elutasító nevével
    const declinerName = await this.nameOf(userId);
    await this.emit(updated.challengerId, updated.id, 'declined',
      battleChallengeDeclined(declinerName), { opponentName: declinerName });

    return this.get(userId, b.id, now);
  }

  /** Visszavonás: csak a kihívó, csak `pending`. */
  async cancel(userId: string, battleId: string, now: Date = new Date()): Promise<BattleView> {
    const b = await this.own(battleId, userId);
    if (b.challengerId !== userId) {
      throw new BattleError('Csak a kihívó vonhatja vissza a párbajt.', 403, 'NOT_YOUR_BATTLE');
    }
    const t = BATTLE_TRANSITIONS.cancel;
    const updated = await this.store.transition(b.id, t.to, t.from, { expectChallenger: userId });
    if (!updated) throw this.invalidState(await this.store.getBattle(b.id), 'már nem vonható vissza');
    return this.get(userId, b.id, now);
  }

  private invalidState(fresh: BattleRow | null, what: string): BattleError {
    return new BattleError(
      `A párbaj állapota „${BATTLE_STATUS_LABEL[fresh?.status ?? 'expired']}" – ${what}.`,
      409, 'BATTLE_INVALID_STATE',
    );
  }

  // -------------------------------------------------------------------------
  // Tippbeküldés
  // -------------------------------------------------------------------------

  /**
   * Battle-tipp leadása vagy módosítása.
   *
   * FONTOS: ez KIZÁRÓLAG a `battle_predictions` táblába ír. A Tippverseny
   * `user_predictions` táblájához nem nyúl, ezért nem jelenik meg a ranglistán,
   * nem fogyasztja a FREE napi kvótát, nem számít küldetés-haladásba és nem ad
   * Tippverseny XP-t vagy helyezést.
   *
   * A PRO státuszt a hívó réteg ellenőrzi a beküldéskor; egy MÁR ELFOGADOTT
   * (active) battle nem szakad meg a PRO lejárata miatt – a route ezért az aktív
   * battle tippjeinél nem kér újra PRO-t (lásd routes/battles.ts).
   */
  async submitPrediction(
    userId: string, battleId: string, competitionMatchId: string,
    home: number, away: number, now: Date = new Date(),
  ): Promise<BattleView> {
    const b = await this.own(battleId, userId);
    const matchIds = (await this.store.matchIdsFor([b.id])).get(b.id) ?? [];
    if (!matchIds.includes(competitionMatchId)) {
      throw new BattleError('Ez a mérkőzés nem ehhez a párbajhoz tartozik.', 404, 'BATTLE_NOT_FOUND');
    }
    if (!validScore(home) || !validScore(away)) {
      throw new BattleError('Érvénytelen tipp: a gólszám 0 és 99 közötti egész szám lehet.', 400, 'INVALID_SCORE');
    }

    const status = effectiveStatus(b, now);
    const info = (await this.matchInfo([competitionMatchId])).get(competitionMatchId);
    if (!info) throw new BattleError('A mérkőzés nem található.', 404, 'BATTLE_NOT_FOUND');

    const w = battlePredictionWindow(status, info, now);
    if (!w.open) throw new BattleError(w.reason, 409, 'PREDICTION_CLOSED');

    await this.store.upsertPrediction(b.id, userId, competitionMatchId, home, away);
    return this.get(userId, b.id, now);
  }

  // -------------------------------------------------------------------------
  // Választható ellenfelek és mérkőzések
  // -------------------------------------------------------------------------

  /**
   * Kihívható ellenfelek: KIZÁRÓLAG a Tippverseny nyilvános ranglistáján már
   * látható résztvevők közül, PRO státusszal és beállított megjelenítési névvel.
   *
   * Így nem keletkezik új felhasználó-kereső felület: a kör nem bővebb annál,
   * amit a hívó a ranglistákon amúgy is lát.
   */
  async eligibleOpponents(userId: string): Promise<EligibleOpponent[]> {
    const comps = await this.competitions.listCompetitions(['scheduled', 'active', 'finished']);
    const participants = new Set<string>();
    for (const c of comps) {
      for (const p of await this.competitions.listPredictionsForCompetition(c.id)) participants.add(p.userId);
    }
    participants.delete(userId);
    const ids = [...participants];
    if (!ids.length) return [];

    const [pro, names, profs] = await Promise.all([
      this.proUsers(ids),
      this.names.getMany(ids),
      this.profiles(ids),
    ]);

    return ids
      // PRO + van valódi, beállított megjelenítési neve (álnévvel nem hívható ki)
      .filter((id) => pro.has(id) && !!names.get(id))
      .map((id) => {
        const p = profs.get(id) ?? DEFAULT_PROFILE;
        return { userId: id, displayName: names.get(id)!, avatar: p.avatar, borderKey: p.borderKey, titleKey: p.titleKey };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'hu'));
  }

  /** Battle-be választható mérkőzések: `scheduled` és a kezdés még a jövőben. */
  async eligibleMatches(now: Date = new Date()): Promise<EligibleMatch[]> {
    const comps = await this.competitions.listCompetitions(['scheduled', 'active', 'finished']);
    const out: EligibleMatch[] = [];
    for (const c of comps) {
      for (const m of await this.competitions.listMatches(c.id)) {
        if (!matchSelectable(m, now)) continue;
        out.push({
          competitionMatchId: m.id, competitionName: c.name, leagueName: c.leagueName,
          homeTeam: m.homeTeam, awayTeam: m.awayTeam, kickoff: m.kickoff,
        });
      }
    }
    return out.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  }

  /** Szerveroldali PRO-ellenőrzés a route-réteg számára (a kliens állapotát sosem hisszük el). */
  checkPro(userId: string): Promise<boolean> {
    return this.isPro(userId);
  }
}
