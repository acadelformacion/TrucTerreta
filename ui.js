// --- Truc Valencià . ui.js (interfaz + arranque) ----------------------------
// Firebase borra nodos vacios, null y false. Soluciones:
//   * Claves de asiento: "_0","_1" (no "0","1" -> array)
//   * Manos: objeto {a,b,c} con las cartas
//   * Cartas jugadas: guardadas en h.played como {p0:"carta",p1:"carta"}
//     El nodo NUNCA se borra; se resetea con un marcador "~" entre bazas.
//   * Contadores: almacenados +10 para que nunca sean 0.
import {
  db,
  auth,
  session,
  resetSession,
  ref,
  get,
  set,
  push,
  remove,
  onValue,
  runTransaction,
  onDisconnect,
  GoogleAuthProvider,
  signInWithCredential,
  signInAnonymously,
  signOut,
} from "./firebase.js";
import * as Logica from "./logica.js";
import {
  defaultState,
  configureActions,
  ui,
  dealHand,
  playCard,
  goMazo,
  startOffer,
  respondEnvit,
  respondTruc,
  timeoutTurn,
  requestRematch,
  claimWinByRivalAbsence,
  guestReady,
} from "./acciones.js";
import {
  loadConfig,
  setConfig,
  applyConfig,
  isSoundEnabled,
} from "./config.js";
let _actionInProgress = false;
let _authReady = false;
let _gsiBootDone = false;
const $ = (id) => document.getElementById(id);
// Sincronizar ui.locked con _actionInProgress para que se bloqueen juntos
Object.defineProperty(ui, "locked", {
  get() {
    return this._locked;
  },
  set(v) {
    this._locked = v;
    if (v) _actionInProgress = true;
    else _actionInProgress = false;
  },
});

// --- Key helpers --------------------------------------------------------------
const K = (n) => `_${n}`; // seat: 0->"_0"
const PK = (n) => `p${n}`; // played key: 0->"p0"
const HKEYS = ["a", "b", "c"];
const EMPTY_CARD = "~"; // marcador "no jugada" (valor no valido)

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

// played: {p0:"1_oros", p1:"~"} - "~" = no jugo, string de carta = si jugo
const getPlayed = (h, seat) => {
  const v = h?.played?.[PK(seat)];
  return v && v !== EMPTY_CARD ? v : null;
};
const alreadyPlayed = (h, seat) => getPlayed(h, seat) !== null;
const bothPlayed = (h) => alreadyPlayed(h, 0) && alreadyPlayed(h, 1);

const LS = { room: "truc_room", seat: "truc_seat", name: "truc_name" };
const ANON_NICK_STORAGE_PREFIX = "truc_anon_nick_";
const GUEST_LOBBY_AVATAR = "Media/Images/Others/avatar-convidat.webp";

/** Foto per a llista de sales / perfil de jugador a Firebase */
function lobbyPhotoForPlayer(p) {
  if (!p) return GUEST_LOBBY_AVATAR;
  if (p.photoURL) return p.photoURL;
  if (p.guest) return GUEST_LOBBY_AVATAR;
  return GUEST_LOBBY_AVATAR;
}

function authPlayerExtras() {
  const u = auth.currentUser;
  if (!u) return {};
  if (u.isAnonymous) return { guest: true };
  const o = {};
  if (u.photoURL) o.photoURL = u.photoURL;
  return o;
}

function roomListEstadoLabel(st) {
  if (!st) return "En preparació";
  const s0 = real(st.scores?.[K(0)] ?? OFFSET);
  const s1 = real(st.scores?.[K(1)] ?? OFFSET);
  const meta = Logica.getPuntosParaGanar(st);
  if (st.status === "game_over" || s0 >= meta || s1 >= meta) return "Finalitzada";
  if (st.status === "waiting" && real(st.handNumber ?? OFFSET) === 0)
    return "En preparació";
  return "En partida";
}

/** Configuració de sala llegida de Firebase (arrel `settings` o còpia a `state.settings`). */
function mergeRoomSettings(room) {
  const s = room?.settings || room?.state?.settings || {};
  const pts = Number(s.puntosParaGanar);
  const modo = s.modoJuego === "2v2" ? "2v2" : "1v1";
  let maxJ = Number(s.maxJugadores);
  if (!Number.isFinite(maxJ) || maxJ < 2) maxJ = modo === "2v2" ? 4 : 2;
  return {
    puntosParaGanar: pts === 24 ? 24 : 12,
    modoJuego: modo,
    maxJugadores: maxJ,
  };
}

const DEFAULT_ROOM_SETTINGS = () => ({
  puntosParaGanar: 12,
  modoJuego: "1v1",
  maxJugadores: 2,
});

/** Icones mini per a etiquetes de sala (pedra / jugador). */
const ICO_STONE =
  '<svg class="rl-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><ellipse cx="12" cy="14" rx="7" ry="5.5" fill="currentColor" opacity=".88"/></svg>';
const ICO_USER =
  '<svg class="rl-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4.42 0-8 1.79-8 4v2h16v-2c0-2.21-3.58-4-8-4z"/></svg>';

let _pendingCreateVisibility = "public";
let _pendingRoomSettings = DEFAULT_ROOM_SETTINGS();
const INACT_MS = 60 * 60 * 1000;
const TURN_SECS = 30;
const OFFSET = 10; // scores/trickWins stored +10

const SUITS = {
  oros: { label: "oros", cls: "s-oros" },
  copas: { label: "copas", cls: "s-copas" },
  espadas: { label: "espadas", cls: "s-espadas" },
  bastos: { label: "bastos", cls: "s-bastos" },
};

// --- Audio --------------------------------------------------------------------
let _ac = null;
const ac = () => {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  return _ac;
};
function tone(f, t, d, v, dl) {
  try {
    const c = ac(),
      ts = c.currentTime + (dl || 0);
    const o = c.createOscillator(),
      g = c.createGain();
    o.type = t || "sine";
    o.frequency.setValueAtTime(f, ts);
    g.gain.setValueAtTime(v || 0.15, ts);
    g.gain.exponentialRampToValueAtTime(0.001, ts + (d || 0.1));
    o.connect(g);
    g.connect(c.destination);
    o.start(ts);
    o.stop(ts + (d || 0.1));
  } catch (e) {}
}
const sndCard = () => {
  if (!isSoundEnabled()) return;
  tone(440, "triangle", 0.07, 0.14);
  tone(560, "triangle", 0.05, 0.09, 0.06);
};
const sndWin = () => {
  if (!isSoundEnabled()) return;
  [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.14, 0.17, i * 0.1));
};
const sndPoint = () => {
  if (!isSoundEnabled()) return;
  tone(330, "sine", 0.11, 0.13);
  tone(450, "sine", 0.09, 0.11, 0.1);
};
const sndTick = () => {
  if (!isSoundEnabled()) return;
  tone(880, "square", 0.04, 0.06);
};
const sndBtn = () => {
  if (!isSoundEnabled()) return;
  tone(600, "sine", 0.04, 0.08);
};
const sndLose = () => {
  if (!isSoundEnabled()) return;
  tone(200, "sawtooth", 0.3, 0.12);
  tone(150, "sawtooth", 0.4, 0.1, 0.25);
};

// --- Session ------------------------------------------------------------------
let unsubGame = null,
  unsubStateStatus = null,
  unsubChat = null;
let inactTimer = null,
  betweenTimer = null,
  /** Evita reiniciar l'overlay entre mans quan `betweenTimer` ja és null però encara no ha arribat `hand` després del compte enrere. */
  _betweenCountdownLatch = false,
  turnTimer = null,
  /** Arm del torn: cal cancel·lar-lo junt amb l'interval (si no, es pileguen intervals). */
  turnTimerArm = null;
let prevTurnKey = "",
  prevEnvSt = "none",
  prevTrucSt = "none";
let chatOpen = false,
  lastChatN = 0;
let _lastState = null; // ultimo estado conocido para uso en helpers de render
// Render tracking - avoid unnecessary DOM rebuilds that cause flash
let _prevHandsKey = ""; // tracks hand cards state
let _prevTrickKey = ""; // tracks trick cards state
let _prevHandKey = ""; // tracks which hand we're in
let _lastCompletedTricks = null; // snapshot of trick cards to show during countdown
const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sanitize = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
const normName = (s) =>
  String(s || "")
    .trim()
    .slice(0, 24) || "Convidat";
const other = (s) => (s === 0 ? 1 : 0);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const real = (n) => Number(n || OFFSET) - OFFSET; // decode stored value

function pName(st, seat) {
  return st?.players?.[K(seat)]?.name || `Jugador ${seat}`;
}
/** Els dos seients ocupats (no confondre amb state.ready de Firebase). */
function bothPlayersJoined(st) {
  return !!(st?.players?.[K(0)] && st?.players?.[K(1)]);
}
function getScore(st, seat) {
  return real(st?.scores?.[K(seat)]);
}
function pushLog(st, text) {
  st.logs = st.logs || [];
  st.logs.unshift({ text, at: Date.now() });
  st.logs = st.logs.slice(0, 30);
}

function loadLS() {
  const n = localStorage.getItem(LS.name),
    r = localStorage.getItem(LS.room),
    s = localStorage.getItem(LS.seat);
  const ni = $("nameInput"),
    ri = $("roomInput");
  if (n && ni) ni.value = n;
  if (r && ri) ri.value = r;
  if (s != null) session.mySeat = Number(s);
}
function saveLS(n, c, s) {
  localStorage.setItem(LS.name, n || "");
  localStorage.setItem(LS.room, c || "");
  localStorage.setItem(LS.seat, String(s));
}
function resetInactivity() {
  clearTimeout(inactTimer);
  inactTimer = setTimeout(async () => {
    if (session.roomRef)
      try {
        await remove(session.roomRef);
      } catch (e) {}
    localStorage.removeItem(LS.room);
    localStorage.removeItem(LS.seat);
    location.reload();
  }, INACT_MS);
}

/** Callback global per al SDK de Google (GSI); el token JWT va a Firebase Auth. */
export async function handleCredentialResponse(response) {
  clearAuthErr();
  try {
    const idToken = response?.credential;
    if (!idToken) return;
    const credential = GoogleAuthProvider.credential(idToken);
    await signInWithCredential(auth, credential);
  } catch (err) {
    console.error("Error login Google:", err);
    const code = err?.code || "";
    const hint =
      location.protocol === "file:"
        ? " Obre la pàgina amb un servidor local (http://localhost), Firebase Auth no funciona amb file://."
        : "";
    showAuthErr(
      `No s'ha pogut iniciar amb Google (${code || err?.message || "error"}).${hint}`,
    );
    setLobbyMsg("No s'ha pogut iniciar amb Google.", "err");
  }
}

function readGoogleClientId() {
  const onload = document.getElementById("g_id_onload");
  return (
    onload?.dataset?.client_id ||
    "922530958932-hb10br4fvf87suf41vkjrdbuijdv6oor.apps.googleusercontent.com"
  );
}

function initGoogleSignInButton() {
  if (_gsiBootDone) return true;
  const gsi = window.google?.accounts?.id;
  if (!gsi) return false;
  try {
    const clientId = readGoogleClientId();
    gsi.initialize({
      client_id: clientId,
      callback: handleCredentialResponse,
      auto_select: false,
    });
    const slot = document.getElementById("g_id_signin");
    if (slot) {
      slot.innerHTML = "";
      gsi.renderButton(slot, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
        width: 340,
        logo_alignment: "left",
      });
    }
    _gsiBootDone = true;
    return true;
  } catch (e) {
    console.error("initGoogleSignInButton:", e);
    return false;
  }
}

