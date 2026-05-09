// --- voice.js — reconeixement de veu contextual (Web Speech API) -------------
import { getVoiceEnabled, setVoiceEnabled } from "./config.js";
import { session } from "./firebase.js";
import {
  ui,
  startOffer,
  respondEnvit,
  respondTruc,
  goMazo,
} from "./acciones.js";
import { sndBtn } from "./audio.js";

const $ = (id) => document.getElementById(id);

/** Mic només amb sala activa i pantalla de partida visible (no hub lobby ni sala tancada sense render). */
function isVoiceGameSurfaceOk() {
  if (!session.roomCode) return false;
  const sg = document.getElementById("screenGame");
  return !!(sg && !sg.classList.contains("hidden"));
}

/** Detecta suport sense dependre d'instanciar encara el mòdul render. */
export function isSpeechRecognitionSupported() {
  return !!(
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition)
  );
}

let _recognition = null;
let _listening = false;
let _desiredListen = false;
let _lastState = null;
let _refreshAfterAction = async () => {};
let _notifyUser = () => {};

function ensureHud() {
  const anchor = $("myAvatarContainer");
  if (!anchor) return null;
  let root = $("voiceHud");
  if (!root) {
    root = document.createElement("div");
    root.id = "voiceHud";
    root.setAttribute("aria-live", "polite");
    root.innerHTML =
      '<div class="voice-hud-inner">' +
      '<span class="voice-hud-mic" aria-hidden="true">\u{1F3A4}</span>' +
      '<span class="voice-hud-transcript hidden"></span>' +
      "</div>";
    anchor.appendChild(root);
  } else if (root.parentElement !== anchor) {
    anchor.appendChild(root);
  }
  return root;
}

function capitalizeFirstLetter(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  const chars = [...t];
  chars[0] = chars[0].toLocaleUpperCase("ca");
  return chars.join("");
}

function setHudListening(on) {
  const root = $("voiceHud");
  if (!root) return;
  root.classList.toggle("voice-hud-active", !!on);
  const mic = root.querySelector(".voice-hud-mic");
  mic?.classList.toggle("voice-hud-pulse", !!on);
}

function flashTranscript(text) {
  const root = $("voiceHud");
  const el = root?.querySelector(".voice-hud-transcript");
  if (!el) return;
  el.textContent = capitalizeFirstLetter(text);
  el.classList.remove("hidden");
  clearTimeout(el._voiceT);
  el._voiceT = setTimeout(() => {
    el.classList.add("hidden");
    el.textContent = "";
  }, 1500);
}

function isBtnUsable(id) {
  const el = $(id);
  if (!el) return false;
  if (el.disabled) return false;
  if (el.classList.contains("hidden")) return false;
  return true;
}

function isResponseBtnUsable(cls) {
  const ra = $("responseArea");
  if (!ra || ra.classList.contains("hidden")) return false;
  const b = ra.querySelector(`.abtn.${cls}`);
  return !!(b && !b.disabled);
}

function canOfferEnvitViaVoice() {
  return isBtnUsable("envitBtn") || isResponseBtnUsable("btn-envit-1");
}

function canOfferFaltaViaVoice() {
  return isBtnUsable("faltaBtn") || isResponseBtnUsable("btn-envit-3");
}

function canVal4ViaVoice() {
  if (isResponseBtnUsable("btn-truc-3")) return true;
  return (
    isBtnUsable("trucBtn") && /val\s*4/i.test(String($("trucBtn")?.textContent || ""))
  );
}

function normalizeText(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim();
}

/**
 * Frases més llargs primer. Una sola coincidència per transcript.
 */
function classifyTranscript(norm) {
  const rules = [
    { p: ["falta envit"], k: "offer_falta" },
    { p: ["me'n jugue 4", "men jugue 4", "me jugue 4", "men jugue cuatro"], k: "val4" },
    { p: ["vale 4", "val 4"], k: "val4" },
    { p: ["4 van"], k: "val4" },
    { p: ["cuatro", "quatre"], k: "val4" },
    { p: ["no vull", "no quiero"], k: "reject" },
    { p: ["me'n vaig", "men vaig", "me voy"], k: "mazo" },
    { p: ["mazo"], k: "mazo" },
    { p: ["retruque", "retruc", "truque", "truco", "truc"], k: "offer_truc" },
    { p: ["envide", "envit"], k: "offer_envit" },
    { p: ["falta"], k: "offer_falta" },
    { p: ["paso"], k: "reject" },
    { p: ["vull", "vuic", "quiero"], k: "accept" },
    { p: ["be"], k: "reject" },
    { p: ["no"], k: "reject" },
  ];
  for (const { p, k } of rules) {
    for (const phrase of p) {
      if (norm.includes(phrase)) return k;
    }
  }
  if (/\bsi\b/.test(norm)) return "accept";
  return null;
}

async function runLockedAction(fn) {
  if (ui.locked) return;
  ui.locked = true;
  sndBtn();
  try {
    await fn();
  } finally {
    setTimeout(() => {
      ui.locked = false;
      _refreshAfterAction();
    }, 600);
  }
}

