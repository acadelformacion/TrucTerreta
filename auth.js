// --- auth.js — Google Sign-In i autenticació Firebase -----------------------
import {
  auth,
  GoogleAuthProvider,
  signInWithCredential,
} from "./firebase.js";

const WINS_LS_PREFIX = "truc_wins_";

// --- Estat intern -------------------------------------------------------------
let _authReady = false;
let _gsiBootDone = false;

// --- Helpers d'UI d'error i missatge de lobby --------------------------------
export function showAuthErr(txt) {
  const el = document.getElementById("authErrMsg");
  if (!el) {
    console.error(txt);
    return;
  }
  el.textContent = txt;
  el.classList.remove("hidden");
}

export function clearAuthErr() {
  const el = document.getElementById("authErrMsg");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
}

function _setLobbyMsg(txt, cls) {
  const el = document.getElementById("lobbyMsg");
  if (!el) return;
  el.textContent = txt;
  el.className = "lobby-msg" + (cls ? " " + cls : "");
}

// --- Google Sign-In -----------------------------------------------------------
export async function handleCredentialResponse(response) {
  clearAuthErr();
  try {
    const idToken = response?.credential;
    if (!idToken) return;
    const credential = GoogleAuthProvider.credential(idToken);
    await signInWithCredential(auth, credential);
  } catch (err) {
    console.error("Error login Google:", err);
    const code = err?.code || "";
    const hint =
      location.protocol === "file:"
        ? " Obre la pàgina amb un servidor local (http://localhost), Firebase Auth no funciona amb file://."
        : "";
    showAuthErr(
      `No s'ha pogut iniciar amb Google (${code || err?.message || "error"}).${hint}`,
    );
    _setLobbyMsg("No s'ha pogut iniciar amb Google.", "err");
  }
}

function readGoogleClientId() {
  const onload = document.getElementById("g_id_onload");
  return (
    onload?.dataset?.client_id ||
    "922530958932-hb10br4fvf87suf41vkjrdbuijdv6oor.apps.googleusercontent.com"
  );
}

function initGoogleSignInButton() {
  if (_gsiBootDone) return true;
  const gsi = window.google?.accounts?.id;
  if (!gsi) return false;
  try {
    const clientId = readGoogleClientId();
    gsi.initialize({
      client_id: clientId,
      callback: handleCredentialResponse,
      auto_select: false,
    });
    const slot = document.getElementById("g_id_signin");
    if (slot) {
      slot.innerHTML = "";
      gsi.renderButton(slot, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
        width: 340,
        logo_alignment: "left",
      });
    }
    const promoSlot = document.getElementById("g_id_signin_promo");
    if (promoSlot) {
      promoSlot.innerHTML = "";
      gsi.renderButton(promoSlot, {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "signin_with",
        shape: "pill",
        width: 300,
        logo_alignment: "left",
      });
    }
    _gsiBootDone = true;
    return true;
  } catch (e) {
    console.error("initGoogleSignInButton:", e);
    return false;
  }
}

function scheduleGoogleSignInInit() {
  if (initGoogleSignInButton()) return;
  let tries = 0;
  const id = setInterval(() => {
    tries++;
    if (initGoogleSignInButton() || tries > 50) clearInterval(id);
  }, 100);
  window.addEventListener("load", () => {
    initGoogleSignInButton();
  });
}

export function initAuthFlow() {
  if (_authReady) return;
  _authReady = true;
  window.handleCredentialResponse = handleCredentialResponse;
  scheduleGoogleSignInInit();
}

// --- Estadístiques de victòries (localStorage) --------------------------------
export function bumpStoredWinsIfWonGame() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const k = WINS_LS_PREFIX + uid;
  const n = Number(localStorage.getItem(k) || 0) + 1;
  localStorage.setItem(k, String(n));
  const el = document.getElementById("user-wins-count");
  if (el) el.textContent = String(n);
}
