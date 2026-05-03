// --- Truc Valencià . game.js (entrada) --------------------------------------
// Únic punt de veritat per a la transició login ↔ lobby: `onAuthStateChanged`.
import {
  auth,
  onAuthStateChanged,
  resetSession,
  logAppEvent,
} from "./firebase.js";
import {
  initApp,
  tryReconnectFromLocalStorage,
  tryJoinRoomFromInviteLink,
  detachRoomListeners,
  syncAvatarPickAfterAuth,
} from "./ui.js";
import { loadSpritesheet } from "./spritesheet.js";
import { preloadAllAvatars } from "./assetPreloader.js";

const WINS_LS_PREFIX = "truc_wins_";
/** Sufix numèric estable per sessió (001–999) per a usuaris anònims de Firebase. */
const ANON_NICK_KEY = "truc_anon_nick_";

function randomAnonSuffix001to999() {
  const n = Math.floor(Math.random() * 999) + 1;
  return String(n).padStart(3, "0");
}

function lobbyDisplayName(user) {
  if (!user) return "";
  if (user.isAnonymous) {
    const k = ANON_NICK_KEY + user.uid;
    let suf = sessionStorage.getItem(k);
    if (!suf) {
      suf = randomAnonSuffix001to999();
      sessionStorage.setItem(k, suf);
    }
    return `Convidat-${suf}`;
  }
  return (
    user.displayName ||
    user.email?.split("@")[0] ||
    "Jugador"
  ).slice(0, 24);
}

function updateLobbyProfileHeader(user) {
  const nameEl = document.getElementById("user-profile-name");
  const photoEl = document.getElementById("user-profile-photo");
  const winsEl = document.getElementById("user-wins-count");
  const nameInput = document.getElementById("nameInput");
  const welcomeEl = document.getElementById("lobbyWelcomeLine");

  const name = lobbyDisplayName(user);
  if (welcomeEl) {
    welcomeEl.classList.remove("lobby-welcome-glow-play");
    welcomeEl.textContent = name
      ? `Benvingut al Truc de la Terreta, ${name}!`
      : "";
    if (name) {
      void welcomeEl.offsetWidth;
      welcomeEl.classList.add("lobby-welcome-glow-play");
    }
  }
  if (nameEl) nameEl.textContent = name;
  if (nameInput) nameInput.value = name;

  if (photoEl) {
    const guestAvatar = "Media/Images/Others/avatar-convidat.webp";
    const fallbackSvg =
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="17" r="9" fill="rgba(255,255,255,.4)"/><path d="M6 46c2.5-11 13-17 18-17s15.5 6 18 17" fill="rgba(255,255,255,.22)"/></svg>`,
      );
    if (user.isAnonymous) {
      photoEl.src = guestAvatar;
      photoEl.alt = name;
      photoEl.classList.remove("is-placeholder");
    } else if (user.photoURL) {
      photoEl.src = user.photoURL;
      photoEl.alt = name;
      photoEl.classList.remove("is-placeholder");
    } else {
      photoEl.src = fallbackSvg;
      photoEl.alt = name;
      photoEl.classList.add("is-placeholder");
    }
  }

  // El badge de victòries es deixa en blanc aquí:
  // l'actualitzarà el listener de Firestore en temps real.

  const statsBtn = document.getElementById("btn-estadisticas");
  if (statsBtn) {
    statsBtn.style.opacity = "1";
    statsBtn.style.cursor = "pointer";
  }
}

/**
 * Subscriu un listener en temps real a Firestore per al document del jugador.
 * Actualitza el badge de victòries del capçal del lobby automàticament.
 * Retorna la funció unsubscribe.
 */
function subscribePlayerStats(uid) {
  // Cancel·lar listener anterior si n'hi havia
  if (_unsubPlayerStats) {
    _unsubPlayerStats();
    _unsubPlayerStats = null;
  }

  const playerDocRef = doc(firestore, "players", uid);
  _unsubPlayerStats = onSnapshot(
    playerDocRef,
    (snap) => {
      const winsEl = document.getElementById("user-wins-count");
      if (!winsEl) return;
      const wins = snap.exists() ? (snap.data().gamesWon || 0) : 0;
      winsEl.textContent = String(wins);
      // Sincronitzar localStorage per a sessions futures sense connexió
      localStorage.setItem(WINS_LS_PREFIX + uid, String(wins));
    },
    (err) => {
      // En cas d'error (p.ex. desconnexió), mostra el valor en caché del localStorage
      console.warn("subscribePlayerStats error:", err);
      const winsEl = document.getElementById("user-wins-count");
      if (winsEl) {
        const cached = Number(localStorage.getItem(WINS_LS_PREFIX + uid) || 0);
        winsEl.textContent = String(Number.isFinite(cached) ? cached : 0);
      }
    }
  );
}

async function applySignedInUi(user) {
  const pantallaInicio = document.getElementById("pantalla-inicio");
  const pantallaLobby = document.getElementById("pantalla-lobby");
  if (!pantallaInicio || !pantallaLobby) return;

  try {
    await loadSpritesheet();
  } catch (e) {
    console.error("loadSpritesheet:", e);
  }

  pantallaInicio.classList.add("hidden");
  pantallaLobby.classList.remove("hidden");

  // Precargar avatares en segundo plano para que aparezcan al instante al elegir
  preloadAllAvatars();

  if (user && !user.isAnonymous) {
    const promoModal = document.getElementById("statsPromoModal");
    if (promoModal) {
      promoModal.classList.add("hidden");
      promoModal.setAttribute("aria-hidden", "true");
    }
  }

  if (user?.uid) console.log("Auth UID:", user.uid);

  try {
    updateLobbyProfileHeader(user);
  } catch (e) {
    console.error("updateLobbyProfileHeader:", e);
  }
  try {
    syncAvatarPickAfterAuth();
  } catch (e) {
    console.error("syncAvatarPickAfterAuth:", e);
  }
  try {
    const joinedFromInvite = await tryJoinRoomFromInviteLink();
    if (!joinedFromInvite) {
      await tryReconnectFromLocalStorage();
    }
  } catch (e) {
    console.error("tryReconnectFromLocalStorage:", e);
  }
}

function applySignedOutUi() {
  const pantallaInicio = document.getElementById("pantalla-inicio");
  const pantallaLobby = document.getElementById("pantalla-lobby");
  if (!pantallaInicio || !pantallaLobby) return;
  pantallaInicio.classList.remove("hidden");
  pantallaLobby.classList.add("hidden");
  const welcomeEl = document.getElementById("lobbyWelcomeLine");
  if (welcomeEl) {
    welcomeEl.textContent = "";
    welcomeEl.classList.remove("lobby-welcome-glow-play");
  }
}

initApp();
logAppEvent("game_loaded");

onAuthStateChanged(auth, async (user) => {
  if (user) {
    await applySignedInUi(user);
  } else {
    detachRoomListeners();
    resetSession();
    applySignedOutUi();
  }
});
