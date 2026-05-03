// --- Acciones de partida (mutaciones via Firebase) ----------------------------
import { session, mutate as mutateFirebase, get, db, ref, set, serverTimestamp, functions, httpsCallable } from "./firebase.js";
import { isBotActive } from "./bot.js";
import * as Logica from "./logica.js";
import {
  teamOf,
  getNumSeats,
  allSeats,
  nextCCW,
  nextMano,
  emptyPlayers,
  emptyReady,
  initialScores,
  responderSeat,
  callerSeat,
} from "./teams.js";

const K = (n) => `_${n}`;
const PK = (n) => `p${n}`;
const HKEYS = ["a", "b", "c"];
const EMPTY_CARD = "~";
const OFFSET = 10; // scores/trickWins stored +10
const SUITS = {
  oros: { label: "oros", cls: "s-oros" },
  copas: { label: "copas", cls: "s-copas" },
  espadas: { label: "espadas", cls: "s-espadas" },
  bastos: { label: "bastos", cls: "s-bastos" },
};

const other = (s) => (s === 0 ? 1 : 0);
const real = (n) => Number(n || OFFSET) - OFFSET;

const toHObj = (arr) => {
  const o = {};
  (arr || [])
    .filter((c) => c && c !== EMPTY_CARD)
    .forEach((c, i) => {
      o[HKEYS[i]] = c;
    });
  if (!Object.keys(o).length) o.x = EMPTY_CARD;
  return o;
};
const fromHObj = (obj) => {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) return obj.filter((c) => c && c !== EMPTY_CARD);
  return HKEYS.map((k) => obj[k]).filter((c) => c && c !== EMPTY_CARD);
};

const getPlayed = (h, seat) => {
  const v = h?.played?.[PK(seat)];
  return v && v !== EMPTY_CARD ? v : null;
};
const setPlayed = (h, seat, card) => {
  if (!h.played) {
    const n = h.numSeats || 2;
    h.played = {};
    for (let i = 0; i < n; i++) h.played[PK(i)] = EMPTY_CARD;
  }
  h.played[PK(seat)] = card || EMPTY_CARD;
};
const alreadyPlayed = (h, seat) => getPlayed(h, seat) !== null;

function pushLog(st, text, meta) {
  st.logs = st.logs || [];
  const row = { text, at: serverTimestamp() };
  if (meta?.envitProof?.cards?.length)
    row.envitProof = {
      points: Number(meta.envitProof.points) || 0,
      cards: meta.envitProof.cards.filter(Boolean),
    };
  st.logs.unshift(row);
  st.logs = st.logs.slice(0, 30);
}
function addSA(h, seat, n = 1) {
  h.scoreAwards[K(seat)] = Number(h.scoreAwards[K(seat)] || OFFSET) + n;
}
function pName(st, seat) {
  return st?.players?.[K(seat)]?.name || `Jugador ${seat}`;
}
function cardLabel(c) {
  const { num, suit } = Logica.parseCard(c);
  return `${num} de ${SUITS[suit]?.label}`;
}

/** Tots els seients han jugat carta en la basa actual? */
function _allPlayed(h) {
  const n = h.numSeats || 2;
  for (let i = 0; i < n; i++) {
    if (!alreadyPlayed(h, i)) return false;
  }
  return true;
}

/** Proper seient que no ha jugat, en ordre CCW des del trickLead. */
function _nextUnplayedSeat(h) {
  const n = h.numSeats || 2;
  const lead = h.trickLead ?? h.mano;
  let s = lead;
  for (let i = 0; i < n; i++) {
    if (!alreadyPlayed(h, s)) return s;
    s = (s - 1 + n) % n;
  }
  return lead;
}

/**
 * Seient que ha de respondre a una oferta feta per `bySeat`.
 * 1v1: other(bySeat). 2v2: membre de l'equip rival més proper al mano en CCW.
 */
function _respondingSeat(state, bySeat) {
  const n = getNumSeats(state);
  if (n <= 2) return bySeat === 0 ? 1 : 0;
  const rivalTeam = teamOf(bySeat) === 0 ? 1 : 0;
  const mano = state.mano ?? 0;
  for (let i = 0; i < n; i++) {
    const s = (mano - i + n) % n;
    if (teamOf(s) === rivalTeam) return s;
  }
  return bySeat === 0 ? 1 : 0;
}

