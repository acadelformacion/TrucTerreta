import { session } from './firebase.js';
import { isSoundEnabled } from './config.js';

// ── CONSTANTES ────────────────────────────────────────────────
const BOT_SEAT = 1;
const OBS_SIZE = 85;
const NUM_ACTIONS = 14;
const OFFSET = 10;
const EMPTY_CARD = '~';

const ALL_ACTIONS = [
  ['PLAY_CARD',0],['PLAY_CARD',1],['PLAY_CARD',2],
  ['OFFER','envit'],['OFFER','falta'],['OFFER','truc'],
  ['RESPOND_ENVIT','vull'],['RESPOND_ENVIT','no_vull'],
  ['RESPOND_ENVIT','torne'],['RESPOND_ENVIT','falta'],
  ['RESPOND_TRUC','vull'],['RESPOND_TRUC','no_vull'],
  ['RESPOND_TRUC','retruque'],['RESPOND_TRUC','val4'],
];

// Escalafón de poder (1-14)
const POWER = {
  '1_espadas':14,'1_bastos':13,'7_espadas':12,'7_oros':11,
  '3_oros':10,'3_copas':10,'3_espadas':10,'3_bastos':10,
  '2_oros':9,'2_copas':9,'2_espadas':9,'2_bastos':9,
  '1_oros':8,'1_copas':8,
  '12_oros':7,'12_copas':7,'12_espadas':7,'12_bastos':7,
  '11_oros':6,'11_copas':6,'11_espadas':6,'11_bastos':6,
  '10_oros':5,'10_copas':5,'10_espadas':5,'10_bastos':5,
  '7_copas':4,'7_bastos':4,
  '6_oros':3,'6_copas':3,'6_espadas':3,'6_bastos':3,
  '5_oros':2,'5_copas':2,'5_espadas':2,'5_bastos':2,
  '4_oros':1,'4_copas':1,'4_espadas':1,'4_bastos':1,
};

const _TRG = [
  ['1_espadas'],['1_bastos'],['7_espadas'],['7_oros'],
  ['3_oros','3_copas','3_espadas','3_bastos'],
  ['2_oros','2_copas','2_espadas','2_bastos'],
  ['1_oros','1_copas'],
  ['12_oros','12_copas','12_espadas','12_bastos'],
  ['11_oros','11_copas','11_espadas','11_bastos'],
  ['10_oros','10_copas','10_espadas','10_bastos'],
  ['7_copas','7_bastos'],
  ['6_oros','6_copas','6_espadas','6_bastos'],
  ['5_oros','5_copas','5_espadas','5_bastos'],
  ['4_oros','4_copas','4_espadas','4_bastos'],
];
const TRANK = {};
let _s = 100;
for (const g of _TRG) { for (const c of g) TRANK[c] = _s; _s -= 10; }

// ── HELPERS ───────────────────────────────────────────────────
const K = n => `_${n}`;
const PK = n => `p${n}`;
const real = n => Number(n || OFFSET) - OFFSET;

function fromHObj(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.filter(c => c && c !== EMPTY_CARD);
  return ['a','b','c'].map(k => obj[k]).filter(c => c && c !== EMPTY_CARD);
}

function getPlayed(h, seat) {
  const v = h?.played?.[PK(seat)];
  return (v && v !== EMPTY_CARD) ? v : null;
}

function power(card) { return POWER[card] || 0; }
function trank(card) { return TRANK[card] || 0; }
function parseCard(c) { const [n,s] = c.split('_'); return { num: Number(n), suit: s }; }
function evval(c) { const { num } = parseCard(c); return num >= 10 ? 0 : num; }

function bestEnvit(cards) {
  if (!cards?.length) return 0;
  let best = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i+1; j < cards.length; j++) {
      const { suit: si } = parseCard(cards[i]);
      const { suit: sj } = parseCard(cards[j]);
      if (si === sj) {
        const v = 20 + evval(cards[i]) + evval(cards[j]);
        if (v > best) best = v;
      }
    }
  }
  return best > 0 ? best : Math.max(0, ...cards.map(evval));
}

