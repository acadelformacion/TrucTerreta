// --- profile.js — Perfil persistent de l'usuari (Google Auth) ----------------
// Node Firebase RTDB: /users/{uid}/profile
// { nick, avatarId, tableBackground, cardDeck, nickChangedAt, nickChangeCount, updatedAt }
// Node Firebase RTDB: /nicknames/{nickNormalitzat} → { uid, reservedUntil }
//
// LÒGICA:
//   · Usuaris Google: llegeix/escriu RTDB. loadProfile() és async.
//   · Convidats / no-auth: getProfile() retorna DEFAULT_PROFILE.
//   · getProfile() és síncrona (retorna la caché en memòria).
//   · applyProfileToConfig() sincronitza el perfil amb config.js (localStorage).
//   · Nick: unicitat via transacció RTDB + cooldown de 30 dies des del 2n canvi.

import { auth, db, ref, get, set, remove, runTransaction } from "./firebase.js";
import { setConfig } from "./config.js";

// --- Opcions extensibles de cartes -------------------------------------------
export const CARD_DECK_OPTIONS = [
  { id: "classic", label: "Clàssic" },
  // Afegir aquí noves baralles quan estiguen disponibles:
  // { id: "modern", label: "Moderna" },
];

// --- Opcions de fons de taula -------------------------------------------------
export const TABLE_BG_OPTIONS = [
  { id: "verde", label: "Clàssic verd" },
  { id: "azul",  label: "Clàssic blau" },
  { id: "bg3",   label: "Bar" },
];

// --- Constants de nick -------------------------------------------------------
/** Temps de cooldown entre canvis de nick (30 dies). */
export const NICK_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** Quant de temps es manté reservat un nick al node /nicknames (60 dies). */
const NICK_HOLD_MS = 60 * 24 * 60 * 60 * 1000;

// --- Valors per defecte -------------------------------------------------------
const DEFAULT_PROFILE = {
  nick:             null,      // null → usar displayName de Google
  avatarId:         "g",       // "g" → foto Google; número → índex AVATAR_IMAGES
  tableBackground:  "verde",
  cardDeck:         "classic",
  nickChangedAt:    0,
  nickChangeCount:  0,
};

// --- Estat intern (caché en memòria) -----------------------------------------
let _cachedProfile = null;
/** true un cop loadProfile() ha acabat (amb èxit o amb fallback) */
let _loaded = false;

// --- Helpers -----------------------------------------------------------------
function _isGoogleUser() {
  const u = auth.currentUser;
  return !!(u && !u.isAnonymous);
}

function _rtdbPath() {
  return `users/${auth.currentUser.uid}/profile`;
}

// --- Helpers de nick ---------------------------------------------------------

/**
 * Normalitza un nick per a comparació i com a clau a /nicknames/.
 * lowercase + trim + col·lapsa espais.
 */
export function normalizeNick(nick) {
  if (!nick || typeof nick !== "string") return "";
  return nick.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Retorna l'estat del cooldown de canvi de nick de forma síncrona (usa la caché).
 * @returns {{ canChange: boolean, daysLeft: number, isFirstChange: boolean }}
 */
export function getNickCooldownStatus() {
  const prof = getProfile();
  const changeCount = prof.nickChangeCount || 0;

  // El primer canvi mai té cooldown (el nick per defecte no compta com a canvi)
  if (changeCount === 0) {
    return { canChange: true, daysLeft: 0, isFirstChange: true };
  }

  const changedAt = prof.nickChangedAt || 0;
  const elapsed   = Date.now() - changedAt;

  if (elapsed >= NICK_COOLDOWN_MS) {
    return { canChange: true, daysLeft: 0, isFirstChange: false };
  }

  const daysLeft = Math.ceil((NICK_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
  return { canChange: false, daysLeft, isFirstChange: false };
}

/**
 * Comprova si un nick és disponible llegint /nicknames/ (async).
 * @returns {Promise<{ available: boolean, takenByMe: boolean }>}
 */
export async function checkNickAvailability(nick) {
  const normalized = normalizeNick(nick);
  if (!normalized) return { available: true, takenByMe: false };

  const u = auth.currentUser;
  if (!u) return { available: false, takenByMe: false };

  try {
    const snap = await get(ref(db, `nicknames/${normalized}`));
    if (!snap.exists()) return { available: true, takenByMe: false };

    const data = snap.val();
    // El nick és nostre
    if (data.uid === u.uid) return { available: true, takenByMe: true };
    // La reserva ha expirat: tractam com lliure
    if (data.reservedUntil && data.reservedUntil < Date.now()) {
      return { available: true, takenByMe: false };
    }
    return { available: false, takenByMe: false };
  } catch (err) {
    console.warn("checkNickAvailability error:", err);
    // Fallback permissiu: deixem intentar-ho, la transacció ho verificarà
    return { available: true, takenByMe: false };
  }
}

// --- API pública -------------------------------------------------------------

/**
 * Carrega el perfil de Firebase RTDB (usuaris Google) o retorna el default.
 * Ha de ser cridat amb `await` a applySignedInUi() ABANS de tot.
 * Té un timeout de 3 s per no bloquejar si hi ha problemes de xarxa.
 */
export async function loadProfile() {
  _loaded = false;
  _cachedProfile = null;

  const u = auth.currentUser;
  if (!u || u.isAnonymous) {
    _cachedProfile = { ...DEFAULT_PROFILE };
    _loaded = true;
    return _cachedProfile;
  }

  try {
    const snap = await Promise.race([
      get(ref(db, _rtdbPath())),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("profile_timeout")), 3000),
      ),
    ]);

    if (snap && snap.exists()) {
      const raw = snap.val();
      _cachedProfile = {
        nick:             raw.nick             ?? DEFAULT_PROFILE.nick,
        avatarId:         raw.avatarId         ?? DEFAULT_PROFILE.avatarId,
        tableBackground:  raw.tableBackground  ?? DEFAULT_PROFILE.tableBackground,
        cardDeck:         raw.cardDeck         ?? DEFAULT_PROFILE.cardDeck,
        nickChangedAt:    raw.nickChangedAt     ?? 0,
        nickChangeCount:  raw.nickChangeCount   ?? 0,
      };
    } else {
      // Primer ús: no hi ha perfil guardat
      _cachedProfile = { ...DEFAULT_PROFILE };
    }
  } catch (err) {
    console.warn("loadProfile: error o timeout, usant perfil per defecte.", err);
    _cachedProfile = { ...DEFAULT_PROFILE };
  }

  _loaded = true;
  return _cachedProfile;
}