function scheduleGoogleSignInInit() {
  if (initGoogleSignInButton()) return;
  let tries = 0;
  const id = setInterval(() => {
    tries++;
    if (initGoogleSignInButton() || tries > 50) clearInterval(id);
  }, 100);
  window.addEventListener("load", () => {
    initGoogleSignInButton();
  });
}

function initAuthFlow() {
  if (_authReady) return;
  _authReady = true;

  window.handleCredentialResponse = handleCredentialResponse;
  scheduleGoogleSignInInit();
}

const WINS_LS_PREFIX = "truc_wins_";

function bumpStoredWinsIfWonGame() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const k = WINS_LS_PREFIX + uid;
  const n = Number(localStorage.getItem(k) || 0) + 1;
  localStorage.setItem(k, String(n));
  const el = $("user-wins-count");
  if (el) el.textContent = String(n);
}

/** Reconnexió després d’auth (cridat des de `game.js`). */
export async function tryReconnectFromLocalStorage() {
  const _sr = localStorage.getItem(LS.room);
  if (!_sr) return;
  const _code = sanitize(_sr);
  try {
    const snap = await get(ref(db, `rooms/${_code}`));
    if (snap.exists() && snap.val()?.state) {
      if (session.roomCode) return;
      session.roomCode = _code;
      if ($("roomInput")) $("roomInput").value = _code;
      const _ss = localStorage.getItem(LS.seat);
      if (_ss != null) session.mySeat = Number(_ss);
      startSession(_code);
    } else {
      localStorage.removeItem(LS.room);
      localStorage.removeItem(LS.seat);
    }
  } catch (e) {
    localStorage.removeItem(LS.room);
    localStorage.removeItem(LS.seat);
  }
}

// --- Timers -------------------------------------------------------------------
// -- Circular ring helpers -----------------------------------------------------
const RING_C = 2 * Math.PI * 25; // r=25 for avatar rings // circumference for r=15
function setRing(arcId, ringId, pct, phase) {
  const arc = $(arcId);
  if (!arc) return;
  const dash = RING_C * (Math.max(0, pct) / 100);
  arc.style.strokeDasharray = `${dash} ${RING_C}`;
  const color = pct > 60 ? "#2ea043" : pct > 30 ? "#e8ab2a" : "#da3633";
  arc.style.stroke = color;
}

function stopTurnTimer() {
  if (turnTimerArm != null) {
    clearTimeout(turnTimerArm);
    turnTimerArm = null;
  }
  clearInterval(turnTimer);
  turnTimer = null;
  const myWrap = $("myAvatarContainer");
  const rivWrap = $("rivalAvatarContainer");
  if (myWrap) myWrap.classList.remove("turn-active");
  if (rivWrap) rivWrap.classList.remove("turn-active");
  setRing("myTimerArc", "myTimerRing", 0, "my");
  setRing("rivalTimerArc", "rivalTimerRing", 0, "rival");
}
function startTurnTimer(isMyTurn, state) {
  stopTurnTimer();
  let rem = TURN_SECS;
  const myWrap = $("myAvatarContainer");
  const rivWrap = $("rivalAvatarContainer");
  if (isMyTurn) {
    if (myWrap) myWrap.classList.add("turn-active");
    if (rivWrap) rivWrap.classList.remove("turn-active");
    setRing("myTimerArc", "myTimerRing", 100, "my");
    setRing("rivalTimerArc", "rivalTimerRing", 0, "rival");
  } else {
    if (rivWrap) rivWrap.classList.add("turn-active");
    if (myWrap) myWrap.classList.remove("turn-active");
    setRing("myTimerArc", "myTimerRing", 0, "my");
    setRing("rivalTimerArc", "rivalTimerRing", 100, "rival");
  }
  turnTimerArm = setTimeout(() => {
    turnTimerArm = null;
    turnTimer = setInterval(() => {
      rem--;
      const pct = Math.max(0, (rem / TURN_SECS) * 100);
      if (isMyTurn) {
        setRing("myTimerArc", "myTimerRing", pct, "my");
      } else {
        setRing("rivalTimerArc", "rivalTimerRing", pct, "rival");
      }
      if (rem >= 1 && rem <= 5) sndTick();
      if (rem <= 0) {
        stopTurnTimer();
        if (isMyTurn) timeoutTurn();
      }
    }, 1000);
  }, 50);
}
function stopBetween() {
  if (betweenTimer != null) clearTimeout(betweenTimer);
  betweenTimer = null;
  $("countdownOverlay").classList.add("hidden");
}
function _showCountdownMsg(text) {
  let el = $("tableCdEl");
  if (!el) {
    el = document.createElement("div");
    el.id = "tableCdEl";
    el.className = "table-cd-msg";
    const cz = document.getElementById("centerZone");
    if (cz) cz.appendChild(el);
  }
  el.innerHTML = text;
  el.classList.remove("table-cd-anim");
  void el.offsetWidth;
  el.classList.add("table-cd-anim");
}
function startBetween(summaryHtml) {
  stopBetween();
  const ov = $("countdownOverlay"),
    lbl = $("countdownLabel");
  if (lbl && summaryHtml) {
    lbl.innerHTML = summaryHtml;
  }
  ov.classList.remove("hidden");
  let n = 5;
  let cdEl = $("tableCdEl");
  if (!cdEl) {
    cdEl = document.createElement("div");
    cdEl.id = "tableCdEl";
    cdEl.className = "table-cd-fixed";
    cdEl.setAttribute("aria-live", "assertive");
    const cz = document.getElementById("centerZone");
    if (cz) cz.appendChild(cdEl);
  }
  cdEl.classList.add("hidden");
  cdEl.innerHTML = "";
  function tick() {
    if (n < 0) {
      _betweenCountdownLatch = true;
      cdEl.classList.add("hidden");
      cdEl.innerHTML = "";
      stopBetween();
      if (session.mySeat === 0) {
        dealHand().catch(() => {});
      }
      return;
    }
    cdEl.classList.remove("hidden");
    cdEl.innerHTML = `<div class="cd-subtitle">Següent mà en…</div><div class="cd-number">${n}</div>`;
    if (n < 5) sndTick();
    n--;
    betweenTimer = setTimeout(tick, 1000);
  }
  betweenTimer = setTimeout(() => {
    tick();
  }, 3000); // 3s show summary first
}

function buildCard(card) {
  const { num, suit } = Logica.parseCard(card);
  // Imagen por carta: 1 de oros => "1o.jpg", 3 de copas => "3c.jpg", etc.
  const suitLetter =
    { oros: "o", copas: "c", espadas: "e", bastos: "b" }[suit] || "";
  const imgCode = `${num}${suitLetter}`;
  const el = document.createElement("div");
  el.className = `playing-card ${SUITS[suit]?.cls || ""} use-img`;
  const img = document.createElement("img");
  img.className = "card-art";
  img.alt = `${num}${suitLetter}`;
  img.draggable = false;
  img.src = `./Media/Images/Cards/${imgCode}.jpg`;
  el.appendChild(img);
  return el;
}
function buildBack() {
  const el = document.createElement("div");
  el.className = "card-back";
  return el;
}

// -- Show action label in center of table --------------------------------------
// --- Nueva función de mensajes con "Bocadillos" y sincronización ---
// Solo muestra la animación visual, sin escribir a Firebase
function showTableMsgLocal(text, isMine = true) {
  const bubble = document.createElement("div");
  bubble.className = `table-msg-bubble ${isMine ? "msg-mine" : "msg-rival"}`;
  bubble.textContent = text.toUpperCase() + "!";
  document.body.appendChild(bubble);
  setTimeout(() => {
    if (bubble) bubble.remove();
  }, 1800);
}

// Envía a Firebase Y muestra local — solo llamar desde botones propios
export function showTableMsg(text, isMine = true) {
  showTableMsgLocal(text, isMine);
  if (isMine && session.roomCode) {
    set(ref(db, `rooms/${session.roomCode}/msg`), {
      text,
      at: Date.now(),
      sender: session.mySeat,
    }).catch(() => {});
  }
}

function animatePlay(cardEl, card, onDone) {
  const slot = $("trickGrid");
  const fr = cardEl.getBoundingClientRect();
  const to = slot
    ? slot.getBoundingClientRect()
    : {
        left: window.innerWidth / 2,
        top: window.innerHeight / 2,
        width: 80,
        height: 114,
      };
  const fly = buildCard(card);
  fly.classList.add("card-flying");
  fly.style.cssText = `left:${fr.left}px;top:${fr.top}px;width:${fr.width}px;height:${fr.height}px;position:fixed;pointer-events:none;z-index:200;`;
  fly.style.setProperty(
    "--tx",
    to.left + to.width / 2 - fr.left - fr.width / 2 + "px",
  );
  fly.style.setProperty(
    "--ty",
    to.top + to.height / 2 - fr.top - fr.height / 2 + "px",
  );
  fly.style.setProperty("--rot", Math.random() * 10 - 5 + "deg");
  document.body.appendChild(fly);
  fly.addEventListener(
    "animationend",
    () => {
      fly.remove();
      if (onDone) onDone();
    },
    { once: true },
  );
}

// --- Render -------------------------------------------------------------------

// --- Score summary for between-hands overlay ---------------------------------
function buildScoreSummary(state) {
  const logs = state.logs || [];
  const p0 = pName(state, 0),
    p1 = pName(state, 1);
  // Find logs from this hand: stop at the SECOND "Marcador:" entry
  let marcCount = 0;
  const handLogs = [];
  for (const l of logs) {
    if (l.text?.startsWith("Marcador:")) {
      marcCount++;
      if (marcCount >= 2) break;
    }
    handLogs.push(l);
  }
  handLogs.reverse(); // oldest first

  let pts0 = 0,
    pts1 = 0;
  const rows = [];
  for (const l of handLogs) {
    const txt = l.text || "";
    // Match (+N) with or without parens, or just +N before space/end
    const m = txt.match(/\(\+(\d+)\)/) || txt.match(/\+(\d+)(?=[^\d]|$)/);
    if (!m) continue;
    const pts = Number(m[1]);
    let label = "",
      winner = "";
    // Determine winner: check name match OR J0/J1 pattern OR +N for p0/p1
    const hasP0name = p0.length > 1 && txt.includes(p0);
    const hasP1name = p1.length > 1 && txt.includes(p1);
    const hasJ0 = txt.match(/\bJ0\b/);
    const hasJ1 = txt.match(/\bJ1\b/);
    // If both names appear (eg "Pepe +1 per Manolo"), pick the one after "per" or "per"
    const guessWinner = () => {
      if (hasP0name && !hasP1name) return p0;
      if (hasP1name && !hasP0name) return p1;
      if (hasJ0 && !hasJ1) return p0;
      if (hasJ1 && !hasJ0) return p1;
      return p0; // fallback
    };
    // Detect event type from log text
    if (
      txt.includes("Envit") &&
      (txt.includes("guanya") || txt.includes("acceptat"))
    ) {
      winner = guessWinner();
      label = `Envit guanyat per <b>${winner}</b>`;
    } else if (txt.includes("Envit") && txt.includes("rebutjat")) {
      winner = guessWinner();
      label = `No vull l'envit - +1 per <b>${winner}</b>`;
    } else if (
      (txt.includes("Truc") ||
        txt.includes("truc") ||
        txt.includes("Retruque") ||
        txt.includes("Val 4")) &&
      (txt.includes("guanya") || txt.includes("acceptat"))
    ) {
      winner = guessWinner();
      label = `Truc guanyat per <b>${winner}</b>`;
    } else if (
      (txt.includes("Truc") || txt.includes("truc")) &&
      txt.includes("rebutjat")
    ) {
      winner = guessWinner();
      label = `No vull el truc - +1 per <b>${winner}</b>`;
    } else if (txt.includes("Ma guanyada") || txt.includes("guanyada")) {
      winner = guessWinner();
      label = `Ma guanyada per <b>${winner}</b>`;
    } else if (txt.includes("mazo") || txt.includes("Mazo")) {
      winner = guessWinner();
      label = `Al mazo - punt per <b>${winner}</b>`;
    } else if (txt.includes("rebutjat")) {
      winner = guessWinner();
      label = `Rebutjat - punt per <b>${winner}</b>`;
    } else {
      continue;
    }
    if (winner === p0) pts0 += pts;
    else pts1 += pts;
    rows.push(
      `<div class="sum-row"><span class="sum-label">${label}</span><span class="sum-pts">+${pts}</span></div>`,
    );
  }

  let html = '<div class="summary-events">';
  if (rows.length) {
    html += rows.join("");
  } else {
    html +=
      '<div style="color:var(--muted);font-size:12px">Cap punt especial</div>';
  }
  html += `</div><div class="sum-result">${p0} <span class="sum-score">${pts0}</span> - <span class="sum-score">${pts1}</span> ${p1}</div>`;
  return html;
}