function maxPower(cards) {
  return cards.reduce((m, c) => Math.max(m, power(c)), 0);
}

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function roll(percent) {
  return Math.random() * 100 < percent;
}

// ── MEMORIA ADAPTATIVA ────────────────────────────────────────
const _mem = {
  // Perfiles del humano
  humanFarolero: 0,      // +20% querer durante N manos
  humanConservador: 0,   // +30% no_vull durante N manos
  humanEspera: 0,        // manos sin envidar siendo mano

  // Estados mentales del bot
  tilt: 0,               // manos consecutivas perdidas
  modVenganza: 0,        // manos restantes de venganza

  // Historial reciente para detección de patrones
  humanEnvitHistory: [], // 'envit'|'no_envit' por mano siendo mano
  humanRetiradas: 0,     // veces que humano dijo no_vull a retruc del bot
  humanTorneCount: 0,    // veces que humano usó torne recientemente
  botTorneWins: 0,       // veces que bot ganó farol de torne
  humanFaltaCount: 0,

  // Contadores de racha
  botLostStreak: 0,
  lastHandWinner: null,

  // Modo venganza activo
  venganzaActive: 0,
};

// Modificadores finales calculados por updateMemory()
let _mod = {
  bonusQuerer: 0,        // % extra para aceptar truc/envit
  bonusNoVull: 0,        // % extra para rechazar
  bonusEnvidar: 0,       // % extra para envidar
  malusTrucAccept: 0,    // % penalización aceptar truc rival
  tiltBonus: 0,          // % extra agresividad por tilt
  venganzaBonus: 0,      // % extra retruc por venganza
  envitThresholdMod: 0,  // reducción umbral envit por tilt (-2 pts)
};

export function resetBotMemory() {
  _botWasBluffingTruc = false;
  Object.assign(_mem, {
    humanFarolero: 0, humanConservador: 0, humanEspera: 0,
    tilt: 0, modVenganza: 0,
    humanEnvitHistory: [], humanRetiradas: 0,
    humanTorneCount: 0, botTorneWins: 0, humanFaltaCount: 0,
    botLostStreak: 0, lastHandWinner: null, venganzaActive: 0,
  });
  Object.assign(_mod, {
    bonusQuerer: 0, bonusNoVull: 0, bonusEnvidar: 0,
    malusTrucAccept: 0, tiltBonus: 0, venganzaBonus: 0,
    envitThresholdMod: 0,
  });
}

export function updateBotMemory(lastHandSummary, humanSeat, scores) {
  if (!lastHandSummary) return;
  const { hands, envit, truc, winner, mano: handMano } = lastHandSummary;

  const humanCards = fromHObj(hands?.[K(humanSeat)]);
  const humanWon = winner === humanSeat;
  const botWon = winner === BOT_SEAT;

  // ── Tilt ──────────────────────────────────────────────────
  if (botWon) {
    _mem.botLostStreak = 0;
    _mem.tilt = 0;
  } else {
    _mem.botLostStreak++;
    if (_mem.botLostStreak >= 3) _mem.tilt = 1;
  }

  // ── Venganza ──────────────────────────────────────────────
  if (envit.state === 'accepted' && envit.acceptedLevel === 'falta'
      && envit.winner === humanSeat) {
    _mem.venganzaActive = 2;
  }
  if (_mem.venganzaActive > 0) _mem.venganzaActive--;

  // ── Perfil Farolero ───────────────────────────────────────
  // Humano trucó/envidó pero tenía cartas malas y perdió
  if (humanWon === false && truc.state !== 'none'
      && truc.caller === humanSeat) {
    const hmp = maxPower(humanCards);
    if (hmp <= 7) {
      _mem.humanFarolero = Math.min(_mem.humanFarolero + 1, 3);
    }
  }
  if (_mem.humanFarolero > 0) _mem.humanFarolero--;

  // ── Perfil Conservador ────────────────────────────────────
  // Humano trucó/envidó solo con cartas máximas
  if (humanWon && truc.state !== 'none' && truc.caller === humanSeat) {
    const hmp = maxPower(humanCards);
    if (hmp >= 11) {
      _mem.humanConservador = Math.min(_mem.humanConservador + 1, 3);
    }
  }
  if (_mem.humanConservador > 0) _mem.humanConservador--;

  // ── Perfil Espera (humano mano no envida) ────────────────
  if (handMano === humanSeat) {
    if (envit.state === 'none' || envit.caller !== humanSeat) {
      _mem.humanEspera++;
    } else {
      _mem.humanEspera = 0;
    }
  }

  // ── Detector humano miedoso (retiradas ante retruc bot) ──
  if (truc.state !== 'none' && truc.caller === BOT_SEAT && !humanWon) {
    _mem.humanRetiradas = Math.min(_mem.humanRetiradas + 1, 5);
  } else {
    _mem.humanRetiradas = Math.max(0, _mem.humanRetiradas - 1);
  }

  // Detectar si humano canta falta frecuentemente
  if (envit.state !== 'none' && envit.acceptedLevel === 'falta'
      && envit.caller === humanSeat) {
    _mem.humanFaltaCount = Math.min((_mem.humanFaltaCount || 0) + 1, 3);
  } else {
    _mem.humanFaltaCount = Math.max(0, (_mem.humanFaltaCount || 0) - 1);
  }

  // ── Recalcular modificadores ──────────────────────────────
  _mod.bonusQuerer = _mem.humanFarolero > 0 ? 20 : 0;
  _mod.bonusNoVull = _mem.humanConservador > 0 ? 30 : 0;
  _mod.bonusEnvidar = Math.min(_mem.humanEspera * 10, 30);
  _mod.malusTrucAccept = _mem.humanConservador > 0 ? 15 : 0;
  _mod.tiltBonus = _mem.tilt ? 20 : 0;
  _mod.venganzaBonus = _mem.venganzaActive > 0 ? 20 : 0;
  _mod.envitThresholdMod = _mem.tilt ? -2 : 0;
}