/**
 * Crea l'estat inicial de la partida per a `maxJugadores` jugadors.
 * Genera dinàmicament els slots de `players` i `ready` per a N seients.
 * Els `scores` sempre son per equip (team 0 i team 1), independentment de N.
 * @param {number} [maxJugadores=2] - 2 per a 1v1, 4 per a 2v2
 * @param {string} [modoJuego="1v1"] - "1v1" | "2v2"
 * @param {number} [puntosParaGanar=12] - 12 | 24
 */
export function buildDefaultState(maxJugadores = 2, modoJuego = "1v1", puntosParaGanar = 12) {
  const n = maxJugadores === 4 ? 4 : 2;
  const modo = modoJuego === "2v2" ? "2v2" : "1v1";
  return {
    version: 8,
    status: "waiting",
    roomCode: "",
    players: emptyPlayers(n),
    ready: emptyReady(n),
    scores: initialScores(OFFSET),
    handNumber: OFFSET,
    mano: 0,
    turn: 0,
    hand: null,
    lastHandSummary: null,
    logs: [],
    winner: null,
    gameEndReason: null,
    settings: {
      puntosParaGanar: puntosParaGanar === 24 ? 24 : 12,
      modoJuego: modo,
      maxJugadores: n,
    },
    openingIntroAt: 0,
  };
}

/**
 * Estat per defecte 1v1 (compatibilitat amb tot el codi existent).
 * Tots els mòduls que importaven defaultState() segueixen funcionant igual.
 */
export function defaultState() {
  return buildDefaultState(2, "1v1", 12);
}

function resumeOffer(state) {
  const h = state.hand,
    r = h.resume;
  h.envitAvailable = false;
  if (r) {
    h.mode = r.mode;
    h.turn = r.turn;
    h.turnStartedAt = serverTimestamp();
    // ¡AQUÍ ESTÁ LA MAGIA! Recuperamos la oferta anterior (el Truc) si la había
    h.pendingOffer = r.oldOffer || null;
  } else {
    h.mode = "normal";
    h.pendingOffer = null;
  }
  h.resume = null;
}

const mutate = async (fn) => {
  const res = await mutateFirebase(fn, defaultState);
  if (session.roomCode) {
    set(ref(db, `rooms/${session.roomCode}/lastActivity`), serverTimestamp()).catch(() => {});
  }
  return res;
};

let _renderAll = () => {};
let _renderAllLastRoom = () => {};
export function configureActions({ renderAll, renderAllLastRoom }) {
  _renderAll = renderAll;
  _renderAllLastRoom = renderAllLastRoom || (() => {});
}

/** Força render després de mutate (onValue sol no arriba o arriba tard). */
function pullRoomAndRender() {
  if (!session.roomRef) return;
  queueMicrotask(() => {
    get(session.roomRef)
      .then((snap) => {
        if (snap.val()) _renderAll(snap.val());
      })
      .catch(() => {});
  });
}

export const ui = { locked: false };

export async function dealHand() {
  let numSeats = 2;
  let handNumber = 0;
  const ok = await mutate((state) => {
    numSeats = getNumSeats(state);
    const n = numSeats;
    // Comprovar que tots els seients tenen jugador
    for (let i = 0; i < n; i++) {
      if (!state.players?.[K(i)]) return false;
    }
    if (state.status === "game_over") return false;
    if (state.hand?.status === "in_progress") return false;

    // Primera mano: preparació + qui comença
    if (real(state.handNumber) === 0) {
      if (!state.ready) {
        const r = {};
        for (let i = 0; i < n; i++) r[K(i)] = false;
        state.ready = r;
      }
      for (let i = 0; i < n; i++) {
        if (!state.ready[K(i)]) return false;
      }
      state.mano = Math.floor(Math.random() * n);
      state.openingIntroAt = serverTimestamp();
    }
    
    state.hand = Logica.makeHand(state.mano, getNumSeats(state));
    state.hand.turnStartedAt = serverTimestamp();
    state.status = "playing";
    // Evita que `lastAllTricks` de la mà anterior confonga el render entre mans / ofertes
    state.lastAllTricks = [];
    pushLog(state, `Ma #${real(state.handNumber) + 1}. Torn: J${state.mano}.`);
    handNumber = state.handNumber;
    return true;
  });

  if (ok && session.roomCode) {
    try {
      const repartir = httpsCallable(functions, "repartirCartas");
      await repartir({ roomId: session.roomCode, numSeats, handNumber });
    } catch (e) {
      console.error("Error repartiendo cartas:", e);
    }
  }

  pullRoomAndRender();
}