function renderRivalCards(handObj) {
  const z = $("rivalCards");
  if (!z) return;
  z.replaceChildren();
  const cards = fromHObj(handObj);
  const n = cards.length;
  // Mostrar siempre el numero real de cartas restantes del rival (boca abajo)
  // Empieza con 3, baja a 2, luego 1 conforme juega
  z.setAttribute("data-count", String(n));
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    s.className = "rival-card-slot";
    // Separacion en abanico: la del medio centrada, las laterales inclinadas
    const angles = n === 3 ? [-8, 0, 8] : n === 2 ? [-5, 5] : [0];
    const xoffs = n === 3 ? [-44, 0, 44] : n === 2 ? [-24, 24] : [0];
    s.style.cssText = `transform:translateX(${xoffs[i] || 0}px) rotate(${angles[i] || 0}deg);z-index:${i + 1};`;
    s.appendChild(buildBack());
    z.appendChild(s);
  }
}

function renderMyCards(state) {
  const h = state.hand,
    z = $("myCards");
  if (!z) return;
  if (!h) {
    z.replaceChildren();
    return;
  }
  const myCards = fromHObj(h.hands?.[K(session.mySeat)]);
  const played = alreadyPlayed(h, session.mySeat);
  // Block play if hand should already be over (b1 draw + b2 winner)
  const _ch = h.trickHistory || [];
  const _handDecided =
    (_ch.length >= 1 &&
      _ch[0].winner === null &&
      _ch.length >= 2 &&
      _ch[1].winner !== null) ||
    (_ch.length >= 1 &&
      _ch[0].winner !== null &&
      _ch.length >= 2 &&
      _ch[1].winner === null);
  const canPlay =
    !played &&
    !ui.locked &&
    h.turn === session.mySeat &&
    h.mode === "normal" &&
    !h.pendingOffer &&
    state.status === "playing" &&
    h.status === "in_progress" &&
    !_handDecided;
  // Skip full rebuild if hand cards haven't changed (prevents flash)
  const handsKey = myCards.join(",") + "|" + canPlay;
  if (handsKey === _prevHandsKey && z.children.length === myCards.length)
    return;
  _prevHandsKey = handsKey;
  z.replaceChildren();

  myCards.forEach((card) => {
    const wrap = document.createElement("div");
    wrap.className = "my-card-wrap";
    const cel = buildCard(card);
    wrap.appendChild(cel);
    if (canPlay) {
      wrap.classList.add("playable");
      wrap.addEventListener(
        "click",
        () => {
          if (ui.locked || !wrap.classList.contains("playable")) return;
          z.querySelectorAll(".my-card-wrap").forEach((w) =>
            w.classList.remove("playable"),
          );
          sndCard();
          animatePlay(cel, card, () => playCard(card));
        },
        { once: true },
      );
    }
    z.appendChild(wrap);
  });
}
function _renderTrickGrid(allTricks, curP0, curP1) {
  const grid = $("trickGrid");
  if (!grid) return;
  grid.replaceChildren();

  const me = session.mySeat,
    rival = other(session.mySeat);
  const hasCurrent = curP0 || curP1;
  if (allTricks.length === 0 && !hasCurrent) return;

  allTricks.forEach((t) => {
    const col = document.createElement("div");
    col.className = "trick-col";
    const isDraw = t.w === 99 || t.w === null || t.w === undefined;
    if (isDraw) col.classList.add("trick-draw");

    const cellRival = document.createElement("div");
    cellRival.className = "trick-cell-rival";
    const cardRivalCode = rival === 0 ? t.c0 : t.c1;
    if (cardRivalCode && cardRivalCode !== EMPTY_CARD) {
      const el = buildCard(cardRivalCode);
      if (!isDraw && t.w === rival) el.classList.add("trick-winner");
      cellRival.appendChild(el);
    }

    const sep = document.createElement("div");
    sep.className = "trick-row-sep";

    const cellMine = document.createElement("div");
    cellMine.className = "trick-cell-mine";
    const cardMineCode = me === 0 ? t.c0 : t.c1;
    if (cardMineCode && cardMineCode !== EMPTY_CARD) {
      const el = buildCard(cardMineCode);
      if (!isDraw && t.w === me) el.classList.add("trick-winner");
      cellMine.appendChild(el);
    }

    col.appendChild(cellRival);
    col.appendChild(sep);
    col.appendChild(cellMine);
    grid.appendChild(col);
  });

  if (hasCurrent) {
    const col = document.createElement("div");
    col.className = "trick-col";

    const cellRival = document.createElement("div");
    cellRival.className = "trick-cell-rival";
    const rivalCard = rival === 0 ? curP0 : curP1;
    if (rivalCard) {
      const el = buildCard(rivalCard);
      el.classList.add("land-anim");
      cellRival.appendChild(el);
    }

    const sep = document.createElement("div");
    sep.className = "trick-row-sep";

    const cellMine = document.createElement("div");
    cellMine.className = "trick-cell-mine";
    const myCard = me === 0 ? curP0 : curP1;
    if (myCard) {
      const el = buildCard(myCard);
      el.classList.add("land-anim");
      cellMine.appendChild(el);
    }

    col.appendChild(cellRival);
    col.appendChild(sep);
    col.appendChild(cellMine);
    grid.appendChild(col);
  }
}

function renderTrickSnapshot(snapshot) {
  const key = "snap|" + snapshot.key;
  if (key === _prevTrickKey) return;
  _prevTrickKey = key;
  _renderTrickGrid(snapshot.allTricks, null, null);
}

function renderTrick(state) {
  const h = state.hand;
  const info = $("centerInfo");

  if (!h) {
    if (
      _lastCompletedTricks &&
      (betweenTimer != null || _betweenCountdownLatch)
    ) {
      return;
    }
    const grid = $("trickGrid");
    if (grid) grid.replaceChildren();
    if (info) info.replaceChildren();
    return;
  }
  const allT = h.allTricks || [];
  const p0 = getPlayed(h, 0),
    p1 = getPlayed(h, 1);
  const trickKey = allT.length + "|" + (p0 || "-") + "|" + (p1 || "-");

  if (trickKey !== _prevTrickKey) {
    _prevTrickKey = trickKey;
    _renderTrickGrid(allT, p0, p1);
  }

  // Historial de bazas: replaceChildren agrupa lectura/escriptura i evita buidar amb innerHTML.
  if (info) {
    const hist = h.trickHistory || [];
    if (hist.length) {
      const dots = document.createElement("div");
      dots.className = "trick-history-dots";
      hist.forEach((t) => {
        const d = document.createElement("div");
        d.className = "trick-dot";
        if (t.winner === 99 || t.winner === null) d.classList.add("draw");
        else if (t.winner === session.mySeat) d.classList.add("won");
        else d.classList.add("lost");
        dots.appendChild(d);
      });
      info.replaceChildren(dots);
    } else {
      info.replaceChildren();
    }
  }
}
function renderActions(state) {
  if (_actionInProgress) {
    ["envitBtn", "faltaBtn", "trucBtn", "mazoBtn"].forEach((id) => {
      const b = $(id);
      if (b) b.classList.add("hidden");
    });
    const ra = $("responseArea");
    if (ra) {
      ra.innerHTML = "";
      ra.classList.add("hidden");
    }
    const om = $("offerMsg");
    if (om) om.classList.add("hidden");
    return;
  }
  const h = state.hand;
  const ra = $("responseArea"),
    om = $("offerMsg");

  // 1. Limpieza inicial
  if (ra) {
    ra.innerHTML = "";
    ra.classList.add("hidden");
  }
  if (om) {
    om.classList.add("hidden");
  }

  const playing = state.status === "playing" && h?.status === "in_progress";
  if (!playing) {
    ["envitBtn", "faltaBtn", "trucBtn", "mazoBtn"].forEach((id) => {
      const b = $(id);
      if (b) b.classList.add("hidden");
    });
    $("statusMsg").textContent =
      state.status === "waiting" ? "Esperant..." : "Partida acabada";
    $("actionPanel").style.display = "none";
    return;
  }

  $("actionPanel").style.display = "";
  const myT = h.turn === session.mySeat,
    norm = h.mode === "normal",
    envDone = h.envit.state !== "none";
  const played = alreadyPlayed(h, session.mySeat);
  // `tricksDone` cal al bloc de missatges d'estat; abans només existia dins `else if (myT && norm)` i podia causar ReferenceError en mòduls estrictes.
  const tricksDone = (h.trickHistory || []).length;

  const noTricksPlayed = (h.trickHistory || []).length === 0;
  const iHaventPlayed = !alreadyPlayed(h, session.mySeat);
  const noTrucAtAll =
    h.truc.state === "none" && !(h.pendingOffer?.kind === "truc");

  const envitAvailNow =
    h.envitAvailable &&
    noTricksPlayed &&
    iHaventPlayed &&
    !envDone &&
    noTrucAtAll;
  const canEnvitInTruc =
    h.envitAvailable &&
    noTricksPlayed &&
    iHaventPlayed &&
    !envDone &&
    h.mode === "respond_truc";
  const envitOk = envitAvailNow || canEnvitInTruc;

  const nadieHaJugado = !alreadyPlayed(h, 0) && !alreadyPlayed(h, 1);
  const sinApuestasPrevias =
    h.envit.state === "none" && h.truc.state === "none";
  const bloqueoInicio = noTricksPlayed && nadieHaJugado && sinApuestasPrevias;

  // 2. Ocultar todos los botones fijos primero
  ["envitBtn", "faltaBtn", "trucBtn", "mazoBtn"].forEach((id) => {
    const b = $(id);
    if (b) b.classList.add("hidden");
  });

  // Helper para añadir botones dinámicos (Vull, No vull, etc.)
  const add = (l, cls, fn) => {
    const b = document.createElement("button");
    b.textContent = l;
    b.className = `abtn ${cls} action-btn`;
    b.addEventListener("click", async () => {
      if (_actionInProgress) return; // ← bloquea dobles clicks
      _actionInProgress = true;
      sndBtn();
      showTableMsg(l);
      try {
        await fn();
      } finally {
        setTimeout(() => {
          _actionInProgress = false;
          get(session.roomRef)
            .then((snap) => {
              if (snap?.val()) renderAll(snap.val());
            })
            .catch(() => {});
        }, 1500);
      }
    });
    ra.appendChild(b);
  };

  // 3. LÓGICA DE BOTONES DINÁMICOS
  if (h.pendingOffer && h.turn === session.mySeat) {
    // CASO A: Me han cantado algo (Responder)
    om.textContent =
      h.pendingOffer.kind === "envit"
        ? h.pendingOffer.level === "falta"
          ? "Envit de falta"
          : h.pendingOffer.level === 4
            ? "Torne (4)"
            : "Envit"
        : h.pendingOffer.level === 3
          ? "Retruque"
          : h.pendingOffer.level === 4
            ? "Val 4"
            : "Truc";

    om.classList.remove("hidden");
    ra.classList.remove("hidden");
    if (h.pendingOffer.kind === "envit") {
      add("Vull", "abtn-green", () => respondEnvit("vull"));
      add("No vull", "abtn-red", () => respondEnvit("no_vull"));

      const lvl = h.pendingOffer.level;
      if (lvl === 2) {
        add("Torne", "abtn-gold", () => respondEnvit("torne"));
        add("Falta", "abtn-gold", () => respondEnvit("falta"));
      } else if (lvl === 4) {
        add("Falta", "abtn-gold", () => respondEnvit("falta"));
      }
      // lvl === 'falta' → solo Vull/No vull, nada más
    } else {
      if (envitOk) {
        add("Envidar", "abtn-green", () => startOffer("envit"));
        add("Falta", "abtn-gold", () => startOffer("falta"));
      }
      add("Vull", "abtn-green", () => respondTruc("vull"));
      add("No vull", "abtn-red", () => respondTruc("no_vull"));
      if (h.pendingOffer.level === 2)
        add("Retruque", "abtn-gold", () => respondTruc("retruque"));
      if (h.pendingOffer.level === 3)
        add("Val 4", "abtn-gold", () => respondTruc("val4"));
    }
  } else if (myT && norm) {
    // Jugada consecutiva obligatoria: gané la baza anterior y debo liderar la siguiente
    // En este caso no se permite ninguna acción, solo tirar carta
    const lastTrick = tricksDone > 0 ? h.trickHistory[tricksDone - 1] : null;
    const winnerWasResponder =
      lastTrick &&
      lastTrick.winner !== 99 &&
      lastTrick.winner !== lastTrick.lead;
    const isConsecutivePlay =
      tricksDone > 0 &&
      h.trickLead === session.mySeat &&
      !played &&
      winnerWasResponder;

    if (!isConsecutivePlay) {
      // CASO B normal: Es mi turno normal (Cantar)
      if (envitOk) {
        if ($("envitBtn")) $("envitBtn").classList.remove("hidden");
        if ($("faltaBtn")) $("faltaBtn").classList.remove("hidden");
      }
      if (!played) {
        const trucNone = h.truc.state === "none";
        const iAccepted =
          h.truc.state === "accepted" && h.truc.acceptedBy === session.mySeat;
        const canEscalate = iAccepted && Number(h.truc.acceptedLevel || 0) < 4;
        if (trucNone || canEscalate) {
          const tb = $("trucBtn");
          if (tb) {
            tb.textContent = canEscalate
              ? Number(h.truc.acceptedLevel || 0) === 2
                ? "Retrucar"
                : "Val 4"
              : "Trucar";
            tb.classList.remove("hidden");
          }
        }
        if (!bloqueoInicio && $("mazoBtn"))
          $("mazoBtn").classList.remove("hidden");
      }
    }
  }

  // 4. MENSAJES DE ESTADO (TURNOS) - ¡Esto es lo que faltaba dentro!
  const sm = $("statusMsg");
  if (sm) {
    sm.classList.remove("my-turn");
    if (played && !bothPlayed(h)) {
      sm.textContent = `Esperant a ${pName(state, other(session.mySeat))}...`;
    } else if (h.pendingOffer && h.turn !== session.mySeat) {
      sm.textContent = `Esperant a ${pName(state, h.turn)}...`;
    } else if (!myT && !played) {
      sm.textContent = `Torn de ${pName(state, h.turn)}`;
    } else if (!played && norm && !h.pendingOffer) {
      const lastTrick = tricksDone > 0 ? h.trickHistory[tricksDone - 1] : null;
      const winnerWasResponder =
        lastTrick &&
        lastTrick.winner !== 99 &&
        lastTrick.winner !== lastTrick.lead;
      const isConsecutivePlay =
        tricksDone > 0 && h.trickLead === session.mySeat && winnerWasResponder;
      sm.textContent = isConsecutivePlay
        ? "Tira la teua carta"
        : "El teu torn, tria carta o acció";
      sm.classList.add("my-turn");
    } else {
      sm.textContent = "";
    }
  }
}

