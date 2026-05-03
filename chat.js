// --- chat.js — Chat de text i frases ràpides ---------------------------------
import {
  db,
  session,
  ref,
  push,
  set,
  onValue,
} from "./firebase.js";
import { opponents as _opponents } from "./teams.js";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// --- Estat intern -------------------------------------------------------------
let unsubChat = null;
let chatOpen = false;
let lastChatN = 0;
let _canChatUntil = 0;
let _unsubPhrases = null;

// Chat lobby/pre-partida
let unsubLobbyChat = null;
let lobbyChatOpen = false;
let lastLobbyChatN = 0;

// Control anti-spam
let _lastMessageSentAt = 0;
const CHAT_COOLDOWN_MS = 1500;

const _bubbleState = {
  myBubble: { offerText: "", phraseText: "", phraseTimer: null },
  rivalBubble: { offerText: "", phraseText: "", phraseTimer: null },
};

// --- Emojis -------------------------------------------------------------------
const QUICK_EMOJIS_GAME = ["😂", "😡", "👍", "😏", "🔥", "💀", "🤔", "😈", "👀", "🎉", "🤣", "😤"];
const QUICK_EMOJIS_LOBBY = [
  "😂", "😊", "😎", "🤔", "😏", "😡", "👍", "👎", "🔥", "❤️", "💀", "🎉",
  "🃏", "🎴", "♠️", "♥️", "♦️", "♣️", "🏆", "💪", "🤣", "😤",
];

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

// --- Chat de text (partida) ---------------------------------------------------
export function initChat(code) {
  if (unsubChat) unsubChat();
  lastChatN = 0;
  chatOpen = false;
  const badge = $("chatBadge");
  if (badge) badge.classList.add("hidden");

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
      div.innerHTML = `<span class="chat-line-main"><span class="chat-author">${esc(m.name)}:</span> <span class="chat-text">${esc(m.text)}</span></span><span class="chat-time">${hh}:${mm}</span>`;
      frag.appendChild(div);
    });
    area.replaceChildren(frag);
    area.scrollTop = area.scrollHeight;
    if (!chatOpen && arr.length > lastChatN) {
      if (badge) badge.classList.remove("hidden");
      // Animació al botó Xat
      const toggle = $("chatToggle");
      if (toggle) {
        toggle.classList.remove("chat-toggle--ping");
        void toggle.offsetWidth; // reflow per reiniciar animació
        toggle.classList.add("chat-toggle--ping");
      }
    }
    lastChatN = arr.length;
  });
}

export async function sendChat() {
  const inp = $("chatInput"),
    text = inp.value.trim();
  if (!text || !session.roomRef || session.mySeat === null) return;

  if (Date.now() - _lastMessageSentAt < CHAT_COOLDOWN_MS) {
    inp.style.backgroundColor = "rgba(255, 0, 0, 0.2)";
    setTimeout(() => (inp.style.backgroundColor = ""), 300);
    return;
  }
  _lastMessageSentAt = Date.now();

  inp.value = "";
  closeGameEmojiPicker();
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
    const badge = $("chatBadge");
    if (badge) badge.classList.add("hidden");
    const toggle = $("chatToggle");
    if (toggle) toggle.classList.remove("chat-toggle--ping");
    setTimeout(() => {
      $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
      $("chatInput").focus();
    }, 50);
  } else {
    closeGameEmojiPicker();
  }
}

// --- Emoji picker (partida) ---------------------------------------------------
let _gameEmojiOpen = false;

export function toggleGameEmojiPicker() {
  _gameEmojiOpen = !_gameEmojiOpen;
  const picker = $("gameEmojiPicker");
  if (!picker) return;
  if (_gameEmojiOpen) {
    picker.classList.remove("hidden");
    // Renderitzar si buit
    if (!picker.children.length) {
      QUICK_EMOJIS_GAME.forEach((em) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "emoji-btn";
        btn.textContent = em;
        btn.setAttribute("aria-label", em);
        btn.addEventListener("click", () => insertEmojiGame(em));
        picker.appendChild(btn);
      });
    }
  } else {
    picker.classList.add("hidden");
  }
}

export function closeGameEmojiPicker() {
  _gameEmojiOpen = false;
  const picker = $("gameEmojiPicker");
  if (picker) picker.classList.add("hidden");
}

function insertEmojiGame(em) {
  const inp = $("chatInput");
  if (!inp) return;
  const start = inp.selectionStart ?? inp.value.length;
  const end = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, start) + em + inp.value.slice(end);
  inp.selectionStart = inp.selectionEnd = start + em.length;
  inp.focus();
  closeGameEmojiPicker();
}

// --- Chat lobby/pre-partida ---------------------------------------------------
export function initLobbyChat(code) {
  if (unsubLobbyChat) unsubLobbyChat();
  lastLobbyChatN = 0;

  unsubLobbyChat = onValue(ref(db, `rooms/${code}/chat`), (snap) => {
    const msgs = snap.val();
    const area = $("lobbyChatMessages");
    if (!area) return;
    if (!msgs) {
      area.replaceChildren();
      return;
    }
    const arr = Object.values(msgs).sort((a, b) => a.at - b.at);
    area.replaceChildren();
    arr.forEach((m) => {
      const div = document.createElement("div");
      div.className = `lc-msg ${m.seat === session.mySeat ? "mine" : "theirs"}`;
      div.dataset.at = m.at;
      const t = new Date(m.at);
      const hh = t.getHours().toString().padStart(2, "0");
      const mm = t.getMinutes().toString().padStart(2, "0");
      div.innerHTML = `<span class="lc-line-main"><span class="lc-author">${esc(m.name)}:</span> <span class="lc-text">${esc(m.text)}</span></span><span class="lc-time">${hh}:${mm}</span>`;
      area.appendChild(div);
    });
    area.scrollTop = area.scrollHeight;
    lastLobbyChatN = arr.length;
  });
}

