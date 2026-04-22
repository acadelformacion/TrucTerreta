// config.js — Gestió de preferències locals del jugador

const CONFIG_KEY = "trucConfig";

const DEFAULT_CONFIG = {
  buttonSize: "normal", // 'normal' | 'large'
  cardDeck: "classic", // 'classic' | (añade más aquí)
  tableBackground: "green", // 'green' | 'bg2' | (añade más aquí)
  sound: true, // true | false
  vibration: true, // true | false
};

// Carga config desde localStorage, fusionando con defaults
export function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    return { ...DEFAULT_CONFIG, ...saved };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Guarda una clave concreta
export function setConfig(key, value) {
  const cfg = loadConfig();
  cfg[key] = value;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  applyConfig(cfg);
}

// Aplica toda la config al DOM
export function applyConfig(cfg = loadConfig()) {
  // Tamaño de botones
  document.body.classList.toggle("btn-large", cfg.buttonSize === "large");

  // Fondo de la mesa
  const table = document.getElementById("table");
  if (table) {
    // Quita todas las clases de fondo anteriores
    table.classList.forEach((cls) => {
      if (cls.startsWith("bg-")) table.classList.remove(cls);
    });
    if (cfg.tableBackground !== "green") {
      table.classList.add(`bg-${cfg.tableBackground}`);
    }
  }

  // Sonido: no hace nada en el DOM, isSoundEnabled() lo consulta
}

// Consulta rápida para las funciones de audio en ui.js
export function isSoundEnabled() {
  return loadConfig().sound !== false;
}

export function isVibrationEnabled() {
  return loadConfig().vibration !== false;
}
