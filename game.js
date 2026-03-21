// ─── Truc Valenciano · game.js ─────────────────────────────────────────────
import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, get, set, remove, onValue, runTransaction }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey:            "AIzaSyBHQ3hSWToVKzADI9eUlCNONbi_lN_TTAI",
  authDomain:        "trucvalencia-12345.firebaseapp.com",
  databaseURL:       "https://trucvalencia-12345-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "trucvalencia-12345",
  storageBucket:     "trucvalencia-12345.firebasestorage.app",
  messagingSenderId: "922530958932",
  appId:             "1:922530958932:web:84fe1d9386f5ea2d6f67c1"
};

initializeApp(firebaseConfig);
const db = getDatabase();

// ─── localStorage keys ───────────────────────────────────────────────────────
const LS = { room: 'truc_room', seat: 'truc_seat', name: 'truc_name' };

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  nameInput:         $('nameInput'),
  roomInput:         $('roomInput'),
  createBtn:         $('createBtn'),
  joinBtn:           $('joinBtn'),
  dealBtn:           $('dealBtn'),
  leaveBtn:          $('leaveBtn'),
  debugReveal:       $('debugReveal'),
  lobbyMsg:          $('lobbyMsg'),
  gameCard:          $('gameCard'),
  roomBadge:         $('roomBadge'),
  seatBadge:         $('seatBadge'),
  score0:            $('score0'),
  score1:            $('score1'),
  stateLabel:        $('stateLabel'),
  turnLabel:         $('turnLabel'),
  manoLabel:         $('manoLabel'),
  turnSeatLabel:     $('turnSeatLabel'),
  handLabel:         $('handLabel'),
  player0Name:       $('player0Name'),
  player1Name:       $('player1Name'),
  tableArea:         $('tableArea'),
  handArea:          $('handArea'),
  currentTrickLabel: $('currentTrickLabel'),
  handInfo:          $('handInfo'),
  offerInfo:         $('offerInfo'),
  actionHelp:        $('actionHelp'),
  envitBtn:          $('envitBtn'),
  trucBtn:           $('trucBtn'),
  mazoBtn:           $('mazoBtn'),
  responseButtons:   $('responseButtons'),
  trickWinsLabel:    $('trickWinsLabel'),
  historyArea:       $('historyArea'),
  logArea:           $('logArea'),
  hiddenHandNotice:  $('hiddenHandNotice')
};

// Inject countdown overlay into body
document.body.insertAdjacentHTML('beforeend', `
  <div id="countdownOverlay" class="hidden">
    <div id="countdownNum">5</div>
    <div id="countdownLabel">Nueva mano en…</div>
  </div>
`);
const countdownOverlay = $('countdownOverlay');
const countdownNum     = $('countdownNum');

// ─── Session state ────────────────────────────────────────────────────────────
let roomRef     = null;
let roomCode    = null;
let mySeat      = null;
let unsubscribe = null;
let countdownTimer = null;   // para no lanzar múltiples cuentas atrás
let lastHandStatus = null;   // detectar transición a 'waiting'

// ─── SVG de palos españoles ───────────────────────────────────────────────────
// Dibujados como path inline, sin dependencias externas
const SUIT_SVG = {
  oros: `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Moneda/Denario: círculo con estrella interior -->
    <circle cx="20" cy="20" r="16" stroke="currentColor" stroke-width="2.5" fill="rgba(176,125,16,.12)"/>
    <circle cx="20" cy="20" r="10" stroke="currentColor" stroke-width="1.5" fill="rgba(176,125,16,.2)"/>
    <circle cx="20" cy="20" r="4"  fill="currentColor"/>
  </svg>`,

  copas: `<svg viewBox="0 0 40 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Copa tipo graal -->
    <path d="M11 6 Q11 18 20 20 Q29 18 29 6 Z" stroke="currentColor" stroke-width="2" fill="rgba(181,42,42,.12)" stroke-linejoin="round"/>
    <path d="M14 20 Q14 26 17 28 L17 34 M23 28 Q26 26 26 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M13 34 L27 34" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M16 6 Q18 10 20 6 Q22 10 24 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
  </svg>`,

  espadas: `<svg viewBox="0 0 40 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Espada recta con guarda -->
    <path d="M20 4 L20 36" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M20 4 L14 18 L20 15 L26 18 Z" fill="currentColor" opacity=".85"/>
    <path d="M10 28 L30 28" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M18 36 L22 36 L21 40 L19 40 Z" fill="currentColor"/>
  </svg>`,

  bastos: `<svg viewBox="0 0 40 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Palo nudoso -->
    <path d="M15 38 Q13 28 16 20 Q12 16 14 10 Q18 8 20 12 Q22 8 26 10 Q28 16 24 20 Q27 28 25 38 Z"
          stroke="currentColor" stroke-width="2" fill="rgba(42,92,23,.12)" stroke-linejoin="round"/>
    <circle cx="14" cy="10" r="3.5" fill="currentColor" opacity=".7"/>
    <circle cx="26" cy="10" r="3.5" fill="currentColor" opacity=".7"/>
    <circle cx="20" cy="7"  r="3"   fill="currentColor" opacity=".85"/>
  </svg>`
};

