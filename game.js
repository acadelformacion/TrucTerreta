// ─── Truc Valenciano · game.js ─────────────────────────────────────────────
// Firebase convierte {0:x, 1:y} en array. Para evitarlo, todas las claves
// de asiento son "_0" y "_1" (con guión bajo). Firebase nunca convierte
// claves que empiezan por letra/guión a array.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, get, set, push, remove, onValue, runTransaction }
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

// ─── Claves de asiento (siempre string con prefijo, nunca numérico) ───────────
const K  = n => `_${n}`;          // seat key:   0 → "_0"
const UK = k => Number(k.slice(1)); // undo key: "_0" → 0
// Manos: array de 3 cartas → objeto {"a":"1_oros","b":"7_espadas","c":"3_copas"}
const HAND_KEYS = ['a','b','c'];
const toHandObj = arr =>
  Object.fromEntries((arr||[]).filter(Boolean).map((c,i)=>[HAND_KEYS[i],c]));
const fromHandObj = obj => {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj.filter(Boolean); // safety fallback
  return HAND_KEYS.map(k=>obj[k]).filter(Boolean);
};

const LS = { room:'truc_room', seat:'truc_seat', name:'truc_name' };
const INACTIVITY_MS = 60*60*1000;
const TURN_SECONDS  = 30;

// ─── Suit SVGs ────────────────────────────────────────────────────────────────
const SUIT_SVG = {
  oros:`<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="2" fill="rgba(176,125,16,.1)"/><circle cx="16" cy="16" r="7" stroke="currentColor" stroke-width="1.5" fill="rgba(176,125,16,.15)"/><circle cx="16" cy="16" r="3" fill="currentColor"/></svg>`,
  copas:`<svg viewBox="0 0 32 36" fill="none"><path d="M8 5 Q8 15 16 17 Q24 15 24 5 Z" stroke="currentColor" stroke-width="1.8" fill="rgba(181,42,42,.1)" stroke-linejoin="round"/><path d="M11 17 Q11 22 13.5 23.5 L13.5 28 M18.5 23.5 Q21 22 21 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10 28 L22 28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  espadas:`<svg viewBox="0 0 32 36" fill="none"><path d="M16 3 L16 30" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 3 L11 14 L16 11 L21 14 Z" fill="currentColor" opacity=".85"/><path d="M8 22 L24 22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 30 L18 30 L17.5 33 L14.5 33 Z" fill="currentColor"/></svg>`,
  bastos:`<svg viewBox="0 0 32 36" fill="none"><path d="M12 32 Q10 23 13 16 Q9 12 11 7 Q15 5 16 9 Q17 5 21 7 Q23 12 19 16 Q22 23 20 32 Z" stroke="currentColor" stroke-width="1.8" fill="rgba(42,92,23,.1)" stroke-linejoin="round"/><circle cx="11" cy="7" r="3" fill="currentColor" opacity=".65"/><circle cx="21" cy="7" r="3" fill="currentColor" opacity=".65"/><circle cx="16" cy="5" r="2.5" fill="currentColor" opacity=".8"/></svg>`
};
const SUITS = {
  oros:{label:'oros',cls:'s-oros'}, copas:{label:'copas',cls:'s-copas'},
  espadas:{label:'espadas',cls:'s-espadas'}, bastos:{label:'bastos',cls:'s-bastos'}
};
const SUIT_ORDER = ['oros','copas','espadas','bastos'];
const TRICK_ORDER_GROUPS = [
  ['1_espadas'],['1_bastos'],['7_espadas'],['7_oros'],
  ['3_oros','3_copas','3_espadas','3_bastos'],['2_oros','2_copas','2_espadas','2_bastos'],
  ['1_oros','1_copas'],
  ['12_oros','12_copas','12_espadas','12_bastos'],['11_oros','11_copas','11_espadas','11_bastos'],
  ['10_oros','10_copas','10_espadas','10_bastos'],['7_copas','7_bastos'],
  ['6_oros','6_copas','6_espadas','6_bastos'],['5_oros','5_copas','5_espadas','5_bastos'],
  ['4_oros','4_copas','4_espadas','4_bastos']
];
const TRICK_RANK=(()=>{const m={};let s=100;for(const g of TRICK_ORDER_GROUPS){for(const c of g)m[c]=s;s-=10;}return m;})();

// ─── Audio ────────────────────────────────────────────────────────────────────
let _ac=null;
const ac=()=>{if(!_ac)_ac=new(window.AudioContext||window.webkitAudioContext)();return _ac;};
function tone(f,t,d,v,dl){try{const c=ac(),ts=c.currentTime+(dl||0);const o=c.createOscillator(),g=c.createGain();o.type=t||'sine';o.frequency.setValueAtTime(f,ts);g.gain.setValueAtTime(v||.15,ts);g.gain.exponentialRampToValueAtTime(.001,ts+(d||.1));o.connect(g);g.connect(c.destination);o.start(ts);o.stop(ts+(d||.1));}catch(e){}}
const sndCard =()=>{tone(440,'triangle',.07,.14);tone(560,'triangle',.05,.09,.06);};
const sndWin  =()=>{[523,659,784,1047].forEach((f,i)=>tone(f,'sine',.14,.17,i*.1));};
const sndPoint=()=>{tone(330,'sine',.11,.13);tone(450,'sine',.09,.11,.1);};
const sndTick =()=>tone(880,'square',.04,.06);

