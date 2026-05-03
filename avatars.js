// --- avatars.js — Selecció i renderitzat d'avatars ---------------------------
import { auth, db, session, ref, set, get } from "./firebase.js";
import { isBotActive } from "./bot.js";
import { getNumSeats, opponents, teammates } from "./teams.js";

const K = (n) => `_${n}`;

// Injecció de renderAll per a sincronització post-auth (igual que configureActions)
let _renderAll = null;
export function configureAvatars(deps) {
  _renderAll = deps.renderAll;
}

// --- Constants ----------------------------------------------------------------
export const AVATAR_IMAGES = [
  "Media/Images/Avatars/Avatar4.png",
  "Media/Images/Avatars/Avatar3.png",
  "Media/Images/Avatars/Avatar1.png",
  "Media/Images/Avatars/Avatar14.png",
  "Media/Images/Avatars/Avatar16.png",
  "Media/Images/Avatars/Avatar6.png",
  "Media/Images/Avatars/Avatar7.png",
  "Media/Images/Avatars/Avatar5.png",
];
export const GUEST_LOBBY_AVATAR =
  "Media/Images/Others/avatar-convidat.webp";
export const BOT_AVATAR = "Media/Images/Avatars/avatar-robot.webp";

/** @typedef {"g"|"guest"|number} AvatarChoice */

// --- Estat intern -------------------------------------------------------------
/** @type {AvatarChoice} */
export let myAvatarChoice = "guest";
let _rivalAvatarIdx = -1;

// --- Helpers purs ------------------------------------------------------------
export function clampAvatarIdx(n) {
  const i = Number(n);
  if (!Number.isFinite(i)) return 0;
  return Math.min(AVATAR_IMAGES.length - 1, Math.max(0, Math.floor(i)));
}

