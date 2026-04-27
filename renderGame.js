// --- renderGame.js — Motor de renderizado visual ------------------------------
import { db, session, ref, get, set, onDisconnect, remove } from "./firebase.js";
import * as Logica from "./logica.js";
import {
  defaultState,
  ui,
  dealHand,
  playCard,
  startOffer,
  respondEnvit,
  respondTruc,
  playCardAsBot,
  startOfferAsBot,
  respondEnvitAsBot,
  respondTrucAsBot,
  goMazo,
  claimWinByRivalAbsence,
  registerRivalAbsence,
} from "./acciones.js";
import { sndCard, sndBtn, sndTick, sndWin, sndLose, detectSounds } from "./audio.js";
import {
  animateHUDPoints,
  playVersusIntro,
  playCenterTableMessage,
  animateRivalActionTableMsg,
  animatePlay,
  animateMyHandDealFromDeck,
  startTurnTimer,
  stopTurnTimer,
  playGameOverPresentation,
  stopConfetti,
  animateRivalPlay,
  animateScreenShake,
  animateTrickCollect,
  setupHoverDynamics
} from "./animations.js";
import { syncOfferBubblesFromState, showBubble } from "./chat.js";
import {
  AVATAR_IMAGES,
  myAvatarChoice,
  loadAvatarChoiceIntoMemory,
  srcFromChoice,
  srcFromFirebaseAvatar,
  renderAvatars,
  renderWaitingSlots,
} from "./avatars.js";
import { bumpStoredWinsIfWonGame } from "./auth.js";
import { setLobbyMsg } from "./lobby.js";
import { isVibrationEnabled } from "./config.js";
import { isBotActive, botAct, resetBotMemory, updateBotMemory } from "./bot.js";

// --- Helpers locales ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const K = (n) => `_${n}`;
const PK = (n) => `p${n}`;
const HKEYS = ["a", "b", "c"];
const EMPTY_CARD = "~";
const OFFSET = 10;

const fromHObj = (obj) => {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) return obj.filter((c) => c && c !== EMPTY_CARD);
  return HKEYS.map((k) => obj[k]).filter((c) => c && c !== EMPTY_CARD);
};
const getPlayed = (h, seat) => {
  const v = h?.played?.[PK(seat)];
  return v && v !== EMPTY_CARD ? v : null;
};
const alreadyPlayed = (h, seat) => getPlayed(h, seat) !== null;
const bothPlayed = (h) => alreadyPlayed(h, 0) && alreadyPlayed(h, 1);
const other = (s) => (s === 0 ? 1 : 0);
const real = (n) => Number(n || OFFSET) - OFFSET;
const ICO_STONE =
  '<svg class="rl-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><ellipse cx="12" cy="14" rx="7" ry="5.5" fill="currentColor" opacity=".88"/></svg>';
const ICO_USER =
  '<svg class="rl-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4.42 0-8 1.79-8 4v2h16v-2c0-2.21-3.58-4-8-4z"/></svg>';

const SUITS = {
  oros: { label: "oros", cls: "s-oros" },
  copas: { label: "copas", cls: "s-copas" },
  espadas: { label: "espadas", cls: "s-espadas" },
  bastos: { label: "bastos", cls: "s-bastos" },
};

function pName(st, seat) {
  return st?.players?.[K(seat)]?.name || `Jugador ${seat}`;
}
function bothPlayersJoined(st) {
  return !!(st?.players?.[K(0)] && st?.players?.[K(1)]);
}
function getScore(st, seat) {
  return real(st?.scores?.[K(seat)]);
}

// --- Estado de render ---------------------------------------------------------
let _prevStatus = "";
let _prevHandNumber = -1;
let _introPlayed = false;
let _lastState = null;
let _lastRoom = null;
let _versusIntroShownKey = "";
let _prevHandsKey = "";
let _prevTrickKey = "";
let _prevHandKey = "";
let _lastCompletedTricks = null;
let prevTurnKey = "";
let _gameEndHandSummaryStartedFor = "";
let _gameEndHandSummaryDoneFor = "";
let _gameOverPresentationScheduledFor = "";
let gameEndSummaryTimer = null;
let _gameEndSummaryLatch = false;
let _openingAnimPendingKey = "";
let _openingAnimDoneKey = "";
let _openingAnimRunning = false;
let _lastIncomingOfferVibrationKey = "";
let _botThinking = false;
let _prevRivalPlayedCount = 0;
let _prevPendingOfferStr = "";

// Cuenta atrás entre manos
let betweenTimer = null;
let _betweenCountdownLatch = false;

let preGameInactTimer = null;
let preGameWarningTimer = null;

function clearPreGameTimers() {
  clearTimeout(preGameInactTimer);
  clearInterval(preGameWarningTimer);
  preGameInactTimer = null;
  preGameWarningTimer = null;
  const overlay = $("preGameInactivityOverlay");
  if (overlay) overlay.classList.add("hidden");
}

function startPreGameInactivity() {
  clearPreGameTimers();
  preGameInactTimer = setTimeout(() => {
    showPreGameWarning();
  }, 9 * 60 * 1000);
}

function showPreGameWarning() {
  let overlay = $("preGameInactivityOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "preGameInactivityOverlay";
    overlay.className = "game-over-overlay";
    overlay.style.zIndex = "9999";
    overlay.innerHTML = `
      <div style="background:rgba(0,0,0,0.85); padding:24px; border-radius:12px; text-align:center; border:1px solid var(--gold);">
        <h2 style="color:var(--gold); margin-bottom:12px;">Sala inactiva</h2>
        <p style="margin-bottom:20px;">La partida no comença. Tancant en <span id="preGameWarningCd">60</span>s...</p>
        <button id="preGameImHereBtn" class="lbtn lbtn-primary">Estic ací</button>
      </div>
    `;
    document.body.appendChild(overlay);
    
    $("preGameImHereBtn").addEventListener("click", () => {
      clearPreGameTimers();
      startPreGameInactivity();
    });
  }
  overlay.classList.remove("hidden");
  
  let cd = 60;
  const cdSpan = $("preGameWarningCd");
  cdSpan.textContent = cd;
  
  preGameWarningTimer = setInterval(() => {
    cd--;
    cdSpan.textContent = cd;
    if (cd <= 0) {
      clearPreGameTimers();
      if (session.roomRef) {
        remove(session.roomRef).catch(() => {}).finally(() => {
          const goLeaveBtn = document.getElementById("goLeaveBtn");
          if (goLeaveBtn) goLeaveBtn.click();
        });
      }
    }
  }, 1000);
}

// Presencia
let _absenceClaimTimer = null;
let _absenceTickTimer = null;
let _absenceDeadline = 0;
let _claimMissingRivalPending = false;
let _lastRivalAbsentState = false;

// Pre-game onDisconnect
let _preGameRoomOnDisconnect = null;