function updateRivalTimer(state) {
  const h = state.hand;
  const my = $("myZone"),
    riv = $("rivalZone");
  const playing = h && state.status === "playing" && h.status === "in_progress";
  const myActive =
    playing && h.turn === session.mySeat && !alreadyPlayed(h, session.mySeat);
  const rivActive =
    playing &&
    h.turn === other(session.mySeat) &&
    !alreadyPlayed(h, other(session.mySeat));
  if (my) {
    my.classList.toggle("turn-active", !!myActive);
  }
  if (riv) {
    riv.classList.toggle("turn-active", !!rivActive);
  }
}

// Iniciamos en 'null' para saber cuándo es la primera carga de la partida
let _oldHUD = { 0: null, 1: null };

async function animateHUDPoints(id, targetValue, hudIdx) {
  const el = $(id);
  if (!el) return;

  // 1. Si es la primera vez que se carga la pantalla, pintamos sin animar
  if (_oldHUD[hudIdx] === null) {
    el.textContent = targetValue;
    _oldHUD[hudIdx] = targetValue;
    return;
  }

  let current = _oldHUD[hudIdx];

  // 2. Si los puntos son menores (nueva partida) o iguales, pintamos directo
  if (targetValue <= current) {
    el.textContent = targetValue;
    _oldHUD[hudIdx] = targetValue;
    return;
  }

  // 3. Seguro antibloqueos (por si Firebase manda la actualización dos veces seguidas)
  if (el.dataset.animating === "true") return;
  el.dataset.animating = "true";

  // 4. Subimos de uno en uno
  while (current < targetValue) {
    current++;
    _oldHUD[hudIdx] = current; // Guardamos el progreso

    // Pausa dramática de medio segundo
    await new Promise((r) => setTimeout(r, 500));

    el.textContent = current;

    // Disparamos el destello CSS
    el.classList.remove("score-animate");
    void el.offsetWidth; // Truquito para reiniciar animaciones CSS
    el.classList.add("score-animate");
  }

  // Liberamos el seguro al terminar
  el.dataset.animating = "false";
  sndPoint();
}

function renderHUD(state) {
  const hideCode = session.roomVisibility === "public";
  $("hudRoom").textContent = hideCode
    ? "Sala pública"
    : `Sala ${session.roomCode || "-"}`;
  $("hudSeat").textContent = pName(state, session.mySeat);

  const sMy = getScore(state, session.mySeat);
  const sRiv = getScore(state, other(session.mySeat));

  // Ahora siempre llamamos a la animación, ella sola decide si tiene que saltar o no
  animateHUDPoints("hudScore0", sMy, 0);
  animateHUDPoints("hudScore1", sRiv, 1);

  $("hudState").textContent =
    state.status === "waiting"
      ? "Esperant"
      : state.status === "playing"
        ? "En joc"
        : "Acabada";

  const turnPlayer = state.hand
    ? pName(state, state.hand.turn)
    : pName(state, state.mano);
  $("siMano").textContent = turnPlayer;
  $("siHand").textContent = String(real(state.handNumber || OFFSET));
  // Controla que el panel inferior solo se fije en pantalla durante la partida
  if ($("actionPanel")) {
    $("actionPanel").classList.toggle(
      "playing-mode",
      state.status === "playing",
    );
  }
}

function renderLog(state) {
  const a = $("logArea");
  if (!a) return;
  const p0 = pName(state, 0),
    p1 = pName(state, 1);
  const frag = document.createDocumentFragment();
  (state.logs || []).slice(0, 15).forEach((item) => {
    const d = document.createElement("div");
    d.className = "log-entry";
    let txt = (item.text || "").replace(/\bJ0\b/g, p0).replace(/\bJ1\b/g, p1);
    d.textContent = txt;
    frag.appendChild(d);
  });
  // Una sola mutació al contenidor: menys reflows que buidar amb innerHTML i afegir en bucle.
  a.replaceChildren(frag);
}

function detectSounds(state) {
  const h = state.hand;
  if (!h) return;
  if (h.envit.state === "accepted" && prevEnvSt !== "accepted") sndPoint();
  if (h.truc.state === "accepted" && prevTrucSt !== "accepted") sndPoint();
  prevEnvSt = h.envit.state || "none";
  prevTrucSt = h.truc.state || "none";
}

// --- Presence / disconnect ----------------------------------------------------
let _absenceClaimTimer = null;
let _absenceTickTimer = null;
let _absenceDeadline = 0;
/** Evita cridar `claimWinByRivalAbsence` en bucle mentre la transacció encara va. */
let _claimMissingRivalPending = false;

function clearAbsenceTimers() {
  if (_absenceClaimTimer) {
    clearTimeout(_absenceClaimTimer);
    _absenceClaimTimer = null;
  }
  if (_absenceTickTimer) {
    clearInterval(_absenceTickTimer);
    _absenceTickTimer = null;
  }
  _absenceDeadline = 0;
}

function isActiveMatchState(st) {
  if (!st || st.status === "game_over") return false;
  return !(st.status === "waiting" && real(st.handNumber || OFFSET) === 0);
}

function tickAbsenceCountdown() {
  const el = $("absenceCountdown");
  if (!el || !_absenceDeadline) return;
  const sec = Math.max(0, Math.ceil((_absenceDeadline - Date.now()) / 1000));
  el.textContent = String(sec);
}

/** Evita programar diversos timeouts d’overlay / comptar victòries duplicades. */
let _gameOverAnimScheduledFor = "";
function checkPresence(state) {
  if (!session.roomCode || session.mySeat === null) {
    clearAbsenceTimers();
    $("absenceBar")?.classList.add("hidden");
    return;
  }
  if (!isActiveMatchState(state)) {
    clearAbsenceTimers();
    $("absenceBar")?.classList.add("hidden");
    return;
  }
  get(ref(db, `rooms/${session.roomCode}/presence/${K(other(session.mySeat))}`))
    .then((snap) => {
      if (!session.roomCode || session.mySeat === null) return;
      if (!isActiveMatchState(_lastState) || _lastState.status === "game_over") {
        clearAbsenceTimers();
        $("absenceBar")?.classList.add("hidden");
        return;
      }
      const p = snap.val();
      const absent = p?.absent === true;
      const bar = $("absenceBar");
      if (!bar) return;

      if (!absent) {
        clearAbsenceTimers();
        bar.classList.add("hidden");
        return;
      }

      bar.classList.remove("hidden");
      if (!_absenceClaimTimer) {
        _absenceDeadline = Date.now() + 60000;
        tickAbsenceCountdown();
        _absenceTickTimer = setInterval(tickAbsenceCountdown, 250);
        _absenceClaimTimer = setTimeout(async () => {
          clearAbsenceTimers();
          await claimWinByRivalAbsence();
        }, 60000);
      } else {
        tickAbsenceCountdown();
      }
    })
    .catch(() => {});
}

