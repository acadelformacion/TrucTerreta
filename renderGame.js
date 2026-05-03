// --- renderGame.js — Motor de renderizado visual ------------------------------
import { db, session, ref, get, set, onDisconnect, remove } from "./firebase.js";
import * as Logica from "./logica.js";
import { teamOf, getNumSeats, teammates, opponents, playOrder } from "./teams.js";
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
  animateRivalActionTableMsg,
  animatePlay,
  animateMyHandDealFromDeck,
  showHoldCenterTableMessage,
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
import { getCardStyle } from "./spritesheet.js";

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
const allPlayed = (h) => {
  const n = h?.numSeats || 2;
  for (let i = 0; i < n; i++) { if (!alreadyPlayed(h, i)) return false; }
  return true;
};
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
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function bothPlayersJoined(st) {
  const n = getNumSeats(st);
  for (let i = 0; i < n; i++) { if (!st?.players?.[K(i)]) return false; }
  return true;
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
/** Repartiment inicial complet (totes les zones, ordre CCW des del mano). */
let _openingFullDealKey = "";
let _openingFullDealDoneKey = "";
let _openingFullDealSeatIdx = 0;
let _openingFullDealAnimating = false;
/** Retorn de showHoldCenterTableMessage("Bona sort!") */
let _dismissBonaSort = null;
let _lastIncomingOfferVibrationKey = "";
let _botThinking = false;
let _prevRivalPlayedCount = 0;
let _prevPendingOfferStr = "";

export let optimisticCardIndex = null;
export function setOptimisticCard(index) { optimisticCardIndex = index; }
export function clearOptimisticCard() {
  optimisticCardIndex = null;
  const optEl = document.getElementById("optimistic-card-el");
  if (!optEl) return;
  const g = globalThis.gsap;
  if (g) g.killTweensOf(optEl);
  optEl.remove();
}

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
  if (card === "*" || !card || card === EMPTY_CARD) return buildBack();
  const { num, suit } = Logica.parseCard(card);
  if (Number.isNaN(num)) return buildBack();
  const suitLetter =
    { oros: "o", copas: "c", espadas: "e", bastos: "b" }[suit] || "";

  const gsapWrap = document.createElement("div");
  gsapWrap.className = "card-gsap-wrapper";

  const el = document.createElement("div");
  el.className = `playing-card ${SUITS[suit]?.cls || ""} use-img`;
  const img = document.createElement("div");
  img.className = "card-art";
  if (card && card !== EMPTY_CARD && card !== "*") {
    Object.assign(img.style, getCardStyle(card), {
      backgroundRepeat: "no-repeat",
    });
  }
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
  let played = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let hasTouchStart = false;
  let isDragging = false;
  let lastTouchPlayAt = 0;

  const resetDragVisual = (instant = false) => {
    cel.style.willChange = "";
    cel.style.transition = instant ? "none" : "transform 160ms ease";
    cel.style.transform = "";
    if (!instant) {
      setTimeout(() => {
        if (!played) cel.style.transition = "";
      }, 180);
    }
  };

  const applyDragVisual = (dx, dy) => {
    const visualX = Math.max(-26, Math.min(26, dx * 0.22));
    const visualY = Math.max(-34, Math.min(10, dy * 0.32));
    const up = Math.max(0, -dy);
    const lift = Math.min(1, up / 70);
    const scale = 1 + lift * 0.035;
    const rot = Math.max(-5, Math.min(5, dx * 0.04));
    cel.style.willChange = "transform";
    cel.style.transition = "none";
    cel.style.transform = `translate(${visualX}px, ${visualY}px) rotate(${rot}deg) scale(${scale})`;
  };

  const tryPlayCard = () => {
    if (played || ui.locked || !wrap.classList.contains("playable")) return;
    played = true;
    resetDragVisual(true);
    myCardsZone.querySelectorAll(".my-card-wrap").forEach((w) =>
      w.classList.remove("playable"),
    );
    const randomSoundIndex = Math.floor(Math.random() * 15);
    sndCard(randomSoundIndex);
    
    setOptimisticCard(card);
    
    const g = globalThis.gsap;
    const slot = document.getElementById("trickGrid");
    const fr = wrap.getBoundingClientRect();
    const to = slot ? slot.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 80, height: 114 };
    
    wrap.id = "optimistic-card-el";
    wrap.style.cssText = `left:${fr.left}px;top:${fr.top}px;width:${fr.width}px;height:${fr.height}px;position:fixed;pointer-events:none;z-index:200;`;
    document.body.appendChild(wrap);

    if (g) {
      const dx = to.left + to.width / 2 - (fr.left + fr.width / 2);
      const dy = to.top + to.height / 2 - (fr.top + fr.height / 2);
      const rot = Math.random() * 14 - 7;
      g.set(wrap, { transformPerspective: 400, rotationX: 25 });
      g.to(wrap, {
        x: dx,
        y: dy,
        rotation: rot,
        rotationX: 25,
        scale: 0.72,
        duration: 0.45,
        ease: "back.out(1.2)"
      });
    }

    playCard(card).catch(() => {
      optimisticCardIndex = null;
      if (g) g.killTweensOf(wrap);
      wrap.removeAttribute("id");
      played = false;
      wrap.remove();
      _prevHandsKey = "";
      if (_lastRoom) renderAll(_lastRoom);
    });
  };

  wrap.addEventListener(
    "click",
    () => {
      // Evita el "ghost click" justo despues de un swipe tactil.
      if (Date.now() - lastTouchPlayAt < 450) return;
      tryPlayCard();
    },
    { once: true },
  );

  wrap.addEventListener("touchstart", (e) => {
    if (played || ui.locked || !wrap.classList.contains("playable")) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    hasTouchStart = true;
    isDragging = false;
  }, { passive: true });

  wrap.addEventListener("touchmove", (e) => {
    if (!hasTouchStart || played || ui.locked || !wrap.classList.contains("playable")) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (!isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) isDragging = true;
    if (!isDragging) return;
    applyDragVisual(dx, dy);
  }, { passive: true });

  wrap.addEventListener("touchend", (e) => {
    if (!hasTouchStart || played || ui.locked || !wrap.classList.contains("playable")) return;
    hasTouchStart = false;
    const t = e.changedTouches?.[0];
    if (!t) return;

    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Desde la mano inferior, "tirar carta al centro" suele ser un swipe hacia arriba.
    const isSwipeUp = dy <= -36 && absDy > absDx * 1.15;
    if (!isSwipeUp) {
      resetDragVisual(false);
      return;
    }

    lastTouchPlayAt = Date.now();
    tryPlayCard();
  }, { passive: true });

  wrap.addEventListener("touchcancel", () => {
    hasTouchStart = false;
    if (played) return;
    resetDragVisual(false);
  }, { passive: true });
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
    const cls = SUITS[suit]?.cls || "";
    if (!card || card === EMPTY_CARD || card === "*") {
      return `<div class="playing-card ${cls} use-img playing-card--log-mini"><div class="card-art"></div></div>`;
    }
    const st = getCardStyle(card);
    const style = [
      `background-image:${st.backgroundImage || "none"}`,
      `background-position:${st.backgroundPosition || "0 0"}`,
      `background-size:${st.backgroundSize || "auto"}`,
      "background-repeat:no-repeat",
    ].join(";");
    return `<div class="playing-card ${cls} use-img playing-card--log-mini"><div class="card-art" style="${style}"></div></div>`;
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
  const p0Safe = escHtml(p0);
  const p1Safe = escHtml(p1);
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
      if (hasP0name && !hasP1name) return p0Safe;
      if (hasP1name && !hasP0name) return p1Safe;
      if (hasJ0 && !hasJ1) return p0Safe;
      if (hasJ1 && !hasJ0) return p1Safe;
      return p0Safe;
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
        : (winner === p0Safe ? 0 : 1);
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
        : (winner === p0Safe ? 0 : 1);
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
    if (winner === p0Safe) pts0 += pts;
    else pts1 += pts;
    rows.push(
      `<div class="sum-row"><span class="sum-label">${label}</span><span class="sum-pts">+${pts}</span></div>`,
    );
  }

  let html = '<div class="summary-events">';
  html += rows.length
    ? rows.join("")
    : '<div style="color:var(--muted);font-size:12px">Cap punt especial</div>';
  html += `</div><div class="sum-result">${p0Safe} <span class="sum-score">${pts0}</span> - <span class="sum-score">${pts1}</span> ${p1Safe}</div>`;
  return html;
}