// Inyectado desde ui.js para resetear el timer de inactividad
let _resetInactivity = () => {};

export function configureRenderer({ resetInactivity }) {
  _resetInactivity = resetInactivity;
}

function vibratePattern(pattern) {
  if (!isVibrationEnabled()) return;
  if (!("vibrate" in navigator)) return;
  try {
    navigator.vibrate(pattern);
  } catch {}
}

// Acceso a betweenTimer/latch desde ui.js (detachRoomListeners)
export function getBetweenTimer() { return betweenTimer; }
export function getBetweenCountdownLatch() { return _betweenCountdownLatch; }
export function resetBetweenCountdownLatch() { _betweenCountdownLatch = false; }
export function getLastState() { return _lastState; }

// --- Builders de cartas -------------------------------------------------------
export function buildCard(card) {
  const { num, suit } = Logica.parseCard(card);
  const suitLetter =
    { oros: "o", copas: "c", espadas: "e", bastos: "b" }[suit] || "";
  const imgCode = `${num}${suitLetter}`;
  
  const gsapWrap = document.createElement("div");
  gsapWrap.className = "card-gsap-wrapper";

  const el = document.createElement("div");
  el.className = `playing-card ${SUITS[suit]?.cls || ""} use-img`;
  const img = document.createElement("img");
  img.className = "card-art";
  img.alt = `${num}${suitLetter}`;
  img.draggable = false;
  img.src = `./Media/Images/Cards/${imgCode}.jpg`;
  el.appendChild(img);
  
  gsapWrap.appendChild(el);
  return gsapWrap;
}

function buildBack() {
  const gsapWrap = document.createElement("div");
  gsapWrap.className = "card-gsap-wrapper";
  const el = document.createElement("div");
  el.className = "card-back";
  gsapWrap.appendChild(el);
  return gsapWrap;
}

/** Revers per al repartiment inicial: mateixa mida que la cara (`.card-back-hand` al CSS). */
function buildHandDealBack() {
  const gsapWrap = document.createElement("div");
  gsapWrap.className = "card-gsap-wrapper";
  const el = document.createElement("div");
  el.className = "card-back card-back-hand";
  gsapWrap.appendChild(el);
  return gsapWrap;
}

function bindMyCardPlayable(wrap, cel, card, myCardsZone) {
  wrap.classList.add("playable");
  wrap.addEventListener(
    "click",
    () => {
      if (ui.locked || !wrap.classList.contains("playable")) return;
      myCardsZone.querySelectorAll(".my-card-wrap").forEach((w) =>
        w.classList.remove("playable"),
      );
      const randomSoundIndex = Math.floor(Math.random() * 15);
      sndCard(randomSoundIndex);
      animatePlay(cel, buildCard(card), () => playCard(card));
    },
    { once: true },
  );
}

// --- Mensajes de mesa ---------------------------------------------------------
export function showTableMsgLocal(text, isMine = true) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return;
  const bubble = document.createElement("div");
  bubble.className = `table-msg-bubble ${isMine ? "msg-mine" : "msg-rival"}`;
  bubble.textContent = cleaned;
  document.body.appendChild(bubble);
  setTimeout(() => {
    if (bubble) bubble.remove();
  }, 1800);
}

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

function envitProofInnerHtml(proof) {
  if (!proof?.cards?.length) return "";
  const bits = proof.cards.map((card) => {
    const { num, suit } = Logica.parseCard(card);
    const suitLetter =
      { oros: "o", copas: "c", espadas: "e", bastos: "b" }[suit] || "";
    const imgCode = `${num}${suitLetter}`;
    const cls = SUITS[suit]?.cls || "";
    const src = `./Media/Images/Cards/${imgCode}.jpg`;
    return `<div class="playing-card ${cls} use-img playing-card--log-mini"><img class="card-art" src="${src}" alt="" draggable="false"></div>`;
  });
  const perMaSuffix = proof.perMa ? " (per m\u00e0)" : "";
  return `<div class="sum-envit-proof">${bits.join("")}<span class="sum-envit-pts">${proof.points} punts${perMaSuffix}</span></div>`;
}

function offerCallText(offerKind, offerLevel) {
  if (offerKind === "envit") {
    if (offerLevel === "falta") return "Falta!!!";
    if (Number(offerLevel) >= 4) return "Torne a envidar!";
    return "Envide!";
  }
  if (offerKind === "truc") {
    if (Number(offerLevel) === 4) return "Val 4!!!";
    if (Number(offerLevel) === 3) return "Retruque!!";
    return "Truque!";
  }
  return "";
}

// --- Resumen de puntos entre manos --------------------------------------------

/** Detecta si en la mano actual se aceptó un envit (hay prueba de cartas en el log). */
function handSummaryHasEnvit(state) {
  const logs = state.logs || [];
  let marcCount = 0;
  for (const l of logs) {
    if (l.text?.startsWith("Marcador:")) {
      marcCount++;
      if (marcCount >= 2) break;
    }
    if (l.envitProof?.cards?.length > 0) return true;
  }
  return false;
}

