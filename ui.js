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
  remove,
  onValue,
  onDisconnect,
  signInAnonymously,
  signOut,
  handSlotNeedsSecretReveal,
} from "./firebase.js";
import {
  defaultState,
  configureActions,
  ui,
  dealHand,
  goMazo,
  startOffer,
  requestRematch,
  guestReady,
} from "./acciones.js";
import { loadConfig, setConfig, applyConfig } from "./config.js";
import { clearAuthErr, showAuthErr, initAuthFlow } from "./auth.js";
import {
  setLobbyMsg,
  createRoom,
  createRoomAsBot,
  normName,
  joinRoom,
  loadRoomList,
  limpiarSalasAntiguas,
  initCreateRoomModal,
  initPrivateCodeModal,
  initLeaveConfirmModal,
  openLeaveConfirmModal,
  openCreateRoomModal,
  openPrivateCodeModal,
  configureLobby,
  changeSeat,
  initStatsModal,
  initStatsPromoModal,
} from "./lobby.js";
import { sndBtn } from "./audio.js";
import {
  stopConfetti,
  animateScreenShake,
} from "./animations.js";
import {
  initChat,
  sendChat,
  toggleChatPanel,
  togglePhraseMenu,
  hidePhraseMenu,
  onGameViewportChange,
  initPhraseListener,
  detachChatListeners,
  initLobbyChat,
  sendLobbyChat,
  detachLobbyChatListeners,
  toggleGameEmojiPicker,
  closeGameEmojiPicker,
  toggleLobbyEmojiPicker,
  closeLobbyEmojiPicker,
} from "./chat.js";
import {
  myAvatarChoice,
  configureAvatars,
  loadAvatarChoiceIntoMemory,
  applyAvatarSelectionVisualOnly,
  updateAvatarOptionRowsVisibility,
  syncAvatarPickAfterAuth,
  pickAvatar,
  firebaseValueForChoice,
} from "./avatars.js";
import {
  renderAll,
  getLastRoom,
  showTableMsg,
  showTableMsgLocal,
  resetHandIntroPlayed,
  configureRenderer,
  cancelPreGameRoomOnDisconnect,
  clearAbsenceTimers,
  getLastState,
  clearOptimisticCard,
} from "./renderGame.js";
import { isBotActive } from "./bot.js";
import { warmupMatchAssets } from "./assetPreloader.js";
import { isSpritesheetReady, spritesheetReady } from "./spritesheet.js";
let _actionInProgress = false;
const $ = (id) => document.getElementById(id);

function applyMatchConfig() {
  applyConfig();
  const table = $("table");
  const bgCfgSection = $("cfgTableBackgroundSection");
  const botMatch = isBotActive();
  if (table) {
    table.classList.remove("bg-bot");
    if (botMatch) {
      table.classList.forEach((cls) => {
        if (cls.startsWith("bg-")) table.classList.remove(cls);
      });
      table.classList.add("bg-bot");
    }
  }
  bgCfgSection?.classList.toggle("hidden", botMatch);
}

function setGuestAuthBusy(busy) {
  const overlay = $("guestAuthBusy");
  const btn = $("btn-invitado");
  if (overlay) {
    overlay.classList.toggle("hidden", !busy);
    overlay.setAttribute("aria-hidden", busy ? "false" : "true");
  }
  if (btn) {
    btn.disabled = !!busy;
    btn.setAttribute("aria-busy", busy ? "true" : "false");
  }
}

function offerCallText(kind, level) {
  if (kind === "envit") {
    if (level === "falta") return "Falta!!!";
    if (Number(level) >= 4) return "Torne a envidar!";
    return "Envide!";
  }
  if (kind === "truc") {
    if (Number(level) === 4) return "Val 4!!!";
    if (Number(level) === 3) return "Retruque!!";
    return "Truque!";
  }
  return "";
}
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
const allPlayed = (h) => {
  const n = h?.numSeats || 2;
  for (let i = 0; i < n; i++) { if (!alreadyPlayed(h, i)) return false; }
  return true;
};

const LS = { room: "truc_room", seat: "truc_seat", name: "truc_name" };
const ANON_NICK_STORAGE_PREFIX = "truc_anon_nick_";

const INACT_MS = 60 * 60 * 1000;
const OFFSET = 10; // scores/trickWins stored +10

// Audio: ac, tone, snd* — vegeu audio.js

// --- Session ------------------------------------------------------------------
let unsubGame = null,
  unsubStateStatus = null,
  unsubSecretHand = null,
  unsubBotSecretHand = null;
