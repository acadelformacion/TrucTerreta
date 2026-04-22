// --- animations.js — GSAP, confetti i temporitzadors de torn ----------------
import { sndTick, sndPoint } from "./audio.js";
import { timeoutTurn } from "./acciones.js";
import { isVibrationEnabled } from "./config.js";

const $ = (id) => document.getElementById(id);

// --- Constants de temporitzador de torn --------------------------------------
const RING_C = 2 * Math.PI * 25; // r=25 per als anells d'avatar
const TURN_SECS = 30;

// --- Estat intern dels temporitzadors ----------------------------------------
let turnTimer = null;
let turnTimerArm = null;
let lastTurnWasMine = null;

function vibrateMyTurnStart() {
  if (!isVibrationEnabled()) return;
  if (!("vibrate" in navigator)) return;
  try {
    navigator.vibrate(40);
  } catch {}
}

// --- Anell de temps (SVG stroke) ---------------------------------------------
export function setRing(arcId, _ringId, pct) {
  const arc = $(arcId);
  if (!arc) return;
  const dash = RING_C * (Math.max(0, pct) / 100);
  arc.style.strokeDasharray = `${dash} ${RING_C}`;
  const color = pct > 60 ? "#2ea043" : pct > 30 ? "#e8ab2a" : "#da3633";
  arc.style.stroke = color;
}

export function stopTurnTimer() {
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
  setRing("myTimerArc", "myTimerRing", 0);
  setRing("rivalTimerArc", "rivalTimerRing", 0);
}

export function startTurnTimer(isMyTurn) {
  stopTurnTimer();
  if (isMyTurn && lastTurnWasMine !== true) {
    vibrateMyTurnStart();
  }
  lastTurnWasMine = !!isMyTurn;
  let rem = TURN_SECS;
  const myWrap = $("myAvatarContainer");
  const rivWrap = $("rivalAvatarContainer");
  if (isMyTurn) {
    if (myWrap) myWrap.classList.add("turn-active");
    if (rivWrap) rivWrap.classList.remove("turn-active");
    setRing("myTimerArc", "myTimerRing", 100);
    setRing("rivalTimerArc", "rivalTimerRing", 0);
  } else {
    if (rivWrap) rivWrap.classList.add("turn-active");
    if (myWrap) myWrap.classList.remove("turn-active");
    setRing("myTimerArc", "myTimerRing", 0);
    setRing("rivalTimerArc", "rivalTimerRing", 100);
  }
  turnTimerArm = setTimeout(() => {
    turnTimerArm = null;
    turnTimer = setInterval(() => {
      rem--;
      const pct = Math.max(0, (rem / TURN_SECS) * 100);
      if (isMyTurn) {
        setRing("myTimerArc", "myTimerRing", pct);
      } else {
        setRing("rivalTimerArc", "rivalTimerRing", pct);
      }
      if (rem >= 1 && rem <= 5) sndTick();
      if (rem <= 0) {
        stopTurnTimer();
        if (isMyTurn) timeoutTurn();
      }
    }, 1000);
  }, 50);
}

// --- HUD: punts animats -------------------------------------------------------
let _oldHUD = { 0: null, 1: null };

export async function animateHUDPoints(id, targetValue, hudIdx) {
  const el = $(id);
  if (!el) return;

  if (_oldHUD[hudIdx] === null) {
    el.textContent = targetValue;
    _oldHUD[hudIdx] = targetValue;
    return;
  }

  let current = _oldHUD[hudIdx];

  if (targetValue <= current) {
    el.textContent = targetValue;
    _oldHUD[hudIdx] = targetValue;
    return;
  }

  if (el.dataset.animating === "true") return;
  el.dataset.animating = "true";

  const diff = targetValue - current;
  const stepMs = diff <= 2 ? 500 : diff <= 5 ? 250 : 120;
  const g = globalThis.gsap;

  while (current < targetValue) {
    current++;
    _oldHUD[hudIdx] = current;
    await new Promise((r) => setTimeout(r, stepMs));
    el.textContent = current;
    if (current === targetValue && g) {
      g.fromTo(
        el,
        { scale: 1 },
        {
          scale: 1.7,
          duration: 0.12,
          ease: "power2.out",
          yoyo: true,
          repeat: 1,
          onComplete: () => {
            el.style.transform = "";
          },
        },
      );
      g.fromTo(
        el,
        { textShadow: "0 0 0px #e8ab2a" },
        {
          textShadow: "0 0 24px #e8ab2a",
          duration: 0.12,
          yoyo: true,
          repeat: 1,
        },
      );
    }
  }
  el.dataset.animating = "false";
  sndPoint();
}