function buildScoreSummary(state) {
  const logs = state.logs || [];
  const p0 = pName(state, 0),
    p1 = pName(state, 1);
  let marcCount = 0;
  const handLogs = [];
  for (const l of logs) {
    if (l.text?.startsWith("Marcador:")) {
      marcCount++;
      if (marcCount >= 2) break;
    }
    handLogs.push(l);
  }
  handLogs.reverse();

  let pts0 = 0,
    pts1 = 0;
  const rows = [];
  for (const l of handLogs) {
    const txt = l.text || "";
    const m = txt.match(/\(\+(\d+)\)/) || txt.match(/\+(\d+)(?=[^\d]|$)/);
    if (!m) continue;
    const pts = Number(m[1]);
    let label = "",
      winner = "";
    const hasP0name = p0.length > 1 && txt.includes(p0);
    const hasP1name = p1.length > 1 && txt.includes(p1);
    const hasJ0 = txt.match(/\bJ0\b/);
    const hasJ1 = txt.match(/\bJ1\b/);
    const guessWinner = () => {
      if (hasP0name && !hasP1name) return p0;
      if (hasP1name && !hasP0name) return p1;
      if (hasJ0 && !hasJ1) return p0;
      if (hasJ1 && !hasJ0) return p1;
      return p0;
    };
    if (
      txt.includes("Envit") &&
      (txt.includes("guanya") || txt.includes("acceptat"))
    ) {
      winner = guessWinner();
      const proofHtml = l.envitProof ? envitProofInnerHtml(l.envitProof) : "";
      label = `<span>Envit guanyat per <b>${winner}</b></span>${proofHtml}`;
      // Usa el seient guardat directament; fallback a guessWinner per logs antics
      const envitPtsTo = (l.winnerSeat === 0 || l.winnerSeat === 1)
        ? l.winnerSeat
        : (winner === p0 ? 0 : 1);
      if (proofHtml) {
        rows.push(
          `<div class="sum-row sum-row--has-proof"><span class="sum-label">${label}</span><span class="sum-pts">+${pts}</span></div>`,
        );
        if (envitPtsTo === 0) pts0 += pts;
        else pts1 += pts;
        continue;
      }
      // Sense prova: afegim igualment i continuem
      rows.push(
        `<div class="sum-row"><span class="sum-label">${label}</span><span class="sum-pts">+${pts}</span></div>`,
      );
      if (envitPtsTo === 0) pts0 += pts;
      else pts1 += pts;
      continue;
    } else if (txt.includes("Envit") && txt.includes("rebutjat")) {
      winner = guessWinner();
      const envitPtsTo = (l.winnerSeat === 0 || l.winnerSeat === 1)
        ? l.winnerSeat
        : (winner === p0 ? 0 : 1);
      label = `No vull l'envit - +${pts} per <b>${winner}</b>`;
      rows.push(
        `<div class="sum-row"><span class="sum-label">${label}</span><span class="sum-pts">+${pts}</span></div>`,
      );
      if (envitPtsTo === 0) pts0 += pts;
      else pts1 += pts;
      continue;
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
  html += rows.length
    ? rows.join("")
    : '<div style="color:var(--muted);font-size:12px">Cap punt especial</div>';
  html += `</div><div class="sum-result">${p0} <span class="sum-score">${pts0}</span> - <span class="sum-score">${pts1}</span> ${p1}</div>`;
  return html;
}

// --- Cuenta atrás entre manos ------------------------------------------------
function stopBetween() {
  if (betweenTimer != null) clearTimeout(betweenTimer);
  betweenTimer = null;
  $("countdownOverlay").classList.add("hidden");
}

function stopGameEndSummary() {
  if (gameEndSummaryTimer != null) {
    clearTimeout(gameEndSummaryTimer);
    gameEndSummaryTimer = null;
    // Solo ocultamos el overlay si el timer de fin de partida estaba activo;
    // si hay un betweenTimer corriendo sobre el mismo overlay, no lo tocamos.
    $("countdownOverlay")?.classList.add("hidden");
  }
}

/** 4 s de resum de la mà (5 s si hi havia envit); després pantalla guanyador/perdedor. */
function startGameEndHandSummary(state, animKey) {
  stopGameEndSummary();
  const ov = $("countdownOverlay"),
    lbl = $("countdownLabel");
  if (lbl) lbl.innerHTML = buildScoreSummary(state);
  ov.classList.remove("hidden");
  const cdEl = $("tableCdEl");
  if (cdEl) {
    cdEl.classList.add("hidden");
    cdEl.innerHTML = "";
  }
  animateTrickCollect();

  const duration = 4000 + (handSummaryHasEnvit(state) ? 1000 : 0);
  gameEndSummaryTimer = setTimeout(() => {
    stopGameEndSummary();
    _gameEndSummaryLatch = true;
    if (cdEl) {
      cdEl.classList.add("hidden");
      cdEl.innerHTML = "";
    }
    _gameEndHandSummaryDoneFor = animKey;
    if (_lastRoom) renderAll(_lastRoom);
  }, duration);
}

function startBetween(summaryHtml, extraDelay = 0, state = null) {
  stopBetween();

  const ov = $("countdownOverlay"),
    lbl = $("countdownLabel");
  if (lbl && summaryHtml) lbl.innerHTML = summaryHtml;
  ov.classList.remove("hidden");
  const cdSeconds = isBotActive() ? 3 : 5;
  let n = cdSeconds;
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
      if (session.mySeat === 0) dealHand().catch(() => {});
      return;
    }
    cdEl.classList.remove("hidden");
    cdEl.innerHTML = `<div class="cd-subtitle">Següent mà en\u2026</div><div class="cd-number">${n}</div>`;
    if (n < cdSeconds) sndTick();
    if (state && n === 1) {
      animateTrickCollect();
    }
    n--;
    betweenTimer = setTimeout(tick, 1000);
  }
  betweenTimer = setTimeout(() => tick(), 3000 + extraDelay);
}

// --- Cartas del rival (preparado para N jugadores) ---------------------------
/**
 * Dibuja las cartas boca abajo de un asiento rival concreto.
 * Estructurado con seatId genérico para 2v2: cada rival tiene su propio
 * contenedor DOM indexado por asiento.
 */
function renderPlayerZone(seatId, handObj) {
  // En 1v1 el rival está siempre en #rivalCards.
  // Para 2v2 se usaría #rivalCards-{seatId} u otro contenedor indexado.
  const zone = seatId === other(session.mySeat) ? $("rivalCards") : null;
  if (!zone) return;
  zone.replaceChildren();
  const cards = fromHObj(handObj);
  const n = cards.length;
  zone.setAttribute("data-count", String(n));
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    s.className = "rival-card-slot";
    const angles = n === 3 ? [-8, 0, 8] : n === 2 ? [-5, 5] : [0];
    const xoffs = n === 3 ? [-44, 0, 44] : n === 2 ? [-24, 24] : [0];
    s.style.cssText = `transform:translateX(${xoffs[i] || 0}px) rotate(${angles[i] || 0}deg);z-index:${i + 1};`;
    s.appendChild(buildBack());
    zone.appendChild(s);
  }
}

/**
 * Itera sobre todos los asientos que no son el propio para renderizar rivales.
 * Extensible a N jugadores: en 2v2 iterará sobre 3 rivales.
 */
function renderRivalZones(state) {
  const allSeats = Object.keys(state.players || {})
    .map((k) => Number(k.replace("_", "")))
    .filter((s) => s !== session.mySeat);
  const rivals = allSeats.length > 0 ? allSeats : [other(session.mySeat)];
  rivals.forEach((seatId) => {
    renderPlayerZone(seatId, state.hand?.hands?.[K(seatId)]);
  });
}

export function resetHandIntroPlayed() {
  _introPlayed = false;
  _versusIntroShownKey = "";
  _openingAnimPendingKey = "";
  _openingAnimDoneKey = "";
  _openingAnimRunning = false;
}