/** Evita que un render async antic després de `await` pise un snap més nou (cartes al centre, mà, etc.). */
let _wrappedRenderSeq = 0;
let _mySecretHand = null,
  _botSecretHand = null;
let inactTimer = null;
const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sanitize = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
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

// handleCredentialResponse, readGoogleClientId, initGoogleSignInButton,
// scheduleGoogleSignInInit, initAuthFlow, bumpStoredWinsIfWonGame -> auth.js

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
// setRing, stopTurnTimer, startTurnTimer — vegeu animations.js
async function startHandWithIntro(_state, _roomData = null) {
  ui.locked = true;
  $("waitingOverlay")?.classList.add("hidden");
  try {
    if (session.mySeat === 0) {
      await dealHand();
    }
  } finally {
    ui.locked = false;
  }
}

// Chat, avatars — vegeu chat.js i avatars.js
// --- Room ---------------------------------------------------------------------

let unsubMsg = null;
export function startSession(code) {
  // Tanca subs de sala anteriors (reconnexió / canvi de codi sense reload) per evitar callbacks duplicats i fugues.
  detachRoomListeners();

  session.roomCode = code;
  session.roomRef = ref(db, `rooms/${code}`);
  const cfg = loadConfig();
  warmupMatchAssets({
    deck: cfg.cardDeck || "classic",
    tableBackground: cfg.tableBackground || "verde",
    timeoutMs: 1,
  }).catch(() => {});

  // Sobreescribir nuestro avatar en Firebase al reconectar,
  // por si hay datos de una sesión anterior
  if (session.mySeat !== null) {
    set(
      ref(db, `rooms/${code}/avatars/${K(session.mySeat)}`),
      firebaseValueForChoice(myAvatarChoice),
    ).catch(() => {});
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

    applyMatchConfig();
    wrappedRenderAll(data);
  });

  if (session.mySeat !== null) {
    unsubSecretHand = onValue(ref(db, `secret_hands/${code}/hands/_${session.mySeat}`), (snap) => {
      _mySecretHand = snap.val() || null;
      session.secretHandMine = _mySecretHand;
      if (session.roomRef) {
        get(session.roomRef).then((s) => {
          if (s.exists() && session.roomCode === code) {
            wrappedRenderAll(s.val());
          }
        }).catch(() => {});
      }
    });

    if (isBotActive()) {
      unsubBotSecretHand = onValue(ref(db, `secret_hands/${code}/hands/_1`), (snap) => {
        _botSecretHand = snap.val() || null;
        session.botSecretHandForMutate = _botSecretHand;
        if (session.roomRef) {
          get(session.roomRef).then((s) => {
            if (s.exists() && session.roomCode === code) {
              wrappedRenderAll(s.val());
            }
          }).catch(() => {});
        }
      });
    }
  }

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
          wrappedRenderAll(s.val());
        })
        .catch(() => {});
    },
  );

  initChat(code);
  initPhraseListener(code);
  initLobbyChat(code);

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

export function detachRoomListeners() {
  _wrappedRenderSeq++;
  if (unsubGame) {
    unsubGame();
    unsubGame = null;
  }
  if (unsubStateStatus) {
    unsubStateStatus();
    unsubStateStatus = null;
  }
  if (unsubSecretHand) {
    unsubSecretHand();
    unsubSecretHand = null;
  }
  if (unsubBotSecretHand) {
    unsubBotSecretHand();
    unsubBotSecretHand = null;
  }
  _mySecretHand = null;
  _botSecretHand = null;
  session.secretHandMine = null;
  session.botSecretHandForMutate = null;
  clearOptimisticCard();
  if (unsubMsg) {
    unsubMsg();
    unsubMsg = null;
  }
  detachChatListeners();
  detachLobbyChatListeners();
  cancelPreGameRoomOnDisconnect();
  clearAbsenceTimers();
}

async function leaveRoom() {
  if (!session.roomCode || session.mySeat === null) {
    $("screenLobby").classList.remove("hidden");
    $("screenGame").classList.add("hidden");
    return;
  }
  const code = session.roomCode;
  const mySeat = session.mySeat;
  try {
    await remove(ref(db, `rooms/${code}/state/players/${K(mySeat)}`));
    await remove(ref(db, `rooms/${code}/presence/${K(mySeat)}`)).catch(
      () => {},
    );
    await remove(ref(db, `rooms/${code}/avatars/${K(mySeat)}`)).catch(() => {});
  } catch (e) {}
  detachRoomListeners();
  resetSession();
  localStorage.removeItem(LS.room);
  localStorage.removeItem(LS.seat);
  stopConfetti();
  $("waitingOverlay")?.classList.add("hidden");
  $("gameOverOverlay")?.classList.add("hidden");
  $("screenLobby").classList.remove("hidden");
  $("screenGame").classList.add("hidden");
}