// --- Intro VS (GSAP) ----------------------------------------------------------
// mineSrc i rivalSrc es passen des del cridador per evitar dependència de avatars.js
export function playVersusIntro(myName, rivalName, mineSrc, rivalSrc) {
  const gsapLib = globalThis.gsap;
  const overlay = $("versusOverlay");
  const topBanner = $("vsBannerTop");
  const bottomBanner = $("vsBannerBottom");
  const vsText = $("vsText");
  const elRival = $("vsNameRival");
  const elMine = $("vsNameMine");
  const imgRival = $("vsAvatarRival");
  const imgMine = $("vsAvatarMine");
  if (!gsapLib || !overlay || !topBanner || !bottomBanner || !vsText) {
    return Promise.reject(
      new Error("playVersusIntro: falta GSAP o elements del DOM"),
    );
  }
  if (elRival) elRival.textContent = rivalName != null ? String(rivalName) : "";
  if (elMine) elMine.textContent = myName != null ? String(myName) : "";
  if (imgMine) {
    imgMine.src = mineSrc || "";
    imgMine.alt = myName != null ? String(myName) : "";
  }
  if (imgRival) {
    imgRival.src = rivalSrc || "";
    imgRival.alt = rivalName != null ? String(rivalName) : "";
  }

  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");

  return new Promise((resolve) => {
    gsapLib.killTweensOf([overlay, topBanner, bottomBanner, vsText]);
    gsapLib.set(overlay, { opacity: 1 });
    gsapLib.set(topBanner, { yPercent: -100 });
    gsapLib.set(bottomBanner, { yPercent: 100 });
    gsapLib.set(vsText, {
      xPercent: -50,
      yPercent: -50,
      scale: 2,
      transformOrigin: "50% 50%",
    });

    const tl = gsapLib.timeline({
      onComplete: () => {
        overlay.classList.add("hidden");
        overlay.setAttribute("aria-hidden", "true");
        gsapLib.set(overlay, { clearProps: "opacity" });
        gsapLib.set([topBanner, bottomBanner, vsText], {
          clearProps: "transform",
        });
        resolve();
      },
    });

    tl.to(topBanner, { yPercent: 0, duration: 0.55, ease: "power2.out" }, 0);
    tl.to(bottomBanner, { yPercent: 0, duration: 0.55, ease: "power2.out" }, 0);
    tl.to(vsText, { scale: 1, duration: 0.65, ease: "back.out(1.7)" }, ">");
    tl.to(
      overlay,
      { opacity: 0, duration: 0.5, ease: "power2.inOut" },
      "+=1.5",
    );
  });
}

export function playCenterTableMessage(text, durationMs = 1400) {
  const msg = document.createElement("div");
  msg.className = "table-msg-bubble msg-center start-hand-msg";
  msg.textContent = String(text || "").toUpperCase();
  document.querySelectorAll(".start-hand-msg").forEach((el) => el.remove());
  document.body.appendChild(msg);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      msg.remove();
      resolve();
    };
    msg.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, durationMs);
  });
}