// --- Mis cartas ---------------------------------------------------------------
function renderMyCards(state) {
  const h = state.hand,
    z = $("myCards");
  if (!z) return;
  const emptyBefore = z.children.length === 0;
  if (!h) {
    z.replaceChildren();
    return;
  }
  const myCards = fromHObj(h.hands?.[K(session.mySeat)]);
  const played = alreadyPlayed(h, session.mySeat);
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
  const handsKey = myCards.join(",") + "|" + canPlay;
  if (handsKey === _prevHandsKey && z.children.length === myCards.length)
    return;
  _prevHandsKey = handsKey;

  if (z._hoverCleanups) {
    z._hoverCleanups.forEach(fn => fn && typeof fn === "function" ? fn() : null);
  }
  z._hoverCleanups = [];

  z.replaceChildren();

  const handDealIntro =
    !!globalThis.gsap &&
    emptyBefore &&
    myCards.length === 3 &&
    !_introPlayed;

  myCards.forEach((card) => {
    const wrap = document.createElement("div");
    wrap.className = "my-card-wrap";
    if (handDealIntro) {
      wrap.style.opacity = "0";
      // Evita que el `transition: transform` del CSS interpole entre l'abanic i el set de GSAP (efecte centre→mazo→mà).
      wrap.style.transition = "none";
      wrap.appendChild(buildHandDealBack());
    } else {
      const cel = buildCard(card);
      wrap.appendChild(cel);
      if (canPlay) bindMyCardPlayable(wrap, cel, card, z);
    }
    const cleanup = setupHoverDynamics(wrap);
    if (cleanup) z._hoverCleanups.push(cleanup);
    z.appendChild(wrap);
  });

  if (handDealIntro && z.querySelectorAll(".my-card-wrap").length === 3) {
    _introPlayed = true;
    void z.offsetHeight;
    animateMyHandDealFromDeck(z.querySelectorAll(".my-card-wrap"), {
      flipAllSubtimeline(allWraps) {
        const g = globalThis.gsap;
        if (!g || allWraps.length !== 3) return null;
        const backs = allWraps
          .map((w) => w.querySelector(".card-back-hand"))
          .filter(Boolean);
        if (backs.length !== 3) return null;
        const sub = g.timeline();
        sub.to(backs, {
          scaleX: 0,
          duration: 0.1,
          ease: "power2.in",
          transformOrigin: "50% 50%",
        });
        // El flip de cares ha d'afegir-se amb `sub.to` després del pas de
        // `call` (no des de `onComplete` del tween dels reversos): si no, el
        // subtimeline acaba massa prompte, el timeline pare fa `onComplete` i
        // les cares queden amb scaleX: 0 fins a un render posterior.
        sub.call(function () {
          const faces = [];
          allWraps.forEach((w, idx) => {
            const face = buildCard(myCards[idx]);
            face.style.transition = "none";
            g.set(face, { scaleX: 0, transformOrigin: "50% 50%" });
            w.replaceChildren(face);
            faces.push(face);
          });
          sub.to(faces, {
            scaleX: 1,
            duration: 0.12,
            ease: "power2.out",
            onComplete: () => {
              allWraps.forEach((w, idx) => {
                const face = w.querySelector(".playing-card");
                if (!face) return;
                face.style.removeProperty("transition");
                g.set(face, { clearProps: "scaleX,transformOrigin" });
                if (canPlay)
                  bindMyCardPlayable(w, face, myCards[idx], z);
              });
            },
          });
        });
        return sub;
      },
      onDealAborted(wraps) {
        wraps.forEach((w, idx) => {
          const c = myCards[idx];
          if (!w || !c) return;
          if (w.querySelector(".card-back-hand")) {
            w.replaceChildren(buildCard(c));
          }
          const face = w.querySelector(".playing-card");
          if (canPlay && face) bindMyCardPlayable(w, face, c, z);
        });
      },
    });
  }
}

// --- Grid de bazas ------------------------------------------------------------
function _renderTrickGrid(allTricks, curP0, curP1, didRivalJustPlay = false) {
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
      globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });
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
      globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });
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
      globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });
      cellRival.appendChild(el);
      if (didRivalJustPlay) {
        animateRivalPlay(el);
      } else {
        el.classList.add("land-anim");
      }
    }

    const sep = document.createElement("div");
    sep.className = "trick-row-sep";

    const cellMine = document.createElement("div");
    cellMine.className = "trick-cell-mine";
    const myCard = me === 0 ? curP0 : curP1;
    if (myCard) {
      const el = buildCard(myCard);
      globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });
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
      (betweenTimer != null ||
        _betweenCountdownLatch ||
        gameEndSummaryTimer != null ||
        _gameEndSummaryLatch ||
        state.status === "game_over")
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
    
  const rivalSeat = other(session.mySeat);
  const rivalP = rivalSeat === 0 ? p0 : p1;
  let didRivalJustPlay = false;
  const rivalPlayedCount = allT.length + (rivalP ? 1 : 0);
  if (rivalPlayedCount > _prevRivalPlayedCount) {
    sndCard(Math.floor(Math.random() * 15));
    didRivalJustPlay = true;
  }
  _prevRivalPlayedCount = rivalPlayedCount;

  const offerTag = h.pendingOffer
    ? `${h.pendingOffer.kind}:${h.pendingOffer.level}`
    : "";
  const trickKey =
    real(state.handNumber || OFFSET) +
    "|" +
    allT.length +
    "|" +
    (p0 || "-") +
    "|" +
    (p1 || "-") +
    "|" +
    h.mode +
    "|" +
    offerTag;

  if (trickKey !== _prevTrickKey) {
    _prevTrickKey = trickKey;
    _renderTrickGrid(allT, p0, p1, didRivalJustPlay);
  }

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