// ─── Session ──────────────────────────────────────────────────────────────────
let roomRef=null,roomCode=null,mySeat=null;
let unsubGame=null,unsubChat=null;
let inactTimer=null,betweenTimer=null,turnTimer=null;
let prevTurnKey='',prevEnvitSt='none',prevTrucSt='none';
let chatOpen=false,lastChatN=0;

const $=id=>document.getElementById(id);
const clone=o=>JSON.parse(JSON.stringify(o));
const uid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const sanitize=s=>String(s||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
const normName=s=>String(s||'').trim().slice(0,24)||'Invitado';
const other=s=>s===0?1:0;
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function parseCard(c){const[n,s]=String(c).split('_');return{num:Number(n),suit:s};}
function cardLabel(c){const{num,suit}=parseCard(c);return`${num} de ${SUITS[suit]?.label||suit}`;}
function trickRank(c){return TRICK_RANK[c]??0;}
function cmpTrick(a,b){const d=trickRank(a)-trickRank(b);return d>0?1:d<0?-1:0;}
function envitVal(c){const n=parseCard(c).num;return n>=10?0:n;}
function bestEnvit(cards){
  if(!cards?.length)return 0;let best=0;
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
    const a=parseCard(cards[i]),b=parseCard(cards[j]);
    if(a.suit===b.suit){const v=20+envitVal(cards[i])+envitVal(cards[j]);if(v>best)best=v;}
  }
  return best>0?best:Math.max(0,...cards.map(envitVal));
}
// Acceso a players/scores usando claves "_0","_1"
function pName(st,seat){return st?.players?.[K(seat)]?.name||`Jugador ${seat}`;}
function bothReady(st){return !!(st?.players?.[K(0)]&&st?.players?.[K(1)]);}
function getScore(st,seat){return Number(st?.scores?.[K(seat)]||0);}
function addScore(st,seat,pts){if(!st.scores)st.scores={[K(0)]:0,[K(1)]:0};st.scores[K(seat)]=(Number(st.scores[K(seat)]||0))+pts;}

function pushLog(st,text){st.logs=st.logs||[];st.logs.unshift({text,at:Date.now()});st.logs=st.logs.slice(0,30);}

function loadLS(){
  const n=localStorage.getItem(LS.name),r=localStorage.getItem(LS.room),s=localStorage.getItem(LS.seat);
  if(n)$('nameInput').value=n;if(r)$('roomInput').value=r;if(s!=null)mySeat=Number(s);
}
function saveLS(name,code,seat){
  localStorage.setItem(LS.name,name||'');localStorage.setItem(LS.room,code||'');localStorage.setItem(LS.seat,String(seat));
}
function resetInactivity(){
  clearTimeout(inactTimer);
  inactTimer=setTimeout(async()=>{if(roomRef)try{await remove(roomRef);}catch(e){}
    localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);location.reload();},INACTIVITY_MS);
}

// ─── Default state — sin claves numéricas ─────────────────────────────────────
function defaultState(){
  return{version:4,status:'waiting',roomCode:'',
    players:{[K(0)]:null,[K(1)]:null},
    scores:{[K(0)]:0,[K(1)]:0},
    handNumber:0,mano:0,turn:0,hand:null,logs:[],winner:null};
}

function buildDeck(){
  const c=[],n=[1,2,3,4,5,6,7,10,11,12];
  for(const s of SUIT_ORDER)for(const x of n)c.push(`${x}_${s}`);return c;
}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

function makeHand(mano){
  const deck=shuffle(buildDeck());
  return{
    status:'in_progress',mano,turn:mano,mode:'normal',
    envitAvailable:true,pendingOffer:null,resume:null,
    // Manos como objetos {a,b,c} — nunca arrays ni claves numéricas
    hands:{[K(0)]:toHandObj(deck.slice(0,3)),[K(1)]:toHandObj(deck.slice(3,6))},
    // Cartas jugadas: claves "c0","c1" — nunca "0","1"
    currentTrick:{cards:{},lead:mano,playedBy:[]},
    trickIndex:0,
    trickWins:{[K(0)]:0,[K(1)]:0},
    trickHistory:[],
    scoreAwards:{[K(0)]:0,[K(1)]:0},
    envit:{state:'none',caller:null,responder:null,acceptedLevel:0,acceptedBy:null},
    truc:{state:'none',caller:null,responder:null,acceptedLevel:0,acceptedBy:null}
  };
}

// ─── Game logic ───────────────────────────────────────────────────────────────
function handWinner(state){
  const h=state.hand;
  const w0=Number(h.trickWins?.[K(0)]||0),w1=Number(h.trickWins?.[K(1)]||0);
  if(w0>=2)return 0;if(w1>=2)return 1;
  const hist=h.trickHistory||[];if(hist.length<3)return state.mano;
  const r1=hist[0]?.winner??null,r2=hist[1]?.winner??null,r3=hist[2]?.winner??null;
  if(r1===null&&r2===null&&r3===null)return state.mano;
  if(r1===null)return r2!==null?r2:r3!==null?r3:state.mano;
  return r1;
}