export async function playCard(card) { return _doPlayCard(session.mySeat, card); }
export async function playCardAsBot(card) { return _doPlayCard(1, card); }

/** Lògica compartida per a jugar una carta des de qualsevol seient. */
async function _doPlayCard(seat, card) {
  if (ui.locked) return;
  ui.locked = true;
  document
    .querySelectorAll("#myCards .my-card-wrap")
    .forEach((w) => w.classList.remove("playable"));
  try {
    const tx = await mutate((state) => {
      const h = state.hand;
      if (!h || state.status !== "playing" || h.status !== "in_progress")
        return false;
      if (h.mode !== "normal" || h.pendingOffer) return false;
      if (h.turn !== seat) return false;
      const _hist = h.trickHistory || [];
      const _r1 = _hist.length > 0 ? _hist[0].winner : undefined;
      const _r2 = _hist.length > 1 ? _hist[1].winner : undefined;
      const _isDraw = (w) => w === 99 || w === null || w === undefined;
      const _isWin = (w) => w === 0 || w === 1;
      const _b1Draw = _hist.length >= 1 && _isDraw(_r1) && _r1 !== undefined;
      const _b2Win = _hist.length >= 2 && _isWin(_r2);
      const _b1Win = _hist.length >= 1 && _isWin(_r1);
      const _b2Draw = _hist.length >= 2 && _isDraw(_r2) && _r2 !== undefined;
      if ((_b1Draw && _b2Win) || (_b1Win && _b2Draw)) return false;
      if (alreadyPlayed(h, seat)) return false;
      const mine = fromHObj(h.hands?.[K(seat)]);
      if (!mine.includes(card)) return false;
      h.hands[K(seat)] = toHObj(mine.filter((c) => c !== card));
      setPlayed(h, seat, card);
      h.envitAvailable = false;
      const plrName = state.players?.[K(seat)]?.name || `J${seat}`;
      pushLog(state, `${plrName} juga ${cardLabel(card)}.`);
      if (_allPlayed(h)) {
        Logica.resolveTrick(state);
      } else {
        h.turn = _nextUnplayedSeat(h);
        h.turnStartedAt = serverTimestamp();
        const isBaza1 = (h.trickHistory || []).length === 0;
        h.envitAvailable = isBaza1;
      }
      return true;
    });
    if (!tx || tx.committed === false) {
      throw new Error("PLAY_NOT_COMMITTED");
    }
  } finally {
    setTimeout(() => {
      ui.locked = false;
      _renderAllLastRoom();
    }, 90);
  }
}

export async function goMazo() {
  await mutate((state) => {
    const h = state.hand;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    // Solo puedes irte si es tu turno, estás en modo normal y no hay ofertas pendientes
    if (h.turn !== session.mySeat || h.mode !== "normal" || h.pendingOffer)
      return false;

    const nom = pName(state, session.mySeat);
    // Pasamos el tercer parámetro (session.mySeat) para que la lógica sepa QUIÉN huye
    Logica.applyHandEnd(state, `${nom} se'n va.`, session.mySeat);
    return true;
  });
  pullRoomAndRender();
}

export async function startOffer(kind) {
  await mutate((state) => _startOfferCore(state, session.mySeat, kind));
  pullRoomAndRender();
}
export async function startOfferAsBot(kind) {
  await mutate((state) => _startOfferCore(state, 1, kind));
}