// --- Cuenta atrás entre manos ------------------------------------------------
function stopBetween() {
  if (betweenTimer != null) clearTimeout(betweenTimer);
  betweenTimer = null;
  // No ocultar si el resumen de fin de partida está usando el mismo overlay.
  if (gameEndSummaryTimer == null) {
    $("countdownOverlay").classList.add("hidden");
  }
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
/**
 * Draws face-down cards for a rival/teammate zone.
 * Detects if the zone uses vertical stacking (side-cards) or horizontal (top/bottom)
 * and adjusts offsets accordingly.
 */
/**
 * @param {"normal"|"empty"|"dealIntro"} [zoneMode]
 */
function renderPlayerZone(zoneEl, handObj, zoneMode = "normal") {
  if (!zoneEl) return;
  if (zoneMode === "empty") {
    zoneEl.replaceChildren();
    zoneEl.setAttribute("data-count", "0");
    return;
  }
  zoneEl.replaceChildren();
  const cards = fromHObj(handObj);
  const n = cards.length;
  zoneEl.setAttribute("data-count", String(n));
  const dealIntro = zoneMode === "dealIntro";
  const isVertical = zoneEl.classList.contains("side-cards");
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    s.className = "rival-card-slot";
    if (isVertical) {
      // Vertical stacking: CSS handles margin-top via .side-cards .rival-card-slot
      s.style.cssText = `z-index:${i + 1};`;
    } else {
      const angles = n === 3 ? [-8, 0, 8] : n === 2 ? [-5, 5] : [0];
      const xoffs  = n === 3 ? [-44, 0, 44] : n === 2 ? [-24, 24] : [0];
      s.style.cssText = `transform:translateX(${xoffs[i] || 0}px) rotate(${angles[i] || 0}deg);z-index:${i + 1};`;
    }
    if (dealIntro) {
      s.style.opacity = "0";
      s.style.transition = "none";
    }
    s.appendChild(dealIntro ? buildHandDealBack() : buildBack());
    zoneEl.appendChild(s);
  }
}

/**
 * Per a 2v2 (4 seients), retorna [rivalDret, rivalEsquerra] en ordre CCW des de `me`.
 * - rivalDret  = primer rival trobat anant CCW (a la dreta del jugador)
 * - rivalEsquerra = segon rival trobat anant CCW (a l'esquerra del jugador)
 *
 * Càlcul: seients en disposició horària (0=S,1=W,2=N,3=E);
 * CCW des de 0: [3,2,1] → first rival=3(E=dreta), second rival=1(W=esquerra) ✓
 */
function _ccwRivals(me) {
  const rivals = [];
  for (let i = 1; i < 4; i++) {
    const s = (me - i + 4) % 4;
    if (teamOf(s) !== teamOf(me)) rivals.push(s);
  }
  return rivals; // [rivalDret, rivalEsquerra]
}

/** Clau estable per mano dins la sala (repartiment animat cada mano). */
function getHandDealAnimKeyFromState(state) {
  if (state.status !== "playing" || !state.hand) return "";
  if (state.hand.status !== "in_progress") return "";
  const hn = real(state.handNumber || OFFSET);
  return `${session.roomCode || ""}|hn:${hn}`;
}

function myHandReadyForDealAnim(state) {
  const h = state.hand;
  if (!h || h.status !== "in_progress") return false;
  const mine = fromHObj(h.hands?.[K(session.mySeat)]);
  if (!mine.length) return false;
  if (mine.includes("*") || mine.includes(EMPTY_CARD)) return false;
  return true;
}

/**
 * Alinia la seqüència de repartiment amb la mano actual tan bon punt hi ha `state.hand`
 * (no esperem cartes sense *): així cada mano nova rep `dealIntro` / opacitat 0 als rivals.
 */
function syncHandDealSequenceState(state) {
  if (state.status !== "playing" || !state.hand) return;
  const dealKey = getHandDealAnimKeyFromState(state);
  if (!dealKey) return;
  if (dealKey === _openingFullDealDoneKey) return;
  if (_openingFullDealKey !== dealKey) {
    _openingFullDealKey = dealKey;
    _openingFullDealSeatIdx = 0;
    _openingFullDealDoneKey = "";
    _openingFullDealAnimating = false;
  }
}

function openingFullDealBlocking(state) {
  const k = getHandDealAnimKeyFromState(state);
  return !!k && _openingFullDealDoneKey !== k;
}