export function hasGooglePhoto() {
  const u = auth.currentUser;
  return !!(u && !u.isAnonymous && u.photoURL);
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** URL final per a render (taula / pre-partida) */
export function srcFromChoice(ch) {
  if (ch === "g") return auth.currentUser?.photoURL || "";
  if (ch === "guest") return GUEST_LOBBY_AVATAR;
  if (typeof ch === "number" && ch >= 0 && ch < AVATAR_IMAGES.length)
    return AVATAR_IMAGES[ch];
  return "";
}

/** Escriu a RTDB: URL Google o ruta d'asset (mai índex numèric) */
export function firebaseValueForChoice(ch) {
  if (ch === "g") {
    const url = auth.currentUser?.photoURL;
    return url || AVATAR_IMAGES[0];
  }
  if (ch === "guest") return GUEST_LOBBY_AVATAR;
  if (typeof ch === "number" && ch >= 0 && ch < AVATAR_IMAGES.length)
    return AVATAR_IMAGES[ch];
  return AVATAR_IMAGES[0];
}

/** Llegeix valor de sala (nombre antic, URL o path) → URL per a img.src */
export function srcFromFirebaseAvatar(val) {
  if (val === null || val === undefined) return "";
  if (typeof val === "number") {
    if (val >= 0 && val < AVATAR_IMAGES.length) return AVATAR_IMAGES[val];
    return "";
  }
  if (typeof val === "string") {
    const t = val.trim();
    if (!t) return "";
    if (/^https?:\/\//i.test(t)) return t;
    if (t === GUEST_LOBBY_AVATAR) return t;
    return t;
  }
  return "";
}

export function avatarImgHtml(src) {
  if (!src) return "";
  return `<img src="${escAttr(src)}" alt="" decoding="async">`;
}

/** Per a conflicte «mateix dibuix que el rival» */
export function drawingIndexFromFirebase(val) {
  if (val === null || val === undefined) return -1;
  if (typeof val === "number")
    return val >= 0 && val < AVATAR_IMAGES.length ? val : -1;
  if (typeof val === "string") {
    const t = val.trim();
    if (!t) return -1;
    if (/^https?:\/\//i.test(t)) return -1;
    if (t === GUEST_LOBBY_AVATAR) return -1;
    const j = AVATAR_IMAGES.indexOf(t);
    if (j >= 0) return j;
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0 && n < AVATAR_IMAGES.length) return n;
  }
  return -1;
}

// --- Persistència i càrrega --------------------------------------------------
export function loadAvatarChoiceIntoMemory() {
  const u = auth.currentUser;
  if (!u || u.isAnonymous) {
    const raw = localStorage.getItem("truc_avatar");
    if (raw === "guest") {
      myAvatarChoice = "guest";
      return;
    }
    if (raw && /^[0-7]$/.test(raw)) {
      myAvatarChoice = Number(raw);
      return;
    }
    myAvatarChoice = "guest";
    return;
  }
  const sel = localStorage.getItem("truc_avatar_sel");
  if (sel === "g" && u.photoURL) {
    myAvatarChoice = "g";
    return;
  }
  if (sel && /^[0-7]$/.test(sel)) {
    myAvatarChoice = Number(sel);
    return;
  }
  if (u.photoURL) {
    myAvatarChoice = "g";
    return;
  }
  myAvatarChoice = clampAvatarIdx(localStorage.getItem("truc_avatar") || 0);
}

export function persistAvatarChoice() {
  const u = auth.currentUser;
  if (!u || u.isAnonymous) {
    if (myAvatarChoice === "guest") {
      localStorage.setItem("truc_avatar", "guest");
      localStorage.removeItem("truc_avatar_sel");
      return;
    }
    const idx = typeof myAvatarChoice === "number" ? myAvatarChoice : 0;
    localStorage.setItem("truc_avatar", String(idx));
    localStorage.removeItem("truc_avatar_sel");
    return;
  }
  if (myAvatarChoice === "g") {
    localStorage.setItem("truc_avatar_sel", "g");
    localStorage.setItem("truc_avatar", "0");
    return;
  }
  localStorage.setItem("truc_avatar_sel", String(myAvatarChoice));
  localStorage.setItem("truc_avatar", String(myAvatarChoice));
}

export function updateAvatarOptionRowsVisibility() {
  const googleEl = document.querySelector(".av-opt-google");
  const guestEl = document.querySelector(".av-opt-guest");
  const im = googleEl?.querySelector(".av-opt-google-img");
  const u = auth.currentUser;
  const googleShow = !!(u && !u.isAnonymous && u.photoURL);
  const guestShow = !!(u && u.isAnonymous);
  if (googleEl) googleEl.classList.toggle("hidden", !googleShow);
  if (guestEl) guestEl.classList.toggle("hidden", !guestShow);
  if (im && googleShow && u?.photoURL) {
    im.src = u.photoURL;
    im.alt = "Foto Google";
  }
}

export function applyAvatarSelectionVisualOnly() {
  updateAvatarOptionRowsVisibility();
  document.querySelectorAll(".av-opt").forEach((el) => {
    const d = el.dataset.av;
    if (d === "google")
      el.classList.toggle("av-selected", myAvatarChoice === "g");
    else if (d === "guest")
      el.classList.toggle("av-selected", myAvatarChoice === "guest");
    else {
      const i = Number(d);
      if (Number.isFinite(i))
        el.classList.toggle("av-selected", myAvatarChoice === i);
    }
  });
}

/** Cridat des de game.js quan canvia l'estat d'auth (Google vs convidat). */
export function syncAvatarPickAfterAuth() {
  loadAvatarChoiceIntoMemory();
  if (myAvatarChoice === "g" && !hasGooglePhoto())
    myAvatarChoice = auth.currentUser?.isAnonymous
      ? "guest"
      : clampAvatarIdx(localStorage.getItem("truc_avatar") || 0);
  if (
    myAvatarChoice === "guest" &&
    (!auth.currentUser || !auth.currentUser.isAnonymous)
  ) {
    myAvatarChoice = hasGooglePhoto()
      ? "g"
      : clampAvatarIdx(localStorage.getItem("truc_avatar") || 0);
  }
  persistAvatarChoice();
  applyAvatarSelectionVisualOnly();
  const code = session.roomCode;
  if (!code || session.mySeat === null) return;
  set(
    ref(db, `rooms/${code}/avatars/${K(session.mySeat)}`),
    firebaseValueForChoice(myAvatarChoice),
  ).catch(() => {});
  get(ref(db, `rooms/${code}`))
    .then((s) => {
      if (s.exists() && session.roomCode === code && _renderAll)
        _renderAll(s.val());
    })
    .catch(() => {});
}

export function pickAvatar(arg) {
  let next;
  if (arg === "google" || arg === "g") {
    if (!hasGooglePhoto()) return;
    next = "g";
  } else if (arg === "guest") {
    if (!auth.currentUser?.isAnonymous) return;
    next = "guest";
  } else {
    const idx = Number(arg);
    if (!Number.isFinite(idx) || idx < 0 || idx >= AVATAR_IMAGES.length)
      return;
    next = idx;
  }
  if (
    typeof next === "number" &&
    next === _rivalAvatarIdx &&
    _rivalAvatarIdx >= 0
  )
    return;
  myAvatarChoice = next;
  persistAvatarChoice();
  applyAvatarSelectionVisualOnly();
  if (session.roomRef && session.mySeat !== null) {
    set(
      ref(db, `rooms/${session.roomCode}/avatars/${K(session.mySeat)}`),
      firebaseValueForChoice(myAvatarChoice),
    ).catch(() => {});
    const w = document.getElementById(`waitSlotGameAv${session.mySeat}`);
    if (w) {
      const inner = avatarImgHtml(srcFromChoice(myAvatarChoice));
      w.innerHTML = inner;
      w.classList.toggle("slot-game-av-empty", !inner.trim());
    }
  }
}

// --- Render d'avatars ---------------------------------------------------------
export function renderWaitingSlots(room, state) {
  const avs = room?.avatars || {};
  const srcSelf = srcFromChoice(myAvatarChoice);
  const numSeats = getNumSeats(state);
  for (let seat = 0; seat < numSeats; seat++) {
    const ph = document.getElementById(`waitSlotPhoto${seat}`);
    const nm = document.getElementById(`waitSlotName${seat}`);
    const gav = document.getElementById(`waitSlotGameAv${seat}`);
    const bd = document.getElementById(`waitSlotBadge${seat}`);
    if (!ph || !nm || !gav || !bd) continue;

    const sitBtn = document.getElementById(`waitSlotSitBtn${seat}`);
    const changeAvBtn = document.getElementById(`waitSlotChangeAvatarBtn${seat}`);
    const is2v2 = numSeats === 4;
    const isMySeat = session.mySeat === seat;

    const pl = state?.players?.[K(seat)];
    const pName = (st, s) =>
      st?.players?.[K(s)]?.name || `Jugador ${s}`;
    if (!pl) {
      ph.src = GUEST_LOBBY_AVATAR;
      ph.classList.add("is-empty-slot");
      ph.alt = "";
      nm.textContent = "—";
      gav.innerHTML = "";
      gav.classList.add("slot-game-av-empty");
      gav.classList.remove("slot-game-av-is-mine");
      if (changeAvBtn) changeAvBtn.classList.add("hidden");
      
      if (sitBtn && is2v2 && session.mySeat !== seat) {
        sitBtn.classList.remove("hidden");
        bd.classList.add("hidden");
      } else {
        if (sitBtn) sitBtn.classList.add("hidden");
        bd.classList.remove("hidden");
        bd.textContent = "Pendent...";
        bd.dataset.state = "pendent";
        bd.classList.remove("slot-badge-ready");
      }
      continue;
    }
    
    if (sitBtn) sitBtn.classList.add("hidden");
    bd.classList.remove("hidden");
    ph.classList.remove("is-empty-slot");
    nm.textContent = pName(state, seat);
    ph.src = pl.photoURL || GUEST_LOBBY_AVATAR;
    ph.alt = pName(state, seat);
    gav.classList.toggle("slot-game-av-is-mine", isMySeat);
    if (changeAvBtn) changeAvBtn.classList.toggle("hidden", !isMySeat);

    const src =
      session.mySeat === seat ? srcSelf : srcFromFirebaseAvatar(avs[K(seat)]);
    gav.classList.remove("slot-game-av-empty");
    gav.innerHTML = avatarImgHtml(src);
    if (!String(gav.innerHTML).trim()) gav.classList.add("slot-game-av-empty");

    if (isBotActive()) {
      bd.classList.add("hidden");
      bd.classList.remove("slot-badge-ready");
      bd.textContent = "";
      delete bd.dataset.state;
    } else {
      bd.classList.remove("hidden");
      const isReady = !!state.ready?.[K(seat)];
      bd.classList.toggle("slot-badge-ready", isReady);
      if (isReady) {
        bd.textContent = "✅ Preparat!";
        bd.dataset.state = "ready";
      } else {
        bd.textContent = "Triant avatar...";
        bd.dataset.state = "picking";
      }
    }
  }
}

// Exposa globalment per a onclick HTML
window.pickAvatar = pickAvatar;

export function renderAvatars(room) {
  const state = room?.state;
  const avs = room?.avatars || {};
  const opps = opponents(session.mySeat, state);
  const rawRiv = opps.length > 0 ? avs[K(opps[0])] : null;
  _rivalAvatarIdx = drawingIndexFromFirebase(rawRiv);
  const myEl = document.getElementById("myAv");
  const rivEl = document.getElementById("rivalAv");

  if (myEl) myEl.innerHTML = avatarImgHtml(srcFromChoice(myAvatarChoice));
  if (rivEl) rivEl.innerHTML = avatarImgHtml(srcFromFirebaseAvatar(rawRiv));

  // 2v2: renderitzar avatars del company i rival dret
  const tmEl = document.getElementById("teammateAv");
  const rrEl = document.getElementById("rivalRightAv");
  const tms = teammates(session.mySeat, state).filter(s => s !== session.mySeat);
  if (tmEl && tms.length > 0) {
    tmEl.innerHTML = avatarImgHtml(srcFromFirebaseAvatar(avs[K(tms[0])]));
  }
  if (opps.length > 1 && rrEl) {
    rrEl.innerHTML = avatarImgHtml(srcFromFirebaseAvatar(avs[K(opps[1])]));
  }

  document.querySelectorAll(".av-opt").forEach((el) => {
    const d = el.dataset.av;
    if (d === "google" || d === "guest") {
      el.classList.remove("av-taken");
      el.style.opacity = "1";
      el.title = "";
      return;
    }
    const i = Number(d);
    if (!Number.isFinite(i)) return;
    const takenByRival = i === _rivalAvatarIdx && _rivalAvatarIdx >= 0;
    el.classList.toggle("av-taken", takenByRival);
    el.style.opacity = takenByRival ? "0.3" : "1";
    el.title = takenByRival ? "Aquest avatar l'usa el teu rival" : "";
  });
}