// ── MOTOR DE ENVIT ────────────────────────────────────────────
function envitProb(pts, humanIsManoPassed) {
  let base;
  if (pts <= 7)       base = 7;
  else if (pts <= 22) base = 15;
  else if (pts <= 25) base = 35;
  else if (pts <= 28) base = 70;
  else if (pts <= 30) base = 90;
  else                base = 98;

  if (humanIsManoPassed) base = Math.min(100, base + 15);
  base += _mod.bonusEnvidar;
  base += _mod.tiltBonus;
  return base;
}

function acceptEnvitProb(pts) {
  let base;
  if (pts <= 4)       base = 0;
  else if (pts <= 7)  base = 3;
  else if (pts <= 24) base = 25;
  else if (pts <= 27) base = 70;
  else if (pts <= 30) base = 95;
  else                base = 100;

  base += _mod.bonusQuerer;
  base -= _mod.bonusNoVull;
  return Math.max(0, Math.min(100, base));
}

function torneProb(pts) {
  let base;
  if (pts >= 32)      base = 85;
  else if (pts >= 31) base = 60;
  else if (pts >= 28) base = 20;
  else if (pts >= 25) base = 5;
  else if (pts >= 20) base = 0;
  else                base = 4; // farol kamikaze

  // Detector humano miedoso: doble probabilidad de farol
  if (_mem.humanRetiradas >= 2 && (pts <= 7 || pts <= 27)) {
    base = Math.min(100, base * 2);
  }
  return base;
}

function acceptTorneProb(pts) {
  // Bot cantó envit, humano responde torne: bot se acobarda más
  if (pts <= 27)      return 0;
  else if (pts <= 30) return 35 + _mod.bonusQuerer;
  else if (pts <= 31) return 90;
  else                return 100;
}

function acceptFaltaProb(pts, botScore, humanScore, humanFaltaCount) {
  let base;
  const botWinning = botScore - humanScore > 4;

  if (pts >= 33)      base = 100;
  else if (pts >= 32) base = 90;
  else if (pts >= 31) base = 80;
  else if (pts >= 28) base = botWinning ? 0 : 70;
  else if (pts >= 27) base = botWinning ? 75 : 0;
  else                base = 0;

  // Ajuste caza-faroles
  if (humanFaltaCount >= 2 && pts >= 27) base = Math.max(base, 60);

  return Math.max(0, Math.min(100, base));
}