/**
 * @returns {"normal"|"empty"|"dealIntro"}
 */
function openingDealZoneModeForSeat(state, seat) {
  if (!state.hand) return "normal";
  const k = getHandDealAnimKeyFromState(state);
  if (!k || _openingFullDealDoneKey === k) return "normal";
  const order = playOrder(state.mano, state);
  const idx = order.indexOf(seat);
  if (idx < 0) return "normal";
  if (idx > _openingFullDealSeatIdx) return "empty";
  if (idx < _openingFullDealSeatIdx) return "normal";
  return "dealIntro";
}

function zoneElForSeat(state, seat) {
  if (seat === session.mySeat) return $("myCards");
  const n = getNumSeats(state);
  if (n === 2) return $("rivalCards");
  const me = session.mySeat;
  const tmSeat = (me + 2) % 4;
  if (seat === tmSeat) return $("teammateCards");
  const [rivalR, rivalL] = _ccwRivals(me);
  if (seat === rivalR) return $("rivalRightCards");
  if (seat === rivalL) return $("rivalCards");
  return null;
}

function finishOpeningFullDeal() {
  if (typeof _dismissBonaSort === "function") {
    _dismissBonaSort();
    _dismissBonaSort = null;
  }
  _openingFullDealDoneKey = _openingFullDealKey;
  _openingFullDealAnimating = false;
  _introPlayed = true;
  if (_lastRoom) renderAll(_lastRoom);
}

function tryRunOpeningDealAnimation(state) {
  const dk = getHandDealAnimKeyFromState(state);
  if (!dk || _openingFullDealDoneKey === dk) return;
  if (!myHandReadyForDealAnim(state)) return;
  if (_openingFullDealAnimating) return;
  const h = state.hand;
  if (!h) return;
  const dealOrder = playOrder(state.mano, state);
  if (_openingFullDealSeatIdx >= dealOrder.length) {
    finishOpeningFullDeal();
    return;
  }
  const seat = dealOrder[_openingFullDealSeatIdx];
  const zone = zoneElForSeat(state, seat);
  if (!zone) return;
  const wraps =
    seat === session.mySeat
      ? zone.querySelectorAll(".my-card-wrap")
      : zone.querySelectorAll(".rival-card-slot");
  if (wraps.length !== 3) return;

  _openingFullDealAnimating = true;
  const myCardsForFlip =
    seat === session.mySeat ? fromHObj(h.hands?.[K(seat)]) : [];

  const onDealAnimationComplete = () => {
    _openingFullDealAnimating = false;
    _openingFullDealSeatIdx++;
    if (_lastRoom) renderAll(_lastRoom);
  };

  if (seat === session.mySeat) {
    animateMyHandDealFromDeck(wraps, {
      onDealAnimationComplete,
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
        sub.call(function () {
          const faces = [];
          allWraps.forEach((w, idx) => {
            const face = buildCard(myCardsForFlip[idx]);
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
              });
            },
          });
        });
        return sub;
      },
      onDealAborted(wrapsAborted) {
        wrapsAborted.forEach((w, idx) => {
          const c = myCardsForFlip[idx];
          if (!w || !c) return;
          if (w.querySelector(".card-back-hand")) {
            w.replaceChildren(buildCard(c));
          }
        });
      },
    });
  } else {
    const g = globalThis.gsap;
    animateMyHandDealFromDeck(wraps, {
      onDealAnimationComplete,
      // Mateixa branca stack+stagger que el jugador (sense girar cares).
      flipAllSubtimeline() {
        if (!g) return null;
        return g.timeline();
      },
    });
  }
}

/**
 * Mapeja cada seat (que no siga el meu) a la seua zona HTML.
 * 1v1: rival → #rivalCards (com abans)
 * 2v2 creu:
 *   - Company (teammate) → #teammateCards (dalt, seient oposat)
 *   - Rival dret (primer CCW) → #rivalRightCards (dreta)
 *   - Rival esquerra (segon CCW) → #rivalCards (esquerra)
 */
function renderRivalZones(state) {
  const n = getNumSeats(state);
  const is2v2 = n === 4;

  // Alternar mode visual
  const body = document.body;
  const table = $("table");
  if (is2v2) {
    body.setAttribute("data-mode", "2v2");
    if (table) table.classList.add("table-2v2");
  } else {
    body.removeAttribute("data-mode");
    if (table) table.classList.remove("table-2v2");
  }

  // Mostrar/ocultar zones 2v2
  const tmZone = $("teammateZone");
  const rrZone = $("rivalRightZone");
  if (tmZone) tmZone.classList.toggle("hidden", !is2v2);
  if (rrZone) rrZone.classList.toggle("hidden", !is2v2);

  if (!is2v2) {
    // 1v1: renderitzar al rival al rivalCards com sempre
    const rivalSeat = other(session.mySeat);
    renderPlayerZone(
      $("rivalCards"),
      state.hand?.hands?.[K(rivalSeat)],
      openingDealZoneModeForSeat(state, rivalSeat),
    );
    // Nom i avatar del rival
    const rn = $("rivalName");
    if (rn) rn.textContent = pName(state, rivalSeat);
    return;
  }

  // 2v2: company sempre al seient oposat (me+2)%4
  const me = session.mySeat;
  const tmSeat = (me + 2) % 4;
  renderPlayerZone(
    $("teammateCards"),
    state.hand?.hands?.[K(tmSeat)],
    openingDealZoneModeForSeat(state, tmSeat),
  );
  const tn = $("teammateName");
  if (tn) tn.textContent = pName(state, tmSeat);

  // Rivals: [rivalDret, rivalEsquerra] en ordre CCW
  const [rivalR, rivalL] = _ccwRivals(me);
  renderPlayerZone(
    $("rivalCards"),
    state.hand?.hands?.[K(rivalL)],
    openingDealZoneModeForSeat(state, rivalL),
  );
  renderPlayerZone(
    $("rivalRightCards"),
    state.hand?.hands?.[K(rivalR)],
    openingDealZoneModeForSeat(state, rivalR),
  );
  const rn = $("rivalName");
  if (rn) rn.textContent = pName(state, rivalL);
  const rrn = $("rivalRightName");
  if (rrn) rrn.textContent = pName(state, rivalR);
}

