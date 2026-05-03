import { AVATAR_IMAGES, GUEST_LOBBY_AVATAR, BOT_AVATAR } from "./avatars.js";

const SPRITE_PNG = "./Media/Images/Cards/cards-sprite.png";
const SPRITE_JSON = "./Media/Images/Cards/cards-sprite.json";

const BG_IMAGE_BY_TABLE = {
  bg3: "./Media/Images/Others/fondo-mesa-juego-bar.webp",
  verde: "./Media/Images/Others/fondo-verde.webp",
  azul: "./Media/Images/Others/fondo-azul.webp",
};

const warmCache = new Map();

/** URLs del atlas (PNG + JSON) a precalentar antes de la partida. */
function buildCardUrls() {
  return [SPRITE_PNG, SPRITE_JSON];
}

function preloadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      resolve();
    };
    img.decoding = "async";
    img.onload = settle;
    img.onerror = settle;
    img.src = src;
    if (typeof img.decode === "function") {
      img.decode().then(settle).catch(() => {});
    }
  });
}

function preloadJson(src) {
  return fetch(src)
    .then(() => {})
    .catch(() => {});
}

function preloadUrl(src) {
  return src.endsWith(".json") ? preloadJson(src) : preloadImage(src);
}

function preloadAssetGroup(deck, tableBackground) {
  const urls = buildCardUrls();
  const bgSrc =
    BG_IMAGE_BY_TABLE[tableBackground] ||
    `./Media/Images/Others/fondo-mesa-juego-${tableBackground}.webp`;
  const tasks = urls.map(preloadUrl);
  if (bgSrc) tasks.push(preloadImage(bgSrc));
  return Promise.all(tasks);
}

export async function warmupMatchAssets({
  deck = "classic",
  tableBackground = "verde",
  timeoutMs = 1800,
} = {}) {
  const key = `${deck}|${tableBackground}`;
  const loadPromise =
    warmCache.get(key) ||
    preloadAssetGroup(deck, tableBackground).catch(() => {});
  warmCache.set(key, loadPromise);

  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(false), timeoutMs);
  });
  const loaded = await Promise.race([loadPromise.then(() => true), timeoutPromise]);
  if (timeoutId != null) clearTimeout(timeoutId);
  return loaded;
}

/**
 * Precarga en segundo plano todos los avatares disponibles (lista + especiales).
 * Llamar al mostrar el lobby, antes de que el usuario pueda elegir avatar.
 */
export function preloadAllAvatars() {
  const urls = [
    ...AVATAR_IMAGES.map((p) => (p.startsWith("./") ? p : `./${p}`)),
    GUEST_LOBBY_AVATAR.startsWith("./") ? GUEST_LOBBY_AVATAR : `./${GUEST_LOBBY_AVATAR}`,
    BOT_AVATAR.startsWith("./") ? BOT_AVATAR : `./${BOT_AVATAR}`,
  ];
  urls.forEach(preloadImage);
}

/**
 * Precarga en segundo plano todos los fondos de mesa del mapa BG_IMAGE_BY_TABLE.
 * Llamar al entrar a la sala de espera (pre-lobby), antes de que la partida empiece.
 */
export function preloadAllTableBackgrounds() {
  Object.values(BG_IMAGE_BY_TABLE).forEach(preloadImage);
}
