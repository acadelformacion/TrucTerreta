// --- chat.js — Chat de text i frases ràpides ---------------------------------
import {
  db,
  session,
  ref,
  push,
  set,
  onValue,
} from "./firebase.js";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- Estat intern -------------------------------------------------------------
let unsubChat = null;
let chatOpen = false;
let lastChatN = 0;
let _canChatUntil = 0;
let _unsubPhrases = null;

const _bubbleState = {
  myBubble: { offerText: "", phraseText: "", phraseTimer: null },
  rivalBubble: { offerText: "", phraseText: "", phraseTimer: null },
};

// --- Frases ràpides -----------------------------------------------------------
const FRASES_PREDETERMINADAS = [
  "⚔️ Ara sí que va de bo!",
  "🏅 Hui no fas ni un punt.",
  "🌿 Açò és mel de romer.",
  "💣 Va, que esta cau.",
  "💰 Esta mà val or.",
  "🖐️ Vine, vine, que t'espere.",
  "🦁 A vore si tens valor.",
  "😳 Això és tot el que portes?",
];

function canUseQuickPhrases() {
  return Date.now() >= _canChatUntil;
}

// --- Chat de text -------------------------------------------------------------
export function initChat(code) {
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

export async function sendChat() {
  const inp = $("chatInput"),
    text = inp.value.trim();
  if (!text || !session.roomRef || session.mySeat === null) return;
  inp.value = "";
  const myName = localStorage.getItem("truc_name") || `Jugador ${session.mySeat}`;
  await push(ref(db, `rooms/${session.roomCode}/chat`), {
    seat: session.mySeat,
    name: myName,
    text,
    at: Date.now(),
  });
}

export function toggleChatPanel() {
  chatOpen = !chatOpen;
  $("chatBox").classList.toggle("hidden", !chatOpen);
  if (chatOpen) {
    $("chatBadge").classList.add("hidden");
    setTimeout(() => {
      $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
      $("chatInput").focus();
    }, 50);
  }
}

// --- Posicionament de menú i burbolles ----------------------------------------
const PHRASE_MENU_MAX_W = 272;

function positionPhraseMenu() {
  const menu = $("myPhraseMenu");
  const av = $("myAvatarContainer");
  if (!menu || !av || menu.classList.contains("hidden")) return;
  const vv = window.visualViewport;
  const vw = vv?.width ?? window.innerWidth;
  const pad = 12;
  const menuW = Math.min(PHRASE_MENU_MAX_W, Math.max(120, vw - pad * 2));
  const rect = av.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  let left = cx - menuW / 2;
  left = Math.max(pad, Math.min(left, vw - pad - menuW));
  const gap = 8;
  const bottom = window.innerHeight - rect.top + gap;
  menu.style.width = `${menuW}px`;
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
  menu.style.bottom = `${bottom}px`;
  menu.style.top = "auto";
}

export function hidePhraseMenu() {
  const menu = $("myPhraseMenu");
  if (!menu) return;
  menu.classList.add("hidden");
  menu.setAttribute("aria-hidden", "true");
  menu.style.width = "";
  menu.style.left = "";
  menu.style.right = "";
  menu.style.bottom = "";
  menu.style.top = "";
}

const SPEECH_BUBBLE_MAX_W = 272;

function bubbleAnchorId(bubbleId) {
  if (bubbleId === "myBubble") return "myAvatarContainer";
  if (bubbleId === "rivalBubble") return "rivalAvatarContainer";
  return null;
}

function positionSpeechBubble(bubbleId) {
  const b = $(bubbleId);
  const aid = bubbleAnchorId(bubbleId);
  if (!b || !aid || b.classList.contains("hidden")) return;
  const av = $(aid);
  if (!av) return;
  const vv = window.visualViewport;
  const vw = vv?.width ?? window.innerWidth;
  const pad = 12;
  const maxBw = Math.min(SPEECH_BUBBLE_MAX_W, Math.max(80, vw - pad * 2));
  b.style.width = "auto";
  b.style.maxWidth = `${maxBw}px`;
  const measured = Math.ceil(b.getBoundingClientRect().width);
  const bw = Math.min(maxBw, Math.max(56, measured));
  const rect = av.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  let left = cx - bw / 2;
  left = Math.max(pad, Math.min(left, vw - pad - bw));
  const gap = 8;
  b.style.width = `${bw}px`;
  b.style.left = `${left}px`;
  b.style.right = "auto";
  b.style.transform = "none";
  if (bubbleId === "myBubble") {
    b.style.bottom = `${window.innerHeight - rect.top + gap}px`;
    b.style.top = "auto";
  } else {
    b.style.top = `${rect.bottom + gap}px`;
    b.style.bottom = "auto";
  }
}

function hideSpeechBubbleStyles(el) {
  if (!el) return;
  el.style.width = "";
  el.style.maxWidth = "";
  el.style.left = "";
  el.style.right = "";
  el.style.bottom = "";
  el.style.top = "";
  el.style.transform = "";
}

export function onGameViewportChange() {
  const menu = $("myPhraseMenu");
  if (menu && !menu.classList.contains("hidden")) positionPhraseMenu();
  for (const id of ["myBubble", "rivalBubble"]) {
    const el = $(id);
    if (el && !el.classList.contains("hidden")) positionSpeechBubble(id);
  }
}

// --- Burbolles de text (ofertes i frases) ------------------------------------
function offerTextFromPendingOffer(offer) {
  if (!offer) return "";
  if (offer.kind === "envit") {
    if (offer.level === "falta") return "Falta";
    if (Number(offer.level) >= 4) return "Torne";
    return "Envidar";
  }
  if (offer.kind === "truc") {
    if (Number(offer.level) === 4) return "Val 4";
    if (Number(offer.level) === 3) return "Retruque";
    return "Truc";
  }
  return "";
}

export function syncOfferBubblesFromState(state) {
  const pending = state?.hand?.pendingOffer || null;
  _bubbleState.myBubble.offerText = "";
  _bubbleState.rivalBubble.offerText = "";
  if (!pending || (session.mySeat !== 0 && session.mySeat !== 1)) {
    renderSpeechBubble("myBubble");
    renderSpeechBubble("rivalBubble");
    return;
  }
  const txt = offerTextFromPendingOffer(pending);
  const mine = pending.by === session.mySeat;
  const targetId = mine ? "myBubble" : "rivalBubble";
  _bubbleState[targetId].offerText = txt;
  renderSpeechBubble("myBubble");
  renderSpeechBubble("rivalBubble");
}

export function renderSpeechBubble(bubbleId, withAnim = false) {
  const b = $(bubbleId);
  const st = _bubbleState[bubbleId];
  if (!b || !st) return;
  const phrase = String(st.phraseText || "").trim();
  const offer = String(st.offerText || "").trim();
  if (!phrase && !offer) {
    b.classList.add("hidden");
    b.setAttribute("aria-hidden", "true");
    hideSpeechBubbleStyles(b);
    b.replaceChildren();
    return;
  }
  const nodes = [];
  if (phrase) {
    const phraseEl = document.createElement("div");
    phraseEl.className = "speech-main";
    phraseEl.textContent = phrase;
    nodes.push(phraseEl);
  }
  if (offer) {
    const offerEl = document.createElement("div");
    offerEl.className = "speech-offer";
    offerEl.textContent = offer;
    nodes.push(offerEl);
  }
  b.replaceChildren(...nodes);
  b.classList.remove("hidden");
  b.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      positionSpeechBubble(bubbleId);
      if (withAnim) {
        b.style.animation = "none";
        void b.offsetWidth;
        b.style.animation = "";
      }
    });
  });
}

