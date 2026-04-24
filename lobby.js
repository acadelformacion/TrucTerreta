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
} from "./firebase.js";
import { defaultState } from "./acciones.js";
import * as Logica from "./logica.js";
import { GUEST_LOBBY_AVATAR } from "./avatars.js";
import { auth } from "./firebase.js";
import { initBot, setBotActive, resetBotMemory } from "./bot.js";

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
  if (u.isAnonymous) return { guest: true };
  const o = {};
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
export async function createRoom() {
  setBotActive(false);
  resetBotMemory();
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
    const inactiva = Date.now() - lastActivity > 10 * 60 * 1000;
    const finalizada = estado === "game_over";
    const sinJugadores =
      !data.state?.players?.[K(0)] || !data.state?.players?.[K(1)];
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
  setLobbyMsg("", "");
  _pendingCreateVisibility = "public";
  _startSession(code);
  return true;
}

export async function createRoomAsBot(name) {
  const vis = "private";
  const botName = "🤖 Bot";
  const humanName = normName(name);
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
    const sinJugadores =
      !data.state?.players?.[K(0)] || !data.state?.players?.[K(1)];
    if (inactiva || finalizada || sinJugadores) {
      await remove(r);
    } else {
      setLobbyMsg("Sala ja existeix.", "err");
      return false;
    }
  }

  const settings = { ..._pendingRoomSettings };
  const init = defaultState();
  init.roomCode = code;
  init.settings = { ...settings };
  init.players[K(0)] = {
    name: humanName,
    clientId: uid(),
    ...authPlayerExtras(),
  };
  init.players[K(1)] = {
    name: botName,
    clientId: uid(),
    guest: true,
  };
  init.ready = init.ready || {};
  init.ready[K(1)] = true;
  init.logs = [{ text: `Sala creada per ${humanName}.`, at: Date.now() }];

  await set(r, {
    meta: { createdAt: Date.now(), roomCode: code, visibility: vis },
    settings,
    state: init,
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
  setLobbyMsg(`Unit com J${session.mySeat}.`, "good");
  _startSession(code);
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
        const p0 = st.players?.[K(0)];
        if (!p0) continue;
        const p1 = st.players?.[K(1)];
        const nPlayers = (p0 ? 1 : 0) + (p1 ? 1 : 0);
        const preGameLobby =
          st.status === "waiting" && real(st.handNumber ?? OFFSET) === 0;
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
      const inactiva = ahora - la > 30 * 60 * 1000;
      const finalizada = st?.status === "game_over";
      const preGameLobby =
        st?.status === "waiting" && real(st?.handNumber ?? OFFSET) === 0;
      const p0 = st?.players?.[K(0)];
      const p1 = st?.players?.[K(1)];
      const n = (p0 ? 1 : 0) + (p1 ? 1 : 0);
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