export function playIncomingOfferShake(isHighAlert = false) {
  const g = globalThis.gsap;
  if (!g) return;
  const panel = document.getElementById("actionPanel");
  const table = document.getElementById("table");
  const target = panel || table;
  if (!target) return;

  g.killTweensOf(target);
  if (table && table !== target) g.killTweensOf(table);

  const amp = isHighAlert ? 12 : 9;
  const reps = isHighAlert ? 7 : 5;
  const step = isHighAlert ? 0.018 : 0.02;

  const tl = g.timeline({
    onComplete: () => {
      g.set(target, { clearProps: "x,boxShadow" });
      if (table && table !== target) g.set(table, { clearProps: "filter" });
    },
  });

  tl.fromTo(
    target,
    { x: 0 },
    {
      x: amp,
      duration: step,
      ease: "sine.inOut",
      repeat: reps,
      yoyo: true,
    },
    0,
  );

  tl.fromTo(
    target,
    { boxShadow: "0 0 0 rgba(255,214,90,0)" },
    {
      boxShadow: isHighAlert
        ? "0 0 0 2px rgba(255,120,120,0.55)"
        : "0 0 0 2px rgba(255,214,90,0.45)",
      duration: 0.12,
      yoyo: true,
      repeat: 1,
      ease: "power1.inOut",
    },
    0,
  );

  if (table && table !== target) {
    tl.fromTo(
      table,
      { filter: "brightness(1)" },
      {
        filter: isHighAlert ? "brightness(1.14)" : "brightness(1.09)",
        duration: 0.1,
        yoyo: true,
        repeat: 1,
        ease: "power1.inOut",
      },
      0,
    );
  }
}

// --- Animació de carta voladora -----------------------------------------------
// flyEl és l'element de carta ja construït pel cridador (buildCard al mòdul de render).
export function animatePlay(cardEl, flyEl, onDone) {
  const slot = document.getElementById("trickGrid");
  const fr = cardEl.getBoundingClientRect();
  const to = slot
    ? slot.getBoundingClientRect()
    : {
        left: window.innerWidth / 2,
        top: window.innerHeight / 2,
        width: 80,
        height: 114,
      };
  flyEl.classList.add("card-flying");
  flyEl.style.cssText = `left:${fr.left}px;top:${fr.top}px;width:${fr.width}px;height:${fr.height}px;position:fixed;pointer-events:none;z-index:200;`;
  flyEl.style.setProperty(
    "--tx",
    to.left + to.width / 2 - fr.left - fr.width / 2 + "px",
  );
  flyEl.style.setProperty(
    "--ty",
    to.top + to.height / 2 - fr.top - fr.height / 2 + "px",
  );
  flyEl.style.setProperty("--rot", Math.random() * 10 - 5 + "deg");
  document.body.appendChild(flyEl);
  flyEl.addEventListener(
    "animationend",
    () => {
      flyEl.remove();
      if (onDone) onDone();
    },
    { once: true },
  );
}

// --- Fi de partida: canvas-confetti + GSAP (.go-card) -------------------------
const GO_CONFETTI_COLORS = ["#D32F2F", "#FBC02D", "#1976D2"];
let _goConfettiFire = null;
let _goConfettiRainInterval = null;
/** @type {ReturnType<typeof setTimeout>[]} */
const _goConfettiTimeouts = [];

function getGameOverConfetti() {
  const canvas = document.getElementById("confettiCanvas");
  const cf = globalThis.confetti;
  if (!canvas || typeof cf?.create !== "function") return null;
  if (!_goConfettiFire) {
    _goConfettiFire = cf.create(canvas, {
      resize: true,
      disableForReducedMotion: true,
    });
  }
  return _goConfettiFire;
}

function resetGameOverConfettiOnly() {
  if (_goConfettiRainInterval != null) {
    clearInterval(_goConfettiRainInterval);
    _goConfettiRainInterval = null;
  }
  while (_goConfettiTimeouts.length) {
    clearTimeout(_goConfettiTimeouts.pop());
  }
  if (_goConfettiFire && typeof _goConfettiFire.reset === "function") {
    _goConfettiFire.reset();
  }
}

function scheduleGoConfettiTimeout(fn, ms) {
  const id = setTimeout(() => {
    const i = _goConfettiTimeouts.indexOf(id);
    if (i !== -1) _goConfettiTimeouts.splice(i, 1);
    fn();
  }, ms);
  _goConfettiTimeouts.push(id);
}