function _startOfferCore(state, seat, kind) {
  const h = state.hand;
  if (!h || state.status !== "playing" || h.status !== "in_progress")
    return false;
  if (h.turn !== seat) return false;
  if (Logica.mustPlayCardOnlyThisTrick(h, seat)) return false;

  if (kind === "envit" || kind === "falta") {
    if (!h.envitAvailable || h.envit.state !== "none") return false;
    const tricksDone = (h.trickHistory || []).length;
    if (tricksDone !== 0) return false;
    if (alreadyPlayed(h, seat)) return false;
    // Permite envit en modo normal (sin truc) O cuando se está respondiendo a un truc
    const inNormalMode = h.mode === "normal" && h.truc.state === "none" && !h.pendingOffer;
    const respondingToTruc =
      h.mode === "respond_truc" &&
      h.pendingOffer?.kind === "truc" &&
      h.pendingOffer?.to === seat;
    if (!inNormalMode && !respondingToTruc) return false;

    const level = kind === "falta" ? "falta" : 2;
    const toSeat = _respondingSeat(state, seat);
    h.resume = {
      mode: h.mode,
      turn: h.turn,
      oldOffer: h.pendingOffer || null,
    };
    h.pendingOffer = {
      kind: "envit",
      level: level,
      by: seat,
      to: toSeat,
    };
    h.mode = "respond_envit";
    h.turn = toSeat;
    h.turnStartedAt = serverTimestamp();

    const nom = state.players?.[K(seat)]?.name || `J${seat}`;
    pushLog(state, `${nom} canta ${kind === "falta" ? "FALTA" : "envit"}.`);
    return true;
  }

  if (kind === "truc") {
    if (h.mode !== "normal") return false;
    if (h.pendingOffer) return false;

    let trucLevel = 2;
    if (h.truc.state === "accepted" && h.truc.responder === seat) {
      trucLevel = Number(h.truc.acceptedLevel || 2) + 1;
      if (trucLevel > 4) return false;
      if (!Logica.canSeatEscalateAcceptedTruc(h, seat)) return false;
    } else if (h.truc.state !== "none") return false;

    const toSeat = _respondingSeat(state, seat);
    h.resume = {
      mode: h.mode,
      turn: h.turn,
      oldOffer: h.pendingOffer || null,
    };
    h.pendingOffer = {
      kind: "truc",
      level: trucLevel,
      by: seat,
      to: toSeat,
    };
    h.mode = "respond_truc";
    h.turn = toSeat;
    h.turnStartedAt = serverTimestamp();

    // Determinar si el equipo respondedor puede aún envidar:
    // - no se ha hecho ninguna baza
    // - no hay envit previo
    // - 1v1: el respondedor no ha jugado carta
    // - 2v2: al menos un miembro del equipo respondedor no ha jugado carta
    const tricksDoneNow = (h.trickHistory || []).length;
    let respCanEnvit = false;
    if (h.envit.state === "none" && tricksDoneNow === 0) {
      const n = h.numSeats || 2;
      if (n <= 2) {
        respCanEnvit = !alreadyPlayed(h, toSeat);
      } else {
        const respTeam = teamOf(toSeat);
        for (let i = 0; i < n; i++) {
          if (i % 2 === respTeam && !alreadyPlayed(h, i)) {
            respCanEnvit = true;
            break;
          }
        }
      }
    }
    h.envitAvailable = respCanEnvit;

    const nom = state.players?.[K(seat)]?.name || `J${seat}`;
    pushLog(state, `${nom} canta truc.`);
    return true;
  }
  return false;
}

export async function respondEnvit(choice) {
  let envitResult = null;
  if (choice === "vull" && session.roomCode) {
    try {
      const resolver = httpsCallable(functions, "resolverEnvit");
      const res = await resolver({ roomId: session.roomCode });
      envitResult = res.data;
    } catch (e) {
      console.error("Error resolviendo envit:", e);
      // Si falla la función, el mutate fallará o dará 0 puntos (comportamiento actual con *)
    }
  }
  await mutate((state) => _respondEnvitCore(state, session.mySeat, choice, envitResult));
  pullRoomAndRender();
}
export async function respondEnvitAsBot(choice) {
  let envitResult = null;
  if (choice === "vull" && session.roomCode) {
    try {
      const resolver = httpsCallable(functions, "resolverEnvit");
      const res = await resolver({ roomId: session.roomCode });
      envitResult = res.data;
    } catch (e) {}
  }
  await mutate((state) => _respondEnvitCore(state, 1, choice, envitResult));
}