// --- MAIN RENDER --------------------------------------------------------------
function renderAll(room) {
  const state = room?.state || defaultState();
  session.roomVisibility =
    room?.meta?.visibility === "private"
      ? "private"
      : room?.meta?.visibility === "public"
        ? "public"
        : null;
  // Fora del lobby pre-partida: amagar l'overlay ja, per si més endavant falla algun sub-render
  const preGameLobby =
    state.status === "waiting" && real(state.handNumber || OFFSET) === 0;
  if (!preGameLobby) $("waitingOverlay")?.classList.add("hidden");

  // Garantizar pantalla correcta siempre que estemos en sesión activa
  if (session.roomCode) {
    $("screenLobby").classList.add("hidden");
    $("screenGame").classList.remove("hidden");
  }
  resetInactivity();
  detectSounds(state);
  _lastState = state;
  if (state.status === "playing" && state.hand) {
    _betweenCountdownLatch = false;
    $("tableCdEl")?.classList.add("hidden");
  }
  checkPresence(state);
  // Rival fora de `players` (Eixir): tancar partida sense esperar els 60s de presència
  if (
    session.mySeat !== null &&
    session.roomCode &&
    isActiveMatchState(state) &&
    state.status !== "game_over" &&
    !state.players?.[K(other(session.mySeat))]
  ) {
    if (!_claimMissingRivalPending) {
      _claimMissingRivalPending = true;
      claimWinByRivalAbsence().finally(() => {
        _claimMissingRivalPending = false;
      });
    }
  }
  renderAvatars(room);
  if (state.status === "waiting" && real(state.handNumber || OFFSET) === 0) {
    renderWaitingSlots(room, state);
  }
  // Reset render cache when hand changes so new cards animate in properly
  const hKey =
    real(state.handNumber || OFFSET) + "-" + (state.hand?.mano ?? "x");
  if (hKey !== (_prevHandKey || "")) {
    _prevHandsKey = "";
    _prevTrickKey = "";
    _prevHandKey = hKey;
  }
  renderHUD(state);
  $("myName").textContent = pName(state, session.mySeat);
  $("rivalName").textContent = pName(state, other(session.mySeat));
  // Sync avatar selection UI (índice = data-av, coherente con AVATAR_IMAGES)
  document.querySelectorAll(".av-opt").forEach((el) => {
    const i = Number(el.dataset.av);
    if (Number.isFinite(i))
      el.classList.toggle("av-selected", i === myAvatar);
  });
  renderRivalCards(state.hand?.hands?.[K(other(session.mySeat))]);
  updateRivalTimer(state);
  renderMyCards(state);
  // Save snapshot whenever hand is active
  if (state.hand) {
    _lastCompletedTricks = {
      allTricks: state.hand.allTricks || [],
      key:
        real(state.handNumber || OFFSET) +
        "-" +
        Logica.getTrickIndex(state.hand),
    };
  }
  // Use state.lastAllTricks (includes the final trick even after hand=null)
  if (state.lastAllTricks && state.lastAllTricks.length > 0) {
    const lk = "lat-" + state.lastAllTricks.length + "-" + state.handNumber;
    if (_lastCompletedTricks?.key !== lk) {
      _lastCompletedTricks = { allTricks: state.lastAllTricks, key: lk };
      _prevTrickKey = "";
    }
  }
  // Show snapshot when hand is null (between hands or game_over)
  if (!state.hand && _lastCompletedTricks) {
    renderTrickSnapshot(_lastCompletedTricks);
  } else {
    renderTrick(state);
  }
  renderActions(state);
  renderLog(state);
  const bothJoined = bothPlayersJoined(state);

  if (state.status === "game_over") {
    _betweenCountdownLatch = false;
    stopBetween();
    stopTurnTimer();
    $("waitingOverlay").classList.add("hidden");
    const wasHidden = $("gameOverOverlay").classList.contains("hidden");
    const animKey = `${session.roomCode}|${state.winner}|${getScore(state, session.mySeat)}-${getScore(state, other(session.mySeat))}|${state.logs?.[0]?.at ?? ""}|${state.gameEndReason || ""}`;
    if (wasHidden && animKey !== _gameOverAnimScheduledFor) {
      _gameOverAnimScheduledFor = animKey;
      const iWon = state.winner === session.mySeat;
      setTimeout(() => {
        $("gameOverOverlay").classList.remove("hidden");
        $("goTitle").textContent = iWon ? "🏆 Has guanyat!" : "😅 Has perdut";
        $("goWinner").textContent = pName(state, state.winner) + " guanya";
        const abandonment = state.gameEndReason === "abandonment";
        $("goScore").textContent =
          abandonment && iWon
            ? "Has guanyat per abandonament!"
            : abandonment && !iWon
              ? "Has perdut per abandonament (temps de reconnexió esgotat)."
              : `${getScore(state, session.mySeat)} - ${getScore(state, other(session.mySeat))}`;
        if (iWon) {
          sndWin();
          startConfetti(true);
          bumpStoredWinsIfWonGame();
        } else {
          sndLose();
          startConfetti(false);
        }
      }, 3000);
    }
    renderRematchStatus(state);
    // Don't return early - let renderTrick show the last cards
  } else {
    // Si ya no es game_over (revancha), ocultar overlay
    if (!$("gameOverOverlay").classList.contains("hidden")) {
      $("gameOverOverlay").classList.add("hidden");
      stopConfetti();
    }
    _gameOverAnimScheduledFor = "";
  } // end else
  if (state.status === "waiting") {
    stopTurnTimer();
    if (real(state.handNumber || OFFSET) === 0) {
      _betweenCountdownLatch = false;
      stopBetween();
      $("waitingCode").textContent = session.roomCode || "-";
      $("waitingCodeRow")?.classList.toggle(
        "hidden",
        session.roomVisibility === "public",
      );

      const p0ready = !!state.ready?.[K(0)];
      const p1ready = !!state.ready?.[K(1)];
      const myReady = session.mySeat === 0 ? p0ready : p1ready;
      const bothFirebaseReady = p0ready && p1ready;

      if (!bothJoined) {
        $("waitingStatus").innerHTML =
          'Esperant el segon jugador<span class="dots"></span>';
      } else if (!bothFirebaseReady) {
        $("waitingStatus").innerHTML =
          'Cal que els dos confirmeu «preparat»<span class="dots"></span>';
      } else {
        $("waitingStatus").textContent =
          session.mySeat === 0
            ? "Tots preparats! Pots iniciar la partida."
            : "Tots preparats! Esperant l'amfitrió…";
      }

      if (session.mySeat === 0) {
        $("startBtn").classList.toggle("hidden", !bothJoined);
        const sB = $("startBtn");
        sB.disabled = !bothFirebaseReady;
        sB.title = !bothFirebaseReady
          ? "Cal que els dos jugadors estiguen preparats"
          : "";
        sB.style.opacity = !bothFirebaseReady ? "0.5" : "1";
        sB.style.cursor = !bothFirebaseReady ? "not-allowed" : "pointer";

        $("hostReadyBtn").classList.toggle("hidden", !bothJoined || p0ready);
        $("guestReadyBtn").classList.add("hidden");
        $("guestWaitMsg").classList.add("hidden");
      } else {
        $("startBtn").classList.add("hidden");
        $("hostReadyBtn").classList.add("hidden");

        $("guestReadyBtn").classList.toggle("hidden", !bothJoined || myReady);
        const gW = $("guestWaitMsg");
        gW.classList.toggle("hidden", !bothJoined || !myReady);
        if (myReady) {
          gW.innerHTML =
            'Esperant que l\'amfitrió inicie la partida<span class="dots"></span>';
        }
      }

      // Mostrar el botón de volver siempre que estemos en el waiting
      $("backToMainBtn").classList.remove("hidden");
      $("waitingOverlay").classList.remove("hidden");
    } else {
      $("waitingOverlay").classList.add("hidden");
      if (bothJoined && betweenTimer === null && !_betweenCountdownLatch)
        startBetween(buildScoreSummary(state));
    }
    return;
  }
  $("waitingOverlay").classList.add("hidden");
  stopBetween();

  const h = state.hand;
  if (h) {
    const myTurn =
      (h.turn === session.mySeat &&
        !alreadyPlayed(h, session.mySeat) &&
        h.mode === "normal" &&
        !h.pendingOffer) ||
      h.pendingOffer?.to === session.mySeat;
    const tk = `${real(state.handNumber)}-${Logica.getTrickIndex(h)}-${h.turn}-${h.mode}-${alreadyPlayed(h, session.mySeat) ? 1 : 0}`;
    if (tk !== prevTurnKey) {
      startTurnTimer(myTurn && h.status === "in_progress");
      prevTurnKey = tk;
    }
  }
}

