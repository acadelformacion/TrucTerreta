// --- animations.js — GSAP, confetti i temporitzadors de torn ----------------
import { sndTick, sndPoint } from "./audio.js";
import { timeoutTurn } from "./acciones.js";
import { isVibrationEnabled } from "./config.js";
import { getServerTime } from "./firebase.js";

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

export function startTurnTimer(isMyTurn, turnStartedAt) {
  stopTurnTimer();
  if (isMyTurn && lastTurnWasMine !== true) {
    vibrateMyTurnStart();
  }
  lastTurnWasMine = !!isMyTurn;

  // Sincronització: temps transcorregut segons el servidor
  const now = getServerTime();
  const start = Number(turnStartedAt || now);
  const elapsed = (now - start) / 1000;
  let rem = Math.max(0, TURN_SECS - elapsed);

  const myWrap = $("myAvatarContainer");
  const rivWrap = $("rivalAvatarContainer");
  if (isMyTurn) {
    if (myWrap) myWrap.classList.add("turn-active");
    if (rivWrap) rivWrap.classList.remove("turn-active");
    setRing("myTimerArc", "myTimerRing", (rem / TURN_SECS) * 100);
    setRing("rivalTimerArc", "rivalTimerRing", 0);
  } else {
    if (rivWrap) rivWrap.classList.add("turn-active");
    if (myWrap) myWrap.classList.remove("turn-active");
    setRing("myTimerArc", "myTimerRing", 0);
    setRing("rivalTimerArc", "rivalTimerRing", (rem / TURN_SECS) * 100);
  }

  // Si ja ha passat el temps, timeout immediat si és el meu torn
  if (rem <= 0) {
    if (isMyTurn) timeoutTurn();
    return;
  }

  turnTimerArm = setTimeout(() => {
    turnTimerArm = null;
    turnTimer = setInterval(() => {
      // Recalcular rem basat en el temps absolut per evitar deriva del setInterval
      const nowTick = getServerTime();
      const elapsedTick = (nowTick - start) / 1000;
      rem = Math.max(0, TURN_SECS - elapsedTick);
      
      const pct = (rem / TURN_SECS) * 100;
      if (isMyTurn) {
        setRing("myTimerArc", "myTimerRing", pct);
      } else {
        setRing("rivalTimerArc", "rivalTimerRing", pct);
      }
      
      // So de tick en els últims segons (arrodonit per sonar 1 cop per segon)
      const secInt = Math.ceil(rem);
      if (secInt >= 1 && secInt <= 5) {
         // Només sonar si estem prop del "segon exacte" (heurística)
         if (Math.abs(rem - secInt) < 0.1) sndTick();
      }

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
  // Més punts d'un cop → cada pas una mica més lent (abans 120ms era massa ràpid)
  const stepMs =
    diff <= 2 ? 520 : diff <= 5 ? 360 : Math.min(420, 260 + Math.floor(diff / 2) * 28);
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
export function playVersusIntro(
  myName,
  rivalName,
  mineSrc,
  rivalSrc,
  mineSrc2 = "",
  rivalSrc2 = "",
) {
  const gsapLib = globalThis.gsap;
  const overlay = $("versusOverlay");
  const topBanner = $("vsBannerTop");
  const bottomBanner = $("vsBannerBottom");
  const vsText = $("vsText");
  const elRival = $("vsNameRival");
  const elMine = $("vsNameMine");
  const imgRival = $("vsAvatarRival");
  const imgRival2 = $("vsAvatarRival2");
  const imgMine = $("vsAvatarMine");
  const imgMine2 = $("vsAvatarMine2");
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
  if (imgMine2) {
    imgMine2.src = mineSrc2 || "";
    imgMine2.alt = myName != null ? String(myName) : "";
    imgMine2.classList.toggle("hidden", !mineSrc2);
  }
  if (imgRival2) {
    imgRival2.src = rivalSrc2 || "";
    imgRival2.alt = rivalName != null ? String(rivalName) : "";
    imgRival2.classList.toggle("hidden", !rivalSrc2);
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

/** Text daurat des de les cartes del rival cap al centre (trickGrid). No bloqueja el torn. */
export function animateRivalActionTableMsg(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return Promise.resolve();

  const src = document.getElementById("rivalCards");
  const target = document.getElementById("trickGrid");
  const fr = src?.getBoundingClientRect();
  const tRect = target?.getBoundingClientRect();
  const x0 = fr?.width ? fr.left + fr.width / 2 : window.innerWidth * 0.5;
  const y0 = fr?.height ? fr.top + fr.height / 2 : window.innerHeight * 0.22;
  const x1 = tRect?.width
    ? tRect.left + tRect.width / 2
    : window.innerWidth * 0.5;
  const y1 = tRect?.height
    ? tRect.top + tRect.height / 2
    : window.innerHeight * 0.42;

  const bubble = document.createElement("div");
  bubble.className = "table-msg-bubble";
  bubble.textContent = cleaned;
  bubble.style.position = "fixed";
  bubble.style.left = `${x0}px`;
  bubble.style.top = `${y0}px`;
  bubble.style.width = "max-content";
  bubble.style.maxWidth = "min(90vw, 22rem)";
  bubble.style.textAlign = "center";
  bubble.style.zIndex = "1000";
  bubble.style.pointerEvents = "none";
  document.body.appendChild(bubble);

  const g = globalThis.gsap;
  if (!g) {
    bubble.classList.add("msg-rival");
    bubble.style.left = "50%";
    bubble.style.top = "28%";
    bubble.style.animation = "bubblePop 1.8s ease-out forwards";
    return new Promise((resolve) => {
      const done = () => {
        bubble.remove();
        resolve();
      };
      bubble.addEventListener("animationend", done, { once: true });
      setTimeout(done, 2000);
    });
  }

  return new Promise((resolve) => {
    g.killTweensOf(bubble);
    g.set(bubble, {
      xPercent: -50,
      yPercent: -50,
      x: 0,
      y: 0,
      scale: 0.45,
      opacity: 0,
    });
    const dx = x1 - x0;
    const dy = y1 - y0;
    const tl = g.timeline({
      onComplete: () => {
        bubble.remove();
        resolve();
      },
    });
    tl.to(
      bubble,
      { opacity: 1, scale: 1.18, duration: 0.2, ease: "power2.out" },
      0,
    );
    tl.to(bubble, { x: dx, y: dy, duration: 0.68, ease: "power2.inOut" }, 0);
    tl.to(
      bubble,
      { scale: 1, duration: 0.22, ease: "power1.out" },
      0.18,
    );
    tl.to(
      bubble,
      { opacity: 0, scale: 1.06, duration: 0.32, ease: "power2.in" },
      0.62,
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

/** Missatge central sense durada fixa; retorna `dismiss()` per eliminar-lo. */
export function showHoldCenterTableMessage(text) {
  const msg = document.createElement("div");
  msg.className = "table-msg-bubble msg-center start-hand-msg";
  msg.textContent = String(text || "").toUpperCase();
  document.querySelectorAll(".start-hand-msg").forEach((el) => el.remove());
  document.body.appendChild(msg);
  return () => {
    msg.remove();
  };
}

// --- Animació de carta voladora -----------------------------------------------
// flyEl és l'element de carta ja construït pel cridador (buildCard al mòdul de render).
export function animatePlay(cardEl, flyEl, onDone) {
  const slot = document.getElementById("trickGrid");
  const fr = cardEl.getBoundingClientRect();
  const to = slot
    ? slot.getBoundingClientRect()
    : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 80, height: 114 };
      
  flyEl.style.cssText = `left:${fr.left}px;top:${fr.top}px;width:${fr.width}px;height:${fr.height}px;position:fixed;pointer-events:none;z-index:200;`;
  document.body.appendChild(flyEl);

  const g = globalThis.gsap;
  if (g) {
    const dx = to.left + to.width / 2 - (fr.left + fr.width / 2);
    const dy = to.top + to.height / 2 - (fr.top + fr.height / 2);
    const rot = Math.random() * 14 - 7;
    g.set(flyEl, { transformPerspective: 400, rotationX: 25 });
    g.to(flyEl, {
      x: dx,
      y: dy,
      rotation: rot,
      rotationX: 25,
      scale: 0.72,
      duration: 0.45,
      ease: "back.out(1.2)",
      onComplete: () => {
        flyEl.remove();
        if (onDone) onDone();
      }
    });
  } else {
    flyEl.classList.add("card-flying");
    flyEl.style.setProperty("--tx", to.left + to.width / 2 - fr.left - fr.width / 2 + "px");
    flyEl.style.setProperty("--ty", to.top + to.height / 2 - fr.top - fr.height / 2 + "px");
    flyEl.style.setProperty("--rot", Math.random() * 10 - 5 + "deg");
    flyEl.addEventListener("animationend", () => { flyEl.remove(); if (onDone) onDone(); }, { once: true });
  }
}

export function animateRivalPlay(el) {
  const g = globalThis.gsap;
  if (!g) {
    el.classList.add("land-anim");
    return;
  }
  const sourceNode = document.getElementById("rivalAv") || document.getElementById("rivalCards");
  if (!sourceNode) {
    g.from(el, { scale: 0.5, y: -50, opacity: 0, duration: 0.4, ease: "back.out(1.2)" });
    return;
  }
  
  // Ocultar la carta real temporalmente
  el.style.opacity = "0";

  const fr = sourceNode.getBoundingClientRect();
  const to = el.getBoundingClientRect();
  
  // Crear un clon para volar
  const flyEl = el.cloneNode(true);
  flyEl.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;position:fixed;pointer-events:none;z-index:200;transition:none;opacity:1;`;
  document.body.appendChild(flyEl);

  const dx = fr.left + fr.width / 2 - (to.left + to.width / 2);
  const dy = fr.top + fr.height / 2 - (to.top + to.height / 2);
  
  g.from(flyEl, {
    x: dx,
    y: dy,
    rotation: Math.random() * 20 - 10,
    scale: 1.2,
    opacity: 0,
    duration: 0.45,
    ease: "back.out(1.2)",
    onComplete: () => {
      flyEl.remove();
      el.style.removeProperty("opacity");
    }
  });
}

export function animateScreenShake(intensity = "high") {
  const g = globalThis.gsap;
  const table = document.getElementById("table");
  if (!g || !table) return;
  g.killTweensOf(table);
  
  if (intensity === "high") {
    g.fromTo(table,
      { x: -3, y: 2, rotation: -0.2 },
      { x: 3, y: -2, rotation: 0.2, yoyo: true, repeat: 5, duration: 0.06, clearProps: "all", ease: "none" }
    );
  } else if (intensity === "low") {
    g.fromTo(table,
      { x: -1.5, y: 1, rotation: -0.1 },
      { x: 1.5, y: -1, rotation: 0.1, yoyo: true, repeat: 3, duration: 0.06, clearProps: "all", ease: "none" }
    );
  }
}

export function animateTrickCollect() {
  const g = globalThis.gsap;
  if (!g) return;
  const cols = document.querySelectorAll(".trick-col");
  if (!cols.length) return;
  
  const target = document.getElementById("deckPile");
  const tx = target ? target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2 : window.innerWidth / 2;
  const ty = target ? target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 : window.innerHeight / 2;

  g.to(cols, {
    x: (i, el) => tx - (el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2),
    y: (i, el) => ty - (el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
    scale: 0.1,
    opacity: 0,
    rotation: "random(-180, 180)",
    duration: 0.65,
    stagger: 0.08,
    ease: "power2.in"
  });
}

export function setupHoverDynamics(el) {
  if (!el || !globalThis.gsap) return () => {};
  const g = globalThis.gsap;
  const onMove = (e) => {
    // Para táctil, toma el primer toque
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    
    // Calcula la inclinación/movimiento (parallax)
    // Reducimos el factor para que sea suave
    const moveX = x * 0.15;
    const moveY = y * 0.15;
    const rot = x * 0.03;
    
    g.to(el, {
      x: moveX,
      y: moveY,
      rotation: rot,
      duration: 0.4,
      ease: "power2.out",
      overwrite: "auto"
    });
  };
  
  const onLeave = () => {
    g.to(el, {
      x: 0,
      y: 0,
      rotation: 0,
      duration: 0.7,
      ease: "elastic.out(1, 0.4)",
      overwrite: "auto"
    });
  };

  el.addEventListener("mousemove", onMove);
  el.addEventListener("mouseleave", onLeave);
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", onLeave);
  el.addEventListener("touchcancel", onLeave);

  return () => {
    el.removeEventListener("mousemove", onMove);
    el.removeEventListener("mouseleave", onLeave);
    el.removeEventListener("touchmove", onMove);
    el.removeEventListener("touchend", onLeave);
    el.removeEventListener("touchcancel", onLeave);
    g.killTweensOf(el);
  };
}

function revealDealWrapsIfAborted(wraps) {
  if (!wraps?.length) return;
  for (const el of wraps) {
    el.style.removeProperty("opacity");
    el.style.removeProperty("transition");
  }
}

/**
 * Centre del mazo en pantalla per animar des d'allà. Si #deckPile no té mida vàlida
 * (p.ex. abans tenia display:none en 2v2), usa zona central / taula com a fallback.
 */
function resolveDeckCenterPx() {
  const deckPile = $("deckPile");
  const deckRect = deckPile?.getBoundingClientRect();
  if (deckRect && deckRect.width >= 2 && deckRect.height >= 2) {
    const deckOnLeft = deckRect.left < window.innerWidth / 2;
    const gcx = deckOnLeft ? deckRect.left + deckRect.width : deckRect.left;
    const gcy = deckRect.top + deckRect.height / 2;
    return { gcx, gcy };
  }
  const cz = $("centerZone");
  if (cz) {
    const r = cz.getBoundingClientRect();
    const gcx = r.left - Math.min(88, Math.max(48, r.width * 0.12));
    const gcy = r.top + r.height / 2;
    return { gcx, gcy };
  }
  const tb = document.getElementById("table");
  if (tb) {
    const r = tb.getBoundingClientRect();
    return { gcx: r.left + 36, gcy: r.top + r.height / 2 };
  }
  return { gcx: window.innerWidth * 0.06, gcy: window.innerHeight * 0.42 };
}

/**
 * Primera mà: cartes des del mazo lateral; opcionalment vol paral·lel cap a un munt
 * i `flipAllSubtimeline` per girar-les totes juntes.
 * @param {NodeListOf<Element>|Element[]} wraps - `.my-card-wrap`
 * @param {{
 *   flipSubtimeline?: (wrap: Element, index: number) => unknown;
 *   flipAllSubtimeline?: (wraps: Element[]) => unknown;
 *   onDealAborted?: (wraps: Element[]) => void;
 *   onDealAnimationComplete?: () => void;
 * }} [options]
 */
export function animateMyHandDealFromDeck(wraps, options = {}) {
  const { flipSubtimeline, flipAllSubtimeline, onDealAborted, onDealAnimationComplete } =
    options;
  const g = globalThis.gsap;
  if (!g || !wraps?.length) {
    revealDealWrapsIfAborted(wraps);
    onDealAborted?.(Array.from(wraps));
    onDealAnimationComplete?.();
    return;
  }

  const { gcx, gcy } = resolveDeckCenterPx();

  const list = Array.from(wraps);
  list.forEach((el) => {
    el.style.transition = "none";
  });
  const parent = list[0]?.parentElement;
  if (parent) void parent.offsetHeight;

  const rectsPre = list.map((el) => el.getBoundingClientRect());
  const fanCenters = rectsPre.map((r) => ({
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
  }));
  const mid = Math.min(1, Math.max(0, Math.floor(list.length / 2)));
  const stackCenter = { x: fanCenters[mid].x, y: fanCenters[mid].y };
  const stackXY = list.map((_, i) => ({
    x: stackCenter.x - fanCenters[i].x,
    y: stackCenter.y - fanCenters[i].y,
  }));

  list.forEach((el, i) => {
    const r = rectsPre[i];
    g.set(el, {
      x: gcx - (r.left + r.width / 2),
      y: gcy - (r.top + r.height / 2),
      rotation: Math.random() * 14 - 7,
      transformOrigin: "50% 50%",
      autoAlpha: 1,
      zIndex: 8 + i,
    });
  });

  const tl = g.timeline({
    onComplete: () => {
      list.forEach((el) => {
        el.style.transition = "none";
        el.style.removeProperty("opacity");
        el.style.removeProperty("z-index");
      });
      g.set(list, { clearProps: "transform,transformOrigin,opacity,visibility" });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          list.forEach((el) => el.style.removeProperty("transition"));
          onDealAnimationComplete?.();
        });
      });
    },
  });

  const useStackAndFlipAll =
    list.length === 3 && typeof flipAllSubtimeline === "function";

  if (useStackAndFlipAll) {
    const stagger = 0.28;
    list.forEach((el, i) => {
      const sx = stackXY[i].x;
      const sy = stackXY[i].y;
      const spin = (1 - i) * 24;
      const one = g.timeline();
      one.to(el, {
        x: sx * 0.4,
        y: sy * 0.4,
        rotation: spin,
        duration: 0.11,
        ease: "power1.out",
      });
      one.to(el, {
        x: sx * 0.78,
        y: sy * 0.78,
        rotation: -spin * 0.4,
        duration: 0.1,
        ease: "sine.inOut",
      });
      one.to(el, {
        x: sx,
        y: sy,
        rotation: 0,
        duration: 0.1,
        ease: "power2.out",
      });
      tl.add(one, i * stagger);
    });
    const getFinalRot = (i, total) => total === 3 ? (i === 0 ? -8 : i === 1 ? 0 : 8) : (total === 2 ? (i === 0 ? -5 : 5) : 0);
    const getFinalY = (i, total) => total === 3 ? (i === 0 ? 6 : i === 1 ? 0 : 6) : (total === 2 ? 4 : 0);

    // Primero colocamos todas las cartas en su abanico final para que el giro
    // no muestre un orden temporal que cambie milisegundos después.
    tl.to(
      list,
      {
        x: 0,
        y: (i) => getFinalY(i, list.length),
        rotation: (i) => getFinalRot(i, list.length),
        duration: 0.18,
        ease: "power2.out",
        stagger: 0.04,
      },
      ">",
    );
    const flipAll = flipAllSubtimeline(list);
    if (flipAll) {
      tl.add(flipAll, ">");
    }
  } else {
    const getFinalRot = (i, total) => total === 3 ? (i === 0 ? -8 : i === 1 ? 0 : 8) : (total === 2 ? (i === 0 ? -5 : 5) : 0);
    const getFinalY = (i, total) => total === 3 ? (i === 0 ? 6 : i === 1 ? 0 : 6) : (total === 2 ? 4 : 0);
    const dur = 0.38;
    const ease = "power2.out";
    list.forEach((el, i) => {
      tl.to(
        el,
        { x: 0, y: getFinalY(i, list.length), rotation: getFinalRot(i, list.length), duration: dur, ease },
        i === 0 ? 0 : ">",
      );
      const flipSub = flipSubtimeline?.(el, i);
      const flipDur =
        flipSub && typeof flipSub.duration === "function"
          ? flipSub.duration()
          : Number(flipSub?.duration ?? 0);
      if (flipSub && flipDur > 0) {
        tl.add(flipSub, ">");
      }
    });
  }
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
  const burstCommon = {
    particleCount: 88,
    spread: 56,
    startVelocity: 46,
    gravity: 0.48,
    ticks: 450,
    decay: 0.945,
    colors: GO_CONFETTI_COLORS,
  };
  const burst = () => {
    fire({
      ...burstCommon,
      angle: 62,
      origin: { x: 0, y: 1 },
    });
    fire({
      ...burstCommon,
      angle: 118,
      origin: { x: 1, y: 1 },
    });
  };
  burst();
  scheduleGoConfettiTimeout(burst, 300);
  scheduleGoConfettiTimeout(burst, 620);
  scheduleGoConfettiTimeout(resetGameOverConfettiOnly, 10500);
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