function _respondEnvitCore(state, seat, choice, envitResult = null) {
  const h = state.hand,
    offer = h?.pendingOffer;
  if (!h || state.status !== "playing" || h.status !== "in_progress")
    return false;
  if (
    !offer ||
    offer.kind !== "envit" ||
    h.turn !== seat ||
    h.mode !== "respond_envit"
  )
    return false;
  const caller = offer.by,
    resp = offer.to;
  if (choice === "vull") {
    // Calcular guanyador per EQUIP: agrega el millor envit de tots els membres de cada equip.
    // 1v1: equip 0 = seat 0, equip 1 = seat 1
    // 2v2: equip 0 = seats 0+2, equip 1 = seats 1+3
    const n = h.numSeats || 2;

    // Per a cada equip, calcular el millor envit entre tots els seus jugadors
    let bestV0 = 0;
    let bestV1 = 0;
    let bestHand0 = []; // la mà del jugador d'equip 0 amb millor envit
    let bestHand1 = []; // la mà del jugador d'equip 1 amb millor envit

    for (let i = 0; i < n; i++) {
      const playedCard = getPlayed(h, i);
      const fullHand = playedCard
        ? [...fromHObj(h.hands?.[K(i)]), playedCard]
        : fromHObj(h.hands?.[K(i)]);
      const v = Logica.bestEnvit(fullHand);
      if (i % 2 === 0) {
        // Equip 0
        if (v > bestV0) { bestV0 = v; bestHand0 = fullHand; }
      } else {
        // Equip 1
        if (v > bestV1) { bestV1 = v; bestHand1 = fullHand; }
      }
    }

    const v0 = envitResult ? envitResult.v0 : bestV0;
    const v1 = envitResult ? envitResult.v1 : bestV1;
    const envitWinner = envitResult ? envitResult.winnerTeam : (v0 > v1 ? 0 : v1 > v0 ? 1 : teamOf(state.mano));
    const perMa = v0 === v1;

    const winnerFullHand = envitResult ? envitResult.winnerHand : (envitWinner === 0 ? bestHand0 : bestHand1);
    const visible = Logica.collectTableCards(h);
    const proof = Logica.bestEnvitProof(winnerFullHand, visible);

    h.envit = {
      state: "accepted",
      caller,
      responder: resp,
      acceptedLevel: offer.level,
      acceptedBy: seat,
      winner: envitWinner,
      envitV0: v0,
      envitV1: v1,
      perMa,
      proof: proof.cards?.length > 0
        ? { points: proof.points, cards: proof.cards }
        : null,
    };
    h.envitAvailable = false;
    pushLog(
      state,
      `Envit acceptat (${offer.level === "falta" ? "falta" : offer.level}).`,
    );
    resumeOffer(state);
    h.turnStartedAt = serverTimestamp();
    return true;
  }
  if (choice === "no_vull") {
    h.envit = {
      state: "rejected",
      caller,
      responder: resp,
      offeredLevel: offer.level,
      acceptedBy: null,
      ...(offer.level === "falta"
        ? { faltaFromLevel: offer.faltaFromLevel ?? null }
        : {}),
    };
    h.envitAvailable = false;
    pushLog(state, `No vull l'envit. Puntuació al final de la mà.`);
    resumeOffer(state);
    return true;
  }
  if (choice === "torne") {
    if (offer.level !== 2) return false;
    h.pendingOffer = { kind: "envit", level: 4, by: resp, to: caller };
    h.turn = caller;
    h.turnStartedAt = serverTimestamp();
    h.mode = "respond_envit";
    h.envitAvailable = false;
    pushLog(state, "Torne a envit 4.");
    return true;
  }
  if (choice === "falta") {
    h.pendingOffer = {
      kind: "envit",
      level: "falta",
      by: resp,
      to: caller,
      faltaFromLevel: offer.level === 4 ? 4 : 2,
    };
    h.turn = caller;
    h.turnStartedAt = serverTimestamp();
    h.mode = "respond_envit";
    h.envitAvailable = false;
    pushLog(state, "Envit de falta.");
    return true;
  }
  return false;
}