// --- Acciones ----------------------------------------------------------------
function renderActions(state) {
  if (ui.locked) {
    ["envitBtn", "faltaBtn", "trucBtn", "mazoBtn"].forEach((id) => {
      const b = $(id);
      if (b) b.classList.add("hidden");
    });
    const ra = $("responseArea");
    if (ra) { ra.innerHTML = ""; ra.classList.add("hidden"); }
    const om = $("offerMsg");
    if (om) om.classList.add("hidden");
    return;
  }
  const h = state.hand;
  const ra = $("responseArea"),
    om = $("offerMsg");

  if (ra) { ra.innerHTML = ""; ra.classList.add("hidden"); }
  if (om) om.classList.add("hidden");

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
  const curOfferStr = h.pendingOffer ? `${h.pendingOffer.kind}:${h.pendingOffer.level}` : "";
  if (curOfferStr && curOfferStr !== _prevPendingOfferStr) {
    const isHighAlert = (h.pendingOffer.kind === "truc" && Number(h.pendingOffer.level) === 4) || (h.pendingOffer.kind === "envit" && h.pendingOffer.level === "falta");
    if (isHighAlert) animateScreenShake();
  }
  _prevPendingOfferStr = curOfferStr;

  const tricksDone = (h.trickHistory || []).length;
  const noTricksPlayed = tricksDone === 0;
  const iHaventPlayed = !alreadyPlayed(h, session.mySeat);
  const noTrucAtAll =
    h.truc.state === "none" && !(h.pendingOffer?.kind === "truc");

  const envitOk =
    h.envitAvailable &&
    noTricksPlayed &&
    iHaventPlayed &&
    !envDone &&
    noTrucAtAll &&
    norm;

  const nadieHaJugado = !alreadyPlayed(h, 0) && !alreadyPlayed(h, 1);
  const sinApuestasPrevias = h.envit.state === "none" && h.truc.state === "none";
  const bloqueoInicio = noTricksPlayed && nadieHaJugado && sinApuestasPrevias;

  ["envitBtn", "faltaBtn", "trucBtn", "mazoBtn"].forEach((id) => {
    const b = $(id);
    if (b) b.classList.add("hidden");
  });

  const add = (l, cls, fn) => {
    const b = document.createElement("button");
    b.textContent = l;
    b.className = `abtn ${cls} action-btn`;
    b.addEventListener("click", async () => {
      if (ui.locked) return;
      ui.locked = true;
      sndBtn();
      const callText =
        cls === "btn-envit-1"
          ? offerCallText("envit", 2)
          : cls === "btn-envit-2"
            ? offerCallText("envit", 4)
            : cls === "btn-envit-3"
              ? offerCallText("envit", "falta")
              : cls === "btn-truc-1"
                ? offerCallText("truc", 2)
                : cls === "btn-truc-2"
                  ? offerCallText("truc", 3)
                  : cls === "btn-truc-3"
                    ? offerCallText("truc", 4)
                    : l;
      showTableMsg(callText);
      try {
        await fn();
      } finally {
        setTimeout(() => {
          ui.locked = false;
          get(session.roomRef)
            .then((snap) => { if (snap?.val()) renderAll(snap.val()); })
            .catch(() => {});
        }, 600);
      }
    });
    ra.appendChild(b);
  };

  if (h.pendingOffer && h.turn === session.mySeat) {
    const offerVibrationKey = `${real(state.handNumber || OFFSET)}|${Logica.getTrickIndex(h)}|${h.pendingOffer.kind}|${h.pendingOffer.level}|${h.pendingOffer.by}`;
    if (_lastIncomingOfferVibrationKey !== offerVibrationKey) {
      _lastIncomingOfferVibrationKey = offerVibrationKey;
      const isHighAlert =
        (h.pendingOffer.kind === "truc" && Number(h.pendingOffer.level) === 4) ||
        (h.pendingOffer.kind === "envit" && h.pendingOffer.level === "falta");
      vibratePattern(isHighAlert ? [100, 50, 100, 50, 100] : [100, 50, 100]);
    }

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
    const pendingKind = h.pendingOffer.kind;
    if (pendingKind === "envit" && h.mode === "respond_envit") {
      add("Vull", "btn-accept", () => respondEnvit("vull"));
      add("No vull", "btn-reject", () => respondEnvit("no_vull"));
      const lvl = h.pendingOffer.level;
      if (lvl === 2) {
        add("Torne", "btn-envit-2", () => respondEnvit("torne"));
        add("Falta", "btn-envit-3", () => respondEnvit("falta"));
      } else if (lvl === 4) {
        add("Falta", "btn-envit-3", () => respondEnvit("falta"));
      }
    } else if (pendingKind === "truc" && h.mode === "respond_truc") {
      add("Vull", "btn-accept", () => respondTruc("vull"));
      add("No vull", "btn-reject", () => respondTruc("no_vull"));
      if (h.pendingOffer.level === 2)
        add("Retruque", "btn-truc-2", () => respondTruc("retruque"));
      if (h.pendingOffer.level === 3)
        add("Val 4", "btn-truc-3", () => respondTruc("val4"));
    } else {
      ra.classList.add("hidden");
      om.classList.add("hidden");
    }
  } else if (myT && norm) {
    const isConsecutivePlay = Logica.mustPlayCardOnlyThisTrick(
      h,
      session.mySeat,
    );

    if (!isConsecutivePlay) {
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
              ? Number(h.truc.acceptedLevel || 0) === 2 ? "Retrucar" : "Val 4"
              : "Trucar";
            tb.classList.remove("btn-truc-1", "btn-truc-2", "btn-truc-3");
            if (!canEscalate) tb.classList.add("btn-truc-1");
            else if (Number(h.truc.acceptedLevel || 0) === 2)
              tb.classList.add("btn-truc-2");
            else tb.classList.add("btn-truc-3");
            tb.classList.remove("hidden");
          }
        }
        if (!bloqueoInicio && $("mazoBtn")) $("mazoBtn").classList.remove("hidden");
      }
    }
  }
  if (!(h.pendingOffer && h.turn === session.mySeat)) {
    _lastIncomingOfferVibrationKey = "";
  }

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
      const isConsecutivePlay = Logica.mustPlayCardOnlyThisTrick(
        h,
        session.mySeat,
      );
      sm.textContent = isConsecutivePlay
        ? "Tira la teua carta"
        : "El teu torn, tria carta o acci\u00f3";
      sm.classList.add("my-turn");
    } else {
      sm.textContent = "";
    }
  }
}

function botActionFlyCaption(action, state) {
  const [type, payload] = action;
  const h = state?.hand;
  const botSeat = 1;
  if (type === "OFFER") {
    if (payload === "envit") return offerCallText("envit", 2);
    if (payload === "falta") return offerCallText("envit", "falta");
    if (payload === "truc") {
      let trucLevel = 2;
      if (h?.truc?.state === "accepted" && h.truc.responder === botSeat) {
        trucLevel = Number(h.truc.acceptedLevel || 2) + 1;
        if (trucLevel > 4) trucLevel = 4;
      }
      return offerCallText("truc", trucLevel);
    }
  }
  if (type === "RESPOND_ENVIT") {
    if (payload === "vull") return "Vull";
    if (payload === "no_vull") return "No vull";
    if (payload === "torne") return offerCallText("envit", 4);
    if (payload === "falta") return offerCallText("envit", "falta");
  }
  if (type === "RESPOND_TRUC") {
    if (payload === "vull") return "Vull";
    if (payload === "no_vull") return "No vull";
    if (payload === "retruque") return offerCallText("truc", 3);
    if (payload === "val4") return offerCallText("truc", 4);
  }
  return "";
}

async function executeBotAction(action, state) {
  const [type] = action;
  if (type === "PLAY_CARD") {
    const cards = fromHObj(state.hand.hands[K(1)]);
    const card = cards[action[1]];
    if (card) await playCardAsBot(card);
    return;
  }
  const caption = botActionFlyCaption(action, state);
  if (caption) {
    void animateRivalActionTableMsg(caption);
    if (
      type === "OFFER" ||
      type === "RESPOND_ENVIT" ||
      type === "RESPOND_TRUC"
    ) {
      showBubble("rivalBubble", caption);
    }
  }
  if (type === "OFFER") {
    await startOfferAsBot(action[1]);
  } else if (type === "RESPOND_ENVIT") {
    await respondEnvitAsBot(action[1]);
  } else if (type === "RESPOND_TRUC") {
    await respondTrucAsBot(action[1]);
  }
}

/** Retard "humà" del bot abans d'actuar (1-5 s). */
const BOT_ACT_DELAY_MIN_MS = 1000;
const BOT_ACT_DELAY_MAX_MS = 5000;

