// --- lobby.js — Creació, llista i gestió de sales ----------------------------
import {
  db,
  session,
  ref,
  get,
  set,
  push,
  remove,
  onValue,
  runTransaction,
  onDisconnect,
} from "./firebase.js";
import { defaultState, buildDefaultState } from "./acciones.js";
import * as Logica from "./logica.js";
import { GUEST_LOBBY_AVATAR, BOT_AVATAR, firebaseValueForChoice } from "./avatars.js";
import { auth, firestore } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { initBot, setBotActive, resetBotMemory } from "./bot.js";
import {
  getDisplayNick,
  getProfile,
  saveProfile,
  getNickCooldownStatus,
  checkNickAvailability,
  CARD_DECK_OPTIONS,
  TABLE_BG_OPTIONS,
} from "./profile.js";
import { checkNickModeration } from "./moderation.js";
import { srcFromChoice } from "./avatars.js";

const $ = (id) => document.getElementById(id);

const K = (n) => `_${n}`;
const OFFSET = 10;
const real = (n) => Number(n || OFFSET) - OFFSET;
const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sanitize = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
export const normName = (s) =>
  String(s || "")
    .trim()
    .slice(0, 24) || "Convidat";
const LS = { room: "truc_room", seat: "truc_seat", name: "truc_name" };

// --- Injecció de dependències (evita circularitat amb ui.js) -----------------
let _startSession = (_code) => {};
export function configureLobby({ startSession }) {
  _startSession = startSession;
}

// --- Helpers -----------------------------------------------------------------
function authPlayerExtras() {
  const u = auth.currentUser;
  if (!u) return {};
  const o = { uid: u.uid };
  if (u.isAnonymous) o.guest = true;
  if (u.photoURL) o.photoURL = u.photoURL;
  return o;
}

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

function lobbyPhotoForPlayer(p) {
  if (!p) return GUEST_LOBBY_AVATAR;
  if (p.photoURL) return p.photoURL;
  if (p.guest) return GUEST_LOBBY_AVATAR;
  return GUEST_LOBBY_AVATAR;
}

function roomListEstadoLabel(st) {
  if (!st) return "En preparació";
  const s0 = real(st.scores?.[K(0)] ?? OFFSET);
  const s1 = real(st.scores?.[K(1)] ?? OFFSET);
  const meta = Logica.getPuntosParaGanar(st);
  if (st.status === "game_over" || s0 >= meta || s1 >= meta)
    return "Finalitzada";
  if (st.status === "waiting" && real(st.handNumber ?? OFFSET) === 0)
    return "En preparació";
  return "En partida";
}