function initLegalModal() {
  const modal = $("legalModal");
  const backdrop = $("legalModalBackdrop");
  const closeBtn = $("legalModalClose");
  const openBtn = $("legalOpenBtn");
  if (!modal) return;
  const open = () => modal.classList.remove("hidden");
  const close = () => modal.classList.add("hidden");
  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
}

function openWhatsappInvite() {
  const code = String(session.roomCode || "").trim().toUpperCase();
  if (!code) {
    setLobbyMsg("No s'ha pogut generar la invitació de la sala.", "err");
    return;
  }
  const roomUrl = `${location.origin}${location.pathname}?sala=${encodeURIComponent(code)}`;
  const msg = `Ens falta un jugador! Fem un Truc? 👉🏼 ${roomUrl}`;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, "_blank", "noopener,noreferrer");
}

export async function tryJoinRoomFromInviteLink() {
  const params = new URLSearchParams(location.search);
  const inviteCode = sanitize(params.get("sala") || "");
  if (!inviteCode || session.roomCode) return false;
  const roomInput = $("roomInput");
  if (roomInput) roomInput.value = inviteCode;
  await joinRoom();
  history.replaceState(null, "", `${location.origin}${location.pathname}`);
  return true;
}

// Re-exportació per a game.js (importa syncAvatarPickAfterAuth des d'ací)
export { syncAvatarPickAfterAuth };

const wrappedRenderAll = async (data) => {
  const seq = ++_wrappedRenderSeq;
  if (!isSpritesheetReady()) {
    await Promise.race([
      spritesheetReady,
      new Promise((res) => setTimeout(res, 3000)),
    ]);
  }
  if (seq !== _wrappedRenderSeq) return;
  if (data?.state?.hand?.hands) {
    const hnRoom = Number(data.state.handNumber);
    const seatK =
      session.mySeat !== null ? `_${session.mySeat}` : null;
    if (
      seatK &&
      _mySecretHand &&
      Number(_mySecretHand.hn) === hnRoom &&
      handSlotNeedsSecretReveal(data.state.hand.hands[seatK])
    ) {
      data.state.hand.hands[seatK] = {
        a: _mySecretHand.a,
        b: _mySecretHand.b,
        c: _mySecretHand.c,
      };
    }
    if (
      isBotActive() &&
      _botSecretHand &&
      Number(_botSecretHand.hn) === hnRoom &&
      handSlotNeedsSecretReveal(data.state.hand.hands["_1"])
    ) {
      data.state.hand.hands["_1"] = {
        a: _botSecretHand.a,
        b: _botSecretHand.b,
        c: _botSecretHand.c,
      };
    }
  }
  if (seq !== _wrappedRenderSeq) return;
  renderAll(data);
};