function applyHandEnd(state,reason){
  const h=state.hand;if(!h)return;
  const finish=()=>{
    const s0=getScore(state,0),s1=getScore(state,1);
    if(s0>=12||s1>=12){
      state.status='game_over';state.winner=s0>s1?0:s1>s0?1:state.mano;state.hand=null;return true;
    }return false;
  };
  if(h.envit.state==='accepted'){
    const v0=bestEnvit(fromHandObj(h.hands?.[K(0)]));
    const v1=bestEnvit(fromHandObj(h.hands?.[K(1)]));
    const ew=v0>v1?0:v1>v0?1:state.mano;
    const ep=h.envit.acceptedLevel==='falta'?12-Math.max(getScore(state,0),getScore(state,1)):Number(h.envit.acceptedLevel||0);
    addScore(state,ew,ep);pushLog(state,`Envit: guanya J${ew} (+${ep}).`);if(finish())return;
  }
  for(const s of[0,1]){const pts=Number(h.scoreAwards?.[K(s)]||0);if(pts)addScore(state,s,pts);}
  if(finish())return;
  if(h.truc.state==='accepted'){
    const tw=handWinner(state),tp=Number(h.truc.acceptedLevel||0);
    addScore(state,tw,tp);pushLog(state,`Truc: guanya J${tw} (+${tp}).`);if(finish())return;
  }
  if(reason)pushLog(state,reason);
  pushLog(state,`Marcador: ${getScore(state,0)}–${getScore(state,1)}`);
  state.mano=other(state.mano);state.turn=state.mano;
  state.status='waiting';state.hand=null;
  state.handNumber=Number(state.handNumber||0)+1;
}

function resolveTrick(state){
  const h=state.hand;
  // Leer cartas jugadas con claves "c0","c1"
  const c0=h.currentTrick.cards?.['c0']||null;
  const c1=h.currentTrick.cards?.['c1']||null;
  let w=null;
  if(c0&&c1){const cmp=cmpTrick(c0,c1);w=cmp>0?0:cmp<0?1:null;}
  h.trickHistory.push({index:h.trickIndex+1,cards:{c0,c1},winner:w,lead:h.currentTrick.lead});
  if(w!==null){h.trickWins[K(w)]=(Number(h.trickWins[K(w)]||0))+1;h.turn=w;pushLog(state,`Baza ${h.trickIndex+1}: guanya J${w}.`);}
  else{h.turn=h.currentTrick.lead;pushLog(state,`Baza ${h.trickIndex+1}: parda.`);}
  h.currentTrick={cards:{},lead:h.turn,playedBy:[]};
  h.trickIndex+=1;h.mode='normal';
  const w0=Number(h.trickWins[K(0)]||0),w1=Number(h.trickWins[K(1)]||0);
  if(w0>=2||w1>=2||h.trickIndex>=3)applyHandEnd(state,`Mà: guanya J${handWinner(state)}.`);
}

function resumeOffer(state){
  const h=state.hand,r=h.resume;
  h.pendingOffer=null;h.envitAvailable=false;
  if(r){h.mode=r.mode;h.turn=r.turn;}else h.mode='normal';
  h.resume=null;
}