// --- Confetti -----------------------------------------------------------------
let confettiRAF = null;
function startConfetti(iWon) {
  const canvas = $("confettiCanvas");
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext("2d");
  const colors = [
    "#f0b429",
    "#2ea043",
    "#da3633",
    "#388bfd",
    "#e040fb",
    "#ff6d00",
  ];
  const particles = Array.from({ length: iWon ? 160 : 60 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * 60,
    r: 4 + Math.random() * 5,
    d: 2 + Math.random() * 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    tilt: Math.random() * 10 - 5,
    tiltSpeed: 0.1 + Math.random() * 0.15,
    opacity: iWon ? 1 : 0.4,
  }));
  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frame++;
    particles.forEach((p) => {
      p.y += p.d;
      p.x += Math.sin(frame * 0.02) * 1.2;
      p.tilt += p.tiltSpeed;
      ctx.beginPath();
      ctx.lineWidth = p.r;
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = p.opacity;
      ctx.moveTo(p.x + p.tilt, p.y);
      ctx.lineTo(p.x + p.tilt + p.r, p.y + p.r * 2);
      ctx.stroke();
      if (p.y > canvas.height + 10) {
        p.y = -10;
        p.x = Math.random() * canvas.width;
      }
    });
    ctx.globalAlpha = 1;
    confettiRAF = requestAnimationFrame(draw);
  }
  draw();
  // Stop after 6s
  setTimeout(stopConfetti, 6000);
}
function stopConfetti() {
  if (confettiRAF) {
    cancelAnimationFrame(confettiRAF);
    confettiRAF = null;
  }
  const canvas = $("confettiCanvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// --- Rematch ------------------------------------------------------------------
function renderRematchStatus(state) {
  const btn = $("goRematchBtn"),
    st = $("goRematchStatus");
  if (!btn || !st) return;
  const myWant = !!state.rematch?.[K(session.mySeat)];
  const rivWant = !!state.rematch?.[K(other(session.mySeat))];
  if (myWant && !rivWant) {
    btn.disabled = true;
    btn.textContent = "⏳ Esperant revenja...";
    st.textContent = `${pName(state, other(session.mySeat))} encara no ha contestat`;
  } else if (!myWant) {
    btn.disabled = false;
    btn.textContent = "🔄 Revenja";
    st.textContent = rivWant
      ? `${pName(state, other(session.mySeat))} vol la revenja!`
      : "";
  }
}

// --- Chat ---------------------------------------------------------------------
function initChat(code) {
  if (unsubChat) unsubChat();
  unsubChat = onValue(ref(db, `rooms/${code}/chat`), (snap) => {
    const msgs = snap.val();
    const area = $("chatMessages");
    if (!area) return;
    if (!msgs) {
      area.replaceChildren();
      return;
    }
    const arr = Object.values(msgs).sort((a, b) => a.at - b.at);
    const frag = document.createDocumentFragment();
    arr.forEach((m) => {
      const div = document.createElement("div");
      div.className = `chat-msg ${m.seat === session.mySeat ? "mine" : "theirs"}`;
      const t = new Date(m.at);
      const hh = t.getHours().toString().padStart(2, "0");
      const mm = t.getMinutes().toString().padStart(2, "0");
      div.innerHTML = `<span class="chat-author">${esc(m.name)}:</span> <span class="chat-text">${esc(m.text)}</span> <span class="chat-time">${hh}:${mm}</span>`;
      frag.appendChild(div);
    });
    area.replaceChildren(frag);
    area.scrollTop = area.scrollHeight;
    if (!chatOpen && arr.length > lastChatN)
      $("chatBadge").classList.remove("hidden");
    lastChatN = arr.length;
  });
}
async function sendChat() {
  const inp = $("chatInput"),
    text = inp.value.trim();
  if (!text || !session.roomRef || session.mySeat === null) return;
  inp.value = "";
  const myName = localStorage.getItem(LS.name) || `Jugador ${session.mySeat}`;
  await push(ref(db, `rooms/${session.roomCode}/chat`), {
    seat: session.mySeat,
    name: myName,
    text,
    at: Date.now(),
  });
}

// --- Room ---------------------------------------------------------------------

// --- Avatars ------------------------------------------------------------------
// Mismo orden que .av-opt en index.html (data-av 0..7)
const AVATAR_IMAGES = [
  "Media/Images/Avatars/Avatar4.png",
  "Media/Images/Avatars/Avatar3.png",
  "Media/Images/Avatars/Avatar1.png",
  "Media/Images/Avatars/Avatar14.png",
  "Media/Images/Avatars/Avatar16.png",
  "Media/Images/Avatars/Avatar6.png",
  "Media/Images/Avatars/Avatar7.png",
  "Media/Images/Avatars/Avatar5.png",
];
let myAvatar = Number(localStorage.getItem("truc_avatar") || 0);

function pickAvatar(idx) {
  // Don't allow picking rival's avatar
  if (idx === _rivalAvatarIdx && _rivalAvatarIdx >= 0) return;
  myAvatar = idx;
  localStorage.setItem("truc_avatar", String(idx));
  document.querySelectorAll(".av-opt").forEach((el) => {
    const i = Number(el.dataset.av);
    if (Number.isFinite(i)) el.classList.toggle("av-selected", i === idx);
  });
  if (session.roomRef && session.mySeat !== null) {
    set(
      ref(db, `rooms/${session.roomCode}/avatars/${K(session.mySeat)}`),
      idx,
    ).catch(() => {});
    const w = $(`waitSlotGameAv${session.mySeat}`);
    if (w) {
      w.innerHTML = getAvatarImg(idx);
      w.classList.toggle("slot-game-av-empty", !getAvatarImg(idx));
    }
  }
}
// Expose globally so HTML onclick works AND attach via JS
window.pickAvatar = pickAvatar;

let _rivalAvatarIdx = -1;
function getAvatarImg(idx) {
  if (idx < 0 || idx >= AVATAR_IMAGES.length) return ""; // sin avatar → vacío
  return `<img src="${AVATAR_IMAGES[idx]}" alt="Avatar">`;
}

function renderWaitingSlots(room, state) {
  const avs = room?.avatars || {};
  for (let seat = 0; seat <= 1; seat++) {
    const ph = $(`waitSlotPhoto${seat}`);
    const nm = $(`waitSlotName${seat}`);
    const gav = $(`waitSlotGameAv${seat}`);
    const bd = $(`waitSlotBadge${seat}`);
    if (!ph || !nm || !gav || !bd) continue;

    const pl = state?.players?.[K(seat)];
    if (!pl) {
      ph.src = GUEST_LOBBY_AVATAR;
      ph.classList.add("is-empty-slot");
      ph.alt = "";
      nm.textContent = "—";
      gav.innerHTML = "";
      gav.classList.add("slot-game-av-empty");
      bd.textContent = "Pendent...";
      bd.dataset.state = "pendent";
      bd.classList.remove("slot-badge-ready");
      continue;
    }
    ph.classList.remove("is-empty-slot");
    nm.textContent = pName(state, seat);
    ph.src = lobbyPhotoForPlayer(pl);
    ph.alt = pName(state, seat);

    const idx =
      session.mySeat === seat
        ? myAvatar
        : Number(avs[K(seat)] ?? -1);
    gav.classList.remove("slot-game-av-empty");
    gav.innerHTML = getAvatarImg(idx);
    if (!String(gav.innerHTML).trim())
      gav.classList.add("slot-game-av-empty");

    const isReady = !!state.ready?.[K(seat)];
    bd.classList.toggle("slot-badge-ready", isReady);
    if (isReady) {
      bd.textContent = "¡ESTÀ PREPARAT!";
      bd.dataset.state = "ready";
    } else {
      bd.textContent = "Triant avatar...";
      bd.dataset.state = "picking";
    }
  }
}

function renderAvatars(room) {
  const avs = room?.avatars || {};
  const myIdx = myAvatar; // siempre usar variable local, nunca Firebase
  const rivIdx = Number(avs[K(other(session.mySeat))] ?? -1);
  _rivalAvatarIdx = rivIdx;
  const myEl = $("myAv"),
    rivEl = $("rivalAv");

  if (myEl) myEl.innerHTML = getAvatarImg(myIdx);
  if (rivEl) rivEl.innerHTML = getAvatarImg(rivIdx);

  // Gray out avatar options that the rival has chosen
  document.querySelectorAll(".av-opt").forEach((el) => {
    const i = Number(el.dataset.av);
    if (!Number.isFinite(i)) return;
    const takenByRival = i === rivIdx && rivIdx >= 0;
    el.classList.toggle("av-taken", takenByRival);
    el.style.opacity = takenByRival ? "0.3" : "1";
    el.title = takenByRival ? "Aquest avatar l'usa el teu rival" : "";
  });
}

let unsubMsg = null;
export function startSession(code) {
  // Tanca subs de sala anteriors (reconnexió / canvi de codi sense reload) per evitar callbacks duplicats i fugues.
  detachRoomListeners();

  session.roomCode = code;
  session.roomRef = ref(db, `rooms/${code}`);

  // Sobreescribir nuestro avatar en Firebase al reconectar,
  // por si hay datos de una sesión anterior
  if (session.mySeat !== null) {
    set(ref(db, `rooms/${code}/avatars/${K(session.mySeat)}`), myAvatar).catch(
      () => {},
    );
  }

  unsubGame = onValue(session.roomRef, (snap) => {
    const data = snap.val();
    if (!data) {
      if (!session.roomCode) return;
      detachRoomListeners();
      clearTimeout(inactTimer);
      inactTimer = null;
      resetSession();
      localStorage.removeItem(LS.room);
      localStorage.removeItem(LS.seat);
      $("waitingOverlay")?.classList.add("hidden");
      $("gameOverOverlay")?.classList.add("hidden");
      stopConfetti();
      $("screenLobby")?.classList.remove("hidden");
      $("screenGame")?.classList.add("hidden");
      setLobbyMsg("La sala s'ha tancat.", "err");
      return;
    }

    if (!data.state) {
      $("screenLobby").classList.remove("hidden");
      $("screenGame").classList.add("hidden");
    } else {
      $("screenLobby").classList.add("hidden");
      $("screenGame").classList.remove("hidden");
    }

    renderAll(data);
  });

  // Refuerç: quan l'estat passa a "playing", alguns clients no rebien el snap de la sala a temps;
  // aquest camí curt força un render amb la sala completa.
  unsubStateStatus = onValue(
    ref(db, `rooms/${code}/state/status`),
    (statusSnap) => {
      if (session.roomCode !== code) return;
      if (statusSnap.val() !== "playing") return;
      $("waitingOverlay")?.classList.add("hidden");
      get(session.roomRef)
        .then((s) => {
          if (!s.exists() || session.roomCode !== code) return;
          renderAll(s.val());
        })
        .catch(() => {});
    },
  );

  initChat(code);
  initPhraseListener(code);

  if (unsubMsg) unsubMsg();
  let lastMsgAt = 0;

  unsubMsg = onValue(ref(db, `rooms/${code}/msg`), (snap) => {
    const m = snap.val();
    if (!m || m.at <= lastMsgAt) return;
    lastMsgAt = m.at;
    if (m.at > Date.now() - 5000) {
      const isMine = m.sender === session.mySeat;
      showTableMsgLocal(m.text, isMine); // ← local, no escribe a Firebase
    }
  });

  // 4. Sistema de presencia (jugador conectado/desconectado)
  if (session.mySeat !== null) {
    const presRef = ref(db, `rooms/${code}/presence/${K(session.mySeat)}`);
    onDisconnect(presRef).set({ absent: true, at: Date.now() });
    set(presRef, { absent: false, at: Date.now() }).catch(() => {});
  }
}
function setLobbyMsg(txt, cls) {
  const el = $("lobbyMsg");
  if (!el) return;
  el.textContent = txt;
  el.className = "lobby-msg" + (cls ? " " + cls : "");
}

function showAuthErr(txt) {
  const el = document.getElementById("authErrMsg");
  if (!el) {
    console.error(txt);
    return;
  }
  el.textContent = txt;
  el.classList.remove("hidden");
}

function clearAuthErr() {
  const el = document.getElementById("authErrMsg");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

async function createRoom() {
  const vis = _pendingCreateVisibility === "private" ? "private" : "public";
  const name = normName($("nameInput")?.value);
  const code =
    sanitize($("roomInput")?.value) ||
    Math.random().toString(36).slice(2, 6).toUpperCase();
  const r = ref(db, `rooms/${code}`);
  const ex = await get(r);

  if (ex.exists()) {
    const data = ex.val();
    const lastActivity = data.lastActivity || 0;
    const estado = data.state?.status;
    const inactiva = Date.now() - lastActivity > 10 * 60 * 1000; // 10 minutos
    const finalizada = estado === "game_over";
    const sinJugadores =
      !data.state?.players?.[K(0)] || !data.state?.players?.[K(1)];

    // Si está inactiva, finalizada o sin jugadores, la borramos y continuamos
    if (inactiva || finalizada || sinJugadores) {
      await remove(r);
    } else {
      _pendingCreateVisibility = "public";
      setLobbyMsg("Sala ja existeix.", "err");
      return false;
    }
  }
  const settings = { ..._pendingRoomSettings };
  const init = defaultState();
  init.roomCode = code;
  init.settings = { ...settings };
  init.players[K(0)] = {
    name,
    clientId: uid(),
    ...authPlayerExtras(),
  };
  init.logs = [{ text: `Sala creada per ${name}.`, at: Date.now() }];
  await set(r, {
    meta: { createdAt: Date.now(), roomCode: code, visibility: vis },
    settings,
    state: init,
    lastActivity: Date.now(),
  });
  session.mySeat = 0;
  saveLS(name, code, 0);
  if ($("roomInput")) $("roomInput").value = code;
  set(ref(db, `rooms/${code}/avatars/${K(0)}`), myAvatar).catch(() => {});
  setLobbyMsg(`Sala ${code} creada.`, "good");
  _pendingCreateVisibility = "public";
  startSession(code);
  return true;
}

async function joinRoom() {
  const name = normName($("nameInput")?.value);
  const code = sanitize($("roomInput")?.value);
  if (!code) {
    setLobbyMsg("Escriu un codi de sala.", "err");
    return;
  }
  const r = ref(db, `rooms/${code}`);
  const result = await runTransaction(
    r,
    (cur) => {
      if (!cur) return cur;
      if (!cur.state) cur.state = defaultState();
      const st = cur.state;
      if (!st.players) st.players = { [K(0)]: null, [K(1)]: null };
      const p0 = st.players[K(0)],
        p1 = st.players[K(1)];
      const roomSettings = mergeRoomSettings(cur);
      if (!st.settings) st.settings = { ...roomSettings };
      const maxJ = Math.min(roomSettings.maxJugadores, 2);
      const ocupats = (p0 ? 1 : 0) + (p1 ? 1 : 0);
      if (ocupats >= maxJ) return undefined;
      const extra = authPlayerExtras();
      if (!p0) {
        st.players[K(0)] = { name, clientId: uid(), ...extra };
        pushLog(st, `${name} entra com J0.`);
      } else {
        st.players[K(1)] = { name, clientId: uid(), ...extra };
        pushLog(st, `${name} entra com J1.`);
      }
      cur.lastActivity = Date.now();
      return cur;
    },
    { applyLocally: false },
  );
  if (!result.committed) {
    setLobbyMsg("Sala completa.", "err");
    return;
  }
  const fs = result.snapshot.val()?.state;
  if (!fs) {
    setLobbyMsg("Sala no trobada.", "err");
    return;
  }
  const p0 = fs.players?.[K(0)],
    p1 = fs.players?.[K(1)];
  if (p1?.name === name && p0?.name !== name) session.mySeat = 1;
  else if (p0?.name === name) session.mySeat = 0;
  else session.mySeat = 1;
  saveLS(name, code, session.mySeat);
  set(ref(db, `rooms/${code}/avatars/${K(session.mySeat)}`), myAvatar).catch(
    () => {},
  );
  setLobbyMsg(`Unit com J${session.mySeat}.`, "good");
  startSession(code);
}
async function leaveRoom() {
  detachRoomListeners();
  clearTimeout(inactTimer);
  inactTimer = null;
  if (session.roomRef && session.mySeat !== null) {
    try {
      const snap = await get(session.roomRef);
      const data = snap.val();
      const playerRef = ref(
        db,
        `rooms/${session.roomCode}/state/players/${K(session.mySeat)}`,
      );

      if (!data) {
        await remove(session.roomRef);
      } else {
        const st = data.state;
        const estado = st?.status;
        const otroJugador = st?.players?.[K(other(session.mySeat))];
        const hn = st?.handNumber;
        const waitingPreLobby =
          estado === "waiting" && real(hn ?? OFFSET) === 0;
        const hostTancaSalaEspera =
          waitingPreLobby && session.mySeat === 0;

        const gameEndReason =
          st?.gameEndReason ?? _lastState?.gameEndReason ?? null;
        const winnerSeat = st?.winner ?? _lastState?.winner;
        const gameOverFb = estado === "game_over";
        const gameOverLocal = _lastState?.status === "game_over";
        const victoriaPerAbandonament =
          gameEndReason === "abandonment" &&
          (gameOverFb || gameOverLocal) &&
          (winnerSeat === 0 || winnerSeat === 1);

        // Victòria per abandonament: només el guanyador esborra la sala sencera
        // (el perdedor només es treu de `players` perquè el guanyador puga veure l'overlay).
        if (victoriaPerAbandonament) {
          if (session.mySeat === winnerSeat) {
            await remove(session.roomRef);
          } else {
            await remove(playerRef);
          }
        } else if (
          estado === "game_over" ||
          !otroJugador ||
          hostTancaSalaEspera
        ) {
          await remove(session.roomRef);
        } else {
          await remove(playerRef);
        }
      }
    } catch (e) {}
  }
  localStorage.removeItem(LS.room);
  localStorage.removeItem(LS.seat);
  location.reload();
}
let _lastRoomListKey = "";
let unsubRooms = null;

function loadRoomList() {
  const listEl = $("roomList");
  if (!listEl) return;
  if (unsubRooms) return; // ya escuchando

  unsubRooms = onValue(ref(db, "rooms"), (snap) => {
    const rooms = snap.val();
    const open = [];
    if (rooms) {
      for (const [code, room] of Object.entries(rooms)) {
        if (room?.meta?.visibility === "private") continue;
        const st = room?.state;
        if (!st) continue;
        const p0 = st.players?.[K(0)];
        if (!p0) continue;
        const p1 = st.players?.[K(1)];
        const nPlayers = (p0 ? 1 : 0) + (p1 ? 1 : 0);
        const preGameLobby =
          st.status === "waiting" && real(st.handNumber ?? OFFSET) === 0;
        // Una sola persona i la partida ja havia començat: no és reclutament, no es mostra
        if (!p1 && !preGameLobby) continue;
        if (!p1 && preGameLobby) {
          const inactive = Date.now() - (room.lastActivity || 0) > 3600000;
          if (inactive) continue;
        }
        const conf = mergeRoomSettings(room);
        const maxCap = Math.min(conf.maxJugadores, 2);
        open.push({
          code,
          host: p0.name,
          hostPhoto: lobbyPhotoForPlayer(p0),
          nPlayers,
          maxCap,
          puntosParaGanar: conf.puntosParaGanar,
          modoJuego: conf.modoJuego,
          estado: roomListEstadoLabel(st),
        });
      }
    }
    open.sort((a, b) => a.code.localeCompare(b.code));
    const newKey = open
      .map(
        (r) =>
          `${r.code}|${r.host}|${r.hostPhoto}|${r.nPlayers}|${r.maxCap}|${r.puntosParaGanar}|${r.modoJuego}|${r.estado}`,
      )
      .join(";");
    if (newKey === _lastRoomListKey) return;
    _lastRoomListKey = newKey;
    listEl.innerHTML = "";
    if (!open.length) {
      listEl.innerHTML = '<div class="rl-empty">Cap sala oberta</div>';
      return;
    }
    open.forEach((r) => {
      const card = document.createElement("div");
      card.className = "rl-card";
      const left = document.createElement("div");
      left.className = "rl-card-left";
      const img = document.createElement("img");
      img.className = "rl-creator-photo";
      img.src = r.hostPhoto;
      img.alt = "";
      img.width = 44;
      img.height = 44;
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      left.appendChild(img);
      const body = document.createElement("div");
      body.className = "rl-card-body";
      const headLn = document.createElement("div");
      headLn.className = "rl-room-head";
      headLn.append("Sala de ");
      const nick = document.createElement("strong");
      nick.className = "rl-creator-nick";
      nick.textContent = r.host;
      headLn.appendChild(nick);
      headLn.append(" · ");
      const tagPts = document.createElement("span");
      tagPts.className = "rl-tag";
      tagPts.innerHTML = `${ICO_STONE}<span>${r.puntosParaGanar}p</span>`;
      const tagMod = document.createElement("span");
      tagMod.className = "rl-tag";
      tagMod.innerHTML = `${ICO_USER}<span>${r.modoJuego}</span>`;
      headLn.appendChild(tagPts);
      headLn.appendChild(document.createTextNode(" "));
      headLn.appendChild(tagMod);
      const jg = document.createElement("div");
      jg.className = "rl-meta-line";
      jg.textContent = `Jugadors: ${r.nPlayers}/${r.maxCap}`;
      const stEl = document.createElement("div");
      stEl.className = "rl-meta-line rl-estado";
      stEl.textContent = r.estado;
      body.appendChild(headLn);
      body.appendChild(jg);
      body.appendChild(stEl);
      const join = document.createElement("button");
      join.type = "button";
      join.className = "lbtn lbtn-primary rl-join";
      join.textContent = "Entrar";
      const ple = r.nPlayers >= r.maxCap;
      if (ple) join.classList.add("rl-join-disabled");
      join.style.opacity = ple ? "0.55" : "1";
      join.style.cursor = ple ? "not-allowed" : "pointer";
      join.title = ple ? "Sala completa" : "";
      join.addEventListener("click", () => {
        if (ple) {
          setLobbyMsg("Sala completa.", "err");
          return;
        }
        const ri = $("roomInput");
        if (ri) ri.value = r.code;
        joinRoom();
      });
      card.appendChild(left);
      card.appendChild(body);
      card.appendChild(join);
      listEl.appendChild(card);
    });
  });
}
const ORPHAN_ROOM_MAX_MS = 2 * 60 * 1000; // sala trencada (1 jugador fora del lobby inicial)

async function limpiarSalasAntiguas() {
  try {
    const snap = await get(ref(db, "rooms"));
    if (!snap.exists()) return;
    const ahora = Date.now();
    const borrados = [];
    snap.forEach((child) => {
      const data = child.val();
      const st = data.state;
      const la = data.lastActivity || 0;
      const inactiva = ahora - la > 30 * 60 * 1000; // 30 min
      const finalizada = st?.status === "game_over";
      const preGameLobby =
        st?.status === "waiting" && real(st?.handNumber ?? OFFSET) === 0;
      const p0 = st?.players?.[K(0)];
      const p1 = st?.players?.[K(1)];
      const n = (p0 ? 1 : 0) + (p1 ? 1 : 0);
      const salaTrencada =
        n === 1 &&
        !preGameLobby &&
        ahora - la > ORPHAN_ROOM_MAX_MS;
      if (inactiva || finalizada || salaTrencada) {
        borrados.push(remove(ref(db, `rooms/${child.key}`)));
      }
    });
    await Promise.all(borrados);
  } catch (e) {}
}
// ── FRASES DE CHAT ────────────────────────────────────────────────────────
const FRASES = [
  "⚔️ Ara sí que va de bo!",
  "🏅 Hui no fas ni un punt.",
  "🌿 Açò és mel de romer.",
  "💣 Va, que esta cau.",
  "💰 Esta mà val or.",
  "🖐️ Vine, vine, que t'espere.",
  "🦁 A vore si tens valor.",
  "😳 Això és tot el que portes?",
  "🔝 De categoria.",
  "😲 No me l'esperava.",
  "🏟️ Ací encara hi ha partida.",
  "🧱 Has vingut a fer bulto.",
  "👵 Ma iaia haguera jugat millor!",
  "🙊 No tens res i ho saps.",
  "🐔 Tens por o què?",
  "🍀 Xe, quina potra que tens!",
  "👿 Redeu, quines cartes!",
  "📉 Hui no en guanye ni una!",
  "🤡 Açò és un vull i no puc.",
  "🧐 Açò no t'ho creus ni tu!",
  "🌙 Tira ja que es fa de nit!",
  "🤥 Mal farol has soltat!",
];

let _canChat = true;
let _unsubPhrases = null;

function buildPhraseMenu() {
  const menu = $("myPhraseMenu");
  if (!menu) return;
  menu.innerHTML = "";
  // 8 frases aleatorias cada vez
  const shuffled = [...FRASES].sort(() => 0.5 - Math.random()).slice(0, 8);
  shuffled.forEach((frase) => {
    const item = document.createElement("div");
    item.className = "phrase-item";
    item.textContent = frase;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      sendPhrase(frase);
    });
    // Soporte táctil explícito
    item.addEventListener("touchend", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendPhrase(frase);
    });
    menu.appendChild(item);
  });
}