export async function sendLobbyChat() {
  const inp = $("lobbyChatInput");
  if (!inp) return;
  const text = inp.value.trim();
  if (!text || !session.roomCode || session.mySeat === null) return;

  if (Date.now() - _lastMessageSentAt < CHAT_COOLDOWN_MS) {
    inp.style.backgroundColor = "rgba(255, 0, 0, 0.2)";
    setTimeout(() => (inp.style.backgroundColor = ""), 300);
    return;
  }
  _lastMessageSentAt = Date.now();

  inp.value = "";
  closeLobbyEmojiPicker();
  const myName = localStorage.getItem("truc_name") || `Jugador ${session.mySeat}`;
  await push(ref(db, `rooms/${session.roomCode}/chat`), {
    seat: session.mySeat,
    name: myName,
    text,
    at: Date.now(),
  });
}

// --- Emoji picker (lobby/pre-partida) ----------------------------------------
let _lobbyEmojiOpen = false;

export function toggleLobbyEmojiPicker() {
  _lobbyEmojiOpen = !_lobbyEmojiOpen;
  const picker = $("lobbyEmojiPicker");
  if (!picker) return;
  if (_lobbyEmojiOpen) {
    picker.classList.remove("hidden");
    if (!picker.children.length) {
      QUICK_EMOJIS_LOBBY.forEach((em) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "emoji-btn";
        btn.textContent = em;
        btn.setAttribute("aria-label", em);
        btn.addEventListener("click", () => insertEmojiLobby(em));
        picker.appendChild(btn);
      });
    }
  } else {
    picker.classList.add("hidden");
  }
}

export function closeLobbyEmojiPicker() {
  _lobbyEmojiOpen = false;
  const picker = $("lobbyEmojiPicker");
  if (picker) picker.classList.add("hidden");
}

function insertEmojiLobby(em) {
  const inp = $("lobbyChatInput");
  if (!inp) return;
  const start = inp.selectionStart ?? inp.value.length;
  const end = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, start) + em + inp.value.slice(end);
  inp.selectionStart = inp.selectionEnd = start + em.length;
  inp.focus();
  closeLobbyEmojiPicker();
}

export function detachLobbyChatListeners() {
  if (unsubLobbyChat) {
    unsubLobbyChat();
    unsubLobbyChat = null;
  }
  closeLobbyEmojiPicker();
  lastLobbyChatN = 0;
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
const SPEECH_BUBBLE_MIN_W = 96;

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
  const bw = Math.min(maxBw, Math.max(SPEECH_BUBBLE_MIN_W, measured));
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
    if (offer.level === "falta") return "Falta!!!";
    if (Number(offer.level) >= 4) return "Torne a envidar!";
    return "Envide!";
  }
  if (offer.kind === "truc") {
    if (Number(offer.level) === 4) return "Val 4!!!";
    if (Number(offer.level) === 3) return "Retruque!!";
    return "Truque!";
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
  const st = _bubbleState[targetId];
  st.offerText = txt;
  const ph = String(st.phraseText || "").trim();
  const ot = String(txt || "").trim();
  if (ph && ot && ph === ot) {
    if (st.phraseTimer) {
      clearTimeout(st.phraseTimer);
      st.phraseTimer = null;
    }
    st.phraseText = "";
  }
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
  const vv = window.visualViewport;
  const vw = vv?.width ?? window.innerWidth;
  const pad = 12;
  const maxBw = Math.min(SPEECH_BUBBLE_MAX_W, Math.max(80, vw - pad * 2));

  const measure = document.createElement("div");
  measure.className = b.className.replace(/\bhidden\b/g, "").trim();
  measure.style.position = "fixed";
  measure.style.left = "-10000px";
  measure.style.top = "0";
  measure.style.visibility = "hidden";
  measure.style.width = "auto";
  measure.style.maxWidth = `${maxBw}px`;
  measure.style.pointerEvents = "none";
  const measureNodes = nodes.map((n) => n.cloneNode(true));
  measure.replaceChildren(...measureNodes);
  document.body.appendChild(measure);
  const measured = Math.ceil(measure.getBoundingClientRect().width);
  measure.remove();
  const bw = Math.min(maxBw, Math.max(SPEECH_BUBBLE_MIN_W, measured));

  b.style.maxWidth = `${maxBw}px`;
  b.style.width = `${bw}px`;
  b.replaceChildren(...nodes);
  b.classList.remove("hidden");
  b.setAttribute("aria-hidden", "false");
  positionSpeechBubble(bubbleId);
  if (withAnim) {
    b.style.animation = "none";
    void b.offsetWidth;
    b.style.animation = "";
  }
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

export function initPhraseListener(code) {
  if (_unsubPhrases) _unsubPhrases();
  if (session.mySeat === null || session.mySeat === undefined) return;
  // Escoltem les frases de tots els rivals (1v1: 1 rival, 2v2: 2 rivals)
  const opps = _opponents(session.mySeat);
  if (!opps.length) return;
  // Per ara, escoltem el primer rival (el principal)
  const rivalKey = _K(opps[0]);
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
  chatOpen = false;
  lastChatN = 0;
  closeGameEmojiPicker();
  $("myAvatarContainer")?.classList.remove("av-frozen");
}