export async function respondTruc(choice) {
  await mutate((state) => _respondTrucCore(state, session.mySeat, choice));
  pullRoomAndRender();
}
export async function respondTrucAsBot(choice) {
  await mutate((state) => _respondTrucCore(state, 1, choice));
}

function _respondTrucCore(state, seat, choice) {
  const h = state.hand,
    offer = h?.pendingOffer;
  if (!h || state.status !== "playing" || h.status !== "in_progress")
    return false;
  if (
    !offer ||
    offer.kind !== "truc" ||
    h.turn !== seat ||
    h.mode !== "respond_truc"
  )
    return false;
  const caller = offer.by,
    resp = offer.to;
  if (choice === "vull") {
    h.truc = {
      state: "accepted",
      caller,
      responder: resp,
      acceptedLevel: offer.level,
      acceptedBy: seat,
      acceptedAtTrick: (h.trickHistory || []).length,
      acceptedAfterPlayCount: Logica.countCardsPlayedThisHand(h),
    };
    h.envitAvailable = false;
    pushLog(state, `Truc acceptat (${offer.level}).`);
    resumeOffer(state);
    h.turnStartedAt = serverTimestamp();
    return true;
  }
  if (choice === "no_vull") {
    h.truc = {
      state: "rejected",
      caller,
      responder: resp,
      acceptedLevel: offer.level - 1,
      acceptedBy: null,
    };
    h.envitAvailable = false;
    const nom = pName(state, seat);
    Logica.applyHandEnd(state, `${nom} no vol el Truc.`, seat);
    return true;
  }
  if (choice === "retruque") {
    if (offer.level !== 2) return false;
    h.pendingOffer = { kind: "truc", level: 3, by: resp, to: caller };
    h.turn = caller;
    h.turnStartedAt = serverTimestamp();
    h.mode = "respond_truc";
    h.envitAvailable = false;
    pushLog(state, "Retruque a 3.");
    return true;
  }
  if (choice === "val4") {
    if (offer.level !== 3) return false;
    h.pendingOffer = { kind: "truc", level: 4, by: resp, to: caller };
    h.turn = caller;
    h.turnStartedAt = serverTimestamp();
    h.mode = "respond_truc";
    h.envitAvailable = false;
    pushLog(state, "Val 4 al truc.");
    return true;
  }
  return false;
}

export async function timeoutTurn() {
  await mutate((state) => {
    const n = getNumSeats(state);
    if (session.mySeat < 0 || session.mySeat >= n) return false;
    const h = state.hand;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    // Pot fer timeout si és el seu torn, o si tots han jugat (race condition)
    if (h.turn !== session.mySeat && !_allPlayed(h))
      return false;
    if (h.pendingOffer?.to === session.mySeat) {
      if (h.pendingOffer.kind === "envit") {
        h.envit = {
          state: "rejected",
          caller: h.pendingOffer.by,
          responder: session.mySeat,
          offeredLevel: h.pendingOffer.level,
          acceptedBy: null,
          ...(h.pendingOffer.level === "falta"
            ? { faltaFromLevel: h.pendingOffer.faltaFromLevel ?? null }
            : {}),
        };
        h.envitAvailable = false;
        pushLog(state, "Temps. Envit rebutjat auto.");
        resumeOffer(state);
        return true;
      }
      if (h.pendingOffer.kind === "truc") {
        Logica.applyHandEnd(
          state,
          `Temps esgotat per a ${pName(state, session.mySeat)}.`,
          session.mySeat,
        );
        return true;
      }
    }
    if (!alreadyPlayed(h, session.mySeat) && h.mode === "normal") {
      Logica.applyHandEnd(
        state,
        `Temps esgotat per a ${pName(state, session.mySeat)}.`,
        session.mySeat,
      );
      return true;
    }
    return false;
  });
}