// ─── Card data ────────────────────────────────────────────────────────────────
const SUITS = {
  oros:    { label: 'oros',    cls: 'suit-oros'    },
  copas:   { label: 'copas',   cls: 'suit-copas'   },
  espadas: { label: 'espadas', cls: 'suit-espadas' },
  bastos:  { label: 'bastos',  cls: 'suit-bastos'  }
};
const SUIT_ORDER = ['oros', 'copas', 'espadas', 'bastos'];

const TRICK_ORDER_GROUPS = [
  ['1_espadas'], ['1_bastos'], ['7_espadas'], ['7_oros'],
  ['3_oros','3_copas','3_espadas','3_bastos'],
  ['2_oros','2_copas','2_espadas','2_bastos'],
  ['1_oros','1_copas'],
  ['12_oros','12_copas','12_espadas','12_bastos'],
  ['11_oros','11_copas','11_espadas','11_bastos'],
  ['10_oros','10_copas','10_espadas','10_bastos'],
  ['7_copas','7_bastos'],
  ['6_oros','6_copas','6_espadas','6_bastos'],
  ['5_oros','5_copas','5_espadas','5_bastos'],
  ['4_oros','4_copas','4_espadas','4_bastos']
];
const TRICK_RANK = (() => {
  const map = {};
  let score = 100;
  for (const group of TRICK_ORDER_GROUPS) {
    for (const card of group) map[card] = score;
    score -= 10;
  }
  return map;
})();

// ─── Pure helpers ─────────────────────────────────────────────────────────────
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid   = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36);

