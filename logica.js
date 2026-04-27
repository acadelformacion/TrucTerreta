// --- Lógica de mano / bazas (extraído de game.js) ----------------------------

const K = (n) => `_${n}`; // seat: 0->"_0"
const PK = (n) => `p${n}`; // played key: 0->"p0"
const HKEYS = ["a", "b", "c"];
const EMPTY_CARD = "~"; // marcador "no jugada" (valor no valido)
const OFFSET = 10; // scores/trickWins stored +10
const SUIT_ORDER = ["oros", "copas", "espadas", "bastos"];

const toHObj = (arr) => {
  const o = {};
  (arr || [])
    .filter((c) => c && c !== EMPTY_CARD)
    .forEach((c, i) => {
      o[HKEYS[i]] = c;
    });
  // Siempre al menos un campo para que Firebase no borre el nodo
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
const resetPlayed = (h) => {
  h.played = { [PK(0)]: EMPTY_CARD, [PK(1)]: EMPTY_CARD };
};

const real = (n) => Number(n || OFFSET) - OFFSET; // decode stored value
const other = (s) => (s === 0 ? 1 : 0);

function getScore(st, seat) {
  return real(st?.scores?.[K(seat)]);
}

/** Pedres per guanyar la partida (12 o 24), per defecte 12 si falta configuració. */
export function getPuntosParaGanar(state) {
  const n = Number(state?.settings?.puntosParaGanar);
  return n === 24 ? 24 : 12;
}

function puntosFalta(state) {
  const lim = getPuntosParaGanar(state);
  return lim - Math.max(getScore(state, 0), getScore(state, 1));
}
function addScore(st, seat, pts) {
  if (!st.scores) st.scores = { [K(0)]: OFFSET, [K(1)]: OFFSET };
  st.scores[K(seat)] = Number(st.scores[K(seat)] || OFFSET) + pts;
}
function getTW(h, seat) {
  return real(h?.trickWins?.[K(seat)]);
}
function addTW(h, seat) {
  h.trickWins[K(seat)] = Number(h.trickWins[K(seat)] || OFFSET) + 1;
}
function getSA(h, seat) {
  return real(h?.scoreAwards?.[K(seat)]);
}
function pushLog(st, text, meta) {
  st.logs = st.logs || [];
  const row = { text, at: Date.now() };
  if (meta?.envitProof?.cards?.length)
    row.envitProof = {
      points: Number(meta.envitProof.points) || 0,
      cards: meta.envitProof.cards.filter(Boolean),
    };
  // Guarda el seient guanyador per al resum (evita heurística de noms)
  if (meta?.winnerSeat === 0 || meta?.winnerSeat === 1)
    row.winnerSeat = meta.winnerSeat;
  st.logs.unshift(row);
  st.logs = st.logs.slice(0, 30);
}

export function getTrickIndex(h) {
  return real(h?.trickIndex);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildDeck() {
  const c = [],
    n = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
  for (const s of SUIT_ORDER) for (const x of n) c.push(`${x}_${s}`);
  return c;
}

export const TRG = [
  ["1_espadas"],
  ["1_bastos"],
  ["7_espadas"],
  ["7_oros"],
  ["3_oros", "3_copas", "3_espadas", "3_bastos"],
  ["2_oros", "2_copas", "2_espadas", "2_bastos"],
  ["1_oros", "1_copas"],
  ["12_oros", "12_copas", "12_espadas", "12_bastos"],
  ["11_oros", "11_copas", "11_espadas", "11_bastos"],
  ["10_oros", "10_copas", "10_espadas", "10_bastos"],
  ["7_copas", "7_bastos"],
  ["6_oros", "6_copas", "6_espadas", "6_bastos"],
  ["5_oros", "5_copas", "5_espadas", "5_bastos"],
  ["4_oros", "4_copas", "4_espadas", "4_bastos"],
];
export const TR = (() => {
  const m = {};
  let s = 100;
  for (const g of TRG) {
    for (const c of g) m[c] = s;
    s -= 10;
  }
  return m;
})();

export function parseCard(c) {
  const [n, s] = String(c).split("_");
  return { num: Number(n), suit: s };
}
function envitVal(c) {
  const n = parseCard(c).num;
  return n >= 10 ? 0 : n;
}
function trickRank(c) {
  return TR[c] ?? 0;
}
export function cmpTrick(a, b) {
  const d = trickRank(a) - trickRank(b);
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}
export function bestEnvit(cards) {
  if (!cards?.length) return 0;
  let best = 0;
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) {
      const a = parseCard(cards[i]),
        b = parseCard(cards[j]);
      if (a.suit === b.suit) {
        const v = 20 + envitVal(cards[i]) + envitVal(cards[j]);
        if (v > best) best = v;
      }
    }
  return best > 0 ? best : Math.max(0, ...cards.map(envitVal));
}

/** Cartes que han sortit al centre (bazas completades + jugada actual). */
export function collectTableCards(h) {
  const set = new Set();
  for (const t of h?.allTricks || []) {
    if (t.c0 && t.c0 !== EMPTY_CARD) set.add(t.c0);
    if (t.c1 && t.c1 !== EMPTY_CARD) set.add(t.c1);
  }
  for (const seat of [0, 1]) {
    const v = h?.played?.[PK(seat)];
    if (v && v !== EMPTY_CARD) set.add(v);
  }
  return set;
}

function pairTableHits(pair, vis) {
  const [a, b] = pair;
  return (vis.has(a) ? 1 : 0) + (vis.has(b) ? 1 : 0);
}

function pairKey(pair) {
  return [...pair].sort().join("|");
}

/**
 * Cartes que justifiquen el millor envit i la puntuació d'envit (no el que es canta).
 * @param {string[]} cards Mà completa (inclosa carta jugada a la 1a basa si escau).
 * @param {Set<string>|Iterable<string>} visibleSet Cartes ja mostrades al centre (desempat).
 */
export function bestEnvitProof(cards, visibleSet) {
  const vis =
    visibleSet instanceof Set ? visibleSet : new Set(visibleSet || []);
  const arr = (cards || []).filter((c) => c && c !== EMPTY_CARD);
  if (!arr.length) return { points: 0, cards: [] };

  let bestPair = 0;
  const pairsAtBest = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const ci = arr[i],
        cj = arr[j];
      const a = parseCard(ci),
        b = parseCard(cj);
      if (a.suit !== b.suit) continue;
      const v = 20 + envitVal(ci) + envitVal(cj);
      if (v > bestPair) {
        bestPair = v;
        pairsAtBest.length = 0;
        pairsAtBest.push([ci, cj]);
      } else if (v === bestPair) {
        pairsAtBest.push([ci, cj]);
      }
    }
  }

  if (bestPair > 0) {
    pairsAtBest.sort((p1, p2) => {
      const h1 = pairTableHits(p1, vis),
        h2 = pairTableHits(p2, vis);
      if (h1 !== h2) return h2 - h1;
      return pairKey(p1).localeCompare(pairKey(p2));
    });
    const [c1, c2] = pairsAtBest[0];
    const ordered = [c1, c2].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { points: bestPair, cards: ordered };
  }

  let bestSingle = 0;
  for (const c of arr) bestSingle = Math.max(bestSingle, envitVal(c));
  const singles = arr.filter((c) => envitVal(c) === bestSingle);
  singles.sort((a, b) => {
    const va = vis.has(a) ? 1 : 0,
      vb = vis.has(b) ? 1 : 0;
    if (va !== vb) return vb - va;
    const ra = trickRank(a),
      rb = trickRank(b);
    if (ra !== rb) return rb - ra;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const pick = singles[0];
  return pick ? { points: bestSingle, cards: [pick] } : { points: 0, cards: [] };
}

// --- Hand factory -------------------------------------------------------------
export function makeHand(mano) {
  const deck = shuffle(buildDeck());
  return {
    status: "in_progress",
    mano,
    turn: mano,
    mode: "normal",
    envitAvailable: true,
    pendingOffer: null,
    resume: null,
    hands: {
      [K(0)]: toHObj(deck.slice(0, 3)),
      [K(1)]: toHObj(deck.slice(3, 6)),
    },
    // played: siempre presente con EMPTY_CARD para que Firebase no lo borre
    played: { [PK(0)]: EMPTY_CARD, [PK(1)]: EMPTY_CARD },
    allTricks: [], // array de {c0,c1,w} de todas las bazas jugadas
    trickLead: mano,
    trickIndex: OFFSET, // stored +OFFSET
    trickWins: { [K(0)]: OFFSET, [K(1)]: OFFSET },
    trickHistory: [],
    scoreAwards: { [K(0)]: OFFSET, [K(1)]: OFFSET },
    envit: {
      state: "none",
      caller: null,
      responder: null,
      acceptedLevel: 0,
      acceptedBy: null,
    },
    truc: {
      state: "none",
      caller: null,
      responder: null,
      acceptedLevel: 0,
      acceptedBy: null,
    },
  };
}

/**
 * Qui ha matat la baza (guanya jugant segon) obri la següent: només pot tirar carta,
 * sense truc, retruc, envit ni falta fins haver-la jugat.
 */
export function mustPlayCardOnlyThisTrick(h, seat) {
  if (!h || h.mode !== "normal" || h.pendingOffer) return false;
  const hist = h.trickHistory || [];
  const tricksDone = hist.length;
  if (tricksDone === 0) return false;
  const lastTrick = hist[tricksDone - 1];
  if (
    !lastTrick ||
    lastTrick.winner === 99 ||
    lastTrick.winner === null ||
    lastTrick.winner === undefined
  )
    return false;
  if (lastTrick.winner !== seat) return false;
  if (lastTrick.winner === lastTrick.lead) return false;
  if (h.trickLead !== seat) return false;
  if (getPlayed(h, seat)) return false;
  return true;
}

// --- Game logic ---------------------------------------------------------------
export function handWinner(state) {
  const h = state.hand;
  const hist = h.trickHistory || [];

  // Extraemos quién ganó cada baza (0, 1 o 99 para empate)
  const r1 = hist[0]?.winner;
  const r2 = hist[1]?.winner;
  const r3 = hist[2]?.winner;

  // 1. Victoria por "vía rápida" (2 bazas ganadas)
  const wins0 = hist.filter((t) => t.winner === 0).length;
  const wins1 = hist.filter((t) => t.winner === 1).length;
  if (wins0 >= 2) return 0;
  if (wins1 >= 2) return 1;

  // 2. Lógica de EMPATES (Pardas)

  // Si la primera es parda...
  if (r1 === 99) {
    if (r2 !== 99 && r2 !== undefined) return r2; // Gana el de la 2ª
    if (r3 !== 99 && r3 !== undefined) return r3; // Gana el de la 3ª
    return state.mano; // Las tres pardas: gana el Mano
  }

  // Si la primera la ganó alguien...
  if (r1 !== 99 && r1 !== undefined) {
    if (r2 === 99) return r1; // 1ª ganada, 2ª parda: Gana el de la 1ª

    // Si la 1ª la ganó uno y la 2ª el otro...
    if (r2 !== 99 && r2 !== r1) {
      if (r3 === 99) return r1; // 3ª parda: Gana el de la 1ª
      if (r3 !== undefined) return r3; // 3ª ganada: Gana el de la 3ª
    }
  }

  return r1 !== 99 && r1 !== undefined ? r1 : state.mano;
}

function fullHandForSeat(h, seat) {
  const played = getPlayed(h, seat);
  const base = fromHObj(h.hands?.[K(seat)]);
  return played ? [...base, played] : [...base];
}

/**
 * Guanyador de l'envit acceptat des del que es va guardar a Firebase.
 * Si falta `winner` (p. ex. 0 perdut a RTDB) o les mans ja estan buides,
 * s'usen `envitV0` / `envitV1` guardats en acceptar.
 */
function resolvedEnvitWinnerSeat(envit, mano) {
  if (!envit || envit.state !== "accepted") return null;
  const raw = envit.winner;
  if (raw === 0 || raw === 1) return raw;
  if (raw === "0" || raw === "1") return Number(raw);
  const ev0 = envit.envitV0,
    ev1 = envit.envitV1;
  if (Number.isFinite(Number(ev0)) && Number.isFinite(Number(ev1))) {
    const v0 = Number(ev0),
      v1 = Number(ev1);
    return v0 > v1 ? 0 : v1 > v0 ? 1 : mano;
  }
  return null;
}

export function applyHandEnd(state, reason, foldedSeat) {
  const h = state.hand;
  if (!h) return;
  const buildLastHandSummary = () => ({
    hands: {
      _0: h.hands?.[K(0)] || null,
      _1: h.hands?.[K(1)] || null,
    },
    allTricks: h.allTricks || [],
    envit: {
      state: h.envit?.state || "none",
      acceptedLevel: h.envit?.acceptedLevel || null,
      caller: h.envit?.caller ?? null,
      winner: resolvedEnvitWinnerSeat(h.envit, state.mano),
    },
    truc: {
      state: h.truc?.state || "none",
      acceptedLevel: h.truc?.acceptedLevel || null,
      caller: h.truc?.caller ?? null,
    },
    winner: null,
    mano: h.mano,
  });

  const finish = () => {
    const s0 = getScore(state, 0),
      s1 = getScore(state, 1);
    const meta = getPuntosParaGanar(state);
    if (s0 >= meta || s1 >= meta) {
      state.lastAllTricks = h.allTricks || [];
      pushLog(state, `Marcador: ${getScore(state, 0)}-${getScore(state, 1)}`);
      state.status = "game_over";
      state.winner = s0 > s1 ? 0 : s1 > s0 ? 1 : state.mano;
      state.hand = null;
      return true;
    }
    return false;
  };

  // NUEVO: Detectamos si alguien abandonó la mano ("Me'n vaig")
  const isFold = foldedSeat !== undefined && foldedSeat !== null;
  const winnerSeat = isFold ? other(foldedSeat) : null;
  state.lastHandSummary = buildLastHandSummary();

  // --- 1. RESOLVER ENVIT ---
  if (h.envit.state === "accepted") {
    let ew = isFold ? winnerSeat : resolvedEnvitWinnerSeat(h.envit, state.mano);
    let envitPerMa = !isFold && (h.envit.perMa === true);
    if (ew === null) {
      // Últim recurs: mans residuals (sense fiabilitat si ja estan buides → 0-0 i mano)
      const v0 = bestEnvit(fromHObj(h.hands?.[K(0)]));
      const v1 = bestEnvit(fromHObj(h.hands?.[K(1)]));
      envitPerMa = !isFold && (v0 === v1);
      ew = v0 > v1 ? 0 : v1 > v0 ? 1 : state.mano;
    }
    const ep =
      h.envit.acceptedLevel === "falta"
        ? puntosFalta(state)
        : Number(h.envit.acceptedLevel || 0);
    const ewName = state.players?.[K(ew)]?.name || `J${ew}`;
    addScore(state, ew, ep);
    // Usar prueba precomputada al aceptar el envit (mano completa).
    // Fallback con mano residual para compatibilidad con partidas antiguas.
    const preProof = h.envit.proof;
    const visible = collectTableCards(h);
    const proof =
      preProof?.cards?.length > 0
        ? preProof
        : bestEnvitProof(fullHandForSeat(h, ew), visible);
    const proofMeta = {
      winnerSeat: ew,
      ...(proof.cards?.length > 0
        ? {
            envitProof: {
              points: proof.points,
              cards: proof.cards,
              ...(envitPerMa ? { perMa: true } : {}),
            },
          }
        : {}),
    };
    pushLog(
      state,
      isFold
        ? `Envit: guanya ${ewName} per abandó (+${ep}).`
        : `Envit: guanya ${ewName} (+${ep}).`,
      proofMeta,
    );
    if (finish()) return;
  } else if (
    h.envit.state === "rejected" &&
    h.envit.caller !== undefined &&
    h.envit.caller !== null
  ) {
    // NUEVO BLOQUE: aplica el punto del envit rechazado aquí mismo,
    // sin depender de scoreAwards escrito en una transacción anterior
    const ec = h.envit.caller;
    const lvl = h.envit.offeredLevel;
    let ep = 1;
    if (lvl === "falta") {
      const ff = h.envit.faltaFromLevel;
      if (ff === 4) ep = 4;
      else if (ff === 2) ep = 2;
      else ep = 1;
    } else if (lvl === 4) ep = 2;
    addScore(state, ec, ep);
    const ewName = state.players?.[K(ec)]?.name || `J${ec}`;
    pushLog(state, `Envit rebutjat: guanya ${ewName} (+${ep}).`, { winnerSeat: ec });
    if (finish()) return;
  } else if (isFold && h.pendingOffer?.kind === "envit") {
    // ¡AQUÍ ESTÁ EL CAMBIO! Si alguien se va al mazo con un envite/falta pendiente de responder:
    const off = h.pendingOffer;
    let puntos = 1;
    if (off.level === "falta") {
      const ff = off.faltaFromLevel;
      if (ff === 4) puntos = 4;
      else if (ff === 2) puntos = 2;
      else puntos = 1;
    } else if (off.level === 4) puntos = 2;

    addScore(state, winnerSeat, puntos);
    pushLog(state, `Envit abandonat: +${puntos} per al rival.`);
    if (finish()) return;
  } else if (
    isFold &&
    h.envit.state === "none" &&
    (h.trickHistory || []).length === 0
  ) {
    // Timeout/fold en el primer turno sin ningún envit negociado:
    // el jugador pierde automáticamente el punto de envit
    addScore(state, winnerSeat, 1);
    const wName = state.players?.[K(winnerSeat)]?.name || `J${winnerSeat}`;
    pushLog(state, `Temps: +1 envit per a ${wName}.`);
    if (finish()) return;
  }

  // (Saltamos premios extra si alguien huye)
  for (const s of [0, 1]) {
    const pts = getSA(h, s);
    if (pts > 0) addScore(state, s, pts);
  }
  if (finish()) return;

  // --- 2. RESOLVER TRUC Y LA MANO ---
  if (h.truc.state === "accepted") {
    const tw = isFold ? winnerSeat : handWinner(state);
    if (state.lastHandSummary) state.lastHandSummary.winner = tw;
    const tp = Number(h.truc.acceptedLevel || 0);
    const twName = state.players?.[K(tw)]?.name || `J${tw}`;
    addScore(state, tw, tp);
    pushLog(
      state,
      isFold
        ? `Truc: guanya ${twName} per abandó (+${tp}).`
        : `Truc: guanya ${twName} (+${tp}).`,
    );
    if (finish()) return;
  } else {
    // Ningún truc aceptado, o se va al mazo cuando le acaban de cantar Truc/Retruc
    const hw = isFold ? winnerSeat : handWinner(state);
    if (hw !== null && hw !== undefined) {
      if (state.lastHandSummary) state.lastHandSummary.winner = hw;
      const hwName = state.players?.[K(hw)]?.name || `J${hw}`;
      // Si se va al mazo, pierde el nivel que ya estuviera asegurado (ej: 1 si es normal, 2 si ya había un truc aceptado de antes).
      const tp = isFold ? Number(h.truc.acceptedLevel || 0) || 1 : 1;
      addScore(state, hw, tp);
      pushLog(
        state,
        isFold
          ? `Mà guanyada per ${hwName} per abandó (+${tp}).`
          : `Mà guanyada per ${hwName} (+1).`,
      );
    }
    if (finish()) return;
  }

  if (reason) pushLog(state, reason);
  pushLog(state, `Marcador: ${getScore(state, 0)}-${getScore(state, 1)}`);
  state.mano = other(state.mano);
  state.turn = state.mano;
  state.status = "waiting";
  state.lastAllTricks = h.allTricks || [];
  state.hand = null;
  state.handNumber = Number(state.handNumber || 10) + 1;
}

export function resolveTrick(state) {
  const h = state.hand;
  const c0 = getPlayed(h, 0),
    c1 = getPlayed(h, 1);
  let w = null;
  if (c0 && c1) {
    const cmp = cmpTrick(c0, c1);
    w = cmp > 0 ? 0 : cmp < 0 ? 1 : null;
  }
  const idx = getTrickIndex(h);
  const lead = h.trickLead ?? state.mano;
  // Store draw as winner=99 (null would be deleted by Firebase)
  h.trickHistory = (h.trickHistory || []).concat([
    { i: idx + 1, c0, c1, winner: w === null ? 99 : w, lead },
  ]);
  if (w !== null) {
    addTW(h, w);
    h.turn = w;
    const wn = state.players?.[K(w)]?.name || `J${w}`;
    pushLog(state, `Baza ${idx + 1}: guanya ${wn}.`);
  } else {
    h.turn = lead;
    pushLog(state, `Baza ${idx + 1}: EMPAT.`); // EMPAT not undefined
  }
  h.trickLead = h.turn;
  h.trickIndex = Number(h.trickIndex || OFFSET) + 1;
  // Guardar la baza resuelta en el array de todas las bazas
  const newAllTricks = (h.allTricks || []).concat([
    { c0: c0 || EMPTY_CARD, c1: c1 || EMPTY_CARD, w: w === null ? 99 : w },
  ]);
  h.allTricks = newAllTricks;
  state.lastAllTricks = newAllTricks;
  // RESET played con EMPTY_CARD - nunca borramos el nodo
  resetPlayed(h);
  h.mode = "normal";
  // Envit SOLO permitido antes de jugar la 1a carta de la 1a baza
  h.envitAvailable = false;

  const w0 = getTW(h, 0),
    w1 = getTW(h, 1);
  const tIdx = getTrickIndex(h);

  // --- Comprobación de final de mano ---
  const hist = h.trickHistory || [];
  const b1 = hist[0]?.winner;
  const b2 = hist[1]?.winner;

  // Nueva lógica de handOver:
  // Se acaba si: alguien tiene 2 victorias, si ya hemos jugado las 3 bazas,
  // O si hay un ganador tras una parda (B1 parda y B2 decidida, o B1 decidida y B2 parda).
  const handOver =
    w0 >= 2 ||
    w1 >= 2 ||
    tIdx >= 3 ||
    (b1 === 99 && b2 !== 99 && b2 !== undefined) ||
    (b1 !== 99 && b2 === 99);

  if (handOver) {
    const hw = handWinner(state); // Aquí llamamos a la función de pardas que arreglamos antes
    const hwName = state.players?.[K(hw)]?.name || `Jugador ${hw}`;
    applyHandEnd(state, `Mà guanyada per ${hwName}.`);
  }
}
