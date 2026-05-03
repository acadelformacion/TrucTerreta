// --- Spritesheet de cartas (JSON TexturePacker + PNG) -----------------------
import { parseCard } from "./logica.js";

const SPRITE_JSON = new URL(
  "./Media/Images/Cards/cards-sprite.json",
  import.meta.url,
).href;

const SPRITE_PNG = new URL(
  "./Media/Images/Cards/cards-sprite.png",
  import.meta.url,
).href;

/** @type {object | null} */
let _atlas = null;
/** @type {string | null} */
let _spriteUrl = null;
/** @type {HTMLImageElement | null} */
let _img = null;
let _resolveReady = null;
export const spritesheetReady = new Promise((resolve) => {
  _resolveReady = resolve;
});

const SUIT_LETTER = {
  oros: "o",
  copas: "c",
  espadas: "e",
  bastos: "b",
};

function resolveFrameKey(cardName) {
  if (!_atlas?.frames) return null;
  const frames = _atlas.frames;
  const s = String(cardName ?? "").trim();
  if (!s) return null;

  if (frames[s]) return s;
  const withPng = s.endsWith(".png") ? s : `${s}.png`;
  if (frames[withPng]) return withPng;

  const { num, suit } = parseCard(s);
  if (Number.isNaN(num) || !suit) return null;
  const letter = SUIT_LETTER[suit];
  if (!letter) return null;
  const code = `${num}${letter}.png`;
  return frames[code] ? code : null;
}

export async function loadSpritesheet() {
  if (_atlas && _spriteUrl) return;
  try {
    const jsonPromise = fetch(SPRITE_JSON).then((r) => {
      if (!r.ok) throw new Error(`cards-sprite.json: ${r.status}`);
      return r.json();
    });

    const imgPromise = new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`No se pudo cargar ${SPRITE_PNG}`));
      im.src = SPRITE_PNG;
    });

    const [atlas, img] = await Promise.all([jsonPromise, imgPromise]);
    _atlas = atlas;
    _img = img;
    _spriteUrl = SPRITE_PNG;
  } catch (_err) {
    console.error("[spritesheet] Falló la carga, continuando sin sprites");
  } finally {
    if (_resolveReady) {
      _resolveReady();
      _resolveReady = null;
    }
  }
}

export function isSpritesheetReady() {
  return _atlas !== null;
}

/**
 * Objeto de estilo (background-*) para una carta del spritesheet.
 * Porcentajes: el frame llena el contenedor (.card-art 100%×100%) sin medir px.
 * `cardName`: código de imagen (`10b`) o carta de logica (`10_bastos`).
 */
export function getCardStyle(cardName) {
  if (!_atlas?.frames || !_spriteUrl) {
    console.warn("[spritesheet] getCardStyle: atlas no cargado");
    return {};
  }

  const raw = String(cardName ?? "").trim();
  if (!raw || raw === "~" || raw === "*") return {};

  const frameKey = resolveFrameKey(raw);
  if (!frameKey) {
    console.warn(`[spritesheet] getCardStyle: clave desconocida "${cardName}"`);
    return {};
  }

  const entry = _atlas.frames[frameKey];
  const frame = entry?.frame;
  if (!frame) {
    console.warn(`[spritesheet] getCardStyle: sin frame para "${cardName}"`);
    return {};
  }

  const meta = _atlas.meta?.size;
  const sw = meta?.w;
  const sh = meta?.h;
  if (!sw || !sh) {
    console.warn("[spritesheet] getCardStyle: falta meta.size");
    return {};
  }

  const { x, y, w: fw, h: fh } = frame;
  if (!fw || !fh) {
    console.warn("[spritesheet] getCardStyle: frame sin dimensiones");
    return {};
  }

  const bsX = (sw / fw * 100).toFixed(4) + "%";
  const bsY = (sh / fh * 100).toFixed(4) + "%";
  const bpX = sw === fw ? "0%" : (x / (sw - fw) * 100).toFixed(4) + "%";
  const bpY = sh === fh ? "0%" : (y / (sh - fh) * 100).toFixed(4) + "%";

  return {
    backgroundImage: `url('${_spriteUrl}')`,
    backgroundSize: `${bsX} ${bsY}`,
    backgroundPosition: `${bpX} ${bpY}`,
  };
}
