// --- Acciones de partida (mutaciones via Firebase) ----------------------------
import { session, mutate as mutateFirebase, get } from "./firebase.js";
import { isBotActive } from "./bot.js";
import * as Logica from "./logica.js";

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
  if (!h.played) h.played = { [PK(0)]: EMPTY_CARD, [PK(1)]: EMPTY_CARD };
  h.played[PK(seat)] = card || EMPTY_CARD;
};
const alreadyPlayed = (h, seat) => getPlayed(h, seat) !== null;

function pushLog(st, text, meta) {
  st.logs = st.logs || [];
  const row = { text, at: Date.now() };
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

export function defaultState() {
  return {
    version: 8,
    status: "waiting",
    roomCode: "",
    players: { [K(0)]: null, [K(1)]: null },
    ready: { [K(0)]: false, [K(1)]: false },
    scores: { [K(0)]: OFFSET, [K(1)]: OFFSET },
    handNumber: OFFSET,
    mano: 0,
    turn: 0,
    hand: null,
    lastHandSummary: null,
    logs: [],
    winner: null,
    gameEndReason: null,
    settings: {
      puntosParaGanar: 12,
      modoJuego: "1v1",
      maxJugadores: 2,
    },
    openingIntroAt: 0,
  };
}

function resumeOffer(state) {
  const h = state.hand,
    r = h.resume;
  h.envitAvailable = false;
  if (r) {
    h.mode = r.mode;
    h.turn = r.turn;
    // ¡AQUÍ ESTÁ LA MAGIA! Recuperamos la oferta anterior (el Truc) si la había
    h.pendingOffer = r.oldOffer || null;
  } else {
    h.mode = "normal";
    h.pendingOffer = null;
  }
  h.resume = null;
}

const mutate = (fn) => mutateFirebase(fn, defaultState);

let _renderAll = () => {};
export function configureActions({ renderAll }) {
  _renderAll = renderAll;
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
  await mutate((state) => {
    if (!state.players?.[K(0)] || !state.players?.[K(1)]) return false;
    if (state.status === "game_over") return false;
    if (state.hand?.status === "in_progress") return false;

    // Primera mano: preparació + quién empieza
    if (real(state.handNumber) === 0) {
      if (!state.ready) state.ready = { [K(0)]: false, [K(1)]: false };
      if (!state.ready[K(0)] || !state.ready[K(1)]) return false;
      state.mano = Math.random() < 0.5 ? 0 : 1;
      state.openingIntroAt = Date.now();
    }

    state.hand = Logica.makeHand(state.mano);
    state.status = "playing";
    // Evita que `lastAllTricks` de la mà anterior confonga el render entre mans / ofertes
    state.lastAllTricks = [];
    pushLog(state, `Ma #${real(state.handNumber) + 1}. Torn: J${state.mano}.`);
    return true;
  });
  pullRoomAndRender();
}

export async function playCard(card) {
  if (ui.locked) return;
  ui.locked = true;
  document
    .querySelectorAll("#myCards .my-card-wrap")
    .forEach((w) => w.classList.remove("playable"));
  try {
    await mutate((state) => {
      const h = state.hand;
      if (!h || state.status !== "playing" || h.status !== "in_progress")
        return false;
      if (h.mode !== "normal" || h.pendingOffer) return false;
      if (h.turn !== session.mySeat) return false;
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
      if (alreadyPlayed(h, session.mySeat)) {
        console.warn("PLAYCARD: already played");
        return false;
      }
      const mine = fromHObj(h.hands?.[K(session.mySeat)]);
      if (!mine.includes(card)) return false;
      h.hands[K(session.mySeat)] = toHObj(mine.filter((c) => c !== card));
      setPlayed(h, session.mySeat, card);
      h.envitAvailable = false;
      const plrName =
        state.players?.[K(session.mySeat)]?.name || `J${session.mySeat}`;
      pushLog(state, `${plrName} juga ${cardLabel(card)}.`);
      if (alreadyPlayed(h, other(session.mySeat))) {
        Logica.resolveTrick(state);
      } else {
        h.turn = other(session.mySeat);
        const isBaza1 = (h.trickHistory || []).length === 0;
        h.envitAvailable = isBaza1;
      }
      return true;
    });
  } finally {
    setTimeout(() => {
      ui.locked = false;
      if (session.roomRef) {
        get(session.roomRef)
          .then((snap) => {
            if (snap.val()) _renderAll(snap.val());
          })
          .catch(() => {});
      }
    }, 90);
  }
}

export async function playCardAsBot(card) {
  if (ui.locked) return;
  ui.locked = true;
  document
    .querySelectorAll("#myCards .my-card-wrap")
    .forEach((w) => w.classList.remove("playable"));
  try {
    await mutate((state) => {
      const botSeat = 1;
      const h = state.hand;
      if (!h || state.status !== "playing" || h.status !== "in_progress")
        return false;
      if (h.mode !== "normal" || h.pendingOffer) return false;
      if (h.turn !== botSeat) return false;
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
      if (alreadyPlayed(h, botSeat)) {
        console.warn("PLAYCARD BOT: already played");
        return false;
      }
      const mine = fromHObj(h.hands?.[K(botSeat)]);
      if (!mine.includes(card)) return false;
      h.hands[K(botSeat)] = toHObj(mine.filter((c) => c !== card));
      setPlayed(h, botSeat, card);
      h.envitAvailable = false;
      const plrName = state.players?.[K(botSeat)]?.name || `J${botSeat}`;
      pushLog(state, `${plrName} juga ${cardLabel(card)}.`);
      if (alreadyPlayed(h, other(botSeat))) {
        Logica.resolveTrick(state);
      } else {
        h.turn = other(botSeat);
        const isBaza1 = (h.trickHistory || []).length === 0;
        h.envitAvailable = isBaza1;
      }
      return true;
    });
  } finally {
    setTimeout(() => {
      ui.locked = false;
      if (session.roomRef) {
        get(session.roomRef)
          .then((snap) => {
            if (snap.val()) _renderAll(snap.val());
          })
          .catch(() => {});
      }
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
  await mutate((state) => {
    const h = state.hand;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    if (h.turn !== session.mySeat) return false;

    // Nueva lógica para Envit o Falta (incluso cruzándolos sobre un Truc)
    if (kind === "envit" || kind === "falta") {
      if (!(h.mode === "normal" || h.mode === "respond_truc")) return false;
      if (!h.envitAvailable || h.envit.state !== "none") return false;
      const tricksDone = (h.trickHistory || []).length;
      if (tricksDone !== 0) return false;
      if (alreadyPlayed(h, session.mySeat)) return false;
      if (h.mode === "normal") {
        const noTrucAtAll =
          h.truc.state === "none" && !(h.pendingOffer?.kind === "truc");
        if (!noTrucAtAll) return false;
      }

      const level = kind === "falta" ? "falta" : 2;

      // Guardamos el offer anterior (ej. el Truc) en oldOffer para no perderlo
      h.resume = {
        mode: h.mode,
        turn: h.turn,
        oldOffer: h.pendingOffer || null,
      };
      h.pendingOffer = {
        kind: "envit",
        level: level,
        by: session.mySeat,
        to: other(session.mySeat),
      };
      h.mode = "respond_envit";
      h.turn = other(session.mySeat);

      const nom =
        state.players?.[K(session.mySeat)]?.name || `J${session.mySeat}`;
      pushLog(state, `${nom} canta ${kind === "falta" ? "FALTA" : "envit"}.`);
      return true;
    }

    if (kind === "truc") {
      if (h.mode !== "normal") return false;
      if (h.pendingOffer) return false; // Solo puedes trucar si no hay un envite pendiente

      let trucLevel = 2;
      if (h.truc.state === "accepted" && h.truc.responder === session.mySeat) {
        trucLevel = Number(h.truc.acceptedLevel || 2) + 1;
        if (trucLevel > 4) return false;
      } else if (h.truc.state !== "none") return false;

      h.resume = {
        mode: h.mode,
        turn: h.turn,
        oldOffer: h.pendingOffer || null,
      };
      h.pendingOffer = {
        kind: "truc",
        level: trucLevel,
        by: session.mySeat,
        to: other(session.mySeat),
      };
      h.mode = "respond_truc";
      h.turn = other(session.mySeat);
      h.envitAvailable = true;

      const nom =
        state.players?.[K(session.mySeat)]?.name || `J${session.mySeat}`;
      pushLog(state, `${nom} canta truc.`);
      return true;
    }
    return false;
  });
  pullRoomAndRender();
}

export async function startOfferAsBot(kind) {
  await mutate((state) => {
    const botSeat = 1;
    const h = state.hand;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    if (h.turn !== botSeat) return false;

    if (kind === "envit" || kind === "falta") {
      if (!(h.mode === "normal" || h.mode === "respond_truc")) return false;
      if (!h.envitAvailable || h.envit.state !== "none") return false;
      const tricksDone = (h.trickHistory || []).length;
      if (tricksDone !== 0) return false;
      if (alreadyPlayed(h, botSeat)) return false;
      if (h.mode === "normal") {
        const noTrucAtAll =
          h.truc.state === "none" && !(h.pendingOffer?.kind === "truc");
        if (!noTrucAtAll) return false;
      }

      const level = kind === "falta" ? "falta" : 2;
      h.resume = {
        mode: h.mode,
        turn: h.turn,
        oldOffer: h.pendingOffer || null,
      };
      h.pendingOffer = {
        kind: "envit",
        level: level,
        by: botSeat,
        to: other(botSeat),
      };
      h.mode = "respond_envit";
      h.turn = other(botSeat);

      const nom = state.players?.[K(botSeat)]?.name || `J${botSeat}`;
      pushLog(state, `${nom} canta ${kind === "falta" ? "FALTA" : "envit"}.`);
      return true;
    }

    if (kind === "truc") {
      if (h.mode !== "normal") return false;
      if (h.pendingOffer) return false;

      let trucLevel = 2;
      if (h.truc.state === "accepted" && h.truc.responder === botSeat) {
        trucLevel = Number(h.truc.acceptedLevel || 2) + 1;
        if (trucLevel > 4) return false;
      } else if (h.truc.state !== "none") return false;

      h.resume = {
        mode: h.mode,
        turn: h.turn,
        oldOffer: h.pendingOffer || null,
      };
      h.pendingOffer = {
        kind: "truc",
        level: trucLevel,
        by: botSeat,
        to: other(botSeat),
      };
      h.mode = "respond_truc";
      h.turn = other(botSeat);
      h.envitAvailable = true;

      const nom = state.players?.[K(botSeat)]?.name || `J${botSeat}`;
      pushLog(state, `${nom} canta truc.`);
      return true;
    }
    return false;
  });
}

export async function respondEnvit(choice) {
  await mutate((state) => {
    const h = state.hand,
      offer = h?.pendingOffer;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    if (
      !offer ||
      offer.kind !== "envit" ||
      h.turn !== session.mySeat ||
      h.mode !== "respond_envit"
    )
      return false;
    const caller = offer.by,
      resp = offer.to;
    if (choice === "vull") {
      // Calcular ganador AHORA, antes de que se jueguen más cartas.
      // IMPORTANT: si un jugador ya había jugado una carta en la 1a baza antes
      // de cantarse el envit, esa carta está en h.played (no en h.hands).
      // Hay que incluirla para evaluar la mano completa correctamente.
      const played0 = getPlayed(h, 0);
      const played1 = getPlayed(h, 1);
      const fullHand0 = played0
        ? [...fromHObj(h.hands?.[K(0)]), played0]
        : fromHObj(h.hands?.[K(0)]);
      const fullHand1 = played1
        ? [...fromHObj(h.hands?.[K(1)]), played1]
        : fromHObj(h.hands?.[K(1)]);
      const v0 = Logica.bestEnvit(fullHand0);
      const v1 = Logica.bestEnvit(fullHand1);
      const envitWinner = v0 > v1 ? 0 : v1 > v0 ? 1 : state.mano;
      const perMa = v0 === v1;

      // Precomputar la prueba AHORA con la mano completa (después las cartas
      // jugadas en bazas se pierden de h.hands y el cálculo sería incorrecto).
      const winnerFullHand = envitWinner === 0 ? fullHand0 : fullHand1;
      const visible = Logica.collectTableCards(h);
      const proof = Logica.bestEnvitProof(winnerFullHand, visible);

      h.envit = {
        state: "accepted",
        caller,
        responder: resp,
        acceptedLevel: offer.level,
        acceptedBy: session.mySeat,
        winner: envitWinner,
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
      const nomCaller = pName(state, caller);
      pushLog(state, `No vull l'envit. Puntuació al final de la mà.`);
      resumeOffer(state);
      return true;
    }
    if (choice === "torne") {
      if (offer.level !== 2) return false;
      h.pendingOffer = { kind: "envit", level: 4, by: resp, to: caller };
      h.turn = caller;
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
      h.mode = "respond_envit";
      h.envitAvailable = false;
      pushLog(state, "Envit de falta.");
      return true;
    }
    return false;
  });
  pullRoomAndRender();
}

export async function respondEnvitAsBot(choice) {
  await mutate((state) => {
    const botSeat = 1;
    const h = state.hand,
      offer = h?.pendingOffer;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    if (
      !offer ||
      offer.kind !== "envit" ||
      h.turn !== botSeat ||
      h.mode !== "respond_envit"
    )
      return false;
    const caller = offer.by,
      resp = offer.to;
    if (choice === "vull") {
      const played0 = getPlayed(h, 0);
      const played1 = getPlayed(h, 1);
      const fullHand0 = played0
        ? [...fromHObj(h.hands?.[K(0)]), played0]
        : fromHObj(h.hands?.[K(0)]);
      const fullHand1 = played1
        ? [...fromHObj(h.hands?.[K(1)]), played1]
        : fromHObj(h.hands?.[K(1)]);
      const v0 = Logica.bestEnvit(fullHand0);
      const v1 = Logica.bestEnvit(fullHand1);
      const envitWinner = v0 > v1 ? 0 : v1 > v0 ? 1 : state.mano;
      const perMa = v0 === v1;

      const winnerFullHand = envitWinner === 0 ? fullHand0 : fullHand1;
      const visible = Logica.collectTableCards(h);
      const proof = Logica.bestEnvitProof(winnerFullHand, visible);

      h.envit = {
        state: "accepted",
        caller,
        responder: resp,
        acceptedLevel: offer.level,
        acceptedBy: botSeat,
        winner: envitWinner,
        perMa,
        proof:
          proof.cards?.length > 0
            ? { points: proof.points, cards: proof.cards }
            : null,
      };
      h.envitAvailable = false;
      pushLog(
        state,
        `Envit acceptat (${offer.level === "falta" ? "falta" : offer.level}).`,
      );
      resumeOffer(state);
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
      pushLog(state, "No vull l'envit. Puntuació al final de la mà.");
      resumeOffer(state);
      return true;
    }
    if (choice === "torne") {
      if (offer.level !== 2) return false;
      h.pendingOffer = { kind: "envit", level: 4, by: resp, to: caller };
      h.turn = caller;
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
      h.mode = "respond_envit";
      h.envitAvailable = false;
      pushLog(state, "Envit de falta.");
      return true;
    }
    return false;
  });
}

export async function respondTruc(choice) {
  await mutate((state) => {
    const h = state.hand,
      offer = h?.pendingOffer;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    if (
      !offer ||
      offer.kind !== "truc" ||
      h.turn !== session.mySeat ||
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
        acceptedBy: session.mySeat,
      };
      h.envitAvailable = false;
      pushLog(state, `Truc acceptat (${offer.level}).`);
      resumeOffer(state);
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

      const nom = pName(state, session.mySeat);
      // La lógica ahora calculará si el rival gana 1, 2 o 3 puntos según el nivel del Truc
      Logica.applyHandEnd(state, `${nom} no vol el Truc.`, session.mySeat);
      return true;
    }
    if (choice === "retruque") {
      if (offer.level !== 2) return false;
      h.pendingOffer = { kind: "truc", level: 3, by: resp, to: caller };
      h.turn = caller;
      h.mode = "respond_truc";
      h.envitAvailable = true;
      pushLog(state, "Retruque a 3.");
      return true;
    }
    if (choice === "val4") {
      if (offer.level !== 3) return false;
      h.pendingOffer = { kind: "truc", level: 4, by: resp, to: caller };
      h.turn = caller;
      h.mode = "respond_truc";
      h.envitAvailable = true;
      pushLog(state, "Val 4 al truc.");
      return true;
    }
    return false;
  });
  pullRoomAndRender();
}

export async function respondTrucAsBot(choice) {
  await mutate((state) => {
    const botSeat = 1;
    const h = state.hand,
      offer = h?.pendingOffer;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    if (
      !offer ||
      offer.kind !== "truc" ||
      h.turn !== botSeat ||
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
        acceptedBy: botSeat,
      };
      h.envitAvailable = false;
      pushLog(state, `Truc acceptat (${offer.level}).`);
      resumeOffer(state);
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

      const nom = pName(state, botSeat);
      Logica.applyHandEnd(state, `${nom} no vol el Truc.`, botSeat);
      return true;
    }
    if (choice === "retruque") {
      if (offer.level !== 2) return false;
      h.pendingOffer = { kind: "truc", level: 3, by: resp, to: caller };
      h.turn = caller;
      h.mode = "respond_truc";
      h.envitAvailable = true;
      pushLog(state, "Retruque a 3.");
      return true;
    }
    if (choice === "val4") {
      if (offer.level !== 3) return false;
      h.pendingOffer = { kind: "truc", level: 4, by: resp, to: caller };
      h.turn = caller;
      h.mode = "respond_truc";
      h.envitAvailable = true;
      pushLog(state, "Val 4 al truc.");
      return true;
    }
    return false;
  });
}

export async function timeoutTurn() {
  await mutate((state) => {
    if (session.mySeat !== 0 && session.mySeat !== 1) return false;
    const h = state.hand;
    if (!h || state.status !== "playing" || h.status !== "in_progress")
      return false;
    if (h.turn !== session.mySeat && !alreadyPlayed(h, other(session.mySeat)))
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

  if (isBotActive()) {
    await mutate((state) => {
      if (state.status !== "game_over") return false;
      state.status = "waiting";
      state.scores = { [K(0)]: OFFSET, [K(1)]: OFFSET };
      state.handNumber = OFFSET;
      state.mano = other(state.mano);
      state.hand = null;
      state.winner = null;
      state.gameEndReason = null;
      state.rematch = { [K(0)]: false, [K(1)]: false };
      state.ready = { [K(0)]: true, [K(1)]: true };
      state.logs = [];
      pushLog(state, "Revenja iniciada!");
      return true;
    });
    await dealHand();
    return;
  }

  await mutate((state) => {
    if (!state.rematch) state.rematch = { [K(0)]: false, [K(1)]: false };
    state.rematch[K(session.mySeat)] = true;
    if (state.rematch[K(0)] && state.rematch[K(1)]) {
      state.status = "waiting";
      state.scores = { [K(0)]: OFFSET, [K(1)]: OFFSET };
      state.handNumber = OFFSET;
      state.mano = other(state.mano);
      state.hand = null;
      state.winner = null;
      state.gameEndReason = null;
      state.rematch = { [K(0)]: false, [K(1)]: false };
      state.ready = { [K(0)]: false, [K(1)]: false };
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

    if (session.mySeat !== 0 && session.mySeat !== 1) return false;

    const rivalSeat = other(session.mySeat);
    const me = state.players?.[K(session.mySeat)];
    const rival = state.players?.[K(rivalSeat)];
    if (!me) return false;

    const setWin = (logLine) => {
      if (state.hand?.allTricks) state.lastAllTricks = state.hand.allTricks;
      state.hand = null;
      state.status = "game_over";
      state.winner = session.mySeat;
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
    if (!state.ready) state.ready = { [K(0)]: false, [K(1)]: false };
    state.ready[K(session.mySeat)] = true;
    pushLog(state, pName(state, session.mySeat) + " està preparat!");
    return true;
  });
}