export function initApp() {
  configureActions({
    renderAll: wrappedRenderAll,
    renderAllLastRoom: () => { const lr = getLastRoom(); if (lr) renderAll(lr); },
  });
  configureAvatars({ renderAll: wrappedRenderAll });
  configureLobby({ startSession });
  configureRenderer({ resetInactivity });
  initAuthFlow();
  initLegalModal();
  initCreateRoomModal();
  initPrivateCodeModal();
  initLeaveConfirmModal();
  initStatsModal();
  initStatsPromoModal();
  limpiarSalasAntiguas(); // sin await, que corra en segundo plano
  $("btn-crear-publica")?.addEventListener("click", () =>
    openCreateRoomModal("public"),
  );
  $("btn-crear-privada")?.addEventListener("click", () =>
    openPrivateCodeModal("create"),
  );
  $("btn-unirse-codigo")?.addEventListener("click", () =>
    openPrivateCodeModal("join"),
  );
  $("botBtn")?.addEventListener("click", async () => {
    const name = normName($("nameInput")?.value);
    await createRoomAsBot(name);
  });
  $("btn-invitado")?.addEventListener("click", async () => {
    if ($("btn-invitado")?.disabled) return;
    clearAuthErr();
    setGuestAuthBusy(true);
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
    } finally {
      setGuestAuthBusy(false);
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
  $("leaveBtn").addEventListener("click", async () => {
    const wantsToLeave = await openLeaveConfirmModal();
    if (!wantsToLeave) return;
    await leaveRoom();
  });
  $("goLeaveBtn").addEventListener("click", leaveRoom);
  $("backToMainBtn")?.addEventListener("click", async () => {
    sndBtn();
    await leaveRoom();
  });
  $("goRematchBtn")?.addEventListener("click", requestRematch);
  $("waitingInviteWhatsappBtn")?.addEventListener("click", openWhatsappInvite);
  // Menú de frases: només el propi avatar (myZone); cada jugador ve el seu com a #myAvatarContainer
  const onPhraseAvatarTap = (e) => {
    e.preventDefault();
    togglePhraseMenu();
  };
  $("myAvatarContainer")?.addEventListener("click", togglePhraseMenu);
  $("myAvatarContainer")?.addEventListener("touchend", onPhraseAvatarTap);

  window.addEventListener("resize", onGameViewportChange);
  window.visualViewport?.addEventListener("resize", onGameViewportChange);
  window.visualViewport?.addEventListener("scroll", onGameViewportChange);

  // Tancar el menú si es fa clic fora (no cal excloure rival per obrir; només my obre)
  document.addEventListener("click", (e) => {
    const myW = $("myAvatarContainer");
    const pm = $("myPhraseMenu");
    if (myW?.contains(e.target)) return;
    if (pm?.contains(e.target)) return;
    hidePhraseMenu();
  });

  async function onPlayerReadyClick() {
    if (ui.locked) return;
    ui.locked = true;
    sndBtn();
    try {
      await guestReady();
    } finally {
      setTimeout(() => {
        ui.locked = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) wrappedRenderAll(snap.val());
          })
          .catch(() => {});
      }, 200);
    }
  }
  $("guestReadyBtn")?.addEventListener("click", onPlayerReadyClick);
  $("hostReadyBtn")?.addEventListener("click", onPlayerReadyClick);

  $("startBtn").addEventListener("click", async () => {
    if (ui.locked) return;
    sndBtn();
    const cfg = loadConfig();
    await warmupMatchAssets({
      deck: cfg.cardDeck || "classic",
      tableBackground: cfg.tableBackground || "verde",
      timeoutMs: 1800,
    });
    let roomData = null;
    let state = getLastState();
    if (!state && session.roomRef) {
      try {
        const snap = await get(session.roomRef);
        roomData = snap.val() || null;
        state = roomData?.state ?? defaultState();
      } catch {
        state = defaultState();
      }
    }
    if (!roomData && session.roomRef) {
      try {
        const snap = await get(session.roomRef);
        roomData = snap.val() || null;
      } catch {}
    }
    if (!state) state = defaultState();
    await startHandWithIntro(state, roomData);
  });

  // --- NUEVO: Configuración -------------------------------------------------
  applyMatchConfig();

  $("configBtn").addEventListener("click", () => {
    applyMatchConfig();
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
      applyMatchConfig();
      // Actualiza visual de botones activos en esa sección
      document.querySelectorAll(`.cfg-opt[data-cfg="${key}"]`).forEach((b) => {
        b.classList.toggle("active", b.dataset.val === String(val));
      });
    });
  });
  // --------------------------------------------------------------------------

  /* Botones de acció principals — amb guard antidoble-click */
  $("envitBtn").onclick = async () => {
    if (ui.locked) return;
    ui.locked = true;
    sndBtn();
    showTableMsg(offerCallText("envit", 2), true);
    try {
      await startOffer("envit");
    } finally {
      setTimeout(() => {
        ui.locked = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) wrappedRenderAll(snap.val());
          })
          .catch(() => {});
      }, 600);
    }
  };
  $("faltaBtn").onclick = async () => {
    if (ui.locked) return;
    ui.locked = true;
    sndBtn();
    animateScreenShake("high");
    showTableMsg(offerCallText("envit", "falta"), true);
    try {
      await startOffer("falta");
    } finally {
      setTimeout(() => {
        ui.locked = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) wrappedRenderAll(snap.val());
          })
          .catch(() => {});
      }, 600);
    }
  };
  $("trucBtn").onclick = async () => {
    if (ui.locked) return;
    ui.locked = true;
    sndBtn();
    const trucBtnLabel = String($("trucBtn").textContent || "").trim();
    const trucLevel = /val\s*4/i.test(trucBtnLabel)
      ? 4
      : /retruc/i.test(trucBtnLabel)
        ? 3
        : 2;
    if (trucLevel === 4) animateScreenShake("high");
    else if (trucLevel === 3) animateScreenShake("low");
    showTableMsg(offerCallText("truc", trucLevel), true);
    try {
      await startOffer("truc");
    } finally {
      setTimeout(() => {
        ui.locked = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) wrappedRenderAll(snap.val());
          })
          .catch(() => {});
      }, 600);
    }
  };
  $("mazoBtn").onclick = async () => {
    if (ui.locked) return;
    ui.locked = true;
    sndBtn();
    showTableMsg("Me'n vaig!", true);
    try {
      await goMazo();
    } finally {
      setTimeout(() => {
        ui.locked = false;
        get(session.roomRef)
          .then((snap) => {
            if (snap?.val()) wrappedRenderAll(snap.val());
          })
          .catch(() => {});
      }, 600);
    }
  };

  $("logToggle").addEventListener("click", () => {
    const b = $("logBody");
    b.classList.toggle("hidden");
    $("logToggle").textContent = b.classList.contains("hidden")
      ? "> Registro"
      : "v Registro";
  });
  $("chatToggle").addEventListener("click", toggleChatPanel);
  $("chatSend").addEventListener("click", sendChat);
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });
  // Botó emoji del chat de partida
  $("gameEmojiBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleGameEmojiPicker();
  });
  // Tancar emoji picker de partida en clic fora
  document.addEventListener("click", (e) => {
    const picker = $("gameEmojiPicker");
    const btn = $("gameEmojiBtn");
    if (picker && !picker.contains(e.target) && e.target !== btn) {
      closeGameEmojiPicker();
    }
  });
  // Chat pre-partida (lobby/waiting)
  $("lobbyEmojiBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLobbyEmojiPicker();
  });
  $("lobbyChat_Send")?.addEventListener("click", sendLobbyChat);
  $("lobbyChatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendLobbyChat(); }
  });
  // Tancar emoji picker de lobby en clic fora
  document.addEventListener("click", (e) => {
    const picker = $("lobbyEmojiPicker");
    const btn = $("lobbyEmojiBtn");
    if (picker && !picker.contains(e.target) && e.target !== btn) {
      closeLobbyEmojiPicker();
    }
  });
  const avatarPickerModal = $("avatarPickerModal");
  const avatarPickerBackdrop = $("avatarPickerModalBackdrop");
  const avatarPickerClose = $("avatarPickerModalClose");
  const openAvatarPickerModal = () => {
    if (!avatarPickerModal) return;
    avatarPickerModal.classList.remove("hidden");
    avatarPickerModal.setAttribute("aria-hidden", "false");
  };
  const closeAvatarPickerModal = () => {
    if (!avatarPickerModal) return;
    avatarPickerModal.classList.add("hidden");
    avatarPickerModal.setAttribute("aria-hidden", "true");
  };
  avatarPickerClose?.addEventListener("click", closeAvatarPickerModal);
  avatarPickerBackdrop?.addEventListener("click", closeAvatarPickerModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && avatarPickerModal && !avatarPickerModal.classList.contains("hidden")) {
      closeAvatarPickerModal();
    }
  });

  document.querySelectorAll(".av-opt").forEach((el) => {
    el.addEventListener("click", () => {
      const raw = el.dataset.av;
      if (raw === "google") pickAvatar("google");
      else if (raw === "guest") pickAvatar("guest");
      else {
        const i = Number(raw);
        if (Number.isFinite(i)) pickAvatar(i);
      }
      closeAvatarPickerModal();
    });
  });
  [0, 1, 2, 3].forEach((seatIndex) => {
    const btn = document.getElementById(`waitSlotChangeAvatarBtn${seatIndex}`);
    const av = document.getElementById(`waitSlotGameAv${seatIndex}`);
    const openIfMine = () => {
      if (session.mySeat !== seatIndex) return;
      openAvatarPickerModal();
    };
    btn?.addEventListener("click", openIfMine);
    av?.addEventListener("click", openIfMine);
  });
  
  // Botons "Sentar-se ací" per al 2v2
  [0, 1, 2, 3].forEach(seatIndex => {
    const btn = document.getElementById(`waitSlotSitBtn${seatIndex}`);
    if (btn) {
      btn.addEventListener("click", async () => {
        if (ui.locked) return;
        ui.locked = true;
        sndBtn();
        try {
          await changeSeat(seatIndex);
        } finally {
          ui.locked = false;
        }
      });
    }
  });

  loadAvatarChoiceIntoMemory();
  updateAvatarOptionRowsVisibility();
  applyAvatarSelectionVisualOnly();
  loadLS();
  loadRoomList();
}
