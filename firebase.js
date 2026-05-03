// --- Firebase (config + DB + sesión de sala) ---------------------------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getDatabase,
  ref,
  get,
  set,
  push,
  remove,
  onValue,
  runTransaction,
  onDisconnect,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signInAnonymously,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getAnalytics,
  logEvent,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";
import {
  getFunctions,
  httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

export const firebaseConfig = {
  apiKey: "AIzaSyBHQ3hSWToVKzADI9eUlCNONbi_lN_TTAI",
  authDomain: "trucvalencia-12345.firebaseapp.com",
  databaseURL:
    "https://trucvalencia-12345-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "trucvalencia-12345",
  storageBucket: "trucvalencia-12345.firebasestorage.app",
  messagingSenderId: "922530958932",
  appId: "1:922530958932:web:84fe1d9386f5ea2d6f67c1",
  measurementId: "G-VSTR2KB00Q",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase();
export const auth = getAuth(app);
export const analytics = getAnalytics(app);
export const functions = getFunctions(app, "europe-west1");
export const firestore = getFirestore(app);

// --- Sincronització de temps amb el servidor ----------------------------------
let _serverTimeOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
  _serverTimeOffset = snap.val() || 0;
});

/** Retorna el timestamp actual sincronitzat amb el servidor de Google. */
export function getServerTime() {
  return Date.now() + _serverTimeOffset;
}

/**
 * Wrapper genérico para eventos de Analytics.
 * Ús: logAppEvent("event_name", { key: "value" })
 */
export function logAppEvent(eventName, params = undefined) {
  if (!analytics || !eventName) return;
  if (params && typeof params === "object") {
    logEvent(analytics, eventName, params);
    return;
  }
  logEvent(analytics, eventName);
}

/** Referencias mutables compartidas entre módulos (misma referencia de objeto) */
export const session = {
  roomRef: null,
  roomCode: null,
  mySeat: null,
  /** "public" | "private" | null (fora de sala) */
  roomVisibility: null,
  /** Mà secreta del meu seient (només per hidratar `mutate` si RTDB té '*'). Omple ui.js */
  secretHandMine: null,
  /** Mà del bot al seient _1 (mateixa finalitat). Omple ui.js en mode bot */
  botSecretHandForMutate: null,
};

/** Estat «fora de sala» després de logout o tancament net de listeners. */
export function resetSession() {
  session.roomRef = null;
  session.roomCode = null;
  session.mySeat = null;
  session.roomVisibility = null;
  session.secretHandMine = null;
  session.botSecretHandForMutate = null;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * True només amb la mà inicial tapada sense cartes reals encara (exactament * * *).
 * Qualsevol altra forma (cartes reals, manca de clau després de toHObj, etc.) ha d'usar RTDB, no el secret.
 */
export function handSlotNeedsSecretReveal(slot) {
  if (!slot || typeof slot !== "object") return false;
  return slot.a === "*" && slot.b === "*" && slot.c === "*";
}

function hydrateHandsForMutate(state) {
  const hands = state?.hand?.hands;
  if (!hands) return;
  const hn = Number(state.handNumber);

  const apply = (seatKey, secret) => {
    if (!secret || Number(secret.hn) !== hn) return;
    const slot = hands[seatKey];
    if (!handSlotNeedsSecretReveal(slot)) return;
    hands[seatKey] = { a: secret.a, b: secret.b, c: secret.c };
  };

  if (session.mySeat !== null) {
    apply(`_${session.mySeat}`, session.secretHandMine);
  }
  apply("_1", session.botSecretHandForMutate);
}

export async function mutate(fn, getDefaultState) {
  if (!session.roomRef) return null;
  try {
    return await runTransaction(
      session.roomRef,
      (cur) => {
        if (!cur) return cur;
        const next = clone(cur);
        if (!next.state) next.state = getDefaultState();
        hydrateHandsForMutate(next.state);
        next.lastActivity = serverTimestamp();
        if (fn(next.state) === false) return;
        return next;
      },
      { applyLocally: false },
    );
  } catch (e) {
    console.error("mutate:", e);
    return null;
  }
}

export { ref, get, set, push, remove, onValue, runTransaction, onDisconnect, serverTimestamp };
export {
  GoogleAuthProvider,
  signInWithCredential,
  signInAnonymously,
  onAuthStateChanged,
  signOut,
};
export { httpsCallable };