function togglePhraseMenu() {
  if (!_canChat) return;
  const menu = $("myPhraseMenu");
  if (!menu) return;
  if (menu.classList.contains("hidden")) {
    buildPhraseMenu();
    menu.classList.remove("hidden");
  } else {
    menu.classList.add("hidden");
  }
}

function showBubble(bubbleId, text) {
  const b = $(bubbleId);
  if (!b) return;
  b.textContent = text;
  b.classList.remove("hidden");
  // Reinicia la animación
  b.style.animation = "none";
  void b.offsetWidth;
  b.style.animation = "";
  clearTimeout(b._hideTimer);
  b._hideTimer = setTimeout(() => b.classList.add("hidden"), 4000);
}
window.showBubble = showBubble;

// Frases ràpides: un sol canal RTDB `phraseOut/{_0|_1}` (enviament + `initPhraseListener` per rebre).
function sendPhrase(text) {
  if (!_canChat || !session.roomCode) return;

  // Cierra el menú
  $("myPhraseMenu")?.classList.add("hidden");

  // Muestra en mi pantalla
  showBubble("myBubble", text);

  // Nodo por asiento (com avatars): les dues regles de Firebase solen permetre escriptura al propi _0/_1.
  set(ref(db, `rooms/${session.roomCode}/phraseOut/${K(session.mySeat)}`), {
    msg: text,
    t: Date.now(),
  }).catch(() => {});

  // Bloquea 8 segundos
  _canChat = false;
  $("myAvatarContainer")?.classList.add("av-frozen");
  setTimeout(() => {
    _canChat = true;
    $("myAvatarContainer")?.classList.remove("av-frozen");
  }, 8000);
}