// ─── Firebase wrapper ─────────────────────────────────────────────────────────
async function mutate(fn){
  if(!roomRef){console.error('No roomRef');return null;}
  try{
    const res=await runTransaction(roomRef,cur=>{
      if(!cur)return cur;
      const next=clone(cur);
      if(!next.state)next.state=defaultState();
      next.lastActivity=Date.now();
      const ok=fn(next.state);
      if(ok===false){console.warn('mutate: fn returned false');return;}
      return next;
    },{applyLocally:false});
    if(!res.committed)console.warn('Transaction not committed');
    return res;
  }catch(e){console.error('mutate error:',e);return null;}
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function dealHand(){
  console.log('dealHand called, mySeat=',mySeat);
  const res=await mutate(state=>{
    const p0=state.players?.[K(0)],p1=state.players?.[K(1)];
    if(!p0||!p1){console.warn('dealHand: missing players',JSON.stringify(state.players));return false;}
    if(state.status==='game_over'){console.warn('dealHand: game over');return false;}
    if(state.hand?.status==='in_progress'){console.warn('dealHand: hand in progress');return false;}
    state.hand=makeHand(state.mano);
    state.status='playing';
    pushLog(state,`Mà #${Number(state.handNumber||0)+1}. Torn: J${state.mano}.`);
    console.log('dealHand: success, dealing to mano=',state.mano);
    return true;
  });
  console.log('dealHand result:',res?.committed);
}

async function playCard(card){
  const res=await mutate(state=>{
    const h=state.hand;
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(h.turn!==mySeat||h.mode!=='normal'||h.pendingOffer)return false;
    // Obtener mano como array desde objeto {a,b,c}
    const mine=fromHandObj(h.hands?.[K(mySeat)]);
    if(!mine.includes(card)){console.warn('card not in hand',card,mine);return false;}
    // Guardar mano sin la carta jugada
    h.hands[K(mySeat)]=toHandObj(mine.filter(c=>c!==card));
    // Guardar carta jugada — clave "c0" o "c1" (nunca numérica)
    if(!h.currentTrick.cards)h.currentTrick.cards={};
    h.currentTrick.cards[`c${mySeat}`]=card;
    h.currentTrick.playedBy=(h.currentTrick.playedBy||[]).concat([mySeat]);
    h.envitAvailable=false;
    pushLog(state,`J${mySeat} juga ${cardLabel(card)}.`);
    // ¿Ha jugado el otro también?
    const othCard=h.currentTrick.cards[`c${other(mySeat)}`];
    if(!othCard){h.turn=other(mySeat);h.envitAvailable=true;return true;}
    resolveTrick(state);return true;
  });
  return res;
}

async function goMazo(){
  await mutate(state=>{
    const h=state.hand;
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(h.turn!==mySeat||h.mode!=='normal'||h.pendingOffer)return false;
    if(h.trickIndex!==0||Object.keys(h.currentTrick?.cards||{}).length!==0)return false;
    const w=other(mySeat);
    h.scoreAwards[K(w)]=(Number(h.scoreAwards?.[K(w)]||0))+1;
    pushLog(state,`J${mySeat} al mazo. +1 J${w}.`);
    applyHandEnd(state,'Mazo.');return true;
  });
}

async function startOffer(kind){
  await mutate(state=>{
    const h=state.hand;
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(h.turn!==mySeat||h.pendingOffer)return false;
    if(kind==='envit'){
      if(!(h.mode==='normal'||h.mode==='respond_truc'))return false;
      if(!h.envitAvailable||h.envit.state!=='none')return false;
      h.resume={mode:h.mode,turn:h.turn};
      h.pendingOffer={kind:'envit',level:2,by:mySeat,to:other(mySeat)};
      h.mode='respond_envit';h.turn=other(mySeat);
      pushLog(state,`J${mySeat} canta envit.`);return true;
    }
    if(kind==='truc'){
      if(h.mode!=='normal')return false;
      h.resume={mode:h.mode,turn:h.turn};
      h.pendingOffer={kind:'truc',level:2,by:mySeat,to:other(mySeat)};
      h.mode='respond_truc';h.turn=other(mySeat);h.envitAvailable=true;
      pushLog(state,`J${mySeat} canta truc.`);return true;
    }
    return false;
  });
}

async function respondEnvit(choice){
  await mutate(state=>{
    const h=state.hand,offer=h?.pendingOffer;
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(!offer||offer.kind!=='envit'||h.turn!==mySeat||h.mode!=='respond_envit')return false;
    const caller=offer.by,resp=offer.to;
    if(choice==='vull'){
      h.envit={state:'accepted',caller,responder:resp,acceptedLevel:offer.level,acceptedBy:mySeat};
      h.envitAvailable=false;pushLog(state,`Envit acceptat (${offer.level==='falta'?'falta':offer.level}).`);
      resumeOffer(state);return true;
    }
    if(choice==='no_vull'){
      h.envit={state:'rejected',caller,responder:resp,acceptedLevel:0,acceptedBy:null};
      h.scoreAwards[K(caller)]=(Number(h.scoreAwards?.[K(caller)]||0))+1;
      h.envitAvailable=false;pushLog(state,`Envit rebutjat. +1 J${caller}.`);
      resumeOffer(state);return true;
    }
    if(choice==='torne'){
      if(offer.level!==2)return false;
      h.pendingOffer={kind:'envit',level:4,by:resp,to:caller};
      h.turn=caller;h.mode='respond_envit';h.envitAvailable=false;
      pushLog(state,'Torne a envit 4.');return true;
    }
    if(choice==='falta'){
      h.pendingOffer={kind:'envit',level:'falta',by:resp,to:caller};
      h.turn=caller;h.mode='respond_envit';h.envitAvailable=false;
      pushLog(state,'Envit de falta.');return true;
    }
    return false;
  });
}

async function respondTruc(choice){
  await mutate(state=>{
    const h=state.hand,offer=h?.pendingOffer;
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(!offer||offer.kind!=='truc'||h.turn!==mySeat||h.mode!=='respond_truc')return false;
    const caller=offer.by,resp=offer.to;
    if(choice==='vull'){
      h.truc={state:'accepted',caller,responder:resp,acceptedLevel:offer.level,acceptedBy:mySeat};
      h.envitAvailable=false;pushLog(state,`Truc acceptat (${offer.level}).`);
      resumeOffer(state);return true;
    }
    if(choice==='no_vull'){
      h.truc={state:'rejected',caller,responder:resp,acceptedLevel:0,acceptedBy:null};
      h.scoreAwards[K(caller)]=(Number(h.scoreAwards?.[K(caller)]||0))+1;
      h.envitAvailable=false;pushLog(state,`Truc rebutjat. +1 J${caller}.`);
      applyHandEnd(state,'No vull al truc.');return true;
    }
    if(choice==='retruque'){
      if(offer.level!==2)return false;
      h.pendingOffer={kind:'truc',level:3,by:resp,to:caller};
      h.turn=caller;h.mode='respond_truc';h.envitAvailable=true;
      pushLog(state,'Retruque a 3.');return true;
    }
    if(choice==='val4'){
      if(offer.level!==2&&offer.level!==3)return false;
      h.pendingOffer={kind:'truc',level:4,by:resp,to:caller};
      h.turn=caller;h.mode='respond_truc';h.envitAvailable=true;
      pushLog(state,'Val 4 al truc.');return true;
    }
    return false;
  });
}

async function timeoutTurn(){
  await mutate(state=>{
    const h=state.hand;
    if(!h||state.status!=='playing'||h.status!=='in_progress'||h.turn!==mySeat)return false;
    if(h.pendingOffer?.to===mySeat){
      if(h.pendingOffer.kind==='envit'){
        h.envit={state:'rejected',caller:h.pendingOffer.by,responder:mySeat,acceptedLevel:0,acceptedBy:null};
        h.scoreAwards[K(h.pendingOffer.by)]=(Number(h.scoreAwards?.[K(h.pendingOffer.by)]||0))+1;
        h.envitAvailable=false;pushLog(state,'Temps. Envit auto rebutjat.');resumeOffer(state);return true;
      }
      if(h.pendingOffer.kind==='truc'){
        h.truc={state:'rejected',caller:h.pendingOffer.by,responder:mySeat,acceptedLevel:0,acceptedBy:null};
        h.scoreAwards[K(h.pendingOffer.by)]=(Number(h.scoreAwards?.[K(h.pendingOffer.by)]||0))+1;
        h.envitAvailable=false;pushLog(state,'Temps. Truc auto rebutjat.');
        applyHandEnd(state,'No vull al truc (temps).');return true;
      }
    }
    if(h.mode==='normal'){
      const mine=fromHandObj(h.hands?.[K(mySeat)]);if(!mine.length)return false;
      const card=mine[0];
      h.hands[K(mySeat)]=toHandObj(mine.slice(1));
      if(!h.currentTrick.cards)h.currentTrick.cards={};
      h.currentTrick.cards[`c${mySeat}`]=card;
      h.envitAvailable=false;pushLog(state,`J${mySeat} juga ${cardLabel(card)} (temps).`);
      const othCard=h.currentTrick.cards[`c${other(mySeat)}`];
      if(!othCard){h.turn=other(mySeat);h.envitAvailable=true;return true;}
      resolveTrick(state);return true;
    }
    return false;
  });
}

// ─── Timers ───────────────────────────────────────────────────────────────────
function stopTurnTimer(){
  clearInterval(turnTimer);turnTimer=null;
  const f=$('turnTimerFill');
  if(f){f.style.transition='none';f.style.width='0%';f.classList.remove('urgent','timer-flash');}
}
function startTurnTimer(isMyTurn){
  stopTurnTimer();const f=$('turnTimerFill');if(!f)return;
  f.classList.remove('urgent','timer-flash');
  if(!isMyTurn){f.style.width='0%';return;}
  let rem=TURN_SECONDS;f.style.transition='none';f.style.width='100%';
  setTimeout(()=>{
    f.style.transition='width 1s linear';
    turnTimer=setInterval(()=>{
      rem--;f.style.width=Math.max(0,(rem/TURN_SECONDS)*100)+'%';
      if(rem<=10)f.classList.add('urgent');
      if(rem<=5)sndTick();
      if(rem<=0){stopTurnTimer();timeoutTurn();}
    },1000);
  },50);
}
function stopBetween(){clearInterval(betweenTimer);betweenTimer=null;$('countdownOverlay').classList.add('hidden');}
function startBetween(){
  stopBetween();
  const ov=$('countdownOverlay'),num=$('countdownNum');
  ov.classList.remove('hidden');let n=5;num.textContent=n;
  betweenTimer=setInterval(async()=>{
    n--;sndTick();
    if(n>0)num.textContent=n;
    else{stopBetween();if(mySeat===0)await dealHand();}
  },1000);
}

// ─── Card element builders ─────────────────────────────────────────────────────
function svgEl(suit,size){
  const tmp=document.createElement('span');tmp.innerHTML=SUIT_SVG[suit]||'';
  const svg=tmp.firstElementChild;
  if(svg){svg.style.width=size+'px';svg.style.height=size+'px';svg.style.display='block';}
  return svg||document.createElement('span');
}
function buildCard(card){
  const{num,suit}=parseCard(card);
  const el=document.createElement('div');el.className=`playing-card ${SUITS[suit]?.cls||''}`;
  const top=document.createElement('div');top.className='pc-top';
  const rT=document.createElement('span');rT.className='pc-rank';rT.textContent=num;
  top.appendChild(rT);top.appendChild(svgEl(suit,13));
  const ctr=document.createElement('div');ctr.className='pc-center';ctr.appendChild(svgEl(suit,30));
  const bot=document.createElement('div');bot.className='pc-bot';
  const rB=document.createElement('span');rB.className='pc-rank';rB.textContent=num;
  bot.appendChild(rB);bot.appendChild(svgEl(suit,13));
  el.appendChild(top);el.appendChild(ctr);el.appendChild(bot);
  return el;
}
function buildBack(){const el=document.createElement('div');el.className='card-back';return el;}

function animatePlay(cardEl,card,onDone){
  const slot=$(`trickSlot${mySeat}`);
  const fr=cardEl.getBoundingClientRect();
  const to=slot?slot.getBoundingClientRect():{left:window.innerWidth/2,top:window.innerHeight/2,width:80,height:114};
  const fly=buildCard(card);fly.classList.add('card-flying');
  fly.style.cssText=`left:${fr.left}px;top:${fr.top}px;width:${fr.width}px;height:${fr.height}px;position:fixed;pointer-events:none;z-index:200;`;
  fly.style.setProperty('--tx',(to.left+to.width/2-fr.left-fr.width/2)+'px');
  fly.style.setProperty('--ty',(to.top+to.height/2-fr.top-fr.height/2)+'px');
  fly.style.setProperty('--rot',(Math.random()*10-5)+'deg');
  document.body.appendChild(fly);
  fly.addEventListener('animationend',()=>{fly.remove();if(onDone)onDone();},{once:true});
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderRivalCards(handObj){
  const z=$('rivalCards');z.innerHTML='';
  const cards=fromHandObj(handObj);const n=cards.length;
  z.setAttribute('data-count',n);
  for(let i=0;i<n;i++){const s=document.createElement('div');s.className='rival-card-slot deal-anim';s.appendChild(buildBack());z.appendChild(s);}
}

function renderMyCards(state){
  const h=state.hand,z=$('myCards');z.innerHTML='';if(!h)return;
  const cards=fromHandObj(h.hands?.[K(mySeat)]);
  const playable=h.turn===mySeat&&h.mode==='normal'&&!h.pendingOffer&&state.status==='playing';
  cards.forEach(card=>{
    const wrap=document.createElement('div');wrap.className='my-card-wrap deal-anim';
    const cel=buildCard(card);wrap.appendChild(cel);
    if(playable){
      wrap.classList.add('playable');
      wrap.addEventListener('click',()=>{
        if(!wrap.classList.contains('playable'))return;
        wrap.classList.remove('playable');sndCard();
        animatePlay(cel,card,()=>playCard(card));
      },{once:true});
    }
    z.appendChild(wrap);
  });
}

function renderTrick(state){
  $('trickSlot0').innerHTML='';$('trickSlot1').innerHTML='';
  const h=state.hand;if(!h)return;
  const cards=h.currentTrick?.cards||{};
  // Leemos "c0" y "c1"
  [0,1].forEach(seat=>{
    const card=cards[`c${seat}`];
    if(card){const el=buildCard(card);el.classList.add('land-anim');$(`trickSlot${seat}`).appendChild(el);}
  });
  const info=$('centerInfo');info.innerHTML='';
  const hist=h.trickHistory||[];
  if(hist.length){
    const dots=document.createElement('div');dots.className='trick-history-dots';
    hist.forEach(t=>{
      const d=document.createElement('div');d.className='trick-dot';
      if(t.winner===null)d.classList.add('draw');
      else if(t.winner===mySeat)d.classList.add('won');
      else d.classList.add('lost');
      dots.appendChild(d);
    });
    info.appendChild(dots);
  }
}

function renderActions(state){
  const h=state.hand;
  const eB=$('envitBtn'),tB=$('trucBtn'),mB=$('mazoBtn');
  const ra=$('responseArea'),om=$('offerMsg');
  ra.innerHTML='';ra.classList.add('hidden');om.classList.add('hidden');
  const playing=state.status==='playing'&&h?.status==='in_progress';
  if(!playing){eB.disabled=true;tB.disabled=true;mB.disabled=true;
    $('statusMsg').textContent=state.status==='waiting'?'Esperando…':'Partida terminada';return;}
  const myT=h.turn===mySeat,norm=h.mode==='normal',envDone=h.envit.state!=='none';
  eB.disabled=!myT||!h.envitAvailable||envDone||!!h.pendingOffer||(h.mode!=='normal'&&h.mode!=='respond_truc');
  tB.disabled=!myT||!norm||!!h.pendingOffer;
  mB.disabled=!myT||!norm||!!h.pendingOffer||h.trickIndex!==0||Object.keys(h.currentTrick?.cards||{}).length!==0;
  if(h.pendingOffer&&h.turn===mySeat){
    om.textContent=h.pendingOffer.kind==='envit'
      ?(h.pendingOffer.level==='falta'?'Envit de falta':h.pendingOffer.level===4?'Torne (4)':'Envit')
      :(h.pendingOffer.level===3?'Retruque':h.pendingOffer.level===4?'Val 4':'Truc');
    om.classList.remove('hidden');ra.classList.remove('hidden');
    const add=(l,cls,fn)=>{const b=document.createElement('button');b.textContent=l;b.className=`abtn ${cls}`;b.addEventListener('click',fn);ra.appendChild(b);};
    if(h.pendingOffer.kind==='envit'){
      add('Vull','abtn-green',()=>respondEnvit('vull'));add('No vull','abtn-red',()=>respondEnvit('no_vull'));
      if(h.pendingOffer.level===2){add('Torne','abtn-gold',()=>respondEnvit('torne'));add('Falta','abtn-gold',()=>respondEnvit('falta'));}
      else if(h.pendingOffer.level===4)add('Falta','abtn-gold',()=>respondEnvit('falta'));
    }else{
      if(h.envitAvailable&&!envDone)add('Envidar','abtn-green',()=>startOffer('envit'));
      add('Vull','abtn-green',()=>respondTruc('vull'));add('No vull','abtn-red',()=>respondTruc('no_vull'));
      if(h.pendingOffer.level===2)add('Retruque','abtn-gold',()=>respondTruc('retruque'));
      if(h.pendingOffer.level===2||h.pendingOffer.level===3)add('Val 4','abtn-gold',()=>respondTruc('val4'));
    }
  }
  const sm=$('statusMsg');
  if(h.pendingOffer&&h.turn!==mySeat)sm.textContent=`Esperando a ${pName(state,h.turn)}…`;
  else if(!myT)sm.textContent=`Turno de ${pName(state,h.turn)}`;
  else if(norm&&!h.pendingOffer)sm.textContent='Tu turno — elige carta o acción';
  else sm.textContent='';
}

function renderHUD(state){
  $('hudRoom').textContent=`Sala ${roomCode||'—'}`;
  $('hudSeat').textContent=`${pName(state,mySeat)} (J${mySeat})`;
  $('hudScore0').textContent=String(getScore(state,0));
  $('hudScore1').textContent=String(getScore(state,1));
  $('hudState').textContent=state.status==='waiting'?'Esperando':state.status==='playing'?'En juego':'Terminada';
  $('siMano').textContent=`J${state.mano}${state.mano===mySeat?' (tú)':''}`;
  $('siHand').textContent=String(state.handNumber??0);
  const tw=state.hand?.trickWins;
  $('siBazas').textContent=tw?`${tw[K(0)]||0}-${tw[K(1)]||0}`:'0-0';
}

function renderLog(state){
  const a=$('logArea');a.innerHTML='';
  (state.logs||[]).slice(0,15).forEach(item=>{
    const d=document.createElement('div');d.className='log-entry';d.textContent=item.text;a.appendChild(d);
  });
}

function detectSounds(state){
  const h=state.hand;if(!h)return;
  if(h.envit.state==='accepted'&&prevEnvitSt!=='accepted')sndPoint();
  if(h.truc.state==='accepted'&&prevTrucSt!=='accepted')sndPoint();
  prevEnvitSt=h.envit.state||'none';prevTrucSt=h.truc.state||'none';
}

// ─── MAIN RENDER ──────────────────────────────────────────────────────────────
function renderAll(room){
  const state=room?.state||defaultState();
  resetInactivity();detectSounds(state);
  renderHUD(state);
  $('myName').textContent=pName(state,mySeat);
  $('rivalName').textContent=pName(state,other(mySeat));
  renderRivalCards(state.hand?.hands?.[K(other(mySeat))]);
  renderMyCards(state);renderTrick(state);renderActions(state);renderLog(state);
  const ready=bothReady(state);

  if(state.status==='game_over'){
    stopBetween();stopTurnTimer();$('waitingOverlay').classList.add('hidden');
    $('gameOverOverlay').classList.remove('hidden');
    $('goWinner').textContent=pName(state,state.winner)+' guanya';
    $('goScore').textContent=`${getScore(state,0)} – ${getScore(state,1)}`;sndWin();return;
  }
  $('gameOverOverlay').classList.add('hidden');

  if(state.status==='waiting'){
    stopTurnTimer();
    if(state.handNumber===0){
      // Primera mano: overlay con botón para el host, mensaje de espera para el rival
      stopBetween();
      $('waitingCode').textContent=roomCode||'—';
      $('waitingStatus').textContent=ready
        ?`${pName(state,0)} i ${pName(state,1)} llestos`
        :'Esperant el segon jugador…';
      // Solo el jugador 0 (creador) ve el botón de inicio
      $('startBtn').classList.toggle('hidden',!(mySeat===0&&ready));
      $('waitingNote').textContent=mySeat===0
        ?'Prem Iniciar quan els dos estigueu a punt'
        :'Esperant que el creador inici la partida…';
      $('waitingOverlay').classList.remove('hidden');
    }else{
      // Entre manos: sin overlay, cuenta atrás transparente
      $('waitingOverlay').classList.add('hidden');
      if(ready&&betweenTimer===null)startBetween();
    }
    return;
  }
  // Playing
  $('waitingOverlay').classList.add('hidden');stopBetween();
  const h=state.hand;
  if(h){
    const tk=`${state.handNumber}-${h.trickIndex}-${h.turn}-${h.mode}`;
    if(tk!==prevTurnKey){startTurnTimer(h.turn===mySeat&&h.status==='in_progress');prevTurnKey=tk;}
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function initChat(code){
  if(unsubChat)unsubChat();
  unsubChat=onValue(ref(db,`rooms/${code}/chat`),snap=>{
    const msgs=snap.val();const area=$('chatMessages');area.innerHTML='';
    if(!msgs)return;
    const arr=Object.values(msgs).sort((a,b)=>a.at-b.at);
    arr.forEach(m=>{
      const div=document.createElement('div');div.className=`chat-msg ${m.seat===mySeat?'mine':'theirs'}`;
      const t=new Date(m.at);const hh=t.getHours().toString().padStart(2,'0');const mm=t.getMinutes().toString().padStart(2,'0');
      div.innerHTML=`<span class="chat-author">${esc(m.name)}:</span> <span class="chat-text">${esc(m.text)}</span> <span class="chat-time">${hh}:${mm}</span>`;
      area.appendChild(div);
    });
    area.scrollTop=area.scrollHeight;
    if(!chatOpen&&arr.length>lastChatN)$('chatBadge').classList.remove('hidden');
    lastChatN=arr.length;
  });
}
async function sendChat(){
  const inp=$('chatInput'),text=inp.value.trim();if(!text||!roomRef||mySeat===null)return;
  inp.value='';const myName=localStorage.getItem(LS.name)||`Jugador ${mySeat}`;
  await push(ref(db,`rooms/${roomCode}/chat`),{seat:mySeat,name:myName,text,at:Date.now()});
}

// ─── Room ─────────────────────────────────────────────────────────────────────
function startSession(code){
  roomCode=code;roomRef=ref(db,`rooms/${code}`);
  if(unsubGame)unsubGame();
  unsubGame=onValue(roomRef,snap=>renderAll(snap.val()));
  initChat(code);
  $('screenLobby').classList.add('hidden');$('screenGame').classList.remove('hidden');
}
function setLobbyMsg(txt,cls){const el=$('lobbyMsg');el.textContent=txt;el.className='lobby-msg'+(cls?' '+cls:'');}

async function createRoom(){
  const name=normName($('nameInput').value);
  const code=sanitize($('roomInput').value)||Math.random().toString(36).slice(2,6).toUpperCase();
  const r=ref(db,`rooms/${code}`);
  const ex=await get(r);if(ex.exists()){setLobbyMsg('Sala ja existeix. Usa Unirse.','err');return;}
  const init=defaultState();init.roomCode=code;
  init.players[K(0)]={name,clientId:uid()};
  init.logs=[{text:`Sala creada per ${name}.`,at:Date.now()}];
  await set(r,{meta:{createdAt:Date.now(),roomCode:code},state:init,lastActivity:Date.now()});
  mySeat=0;saveLS(name,code,0);$('roomInput').value=code;
  setLobbyMsg(`Sala ${code} creada.`,'good');startSession(code);
}

async function joinRoom(){
  const name=normName($('nameInput').value);
  const code=sanitize($('roomInput').value);
  if(!code){setLobbyMsg('Escriu un codi de sala.','err');return;}
  const r=ref(db,`rooms/${code}`);
  const result=await runTransaction(r,cur=>{
    if(!cur)return cur;
    if(!cur.state)cur.state=defaultState();
    const st=cur.state;
    if(!st.players)st.players={[K(0)]:null,[K(1)]:null};
    const p0=st.players[K(0)],p1=st.players[K(1)];
    if(p0&&p1)return cur;
    if(!p0){st.players[K(0)]={name,clientId:uid()};pushLog(st,`${name} entra com J0.`);}
    else{st.players[K(1)]={name,clientId:uid()};pushLog(st,`${name} entra com J1.`);}
    cur.lastActivity=Date.now();return cur;
  },{applyLocally:false});
  if(!result.committed){setLobbyMsg('No es pot entrar. Sala plena o inexistent.','err');return;}
  const fs=result.snapshot.val()?.state;
  if(!fs){setLobbyMsg('Sala no trobada.','err');return;}
  const p0=fs.players?.[K(0)],p1=fs.players?.[K(1)];
  if(p1?.name===name&&p0?.name!==name)mySeat=1;
  else if(p0?.name===name)mySeat=0;
  else mySeat=1;
  saveLS(name,code,mySeat);setLobbyMsg(`Unit com J${mySeat}.`,'good');startSession(code);
}

async function leaveRoom(){
  stopBetween();stopTurnTimer();
  if(roomRef&&mySeat!=null){try{await remove(ref(db,`rooms/${roomCode}/state/players/${K(mySeat)}`));}catch(e){}}
  localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);location.reload();
}

// ─── Events ───────────────────────────────────────────────────────────────────
$('createBtn').addEventListener('click',createRoom);
$('joinBtn').addEventListener('click',joinRoom);
$('leaveBtn').addEventListener('click',leaveRoom);
$('goLeaveBtn').addEventListener('click',leaveRoom);
$('startBtn').addEventListener('click',async()=>{
  console.log('startBtn clicked, mySeat=',mySeat);
  $('waitingOverlay').classList.add('hidden');
  await dealHand();
});
$('envitBtn').addEventListener('click',()=>startOffer('envit'));
$('trucBtn').addEventListener('click',()=>startOffer('truc'));
$('mazoBtn').addEventListener('click',goMazo);
$('logToggle').addEventListener('click',()=>{
  const b=$('logBody');b.classList.toggle('hidden');
  $('logToggle').textContent=b.classList.contains('hidden')?'▸ Registro':'▾ Registro';
});
$('chatToggle').addEventListener('click',()=>{
  chatOpen=!chatOpen;$('chatBox').classList.toggle('hidden',!chatOpen);
  if(chatOpen){$('chatBadge').classList.add('hidden');
    setTimeout(()=>{$('chatMessages').scrollTop=$('chatMessages').scrollHeight;$('chatInput').focus();},50);}
});
$('chatSend').addEventListener('click',sendChat);
$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadLS();
const _sr=localStorage.getItem(LS.room);
if(_sr){
  roomCode=sanitize(_sr);$('roomInput').value=roomCode;
  const _ss=localStorage.getItem(LS.seat);if(_ss!=null)mySeat=Number(_ss);
  startSession(roomCode);
}