function getBotActDelayMs() {
  return Math.floor(
    BOT_ACT_DELAY_MIN_MS +
      Math.random() * (BOT_ACT_DELAY_MAX_MS - BOT_ACT_DELAY_MIN_MS + 1),
  );
}

function canBotActInState(state, botSeat) {
  const h = state?.hand;
  if (
    state?.status !== "playing" ||
    h?.status !== "in_progress" ||
    h.turn !== botSeat
  ) {
    return false;
  }
  if (h.pendingOffer) {
    return (
      h.pendingOffer.to === botSeat &&
      ((h.pendingOffer.kind === "envit" && h.mode === "respond_envit") ||
        (h.pendingOffer.kind === "truc" && h.mode === "respond_truc"))
    );
  }
  return h.mode === "normal" && !alreadyPlayed(h, botSeat);
}

function scheduleBotIfNeededFromGameState(state) {
  if (!isBotActive() || _botThinking) return;
  if (session.mySeat !== 0 && session.mySeat !== 1) return;
  const botSeat = other(session.mySeat);
  if (!canBotActInState(state, botSeat)) return;

  _botThinking = true;
  const botDelayMs = getBotActDelayMs();
  setTimeout(() => {
    let didRunAction = false;
    let st = _lastRoom?.state;
    if (!canBotActInState(st, botSeat)) {
      _botThinking = false;
      return;
    }
    botAct(st)
      .then(async (action) => {
        if (action) {
          didRunAction = true;
          await executeBotAction(action, st);
          return;
        }
        st = _lastRoom?.state;
        if (!canBotActInState(st, botSeat)) return;
        const action2 = await botAct(st);
        if (action2) {
          didRunAction = true;
          await executeBotAction(action2, st);
        }
      })
      .catch((e) => console.error("bot error:", e))
      .finally(() => {
        _botThinking = false;
        if (!didRunAction) return;
        if (!session.roomRef) return;
        get(session.roomRef)
          .then((snap) => {
            const room = snap.val();
            if (room) renderAll(room);
          })
          .catch(() => {});
      });
  }, botDelayMs);
}

// --- Timer de turno del rival ------------------------------------------------
function updateRivalTimer(state) {
  const h = state.hand;
  const my = $("myZone"), riv = $("rivalZone");
  const playing = h && state.status === "playing" && h.status === "in_progress";
  const myActive =
    playing && h.turn === session.mySeat && !alreadyPlayed(h, session.mySeat);
  const rivActive =
    playing &&
    h.turn === other(session.mySeat) &&
    !alreadyPlayed(h, other(session.mySeat));
  if (my) my.classList.toggle("turn-active", !!myActive);
  if (riv) riv.classList.toggle("turn-active", !!rivActive);
}

// --- HUD ---------------------------------------------------------------------
function renderHUD(state) {
  const hideCode = session.roomVisibility === "public";
  $("hudRoom").textContent = hideCode
    ? "Sala p\u00fablica"
    : `Sala ${session.roomCode || "-"}`;

  const sMy = getScore(state, session.mySeat);
  const sRiv = getScore(state, other(session.mySeat));

  animateHUDPoints("hudScore0", sMy, 0);
  animateHUDPoints("hudScore1", sRiv, 1);

  const turnPlayer = state.hand
    ? pName(state, state.hand.turn)
    : pName(state, state.mano);
  $("siMano").textContent = turnPlayer;
  $("siHand").textContent = String(real(state.handNumber || OFFSET));
  if ($("actionPanel")) {
    $("actionPanel").classList.toggle("playing-mode", state.status === "playing");
  }
}

// --- Log ---------------------------------------------------------------------
function renderLog(state) {
  const a = $("logArea");
  if (!a) return;
  const p0 = pName(state, 0), p1 = pName(state, 1);
  const frag = document.createDocumentFragment();
  (state.logs || []).slice(0, 15).forEach((item) => {
    const wrap = document.createElement("div");
    wrap.className = "log-entry";
    const line = document.createElement("div");
    line.className = "log-entry-line";
    line.textContent = (item.text || "")
      .replace(/\bJ0\b/g, p0)
      .replace(/\bJ1\b/g, p1);
    wrap.appendChild(line);
    if (item.envitProof?.cards?.length) {
      const row = document.createElement("div");
      row.className = "log-envit-proof-row";
      for (const cid of item.envitProof.cards) {
        const mini = buildCard(cid);
        mini.classList.add("playing-card--log-mini");
        row.appendChild(mini);
      }
      const pts = document.createElement("span");
      pts.className = "log-envit-proof-pts";
      pts.textContent = `${item.envitProof.points} punts`;
      row.appendChild(pts);
      wrap.appendChild(row);
    }
    frag.appendChild(wrap);
  });
  a.replaceChildren(frag);
}

// --- Presencia y desconexión -------------------------------------------------
function clearAbsenceTimers() {
  if (_absenceClaimTimer) { clearTimeout(_absenceClaimTimer); _absenceClaimTimer = null; }
  if (_absenceTickTimer) { clearInterval(_absenceTickTimer); _absenceTickTimer = null; }
  _absenceDeadline = 0;
}

export function isActiveMatchState(st) {
  if (!st || st.status === "game_over") return false;
  return !(st.status === "waiting" && real(st.handNumber || OFFSET) === 0);
}

// Alias exportado para uso desde ui.js (detachRoomListeners)
export { clearAbsenceTimers };

