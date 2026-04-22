const CARD_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
const SUIT_LETTERS = ["o", "c", "e", "b"];
const BG_IMAGE_BY_TABLE = {
  bg3: "./Media/Images/Others/fondo-mesa-juego-bar.webp",
};

const warmCache = new Map();

function buildCardUrls(deck = "classic") {
  const basePath =
    deck && deck !== "classic"
      ? `./Media/Images/Cards/${deck}`
      : "./Media/Images/Cards";
  const urls = [];
  for (const n of CARD_NUMBERS) {
    for (const s of SUIT_LETTERS) {
      urls.push(`${basePath}/${n}${s}.jpg`);
    }
  }
  return urls;
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

function preloadAssetGroup(deck, tableBackground) {
  const urls = buildCardUrls(deck);
  const bgSrc =
    tableBackground === "green" || tableBackground === "bg2"
      ? null
      : (BG_IMAGE_BY_TABLE[tableBackground] ||
        `./Media/Images/Others/fondo-mesa-juego-${tableBackground}.webp`);
  if (bgSrc) urls.push(bgSrc);
  return Promise.all(urls.map(preloadImage));
}

export async function warmupMatchAssets({
  deck = "classic",
  tableBackground = "green",
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