/**
 * Guarda un perfil parcial (merge) a RTDB i actualitza la caché.
 * Si el nick canvia, comprova unicitat via transacció i aplica cooldown.
 * Llança errors específics: 'nick_taken', 'nick_cooldown'.
 * Només funciona per a usuaris Google.
 */
export async function saveProfile(partial = {}) {
  if (!_isGoogleUser()) return;

  const prev = { ...(_cachedProfile || DEFAULT_PROFILE) };
  const next = { ...prev, ...partial };

  // Validació del nick (màx 18 chars, trim)
  if (typeof next.nick === "string") {
    next.nick = next.nick.trim().slice(0, 18) || null;
  }

  const uid = auth.currentUser.uid;
  const prevNickNorm = normalizeNick(prev.nick);
  const nextNickNorm = normalizeNick(next.nick);
  const nickIsChanging = next.nick !== null && prevNickNorm !== nextNickNorm;

  // --- Lògica de canvi de nick -----------------------------------------------
  if (nickIsChanging) {
    const changeCount = prev.nickChangeCount || 0;

    // Comprovar cooldown (llevat del primer canvi)
    if (changeCount > 0) {
      const elapsed = Date.now() - (prev.nickChangedAt || 0);
      if (elapsed < NICK_COOLDOWN_MS) {
        const daysLeft = Math.ceil((NICK_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
        throw Object.assign(new Error("nick_cooldown"), { daysLeft });
      }
    }

    // Intentar reclamar el nou nick via transacció atòmica
    const nickRef = ref(db, `nicknames/${nextNickNorm}`);
    let claimResult;
    try {
      claimResult = await runTransaction(nickRef, (cur) => {
        if (cur && cur.uid !== uid && cur.reservedUntil > Date.now()) {
          return undefined; // abortir — nick en ús per un altre
        }
        return { uid, reservedUntil: Date.now() + NICK_HOLD_MS };
      });
    } catch (e) {
      throw Object.assign(new Error("nick_taken"), { cause: e });
    }

    if (!claimResult.committed) {
      throw new Error("nick_taken");
    }

    // Alliberar el nick anterior (si n'hi havia un diferent)
    if (prevNickNorm && prevNickNorm !== nextNickNorm) {
      await remove(ref(db, `nicknames/${prevNickNorm}`)).catch(() => {});
    }

    // Actualitzar comptadors de canvi
    next.nickChangedAt   = Date.now();
    next.nickChangeCount = changeCount + 1;
  }

  // Si nick s'esborra (null), alliberar la reserva
  if (next.nick === null && prevNickNorm) {
    await remove(ref(db, `nicknames/${prevNickNorm}`)).catch(() => {});
    // No resetegem els comptadors — mantenim el registre del darrer canvi
  }

  next.updatedAt = Date.now();

  // Actualitzar caché primer (optimistic update)
  _cachedProfile = next;

  // Persistir a RTDB
  try {
    await set(ref(db, _rtdbPath()), {
      nick:             next.nick,
      avatarId:         next.avatarId,
      tableBackground:  next.tableBackground,
      cardDeck:         next.cardDeck,
      nickChangedAt:    next.nickChangedAt  || 0,
      nickChangeCount:  next.nickChangeCount || 0,
      updatedAt:        next.updatedAt,
    });
  } catch (err) {
    // Revertir la caché si el write falla
    _cachedProfile = prev;
    console.error("saveProfile: error escrivint a RTDB.", err);
    throw err;
  }

  // Sincronitzar config.js (localStorage) perquè la roda dentada reflectisca el perfil
  applyProfileToConfig();
}

/**
 * Lectura síncrona del perfil en memòria.
 * Retorna DEFAULT_PROFILE si loadProfile() no ha acabat encara.
 */
export function getProfile() {
  return _cachedProfile || { ...DEFAULT_PROFILE };
}

/**
 * Nick a mostrar: nick del perfil si existeix, displayName de Google,
 * o "Convidat" com a últim recurs.
 */
export function getDisplayNick() {
  const prof = getProfile();
  if (prof.nick) return prof.nick;
  const u = auth.currentUser;
  if (!u) return "Convidat";
  if (u.isAnonymous) return null; // game.js genera el Convidat-xxx anònim
  return (
    u.displayName ||
    u.email?.split("@")[0] ||
    "Jugador"
  ).slice(0, 24);
}

/**
 * Aplica tableBackground i cardDeck del perfil a config.js (localStorage).
 * S'ha de cridar just després de loadProfile().
 */
export function applyProfileToConfig() {
  const prof = getProfile();
  if (prof.tableBackground) setConfig("tableBackground", prof.tableBackground);
  if (prof.cardDeck)        setConfig("cardDeck",        prof.cardDeck);
}

/**
 * Indica si loadProfile() ja ha acabat (per a guards opcionals).
 */
export function isProfileLoaded() {
  return _loaded;
}