// ── MOTOR DE TRUC ─────────────────────────────────────────────
function trucProbManoFirst(myCards, humanScore, botScore) {
  const mp = maxPower(myCards);
  // Si humano está a 1 punto de ganar
  if (humanScore >= 11) return 90;
  // Si humano lleva 5+ puntos de ventaja
  if (humanScore - botScore >= 5) return 30;
  if (mp >= 11) return 30;
  if (mp >= 9)  return 15;
  return 0;
}

function trucProbPostreFirst(rivalCard) {
  const rp = power(rivalCard);
  if (rp <= 3)  return 20;
  if (rp <= 5)  return 15;
  if (rp <= 7)  return 10;
  if (rp <= 8)  return 5;
  if (rp <= 10) return 3;
  return 2;
}

function trucProbSecondBaza(myCards, won1st, draw1st, humanScore, botScore) {
  const mp = maxPower(myCards);
  if (won1st) {
    if (myCards.includes('1_espadas')) return 25; // hacerse el débil
    if (mp >= 9)  return 85;
    if (mp >= 1)  return 20;
  }
  if (draw1st) {
    // Parda: vida o muerte
    if (mp >= 11) return 100;
    if (mp >= 9)  return Math.max(5, 35 - (10 - mp) * 7);
    if (mp >= 8)  return 35;
    if (mp >= 4)  return Math.max(5, 35 - (8 - mp) * 6);
    return 0;
  }
  // Perdió 1ª baza
  if (mp >= 11) return 70;
  if (mp <= 4)  return 10; // farol desesperación
  return 0;
}

function retruqueProb(myCards, trucLevel) {
  const mp = maxPower(myCards);
  // ¿Tiene la mejor carta posible restante?
  const hasBest = myCards.includes('1_espadas') || myCards.includes('1_bastos');
  if (hasBest) return 100;

  let base;
  if (trucLevel <= 2) {
    // Responder truc con retruc
    if (mp >= 11) base = 45;
    else          base = 10;
  } else {
    // Responder retruc con val4
    if (mp >= 11) base = 35;
    else          base = 5;
  }
  base += _mod.venganzaBonus;
  base += _mod.tiltBonus * 0.5;
  return Math.min(100, base);
}

function acceptTrucProb(myCards, trucLevel) {
  const mp = maxPower(myCards);
  const hasBest = myCards.includes('1_espadas') || myCards.includes('1_bastos');
  if (hasBest) return 100;

  let base;
  if (mp >= 11) base = 80;
  else if (mp >= 9) base = 50;
  else if (mp >= 6) base = 25;
  else base = 10;

  base += _mod.bonusQuerer;
  base -= _mod.bonusNoVull;
  return Math.max(0, Math.min(100, base));
}

// ── SELECCIÓN DE CARTA ────────────────────────────────────────
function chooseCardToPlay(myCards, rivalCard, isMano) {
  if (!myCards.length) return 0;

  const sorted = [...myCards].map((c,i) => ({ c, i, p: power(c) }))
                              .sort((a,b) => a.p - b.p);
  const mp = maxPower(myCards);

  if (rivalCard) {
    // BOT ES POSTRE: regla de eficiencia mínima
    const winners = sorted.filter(x => trank(x.c) > trank(rivalCard));
    if (!winners.length) {
      // No puede ganar: tirar la más débil
      return sorted[0].i;
    }
    // Si tiene 2 cartas altas y una baja, 75% tira la baja
    const highCount = sorted.filter(x => x.p >= 9).length;
    if (highCount >= 2 && sorted[0].p <= 7 && roll(75)) {
      return sorted[0].i;
    }
    // Tirar la ganadora más débil
    return winners[0].i;
  }

  // BOT ES MANO: estrategia según tipo de mano
  const highCards = sorted.filter(x => x.p >= 11);
  const midCards  = sorted.filter(x => x.p >= 9 && x.p <= 10);

  // Nunca abrir con ases especiales o 7 especiales (95%)
  const hasSpecial = myCards.some(c =>
    ['1_espadas','1_bastos','7_espadas'].includes(c));

  if (mp >= 11) {
    // Mano fuerte: tirar carta mala el 80%
    if (roll(80) && sorted[0].p <= 7) return sorted[0].i;
    // Si tiene dos altas: tirar la más baja de las altas
    if (highCards.length >= 2) {
      const lowHigh = highCards.sort((a,b) => a.p - b.p)[0];
      return lowHigh.i;
    }
  }

  if (midCards.length === 1 && sorted[0].p <= 7) {
    // Mano media: 70% tira carta mala
    if (roll(70)) return sorted[0].i;
    return midCards[0].i;
  }

  // Mano morralla: tirar la más alta
  return sorted[sorted.length - 1].i;
}