export function resetHandIntroPlayed() {
  _introPlayed = false;
  _versusIntroShownKey = "";
  _openingAnimPendingKey = "";
  _openingAnimDoneKey = "";
  _openingAnimRunning = false;
  _openingFullDealKey = "";
  _openingFullDealDoneKey = "";
  _openingFullDealSeatIdx = 0;
  _openingFullDealAnimating = false;
  if (typeof _dismissBonaSort === "function") {
    _dismissBonaSort();
    _dismissBonaSort = null;
  }
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
  let myCards = fromHObj(h.hands?.[K(session.mySeat)]);
  const playedNow = getPlayed(h, session.mySeat);
  if (playedNow) {
    myCards = myCards.filter((c) => c !== playedNow);
  }
  if (optimisticCardIndex !== null) {
    myCards = myCards.filter((c) => c !== optimisticCardIndex);
  }
  // Wait for secret hands to be injected before rendering anything
  if (myCards.includes("*") || myCards.includes(EMPTY_CARD)) return;

  const orchestratingOpening = openingFullDealBlocking(state);
  if (orchestratingOpening) {
    const order = playOrder(state.mano, state);
    const myIdx = order.indexOf(session.mySeat);
    if (myIdx > _openingFullDealSeatIdx) {
      if (z._hoverCleanups) {
        z._hoverCleanups.forEach(fn => fn && typeof fn === "function" ? fn() : null);
      }
      z._hoverCleanups = [];
      z.replaceChildren();
      _prevHandsKey = `deal-wait|${_openingFullDealSeatIdx}|${session.mySeat}`;
      return;
    }
  }

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
    !_handDecided &&
    !openingFullDealBlocking(state);

  const dealTag = orchestratingOpening
    ? `|od:${_openingFullDealSeatIdx}`
    : "";
  const handsKey = myCards.join(",") + "|" + canPlay + dealTag;
  if (handsKey === _prevHandsKey && z.children.length === myCards.length)
    return;
  _prevHandsKey = handsKey;

  if (z._hoverCleanups) {
    z._hoverCleanups.forEach(fn => fn && typeof fn === "function" ? fn() : null);
  }
  z._hoverCleanups = [];

  z.replaceChildren();

  const iAmCurrentDealSeat =
    orchestratingOpening &&
    playOrder(state.mano, state).indexOf(session.mySeat) ===
      _openingFullDealSeatIdx;

  const handDealIntroOrchestrated =
    orchestratingOpening &&
    iAmCurrentDealSeat &&
    !!globalThis.gsap &&
    emptyBefore &&
    myCards.length === 3 &&
    !myCards.includes("*");

  const handDealIntroLegacy =
    !orchestratingOpening &&
    !!globalThis.gsap &&
    emptyBefore &&
    myCards.length === 3 &&
    !myCards.includes("*") &&
    !_introPlayed;

  const handDealIntro =
    handDealIntroOrchestrated || handDealIntroLegacy;

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

  if (
    handDealIntroLegacy &&
    z.querySelectorAll(".my-card-wrap").length === 3
  ) {
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
/**
 * Extrau la carta d'un seat d'un objecte trick.
 * Suporta format 1v1 (t.c0/t.c1) i 2v2 (t.cards.p0/.p1/.p2/.p3).
 */
function _trickCardForSeat(t, seat) {
  if (t.cards) return t.cards[PK(seat)] || null;
  return seat === 0 ? t.c0 : t.c1;
}

function _renderTrickGrid(allTricks, playedMap, numSeats, didRivalJustPlay = false) {
  const grid = $("trickGrid");
  if (!grid) return;
  grid.replaceChildren();

  const me = session.mySeat;
  const myTeam = teamOf(me);
  const hasCurrent = Object.values(playedMap || {}).some(Boolean);
  if (allTricks.length === 0 && !hasCurrent) return;

  // 2v2: apilar por jugador (cada seat tiene su propio montón)
  if (numSeats === 4) {
    const piles = document.createElement("div");
    piles.className = "trick-piles-4p";

    const tmSeat = (me + 2) % 4;
    const [rivalR, rivalL] = _ccwRivals(me);
    const positions = [
      { seat: tmSeat, cls: "trick-pos-top" },
      { seat: rivalL, cls: "trick-pos-left" },
      { seat: rivalR, cls: "trick-pos-right" },
      { seat: me, cls: "trick-pos-bottom" },
    ];

    const seatCards = new Map();
    for (const { seat } of positions) seatCards.set(seat, []);

    allTricks.forEach((t) => {
      for (const { seat } of positions) {
        const code = _trickCardForSeat(t, seat);
        if (!code || code === EMPTY_CARD) continue;
        const isDraw = t.w === 99 || t.w === null || t.w === undefined;
        const won = !isDraw && teamOf(seat) === t.w;
        seatCards.get(seat).push({ code, won, isCurrent: false });
      }
    });

    if (hasCurrent) {
      for (const { seat } of positions) {
        const code = playedMap?.[seat];
        if (!code || code === EMPTY_CARD) continue;
        seatCards.get(seat).push({ code, won: false, isCurrent: true });
      }
    }

    for (const { seat, cls } of positions) {
      const pile = document.createElement("div");
      pile.className = `trick-pile ${cls}`;
      const cards = seatCards.get(seat) || [];

      cards.forEach((entry, idx) => {
        const el = buildCard(entry.code);
        el.classList.add("trick-pile-card");
        el.style.zIndex = String(idx + 1);
        el.style.top = `${idx * 6}px`;

        if (entry.won) el.classList.add("trick-winner");
        globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });

        if (entry.isCurrent) {
          const isRival = teamOf(seat) !== myTeam;
          if (didRivalJustPlay && isRival) animateRivalPlay(el);
          else el.classList.add("land-anim");
        }

        pile.appendChild(el);
      });

      piles.appendChild(pile);
    }

    grid.appendChild(piles);
    return;
  }

  // Helper: construeix una columna de basa
  const buildTrickCol = (getCard, winner, isCurrent, justPlayed) => {
    const col = document.createElement("div");
    col.className = "trick-col";
    const isDraw = winner === 99 || winner === null || winner === undefined;
    if (isDraw && !isCurrent) col.classList.add("trick-draw");

    if (numSeats === 4) {
      // 2v2: disposició en CREU — 4 posicions relatives al jugador local
      col.classList.add("trick-col-4p");
      const tmSeat  = (me + 2) % 4;           // company: seient oposat
      const [rivalR, rivalL] = _ccwRivals(me); // dret=primer CCW, esquerra=segon CCW
      const positions = [
        { seat: tmSeat,  cls: "trick-pos-top"    },
        { seat: rivalL,  cls: "trick-pos-left"   },
        { seat: rivalR,  cls: "trick-pos-right"  },
        { seat: me,      cls: "trick-pos-bottom" },
      ];
      for (const { seat, cls } of positions) {
        const cell = document.createElement("div");
        cell.className = cls;
        const code = getCard(seat);
        if (code && code !== EMPTY_CARD) {
          const el = buildCard(code);
          // winner és índex d'equip (0|1|99); teamOf(seat) diu a quin equip pertany
          if (!isDraw && !isCurrent && winner !== undefined && teamOf(seat) === winner)
            el.classList.add("trick-winner");
          globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });
          const isRival = teamOf(seat) !== myTeam;
          if (isCurrent && justPlayed && isRival) animateRivalPlay(el);
          else if (isCurrent) el.classList.add("land-anim");
          cell.appendChild(el);
        }
        col.appendChild(cell);
      }
      return col;
    }

    // 1v1: disposició original (rival dalt, meua baix)
    const cellRival = document.createElement("div");
    cellRival.className = "trick-cell-rival";
    for (let s = 0; s < numSeats; s++) {
      if (teamOf(s) === myTeam) continue;
      const code = getCard(s);
      if (code && code !== EMPTY_CARD) {
        const el = buildCard(code);
        if (!isDraw && !isCurrent && winner !== undefined && teamOf(winner) !== myTeam)
          el.classList.add("trick-winner");
        globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });
        if (isCurrent && justPlayed && teamOf(s) !== myTeam) animateRivalPlay(el);
        else if (isCurrent) el.classList.add("land-anim");
        cellRival.appendChild(el);
      }
    }

    const sep = document.createElement("div");
    sep.className = "trick-row-sep";

    const cellMine = document.createElement("div");
    cellMine.className = "trick-cell-mine";
    for (let s = 0; s < numSeats; s++) {
      if (teamOf(s) !== myTeam) continue;
      const code = getCard(s);
      if (code && code !== EMPTY_CARD) {
        const el = buildCard(code);
        if (!isDraw && !isCurrent && winner !== undefined && teamOf(winner) === myTeam)
          el.classList.add("trick-winner");
        globalThis.gsap?.set(el, { rotationX: 25, transformPerspective: 400 });
        if (isCurrent) el.classList.add("land-anim");
        cellMine.appendChild(el);
      }
    }

    col.appendChild(cellRival);
    col.appendChild(sep);
    col.appendChild(cellMine);
    return col;
  };

  // Bazas resoltes
  allTricks.forEach((t) => {
    grid.appendChild(
      buildTrickCol((s) => _trickCardForSeat(t, s), t.w, false, false)
    );
  });

  // Basa actual
  if (hasCurrent) {
    grid.appendChild(
      buildTrickCol((s) => playedMap[s] || null, undefined, true, didRivalJustPlay)
    );
  }
}