function sanitizeRoomCode(s) {
  return String(s||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
}
function normalizeName(s) {
  return String(s||'').trim().slice(0,24) || 'Invitado';
}
function getOtherSeat(seat) { return seat === 0 ? 1 : 0; }

function parseCard(card) {
  const [num, suit] = String(card).split('_');
  return { num: Number(num), suit };
}
function cardLabel(card) {
  const { num, suit } = parseCard(card);
  return `${num} de ${SUITS[suit].label}`;
}
function trickRank(card)  { return TRICK_RANK[card] ?? 0; }
function compareTrick(a,b){ const d = trickRank(a)-trickRank(b); return d>0?1:d<0?-1:0; }

function envitVal(card) { const n = parseCard(card).num; return n>=10?0:n; }
function bestEnvit(cards) {
  if (!cards||cards.length!==3) return 0;
  let best = 0;
  for (let i=0;i<3;i++) for (let j=i+1;j<3;j++) {
    const a=parseCard(cards[i]), b=parseCard(cards[j]);
    if (a.suit===b.suit) { const v=20+envitVal(cards[i])+envitVal(cards[j]); if(v>best) best=v; }
  }
  return best>0 ? best : Math.max(...cards.map(envitVal));
}
function playerName(state, seat) { return state?.players?.[seat]?.name || `Jugador ${seat}`; }

function pushLog(state, text) {
  state.logs = state.logs||[];
  state.logs.unshift({text, at: Date.now()});
  state.logs = state.logs.slice(0,25);
}
function describeOffer(offer) {
  if (!offer) return 'Sin apuesta activa';
  const by=`Jugador ${offer.by}`, to=`Jugador ${offer.to}`;
  if (offer.kind==='envit') return offer.level==='falta'?`Envit de falta (${by}→${to})`:`Envit ${offer.level} (${by}→${to})`;
  return `Truc ${offer.level} (${by}→${to})`;
}

// ─── LocalStorage ─────────────────────────────────────────────────────────────
function loadLocalDefaults() {
  const n=localStorage.getItem(LS.name), r=localStorage.getItem(LS.room), s=localStorage.getItem(LS.seat);
  if (n) els.nameInput.value = n;
  if (r) els.roomInput.value = r;
  if (s!==null) mySeat = Number(s);
}
function saveSession(name, code, seat) {
  localStorage.setItem(LS.name, name||'');
  localStorage.setItem(LS.room, code||'');
  localStorage.setItem(LS.seat, String(seat));
}

// ─── Default state ────────────────────────────────────────────────────────────
function defaultState() {
  return {
    version:1, status:'waiting', roomCode:'',
    players:{0:null,1:null}, scores:{0:0,1:0},
    handNumber:0, mano:0, turn:0, hand:null, logs:[], winner:null
  };
}

// ─── Deck ─────────────────────────────────────────────────────────────────────
function buildDeck() {
  const cards=[]; const nums=[1,2,3,4,5,6,7,10,11,12];
  for (const suit of SUIT_ORDER) for (const n of nums) cards.push(`${n}_${suit}`);
  return cards;
}
function shuffle(arr) {
  for (let i=arr.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}

// ─── Hand factory ─────────────────────────────────────────────────────────────
function makeHand(mano) {
  const deck = shuffle(buildDeck());
  return {
    status:'in_progress', mano, turn:mano, mode:'normal',
    envitAvailable:true, pendingOffer:null, resume:null,
    hands:{ 0:deck.slice(0,3), 1:deck.slice(3,6) },
    currentTrick:{ cards:{}, lead:mano, playedBy:[] },
    trickIndex:0, trickWins:{0:0,1:0}, trickHistory:[],
    scoreAwards:{0:0,1:0},
    envit:{ state:'none', caller:null, responder:null, acceptedLevel:0, acceptedBy:null },
    truc: { state:'none', caller:null, responder:null, acceptedLevel:0, acceptedBy:null }
  };
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function determineHandWinner(state) {
  const hand=state.hand, wins=hand.trickWins||{0:0,1:0};
  if (wins[0]>=2) return 0;
  if (wins[1]>=2) return 1;
  const hist=hand.trickHistory||[];
  if (hist.length<3) return state.mano;
  const r1=hist[0]?.winner??null, r2=hist[1]?.winner??null, r3=hist[2]?.winner??null;
  if (r1===null&&r2===null&&r3===null) return state.mano;
  if (r1===null) return r2!==null?r2:r3!==null?r3:state.mano;
  return r1;
}

function applyHandEnd(state, reasonText) {
  const hand=state.hand; if (!hand) return;

  const maybeFinish=()=>{
    if (state.scores[0]>=12||state.scores[1]>=12) {
      const w=state.scores[0]>state.scores[1]?0:state.scores[1]>state.scores[0]?1:state.mano;
      state.status='game_over'; state.winner=w; state.hand=null; return true;
    }
    return false;
  };

  if (hand.envit.state==='accepted') {
    const v0=bestEnvit(hand.hands[0]), v1=bestEnvit(hand.hands[1]);
    const ew=v0>v1?0:v1>v0?1:state.mano;
    const ep=hand.envit.acceptedLevel==='falta'?12-Math.max(state.scores[0],state.scores[1]):Number(hand.envit.acceptedLevel||0);
    state.scores[ew]+=ep;
    pushLog(state,`Envit: gana Jugador ${ew} (+${ep}).`);
    if (maybeFinish()) return;
  }
  for (const s of [0,1]) state.scores[s]+=Number(hand.scoreAwards?.[s]||0);
  if (maybeFinish()) return;

  if (hand.truc.state==='accepted') {
    const tw=determineHandWinner(state), tp=Number(hand.truc.acceptedLevel||0);
    state.scores[tw]+=tp;
    pushLog(state,`Truc: gana Jugador ${tw} (+${tp}).`);
    if (maybeFinish()) return;
  }
  if (reasonText) pushLog(state,reasonText);
  pushLog(state,`Marcador: ${state.scores[0]}–${state.scores[1]}`);

  state.mano=getOtherSeat(state.mano);
  state.turn=state.mano;
  state.status='waiting';
  state.hand=null;
  state.handNumber=Number(state.handNumber||0)+1;
}

function resolveTrick(state) {
  const hand=state.hand, cards=hand.currentTrick.cards;
  const cmp=compareTrick(cards[0],cards[1]);
  const winner=cmp>0?0:cmp<0?1:null;
  hand.trickHistory.push({ index:hand.trickIndex+1, cards:clone(cards), winner, lead:hand.currentTrick.lead });
  if (winner!==null) { hand.trickWins[winner]+=1; hand.turn=winner; pushLog(state,`Baza ${hand.trickIndex+1}: gana Jugador ${winner}.`); }
  else               { hand.turn=hand.currentTrick.lead; pushLog(state,`Baza ${hand.trickIndex+1}: parda.`); }
  hand.currentTrick={ cards:{}, lead:hand.turn, playedBy:[] };
  hand.trickIndex+=1; hand.mode='normal';
  if (hand.trickWins[0]>=2||hand.trickWins[1]>=2||hand.trickIndex>=3) {
    applyHandEnd(state,`La mano la gana Jugador ${determineHandWinner(state)}.`);
  }
}

function resumeAfterOffer(state) {
  const hand=state.hand, resume=hand.resume;
  hand.pendingOffer=null; hand.envitAvailable=false;
  if (resume) { hand.mode=resume.mode; hand.turn=resume.turn; } else { hand.mode='normal'; }
  hand.resume=null;
}

// ─── Firebase transaction wrapper ─────────────────────────────────────────────
async function mutateRoom(mutator) {
  if (!roomRef) throw new Error('No hay sala abierta.');
  return runTransaction(roomRef,(current)=>{
    if (!current) return current;
    const next=clone(current);
    if (!next.state) next.state=defaultState();
    const ok=mutator(next.state);
    if (ok===false) return;
    return next;
  },{applyLocally:false});
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function dealHand() {
  await mutateRoom((state)=>{
    if (!state.players?.[0]||!state.players?.[1]) return false;
    if (state.status==='game_over') return false;
    if (state.hand&&state.hand.status==='in_progress') return false;
    state.hand=makeHand(state.mano);
    state.status='playing';
    pushLog(state,`Nueva mano #${state.handNumber+1}. Mano: Jugador ${state.mano}.`);
    return true;
  });
}

// FIX: playCard recibe el valor de la carta directamente; la transacción lo valida.
async function playCard(card) {
  await mutateRoom((state)=>{
    const hand=state.hand;
    if (!hand||state.status!=='playing'||hand.status!=='in_progress') return false;
    if (hand.turn!==mySeat||hand.mode!=='normal'||hand.pendingOffer) return false;
    const myCards=hand.hands?.[mySeat]||[];
    if (!myCards.includes(card)) return false;

    hand.hands[mySeat]=myCards.filter(c=>c!==card);
    hand.currentTrick.cards[mySeat]=card;
    hand.currentTrick.playedBy.push(mySeat);
    hand.envitAvailable=false;
    pushLog(state,`Jugador ${mySeat} juega ${cardLabel(card)}.`);

    const other=getOtherSeat(mySeat);
    if (!hand.currentTrick.cards[other]) {
      hand.turn=other;
      hand.envitAvailable=true;
      return true;
    }
    resolveTrick(state);
    return true;
  });
}

async function goMazo() {
  await mutateRoom((state)=>{
    const hand=state.hand;
    if (!hand||state.status!=='playing'||hand.status!=='in_progress') return false;
    if (hand.turn!==mySeat||hand.mode!=='normal'||hand.pendingOffer) return false;
    if (hand.trickIndex!==0||Object.keys(hand.currentTrick.cards||{}).length!==0) return false;
    const w=getOtherSeat(mySeat);
    hand.scoreAwards[w]+=1;
    pushLog(state,`Jugador ${mySeat} se va al mazo. +1 para Jugador ${w}.`);
    applyHandEnd(state,'Mazo.');
    return true;
  });
}

async function startOffer(kind) {
  await mutateRoom((state)=>{
    const hand=state.hand;
    if (!hand||state.status!=='playing'||hand.status!=='in_progress') return false;
    if (hand.turn!==mySeat||hand.pendingOffer) return false;
    if (kind==='envit') {
      if (!(hand.mode==='normal'||hand.mode==='respond_truc')) return false;
      if (!hand.envitAvailable) return false;
      hand.resume={mode:hand.mode,turn:hand.turn};
      hand.pendingOffer={kind:'envit',level:2,by:mySeat,to:getOtherSeat(mySeat)};
      hand.mode='respond_envit'; hand.turn=getOtherSeat(mySeat);
      pushLog(state,`Jugador ${mySeat} canta envit.`);
      return true;
    }
    if (kind==='truc') {
      if (hand.mode!=='normal') return false;
      hand.resume={mode:hand.mode,turn:hand.turn};
      hand.pendingOffer={kind:'truc',level:2,by:mySeat,to:getOtherSeat(mySeat)};
      hand.mode='respond_truc'; hand.turn=getOtherSeat(mySeat);
      hand.envitAvailable=true;
      pushLog(state,`Jugador ${mySeat} canta truc.`);
      return true;
    }
    return false;
  });
}

async function respondEnvit(choice) {
  await mutateRoom((state)=>{
    const hand=state.hand, offer=hand?.pendingOffer;
    if (!hand||state.status!=='playing'||hand.status!=='in_progress') return false;
    if (!offer||offer.kind!=='envit'||hand.turn!==mySeat||hand.mode!=='respond_envit') return false;
    const caller=offer.by, responder=offer.to;
    if (choice==='vull') {
      hand.envit={state:'accepted',caller,responder,acceptedLevel:offer.level,acceptedBy:mySeat};
      hand.envitAvailable=false;
      pushLog(state,`Envit aceptado (${offer.level==='falta'?'falta':offer.level}).`);
      resumeAfterOffer(state); return true;
    }
    if (choice==='no_vull') {
      hand.envit={state:'rejected',caller,responder,acceptedLevel:0,acceptedBy:null};
      hand.scoreAwards[caller]+=1; hand.envitAvailable=false;
      pushLog(state,`Envit rechazado. +1 para Jugador ${caller}.`);
      resumeAfterOffer(state); return true;
    }
    if (choice==='torne') {
      if (offer.level!==2) return false;
      hand.pendingOffer={kind:'envit',level:4,by:responder,to:caller};
      hand.turn=caller; hand.mode='respond_envit'; hand.envitAvailable=false;
      pushLog(state,'Torne a envit 4.'); return true;
    }
    if (choice==='falta') {
      hand.pendingOffer={kind:'envit',level:'falta',by:responder,to:caller};
      hand.turn=caller; hand.mode='respond_envit'; hand.envitAvailable=false;
      pushLog(state,'Envit de falta.'); return true;
    }
    return false;
  });
}

async function respondTruc(choice) {
  await mutateRoom((state)=>{
    const hand=state.hand, offer=hand?.pendingOffer;
    if (!hand||state.status!=='playing'||hand.status!=='in_progress') return false;
    if (!offer||offer.kind!=='truc'||hand.turn!==mySeat||hand.mode!=='respond_truc') return false;
    const caller=offer.by, responder=offer.to;
    if (choice==='vull') {
      hand.truc={state:'accepted',caller,responder,acceptedLevel:offer.level,acceptedBy:mySeat};
      hand.envitAvailable=false;
      pushLog(state,`Truc aceptado (${offer.level}).`);
      resumeAfterOffer(state); return true;
    }
    if (choice==='no_vull') {
      hand.truc={state:'rejected',caller,responder,acceptedLevel:0,acceptedBy:null};
      hand.scoreAwards[caller]+=1; hand.envitAvailable=false;
      pushLog(state,`Truc rechazado. +1 para Jugador ${caller}. Mano terminada.`);
      applyHandEnd(state,'No vull al truc.'); return true;
    }
    if (choice==='retruque') {
      if (offer.level!==2) return false;
      hand.pendingOffer={kind:'truc',level:3,by:responder,to:caller};
      hand.turn=caller; hand.mode='respond_truc'; hand.envitAvailable=true;
      pushLog(state,'Retruque a 3.'); return true;
    }
    if (choice==='val4') {
      if (offer.level!==2&&offer.level!==3) return false;
      hand.pendingOffer={kind:'truc',level:4,by:responder,to:caller};
      hand.turn=caller; hand.mode='respond_truc'; hand.envitAvailable=true;
      pushLog(state,'Val 4 al truc.'); return true;
    }
    return false;
  });
}

// ─── Countdown + auto-deal ────────────────────────────────────────────────────
function startCountdown() {
  if (countdownTimer!==null) return; // ya en marcha
  let n=5;
  countdownOverlay.classList.remove('hidden');
  countdownNum.textContent=n;

  countdownTimer=setInterval(async ()=>{
    n--;
    if (n>0) {
      countdownNum.textContent=n;
      countdownNum.classList.add('tick');
      setTimeout(()=>countdownNum.classList.remove('tick'),150);
    } else {
      clearInterval(countdownTimer);
      countdownTimer=null;
      countdownOverlay.classList.add('hidden');
      // Solo el host (seat 0) ejecuta el deal para evitar doble disparo
      if (mySeat===0) await dealHand();
    }
  },1000);
}

function cancelCountdown() {
  if (countdownTimer!==null) { clearInterval(countdownTimer); countdownTimer=null; }
  countdownOverlay.classList.add('hidden');
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setMessage(text, kind='') {
  els.lobbyMsg.className=`msg${kind?` ${kind}`:''}`;
  els.lobbyMsg.textContent=text;
}
function canLocalAct(state) {
  const h=state?.hand;
  return h?.status==='in_progress'&&state?.status==='playing'&&h.turn===mySeat;
}
function canShowEnvit(state) {
  const h=state?.hand;
  if (!canLocalAct(state)||!h.envitAvailable||h.pendingOffer) return false;
  return h.mode==='normal'||h.mode==='respond_truc';
}
function canShowTruc(state) {
  const h=state?.hand;
  return canLocalAct(state)&&h.mode==='normal'&&!h.pendingOffer;
}
function canShowMazo(state) {
  const h=state?.hand;
  return canLocalAct(state)&&h.mode==='normal'&&!h.pendingOffer
    &&h.trickIndex===0&&Object.keys(h.currentTrick?.cards||{}).length===0;
}
function updateAccess(state) {
  const isOver=state?.status==='game_over';
  const h=state?.hand;
  const canDeal=!isOver&&(!h||h.status!=='in_progress')&&state?.players?.[0]&&state?.players?.[1]&&mySeat===0;
  els.dealBtn.disabled  = !canDeal;
  els.envitBtn.disabled = !canShowEnvit(state);
  els.trucBtn.disabled  = !canShowTruc(state);
  els.mazoBtn.disabled  = !canShowMazo(state);
}

// ─── Render helpers ───────────────────────────────────────────────────────────

// Crea el SVG de palo a tamaño dado
function suitSvgEl(suit, sizePx) {
  const wrap=document.createElement('span');
  wrap.innerHTML=SUIT_SVG[suit]||'';
  const svg=wrap.firstElementChild;
  if (svg) { svg.style.width=sizePx+'px'; svg.style.height=sizePx+'px'; }
  return wrap;
}

function createCardEl(card, visible, ownerLabel) {
  const el=document.createElement('div');
  if (!visible) {
    el.className='card-back';
    el.innerHTML=`<div class="card-back-label">${ownerLabel}</div>`;
    return el;
  }
  const {num, suit}=parseCard(card);
  el.className=`playing-card ${SUITS[suit].cls}`;

  // Top row: número + icono pequeño
  const top=document.createElement('div'); top.className='card-top';
  const rankEl=document.createElement('span'); rankEl.className='rank'; rankEl.textContent=num;
  top.appendChild(rankEl);
  top.appendChild(suitSvgEl(suit,14).firstElementChild||document.createElement('span'));

  // Centro: icono grande
  const center=document.createElement('div'); center.className='suit-center';
  const bigSvg=suitSvgEl(suit,36).firstElementChild;
  if (bigSvg) center.appendChild(bigSvg);

  // Bottom: igual que top pero invertido (CSS rotate)
  const bottom=document.createElement('div'); bottom.className='card-bottom';
  const rankB=document.createElement('span'); rankB.className='rank'; rankB.textContent=num;
  bottom.appendChild(rankB);
  const miniB=suitSvgEl(suit,14).firstElementChild;
  if (miniB) bottom.appendChild(miniB);

  // Owner label
  const owner=document.createElement('div'); owner.className='owner-label'; owner.textContent=ownerLabel;

  el.appendChild(top);
  el.appendChild(center);
  el.appendChild(bottom);
  el.appendChild(owner);
  return el;
}

function renderTable(state) {
  const hand=state.hand;
  els.tableArea.innerHTML='';
  if (!hand) { els.tableArea.innerHTML='<div class="compact">Todavía no hay mano.</div>'; return; }
  const cards=hand.currentTrick?.cards||{};
  [0,1].forEach(seat=>{
    const card=cards[seat];
    if (!card) {
      const empty=document.createElement('div');
      empty.className='playing-card';
      empty.style.opacity='.3';
      empty.innerHTML=`<div class="owner-label" style="font-size:11px;color:#999">Jugador ${seat}</div><div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:28px;opacity:.2">—</div>`;
      els.tableArea.appendChild(empty);
      return;
    }
    // Siempre visible en la mesa (ya se jugó)
    els.tableArea.appendChild(createCardEl(card,true,`Jugador ${seat}`));
  });
  if (hand.trickHistory?.length) {
    const last=hand.trickHistory[hand.trickHistory.length-1];
    const footer=document.createElement('div');
    footer.className='compact'; footer.style.marginTop='10px';
    footer.textContent=last.winner===null?'Parda en la última baza':`Última baza → Jugador ${last.winner}`;
    els.tableArea.appendChild(footer);
  }
}

function renderHand(state) {
  const hand=state.hand;
  els.handArea.innerHTML='';
  if (!hand) { els.handArea.innerHTML='<div class="compact">No hay mano en curso.</div>'; els.handInfo.textContent='—'; return; }
  const myCards=hand.hands?.[mySeat]||[];
  els.handInfo.textContent=hand.mode==='respond_truc'?'Responde al truc antes de jugar'
    :hand.mode==='respond_envit'?'Responde al envit'
    :canLocalAct(state)?'Tu turno — elige carta o acción':'Esperando al rival…';

  if (!myCards.length) { els.handArea.innerHTML='<div class="compact">Sin cartas.</div>'; return; }

  // FIX: Capture card value in closure using const inside forEach
  myCards.forEach((card, idx) => {
    const cardEl = createCardEl(card, true, 'Tu carta');
    cardEl.classList.add('deal-anim');
    // Solo clickable en modo normal, es tu turno, y no hay oferta pendiente
    const isPlayable = canLocalAct(state) && hand.mode === 'normal' && !hand.pendingOffer;
    if (isPlayable) {
      cardEl.classList.add('clickable');
      // FIX CRÍTICO: usar una IIFE o const para capturar el valor exacto de card
      const cardValue = card; // captura por valor en este scope
      cardEl.addEventListener('click', () => {
        playCard(cardValue);
      });
    }
    els.handArea.appendChild(cardEl);
  });
}

function renderHistory(state) {
  const hand=state.hand;
  els.historyArea.innerHTML='';
  if (!hand?.trickHistory?.length) { els.historyArea.innerHTML='<div class="compact">Sin bazas resueltas todavía.</div>'; return; }
  hand.trickHistory.forEach((trick,idx)=>{
    const box=document.createElement('div');
    box.className='playing-card'; box.style.width='150px';
    box.innerHTML=`
      <div class="owner-label">Baza ${idx+1}</div>
      <div class="rank" style="font-size:16px;margin:6px 0;">${trick.winner===null?'Parda':`Gana J${trick.winner}`}</div>
      <div class="owner-label">J0: ${trick.cards[0]?cardLabel(trick.cards[0]):'—'}</div>
      <div class="owner-label">J1: ${trick.cards[1]?cardLabel(trick.cards[1]):'—'}</div>
    `;
    els.historyArea.appendChild(box);
  });
}

function renderLog(state) {
  const logs=state.logs||[];
  els.logArea.innerHTML='';
  if (!logs.length) { els.logArea.innerHTML='<div class="compact">Sin movimientos todavía.</div>'; return; }
  logs.slice(0,12).forEach(item=>{
    const div=document.createElement('div'); div.className='logitem'; div.textContent=item.text;
    els.logArea.appendChild(div);
  });
}

function renderResponseButtons(state) {
  const hand=state.hand;
  els.responseButtons.innerHTML='';
  if (!hand?.pendingOffer||hand.turn!==mySeat) { els.responseButtons.classList.add('hidden'); return; }
  els.responseButtons.classList.remove('hidden');
  const addBtn=(txt,cls,fn)=>{
    const b=document.createElement('button'); b.textContent=txt;
    if(cls) b.className=cls; b.addEventListener('click',fn);
    els.responseButtons.appendChild(b);
  };
  if (hand.pendingOffer.kind==='envit') {
    addBtn('Vull','good',()=>respondEnvit('vull'));
    addBtn('No vull','bad',()=>respondEnvit('no_vull'));
    if (hand.pendingOffer.level===2) { addBtn('Torne','warn',()=>respondEnvit('torne')); addBtn('Falta','warn',()=>respondEnvit('falta')); }
    else if (hand.pendingOffer.level===4) { addBtn('Falta','warn',()=>respondEnvit('falta')); }
  } else if (hand.pendingOffer.kind==='truc') {
    if (hand.envitAvailable) addBtn('Envidar','good',()=>startOffer('envit'));
    addBtn('Vull','good',()=>respondTruc('vull'));
    addBtn('No vull','bad',()=>respondTruc('no_vull'));
    if (hand.pendingOffer.level===2) addBtn('Retruque','warn',()=>respondTruc('retruque'));
    if (hand.pendingOffer.level===2||hand.pendingOffer.level===3) addBtn('Val 4','warn',()=>respondTruc('val4'));
  }
}

function renderActionHelp(state) {
  const hand=state.hand;
  if (!hand) { els.actionHelp.textContent='Crea o entra en una sala para empezar.'; return; }
  if (state.status==='game_over') { els.actionHelp.textContent=`Partida terminada. Gana Jugador ${state.winner} (${playerName(state,state.winner)}).`; return; }
  if (hand.pendingOffer) { els.actionHelp.textContent=hand.pendingOffer.kind==='envit'?'Envit pendiente — resuélvelo antes de seguir.':'Truc pendiente — resuélvelo antes de seguir.'; return; }
  if (hand.mode==='normal') {
    els.actionHelp.textContent=mySeat===hand.turn?'Tu turno: juega una carta, envida, truca o vete al mazo (solo al inicio).':`Turno de ${playerName(state,hand.turn)}.`;
  } else if (hand.mode==='respond_truc') {
    els.actionHelp.textContent='Responde al truc. Puedes envidar antes si quieres.';
  } else if (hand.mode==='respond_envit') {
    els.actionHelp.textContent='Responde al envit.';
  }
}

// ─── Main render ──────────────────────────────────────────────────────────────
function renderRoom(room) {
  const state=room?.state||defaultState();
  const hand=state.hand;

  els.roomBadge.textContent  =`Sala: ${state.roomCode||roomCode||'—'}`;
  els.seatBadge.textContent  =`Jugador: ${mySeat===null?'—':mySeat}`;
  els.player0Name.textContent= state.players?.[0]?.name||'—';
  els.player1Name.textContent= state.players?.[1]?.name||'—';
  els.score0.textContent     = String(state.scores?.[0]??0);
  els.score1.textContent     = String(state.scores?.[1]??0);
  els.handLabel.textContent  = String(state.handNumber??0);
  els.manoLabel.textContent  = state.status==='game_over'?'—':`Jugador ${state.mano}${state.mano===mySeat?' (tú)':''}`;
  els.turnSeatLabel.textContent=hand?.turn!==undefined?`Jugador ${hand.turn}`:'—';
  els.stateLabel.textContent = state.status==='waiting'?'Esperando':state.status==='playing'?'Mano en curso':state.status==='game_over'?'Partida terminada':'—';
  els.turnLabel.textContent  = hand?`Turno de ${playerName(state,hand.turn)}`:'—';
  els.currentTrickLabel.textContent=hand?`Baza ${Math.min((hand.trickIndex||0)+1,3)} de 3`:'—';
  els.trickWinsLabel.textContent   =hand?`${hand.trickWins[0]} - ${hand.trickWins[1]}`:'—';
  els.offerInfo.textContent        =hand?.pendingOffer?describeOffer(hand.pendingOffer):'Sin apuesta activa';
  els.hiddenHandNotice.classList.toggle('hidden',!els.debugReveal.checked);
  if (els.debugReveal.checked) els.hiddenHandNotice.textContent='Modo prueba activo: manos visibles.';

  // ── Countdown automático entre manos ──
  // Cuando el estado pasa a 'waiting' y hay dos jugadores listos → cuenta atrás
  const newHandStatus=`${state.status}-${state.handNumber}`;
  if (state.status==='waiting'&&state.players?.[0]&&state.players?.[1]&&state.status!=='game_over') {
    if (lastHandStatus!==null && lastHandStatus!==newHandStatus) {
      startCountdown();
    }
  } else {
    // Si hay mano en curso o partida terminada, cancelamos cualquier cuenta atrás activa
    cancelCountdown();
  }
  lastHandStatus=newHandStatus;

  renderTable(state);
  renderHand(state);
  renderHistory(state);
  renderLog(state);
  renderActionHelp(state);
  renderResponseButtons(state);
  updateAccess(state);

  if (state.status==='waiting') {
    setMessage(state.players?.[0]&&state.players?.[1]?'Dos jugadores listos.':'Esperando al segundo jugador…');
  } else if (state.status==='game_over') {
    setMessage(`Partida terminada. Gana Jugador ${state.winner} (${playerName(state,state.winner)}).`,'good');
  }
}

// ─── Room management ──────────────────────────────────────────────────────────
function startSession(code) {
  roomCode=code;
  roomRef=ref(db,`rooms/${code}`);
  if (unsubscribe) unsubscribe();
  unsubscribe=onValue(roomRef,(snap)=>renderRoom(snap.val()));
  els.gameCard.classList.remove('hidden');
  els.dealBtn.classList.remove('hidden');
  els.leaveBtn.classList.remove('hidden');
  els.roomBadge.textContent=`Sala: ${code}`;
  els.seatBadge.textContent=`Jugador: ${mySeat===null?'—':mySeat}`;
}

async function createRoom() {
  const name=normalizeName(els.nameInput.value);
  const code=sanitizeRoomCode(els.roomInput.value)||Math.random().toString(36).slice(2,6).toUpperCase();
  const r=ref(db,`rooms/${code}`);
  const existing=await get(r);
  if (existing.exists()) { setMessage('Esa sala ya existe. Usa Entrar con el código.','bad'); return; }
  const initial=defaultState();
  initial.roomCode=code; initial.players[0]={name,clientId:uid()};
  initial.logs=[{text:`Sala creada por ${name}.`,at:Date.now()}];
  await set(r,{meta:{createdAt:Date.now(),roomCode:code},state:initial});
  mySeat=0; saveSession(name,code,0);
  els.roomInput.value=code;
  setMessage(`Sala creada. Código: ${code}`,'good');
  startSession(code);
}

async function joinRoom() {
  const name=normalizeName(els.nameInput.value);
  const code=sanitizeRoomCode(els.roomInput.value);
  if (!code) { setMessage('Escribe un código de sala.','bad'); return; }
  const r=ref(db,`rooms/${code}`);
  const result=await runTransaction(r,(current)=>{
    if (!current) return current;
    if (!current.state) current.state=defaultState();
    const st=current.state;
    if (st.players?.[0]&&st.players?.[1]) return current;
    if (!st.players[0]) { st.players[0]={name,clientId:uid()}; pushLog(st,`${name} entra como Jugador 0.`); }
    else                { st.players[1]={name,clientId:uid()}; pushLog(st,`${name} entra como Jugador 1.`); }
    return current;
  },{applyLocally:false});

  if (!result.committed) { setMessage('No se pudo entrar. Sala llena o no existe.','bad'); return; }
  const fs=result.snapshot.val()?.state;
  if (!fs) { setMessage('Sala no encontrada.','bad'); return; }
  // Determinar asiento desde el resultado final
  mySeat = (!fs.players?.[0] || fs.players[0].name!==name) ? 1 : 0;
  if (fs.players?.[1]?.name===name && fs.players?.[0]?.name!==name) mySeat=1;
  else if (fs.players?.[0]?.name===name) mySeat=0;
  else mySeat=1;
  saveSession(name,code,mySeat);
  setMessage(`Sala ${code} — eres Jugador ${mySeat}.`,'good');
  startSession(code);
}

async function leaveRoom() {
  if (!roomRef||mySeat===null) { location.reload(); return; }
  cancelCountdown();
  try { await remove(ref(db,`rooms/${roomCode}/state/players/${mySeat}`)); } catch(e){console.error(e);}
  localStorage.removeItem(LS.room); localStorage.removeItem(LS.seat);
  location.reload();
}

// ─── Event listeners ──────────────────────────────────────────────────────────
els.createBtn.addEventListener('click', createRoom);
els.joinBtn.addEventListener('click',   joinRoom);
els.dealBtn.addEventListener('click',   dealHand);
els.leaveBtn.addEventListener('click',  leaveRoom);
els.envitBtn.addEventListener('click',  ()=>startOffer('envit'));
els.trucBtn.addEventListener('click',   ()=>startOffer('truc'));
els.mazoBtn.addEventListener('click',   goMazo);
els.debugReveal.addEventListener('change', async ()=>{
  if (!roomRef) return;
  const snap=await get(roomRef); renderRoom(snap.val());
});

// ─── Restore session ──────────────────────────────────────────────────────────
loadLocalDefaults();
const savedRoom=localStorage.getItem(LS.room);
if (savedRoom) {
  roomCode=sanitizeRoomCode(savedRoom);
  els.roomInput.value=roomCode;
  const savedSeat=localStorage.getItem(LS.seat);
  if (savedSeat!==null) mySeat=Number(savedSeat);
  startSession(roomCode);
  setMessage(`Sala guardada cargada: ${roomCode}.`);
}