function tickAbsenceCountdown() {
  const el = $("absenceCountdown");
  if (!el || !_absenceDeadline) return;
  const sec = Math.max(0, Math.ceil((_absenceDeadline - Date.now()) / 1000));
  el.textContent = String(sec);
}

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
        _lastRivalAbsentState = false;
        clearAbsenceTimers();
        bar.classList.add("hidden");
        return;
      }

      if (!_lastRivalAbsentState) {
        _lastRivalAbsentState = true;
        stopTurnTimer();
        registerRivalAbsence();
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

export function cancelPreGameRoomOnDisconnect() {
  if (_preGameRoomOnDisconnect) {
    _preGameRoomOnDisconnect.cancel().catch(() => {});
    _preGameRoomOnDisconnect = null;
  }
}

function updatePreGameRoomOnDisconnectArm(state) {
  const preGame =
    state?.status === "waiting" && real(state?.handNumber ?? OFFSET) === 0;
  if (
    !preGame ||
    !session.roomRef ||
    session.mySeat === null ||
    (session.mySeat !== 0 && session.mySeat !== 1)
  ) {
    cancelPreGameRoomOnDisconnect();
    return;
  }
  if (_preGameRoomOnDisconnect) return;
  const h = onDisconnect(session.roomRef);
  _preGameRoomOnDisconnect = h;
  h.remove().catch(() => {});
}

// --- Revenja -----------------------------------------------------------------
function renderRematchStatus(state) {
  const btn = $("goRematchBtn"), st = $("goRematchStatus");
  if (!btn || !st) return;
  const myWant = !!state.rematch?.[K(session.mySeat)];
  const rivWant = !!state.rematch?.[K(other(session.mySeat))];
  if (isBotActive()) {
    btn.disabled = false;
    btn.textContent = "\ud83d\udd04 Revenja";
    st.textContent = "";
    return;
  }
  if (myWant && !rivWant) {
    btn.disabled = true;
    btn.textContent = "\u23f3 Esperant revenja...";
    st.textContent = `${pName(state, other(session.mySeat))} encara no ha contestat`;
  } else if (!myWant) {
    btn.disabled = false;
    btn.textContent = "\ud83d\udd04 Revenja";
    st.textContent = rivWant
      ? `${pName(state, other(session.mySeat))} vol la revenja!`
      : "";
  }
}

// --- RENDER PRINCIPAL --------------------------------------------------------
export function renderAll(room) {
  const state = room?.state || defaultState();
  if (_prevStatus === "waiting" && state.status === "playing") {
    _introPlayed = false;
  }
  session.roomVisibility =
    room?.meta?.visibility === "private"
      ? "private"
      : room?.meta?.visibility === "public"
        ? "public"
        : null;
  const preGameLobby =
    state.status === "waiting" && real(state.handNumber || OFFSET) === 0;
    
  if (preGameLobby) {
    if (!preGameInactTimer && !preGameWarningTimer) {
      startPreGameInactivity();
    }
  } else {
    clearPreGameTimers();
    $("waitingOverlay")?.classList.add("hidden");
  }

  if (session.roomCode) {
    $("screenLobby").classList.add("hidden");
    $("screenGame").classList.remove("hidden");
  }
  _resetInactivity();
  detectSounds(state);
  _lastState = state;
  _lastRoom = room ?? null;
  updatePreGameRoomOnDisconnectArm(state);
  $("deckPile")?.classList.toggle("hidden", state.status !== "playing");
  const deck = $("deckPile");
  if (deck) {
    if (state.status === "playing") {
      const iAmMano = state.mano === session.mySeat;
      deck.style.left = iAmMano ? "16px" : "";
      deck.style.right = iAmMano ? "" : "16px";
    } else {
      deck.style.left = "";
      deck.style.right = "";
    }
  }
  if (state.status === "playing" && state.hand) {
    _betweenCountdownLatch = false;
    $("tableCdEl")?.classList.add("hidden");
  }
  checkPresence(state);
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
  syncOfferBubblesFromState(state);
  if (state.status === "waiting" && real(state.handNumber || OFFSET) === 0) {
    renderWaitingSlots(room, state);
  }
  const hKey = real(state.handNumber || OFFSET) + "-" + (state.hand?.mano ?? "x");
  if (hKey !== (_prevHandKey || "")) {
    _prevHandsKey = "";
    _prevTrickKey = "";
    _prevHandKey = hKey;
    _prevRivalPlayedCount = 0;
  }
  renderHUD(state);
  $("myName").textContent = pName(state, session.mySeat);
  $("rivalName").textContent = pName(state, other(session.mySeat));

  const openingAnimKey =
    state.status === "playing" &&
    real(state.handNumber || OFFSET) === 0 &&
    Number(state.openingIntroAt || 0) > 0
      ? `${session.roomCode || ""}|${state.openingIntroAt}`
      : "";
  const openingAnimPending =
    !!openingAnimKey && _openingAnimDoneKey !== openingAnimKey;

  if (
    openingAnimPending &&
    !_openingAnimRunning &&
    _openingAnimPendingKey !== openingAnimKey
  ) {
    _openingAnimPendingKey = openingAnimKey;
    _openingAnimRunning = true;
    loadAvatarChoiceIntoMemory();
    const _vsMineSrc = srcFromChoice(myAvatarChoice) || AVATAR_IMAGES[0];
    const _vsRivalSrc =
      srcFromFirebaseAvatar(_lastRoom?.avatars?.[K(other(session.mySeat))]) ||
      AVATAR_IMAGES[0];
    Promise.resolve()
      .then(() =>
        playVersusIntro(
          pName(state, session.mySeat),
          pName(state, other(session.mySeat)),
          _vsMineSrc,
          _vsRivalSrc,
        ),
      )
      .catch(() => {})
      .then(() => {
        if (isBotActive() && _lastRoom?.state) {
          scheduleBotIfNeededFromGameState(_lastRoom.state);
        }
        const afterMsg = playCenterTableMessage("Bona sort!");
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            setTimeout(() => {
              _openingAnimDoneKey = openingAnimKey;
              _openingAnimRunning = false;
              if (_lastRoom) renderAll(_lastRoom);
            }, 500);
          }),
        );
        return afterMsg;
      })
      .catch(() => {})
      .finally(() => {
        if (_openingAnimDoneKey !== openingAnimKey) {
          _openingAnimDoneKey = openingAnimKey;
          _openingAnimRunning = false;
          if (_lastRoom) renderAll(_lastRoom);
        }
      });
  }

  const firstHandStartedForAll =
    _prevStatus === "waiting" &&
    state.status === "playing" &&
    real(state.handNumber || OFFSET) === 0;
  if (firstHandStartedForAll && session.mySeat !== 0) {
    const introKey = `${session.roomCode || ""}|${state.handNumber || OFFSET}|${session.mySeat}`;
    if (_versusIntroShownKey !== introKey) {
      _versusIntroShownKey = introKey;
    }
  }
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
  if (openingAnimPending) {
    $("rivalCards")?.replaceChildren();
    $("myCards")?.replaceChildren();
    renderTrick(state);
    renderActions(state);
    renderLog(state);
    _prevStatus = state.status;
    // Detectar fin de mano y actualizar memoria del bot
    if (isBotActive() && state.lastHandSummary) {
      const hn = real(state.handNumber || OFFSET);
      if (hn !== _prevHandNumber) {
        _prevHandNumber = hn;
        const humanSeat = 1 - 1;
        updateBotMemory(
          state.lastHandSummary,
          humanSeat,
          state.scores,
        );
      }
    }
    // Durant l'overlay VS: sense render complet ni programació del bot (això va al .then de playVersusIntro).
    return;
  }

  renderRivalZones(state);
  updateRivalTimer(state);
  renderMyCards(state);
  if (state.hand) {
    _lastCompletedTricks = {
      allTricks: state.hand.allTricks || [],
      key: real(state.handNumber || OFFSET) + "-" + Logica.getTrickIndex(state.hand),
    };
  } else if (state.lastAllTricks && state.lastAllTricks.length > 0) {
    const lk = "lat-" + state.lastAllTricks.length + "-" + state.handNumber;
    if (_lastCompletedTricks?.key !== lk) {
      _lastCompletedTricks = { allTricks: state.lastAllTricks, key: lk };
    }
  }
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
    const animKey = `${session.roomCode}|${state.winner}|${getScore(state, session.mySeat)}-${getScore(state, other(session.mySeat))}|${state.logs?.[0]?.at ?? ""}|${state.gameEndReason || ""}`;
    const abandonment = state.gameEndReason === "abandonment";
    const showGameOverOverlay = () => {
      const st = _lastState;
      if (!st || st.status !== "game_over") return;
      _gameEndSummaryLatch = false;
      const iWon = st.winner === session.mySeat;
      const aband = st.gameEndReason === "abandonment";
      $("gameOverOverlay").classList.remove("hidden");
      $("goTitle").textContent = iWon ? "\ud83c\udfc6 Has guanyat!" : "\ud83d\ude05 Has perdut";
      $("goWinner").textContent = pName(st, st.winner) + " guanya";
      $("goScore").textContent =
        aband && iWon
          ? "Has guanyat per abandonament!"
          : aband && !iWon
            ? "Has perdut per abandonament (temps de reconnexi\u00f3 esgotat)."
            : `${getScore(st, session.mySeat)} - ${getScore(st, other(session.mySeat))}`;
      if (iWon) {
        sndWin();
        vibratePattern(500);
        bumpStoredWinsIfWonGame();
      } else {
        sndLose();
      }
      playGameOverPresentation(iWon);
    };
    if (abandonment) {
      stopGameEndSummary();
      if (_gameOverPresentationScheduledFor !== animKey) {
        _gameOverPresentationScheduledFor = animKey;
        setTimeout(showGameOverOverlay, 3000);
      }
    } else {
      if (_gameEndHandSummaryStartedFor !== animKey) {
        _gameEndHandSummaryStartedFor = animKey;
        startGameEndHandSummary(state, animKey);
      }
      if (
        _gameEndHandSummaryDoneFor === animKey &&
        _gameOverPresentationScheduledFor !== animKey
      ) {
        _gameOverPresentationScheduledFor = animKey;
        setTimeout(showGameOverOverlay, 0);
      }
    }
    renderRematchStatus(state);
  } else {
    if (!$("gameOverOverlay").classList.contains("hidden")) {
      $("gameOverOverlay").classList.add("hidden");
      stopConfetti();
    }
    stopGameEndSummary();
    _gameEndHandSummaryStartedFor = "";
    _gameEndHandSummaryDoneFor = "";
    _gameOverPresentationScheduledFor = "";
    _gameEndSummaryLatch = false;
  }

  if (state.status === "waiting") {
    stopTurnTimer();
    if (real(state.handNumber || OFFSET) === 0) {
      _betweenCountdownLatch = false;
      stopBetween();
      $("waitingCode").textContent = session.roomCode || "-";
      const modo = state?.settings?.modoJuego === "2v2" ? "2v2" : "1v1";
      const pts = Number(state?.settings?.puntosParaGanar) === 24 ? 24 : 12;
      const modeTag = $("waitingModeTag");
      const ptsTag = $("waitingPtsTag");
      if (modeTag) modeTag.innerHTML = `${ICO_USER}<span>${modo}</span>`;
      if (ptsTag) ptsTag.innerHTML = `${ICO_STONE}<span>${pts} pedres</span>`;
      $("waitingInviteWhatsappBtn")?.classList.toggle("hidden", isBotActive());
      $("waitingCodeRow")?.classList.toggle(
        "hidden",
        session.roomVisibility === "public",
      );
      const p0ready = !!state.ready?.[K(0)];
      const p1ready = !!state.ready?.[K(1)];
      const myReady = session.mySeat === 0 ? p0ready : p1ready;
      const bothFirebaseReady = p0ready && p1ready;
      const isBotMatch = isBotActive();
      const canStartMatch = isBotMatch ? bothJoined : bothFirebaseReady;

      if (!bothJoined) {
        $("waitingStatus").innerHTML =
          'Esperant el segon jugador<span class="dots"></span>';
      } else if (isBotMatch) {
        $("waitingStatus").textContent = "Rival preparat! Pots iniciar la partida.";
      } else if (!bothFirebaseReady) {
        $("waitingStatus").innerHTML =
          'Cal que els dos confirmeu \u00abpreparat\u00bb<span class="dots"></span>';
      } else {
        $("waitingStatus").textContent =
          session.mySeat === 0
            ? "Tots preparats! Pots iniciar la partida."
            : "Tots preparats! Esperant l'amfitri\u00f3\u2026";
      }

      if (session.mySeat === 0) {
        $("startBtn").classList.toggle("hidden", !bothJoined);
        const sB = $("startBtn");
        sB.disabled = !canStartMatch;
        sB.title = !canStartMatch
          ? "Cal que els dos jugadors estiguen preparats"
          : "";
        sB.style.opacity = !canStartMatch ? "0.5" : "1";
        sB.style.cursor = !canStartMatch ? "not-allowed" : "pointer";
        $("hostReadyBtn").classList.toggle(
          "hidden",
          isBotMatch || !bothJoined || p0ready,
        );
        $("guestReadyBtn").classList.add("hidden");
        $("guestWaitMsg").classList.add("hidden");
      } else {
        $("startBtn").classList.add("hidden");
        $("hostReadyBtn").classList.add("hidden");
        $("guestReadyBtn").classList.toggle(
          "hidden",
          isBotMatch || !bothJoined || myReady,
        );
        const gW = $("guestWaitMsg");
        gW.classList.toggle("hidden", !bothJoined || !myReady);
        if (myReady) {
          gW.innerHTML =
            'Esperant que l\'amfitri\u00f3 inicie la partida<span class="dots"></span>';
        }
      }

      $("backToMainBtn").classList.remove("hidden");
      $("waitingOverlay").classList.remove("hidden");
    } else {
      $("waitingOverlay").classList.add("hidden");
      if (bothJoined && betweenTimer === null && !_betweenCountdownLatch)
        startBetween(buildScoreSummary(state), handSummaryHasEnvit(state) ? 1000 : 0, state);
    }
    _prevStatus = state.status;
    // Detectar fin de mano y actualizar memoria del bot
    if (isBotActive() && state.lastHandSummary) {
      const hn = real(state.handNumber || OFFSET);
      if (hn !== _prevHandNumber) {
        _prevHandNumber = hn;
        const humanSeat = 1 - 1;
        updateBotMemory(
          state.lastHandSummary,
          humanSeat,
          state.scores,
        );
      }
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
  _prevStatus = state.status;
  // Detectar fin de mano y actualizar memoria del bot
  if (isBotActive() && state.lastHandSummary) {
    const hn = real(state.handNumber || OFFSET);
    if (hn !== _prevHandNumber) {
      _prevHandNumber = hn;
      const humanSeat = 1 - 1;
      updateBotMemory(
        state.lastHandSummary,
        humanSeat,
        state.scores,
      );
    }
  }
  scheduleBotIfNeededFromGameState(state);
}

// --- Inicialitzaci� d'efectes ------------------------------------------------
setupHoverDynamics(document.getElementById("deckPile"));