function renderTrickSnapshot(snapshot) {
  const key = "snap|" + snapshot.key;
  if (key === _prevTrickKey) return;
  _prevTrickKey = key;
  _renderTrickGrid(snapshot.allTricks, {}, snapshot.numSeats || 2);
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
  const numSeats = h.numSeats || 2;

  // Construir mapa de played per a tots els seats
  const playedMap = {};
  for (let s = 0; s < numSeats; s++) playedMap[s] = getPlayed(h, s);
    
  // Detectar si algun rival acaba de jugar
  let totalRivalPlayed = allT.length;
  for (let s = 0; s < numSeats; s++) {
    if (teamOf(s) !== teamOf(session.mySeat) && playedMap[s]) totalRivalPlayed++;
  }
  let didRivalJustPlay = false;
  if (totalRivalPlayed > _prevRivalPlayedCount) {
    sndCard(Math.floor(Math.random() * 15));
    didRivalJustPlay = true;
  }
  _prevRivalPlayedCount = totalRivalPlayed;

  const offerTag = h.pendingOffer
    ? `${h.pendingOffer.kind}:${h.pendingOffer.level}`
    : "";
  // trickKey inclou totes les cartes jugades
  let playedStr = "";
  for (let s = 0; s < numSeats; s++) playedStr += "|" + (playedMap[s] || "-");
  const trickKey =
    real(state.handNumber || OFFSET) +
    "|" + allT.length +
    playedStr +
    "|" + h.mode +
    "|" + offerTag;

  if (trickKey !== _prevTrickKey) {
    _prevTrickKey = trickKey;
    _renderTrickGrid(allT, playedMap, numSeats, didRivalJustPlay);
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
        else if (teamOf(t.winner) === teamOf(session.mySeat)) d.classList.add("won");
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
  const h = state.hand;
  const curOfferStr = h?.pendingOffer ? `${h.pendingOffer.kind}:${h.pendingOffer.level}` : "";
  if (curOfferStr && curOfferStr !== _prevPendingOfferStr) {
    const isHighAlert = (h.pendingOffer.kind === "truc" && Number(h.pendingOffer.level) === 4) || (h.pendingOffer.kind === "envit" && h.pendingOffer.level === "falta");
    const isLowAlert = (h.pendingOffer.kind === "truc" && Number(h.pendingOffer.level) === 3) || (h.pendingOffer.kind === "envit" && Number(h.pendingOffer.level) === 4);
    if (isHighAlert) animateScreenShake("high");
    else if (isLowAlert) animateScreenShake("low");
  }
  _prevPendingOfferStr = curOfferStr;

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

  if (openingFullDealBlocking(state)) {
    ["envitBtn", "faltaBtn", "trucBtn", "mazoBtn"].forEach((id) => {
      const b = $(id);
      if (b) b.classList.add("hidden");
    });
    const raDeal = $("responseArea"),
      omDeal = $("offerMsg");
    if (raDeal) {
      raDeal.innerHTML = "";
      raDeal.classList.add("hidden");
    }
    if (omDeal) omDeal.classList.add("hidden");
    const smDeal = $("statusMsg");
    if (smDeal) {
      smDeal.textContent = "Repartint cartes\u2026";
      smDeal.classList.remove("my-turn");
    }
    $("actionPanel").style.display = "";
    return;
  }

  $("actionPanel").style.display = "";
  const myT = h.turn === session.mySeat,
    norm = h.mode === "normal",
    envDone = h.envit.state !== "none";
  const played = alreadyPlayed(h, session.mySeat);

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

  // N-seat aware: noone has played yet only when ALL seats are empty
  const nadieHaJugado = (() => {
    const ns = h.numSeats || 2;
    for (let s = 0; s < ns; s++) { if (alreadyPlayed(h, s)) return false; }
    return true;
  })();
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
      
      if (cls === "btn-envit-3" || cls === "btn-truc-3") animateScreenShake("high");
      else if (cls === "btn-envit-2" || cls === "btn-truc-2") animateScreenShake("low");

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
      // Opció d'envidar en resposta al truc (si l'equip respondedor encara pot envidar)
      if (h.envitAvailable && h.envit.state === "none") {
        add("Envit", "btn-envit-1", () => startOffer("envit"));
        add("Falta", "btn-envit-3", () => startOffer("falta"));
      }
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
        const canEscalate = Logica.canSeatEscalateAcceptedTruc(
          h,
          session.mySeat,
        );
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
    if (played && !allPlayed(h)) {
      // In 2v2 show the name of whoever actually has the turn, not just "the other"
      sm.textContent = `Esperant a ${pName(state, h.turn)}...`;
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
  const botCards = fromHObj(h.hands?.[K(botSeat)]);
  if (botCards.includes("*") || botCards.includes(EMPTY_CARD)) return false;

  return h.mode === "normal" && !alreadyPlayed(h, botSeat);
}

function scheduleBotIfNeededFromGameState(state) {
  if (!isBotActive() || _botThinking) return;
  if (openingFullDealBlocking(state)) return;
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
        if (_lastRoom) renderAll(_lastRoom);
      });
  }, botDelayMs);
}