function playGameOverConfettiWinner(fire) {
  const burst = () => {
    fire({
      particleCount: 88,
      angle: 62,
      spread: 56,
      startVelocity: 50,
      origin: { x: 0, y: 1 },
      colors: GO_CONFETTI_COLORS,
    });
    fire({
      particleCount: 88,
      angle: 118,
      spread: 56,
      startVelocity: 50,
      origin: { x: 1, y: 1 },
      colors: GO_CONFETTI_COLORS,
    });
  };
  burst();
  scheduleGoConfettiTimeout(burst, 300);
  scheduleGoConfettiTimeout(burst, 620);
  scheduleGoConfettiTimeout(resetGameOverConfettiOnly, 6500);
}

function playGameOverConfettiLoser(fire) {
  const sadDrop = () => {
    fire({
      particleCount: 3,
      spread: 28,
      startVelocity: 5,
      gravity: 0.3,
      ticks: 300,
      // Arranca un poco dentro del canvas para que se vea caer desde el inicio.
      origin: { x: Math.random() * 0.75 + 0.125, y: 0.08 },
      colors: ["#0a0a0a", "#252525", "#3d3d3d"],
      shapes: ["circle"],
      scalar: 0.75,
    });
  };
  sadDrop();
  scheduleGoConfettiTimeout(sadDrop, 140);
  scheduleGoConfettiTimeout(sadDrop, 280);
  _goConfettiRainInterval = setInterval(sadDrop, 250);
  scheduleGoConfettiTimeout(resetGameOverConfettiOnly, 8200);
}

export function playGameOverPresentation(iWon) {
  resetGameOverConfettiOnly();
  const goCard = document.querySelector("#gameOverOverlay .go-card");
  const goTitle = document.getElementById("goTitle");
  const g = globalThis.gsap;
  if (g) {
    if (goCard) {
      g.killTweensOf(goCard);
      g.set(goCard, { clearProps: "transform,filter,opacity" });
    }
    if (goTitle) {
      g.killTweensOf(goTitle);
      g.set(goTitle, { clearProps: "transform,opacity,textShadow,filter" });
    }
  }

  const fire = getGameOverConfetti();

  if (iWon) {
    if (fire) playGameOverConfettiWinner(fire);
    if (g && goCard) {
      g.fromTo(
        goCard,
        { y: 110, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.8, ease: "back.out(1.7)" },
      );
    }
    if (g && goTitle) {
      g.fromTo(
        goTitle,
        { opacity: 0.82, textShadow: "0 0 2px rgba(255,255,255,0.15)" },
        {
          opacity: 1,
          textShadow:
            "0 0 22px rgba(251,192,45,0.95), 0 0 10px rgba(25,118,210,0.75), 0 0 6px rgba(211,47,47,0.5)",
          duration: 0.42,
          repeat: 5,
          yoyo: true,
          ease: "power2.inOut",
        },
      );
    }
  } else {
    if (fire) playGameOverConfettiLoser(fire);
    if (g && goCard) {
      g.timeline()
        .fromTo(
          goCard,
          { y: 48, opacity: 0, filter: "grayscale(0%)", x: 0 },
          { y: 0, opacity: 1, duration: 1.15, ease: "power2.out" },
        )
        .to(
          goCard,
          { filter: "grayscale(100%)", duration: 0.95, ease: "power1.inOut" },
          0.18,
        )
        .to(
          goCard,
          { x: 3, duration: 0.065, repeat: 16, yoyo: true, ease: "sine.inOut" },
          0.4,
        );
    } else if (goCard) {
      goCard.style.filter = "grayscale(100%)";
    }
    if (g && goTitle) {
      g.to(goTitle, { opacity: 0.88, duration: 1.2, ease: "power1.out" });
    }
  }
}

export function stopConfetti() {
  resetGameOverConfettiOnly();
  const goCard = document.querySelector("#gameOverOverlay .go-card");
  const goTitle = document.getElementById("goTitle");
  const gsapLib = globalThis.gsap;
  if (gsapLib) {
    if (goCard) {
      gsapLib.killTweensOf(goCard);
      gsapLib.set(goCard, { clearProps: "transform,filter,opacity" });
    }
    if (goTitle) {
      gsapLib.killTweensOf(goTitle);
      gsapLib.set(goTitle, {
        clearProps: "transform,opacity,textShadow,filter",
      });
    }
  }
}