function initPhraseListener(code) {
  if (_unsubPhrases) _unsubPhrases();
  if (session.mySeat !== 0 && session.mySeat !== 1) return;
  const rivalKey = K(other(session.mySeat));
  _unsubPhrases = onValue(
    ref(db, `rooms/${code}/phraseOut/${rivalKey}`),
    (snap) => {
      const data = snap.val();
      if (!data || !data.msg) return;
      const age = Date.now() - (data.t || 0);
      if (age > 8000 || age < -2000) return;
      showBubble("rivalBubble", data.msg);
    },
  );
}

export function detachRoomListeners() {
  stopBetween();
  stopTurnTimer();
  clearAbsenceTimers();
  _claimMissingRivalPending = false;
  $("absenceBar")?.classList.add("hidden");
  if (unsubGame) {
    unsubGame();
    unsubGame = null;
  }
  if (unsubStateStatus) {
    unsubStateStatus();
    unsubStateStatus = null;
  }
  if (unsubChat) {
    unsubChat();
    unsubChat = null;
  }
  if (unsubMsg) {
    unsubMsg();
    unsubMsg = null;
  }
  if (_unsubPhrases) {
    _unsubPhrases();
    _unsubPhrases = null;
  }
}

// --- Boot: initApp ------------------------------------------------------------
function initLegalModal() {
  const modal = $("legalModal");
  const openBtn = $("legalModalOpen");
  const closeBtn = $("legalModalClose");
  const backdrop = $("legalModalBackdrop");
  if (!modal || !openBtn || !closeBtn) return;

  const show = () => {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    closeBtn.focus();
  };
  const hide = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    openBtn.focus();
  };

  openBtn.addEventListener("click", (e) => {
    e.preventDefault();
    show();
  });
  closeBtn.addEventListener("click", () => hide());
  backdrop?.addEventListener("click", () => hide());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
}

let _openCreateRoomModal = () => {};

function initCreateRoomModal() {
  const modal = $("createRoomModal");
  const backdrop = $("createRoomModalBackdrop");
  const cancel = $("createRoomModalCancel");
  const submit = $("createRoomModalSubmit");
  if (!modal || !backdrop || !cancel || !submit) return;

  const hide = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  const resetForm = () => {
    _pendingRoomSettings = DEFAULT_ROOM_SETTINGS();
    const r12 = modal.querySelector('input[name="crcPts"][value="12"]');
    const m11 = modal.querySelector('input[name="crcModo"][value="1v1"]');
    if (r12) r12.checked = true;
    if (m11) m11.checked = true;
  };

  _openCreateRoomModal = () => {
    resetForm();
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    submit.focus();
  };

  cancel.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });

  submit.addEventListener("click", async () => {
    const ptsRaw = modal.querySelector('input[name="crcPts"]:checked')?.value;
    const modo =
      modal.querySelector('input[name="crcModo"]:checked')?.value || "1v1";
    const pts = Number(ptsRaw) === 24 ? 24 : 12;
    _pendingRoomSettings = {
      puntosParaGanar: pts,
      modoJuego: modo,
      maxJugadores: modo === "2v2" ? 4 : 2,
    };
    const ok = await createRoom();
    if (ok) hide();
  });
}

export function initApp() {
  configureActions({ renderAll });
  initAuthFlow();
  initLegalModal();
  initCreateRoomModal();
  limpiarSalasAntiguas(); // sin await, que corra en segundo plano
  $("btn-crear-publica")?.addEventListener("click", () => {
    _pendingCreateVisibility = "public";
    if ($("roomInput")) $("roomInput").value = "";
    _openCreateRoomModal();
  });
  $("btn-crear-privada")?.addEventListener("click", () => {
    _pendingCreateVisibility = "private";
    const raw = window.prompt(
      "Introdueix el codi de la sala privada (4–8 caràcters alfanumèrics):",
      "",
    );
    if (raw == null) {
      _pendingCreateVisibility = "public";
      return;
    }
    const code = sanitize(raw);
    if (code.length < 2) {
      _pendingCreateVisibility = "public";
      setLobbyMsg("Codi massa curt.", "err");
      return;
    }
    if ($("roomInput")) $("roomInput").value = code;
    _openCreateRoomModal();
  });
  $("btn-unirse-codigo")?.addEventListener("click", () => {
    const raw = window.prompt("Introdueix el codi de la sala:", "");
    if (raw == null) return;
    const code = sanitize(raw);
    if (!code) {
      setLobbyMsg("Escriu un codi de sala.", "err");
      return;
    }
    if ($("roomInput")) $("roomInput").value = code;
    joinRoom();
  });
  $("btn-invitado")?.addEventListener("click", async () => {
    clearAuthErr();
    try {
      await signInAnonymously(auth);
    } catch (err) {
      console.error("Error login convidat:", err);
      const code = err?.code || "";
      const hint =
        location.protocol === "file:"
          ? " Obre amb http://localhost (no file://)."
          : "";
      showAuthErr(
        `No s'ha pogut entrar com a convidat (${code || err?.message || "error"}).${hint}`,
      );
      setLobbyMsg("No s'ha pogut entrar com a convidat.", "err");
    }
  });
  $("lobbyEixirBtn")?.addEventListener("click", async () => {
    const u = auth.currentUser;
    if (u?.isAnonymous && u.uid) {
      sessionStorage.removeItem(ANON_NICK_STORAGE_PREFIX + u.uid);
    }
    if (session.roomRef) detachRoomListeners();
    resetSession();
    localStorage.removeItem(LS.room);
    localStorage.removeItem(LS.seat);
    try {
      await signOut(auth);
    } catch (err) {
      console.error("signOut lobby:", err);
    }
  });
  $("leaveBtn").addEventListener("click", leaveRoom);
  $("goLeaveBtn").addEventListener("click", leaveRoom);
  $("backToMainBtn")?.addEventListener("click", async () => {
    sndBtn();
    await leaveRoom();
  });
  $("goRematchBtn")?.addEventListener("click", requestRematch);
  // Menú de frases: el propi avatar i el del rival (mateixa acció; abans el clic al rival es propagava al document i tancava el menú a l'instant)
  const onPhraseAvatarTap = (e) => {
    e.preventDefault();
    togglePhraseMenu();
  };
  $("myAvatarContainer")?.addEventListener("click", togglePhraseMenu);
  $("myAvatarContainer")?.addEventListener("touchend", onPhraseAvatarTap);
  $("rivalAvatarContainer")?.addEventListener("click", togglePhraseMenu);
  $("rivalAvatarContainer")?.addEventListener("touchend", onPhraseAvatarTap);

  // Cerrar al hacer click fuera
  document.addEventListener("click", (e) => {
    const myW = $("myAvatarContainer");
    const rivW = $("rivalAvatarContainer");
    if (!myW?.contains(e.target) && !rivW?.contains(e.target)) {
      $("myPhraseMenu")?.classList.add("hidden");
    }
  });

  async function onPlayerReadyClick() {
    if (_actionInProgress) return;
    _actionInProgress = true;
    sndBtn();
    try {
      await guestReady();
    } finally {
      setTimeout(() => {
        _actionInProgress = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) renderAll(snap.val());
          })
          .catch(() => {});
      }, 200);
    }
  }
  $("guestReadyBtn")?.addEventListener("click", onPlayerReadyClick);
  $("hostReadyBtn")?.addEventListener("click", onPlayerReadyClick);

  $("startBtn").addEventListener("click", async () => {
    sndBtn();
    $("waitingOverlay").classList.add("hidden");
    await dealHand();
  });

  // --- NUEVO: Configuración -------------------------------------------------
  applyConfig();

  $("configBtn").addEventListener("click", () => {
    $("configPanel").classList.toggle("hidden");
    // Marca el botón activo de cada sección
    const cfg = loadConfig();
    document.querySelectorAll(".cfg-opt").forEach((btn) => {
      const key = btn.dataset.cfg;
      const val = btn.dataset.val;
      const currentVal = String(cfg[key]);
      btn.classList.toggle("active", val === currentVal);
    });
  });

  $("configClose").addEventListener("click", () => {
    $("configPanel").classList.add("hidden");
  });

  document.querySelectorAll(".cfg-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.cfg;
      let val = btn.dataset.val;
      // Convierte 'true'/'false' string a boolean para el sonido
      if (val === "true") val = true;
      if (val === "false") val = false;
      setConfig(key, val);
      // Actualiza visual de botones activos en esa sección
      document.querySelectorAll(`.cfg-opt[data-cfg="${key}"]`).forEach((b) => {
        b.classList.toggle("active", b.dataset.val === String(val));
      });
    });
  });
  // --------------------------------------------------------------------------

  /* Botones de acció principals — amb guard antidoble-click */
  $("envitBtn").onclick = async () => {
    if (_actionInProgress) return;
    _actionInProgress = true;
    sndBtn();
    showTableMsg("Envide!", true);
    try {
      await startOffer("envit");
    } finally {
      setTimeout(() => {
        _actionInProgress = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) renderAll(snap.val());
          })
          .catch(() => {});
      }, 1500);
    }
  };
  $("faltaBtn").onclick = async () => {
    if (_actionInProgress) return;
    _actionInProgress = true;
    sndBtn();
    showTableMsg("Falta!", true);
    try {
      await startOffer("falta");
    } finally {
      setTimeout(() => {
        _actionInProgress = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) renderAll(snap.val());
          })
          .catch(() => {});
      }, 1500);
    }
  };
  $("trucBtn").onclick = async () => {
    if (_actionInProgress) return;
    _actionInProgress = true;
    sndBtn();
    showTableMsg($("trucBtn").textContent + "!", true);
    try {
      await startOffer("truc");
    } finally {
      setTimeout(() => {
        _actionInProgress = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) renderAll(snap.val());
          })
          .catch(() => {});
      }, 1500);
    }
  };
  $("mazoBtn").onclick = async () => {
    if (_actionInProgress) return;
    _actionInProgress = true;
    sndBtn();
    showTableMsg("Me'n vaig!", true);
    try {
      await goMazo();
    } finally {
      setTimeout(() => {
        _actionInProgress = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) renderAll(snap.val());
          })
          .catch(() => {});
      }, 1500);
    }
  };

  $("logToggle").addEventListener("click", () => {
    const b = $("logBody");
    b.classList.toggle("hidden");
    $("logToggle").textContent = b.classList.contains("hidden")
      ? "> Registro"
      : "v Registro";
  });
  $("chatToggle").addEventListener("click", () => {
    chatOpen = !chatOpen;
    $("chatBox").classList.toggle("hidden", !chatOpen);
    if (chatOpen) {
      $("chatBadge").classList.add("hidden");
      setTimeout(() => {
        $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
        $("chatInput").focus();
      }, 50);
    }
  });
  $("chatSend").addEventListener("click", sendChat);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  document.querySelectorAll(".av-opt").forEach((el) => {
    el.addEventListener("click", () => {
      const i = Number(el.dataset.av);
      if (Number.isFinite(i)) pickAvatar(i);
    });
  });
  pickAvatar(myAvatar);
  loadLS();
  loadRoomList();
}