// --- Turn-zone indicator (1v1 + 2v2) -----------------------------------------
/**
 * Applies .zone-active-turn / .zone-waiting to every player zone.
 * In 1v1 also toggles the legacy .turn-active class.
 * seatToZoneId maps seat → DOM element id so the logic is data-driven.
 */
function updateRivalTimer(state) {
  const h = state.hand;
  const n = getNumSeats(state);
  const is2v2 = n === 4;
  const playing = h && state.status === "playing" && h.status === "in_progress";
  const activeSeat = playing ? h.turn : -1;

  if (!is2v2) {
    // 1v1 legacy path — keep .turn-active for CSS transitions
    const my = $("myZone"), riv = $("rivalZone");
    const myActive  = playing && activeSeat === session.mySeat && !alreadyPlayed(h, session.mySeat);
    const rivActive = playing && activeSeat === other(session.mySeat) && !alreadyPlayed(h, other(session.mySeat));
    if (my)  my.classList.toggle("turn-active", !!myActive);
    if (riv) riv.classList.toggle("turn-active", !!rivActive);
    // clear 2v2 classes if mode was switched
    [$("teammateZone"), $("rivalRightZone")].forEach(el => {
      el?.classList.remove("zone-active-turn", "zone-waiting", "team-a", "team-b");
    });
    return;
  }

  // 2v2 path — use zone-active-turn / zone-waiting + team color hints
  const me = session.mySeat;
  const tm = (me + 2) % 4; // company sempre al seient oposat
  const [rivalR, rivalL] = _ccwRivals(me); // dret=primer CCW, esquerra=segon CCW

  /** seat → zone element */
  const seatZone = (seat) => {
    if (seat === me)       return $("myZone");
    if (seat === tm)       return $("teammateZone");
    if (seat === rivalL)   return $("rivalZone");       // rivalZone = esquerra
    if (seat === rivalR)   return $("rivalRightZone");  // rivalRightZone = dreta
    return null;
  };

  [me, tm, rivalL, rivalR].forEach(seat => {
    const el = seatZone(seat);
    if (!el) return;
    const isActive = playing && activeSeat === seat && !alreadyPlayed(h, seat);
    el.classList.toggle("zone-active-turn", isActive);
    el.classList.toggle("zone-waiting", playing && !isActive);
    // team color class for the pulse animation
    el.classList.toggle("team-a", isActive && teamOf(seat) === 0);
    el.classList.toggle("team-b", isActive && teamOf(seat) === 1);
    // keep legacy turn-active for myZone (used by CSS timer ring)
    if (seat === me) el.classList.toggle("turn-active", isActive);
  });
}