// ── LÓGICA PRINCIPAL DE DECISIÓN ──────────────────────────────
function decideAction(state, myCards, qvals, legal) {
  const h = state.hand;
  const mode = h.mode;
  const po = h.pendingOffer;
  const rivalCard = getPlayed(h, 1 - BOT_SEAT);
  const hist = h.trickHistory || [];
  const envPts = bestEnvit(myCards) + _mod.envitThresholdMod;
  const botScore = real(state.scores?.[K(BOT_SEAT)]);
  const humanScore = real(state.scores?.[K(1 - BOT_SEAT)]);
  const humanIsMano = h.mano === (1 - BOT_SEAT);
  const humanPassedEnvit = humanIsMano && h.envit?.state === 'none'
                           && hist.length > 0;
  const trucLevel = Number(po?.level || h.truc?.acceptedLevel || 2);
  const mp = maxPower(myCards);

  // ── RESPOND_ENVIT ─────────────────────────────────────────
  if (mode === 'respond_envit' && po?.kind === 'envit') {
    const level = po.level;

    // Falta
    if (level === 'falta') {
      const faltaCount = _mem.humanFaltaCount || 0;
      if (roll(acceptFaltaProb(envPts, botScore, humanScore, faltaCount))) {
        return 6; // vull
      }
      return 7; // no_vull
    }

    // Torne del humano (nivel 4)
    if (level === 4) {
      if (roll(acceptTorneProb(envPts))) return 6; // vull
      return 7; // no_vull
    }

    // Envit normal (nivel 2): ¿subir con torne?
    if (level === 2) {
      if (roll(torneProb(envPts))) return 8; // torne
    }

    // Aceptar o rechazar
    if (roll(acceptEnvitProb(envPts))) return 6; // vull
    return 7; // no_vull
  }

  // ── RESPOND_TRUC ──────────────────────────────────────────
  if (mode === 'respond_truc' && po?.kind === 'truc') {
    const rp = retruqueProb(myCards, trucLevel);
    const ap = acceptTrucProb(myCards, trucLevel);
    const hasBest = myCards.includes('1_espadas') || myCards.includes('1_bastos');

    if (trucLevel === 2 && roll(rp)) {
      if (hasBest || mp >= 11) _botWasBluffingTruc = false;
      else _botWasBluffingTruc = true;
      return 12; // retruque
    }
    if (trucLevel === 3 && legal.includes(13) && roll(rp)) {
      if (hasBest || mp >= 11) _botWasBluffingTruc = false;
      else _botWasBluffingTruc = true;
      return 13; // val4
    }
    if (roll(ap)) return 10; // vull
    return 11; // no_vull
  }

  // ── MODO NORMAL ───────────────────────────────────────────
  if (mode === 'normal' && !po) {

    // ¿Cantar envit?
    if (legal.includes(3) && h.envitAvailable
        && h.envit?.state === 'none') {
      const prob = envitProb(envPts, humanPassedEnvit);
      if (roll(prob)) {
        // ¿Falta o envit normal?
        if (legal.includes(4) && envPts >= 31 && roll(40)) return 4; // falta
        return 3; // envit
      }
    }

    // ¿Cantar truc?
    if (legal.includes(5)) {
      let trucProb = 0;
      const b1 = hist[0];
      if (!b1) {
        // Primera baza, soy mano
        if (h.mano === BOT_SEAT) {
          trucProb = trucProbManoFirst(myCards, humanScore, botScore);
        } else if (rivalCard) {
          trucProb = trucProbPostreFirst(rivalCard);
        }
      } else {
        // Segunda o tercera baza
        const won1st = b1.winner === BOT_SEAT;
        const draw1st = b1.winner === 99;
        trucProb = trucProbSecondBaza(myCards, won1st, draw1st,
                                      humanScore, botScore);
      }
      trucProb += _mod.tiltBonus;
      if (roll(trucProb)) return 5; // truc
    }

    // Jugar carta
    if (_botWasBluffingTruc) {
      _botWasBluffingTruc = false;
      // Tirar la carta más débil para minimizar daños
      const weakest = [...myCards]
        .map((c,i) => ({ c, i, p: power(c) }))
        .sort((a,b) => a.p - b.p)[0];
      if (weakest && legal.includes(weakest.i)) return weakest.i;
    }
    const cardIdx = chooseCardToPlay(myCards, rivalCard, h.mano === BOT_SEAT);
    const actionIdx = cardIdx; // PLAY_CARD[0,1,2]
    if (legal.includes(actionIdx)) return actionIdx;
    // Fallback: primera carta legal
    const playLegal = legal.filter(i => i <= 2);
    if (playLegal.length) return playLegal[0];
  }

  // Fallback RL
  return null;
}