export function mergeRoomSettings(room) {
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

export const DEFAULT_ROOM_SETTINGS = () => ({
  puntosParaGanar: 12,
  modoJuego: "1v1",
  maxJugadores: 2,
});

const ICO_STONE =
  '<svg class="rl-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><ellipse cx="12" cy="14" rx="7" ry="5.5" fill="currentColor" opacity=".88"/></svg>';
const ICO_USER =
  '<svg class="rl-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4.42 0-8 1.79-8 4v2h16v-2c0-2.21-3.58-4-8-4z"/></svg>';

// --- Estat intern de sala -----------------------------------------------------
let _pendingCreateVisibility = "public";
let _pendingRoomSettings = DEFAULT_ROOM_SETTINGS();
let _lastRoomListKey = null;
let unsubRooms = null;
const ORPHAN_ROOM_MAX_MS = 2 * 60 * 1000;
/** Timestamp de l'última sala creada (rate-limit client-side). */
let _lastRoomCreatedAt = 0;
const ROOM_CREATE_RATE_MS = 5_000;

// --- Missatge de lobby -------------------------------------------------------
export function setLobbyMsg(txt, cls) {
  const el = $("lobbyMsg");
  if (!el) return;
  el.textContent = txt;
  el.className = "lobby-msg" + (cls ? " " + cls : "");
}

function saveLS(n, c, s) {
  localStorage.setItem(LS.name, n || "");
  localStorage.setItem(LS.room, c || "");
  localStorage.setItem(LS.seat, String(s));
}

// --- Crear sala --------------------------------------------------------------
/** Comprova si l'usuari autenticat ja té una sala activa com a amfitrió (J0). */
async function hasActiveRoomAsHost() {
  const u = auth.currentUser;
  if (!u) return false;
  const snap = await get(ref(db, "rooms"));
  if (!snap.exists()) return false;
  let found = false;
  snap.forEach((child) => {
    const data = child.val();
    if (data?.state?.players?.[K(0)]?.uid !== u.uid) return;
    const finalizada = data.state.status === "game_over";
    const inactiva = Date.now() - (data.lastActivity || 0) > 3 * 60 * 1000;
    if (!finalizada && !inactiva) found = true;
  });
  return found;
}

export async function createRoom() {
  setBotActive(false);
  resetBotMemory();
  // Barrera 1: Rate-limit — mínim 15 s entre creacions
  if (Date.now() - _lastRoomCreatedAt < ROOM_CREATE_RATE_MS) {
    setLobbyMsg("Espera uns segons abans de crear una nova sala.", "err");
    return false;
  }
  // Barrera 2: Sala activa — un usuari, una sala
  if (auth.currentUser) {
    if (await hasActiveRoomAsHost()) {
      _pendingCreateVisibility = "public";
      setLobbyMsg("Ja tens una sala activa. Tanca-la primer.", "err");
      return false;
    }
  }
  const vis = _pendingCreateVisibility === "private" ? "private" : "public";
  // Usa el nick del perfil si existeix; si no, el contingut de nameInput (legacy)
  const displayNick = getDisplayNick();
  const name = normName(displayNick || $("nameInput")?.value);
  const code =
    sanitize($("roomInput")?.value) ||
    Math.random().toString(36).slice(2, 6).toUpperCase();
  const r = ref(db, `rooms/${code}`);
  const ex = await get(r);

  if (ex.exists()) {
    const data = ex.val();
    const lastActivity = data.lastActivity || 0;
    const estado = data.state?.status;
    const inactiva = Date.now() - lastActivity > 10 * 60 * 1000;
    const finalizada = estado === "game_over";
    const sinJugadores = (() => {
      const maxJ = data.state?.settings?.maxJugadores || 2;
      for (let i = 0; i < maxJ; i++) {
        if (!data.state?.players?.[K(i)]) return true;
      }
      return false;
    })();
    if (inactiva || finalizada || sinJugadores) {
      await remove(r);
    } else {
      _pendingCreateVisibility = "public";
      setLobbyMsg("Sala ja existeix.", "err");
      return false;
    }
  }
  _lastRoomCreatedAt = Date.now();
  const settings = { ..._pendingRoomSettings };
  // buildDefaultState genera els slots correctes per a 2 o 4 jugadors
  const init = buildDefaultState(
    settings.maxJugadores,
    settings.modoJuego,
    settings.puntosParaGanar,
  );
  init.roomCode = code;
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
  setLobbyMsg("", "");
  _pendingCreateVisibility = "public";
  _startSession(code);
  return true;
}

export async function createRoomAsBot(name) {
  // Barrera 1: Rate-limit — mínim 15 s entre creacions
  if (Date.now() - _lastRoomCreatedAt < ROOM_CREATE_RATE_MS) {
    setLobbyMsg("Espera uns segons abans de crear una nova sala.", "err");
    return false;
  }
  const vis = "private";
  const botName = "🤖 Bot";
  // Usa el nick del perfil si existeix; si no, el nom passat per paràmetre
  const displayNick = getDisplayNick();
  const humanName = normName(displayNick || name);
  const code =
    sanitize($("roomInput")?.value) ||
    Math.random().toString(36).slice(2, 6).toUpperCase();
  const r = ref(db, `rooms/${code}`);
  const ex = await get(r);

  if (ex.exists()) {
    const data = ex.val();
    const lastActivity = data.lastActivity || 0;
    const estado = data.state?.status;
    const inactiva = Date.now() - lastActivity > 10 * 60 * 1000;
    const finalizada = estado === "game_over";
    const sinJugadores = (() => {
      const maxJ = data.state?.settings?.maxJugadores || 2;
      for (let i = 0; i < maxJ; i++) {
        if (!data.state?.players?.[K(i)]) return true;
      }
      return false;
    })();
    if (inactiva || finalizada || sinJugadores) {
      await remove(r);
    } else {
      setLobbyMsg("Sala ja existeix.", "err");
      return false;
    }
  }
  _lastRoomCreatedAt = Date.now();

  const settings = {
    ..._pendingRoomSettings,
    modoJuego: "1v1",
    maxJugadores: 2,
    contraBot: true,
  };
  // buildDefaultState genera els slots correctes per al modo de joc
  const init = buildDefaultState(
    settings.maxJugadores,
    settings.modoJuego,
    settings.puntosParaGanar,
  );
  init.settings.contraBot = true;
  init.roomCode = code;
  init.players[K(0)] = {
    name: humanName,
    clientId: uid(),
    ...authPlayerExtras(),
  };
  init.players[K(1)] = {
    name: botName,
    clientId: uid(),
    guest: true,
    photoURL: BOT_AVATAR,
  };
  init.ready = init.ready || {};
  init.ready[K(0)] = true;
  init.ready[K(1)] = true;
  init.logs = [{ text: `Sala creada per ${humanName}.`, at: Date.now() }];

  await set(r, {
    meta: { createdAt: Date.now(), roomCode: code, visibility: vis },
    settings,
    state: init,
    avatars: {
      [K(0)]: firebaseValueForChoice(0),
      [K(1)]: BOT_AVATAR,
    },
    lastActivity: Date.now(),
  });

  session.mySeat = 0;
  saveLS(humanName, code, 0);
  if ($("roomInput")) $("roomInput").value = code;
  setLobbyMsg("", "");
  _pendingCreateVisibility = "public";
  resetBotMemory();
  setBotActive(true);
  await initBot();
  _startSession(code);
  return true;
}

// --- Unir-se a sala ----------------------------------------------------------
export async function joinRoom() {
  setBotActive(false);
  resetBotMemory();
  // Usa el nick del perfil si existeix; si no, el contingut de nameInput (legacy)
  const displayNick = getDisplayNick();
  const name = normName(displayNick || $("nameInput")?.value);
  const code = sanitize($("roomInput")?.value);
  if (!code) {
    setLobbyMsg("Escriu un codi de sala.", "err");
    return;
  }
  const r = ref(db, `rooms/${code}`);
  let assignedSeat = null;
  const result = await runTransaction(
    r,
    (cur) => {
      if (!cur) return cur;
      if (!cur.state) cur.state = defaultState();
      const st = cur.state;
      const roomSettings = mergeRoomSettings(cur);
      if (!st.settings) st.settings = { ...roomSettings };
      // Nombre de seients per a aquesta sala (2 o 4)
      const maxJ = roomSettings.maxJugadores || 2;
      if (!st.players) {
        st.players = {};
        for (let i = 0; i < maxJ; i++) st.players[K(i)] = null;
      }
      // Trobar primer seient lliure
      let freeSeat = null;
      for (let i = 0; i < maxJ; i++) {
        if (!st.players[K(i)]) { freeSeat = i; break; }
      }
      if (freeSeat === null) return undefined; // Sala completa
      const extra = authPlayerExtras();
      st.players[K(freeSeat)] = { name, clientId: uid(), ...extra };
      pushLog(st, `${name} entra com J${freeSeat}.`);
      assignedSeat = freeSeat;
      cur.lastActivity = Date.now();
      return cur;
    },
    { applyLocally: false },
  );
  if (!result.committed) {
    setLobbyMsg("Sala completa.", "err");
    return;
  }
  if (!result.snapshot.val()?.state) {
    setLobbyMsg("Sala no trobada.", "err");
    return;
  }
  session.mySeat = assignedSeat ?? 1;
  saveLS(name, code, session.mySeat);
  setLobbyMsg("", "");
  _startSession(code);
}

// --- Canviar seient (2v2 pre-partida) ----------------------------------------
export async function changeSeat(newSeat) {
  if (session.mySeat === newSeat || session.mySeat === null) return;
  const code = session.roomCode;
  if (!code) return;
  const r = ref(db, `rooms/${code}`);

  const result = await runTransaction(r, (cur) => {
    if (!cur || !cur.state || !cur.state.players) return cur;
    if (cur.state.players[K(newSeat)]) return cur; // Seient ja ocupat
    
    // Moure jugador
    cur.state.players[K(newSeat)] = cur.state.players[K(session.mySeat)];
    cur.state.players[K(session.mySeat)] = null;
    
    // Moure ready status
    if (cur.state.ready) {
      const wasReady = cur.state.ready[K(session.mySeat)];
      cur.state.ready[K(session.mySeat)] = null;
      if (wasReady) cur.state.ready[K(newSeat)] = true;
    }

    // Moure avatar
    if (cur.avatars?.[K(session.mySeat)]) {
      const av = cur.avatars[K(session.mySeat)];
      cur.avatars[K(session.mySeat)] = null;
      cur.avatars[K(newSeat)] = av;
    }
    
    // Moure presencia si cal
    if (cur.presence?.[K(session.mySeat)]) {
      const pr = cur.presence[K(session.mySeat)];
      cur.presence[K(session.mySeat)] = null;
      cur.presence[K(newSeat)] = pr;
    }

    cur.lastActivity = Date.now();
    return cur;
  }, { applyLocally: false });

  if (result.committed) {
    const snapState = result.snapshot.val()?.state;
    if (snapState && snapState.players && snapState.players[K(newSeat)]) {
      const oldSeat = session.mySeat;
      session.mySeat = newSeat;
      localStorage.setItem("truc_seat", String(newSeat));
      // Actualitzar presència en cas que el node onDisconnect calga refer-se
      const oldRef = ref(db, `rooms/${code}/presence/${K(oldSeat)}`);
      onDisconnect(oldRef).cancel();
      const newRef = ref(db, `rooms/${code}/presence/${K(newSeat)}`);
      onDisconnect(newRef).set({ absent: true, at: Date.now() });
      set(newRef, { absent: false, at: Date.now() }).catch(() => {});
    }
  }
}

// --- Llista de sales públiques -----------------------------------------------
export function loadRoomList() {
  const listEl = $("roomList");
  if (!listEl) return;
  if (unsubRooms) return;

  unsubRooms = onValue(ref(db, "rooms"), (snap) => {
    const rooms = snap.val();
    const open = [];
    if (rooms) {
      for (const [code, room] of Object.entries(rooms)) {
        if (room?.meta?.visibility === "private") continue;
        const st = room?.state;
        if (!st) continue;
        const conf = mergeRoomSettings(room);
        const maxCap = conf.maxJugadores || 2;
        // Comptar jugadors presents
        let nPlayers = 0;
        for (let i = 0; i < maxCap; i++) {
          if (st.players?.[K(i)]) nPlayers++;
        }
        const preGameLobby =
          st.status === "waiting" && real(st.handNumber ?? OFFSET) === 0;
        if (nPlayers >= maxCap && !preGameLobby) continue;
        if (nPlayers < maxCap && preGameLobby) {
          const inactive = Date.now() - (room.lastActivity || 0) > 3600000;
          if (inactive) continue;
        }
        // Host = primer jugador trobat
        const host = st.players?.[K(0)] || null;
        if (!host && nPlayers === 0) continue;
        open.push({
          code,
          host: host?.name || "?",
          hostPhoto: lobbyPhotoForPlayer(host),
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
      headLn.append("Sala creada per ");
      const nick = document.createElement("strong");
      nick.className = "rl-creator-nick";
      nick.textContent = r.host;
      headLn.appendChild(nick);
      const modePts = document.createElement("div");
      modePts.className = "rl-mode-pts-line";
      const tagMod = document.createElement("span");
      tagMod.className = "rl-tag";
      tagMod.innerHTML = `${ICO_USER}<span>${r.modoJuego}</span>`;
      const tagPts = document.createElement("span");
      tagPts.className = "rl-tag";
      tagPts.innerHTML = `${ICO_STONE}<span>${r.puntosParaGanar}p</span>`;
      modePts.appendChild(tagMod);
      modePts.appendChild(tagPts);
      const jg = document.createElement("div");
      jg.className = "rl-meta-line rl-jugadors-estado";
      const jgLbl = document.createElement("span");
      jgLbl.className = "rl-jugadors-lbl";
      jgLbl.textContent = `Jugadors: ${r.nPlayers}/${r.maxCap}`;
      const jgDot = document.createElement("span");
      jgDot.className = "rl-jugadors-sep";
      jgDot.textContent = "\u00b7";
      const stSpan = document.createElement("span");
      stSpan.className = "rl-estado";
      stSpan.textContent = r.estado;
      jg.appendChild(jgLbl);
      jg.appendChild(jgDot);
      jg.appendChild(stSpan);
      body.appendChild(headLn);
      body.appendChild(modePts);
      body.appendChild(jg);
      const join = document.createElement("button");
      join.type = "button";
      join.className = "lbtn lbtn-primary rl-join";
      join.textContent = "Entrar";
      const ple = r.nPlayers >= r.maxCap;
      if (ple) join.classList.add("rl-join-disabled");
      else join.classList.add("rl-join-attention");
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

// --- Netejar sales antigues --------------------------------------------------
export async function limpiarSalasAntiguas() {
  try {
    const snap = await get(ref(db, "rooms"));
    if (!snap.exists()) return;
    const ahora = Date.now();
    const borrados = [];
    snap.forEach((child) => {
      const data = child.val();
      const st = data.state;
      const la = data.lastActivity || 0;
      const inactiva = ahora - la > 3 * 60 * 1000;
      const finalizada = st?.status === "game_over";
      const preGameLobby =
        st?.status === "waiting" && real(st?.handNumber ?? OFFSET) === 0;
      const maxJ = st?.settings?.maxJugadores || 2;
      let n = 0;
      for (let i = 0; i < maxJ; i++) {
        if (st?.players?.[K(i)]) n++;
      }
      const salaTrencada =
        n === 1 && !preGameLobby && ahora - la > ORPHAN_ROOM_MAX_MS;
      if (inactiva || finalizada || salaTrencada) {
        borrados.push(remove(ref(db, `rooms/${child.key}`)));
      }
    });
    await Promise.all(borrados);
  } catch (e) {}
}

// --- Modals ------------------------------------------------------------------
let _openCreateRoomModal = () => {};
let _openPrivateCodeModal = (_mode) => {};
let _openLeaveConfirmModal = () => Promise.resolve(false);

export function openLeaveConfirmModal() {
  return _openLeaveConfirmModal();
}

export function initCreateRoomModal() {
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

export function initPrivateCodeModal() {
  const modal = $("privateCodeModal");
  const backdrop = $("privateCodeModalBackdrop");
  const cancel = $("privateCodeModalCancel");
  const submit = $("privateCodeModalSubmit");
  const input = $("privateCodeInput");
  const title = $("privateCodeModalTitle");
  const sub = $("privateCodeModalSub");
  if (!modal || !backdrop || !cancel || !submit || !input || !title || !sub)
    return;

  let mode = "join";

  const hide = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  _openPrivateCodeModal = (nextMode) => {
    mode = nextMode === "create" ? "create" : "join";
    const isCreate = mode === "create";
    title.textContent = isCreate
      ? "🔒 Crear sala privada"
      : "🔑 Unir-se a sala privada";
    sub.textContent = isCreate
      ? "Escriu el codi de la sala privada per crear-la."
      : "Escriu el codi de la sala privada per entrar.";
    submit.textContent = isCreate ? "Continuar" : "Unir-se";
    input.value = "";
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    input.focus();
  };

  const submitCode = () => {
    const code = sanitize(input.value);
    if (mode === "create") {
      _pendingCreateVisibility = "private";
      if (code.length < 2) {
        _pendingCreateVisibility = "public";
        setLobbyMsg("Codi massa curt.", "err");
        input.focus();
        return;
      }
      if ($("roomInput")) $("roomInput").value = code;
      hide();
      _openCreateRoomModal();
      return;
    }
    if (!code) {
      setLobbyMsg("Escriu un codi de sala.", "err");
      input.focus();
      return;
    }
    if ($("roomInput")) $("roomInput").value = code;
    hide();
    joinRoom();
  };

  cancel.addEventListener("click", () => {
    if (mode === "create") _pendingCreateVisibility = "public";
    hide();
  });
  backdrop.addEventListener("click", () => {
    if (mode === "create") _pendingCreateVisibility = "public";
    hide();
  });
  submit.addEventListener("click", submitCode);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitCode();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) {
      if (mode === "create") _pendingCreateVisibility = "public";
      hide();
    }
  });
}

export function initLeaveConfirmModal() {
  const modal = $("leaveConfirmModal");
  const backdrop = $("leaveConfirmModalBackdrop");
  const cancel = $("leaveConfirmModalCancel");
  const submit = $("leaveConfirmModalSubmit");
  if (!modal || !backdrop || !cancel || !submit) return;

  let resolver = null;

  const close = (accepted) => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    if (resolver) {
      resolver(Boolean(accepted));
      resolver = null;
    }
  };

  _openLeaveConfirmModal = () =>
    new Promise((resolve) => {
      resolver = resolve;
      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
      submit.focus();
    });

  cancel.addEventListener("click", () => close(false));
  submit.addEventListener("click", () => close(true));
  backdrop.addEventListener("click", () => close(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close(false);
  });
}

// Exposa globalment per a accés des de la llista de sales
export function openCreateRoomModal(visibility = "public") {
  _pendingCreateVisibility = visibility;
  if (visibility === "public" && $("roomInput")) $("roomInput").value = "";
  _openCreateRoomModal();
}
export function openPrivateCodeModal(mode) {
  _openPrivateCodeModal(mode);
}

export function initStatsModal() {
  const modal = $("statsModal");
  const backdrop = $("statsModalBackdrop");
  const closeBtn = $("statsModalClose");
  const openBtn = $("btn-estadisticas");

  if (!modal || !backdrop || !closeBtn || !openBtn) return;

  const hide = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  const show = async () => {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");

    // Reset while loading
    $("statsPlayed").textContent = "...";
    $("statsWon").textContent = "...";
    $("statsLost").textContent = "...";
    $("statsPoints").textContent = "...";
    $("statsStreak").textContent = "...";
    $("statsBestStreak").textContent = "...";
    $("statsWinRate").textContent = "...";

    const user = auth.currentUser;
    if (!user || user.isAnonymous) {
      $("statsPlayed").textContent = "0";
      $("statsWon").textContent = "0";
      $("statsLost").textContent = "0";
      $("statsPoints").textContent = "0";
      $("statsStreak").textContent = "0";
      $("statsBestStreak").textContent = "0";
      $("statsWinRate").textContent = "0%";
      return;
    }

    try {
      const docRef = doc(firestore, "players", user.uid);
      const docSnap = await getDoc(docRef);

      if (docSnap.exists()) {
        const data = docSnap.data();
        const played = data.gamesPlayed || 0;
        const won = data.gamesWon || 0;
        const winRate = played > 0 ? Math.round((won / played) * 100) : 0;
        $("statsPlayed").textContent = played;
        $("statsWon").textContent = won;
        $("statsLost").textContent = data.gamesLost || 0;
        $("statsPoints").textContent = data.totalPoints || 0;
        $("statsStreak").textContent = data.currentStreak || 0;
        $("statsBestStreak").textContent = data.bestStreak || 0;
        $("statsWinRate").textContent = `${winRate}%`;
      } else {
        $("statsPlayed").textContent = "0";
        $("statsWon").textContent = "0";
        $("statsLost").textContent = "0";
        $("statsPoints").textContent = "0";
        $("statsStreak").textContent = "0";
        $("statsBestStreak").textContent = "0";
        $("statsWinRate").textContent = "0%";
      }
    } catch (e) {
      console.error("Error loading stats:", e);
      $("statsPlayed").textContent = "-";
      $("statsWon").textContent = "-";
      $("statsLost").textContent = "-";
      $("statsPoints").textContent = "-";
      $("statsStreak").textContent = "-";
      $("statsBestStreak").textContent = "-";
      $("statsWinRate").textContent = "-";
    }
  };

  openBtn.addEventListener("click", () => {
    const user = auth.currentUser;
    if (user && !user.isAnonymous) {
      show();
    } else {
      openStatsPromoModal();
    }
  });
  closeBtn.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
}

let _openStatsPromoModal = () => {};
export function openStatsPromoModal() {
  _openStatsPromoModal();
}

export function initStatsPromoModal() {
  const modal = $("statsPromoModal");
  const backdrop = $("statsPromoModalBackdrop");
  const closeBtn = $("statsPromoModalClose");

  if (!modal || !backdrop || !closeBtn) return;

  const hide = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  _openStatsPromoModal = () => {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  };

  closeBtn.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
}

// --- Modal de Perfil ---------------------------------------------------------
let _openProfileModal = () => {};
let _openProfilePromoModal = () => {};

export function openProfileModal() {
  _openProfileModal();
}
export function openProfilePromoModal() {
  _openProfilePromoModal();
}

export function initProfilePromoModal() {
  const modal    = $("profilePromoModal");
  const backdrop = $("profilePromoModalBackdrop");
  const closeBtn = $("profilePromoModalClose");
  if (!modal || !backdrop || !closeBtn) return;

  const hide = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };
  _openProfilePromoModal = () => {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  };
  closeBtn.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
}

export function initProfileModal() {
  const modal    = $("profileModal");
  const backdrop = $("profileModalBackdrop");
  const closeBtn = $("profileModalClose");
  const cancelBtn = $("profileModalCancel");
  const submitBtn = $("profileModalSubmit");
  const nickInput = $("profileNickInput");
  if (!modal || !backdrop || !closeBtn || !cancelBtn || !submitBtn || !nickInput) return;

  const hide = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  // Funcions auxiliars per als selectors visuals del modal
  function _markActive(selector, activeVal) {
    modal.querySelectorAll(selector).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === activeVal);
    });
  }

  let _pendingNickData = null;

  function setMsg(html, isErr = false) {
    const el = $("profileNickMsg");
    if (!el) return;
    el.innerHTML = html;
    el.style.color = isErr ? "#f0a0a0" : "#a0f0a0";
  }

  function resetFlow() {
    setMsg("");
    const cm = $("nickConfirmModal");
    if (cm) { cm.classList.add("hidden"); cm.setAttribute("aria-hidden", "true"); }
    submitBtn.disabled = false;
    submitBtn.textContent = "💾 Guardar";
    nickInput.disabled = false;
    _pendingNickData = null;
  }

  _openProfileModal = () => {
    const u = auth.currentUser;
    if (!u || u.isAnonymous) {
      _openProfilePromoModal();
      return;
    }
    resetFlow();
    
    const prof = getProfile();
    const hintNickEl = $("profileNickCurrentHintNick");
    if (hintNickEl) {
      const dn = getDisplayNick();
      hintNickEl.textContent = dn == null ? "—" : String(dn);
    }
    nickInput.value = prof.nick || "";
    
    // Status cooldown
    const cd = getNickCooldownStatus();
    if (!cd.canChange) {
      setMsg(`⏳ Tensi cooldown actiu per canviar el nom. Et falten <b>${cd.daysLeft}</b> dies.`, true);
      nickInput.disabled = true;
    }

    const googleOpt = modal.querySelector(".prof-av-opt-google");
    const googleImg = modal.querySelector(".prof-av-opt-google-img");
    if (googleOpt) {
      const hasPhoto = !!(u && !u.isAnonymous && u.photoURL);
      googleOpt.classList.toggle("hidden", !hasPhoto);
      if (hasPhoto && googleImg) {
        googleImg.src = u.photoURL;
        googleImg.alt = "Foto Google";
      }
    }
    
    modal.querySelectorAll(".prof-av-opt").forEach((el) => {
      const d = el.dataset.av;
      if (d === "google") {
        el.classList.toggle("av-selected", prof.avatarId === "g");
      } else {
        const i = Number(d);
        el.classList.toggle("av-selected", prof.avatarId === i);
      }
    });
    
    _markActive(".prof-bg-opt", prof.tableBackground);
    _markActive(".prof-deck-opt", prof.cardDeck);

    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    if (cd.canChange) nickInput.focus();
  };

  // ... (esdeveniments d'avatar, fons, cartes es mantenen igual)
  modal.querySelectorAll(".prof-av-opt").forEach((el) => {
    el.addEventListener("click", () => {
      modal.querySelectorAll(".prof-av-opt").forEach((e) => e.classList.remove("av-selected"));
      el.classList.add("av-selected");
    });
  });

  modal.querySelectorAll(".prof-bg-opt").forEach((btn) => {
    btn.addEventListener("click", () => _markActive(".prof-bg-opt", btn.dataset.val));
  });

  modal.querySelectorAll(".prof-deck-opt").forEach((btn) => {
    btn.addEventListener("click", () => _markActive(".prof-deck-opt", btn.dataset.val));
  });

  // Pas 1: Validació
  submitBtn.addEventListener("click", async () => {
    const rawNick = nickInput.value.trim();
    const nick = rawNick.slice(0, 18) || null;
    const prof = getProfile();
    const curNick = prof.nick || "";
    const isNickChanging = nick !== null && nick.toLowerCase() !== curNick.toLowerCase();

    // Recopilar la resta de dades
    let avatarId = "g";
    const selectedAv = modal.querySelector(".prof-av-opt.av-selected");
    if (selectedAv) {
      const d = selectedAv.dataset.av;
      avatarId = d === "google" ? "g" : Number(d);
    }
    const selectedBg = modal.querySelector(".prof-bg-opt.active");
    const tableBackground = selectedBg?.dataset.val || prof.tableBackground;
    const selectedDeck = modal.querySelector(".prof-deck-opt.active");
    const cardDeck = selectedDeck?.dataset.val || prof.cardDeck;

    const dataToSave = { nick, avatarId, tableBackground, cardDeck };

    if (!isNickChanging) {
      // Guarda directe sense confirmació de nick
      await _executeSave(dataToSave);
      return;
    }

    // El nick canvia
    const cd = getNickCooldownStatus();
    if (!cd.canChange) {
      setMsg(`⏳ Ja has usat el teu canvi de nom. No podràs tornar a canviar-lo durant ${cd.daysLeft} dies.`, true);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Comprovant…";
    setMsg("Comprovant disponibilitat...");

    try {
      // 1. Unicitat (RTDB)
      const avail = await checkNickAvailability(nick);
      if (!avail.available) {
        setMsg("😅 Este nom ja l'està usant algú, prova'n un altre! 🤔", true);
        submitBtn.disabled = false;
        submitBtn.textContent = "💾 Guardar";
        return;
      }

      // 2. Moderació de contingut (Gemini) — fallback silenciós si l'API falla
      setMsg("Analitzant el nom...");
      const modResult = await checkNickModeration(nick);
      if (!modResult.allowed) {
        setMsg("Aquest malnom no està permès. Prova'n un altre! 🚫", true);
        submitBtn.disabled = false;
        submitBtn.textContent = "💾 Guardar";
        return;
      }

      // 3. Tot correcte — obrir modal de confirmació
      setMsg("");
      _pendingNickData = dataToSave;
      $("profileNickConfirmText").innerHTML =
        `Estàs segur que vols canviar el teu nom a <b>'${nick}'</b>?` +
        `<br><span style="font-size:0.85rem;opacity:0.75;">Recorda que no podràs tornar a canviar-lo fins d'ací a 30 dies. ✋</span>`;

      submitBtn.disabled = false;
      submitBtn.textContent = "💾 Guardar";

      const cm = $("nickConfirmModal");
      cm.classList.remove("hidden");
      cm.setAttribute("aria-hidden", "false");
      $("profileNickConfirmYes").focus();

    } catch (e) {
      setMsg("Error comprovant el nom. Torna a intentar-ho.", true);
      submitBtn.disabled = false;
      submitBtn.textContent = "💾 Guardar";
    }
  });

  // Pas 2: Confirmació (SÍ)
  $("profileNickConfirmYes")?.addEventListener("click", async () => {
    if (!_pendingNickData) return;
    const btn = $("profileNickConfirmYes");
    btn.disabled = true;
    btn.textContent = "Guardant…";
    try {
      await _executeSave(_pendingNickData);
    } finally {
      btn.disabled = false;
      btn.textContent = "✅ Confirmar";
    }
  });

  // Pas 2: Confirmació (NO)
  $("profileNickConfirmNo")?.addEventListener("click", () => {
    resetFlow();
  });

  // Execució real de guardat
  async function _executeSave(data) {
    try {
      await saveProfile(data);
      if (typeof window.syncProfileAvatarToMemory === "function") {
        window.syncProfileAvatarToMemory();
      }
      
      const nameEl = $("user-profile-name");
      const photoEl = $("user-profile-photo");
      const welcomeEl = $("lobbyWelcomeLine");
      const u = auth.currentUser;
      if (u) {
        const { getDisplayNick: gdn } = await import("./profile.js");
        const newNick = gdn();
        const currentProfile = getProfile();
        const currentAvatarSrc = srcFromChoice(currentProfile.avatarId);
        if (nameEl) nameEl.textContent = newNick;
        if (photoEl && currentAvatarSrc) {
          photoEl.src = currentAvatarSrc;
          photoEl.alt = newNick || "Jugador";
          photoEl.classList.remove("is-placeholder");
        }
        const nameInputEl = $("nameInput");
        if (nameInputEl) nameInputEl.value = newNick;
        if (welcomeEl) {
          welcomeEl.classList.remove("lobby-welcome-glow-play");
          welcomeEl.textContent = newNick
            ? `Benvingut al Truc de la Terreta, ${newNick}!`
            : "";
          if (newNick) {
            void welcomeEl.offsetWidth;
            welcomeEl.classList.add("lobby-welcome-glow-play");
          }
        }
      }
      const { refreshLiveProfileVisuals } = await import("./ui.js");
      refreshLiveProfileVisuals();
      // Tancar el modal de confirmació i el de perfil
      const cm = $("nickConfirmModal");
      if (cm) { cm.classList.add("hidden"); cm.setAttribute("aria-hidden", "true"); }
      hide();
    } catch (e) {
      if (e.message === "nick_taken") {
        setMsg("😅 Este nom ja l'està usant algú, prova'n un altre! 🤔", true);
        resetFlow();
      } else if (e.message === "nick_cooldown") {
        setMsg(`⏳ No pots canviar de nom encara. Et falten ${e.daysLeft} dies.`, true);
        resetFlow();
      } else {
        setMsg("S'ha produït un error inesperat.", true);
        resetFlow();
      }
    }
  }

  cancelBtn.addEventListener("click", hide);
  closeBtn.addEventListener("click", hide);
  backdrop.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
}