export async function requestRematch() {
  if (!session.roomRef || session.mySeat === null) return;
  const { resetHandIntroPlayed } = await import("./renderGame.js");
  resetHandIntroPlayed();

  /** Helper: genera objecte { _0: val, _1: val, ... } per a N seients */
  const _nObj = (n, val) => {
    const o = {};
    for (let i = 0; i < n; i++) o[K(i)] = val;
    return o;
  };

  if (isBotActive()) {
    await mutate((state) => {
      if (state.status !== "game_over") return false;
      const n = getNumSeats(state);
      state.status = "waiting";
      state.scores = { [K(0)]: OFFSET, [K(1)]: OFFSET };
      state.handNumber = OFFSET;
      state.mano = nextMano(state, state.mano);
      state.hand = null;
      state.winner = null;
      state.gameEndReason = null;
      state.rematch = _nObj(n, false);
      state.ready = _nObj(n, true);
      state.logs = [];
      pushLog(state, "Revenja iniciada!");
      return true;
    });
    await dealHand();
    return;
  }

  await mutate((state) => {
    const n = getNumSeats(state);
    if (!state.rematch) state.rematch = _nObj(n, false);
    state.rematch[K(session.mySeat)] = true;
    // Comprovar si tots han demanat revenja
    let allReady = true;
    for (let i = 0; i < n; i++) {
      if (!state.rematch[K(i)]) { allReady = false; break; }
    }
    if (allReady) {
      state.status = "waiting";
      state.scores = { [K(0)]: OFFSET, [K(1)]: OFFSET };
      state.handNumber = OFFSET;
      state.mano = nextMano(state, state.mano);
      state.hand = null;
      state.winner = null;
      state.gameEndReason = null;
      state.rematch = _nObj(n, false);
      state.ready = _nObj(n, false);
      state.logs = [];
      pushLog(state, "Revenja iniciada!");
    }
    return true;
  });
}

export async function claimWinByRivalAbsence() {
  await mutate((state) => {
    if (state.status === "game_over") return false;

    const preGameLobby =
      state.status === "waiting" && real(state.handNumber || OFFSET) === 0;
    if (preGameLobby) return false;

    const n = getNumSeats(state);
    if (session.mySeat < 0 || session.mySeat >= n) return false;

    const rivalSeat = _respondingSeat(state, session.mySeat);
    const me = state.players?.[K(session.mySeat)];
    const rival = state.players?.[K(rivalSeat)];
    if (!me) return false;

    const setWin = (logLine) => {
      if (state.hand?.allTricks) state.lastAllTricks = state.hand.allTricks;
      state.hand = null;
      state.status = "game_over";
      state.winner = teamOf(session.mySeat);
      state.gameEndReason = "abandonment";
      pushLog(state, logLine);
    };

    // Rival ja no està a `players` (p. ex. ha fet «Eixir» i s'ha borrat el node)
    if (!rival) {
      setWin("Victòria per abandonament (rival fora de la sala).");
      return true;
    }

    const rivalName = rival.name || "El rival";
    setWin(
      `${rivalName} no s'ha reconnectat: victòria per abandonament.`,
    );
    return true;
  });
}

export async function guestReady() {
  await mutate((state) => {
    if (!state.ready) {
      const n = getNumSeats(state);
      const r = {};
      for (let i = 0; i < n; i++) r[K(i)] = false;
      state.ready = r;
    }
    state.ready[K(session.mySeat)] = true;
    pushLog(state, pName(state, session.mySeat) + " està preparat!");
    return true;
  });
}

export async function registerRivalAbsence() {
  await mutate((state) => {
    if (state.status !== "playing") return false;
    const rivalSeat = _respondingSeat(state, session.mySeat);
    const rival = state.players?.[K(rivalSeat)];
    if (!rival) return false;
    
    rival.disconnects = (rival.disconnects || 0) + 1;
    pushLog(state, `${rival.name} s'ha desconnectat (${rival.disconnects}/3).`);
    
    if (rival.disconnects >= 3) {
      if (state.hand?.allTricks) state.lastAllTricks = state.hand.allTricks;
      state.hand = null;
      state.status = "game_over";
      state.winner = teamOf(session.mySeat);
      state.gameEndReason = "abandonment";
      pushLog(state, `Victòria per excés de desconnexions de ${rival.name}.`);
    }
    return true;
  });
}