// ── CONSTRUCCIÓN DE OBSERVACIÓN (para RL fallback) ────────────
function encCard(c) {
  if (!c || c === EMPTY_CARD) return new Array(7).fill(0.0);
  const { suit } = parseCard(c);
  return [
    trank(c)/100.0, evval(c)/7.0,
    suit==='oros'?1:0, suit==='copas'?1:0,
    suit==='espadas'?1:0, suit==='bastos'?1:0, 1.0
  ];
}

function buildObservation(state, seat) {
  const obs = new Float32Array(OBS_SIZE);
  const h = state?.hand;
  if (!h) return obs;
  const opp = 1 - seat;
  let idx = 0;
  const myCards = fromHObj(h.hands?.[K(seat)]);
  for (let i = 0; i < 3; i++) {
    const enc = encCard(myCards[i] || null);
    for (const v of enc) obs[idx++] = v;
  }
  const encMe = encCard(getPlayed(h, seat));
  const encOpp = encCard(getPlayed(h, opp));
  for (const v of encMe) obs[idx++] = v;
  for (const v of encOpp) obs[idx++] = v;
  const hist = h.trickHistory || [];
  for (let ti = 0; ti < 2; ti++) {
    if (ti < hist.length) {
      const t = hist[ti];
      const c0 = seat===0 ? t.c0 : t.c1;
      const c1 = seat===0 ? t.c1 : t.c0;
      const encA = encCard(c0); for (const v of encA) obs[idx++] = v;
      const encB = encCard(c1); for (const v of encB) obs[idx++] = v;
      const w = t.winner;
      obs[idx++] = w===seat ? 1.0 : (w===opp ? -1.0 : 0.0);
    } else { idx += 15; }
  }
  obs[idx++] = real(state.scores?.[K(seat)]) / 12.0;
  obs[idx++] = real(state.scores?.[K(opp)]) / 12.0;
  obs[idx++] = h.mano === seat ? 1.0 : 0.0;
  obs[idx++] = real(h.trickIndex) / 3.0;
  obs[idx++] = real(h.trickWins?.[K(seat)]) / 2.0;
  obs[idx++] = real(h.trickWins?.[K(opp)]) / 2.0;
  obs[idx++] = h.envitAvailable ? 1.0 : 0.0;
  const modes = { normal:0, respond_envit:1, respond_truc:2 };
  obs[idx + (modes[h.mode] ?? 0)] = 1.0; idx += 3;
  const po = h.pendingOffer;
  obs[idx++] = po ? (typeof po.level==='number' ? po.level/4.0 : 1.0) : 0.0;
  const es = { none:0, accepted:1, rejected:2 };
  obs[idx + (es[h.envit?.state] ?? 0)] = 1.0; idx += 3;
  const al = h.envit?.acceptedLevel;
  obs[idx++] = al==='falta' ? 1.0 : (al ? al/4.0 : 0.0);
  obs[idx + (es[h.truc?.state] ?? 0)] = 1.0; idx += 3;
  const tl = h.truc?.acceptedLevel;
  obs[idx++] = tl ? tl/4.0 : 0.0;
  obs[idx++] = bestEnvit(myCards) / 38.0;
  return obs;
}

