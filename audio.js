// --- audio.js — Web Audio API sintetitzat en temps real ---
import { isSoundEnabled } from "./config.js";

let _ac = null;
export const ac = () => {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  return _ac;
};

export function tone(f, t, d, v, dl) {
  try {
    const c = ac(),
      ts = c.currentTime + (dl || 0);
    const o = c.createOscillator(),
      g = c.createGain();
    o.type = t || "sine";
    o.frequency.setValueAtTime(f, ts);
    g.gain.setValueAtTime(v || 0.15, ts);
    g.gain.exponentialRampToValueAtTime(0.001, ts + (d || 0.1));
    o.connect(g);
    g.connect(c.destination);
    o.start(ts);
    o.stop(ts + (d || 0.1));
  } catch (e) {}
}

const cardAudioFiles = [
  "colocar-carta-1", "colocar-carta-2", "colocar-carta-3", "colocar-carta-4",
  "deslizar-carta-1", "deslizar-carta-2", "deslizar-carta-3", "deslizar-carta-4",
  "deslizar-carta-5", "deslizar-carta-6", "deslizar-carta-7", "deslizar-carta-8",
  "deslizar-carta-9", "deslizar-carta-10", "deslizar-carta-11"
];
let cardHowls = [];

export const sndCard = (index) => {
  if (!isSoundEnabled()) return;
  
  if (cardHowls.length === 0 && typeof Howl !== 'undefined') {
    cardHowls = cardAudioFiles.map(name => new Howl({
      src: [`Media/Audio/${name}.ogg`, `Media/Audio/${name}.mp3`]
    }));
  }

  if (cardHowls.length > 0) {
    const i = typeof index === 'number' && index >= 0 && index < cardHowls.length 
      ? index 
      : Math.floor(Math.random() * cardHowls.length);
    cardHowls[i].play();
  } else {
    tone(440, "triangle", 0.07, 0.14);
    tone(560, "triangle", 0.05, 0.09, 0.06);
  }
};
export const sndWin = () => {
  if (!isSoundEnabled()) return;
  [523, 659, 784, 1047].forEach((f, i) => tone(f, "sine", 0.14, 0.17, i * 0.1));
};
export const sndPoint = () => {
  if (!isSoundEnabled()) return;
  tone(330, "sine", 0.11, 0.13);
  tone(450, "sine", 0.09, 0.11, 0.1);
};
export const sndTick = () => {
  if (!isSoundEnabled()) return;
  tone(880, "square", 0.04, 0.06);
};
export const sndBtn = () => {
  if (!isSoundEnabled()) return;
  tone(600, "sine", 0.04, 0.08);
};
export const sndLose = () => {
  if (!isSoundEnabled()) return;
  tone(200, "sawtooth", 0.3, 0.12);
  tone(150, "sawtooth", 0.4, 0.1, 0.25);
};

// --- Detecció de sons per diff d'estat (prevEnvSt/prevTrucSt viuen ací) -------
let prevEnvSt = "none";
let prevTrucSt = "none";

export function detectSounds(state) {
  const h = state.hand;
  if (!h) return;
  if (h.envit.state === "accepted" && prevEnvSt !== "accepted") sndPoint();
  if (h.truc.state === "accepted" && prevTrucSt !== "accepted") sndPoint();
  prevEnvSt = h.envit.state || "none";
  prevTrucSt = h.truc.state || "none";
}