export function showBubble(bubbleId, text) {
  const b = $(bubbleId);
  const st = _bubbleState[bubbleId];
  if (!b || !st) return;
  st.phraseText = String(text || "").trim();
  renderSpeechBubble(bubbleId, true);
  if (st.phraseTimer) clearTimeout(st.phraseTimer);
  st.phraseTimer = setTimeout(() => {
    st.phraseText = "";
    st.phraseTimer = null;
    renderSpeechBubble(bubbleId);
  }, 4000);
}

// --- Menú de frases ràpides --------------------------------------------------
function buildPhraseMenu() {
  const menu = $("myPhraseMenu");
  if (!menu) return;
  menu.innerHTML = "";
  FRASES_PREDETERMINADAS.forEach((frase) => {
    const item = document.createElement("div");
    item.className = "phrase-item";
    item.textContent = frase;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      sendPhrase(frase);
    });
    item.addEventListener("touchend", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendPhrase(frase);
    });
    menu.appendChild(item);
  });
}

export function togglePhraseMenu() {
  if (!canUseQuickPhrases()) return;
  if (session.mySeat !== 0 && session.mySeat !== 1) return;
  const menu = $("myPhraseMenu");
  if (!menu) return;
  if (menu.classList.contains("hidden")) {
    buildPhraseMenu();
    menu.classList.remove("hidden");
    menu.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => positionPhraseMenu());
    });
  } else {
    hidePhraseMenu();
  }
}

function sendPhrase(text) {
  if (!canUseQuickPhrases() || !session.roomCode) return;
  if (session.mySeat !== 0 && session.mySeat !== 1) return;
  hidePhraseMenu();
  showBubble("myBubble", text);
  set(ref(db, `rooms/${session.roomCode}/phraseOut/${_K(session.mySeat)}`), {
    msg: text,
    t: Date.now(),
  }).catch(() => {});
  _canChatUntil = Date.now() + 8000;
  $("myAvatarContainer")?.classList.add("av-frozen");
  setTimeout(() => {
    if (canUseQuickPhrases()) $("myAvatarContainer")?.classList.remove("av-frozen");
  }, 8000);
}

// K helper local (evita dependència de ui.js)
const _K = (n) => `_${n}`;
const _other = (s) => (s === 0 ? 1 : 0);

export function initPhraseListener(code) {
  if (_unsubPhrases) _unsubPhrases();
  if (session.mySeat !== 0 && session.mySeat !== 1) return;
  const rivalKey = _K(_other(session.mySeat));
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

// Exposa globalment per a callbacks HTML externs
window.showBubble = showBubble;

export function detachChatListeners() {
  if (unsubChat) {
    unsubChat();
    unsubChat = null;
  }
  if (_unsubPhrases) {
    _unsubPhrases();
    _unsubPhrases = null;
  }
  for (const id of ["myBubble", "rivalBubble"]) {
    const st = _bubbleState[id];
    if (st?.phraseTimer) clearTimeout(st.phraseTimer);
    if (st) {
      st.phraseTimer = null;
      st.phraseText = "";
      st.offerText = "";
    }
    renderSpeechBubble(id);
  }
  _canChatUntil = 0;
  $("myAvatarContainer")?.classList.remove("av-frozen");
}
