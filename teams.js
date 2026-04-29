// --- teams.js — Helpers de seients i equips per a 1v1 i 2v2 ------------------
//
// Convencions:
//   • 1v1: seients [0,1]; equip 0={0}, equip 1={1}
//   • 2v2: seients [0,1,2,3]; equip 0={0,2}, equip 1={1,3}
//          Disposició horària: 0(A)-1(B)-2(A)-3(B)
//          Mà i torn roten en sentit ANTIHORARI: (s - 1 + N) % N
//
// Totes les funcions són pures (sense efectes secundaris).

const K = (n) => `_${n}`;

// ── Bàsics ────────────────────────────────────────────────────────────────────

/**
 * Nombre de seients de la partida.
 * @param {object} state
 * @returns {2|4}
 */
export function getNumSeats(state) {
  return state?.settings?.modoJuego === "2v2" ? 4 : 2;
}

/**
 * Índex d'equip d'un seient (0 o 1).
 * 1v1: seat 0 → 0, seat 1 → 1
 * 2v2: seat 0 → 0, seat 1 → 1, seat 2 → 0, seat 3 → 1
 */
export function teamOf(seat) {
  return seat % 2;
}

/**
 * Array de tots els seients vàlids [0..N-1].
 */
export function allSeats(state) {
  const n = getNumSeats(state);
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Mapa d'equips: { 0: [seats equip A], 1: [seats equip B] }
 * 1v1: { 0: [0], 1: [1] }
 * 2v2: { 0: [0,2], 1: [1,3] }
 */
export function teamSeatsMap(state) {
  const seats = allSeats(state);
  return {
    0: seats.filter((s) => teamOf(s) === 0),
    1: seats.filter((s) => teamOf(s) === 1),
  };
}

// ── Navegació antihorària ──────────────────────────────────────────────────────

/**
 * Seient anterior en sentit antihorari (el "proper" en el torn de joc).
 * 1v1: nextCCW(0)=1, nextCCW(1)=0  (idèntic a other())
 * 2v2: nextCCW(0)=3, nextCCW(3)=2, nextCCW(2)=1, nextCCW(1)=0
 */
export function nextCCW(state, seat) {
  const n = getNumSeats(state);
  return (seat - 1 + n) % n;
}

/**
 * Ordre de joc CCW per a una basa, partint del seient `from`.
 * 1v1 mano=0: [0, 1]
 * 2v2 mano=0: [0, 3, 2, 1]
 */
export function playOrder(from, state) {
  const n = getNumSeats(state);
  const order = [];
  let s = from;
  for (let i = 0; i < n; i++) {
    order.push(s);
    s = nextCCW(state, s);
  }
  return order;
}

// ── Rivals i companys ─────────────────────────────────────────────────────────

/**
 * Companys d'equip del seient `seat` (excloent-se a si mateix).
 * 1v1: sempre [] (no hi ha company)
 * 2v2: seat 0 → [2], seat 1 → [3], etc.
 */
export function teammates(seat, state) {
  return allSeats(state).filter(
    (s) => s !== seat && teamOf(s) === teamOf(seat),
  );
}

/**
 * Rivals del seient `seat`.
 * 1v1: seat 0 → [1], seat 1 → [0]  (idèntic a other())
 * 2v2: seat 0 → [1,3], seat 1 → [0,2], etc.
 */
export function opponents(seat, state) {
  return allSeats(state).filter((s) => teamOf(s) !== teamOf(seat));
}

/**
 * Primer rival en ordre CCW. En 1v1 és equivalent a other(seat).
 * Util com a substitut drop-in de `other()` en codi que ja funciona.
 */
export function firstOpponent(seat, state) {
  const opps = opponents(seat, state);
  return opps.length > 0 ? opps[0] : null;
}

// ── Mà i ofertes ──────────────────────────────────────────────────────────────

/**
 * Seient que rep la propera mà (mano) en sentit antihorari.
 * 1v1: nextMano(0)=1, nextMano(1)=0
 * 2v2: nextMano(0)=3, nextMano(3)=2, nextMano(2)=1, nextMano(1)=0
 */
export function nextMano(state, currentMano) {
  return nextCCW(state, currentMano);
}

/**
 * Donat un equip rival que ha de respondre una oferta, retorna el seient
 * concret que ha de respondre: el membre de l'equip rival més proper
 * al mano actual en sentit antihorari (el que serà mano aviat).
 *
 * Regla: recorrem l'ordre CCW des del mano i retornem el primer
 * seient que pertany a `respondingTeam`.
 *
 * 1v1 mano=0, respondingTeam=1: retorna 1
 * 2v2 mano=0, respondingTeam=1: retorna 3 (ordre CCW des de 0: [0,3,2,1])
 * 2v2 mano=1, respondingTeam=0: retorna 0 (ordre CCW des de 1: [1,0,3,2])
 */
export function responderSeat(state, respondingTeam) {
  const n = getNumSeats(state);
  const mano = state.mano ?? 0;
  for (let i = 0; i < n; i++) {
    const s = (mano - i + n) % n;
    if (teamOf(s) === respondingTeam) return s;
  }
  return null;
}

/**
 * Donat un equip que vol fer una oferta, retorna el seient concret
 * que pot ofertar (l'últim en parlar d'eixe equip en la ronda actual,
 * és a dir, el membre de l'equip MÉS LLUNY del mano en ordre CCW).
 *
 * Regla: el qui cant l'envit ha de ser el darrer del seu equip a parlar,
 * de manera que l'adversari haja vist totes les cartes possibles del seu equip.
 * Equival a buscar el membre de callerTeam MÉS TARD en l'ordre CCW.
 *
 * 1v1 mano=0, callerTeam=0: retorna 0 (únic membre)
 * 2v2 mano=0, callerTeam=0: ordre CCW [0,3,2,1]; membres equip 0: [0,2] → el darrer és 2
 * 2v2 mano=0, callerTeam=1: ordre CCW [0,3,2,1]; membres equip 1: [3,1] → el darrer és 1
 */
export function callerSeat(state, callerTeam) {
  const n = getNumSeats(state);
  const mano = state.mano ?? 0;
  let lastFound = null;
  for (let i = 0; i < n; i++) {
    const s = (mano - i + n) % n;
    if (teamOf(s) === callerTeam) lastFound = s;
  }
  return lastFound;
}

// ── Inicialització de slots ────────────────────────────────────────────────────

/**
 * Genera l'objecte `players` buit per a N seients.
 * @param {number} n - Nombre de seients (2 o 4)
 * @returns {{ _0: null, _1: null, ... }}
 */
export function emptyPlayers(n) {
  const o = {};
  for (let i = 0; i < n; i++) o[K(i)] = null;
  return o;
}

/**
 * Genera l'objecte `ready` buit per a N seients.
 */
export function emptyReady(n) {
  const o = {};
  for (let i = 0; i < n; i++) o[K(i)] = false;
  return o;
}

/**
 * Scores inicials per equip (sempre 2 equips, independentment de N seients).
 * @param {number} OFFSET - Valor d'offset de Firebase
 */
export function initialScores(OFFSET) {
  return { [K(0)]: OFFSET, [K(1)]: OFFSET };
}