function buildActionMask(state, seat) {
  const mask = new Float32Array(NUM_ACTIONS).fill(0);
  const h = state?.hand;
  if (!h || state.status !== 'playing' || h.status !== 'in_progress') return mask;
  if (h.turn !== seat) return mask;
  const mode = h.mode;
  const po = h.pendingOffer;
  const myCards = fromHObj(h.hands?.[K(seat)]);
  const nc = myCards.length;
  const alreadyPlayed = getPlayed(h, seat) !== null;
  if (mode === 'normal' && !po) {
    if (!alreadyPlayed) for (let i = 0; i < nc; i++) mask[i] = 1.0;
    if (h.envitAvailable && h.envit?.state === 'none') {
      mask[3] = 1.0; mask[4] = 1.0;
    }
    const tr = h.truc;
    let canTruc = true;
    if (tr?.state === 'accepted') {
      if (tr.responder !== seat) canTruc = false;
      else if (Number(tr.acceptedLevel||2)+1 > 4) canTruc = false;
    } else if (tr?.state !== 'none') canTruc = false;
    if (canTruc && nc > 0) mask[5] = 1.0;
  } else if (mode === 'respond_envit' && po?.kind === 'envit') {
    mask[6] = 1.0; mask[7] = 1.0;
    if (po.level === 2) { mask[8] = 1.0; mask[9] = 1.0; }
    if (po.level === 4) mask[9] = 1.0;
  } else if (mode === 'respond_truc' && po?.kind === 'truc') {
    mask[10] = 1.0; mask[11] = 1.0;
    if (po.level === 2) mask[12] = 1.0;
    if (po.level === 3) mask[13] = 1.0;
    if (h.envitAvailable && h.envit?.state === 'none') {
      mask[3] = 1.0; mask[4] = 1.0;
    }
  }
  return mask;
}

// ── ESTADO DEL BOT ────────────────────────────────────────────
let _ortSession = null;
let _botActive = false;
let _botWasBluffingTruc = false;

export async function initBot() {
  try {
    _ortSession = await ort.InferenceSession.create('./Media/truc_bot.onnx');
    console.log('Bot ONNX cargado OK');
  } catch(e) {
    console.error('Error cargando bot ONNX:', e);
  }
}

export function setBotActive(active) { _botActive = active; }
export function isBotActive() { return _botActive; }

export async function botAct(state) {
  if (!_botActive) return null;
  if (state?.hand?.turn !== BOT_SEAT) return null;

  const h = state.hand;
  const myCards = fromHObj(h.hands?.[K(BOT_SEAT)]);
  const mask = buildActionMask(state, BOT_SEAT);
  const legal = Array.from(mask).map((v,i) => v>0?i:-1).filter(i=>i>=0);
  if (!legal.length) return null;

  // ── Intentar decisión heurística ──────────────────────────
  const heuristicIdx = decideAction(state, myCards, null, legal);
  if (heuristicIdx !== null && legal.includes(heuristicIdx)) {
    return ALL_ACTIONS[heuristicIdx];
  }

  // ── Fallback: RL ──────────────────────────────────────────
  if (!_ortSession) {
    const ri = legal[Math.floor(Math.random() * legal.length)];
    return ALL_ACTIONS[ri];
  }
  try {
    const obs = buildObservation(state, BOT_SEAT);
    const tensor = new ort.Tensor('float32', obs, [1, OBS_SIZE]);
    const result = await _ortSession.run({ obs: tensor });
    const qvals = Array.from(result.q_values.data);
    let bestIdx = legal[0];
    let bestQ = -Infinity;
    for (const i of legal) {
      if (qvals[i] > bestQ) { bestQ = qvals[i]; bestIdx = i; }
    }
    return ALL_ACTIONS[bestIdx];
  } catch(e) {
    console.error('botAct RL error:', e);
    const ri = legal[Math.floor(Math.random() * legal.length)];
    return ALL_ACTIONS[ri];
  }
}
