import { session } from './firebase.js';

const BOT_SEAT = 1;
const OBS_SIZE = 85;
const NUM_ACTIONS = 14;
const OFFSET = 10;
const EMPTY_CARD = '~';
const SUITS = ['oros','copas','espadas','bastos'];
const ALL_ACTIONS = [
  ['PLAY_CARD',0],['PLAY_CARD',1],['PLAY_CARD',2],
  ['OFFER','envit'],['OFFER','falta'],['OFFER','truc'],
  ['RESPOND_ENVIT','vull'],['RESPOND_ENVIT','no_vull'],
  ['RESPOND_ENVIT','torne'],['RESPOND_ENVIT','falta'],
  ['RESPOND_TRUC','vull'],['RESPOND_TRUC','no_vull'],
  ['RESPOND_TRUC','retruque'],['RESPOND_TRUC','val4'],
];

const WIN_PTS = 12;
const CARD_DIM = 7;

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

function trank(c) { return TRANK[c] || 0; }
function parseCard(c) { const [n,s] = c.split('_'); return {num:Number(n), suit:s}; }
function evval(c) { const {num} = parseCard(c); return num >= 10 ? 0 : num; }

function encCard(c) {
  if (!c || c === EMPTY_CARD) return new Array(CARD_DIM).fill(0.0);
  const {suit} = parseCard(c);
  return [
    trank(c)/100.0,
    evval(c)/7.0,
    suit==='oros'?1:0,
    suit==='copas'?1:0,
    suit==='espadas'?1:0,
    suit==='bastos'?1:0,
    1.0
  ];
}

const K = n => `_${n}`;
const PK = n => `p${n}`;
const real = n => Number(n||OFFSET) - OFFSET;

function fromHObj(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.filter(c=>c&&c!==EMPTY_CARD);
  return ['a','b','c'].map(k=>obj[k]).filter(c=>c&&c!==EMPTY_CARD);
}

function getPlayed(h, seat) {
  const v = h?.played?.[PK(seat)];
  return (v && v !== EMPTY_CARD) ? v : null;
}

function bestEnvit(cards) {
  if (!cards?.length) return 0;
  let best = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i+1; j < cards.length; j++) {
      const {suit:si} = parseCard(cards[i]);
      const {suit:sj} = parseCard(cards[j]);
      if (si === sj) {
        const v = 20 + evval(cards[i]) + evval(cards[j]);
        if (v > best) best = v;
      }
    }
  }
  return best > 0 ? best : Math.max(0, ...cards.map(evval));
}

function buildObservation(state, seat) {
  const obs = new Float32Array(OBS_SIZE);
  const h = state?.hand;
  if (!h) return obs;
  const opp = 1 - seat;
  let idx = 0;

  // My hand (3 cards padded)
  const myCards = fromHObj(h.hands?.[K(seat)]);
  for (let i = 0; i < 3; i++) {
    const enc = encCard(myCards[i] || null);
    for (const v of enc) obs[idx++] = v;
  }

  // Played this trick
  const encMe = encCard(getPlayed(h, seat));
  const encOpp = encCard(getPlayed(h, opp));
  for (const v of encMe) obs[idx++] = v;
  for (const v of encOpp) obs[idx++] = v;

  // Trick history (up to 2)
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
    } else {
      idx += CARD_DIM*2 + 1;
    }
  }

  // Scores normalized
  obs[idx++] = real(state.scores?.[K(seat)]) / WIN_PTS;
  obs[idx++] = real(state.scores?.[K(opp)]) / WIN_PTS;

  // Am mano
  obs[idx++] = h.mano === seat ? 1.0 : 0.0;

  // Trick index
  obs[idx++] = real(h.trickIndex) / 3.0;

  // Trick wins
  obs[idx++] = real(h.trickWins?.[K(seat)]) / 2.0;
  obs[idx++] = real(h.trickWins?.[K(opp)]) / 2.0;

  // Envit available
  obs[idx++] = h.envitAvailable ? 1.0 : 0.0;

  // Mode one-hot
  const modes = {normal:0, respond_envit:1, respond_truc:2};
  const mi = modes[h.mode] ?? 0;
  obs[idx + mi] = 1.0; idx += 3;

  // Pending offer level
  const po = h.pendingOffer;
  if (po) {
    const lv = po.level;
    obs[idx] = (typeof lv === 'number') ? lv/4.0 : 1.0;
  }
  idx++;

  // Envit state one-hot
  const es = {none:0, accepted:1, rejected:2};
  obs[idx + (es[h.envit?.state] ?? 0)] = 1.0; idx += 3;

  // Envit accepted level
  const al = h.envit?.acceptedLevel;
  obs[idx++] = al === 'falta' ? 1.0 : (al ? al/4.0 : 0.0);

  // Truc state one-hot
  obs[idx + (es[h.truc?.state] ?? 0)] = 1.0; idx += 3;

  // Truc accepted level
  const tl = h.truc?.acceptedLevel;
  obs[idx++] = tl ? tl/4.0 : 0.0;

  // My envit value
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
  const tricksDone = (h.trickHistory || []).length;
  const noTricksPlayed = tricksDone === 0;
  const noTrucAtAll =
    h.truc?.state === 'none' && !(po?.kind === 'truc');

  if (mode === 'normal' && !po) {
    if (!alreadyPlayed) {
      for (let i = 0; i < nc; i++) mask[i] = 1.0;
    }
    if (
      h.envitAvailable &&
      h.envit?.state === 'none' &&
      noTricksPlayed &&
      !alreadyPlayed &&
      noTrucAtAll
    ) {
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
    // Igual que renderActions (canEnvitInTruc): solo en 1a baza i sense carta jugada
    if (
      h.envitAvailable &&
      h.envit?.state === 'none' &&
      noTricksPlayed &&
      !alreadyPlayed
    ) {
      mask[3] = 1.0; mask[4] = 1.0;
    }
  }
  return mask;
}

let _ortSession = null;
let _botActive = false;

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
  if (!_botActive || !_ortSession) return null;
  if (state?.hand?.turn !== BOT_SEAT) return null;

  const obs = buildObservation(state, BOT_SEAT);
  const mask = buildActionMask(state, BOT_SEAT);

  const legal = Array.from(mask).map((v,i)=>v>0?i:-1).filter(i=>i>=0);
  if (!legal.length) return null;

  try {
    const tensor = new ort.Tensor('float32', obs, [1, OBS_SIZE]);
    const result = await _ortSession.run({obs: tensor});
    const qvals = result.q_values.data;

    let bestIdx = legal[0];
    let bestQ = -Infinity;
    for (const i of legal) {
      if (qvals[i] > bestQ) { bestQ = qvals[i]; bestIdx = i; }
    }
    return ALL_ACTIONS[bestIdx];
  } catch(e) {
    console.error('botAct error:', e);
    const ri = legal[Math.floor(Math.random()*legal.length)];
    return ALL_ACTIONS[ri];
  }
}