async function dispatchVoiceIntent(kind) {
  const h = _lastState?.hand;
  if (!h) return;

  if (kind === "val4") {
    if (!canVal4ViaVoice()) return;
    if (isResponseBtnUsable("btn-truc-3")) {
      await runLockedAction(() => respondTruc("val4"));
      return;
    }
    await runLockedAction(() => startOffer("truc"));
    return;
  }

  if (kind === "offer_falta") {
    if (!canOfferFaltaViaVoice()) return;
    await runLockedAction(() => startOffer("falta"));
    return;
  }
  if (kind === "offer_envit") {
    if (!canOfferEnvitViaVoice()) return;
    await runLockedAction(() => startOffer("envit"));
    return;
  }
  if (kind === "offer_truc") {
    if (!isBtnUsable("trucBtn")) return;
    await runLockedAction(() => startOffer("truc"));
    return;
  }
  if (kind === "mazo") {
    if (!isBtnUsable("mazoBtn")) return;
    await runLockedAction(() => goMazo());
    return;
  }
  if (kind === "accept") {
    if (!isResponseBtnUsable("btn-accept")) return;
    if (h.mode === "respond_envit") {
      await runLockedAction(() => respondEnvit("vull"));
    } else if (h.mode === "respond_truc") {
      await runLockedAction(() => respondTruc("vull"));
    }
    return;
  }
  if (kind === "reject") {
    if (!isResponseBtnUsable("btn-reject")) return;
    if (h.mode === "respond_envit") {
      await runLockedAction(() => respondEnvit("no_vull"));
    } else if (h.mode === "respond_truc") {
      await runLockedAction(() => respondTruc("no_vull"));
    }
  }
}

function processTranscript(raw) {
  const norm = normalizeText(raw);
  if (!norm) return;
  const kind = classifyTranscript(norm);
  if (!kind) return;
  flashTranscript(raw.trim());
  void dispatchVoiceIntent(kind).catch(() => {});
}

function safeStop() {
  if (!_recognition) return;
  try {
    _recognition.stop();
  } catch {
    /* ignorar */
  }
}

function requestStart() {
  if (!_recognition || !_desiredListen || !getVoiceEnabled()) return;
  if (!isVoiceGameSurfaceOk()) return;
  if (_listening || ui.locked) return;
  try {
    _recognition.start();
    _listening = true;
    setHudListening(true);
  } catch {
    _listening = false;
    setHudListening(false);
  }
}

function attachRecognitionHandlers() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  _recognition = new SR();
  _recognition.continuous = false;
  _recognition.interimResults = false;
  _recognition.lang = "ca-ES";

  _recognition.onresult = (ev) => {
    let text = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      text += ev.results[i][0].transcript;
    }
    processTranscript(text);
  };

  _recognition.onerror = (ev) => {
    const code = ev?.error || "";
    if (code === "language-not-supported" && _recognition.lang === "ca-ES") {
      _recognition.lang = "es-ES";
      _listening = false;
      setHudListening(false);
      if (_desiredListen && getVoiceEnabled()) {
        setTimeout(() => requestStart(), 120);
      }
      return;
    }
    if (code === "no-speech" || code === "audio-capture") {
      _listening = false;
      setHudListening(false);
      if (_desiredListen && getVoiceEnabled()) {
        setTimeout(() => requestStart(), 120);
      }
      return;
    }
    if (code === "not-allowed" || code === "service-not-allowed") {
      setVoiceEnabled(false);
      _desiredListen = false;
      _listening = false;
      setHudListening(false);
      _notifyUser(
        "Micròfon denegat: s'ha desactivat cantar jugades per veu.",
      );
      return;
    }
    _listening = false;
    setHudListening(false);
    if (_desiredListen && getVoiceEnabled()) {
      setTimeout(() => requestStart(), 200);
    }
  };

  _recognition.onend = () => {
    _listening = false;
    setHudListening(false);
    if (_desiredListen && getVoiceEnabled() && !ui.locked) {
      setTimeout(() => requestStart(), 80);
    }
  };
}

export function initVoice(deps) {
  _refreshAfterAction = deps.refreshAfterAction || (async () => {});
  _notifyUser = deps.notifyUser || (() => {});
  ensureHud();
  if (!isSpeechRecognitionSupported()) return;
  attachRecognitionHandlers();
}

export function stopListening() {
  _desiredListen = false;
  safeStop();
  _listening = false;
  setHudListening(false);
}

export function startListening() {
  if (!isSpeechRecognitionSupported() || !_recognition) return;
  _desiredListen = true;
  requestStart();
}

/**
 * @param {{ shouldListen: boolean, state: object }} opts
 */
export function syncListeningFromGame(opts) {
  const shouldListen = !!(opts?.shouldListen && getVoiceEnabled());
  _lastState = opts?.state ?? _lastState;
  ensureHud();

  if (!isSpeechRecognitionSupported() || !_recognition) {
    setHudListening(false);
    return;
  }

  _desiredListen = shouldListen;
  if (!shouldListen) {
    safeStop();
    _listening = false;
    setHudListening(false);
    return;
  }

  if (!isVoiceGameSurfaceOk()) {
    safeStop();
    _listening = false;
    setHudListening(false);
    return;
  }

  if (!ui.locked) requestStart();
}