// --- HUD ---------------------------------------------------------------------
function renderHUD(state) {
  const hideCode = session.roomVisibility === "public";
  const roomEl = $("hudRoom");
  if (roomEl) {
    if (hideCode) {
      roomEl.textContent = "";
      roomEl.classList.add("hidden");
    } else {
      roomEl.textContent = `Sala ${session.roomCode || "-"}`;
      roomEl.classList.remove("hidden");
    }
  }
  const puntosObjetivo =
    Number(state?.settings?.puntosParaGanar) === 24 ? 24 : 12;
  $("hudTarget").textContent = `${puntosObjetivo} pedres`;
  $("hudNick").textContent = pName(state, session.mySeat);
  $("hudMode").textContent = getNumSeats(state) === 4 ? "2v2" : "1v1";

  const myTeam = teamOf(session.mySeat);
  const rivTeam = myTeam === 0 ? 1 : 0;
  const sMy = getScore(state, myTeam);
  const sRiv = getScore(state, rivTeam);

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
  // Build seat→name map for all seats (supports 1v1 and 2v2)
  const numSeats = getNumSeats(state);
  const seatNames = {};
  for (let s = 0; s < numSeats; s++) seatNames[s] = pName(state, s);
  const frag = document.createDocumentFragment();
  (state.logs || []).slice(0, 15).forEach((item) => {
    const wrap = document.createElement("div");
    wrap.className = "log-entry";
    const line = document.createElement("div");
    line.className = "log-entry-line";
    let txt = item.text || "";
    for (let s = 0; s < numSeats; s++) {
      txt = txt.replace(new RegExp(`\\bJ${s}\\b`, "g"), seatNames[s]);
    }
    line.textContent = txt;
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
  // In 2v2 check presence of the first opponent; in 1v1 check the single rival
  const presenceSeat = getNumSeats(state) === 4
    ? opponents(session.mySeat, state)[0]
    : other(session.mySeat);
  get(ref(db, `rooms/${session.roomCode}/presence/${K(presenceSeat)}`))
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

export function getLastRoom() { return _lastRoom; }

// --- RENDER PRINCIPAL --------------------------------------------------------
export function renderAll(room) {
  const state = room?.state || defaultState();
  if (optimisticCardIndex !== null) {
    const _myHandCards = state.hand
      ? fromHObj(state.hand.hands?.[K(session.mySeat)])
      : [];
    if (!_myHandCards.includes(optimisticCardIndex)) {
      clearOptimisticCard();
      _prevTrickKey = "";
    }
  }

  const hideChatVsBot = isBotActive();
  const gameChatPanel = $("chatPanel");
  const waitingChatPanel = $("lobbyChatPanel");
  if (gameChatPanel) gameChatPanel.classList.toggle("hidden", hideChatVsBot);
  if (waitingChatPanel) waitingChatPanel.classList.toggle("hidden", hideChatVsBot);
  if (hideChatVsBot) {
    $("chatBox")?.classList.add("hidden");
    $("chatBadge")?.classList.add("hidden");
  }
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
  // In 2v2, check that at least one opponent is present (not both seats missing)
  if (
    session.mySeat !== null &&
    session.roomCode &&
    isActiveMatchState(state) &&
    state.status !== "game_over"
  ) {
    const n2 = getNumSeats(state);
    const opps2 = n2 === 4 ? opponents(session.mySeat, state) : [other(session.mySeat)];
    const allOpponentsGone = opps2.every(s => !state.players?.[K(s)]);
    if (allOpponentsGone) {
      if (!_claimMissingRivalPending) {
        _claimMissingRivalPending = true;
        claimWinByRivalAbsence().finally(() => {
          _claimMissingRivalPending = false;
        });
      }
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
    clearOptimisticCard();
    _introPlayed = false;
  }
  renderHUD(state);
  $("myName").textContent = pName(state, session.mySeat);
  // In 2v2 rivalName is set inside renderRivalZones; skip overwrite here
  if (getNumSeats(state) < 4) {
    $("rivalName").textContent = pName(state, other(session.mySeat));
  }

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

    const n4 = getNumSeats(state);
    const is2v2intro = n4 === 4;
    const me4 = session.mySeat;
    const _vsMineSrc = srcFromChoice(myAvatarChoice) || AVATAR_IMAGES[0];

    let bottomLabel, topLabel, rivalSrcForIntro, mineSrc2ForIntro = "", rivalSrc2ForIntro = "";
    if (is2v2intro) {
      // Bottom band: my team (me + teammate)
      const tmSeat4 = (me4 + 2) % 4; // company al seient oposat
      bottomLabel = `${pName(state, me4)} & ${pName(state, tmSeat4)}`;
      // Top band: opponent team names
      const opps4 = opponents(me4, state);
      const opp0Name = pName(state, opps4[0]);
      const opp1Name = opps4[1] !== undefined ? pName(state, opps4[1]) : "";
      topLabel = opp1Name ? `${opp0Name} & ${opp1Name}` : opp0Name;
      // Avatar: use first opponent's avatar
      rivalSrcForIntro =
        srcFromFirebaseAvatar(_lastRoom?.avatars?.[K(opps4[0])]) || AVATAR_IMAGES[0];
      mineSrc2ForIntro =
        srcFromFirebaseAvatar(_lastRoom?.avatars?.[K(tmSeat4)]) || AVATAR_IMAGES[0];
      rivalSrc2ForIntro =
        srcFromFirebaseAvatar(_lastRoom?.avatars?.[K(opps4[1])]) || AVATAR_IMAGES[0];
    } else {
      bottomLabel = pName(state, me4);
      topLabel    = pName(state, other(me4));
      rivalSrcForIntro =
        srcFromFirebaseAvatar(_lastRoom?.avatars?.[K(other(me4))]) || AVATAR_IMAGES[0];
    }

    Promise.resolve()
      .then(() =>
        playVersusIntro(
          bottomLabel,
          topLabel,
          _vsMineSrc,
          rivalSrcForIntro,
          mineSrc2ForIntro,
          rivalSrc2ForIntro,
        ),
      )
      .catch(() => {})
      .then(() => {
        if (isBotActive() && _lastRoom?.state) {
          scheduleBotIfNeededFromGameState(_lastRoom.state);
        }
        if (typeof _dismissBonaSort === "function") {
          _dismissBonaSort();
          _dismissBonaSort = null;
        }
        _dismissBonaSort = showHoldCenterTableMessage("Bona sort!");
        _openingAnimDoneKey = openingAnimKey;
        _openingAnimRunning = false;
        if (_lastRoom) renderAll(_lastRoom);
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

  syncHandDealSequenceState(state);
  renderRivalZones(state);
  updateRivalTimer(state);
  renderMyCards(state);
  const _ns = getNumSeats(state);
  if (state.hand) {
    _lastCompletedTricks = {
      allTricks: state.hand.allTricks || [],
      key: real(state.handNumber || OFFSET) + "-" + Logica.getTrickIndex(state.hand),
      numSeats: state.hand.numSeats || _ns,
    };
  } else if (state.lastAllTricks && state.lastAllTricks.length > 0) {
    const lk = "lat-" + state.lastAllTricks.length + "-" + state.handNumber;
    if (_lastCompletedTricks?.key !== lk) {
      _lastCompletedTricks = { allTricks: state.lastAllTricks, key: lk, numSeats: _ns };
    }
  }
  if (!state.hand && _lastCompletedTricks) {
    renderTrickSnapshot(_lastCompletedTricks);
  } else {
    renderTrick(state);
  }
  renderActions(state);
  renderLog(state);
  tryRunOpeningDealAnimation(state);
  const bothJoined = bothPlayersJoined(state);

  if (state.status === "abandoned") {
    _betweenCountdownLatch = false;
    stopBetween();
    stopTurnTimer();
    if ($("waitingOverlay")) $("waitingOverlay").classList.add("hidden");
    if ($("gameOverOverlay")) $("gameOverOverlay").classList.add("hidden");
    
    let abModal = $("abandonedModal");
    if (!abModal) {
      abModal = document.createElement("div");
      abModal.id = "abandonedModal";
      abModal.className = "game-over-overlay";
      abModal.style.zIndex = "9999";
      abModal.innerHTML = `
        <div style="background:rgba(0,0,0,0.85); padding:24px; border-radius:12px; text-align:center; border:1px solid var(--gold);">
          <h2 style="color:var(--gold); margin-bottom:12px;">Sala inactiva</h2>
          <p style="margin-bottom:20px;">La partida ha finalitzat per inactivitat.</p>
          <button id="abModalLeaveBtn" class="lbtn lbtn-primary">Tornar al lobby</button>
        </div>
      `;
      document.body.appendChild(abModal);
      $("abModalLeaveBtn").addEventListener("click", () => {
        abModal.classList.add("hidden");
        const goLeaveBtn = document.getElementById("goLeaveBtn");
        if (goLeaveBtn) goLeaveBtn.click();
        else window.location.reload();
      });
    }
    abModal.classList.remove("hidden");
    return;
  }

  if (state.status === "game_over") {
    _betweenCountdownLatch = false;
    // Solo detener el between si no hay ya un resumen de fin de partida activo.
    if (gameEndSummaryTimer == null) stopBetween();
    stopTurnTimer();
    $("waitingOverlay").classList.add("hidden");
    const animKey = `${session.roomCode}|${state.winner}|${getScore(state, session.mySeat)}-${getScore(state, other(session.mySeat))}|${state.logs?.[0]?.at ?? ""}|${state.gameEndReason || ""}`;
    const abandonment = state.gameEndReason === "abandonment";
    const showGameOverOverlay = () => {
      const st = _lastState;
      if (!st || st.status !== "game_over") return;
      _gameEndSummaryLatch = false;
      // In 2v2 state.winner is the team index (0 or 1); in 1v1 it equals the seat.
      const n2v2 = getNumSeats(st);
      const iWon = n2v2 === 4
        ? teamOf(session.mySeat) === st.winner
        : st.winner === session.mySeat;
      const aband = st.gameEndReason === "abandonment";
      $("gameOverOverlay").classList.remove("hidden");
      $("goTitle").textContent = iWon ? "\ud83c\udfc6 Has guanyat!" : "\ud83d\ude05 Has perdut";
      // Winner label: in 2v2 show both team members
      if (n2v2 === 4 && st.winner !== undefined) {
        const winnerTeam = st.winner; // 0 or 1
        const wSeats = [0, 1, 2, 3].filter(s => teamOf(s) === winnerTeam);
        const wNames = wSeats.map(s => pName(st, s)).filter(Boolean);
        $("goWinner").textContent = wNames.join(" & ") + " guanyen";
      } else {
        $("goWinner").textContent = pName(st, st.winner) + " guanya";
      }
      const myTeamGO  = n2v2 === 4 ? teamOf(session.mySeat) : session.mySeat;
      const rivTeamGO = myTeamGO === 0 ? 1 : 0;
      $("goScore").textContent =
        aband && iWon
          ? "Has guanyat per abandonament!"
          : aband && !iWon
            ? "Has perdut per abandonament (temps de reconnexió esgotat)."
            : `${getScore(st, myTeamGO)} - ${getScore(st, rivTeamGO)}`;
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
      const hideWaitingRoomCode =
        session.roomVisibility === "public" || isBotActive();
      $("waitingCode").textContent = hideWaitingRoomCode
        ? ""
        : session.roomCode || "-";
      const modo = state?.settings?.modoJuego === "2v2" ? "2v2" : "1v1";
      const pts = Number(state?.settings?.puntosParaGanar) === 24 ? 24 : 12;
      const modeTag = $("waitingModeTag");
      const ptsTag = $("waitingPtsTag");
      if (modeTag) modeTag.innerHTML = `${ICO_USER}<span>${modo}</span>`;
      if (ptsTag) ptsTag.innerHTML = `${ICO_STONE}<span>${pts} pedres</span>`;
      const numSeats = getNumSeats(state);
      const is2v2 = numSeats === 4;

      // In 2v2 the WhatsApp button is inside slot-player-1 which already has a player;
      // move it below the faceoff section to avoid overlapping the slot card.
      const waBtn = $("waitingInviteWhatsappBtn");
      if (waBtn) {
        waBtn.classList.toggle("hidden", isBotActive());
        if (is2v2 && !isBotActive()) {
          // Reattach below the faceoff div so it doesn't cover slot-player-1
          const faceoff = $("waitingFaceoff");
          const actions = document.querySelector(".waiting-actions");
          if (faceoff && actions && waBtn.parentElement !== faceoff.parentElement) {
            faceoff.parentElement?.insertBefore(waBtn, actions);
          }
        }
      }
      $("waitingCodeRow")?.classList.toggle("hidden", hideWaitingRoomCode);
      const p0ready = !!state.ready?.[K(0)];
      const p1ready = !!state.ready?.[K(1)];
      const myReady = !!state.ready?.[K(session.mySeat)];
      let allFirebaseReady = true;
      for (let i = 0; i < numSeats; i++) {
        if (!state.ready?.[K(i)]) { allFirebaseReady = false; break; }
      }
      const isBotMatch = isBotActive();
      const canStartMatch = isBotMatch ? bothJoined : allFirebaseReady;

      // Mostrar/ocultar slots 2 i 3 segons mode
      const slot2 = $("slot-player-2");
      const slot3 = $("slot-player-3");
      if (slot2) slot2.classList.toggle("hidden", !is2v2);
      if (slot3) slot3.classList.toggle("hidden", !is2v2);
      const tlA = $("waitingTeamLabelA");
      const tlB = $("waitingTeamLabelB");
      if (tlA) tlA.classList.toggle("hidden", !is2v2);
      if (tlB) tlB.classList.toggle("hidden", !is2v2);

      if (!bothJoined) {
        const nJoined = Object.keys(state.players || {}).length;
        const missing = numSeats - nJoined;
        $("waitingStatus").innerHTML = is2v2
          ? `Esperant ${missing} jugador${missing > 1 ? "s" : ""}<span class="dots"></span>`
          : 'Esperant el segon jugador<span class="dots"></span>';
      } else if (isBotMatch) {
        $("waitingStatus").textContent = "Rival preparat! Pots iniciar la partida.";
      } else if (!allFirebaseReady) {
        $("waitingStatus").innerHTML = is2v2
          ? 'Cal que tots confirmeu \u00abpreparat\u00bb<span class="dots"></span>'
          : 'Cal que els dos confirmeu \u00abpreparat\u00bb<span class="dots"></span>';
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
          ? "Cal que tots els jugadors estiguen preparats"
          : "";
        sB.style.opacity = !canStartMatch ? "0.5" : "1";
        sB.style.cursor = !canStartMatch ? "not-allowed" : "pointer";
        $("hostReadyBtn").classList.toggle(
          "hidden",
          isBotMatch || !bothJoined || myReady,
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
      startTurnTimer(myTurn && h.status === "in_progress", h.turnStartedAt);
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
