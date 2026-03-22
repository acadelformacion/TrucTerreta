// --- Truc Valenciano . game.js ---------------------------------------------
// Firebase borra nodos vacios, null y false. Soluciones:
//   * Claves de asiento: "_0","_1" (no "0","1" -> array)
//   * Manos: objeto {a,b,c} con las cartas
//   * Cartas jugadas: guardadas en h.played como {p0:"carta",p1:"carta"}
//     El nodo NUNCA se borra; se resetea con un marcador "~" entre bazas.
//   * Contadores: almacenados +10 para que nunca sean 0.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, get, set, push, remove, onValue, runTransaction, onDisconnect }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey:"AIzaSyBHQ3hSWToVKzADI9eUlCNONbi_lN_TTAI",
  authDomain:"trucvalencia-12345.firebaseapp.com",
  databaseURL:"https://trucvalencia-12345-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:"trucvalencia-12345",
  storageBucket:"trucvalencia-12345.firebasestorage.app",
  messagingSenderId:"922530958932",
  appId:"1:922530958932:web:84fe1d9386f5ea2d6f67c1"
};
initializeApp(firebaseConfig);
const db = getDatabase();

// --- Key helpers --------------------------------------------------------------
const K  = n => `_${n}`;          // seat: 0->"_0"
const PK = n => `p${n}`;          // played key: 0->"p0"
const HKEYS = ['a','b','c'];
const EMPTY_CARD = '~';            // marcador "no jugada" (valor no valido)

const toHObj = arr => {
  const o = {};
  (arr||[]).filter(c=>c&&c!==EMPTY_CARD).forEach((c,i)=>{ o[HKEYS[i]]=c; });
  // Siempre al menos un campo para que Firebase no borre el nodo
  if(!Object.keys(o).length) o.x = EMPTY_CARD;
  return o;
};
const fromHObj = obj => {
  if(!obj||typeof obj!=='object') return [];
  if(Array.isArray(obj)) return obj.filter(c=>c&&c!==EMPTY_CARD);
  return HKEYS.map(k=>obj[k]).filter(c=>c&&c!==EMPTY_CARD);
};

// played: {p0:"1_oros", p1:"~"} - "~" = no jugo, string de carta = si jugo
const getPlayed = (h, seat) => {
  const v = h?.played?.[PK(seat)];
  return (v && v !== EMPTY_CARD) ? v : null;
};
const setPlayed = (h, seat, card) => {
  if(!h.played) h.played = {[PK(0)]:EMPTY_CARD, [PK(1)]:EMPTY_CARD};
  h.played[PK(seat)] = card || EMPTY_CARD;
};
const resetPlayed = (h) => {
  h.played = {[PK(0)]:EMPTY_CARD, [PK(1)]:EMPTY_CARD};
};
const alreadyPlayed = (h, seat) => getPlayed(h, seat) !== null;
const bothPlayed    = (h) => alreadyPlayed(h,0) && alreadyPlayed(h,1);

const LS = { room:'truc_room', seat:'truc_seat', name:'truc_name' };
const INACT_MS  = 60*60*1000;
const TURN_SECS = 30;
const OFFSET    = 10; // scores/trickWins stored +10

// --- SVG palos ----------------------------------------------------------------
const SUIT_SVG = {
  oros:`<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="2" fill="rgba(176,125,16,.1)"/><circle cx="16" cy="16" r="7" stroke="currentColor" stroke-width="1.5" fill="rgba(176,125,16,.15)"/><circle cx="16" cy="16" r="3" fill="currentColor"/></svg>`,
  copas:`<svg viewBox="0 0 32 36" fill="none"><path d="M8 5 Q8 15 16 17 Q24 15 24 5 Z" stroke="currentColor" stroke-width="1.8" fill="rgba(181,42,42,.1)" stroke-linejoin="round"/><path d="M11 17 Q11 22 13.5 23.5 L13.5 28 M18.5 23.5 Q21 22 21 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10 28 L22 28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  espadas:`<svg viewBox="0 0 32 36" fill="none"><path d="M16 3 L16 30" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 3 L11 14 L16 11 L21 14 Z" fill="currentColor" opacity=".85"/><path d="M8 22 L24 22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 30 L18 30 L17.5 33 L14.5 33 Z" fill="currentColor"/></svg>`,
  bastos:`<svg viewBox="0 0 32 36" fill="none"><path d="M12 32 Q10 23 13 16 Q9 12 11 7 Q15 5 16 9 Q17 5 21 7 Q23 12 19 16 Q22 23 20 32 Z" stroke="currentColor" stroke-width="1.8" fill="rgba(42,92,23,.1)" stroke-linejoin="round"/><circle cx="11" cy="7" r="3" fill="currentColor" opacity=".65"/><circle cx="21" cy="7" r="3" fill="currentColor" opacity=".65"/><circle cx="16" cy="5" r="2.5" fill="currentColor" opacity=".8"/></svg>`
};
const SUITS={oros:{label:'oros',cls:'s-oros'},copas:{label:'copas',cls:'s-copas'},espadas:{label:'espadas',cls:'s-espadas'},bastos:{label:'bastos',cls:'s-bastos'}};
const SUIT_ORDER=['oros','copas','espadas','bastos'];
const TRG=[
  ['1_espadas'],['1_bastos'],['7_espadas'],['7_oros'],
  ['3_oros','3_copas','3_espadas','3_bastos'],['2_oros','2_copas','2_espadas','2_bastos'],
  ['1_oros','1_copas'],
  ['12_oros','12_copas','12_espadas','12_bastos'],['11_oros','11_copas','11_espadas','11_bastos'],
  ['10_oros','10_copas','10_espadas','10_bastos'],['7_copas','7_bastos'],
  ['6_oros','6_copas','6_espadas','6_bastos'],['5_oros','5_copas','5_espadas','5_bastos'],
  ['4_oros','4_copas','4_espadas','4_bastos']
];
const TR=(()=>{const m={};let s=100;for(const g of TRG){for(const c of g)m[c]=s;s-=10;}return m;})();

// --- Audio --------------------------------------------------------------------
let _ac=null;
const ac=()=>{if(!_ac)_ac=new(window.AudioContext||window.webkitAudioContext)();return _ac;};
function tone(f,t,d,v,dl){try{const c=ac(),ts=c.currentTime+(dl||0);const o=c.createOscillator(),g=c.createGain();o.type=t||'sine';o.frequency.setValueAtTime(f,ts);g.gain.setValueAtTime(v||.15,ts);g.gain.exponentialRampToValueAtTime(.001,ts+(d||.1));o.connect(g);g.connect(c.destination);o.start(ts);o.stop(ts+(d||.1));}catch(e){}}
const sndCard =()=>{tone(440,'triangle',.07,.14);tone(560,'triangle',.05,.09,.06);};
const sndWin  =()=>{[523,659,784,1047].forEach((f,i)=>tone(f,'sine',.14,.17,i*.1));};
const sndPoint=()=>{tone(330,'sine',.11,.13);tone(450,'sine',.09,.11,.1);};
const sndTick =()=>tone(880,'square',.04,.06);
const sndBtn  =()=>{tone(600,'sine',.04,.08);};
const sndLose =()=>{tone(200,'sawtooth',.3,.12);tone(150,'sawtooth',.4,.1,.25);};

// --- Session ------------------------------------------------------------------
let roomRef=null,roomCode=null,mySeat=null;
let unsubGame=null,unsubChat=null;
let inactTimer=null,betweenTimer=null,turnTimer=null;
let prevTurnKey='',prevEnvSt='none',prevTrucSt='none';
let chatOpen=false,lastChatN=0;
let _lastState=null; // ultimo estado conocido para uso en helpers de render
let uiLocked=false; // bloqueo visual inmediato
// Render tracking - avoid unnecessary DOM rebuilds that cause flash
let _prevHandsKey='';  // tracks hand cards state
let _prevTrickKey='';  // tracks trick cards state
let _prevHandKey='';   // tracks which hand we're in
let _lastCompletedTricks=null; // snapshot of trick cards to show during countdown

const $=id=>document.getElementById(id);
const clone=o=>JSON.parse(JSON.stringify(o));
const uid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const sanitize=s=>String(s||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
const normName=s=>String(s||'').trim().slice(0,24)||'Invitado';
const other=s=>s===0?1:0;
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const real=n=>Number(n||OFFSET)-OFFSET; // decode stored value

function parseCard(c){const[n,s]=String(c).split('_');return{num:Number(n),suit:s};}
function cardLabel(c){const{num,suit}=parseCard(c);return`${num} de ${SUITS[suit]?.label}`;}
function trickRank(c){return TR[c]??0;}
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
function pName(st,seat){return st?.players?.[K(seat)]?.name||`Jugador ${seat}`;}
function bothReady(st){return !!(st?.players?.[K(0)]&&st?.players?.[K(1)]);}
function getScore(st,seat){return real(st?.scores?.[K(seat)]);}
function addScore(st,seat,pts){if(!st.scores)st.scores={[K(0)]:OFFSET,[K(1)]:OFFSET};st.scores[K(seat)]=(Number(st.scores[K(seat)]||OFFSET))+pts;}
function getTW(h,seat){return real(h?.trickWins?.[K(seat)]);}
function addTW(h,seat){h.trickWins[K(seat)]=(Number(h.trickWins[K(seat)]||OFFSET))+1;}
function getSA(h,seat){return real(h?.scoreAwards?.[K(seat)]);}
function addSA(h,seat,n=1){h.scoreAwards[K(seat)]=(Number(h.scoreAwards[K(seat)]||OFFSET))+n;}
function pushLog(st,text){st.logs=st.logs||[];st.logs.unshift({text,at:Date.now()});st.logs=st.logs.slice(0,30);}

function loadLS(){
  const n=localStorage.getItem(LS.name),r=localStorage.getItem(LS.room),s=localStorage.getItem(LS.seat);
  if(n)$('nameInput').value=n;if(r)$('roomInput').value=r;if(s!=null)mySeat=Number(s);
}
function saveLS(n,c,s){localStorage.setItem(LS.name,n||'');localStorage.setItem(LS.room,c||'');localStorage.setItem(LS.seat,String(s));}
function resetInactivity(){
  clearTimeout(inactTimer);
  inactTimer=setTimeout(async()=>{if(roomRef)try{await remove(roomRef);}catch(e){}
    localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);location.reload();},INACT_MS);
}

// --- Default state ------------------------------------------------------------
function defaultState(){
  return{version:7,status:'waiting',roomCode:'',
    players:{[K(0)]:null,[K(1)]:null},
    scores:{[K(0)]:OFFSET,[K(1)]:OFFSET},
    handNumber:OFFSET,mano:0,turn:0,hand:null,logs:[],winner:null};
}

function buildDeck(){const c=[],n=[1,2,3,4,5,6,7,10,11,12];for(const s of SUIT_ORDER)for(const x of n)c.push(`${x}_${s}`);return c;}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

// --- Hand factory -------------------------------------------------------------
function makeHand(mano){
  const deck=shuffle(buildDeck());
  return{
    status:'in_progress', mano, turn:mano, mode:'normal',
    envitAvailable:true, pendingOffer:null, resume:null,
    hands:{[K(0)]:toHObj(deck.slice(0,3)),[K(1)]:toHObj(deck.slice(3,6))},
    // played: siempre presente con EMPTY_CARD para que Firebase no lo borre
    played:{[PK(0)]:EMPTY_CARD,[PK(1)]:EMPTY_CARD},
    allTricks:[],  // array de {c0,c1,w} de todas las bazas jugadas
    trickLead:mano,
    trickIndex:OFFSET,  // stored +OFFSET
    trickWins:{[K(0)]:OFFSET,[K(1)]:OFFSET},
    trickHistory:[],
    scoreAwards:{[K(0)]:OFFSET,[K(1)]:OFFSET},
    envit:{state:'none',caller:null,responder:null,acceptedLevel:0,acceptedBy:null},
    truc:{state:'none',caller:null,responder:null,acceptedLevel:0,acceptedBy:null}
  };
}

function getTrickIndex(h){return real(h?.trickIndex);}

// --- Game logic ---------------------------------------------------------------
function handWinner(state){
  const h=state.hand;
  // Si alguien gano 2 bazas ya esta claro
  const w0=getTW(h,0),w1=getTW(h,1);
  if(w0>=2)return 0;
  if(w1>=2)return 1;
  const hist=h.trickHistory||[];
  const r1=hist.length>0?hist[0].winner:undefined; // null=parda, 0/1=ganador, undefined=no jugada
  const r2=hist.length>1?hist[1].winner:undefined;
  const r3=hist.length>2?hist[2].winner:undefined;
  // Baza 1 parda -> decide baza 2 (si baza 2 tb parda -> mano)
  if(r1===null){
    if(r2!==null&&r2!==undefined)return r2;
    return state.mano; // baza 2 parda o no jugada -> gana el mano
  }
  // Baza 1 con ganador
  if(r1!==undefined){
    // Baza 2 parda o no jugada -> gana el de baza 1
    if(r2===null||r2===undefined)return r1;
    // Baza 2 mismo ganador -> ese jugador gana
    if(r2===r1)return r1;
    // Baza 2 gano el otro -> desempate en baza 3
    if(r3!==null&&r3!==undefined)return r3;
    // Baza 3 parda -> gana el de baza 1 (tiene la primera victoria)
    if(r3===null)return r1;
    return r1; // baza 3 no jugada aun -> provisional
  }
  return state.mano;
}

function applyHandEnd(state,reason){
  const h=state.hand;if(!h)return;
  // Snapshot trick cards before clearing, so client can show them during countdown
  // (stored client-side only, not in Firebase)
  const finish=()=>{
    const s0=getScore(state,0),s1=getScore(state,1);
    if(s0>=12||s1>=12){
      state.status='game_over';
      state.winner=s0>s1?0:s1>s0?1:state.mano;
      state.hand=null;return true;
    }return false;
  };
  if(h.envit.state==='accepted'){
    const v0=bestEnvit(fromHObj(h.hands?.[K(0)]));
    const v1=bestEnvit(fromHObj(h.hands?.[K(1)]));
    const ew=v0>v1?0:v1>v0?1:state.mano;
    const ep=h.envit.acceptedLevel==='falta'?12-Math.max(getScore(state,0),getScore(state,1)):Number(h.envit.acceptedLevel||0);
    const ewName=state.players?.[K(ew)]?.name||`J${ew}`;
    addScore(state,ew,ep);pushLog(state,`Envit: guanya ${ewName} (+${ep}).`);if(finish())return;
  }
  for(const s of[0,1]){const pts=getSA(h,s);if(pts>0)addScore(state,s,pts);}
  if(finish())return;
  if(h.truc.state==='accepted'){
    const tw=handWinner(state),tp=Number(h.truc.acceptedLevel||0);
    const twName=state.players?.[K(tw)]?.name||`J${tw}`;
    addScore(state,tw,tp);pushLog(state,`Truc: guanya ${twName} (+${tp}).`);if(finish())return;
  }else if(h.truc.state==='none'){
    if(!h.mazo){
      // Sin truc y sin mazo: +1 al ganador de las bazas
      const hw=handWinner(state);
      if(hw!==null&&hw!==undefined){
        const hwName=state.players?.[K(hw)]?.name||`J${hw}`;
        addScore(state,hw,1);pushLog(state,`Ma guanyada per ${hwName} (+1).`);
      }
      if(finish())return;
    }
    // if h.mazo=true, the +1 was already added via scoreAwards, skip here
  }
  if(reason)pushLog(state,reason);
  pushLog(state,`Marcador: ${getScore(state,0)}-${getScore(state,1)}`);
  state.mano=other(state.mano);state.turn=state.mano;
  state.status='waiting';state.hand=null;
  state.handNumber=(Number(state.handNumber||OFFSET))+1;
}

function resolveTrick(state){
  const h=state.hand;
  const c0=getPlayed(h,0),c1=getPlayed(h,1);
  let w=null;
  if(c0&&c1){const cmp=cmpTrick(c0,c1);w=cmp>0?0:cmp<0?1:null;}
  const idx=getTrickIndex(h);
  const lead=h.trickLead??state.mano;
  // Store draw as winner=99 (null would be deleted by Firebase)
  h.trickHistory=(h.trickHistory||[]).concat([{i:idx+1,c0,c1,winner:w===null?99:w,lead}]);
  if(w!==null){
    addTW(h,w);h.turn=w;
    const wn=state.players?.[K(w)]?.name||`J${w}`;
    pushLog(state,`Baza ${idx+1}: guanya ${wn}.`);
  }else{
    h.turn=lead;
    pushLog(state,`Baza ${idx+1}: EMPAT.`); // EMPAT not undefined
  }
  h.trickLead=h.turn;
  h.trickIndex=(Number(h.trickIndex||OFFSET))+1;
  // Guardar la baza resuelta en el array de todas las bazas
  h.allTricks=(h.allTricks||[]).concat([{c0:c0||EMPTY_CARD,c1:c1||EMPTY_CARD,w:w===null?99:w}]);
  // RESET played con EMPTY_CARD - nunca borramos el nodo
  resetPlayed(h);
  h.mode='normal';
  // Envit SOLO permitido antes de jugar la 1a carta de la 1a baza
  h.envitAvailable=false;
  const w0=getTW(h,0),w1=getTW(h,1);
  const tIdx=getTrickIndex(h);
  const hist=h.trickHistory||[];
  // Terminar mano si: 2 bazas ganadas, o 3 bazas jugadas,
  // o baza 1 fue parda y baza 2 tiene ganador (el ganador de b2 gana)
  // winner===99 means DRAW (null is deleted by Firebase)
  const isDraw=w=>w===99||w===null||w===undefined;
  const hasWinner=w=>w!==99&&w!==null&&w!==undefined;
  const b1Draw=hist.length>=1&&isDraw(hist[0].winner);
  const b2Draw=hist.length>=2&&isDraw(hist[1].winner);
  const b2HasWinner=hist.length>=2&&hasWinner(hist[1].winner);
  const b1HasWinner=hist.length>=1&&hasWinner(hist[0].winner);
  // End if: 2 wins, 3 tricks, b1draw+b2winner, or b1winner+b2draw
  const handOver=w0>=2||w1>=2||tIdx>=3||(b1Draw&&b2HasWinner)||(b1HasWinner&&b2Draw);
  if(handOver){
    const hw=handWinner(state);
    // hw is 0 or 1 - use state.players directly (we're inside the transaction)
    const hwName=state.players?.[K(hw)]?.name||`Jugador ${hw}`;
    applyHandEnd(state,`Ma guanyada per ${hwName}.`);
  }
}

function resumeOffer(state){
  const h=state.hand,r=h.resume;
  h.pendingOffer=null;h.envitAvailable=false;
  if(r){h.mode=r.mode;h.turn=r.turn;}else h.mode='normal';
  h.resume=null;
}

// --- Firebase -----------------------------------------------------------------
async function mutate(fn){
  if(!roomRef)return null;
  try{
    return await runTransaction(roomRef,cur=>{
      if(!cur)return cur;
      const next=clone(cur);
      if(!next.state)next.state=defaultState();
      next.lastActivity=Date.now();
      if(fn(next.state)===false)return;
      return next;
    },{applyLocally:false});
  }catch(e){console.error('mutate:',e);return null;}
}

// --- Actions ------------------------------------------------------------------
async function dealHand(){
  await mutate(state=>{
    if(!state.players?.[K(0)]||!state.players?.[K(1)])return false;
    if(state.status==='game_over')return false;
    if(state.hand?.status==='in_progress')return false;
    state.hand=makeHand(state.mano);state.status='playing';
    pushLog(state,`Ma #${real(state.handNumber)+1}. Torn: J${state.mano}.`);
    return true;
  });
}

async function playCard(card){
  if(uiLocked)return;
  uiLocked=true;
  document.querySelectorAll('#myCards .my-card-wrap').forEach(w=>w.classList.remove('playable'));
  try{
    await mutate(state=>{
      const h=state.hand;
      if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
      if(h.mode!=='normal'||h.pendingOffer)return false;
      if(h.turn!==mySeat)return false;
      // Safety: abort if hand should already be over
      // b1draw+b2win OR b1win+b2draw = hand is decided, no 3rd trick needed
      const _hist=h.trickHistory||[];
      const _r1=_hist.length>0?_hist[0].winner:undefined;
      const _r2=_hist.length>1?_hist[1].winner:undefined;
      const _isDraw=w=>w===99||w===null||w===undefined;
      const _isWin=w=>w===0||w===1;
      const _b1Draw=_hist.length>=1&&_isDraw(_r1)&&_r1!==undefined;
      const _b2Win=_hist.length>=2&&_isWin(_r2);
      const _b1Win=_hist.length>=1&&_isWin(_r1);
      const _b2Draw=_hist.length>=2&&_isDraw(_r2)&&_r2!==undefined;
      if((_b1Draw&&_b2Win)||(_b1Win&&_b2Draw))return false; // hand already decided
      // Guardia: ?ya jugo en esta baza?
      if(alreadyPlayed(h,mySeat)){console.warn('PLAYCARD: already played');return false;}
      const mine=fromHObj(h.hands?.[K(mySeat)]);
      if(!mine.includes(card))return false;
      // Actualizar mano
      h.hands[K(mySeat)]=toHObj(mine.filter(c=>c!==card));
      // Registrar carta jugada (NUNCA borramos played, solo sobreescribimos)
      setPlayed(h,mySeat,card);
      h.envitAvailable=false;
      const plrName=state.players?.[K(mySeat)]?.name||`J${mySeat}`;
      pushLog(state,`${plrName} juga ${cardLabel(card)}.`);
      if(alreadyPlayed(h,other(mySeat))){
        // Los dos han jugado -> resolver baza (resolveTrick fija h.turn al ganador)
        resolveTrick(state);
      }else{
        // Esperamos al rival
        h.turn=other(mySeat);
        // El segundo jugador SI puede envidar antes de su primera carta (baza 1)
        const isBaza1=(h.trickHistory||[]).length===0;
        h.envitAvailable=isBaza1; // true si aun estamos en la primera baza
      }
      return true;
    });
  }finally{
    // Desbloquear y forzar re-render para que las cartas vuelvan a ser clickables
    // si Firebase ya respondio mientras uiLocked estaba activo
    setTimeout(()=>{
      uiLocked=false;
      // Forzar re-render desde el ultimo estado de Firebase
      if(roomRef){
        get(roomRef).then(snap=>{if(snap.val())renderAll(snap.val());}).catch(()=>{});
      }
    },380);
  }
}

async function goMazo(){
  await mutate(state=>{
    const h=state.hand;
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(h.turn!==mySeat||h.mode!=='normal'||h.pendingOffer)return false;
    // Ir al mazo: rival wins the hand
    const w=other(mySeat);
    const wName=state.players?.[K(w)]?.name||`J${w}`;
    h.mazo=true; // flag to skip default +1 in applyHandEnd
    if(h.truc.state==='accepted'){
      // Truc was accepted: rival gets the full truc points
      const tp=Number(h.truc.acceptedLevel||0);
      addSA(h,w,tp>0?tp:1);
      pushLog(state,`${wName} guanya +${tp>0?tp:1} (mazo amb truc).`);
    }else{
      // No truc: rival gets 1 point
      addSA(h,w);
      pushLog(state,`${wName} guanya +1 (mazo).`);
    }
    // Override hand winner to be the rival
    h.mazoWinner=w;
    applyHandEnd(state,'Mazo.');return true;
  });
}

async function startOffer(kind){
  await mutate(state=>{
    const h=state.hand;
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(h.turn!==mySeat||h.pendingOffer)return false;
    if(kind==='envit'||kind==='falta'){
      if(!(h.mode==='normal'||h.mode==='respond_truc'))return false;
      if(!h.envitAvailable||h.envit.state!=='none')return false;
      h.resume={mode:h.mode,turn:h.turn};
      const level=kind==='falta'?'falta':2;
      h.pendingOffer={kind:'envit',level,by:mySeat,to:other(mySeat)};
      h.mode='respond_envit';h.turn=other(mySeat);
      const label=kind==='falta'?'falta':'envit';
      const plName=state.players?.[K(mySeat)]?.name||`J${mySeat}`;
      pushLog(state,`${plName} canta ${label}.`);return true;
    }
    if(kind==='truc'){
      if(h.mode!=='normal')return false;
      // Truc only available when truc has never happened
      if(h.truc.state!=='none')return false;
      h.resume={mode:h.mode,turn:h.turn};
      h.pendingOffer={kind:'truc',level:2,by:mySeat,to:other(mySeat)};
      h.mode='respond_truc';h.turn=other(mySeat);h.envitAvailable=true;
      const pn=state.players?.[K(mySeat)]?.name||`J${mySeat}`;
      pushLog(state,`${pn} canta truc.`);return true;
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
      // Points = level of offer being refused (torne=4 -> +2 if refused, envit=2 -> +1)
      const envitPts=offer.level==='falta'?2:offer.level===4?2:1;
      addSA(h,caller,envitPts);h.envitAvailable=false;
      const callerName0=state.players?.[K(caller)]?.name||`J${caller}`;
      pushLog(state,`Envit rebutjat. +${envitPts} ${callerName0}.`);resumeOffer(state);return true;
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
      addSA(h,caller);h.envitAvailable=false;
      const callerName1=state.players?.[K(caller)]?.name||`J${caller}`;
      pushLog(state,`Truc rebutjat. +1 ${callerName1}. Ma perduda.`);
      applyHandEnd(state,'No vull al truc.');return true;
    }
    if(choice==='retruque'){
      if(offer.level!==2)return false;
      h.pendingOffer={kind:'truc',level:3,by:resp,to:caller};
      h.turn=caller;h.mode='respond_truc';h.envitAvailable=true;
      pushLog(state,'Retruque a 3.');return true;
    }
    if(choice==='val4'){
      if(offer.level!==3)return false; // Solo tras retruque
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
    if(!h||state.status!=='playing'||h.status!=='in_progress')return false;
    if(h.turn!==mySeat&&!alreadyPlayed(h,other(mySeat)))return false;
    if(h.pendingOffer?.to===mySeat){
      if(h.pendingOffer.kind==='envit'){
        h.envit={state:'rejected',caller:h.pendingOffer.by,responder:mySeat,acceptedLevel:0,acceptedBy:null};
        addSA(h,h.pendingOffer.by);h.envitAvailable=false;
        pushLog(state,'Temps. Envit rebutjat auto.');resumeOffer(state);return true;
      }
      if(h.pendingOffer.kind==='truc'){
        addSA(h,h.pendingOffer.by);
        pushLog(state,`J${mySeat} perd la ma per temps.`);
        applyHandEnd(state,'Temps exhaurit.');return true;
      }
    }
    if(!alreadyPlayed(h,mySeat)&&h.mode==='normal'){
      addSA(h,other(mySeat));
      pushLog(state,`J${mySeat} perd la ma per temps.`);
      applyHandEnd(state,'Temps exhaurit.');return true;
    }
    return false;
  });
}

// --- Timers -------------------------------------------------------------------
// -- Circular ring helpers -----------------------------------------------------
const RING_C = 2*Math.PI*25; // r=25 for avatar rings // circumference for r=15
function setRing(arcId,ringId,pct,phase){
  const arc=$(arcId);if(!arc)return;
  const dash=RING_C*(Math.max(0,pct)/100);
  arc.style.strokeDasharray=`${dash} ${RING_C}`;
  const color=pct>60?'#2ea043':pct>30?'#e8ab2a':'#da3633';
  arc.style.stroke=color;
}

function stopTurnTimer(){
  clearInterval(turnTimer);turnTimer=null;
  const f=$('turnTimerFill');
  if(f){f.style.transition='none';f.style.width='0%';f.classList.remove('urgent');}
  setRing('myTimerArc','myTimerRing',0,'my');
  setRing('rivalTimerArc','rivalTimerRing',0,'rival');
}
function startTurnTimer(isMyTurn, state){
  stopTurnTimer();
  const f=$('turnTimerFill');
  let rem=TURN_SECS;
  // Show ring on the active player
  if(isMyTurn){
    if(f){f.style.transition='none';f.style.width='100%';}
    setRing('myTimerArc','myTimerRing',100,'my');
    setRing('rivalTimerArc','rivalTimerRing',0,'rival');
  } else {
    if(f){f.style.width='0%';}
    setRing('myTimerArc','myTimerRing',0,'my');
    setRing('rivalTimerArc','rivalTimerRing',100,'rival');
  }
  setTimeout(()=>{
    if(f&&isMyTurn)f.style.transition='width 1s linear';
    turnTimer=setInterval(()=>{
      rem--;
      const pct=Math.max(0,(rem/TURN_SECS)*100);
      if(isMyTurn){
        if(f)f.style.width=pct+'%';
        if(rem<=10){if(f)f.classList.add('urgent');}
        setRing('myTimerArc','myTimerRing',pct,'my');
      } else {
        setRing('rivalTimerArc','rivalTimerRing',pct,'rival');
      }
      if(rem<=5)sndTick();
      if(rem<=0){stopTurnTimer();if(isMyTurn)timeoutTurn();}
    },1000);
  },50);
}
function stopBetween(){
  clearInterval(betweenTimer);betweenTimer=null;
  $('countdownOverlay').classList.add('hidden');
}
function _showCountdownMsg(text){
  let el=$('tableCdEl');
  if(!el){
    el=document.createElement('div');el.id='tableCdEl';el.className='table-cd-msg';
    const cz=document.getElementById('centerZone');
    if(cz)cz.appendChild(el);
  }
  el.innerHTML=text;
  el.classList.remove('table-cd-anim');
  void el.offsetWidth;
  el.classList.add('table-cd-anim');
}
function startBetween(summaryHtml){
  stopBetween();
  // Show summary in the overlay (small card at bottom)
  const ov=$('countdownOverlay'),lbl=$('countdownLabel'),num=$('countdownNum');
  if(lbl&&summaryHtml){lbl.innerHTML=summaryHtml;}
  num.textContent='';
  ov.classList.remove('hidden');
  // Countdown in center of table, like a trucar/envit message
  let n=5;
  // Create persistent countdown element (doesn't re-animate each second)
  let cdEl=$('tableCdEl');
  if(!cdEl){
    cdEl=document.createElement('div');cdEl.id='tableCdEl';cdEl.className='table-cd-fixed';
    const cz=document.getElementById('centerZone');
    if(cz)cz.appendChild(cdEl);
  }
  function tick(){
    if(n<0){
      cdEl.classList.add('hidden');
      stopBetween();if(mySeat===0)dealHand();return;
    }
    cdEl.classList.remove('hidden');
    cdEl.innerHTML=`<div class="cd-subtitle">Seguent ma en...</div><div class="cd-number">${n}</div>`;
    if(n<5)sndTick();
    n--;
    betweenTimer=setTimeout(tick,1000);
  }
  betweenTimer=setTimeout(()=>{tick();},3000); // 3s show summary first
}

// --- Card builders ------------------------------------------------------------
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

// -- Show action label in center of table --------------------------------------
function showTableMsg(text){
  // Show locally
  _showTableMsgLocal(text);
  // Write to Firebase so rival sees it too
  if(roomRef)set(ref(db,`rooms/${roomCode}/msg`),{text,at:Date.now()}).catch(()=>{});
}
function _showTableMsgLocal(text){
  let el=$('tableMsgEl');
  if(!el){
    el=document.createElement('div');el.id='tableMsgEl';el.className='table-msg';
    const cz=document.getElementById('centerZone');
    if(cz)cz.appendChild(el);else document.body.appendChild(el);
  }
  el.textContent=text+'!';
  el.classList.remove('table-msg-anim');
  void el.offsetWidth;
  el.classList.add('table-msg-anim');
}

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

// --- Render -------------------------------------------------------------------

// --- Score summary for between-hands overlay ---------------------------------
function buildScoreSummary(state){
  const logs=state.logs||[];
  const p0=pName(state,0),p1=pName(state,1);
  // Find logs from this hand: stop at the SECOND "Marcador:" entry
  let marcCount=0;
  const handLogs=[];
  for(const l of logs){
    if(l.text?.startsWith('Marcador:')){marcCount++;if(marcCount>=2)break;}
    handLogs.push(l);
  }
  handLogs.reverse(); // oldest first
  
  let pts0=0,pts1=0;
  const rows=[];
  for(const l of handLogs){
    const txt=l.text||'';
    // Match (+N) with or without parens, or just +N before space/end
    const m=txt.match(/\(\+(\d+)\)/)||txt.match(/\+(\d+)(?=[^\d]|$)/);
    if(!m)continue;
    const pts=Number(m[1]);
    let label='',winner='';
    // Determine winner: check name match OR J0/J1 pattern OR +N for p0/p1
    const hasP0name=p0.length>1&&txt.includes(p0);
    const hasP1name=p1.length>1&&txt.includes(p1);
    const hasJ0=txt.match(/\bJ0\b/);
    const hasJ1=txt.match(/\bJ1\b/);
    // If both names appear (eg "Pepe +1 per Manolo"), pick the one after "per" or "per"
    const guessWinner=()=>{
      if(hasP0name&&!hasP1name)return p0;
      if(hasP1name&&!hasP0name)return p1;
      if(hasJ0&&!hasJ1)return p0;
      if(hasJ1&&!hasJ0)return p1;
      return p0; // fallback
    };
    // Detect event type from log text
    if(txt.includes('Envit')&&(txt.includes('guanya')||txt.includes('acceptat'))){
      winner=guessWinner();
      label=`Envit guanyat per <b>${winner}</b>`;
    }else if(txt.includes('Envit')&&txt.includes('rebutjat')){
      winner=guessWinner();
      label=`No vull l'envit - +1 per <b>${winner}</b>`;
    }else if((txt.includes('Truc')||txt.includes('truc')||txt.includes('Retruque')||txt.includes('Val 4'))&&(txt.includes('guanya')||txt.includes('acceptat'))){
      winner=guessWinner();
      label=`Truc guanyat per <b>${winner}</b>`;
    }else if((txt.includes('Truc')||txt.includes('truc'))&&txt.includes('rebutjat')){
      winner=guessWinner();
      label=`No vull el truc - +1 per <b>${winner}</b>`;
    }else if(txt.includes('Ma guanyada')||txt.includes('guanyada')){
      winner=guessWinner();
      label=`Ma guanyada per <b>${winner}</b>`;
    }else if(txt.includes('mazo')||txt.includes('Mazo')){
      winner=guessWinner();
      label=`Al mazo - punt per <b>${winner}</b>`;
    }else if(txt.includes('rebutjat')){
      winner=guessWinner();
      label=`Rebutjat - punt per <b>${winner}</b>`;
    }else{continue;}
    if(winner===p0)pts0+=pts;else pts1+=pts;
    rows.push(`<div class="sum-row"><span class="sum-label">${label}</span><span class="sum-pts">+${pts}</span></div>`);
  }
  
  let html='<div class="summary-events">';
  if(rows.length){html+=rows.join('');}
  else{html+='<div style="color:var(--muted);font-size:12px">Cap punt especial</div>';}
  html+=`</div><div class="sum-result">${p0} <span class="sum-score">${pts0}</span> - <span class="sum-score">${pts1}</span> ${p1}</div>`;
  return html;
}

function renderRivalCards(handObj){
  const z=$('rivalCards');z.innerHTML='';
  const cards=fromHObj(handObj);const n=cards.length;
  // Mostrar siempre el numero real de cartas restantes del rival (boca abajo)
  // Empieza con 3, baja a 2, luego 1 conforme juega
  z.setAttribute('data-count',String(n));
  for(let i=0;i<n;i++){
    const s=document.createElement('div');
    s.className='rival-card-slot';
    // Separacion en abanico: la del medio centrada, las laterales inclinadas
    const angles=n===3?[-8,0,8]:n===2?[-5,5]:[0];
    const xoffs=n===3?[-44,0,44]:n===2?[-24,24]:[0];
    s.style.cssText=`transform:translateX(${xoffs[i]||0}px) rotate(${angles[i]||0}deg);z-index:${i+1};`;
    s.appendChild(buildBack());
    z.appendChild(s);
  }
}

function renderMyCards(state){
  const h=state.hand,z=$('myCards');if(!h){z.innerHTML='';return;}
  const myCards=fromHObj(h.hands?.[K(mySeat)]);
  const played=alreadyPlayed(h,mySeat);
  // Block play if hand should already be over (b1 draw + b2 winner)
  const _ch=h.trickHistory||[];
  const _handDecided=(_ch.length>=1&&_ch[0].winner===null&&_ch.length>=2&&_ch[1].winner!==null)||
                     (_ch.length>=1&&_ch[0].winner!==null&&_ch.length>=2&&_ch[1].winner===null);
  const canPlay=!played&&!uiLocked&&h.turn===mySeat&&h.mode==='normal'&&!h.pendingOffer&&state.status==='playing'&&h.status==='in_progress'&&!_handDecided;
  // Skip full rebuild if hand cards haven't changed (prevents flash)
  const handsKey=myCards.join(',')+'|'+canPlay;
  if(handsKey===_prevHandsKey&&z.children.length===myCards.length)return;
  _prevHandsKey=handsKey;
  z.innerHTML='';

  myCards.forEach(card=>{
    const wrap=document.createElement('div');wrap.className='my-card-wrap';
    const cel=buildCard(card);wrap.appendChild(cel);
    if(canPlay){
      wrap.classList.add('playable');
      wrap.addEventListener('click',()=>{
        if(uiLocked||!wrap.classList.contains('playable'))return;
        z.querySelectorAll('.my-card-wrap').forEach(w=>w.classList.remove('playable'));
        sndCard();animatePlay(cel,card,()=>playCard(card));
      },{once:true});
    }
    z.appendChild(wrap);
  });
}

function renderTrickSnapshot(snapshot){
  // Render saved trick cards (used during between-hands countdown)
  const slot0=$('trickSlot0'),slot1=$('trickSlot1');
  const trickKey='snap|'+snapshot.key;
  if(trickKey===_prevTrickKey)return;
  _prevTrickKey=trickKey;
  slot0.innerHTML='';slot1.innerHTML='';
  slot0.style.cssText='display:flex;flex-direction:row;align-items:flex-end;justify-content:center;gap:5px;min-width:80px;height:114px;position:relative;';
  slot1.style.cssText='display:flex;flex-direction:row;align-items:flex-end;justify-content:center;gap:5px;min-width:80px;height:114px;position:relative;';
  // Show ALL cards at full brightness during countdown/gameover
  snapshot.allTricks.forEach((t,ii)=>{
    [0,1].forEach(seat=>{
      const card=seat===0?t.c0:t.c1;
      if(!card||card===EMPTY_CARD)return;
      const el=buildCard(card);
      el.style.cssText='flex-shrink:0;opacity:1;filter:none;';
      (seat===0?slot0:slot1).appendChild(el);
    });
  });
}

function renderTrick(state){
  const slot0=$('trickSlot0'),slot1=$('trickSlot1');
  const h=state.hand;
  if(!h){slot0.innerHTML='';slot1.innerHTML='';return;}
  // Build a key representing current trick state
  const allT=h.allTricks||[];
  const p0=getPlayed(h,0),p1=getPlayed(h,1);
  const trickKey=allT.length+'|'+(p0||'-')+'|'+(p1||'-');
  if(trickKey===_prevTrickKey)return; // nothing changed, skip
  _prevTrickKey=trickKey;
  slot0.innerHTML='';slot1.innerHTML='';

  const hasCurrent=p0||p1;

  // Each slot holds a flex row of cards side-by-side
  [slot0,slot1].forEach(sl=>{
    sl.style.cssText='display:flex;flex-direction:row;align-items:flex-end;justify-content:center;gap:5px;min-width:80px;height:114px;position:relative;';
  });

  // Dim previous tricks only when a new trick is in progress
  allT.forEach((t,i)=>{
    const isLastResolved=(i===allT.length-1);
    let opacity,filt;
    if(!hasCurrent){
      // No card currently being played: all at full brightness
      opacity=1; filt='none';
    }else{
      // A card is being played: dim older tricks
      opacity=isLastResolved?0.7:0.45;
      filt=isLastResolved?'brightness(0.7)':'brightness(0.4)';
    }
    [0,1].forEach(seat=>{
      const card=seat===0?t.c0:t.c1;
      if(!card||card===EMPTY_CARD)return;
      const el=buildCard(card);
      el.style.cssText=`flex-shrink:0;opacity:${opacity};filter:${filt};transition:opacity .4s,filter .4s;`;
      (seat===0?slot0:slot1).appendChild(el);
    });
  });

  // Current trick - full brightness, animation
  [0,1].forEach(seat=>{
    const card=seat===0?p0:p1;
    if(!card)return;
    const el=buildCard(card);
    el.classList.add('land-anim');
    el.style.cssText='flex-shrink:0;';
    (seat===0?slot0:slot1).appendChild(el);
  });

  // (trick dots removed per request)
}

function renderActions(state){
  const h=state.hand;
  const eB=$('envitBtn'),tB=$('trucBtn'),mB=$('mazoBtn');
  const ra=$('responseArea'),om=$('offerMsg');
  ra.innerHTML='';ra.classList.add('hidden');om.classList.add('hidden');
  const playing=state.status==='playing'&&h?.status==='in_progress';
  if(!playing){eB.disabled=true;tB.disabled=true;mB.disabled=true;
    $('statusMsg').textContent=state.status==='waiting'?'Esperando...':'Partida terminada';return;}
  const myT=h.turn===mySeat,norm=h.mode==='normal',envDone=h.envit.state!=='none';
  const played=alreadyPlayed(h,mySeat);
  // Envit: SOLO antes de que cualquiera juegue la primera carta de la mano
  // = ninguna baza resuelta aun + nadie ha jugado carta en esta primera baza
  const noTricksPlayed=(h.trickHistory||[]).length===0;
  // Envit ok if: first trick, I haven't played my card yet, no envit done
  // --- ENVIT / FALTA ---
  // Available if: no tricks played yet AND I haven't played my first card AND no envit done yet
  const iHaventPlayed=!alreadyPlayed(h,mySeat);
  const envitAvailNow=noTricksPlayed&&iHaventPlayed&&!envDone&&h.truc.state==='none';
  // Also available when responding to truc (before playing card) - per rules
  const canEnvitInTruc=noTricksPlayed&&iHaventPlayed&&!envDone&&h.mode==='respond_truc';
  const envitOk=envitAvailNow||canEnvitInTruc;
  eB.disabled=!envitOk||!myT||!!h.pendingOffer;
  const fB=$('faltaBtn');
  if(fB)fB.disabled=!envitOk||!myT||!!h.pendingOffer;

  // --- TRUC ---
  // Rule: once ANY truc has happened (state!='none'), the Trucar button is DISABLED
  // The only exception is val4 escalation, which appears as a RESPONSE button, not Trucar
  const trucHappened=h.truc.state!=='none';
  const trucPending=!!h.pendingOffer&&h.pendingOffer.kind==='truc';
  tB.disabled=played||!myT||!norm||trucPending||trucHappened;

  // --- MAZO ---
  mB.disabled=played||!myT||!norm||!!h.pendingOffer;
  if(h.pendingOffer&&h.turn===mySeat){
    om.textContent=h.pendingOffer.kind==='envit'
      ?(h.pendingOffer.level==='falta'?'Envit de falta':h.pendingOffer.level===4?'Torne (4)':'Envit')
      :(h.pendingOffer.level===3?'Retruque':h.pendingOffer.level===4?'Val 4':'Truc');
    om.classList.remove('hidden');ra.classList.remove('hidden');
    const add=(l,cls,fn)=>{const b=document.createElement('button');b.textContent=l;b.className=`abtn ${cls}`;b.addEventListener('click',()=>{sndBtn();showTableMsg(l);fn();});ra.appendChild(b);};
    if(h.pendingOffer.kind==='envit'){
      add('Vull','abtn-green',()=>respondEnvit('vull'));add('No vull','abtn-red',()=>respondEnvit('no_vull'));
      if(h.pendingOffer.level===2){add('Torne','abtn-gold',()=>respondEnvit('torne'));add('Falta','abtn-gold',()=>respondEnvit('falta'));}
      else if(h.pendingOffer.level===4)add('Falta','abtn-gold',()=>respondEnvit('falta'));
    }else{
      // When responding to truc: can also envit/falta if haven't played yet
      if(noTricksPlayed&&iHaventPlayed&&!envDone&&h.truc.state==='none'){
        add('Envidar','abtn-green',()=>startOffer('envit'));
        add('Falta','abtn-green',()=>startOffer('falta'));
      }
      add('Vull','abtn-green',()=>respondTruc('vull'));
      add('No vull','abtn-red',()=>respondTruc('no_vull'));
      if(h.pendingOffer.level===2)add('Retruque','abtn-gold',()=>respondTruc('retruque'));
      if(h.pendingOffer.level===3)add('Val 4','abtn-gold',()=>respondTruc('val4'));
    }
  }
  const sm=$('statusMsg');sm.classList.remove('my-turn');
  if(played&&!bothPlayed(h))sm.textContent=`Esperando a ${pName(state,other(mySeat))}...`;
  else if(h.pendingOffer&&h.turn!==mySeat)sm.textContent=`Esperando a ${pName(state,h.turn)}...`;
  else if(!myT&&!played)sm.textContent=`Turno de ${pName(state,h.turn)}`;
  else if(!played&&norm&&!h.pendingOffer){sm.textContent='Tu turno - elige carta o accion';sm.classList.add('my-turn');}
  else sm.textContent='';
}

function updateRivalTimer(state){
  const h=state.hand;
  const my=$('myZone'),riv=$('rivalZone');
  const playing=h&&state.status==='playing'&&h.status==='in_progress';
  const myActive=playing&&(h.turn===mySeat&&!alreadyPlayed(h,mySeat));
  const rivActive=playing&&(h.turn===other(mySeat)&&!alreadyPlayed(h,other(mySeat)));
  if(my){my.classList.toggle('turn-active',!!myActive);}
  if(riv){riv.classList.toggle('turn-active',!!rivActive);}
}

function renderHUD(state){
  $('hudRoom').textContent=`Sala ${roomCode||'-'}`;
  $('hudSeat').textContent=pName(state,mySeat);
  // Show my score first, then rival's
  $('hudScore0').textContent=String(getScore(state,mySeat));
  $('hudScore1').textContent=String(getScore(state,other(mySeat)));
  $('hudState').textContent=state.status==='waiting'?'Esperando':state.status==='playing'?'En juego':'Terminada';
  // Turno: show whose turn it is
  const turnPlayer=state.hand?pName(state,state.hand.turn):pName(state,state.mano);
  $('siMano').textContent=turnPlayer;
  $('siHand').textContent=String(real(state.handNumber||OFFSET));
}

function renderLog(state){
  const a=$('logArea');a.innerHTML='';
  const p0=pName(state,0),p1=pName(state,1);
  (state.logs||[]).slice(0,15).forEach(item=>{
    const d=document.createElement('div');d.className='log-entry';
    let txt=(item.text||'').replace(/\bJ0\b/g,p0).replace(/\bJ1\b/g,p1);
    d.textContent=txt;a.appendChild(d);
  });
}

function detectSounds(state){
  const h=state.hand;if(!h)return;
  if(h.envit.state==='accepted'&&prevEnvSt!=='accepted')sndPoint();
  if(h.truc.state==='accepted'&&prevTrucSt!=='accepted')sndPoint();
  prevEnvSt=h.envit.state||'none';prevTrucSt=h.truc.state||'none';
}

// --- Presence / disconnect ----------------------------------------------------
let _absenceTimer=null;
function checkPresence(){
  if(!roomCode||mySeat===null)return;
  get(ref(db,`rooms/${roomCode}/presence/${K(other(mySeat))}`)).then(snap=>{
    const p=snap.val();
    const absent=p?.absent===true;
    const notif=$('absenceNotif');
    if(notif)notif.classList.toggle('hidden',!absent);
    if(absent&&!_absenceTimer){
      _absenceTimer=setTimeout(async()=>{
        // Give win to me after 60s
        await mutate(state=>{
          if(state.status==='game_over')return false;
          state.status='game_over';
          state.winner=mySeat;
          pushLog(state,pName(state,other(mySeat))+' ha abandonat. Guanyes!');
          return true;
        });
      },60000);
    }else if(!absent&&_absenceTimer){
      clearTimeout(_absenceTimer);_absenceTimer=null;
    }
  }).catch(()=>{});
}

// --- MAIN RENDER --------------------------------------------------------------
function renderAll(room){
  const state=room?.state||defaultState();
  resetInactivity();detectSounds(state);_lastState=state;
  checkPresence();
  renderAvatars(room);
  // Reset render cache when hand changes so new cards animate in properly
  const hKey=real(state.handNumber||OFFSET)+'-'+(state.hand?.mano??'x');
  if(hKey!==(_prevHandKey||'')){_prevHandsKey='';_prevTrickKey='';_prevHandKey=hKey;}
  renderHUD(state);
  $('myName').textContent=pName(state,mySeat);
  $('rivalName').textContent=pName(state,other(mySeat));
  // Sync avatar selection UI
  document.querySelectorAll('.av-opt').forEach((el,i)=>el.classList.toggle('av-selected',i===myAvatar));
  renderRivalCards(state.hand?.hands?.[K(other(mySeat))]);
  updateRivalTimer(state);
  renderMyCards(state);
  // Save trick snapshot whenever we have an active hand
  if(state.hand){
    _lastCompletedTricks={
      allTricks:state.hand.allTricks||[],
      key:real(state.handNumber||OFFSET)+'-'+getTrickIndex(state.hand)
    };
  }
  // Show snapshot (not blank) when hand is null (between hands or game over)
  if(!state.hand&&_lastCompletedTricks){
    renderTrickSnapshot(_lastCompletedTricks);
  }else{
    renderTrick(state);
  }
  renderActions(state);renderLog(state);
  const ready=bothReady(state);

  if(state.status==='game_over'){
    stopBetween();stopTurnTimer();$('waitingOverlay').classList.add('hidden');
    const wasHidden=$('gameOverOverlay').classList.contains('hidden');
    if(wasHidden){
      // Delay 3s so players see the winning card first
      const iWon=state.winner===mySeat;
      setTimeout(()=>{
        $('gameOverOverlay').classList.remove('hidden');
        $('goTitle').textContent=iWon?'🏆 Has guanyat!':'Has perdut';
        $('goWinner').textContent=pName(state,state.winner)+' guanya';
        $('goScore').textContent=`${getScore(state,mySeat)} - ${getScore(state,other(mySeat))}`;
        if(iWon){sndWin();startConfetti(true);}
        else{sndLose();startConfetti(false);}
      },3000);
    }
    renderRematchStatus(state);
    // Don't return early - let renderTrick show the last cards
  }else{
  // Si ya no es game_over (revancha), ocultar overlay
  if(!$('gameOverOverlay').classList.contains('hidden')){
    $('gameOverOverlay').classList.add('hidden');
    stopConfetti();
  }
  }// end else

  if(state.status==='waiting'){
    stopTurnTimer();
    if(real(state.handNumber||OFFSET)===0){
      stopBetween();
      $('waitingCode').textContent=roomCode||'-';
      const p0ready=!!(state.ready?.[K(0)]);
      const p1ready=!!(state.ready?.[K(1)]);
      const myReady=mySeat===0?p0ready:p1ready;
      const rivReady=mySeat===0?p1ready:p0ready;
      if(ready){
        const rivName=pName(state,other(mySeat));
        const readyTxt=rivReady?`${rivName} esta preparat!`:'Esperant que els jugadors estiguen preparats...';
        $('waitingStatus').textContent=readyTxt;
      }else{
        $('waitingStatus').textContent='Esperant el segon jugador...';
      }
      // Only host (seat 0) sees Start button; guest sees ready button + waiting msg
      if(mySeat===0){
        $('startBtn').classList.toggle('hidden',!ready);
        $('waitingNote').textContent='';
        $('guestReadyBtn').classList.add('hidden');
        $('guestWaitMsg').classList.add('hidden');
      }else{
        $('startBtn').classList.add('hidden');
        $('guestReadyBtn').classList.toggle('hidden', myReady);
        $('guestWaitMsg').classList.toggle('hidden', !myReady);
        $('guestWaitMsg').textContent=myReady?'Esperant que el creador inicie...':'';
        $('waitingNote').textContent='';
      }
      $('waitingOverlay').classList.remove('hidden');
    }else{
      $('waitingOverlay').classList.add('hidden');
      if(ready&&betweenTimer===null)startBetween(buildScoreSummary(state));
    }
    return;
  }
  $('waitingOverlay').classList.add('hidden');stopBetween();

  const h=state.hand;
  if(h){
    const myTurn=(h.turn===mySeat&&!alreadyPlayed(h,mySeat)&&h.mode==='normal'&&!h.pendingOffer)||h.pendingOffer?.to===mySeat;
    const tk=`${real(state.handNumber)}-${getTrickIndex(h)}-${h.turn}-${h.mode}-${alreadyPlayed(h,mySeat)?1:0}`;
    if(tk!==prevTurnKey){startTurnTimer(myTurn&&h.status==='in_progress');prevTurnKey=tk;}
  }
}


// --- Confetti -----------------------------------------------------------------
let confettiRAF=null;
function startConfetti(iWon){
  const canvas=$('confettiCanvas');if(!canvas)return;
  canvas.width=window.innerWidth;canvas.height=window.innerHeight;
  const ctx=canvas.getContext('2d');
  const colors=['#f0b429','#2ea043','#da3633','#388bfd','#e040fb','#ff6d00'];
  const particles=Array.from({length:iWon?160:60},()=>({
    x:Math.random()*canvas.width,
    y:-20-Math.random()*60,
    r:4+Math.random()*5,
    d:2+Math.random()*4,
    color:colors[Math.floor(Math.random()*colors.length)],
    tilt:Math.random()*10-5,
    tiltSpeed:0.1+Math.random()*0.15,
    opacity:iWon?1:0.4
  }));
  let frame=0;
  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    frame++;
    particles.forEach(p=>{
      p.y+=p.d;p.x+=Math.sin(frame*0.02)*1.2;p.tilt+=p.tiltSpeed;
      ctx.beginPath();ctx.lineWidth=p.r;ctx.strokeStyle=p.color;ctx.globalAlpha=p.opacity;
      ctx.moveTo(p.x+p.tilt,p.y);ctx.lineTo(p.x+p.tilt+p.r,p.y+p.r*2);ctx.stroke();
      if(p.y>canvas.height+10){p.y=-10;p.x=Math.random()*canvas.width;}
    });
    ctx.globalAlpha=1;
    confettiRAF=requestAnimationFrame(draw);
  }
  draw();
  // Stop after 6s
  setTimeout(stopConfetti,6000);
}
function stopConfetti(){
  if(confettiRAF){cancelAnimationFrame(confettiRAF);confettiRAF=null;}
  const canvas=$('confettiCanvas');if(canvas){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);}
}

// --- Rematch ------------------------------------------------------------------
async function requestRematch(){
  if(!roomRef||mySeat===null)return;
  await mutate(state=>{
    if(!state.rematch)state.rematch={[K(0)]:false,[K(1)]:false};
    state.rematch[K(mySeat)]=true;
    // Si ambos quieren revancha -> resetear partida
    if(state.rematch[K(0)]&&state.rematch[K(1)]){
      state.status='waiting';
      state.scores={[K(0)]:OFFSET,[K(1)]:OFFSET};
      state.handNumber=OFFSET;
      state.mano=other(state.mano); // alterna quien tiene la mano inicial
      state.hand=null;
      state.winner=null;
      state.rematch={[K(0)]:false,[K(1)]:false};
      state.logs=[];
      pushLog(state,'Revancha iniciada!');
    }
    return true;
  });
}

function renderRematchStatus(state){
  const btn=$('goRematchBtn'),st=$('goRematchStatus');
  if(!btn||!st)return;
  const myWant=!!(state.rematch?.[K(mySeat)]);
  const rivWant=!!(state.rematch?.[K(other(mySeat))]);
  if(myWant&&!rivWant){
    btn.disabled=true;btn.textContent='() Esperando revancha...';
    st.textContent=`${pName(state,other(mySeat))} no ha respondido aun`;
  }else if(!myWant){
    btn.disabled=false;btn.textContent='⚔️ Revancha';
    st.textContent=rivWant?`${pName(state,other(mySeat))} quiere la revancha!`:'';
  }
}

// --- Chat ---------------------------------------------------------------------
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

// --- Room ---------------------------------------------------------------------

// --- Avatars ------------------------------------------------------------------
const AVATAR_SVGS=['<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><circle cx="30" cy="30" r="30" fill="#2a6496"/><circle cx="30" cy="24" r="13" fill="#fcd29f"/><circle cx="25" cy="22" r="2" fill="#3d2000"/><circle cx="35" cy="22" r="2" fill="#3d2000"/><circle cx="26" cy="21" r="0.8" fill="#fff"/><circle cx="36" cy="21" r="0.8" fill="#fff"/><path d="M25 29 Q30 34 35 29" stroke="#c0703a" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M20 16 Q23 12 30 13 Q37 12 40 16" stroke="#7a4a10" stroke-width="2.5" fill="#5a3008"/><rect x="8" y="40" width="44" height="22" rx="11" fill="#1a4a7a"/><path d="M20 40 Q30 46 40 40" fill="#fcd29f"/></svg>', '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><circle cx="30" cy="30" r="30" fill="#8b2252"/><circle cx="30" cy="24" r="13" fill="#fde3c8"/><circle cx="25" cy="22" r="2" fill="#3d2000"/><circle cx="35" cy="22" r="2" fill="#3d2000"/><circle cx="26" cy="21" r="0.8" fill="#fff"/><circle cx="36" cy="21" r="0.8" fill="#fff"/><path d="M25 30 Q30 35 35 30" stroke="#d05070" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="30" cy="13" rx="13" ry="5" fill="#d4800a"/><rect x="8" y="40" width="44" height="22" rx="11" fill="#6b1040"/><path d="M20 40 Q30 46 40 40" fill="#fde3c8"/></svg>', '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><circle cx="30" cy="30" r="30" fill="#2e7d32"/><circle cx="30" cy="24" r="13" fill="#ffe0b2"/><circle cx="25" cy="22" r="2" fill="#1a1a1a"/><circle cx="35" cy="22" r="2" fill="#1a1a1a"/><circle cx="26" cy="21" r="0.8" fill="#fff"/><circle cx="36" cy="21" r="0.8" fill="#fff"/><path d="M24 29 Q30 33 36 29" stroke="#b55a00" stroke-width="1.8" fill="none" stroke-linecap="round"/><rect x="17" y="12" width="26" height="7" rx="3" fill="#1a1a1a"/><rect x="8" y="40" width="44" height="22" rx="11" fill="#1b5e20"/><path d="M20 40 Q30 46 40 40" fill="#ffe0b2"/></svg>', '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><circle cx="30" cy="30" r="30" fill="#e65100"/><circle cx="30" cy="24" r="13" fill="#ffd7a8"/><circle cx="25" cy="21" r="2.2" fill="#1a1a1a"/><circle cx="35" cy="21" r="2.2" fill="#1a1a1a"/><circle cx="26" cy="20" r="0.9" fill="#fff"/><circle cx="36" cy="20" r="0.9" fill="#fff"/><ellipse cx="30" cy="26" rx="2" ry="1.2" fill="#c8704a"/><path d="M24 29 Q30 35 36 29" stroke="#b54020" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M22 18 Q24 14 30 15 Q36 14 38 18" stroke="#5a2a00" stroke-width="2" fill="none"/><rect x="8" y="40" width="44" height="22" rx="11" fill="#bf360c"/><path d="M20 40 Q30 46 40 40" fill="#ffd7a8"/></svg>'];
let myAvatar=Number(localStorage.getItem('truc_avatar')||0);

function pickAvatar(idx){
  // Don't allow picking rival's avatar
  if(idx===_rivalAvatarIdx&&_rivalAvatarIdx>=0)return;
  myAvatar=idx;
  localStorage.setItem('truc_avatar',String(idx));
  document.querySelectorAll('.av-opt').forEach((el,i)=>el.classList.toggle('av-selected',i===idx));
  if(roomRef&&mySeat!==null){
    set(ref(db,`rooms/${roomCode}/avatars/${K(mySeat)}`),idx).catch(()=>{});
  }
}
// Expose globally so HTML onclick works AND attach via JS
window.pickAvatar=pickAvatar;

function getRivalAvatar(){
  if(!roomRef||mySeat===null)return -1;
  // Read from last known state
  return _rivalAvatarIdx;
}

let _rivalAvatarIdx=-1;
function getAvatarSvg(idx){return AVATAR_SVGS[idx]||AVATAR_SVGS[0];}

function renderAvatars(room){
  const avs=room?.avatars||{};
  const myIdx=Number(avs[K(mySeat)]??myAvatar);
  const rivIdx=Number(avs[K(other(mySeat))]??-1);
  _rivalAvatarIdx=rivIdx;
  const myEl=$('myAv'),rivEl=$('rivalAv');
  if(myEl)myEl.innerHTML=getAvatarSvg(myIdx);
  if(rivEl&&rivIdx>=0)rivEl.innerHTML=getAvatarSvg(rivIdx);
  // Gray out avatar options that the rival has chosen
  document.querySelectorAll('.av-opt').forEach((el,i)=>{
    const takenByRival=i===rivIdx&&rivIdx>=0;
    el.classList.toggle('av-taken',takenByRival);
    el.style.opacity=takenByRival?'0.3':'1';
    el.title=takenByRival?'Aquest avatar l\'usa el teu rival':'';
  });
}


// -- Quick join panel (shown when clicking a room from the list) --------------
function showQuickJoin(code, hostName){
  // Remove existing if any
  const existing=$('qjOverlay');
  if(existing)existing.remove();

  // Centered overlay modal — only asks for nick
  const overlay=document.createElement('div');
  overlay.id='qjOverlay';
  overlay.className='qj-overlay';
  overlay.innerHTML=`
    <div class="qj-modal">
      <div class="qj-title">Unir-se a la sala de <b>${hostName}</b></div>
      <div class="lfield" style="margin:12px 0 4px">
        <label>El teu nom</label>
        <input id="qjName" type="text" placeholder="Ej. Vicent" maxlength="24" autocomplete="off" />
      </div>
      <div class="qj-hint">Podras triar avatar en la seguent pantalla</div>
      <div class="qj-btns">
        <button id="qjJoinBtn" class="lbtn lbtn-primary">Entrar!</button>
        <button id="qjCancelBtn" class="lbtn lbtn-secondary">Cancel.lar</button>
      </div>
      <div id="qjMsg" class="lobby-msg"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Pre-fill saved name
  const saved=localStorage.getItem('truc_name')||localStorage.getItem('truc_name_key')||'';
  const nameEl=overlay.querySelector('#qjName');
  if(saved)nameEl.value=saved;
  setTimeout(()=>nameEl.focus(),50);

  // Close on backdrop click
  overlay.addEventListener('click',e=>{ if(e.target===overlay)overlay.remove(); });
  overlay.querySelector('#qjCancelBtn').addEventListener('click',()=>overlay.remove());

  const doJoin=()=>{
    const name=normName(nameEl.value);
    if(!name){overlay.querySelector('#qjMsg').textContent='Escriu el teu nom!';return;}
    $('nameInput').value=name;
    $('roomInput').value=code;
    overlay.remove();
    joinRoom();
  };
  overlay.querySelector('#qjJoinBtn').addEventListener('click',doJoin);
  nameEl.addEventListener('keydown',e=>{ if(e.key==='Enter')doJoin(); });
}


// -- Available rooms list ---------------------------------------------------
let _lastRoomListKey='';
async function loadRoomList(){
  const listEl=$('roomList');if(!listEl)return;
  try{
    const snap=await get(ref(db,'rooms'));
    const rooms=snap.val();
    const open=[];
    if(rooms){
      for(const[code,room] of Object.entries(rooms)){
        const st=room?.state;
        if(!st||st.status==='game_over')continue;
        const p0=st.players?.[K(0)];
        const p1=st.players?.[K(1)];
        if(p0&&!p1){
          const inactive=Date.now()-(room.lastActivity||0)>3600000;
          if(!inactive)open.push({code,host:p0.name,createdAt:room.meta?.createdAt||0});
        }
      }
    }
    open.sort((a,b)=>b.createdAt-a.createdAt);
    // Only redraw if data actually changed
    const newKey=open.map(r=>r.code+r.host).join('|');
    if(newKey===_lastRoomListKey)return;
    _lastRoomListKey=newKey;
    listEl.innerHTML='';
    if(!open.length){
      listEl.innerHTML='<div class="rl-empty">Cap sala oberta</div>';
      return;
    }
    open.forEach(r=>{
      const row=document.createElement('div');row.className='rl-row';
      row.innerHTML=`<div class="rl-info"><span class="rl-code">${r.code}</span><span class="rl-host">${r.host}</span></div><button class="lbtn lbtn-primary rl-join">Unir-se</button>`;
      row.querySelector('.rl-join').addEventListener('click',()=>{
        showQuickJoin(r.code, r.host);
      });
      listEl.appendChild(row);
    });
  }catch(e){
    // Silently ignore errors to avoid showing flicker
  }
}

let unsubMsg=null;
function startSession(code){
  roomCode=code;roomRef=ref(db,`rooms/${code}`);
  if(unsubGame)unsubGame();
  unsubGame=onValue(roomRef,snap=>renderAll(snap.val()));
  initChat(code);
  // Listen for table messages (sent by either player)
  if(unsubMsg)unsubMsg();
  let lastMsgAt=0;
  unsubMsg=onValue(ref(db,`rooms/${code}/msg`),snap=>{
    const m=snap.val();
    if(m&&m.at>lastMsgAt&&m.at>Date.now()-5000){
      lastMsgAt=m.at;
      _showTableMsgLocal(m.text);
    }
  });
  // Presence: mark player as connected; on disconnect mark absent
  if(mySeat!==null){
    const presRef=ref(db,`rooms/${code}/presence/${K(mySeat)}`);
    onDisconnect(presRef).set({absent:true,at:Date.now()});
    set(presRef,{absent:false,at:Date.now()}).catch(()=>{});
  }
  $('screenLobby').classList.add('hidden');$('screenGame').classList.remove('hidden');
}
function setLobbyMsg(txt,cls){const el=$('lobbyMsg');el.textContent=txt;el.className='lobby-msg'+(cls?' '+cls:'');}

async function createRoom(){
  const name=normName($('nameInput').value);
  const code=sanitize($('roomInput').value)||Math.random().toString(36).slice(2,6).toUpperCase();
  const r=ref(db,`rooms/${code}`);
  const ex=await get(r);if(ex.exists()){setLobbyMsg('Sala ja existeix.','err');return;}
  const init=defaultState();init.roomCode=code;
  init.players[K(0)]={name,clientId:uid()};
  init.logs=[{text:`Sala creada per ${name}.`,at:Date.now()}];
  await set(r,{meta:{createdAt:Date.now(),roomCode:code},state:init,lastActivity:Date.now()});
  mySeat=0;saveLS(name,code,0);$('roomInput').value=code;
  set(ref(db,`rooms/${code}/avatars/${K(0)}`),myAvatar).catch(()=>{});
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
  else if(p0?.name===name)mySeat=0;else mySeat=1;
  saveLS(name,code,mySeat);setLobbyMsg(`Unit com J${mySeat}.`,'good');startSession(code);
}

async function leaveRoom(){
  stopBetween();stopTurnTimer();
  if(roomRef&&mySeat!=null){try{await remove(ref(db,`rooms/${roomCode}/state/players/${K(mySeat)}`));}catch(e){}}
  localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);location.reload();
}

// --- Events -------------------------------------------------------------------
$('createBtn').addEventListener('click',createRoom);
$('joinBtn').addEventListener('click',joinRoom);
$('leaveBtn').addEventListener('click',leaveRoom);
$('goLeaveBtn').addEventListener('click',leaveRoom);
$('goRematchBtn')?.addEventListener('click',requestRematch);
$('guestReadyBtn')?.addEventListener('click',async()=>{
  sndBtn();
  $('guestReadyBtn').classList.add('hidden');
  $('guestWaitMsg').classList.remove('hidden');
  await mutate(state=>{
    if(!state.ready)state.ready={[K(0)]:false,[K(1)]:false};
    state.ready[K(mySeat)]=true;
    pushLog(state,pName(state,mySeat)+' esta preparat!');
    return true;
  });
});
$('startBtn').addEventListener('click',async()=>{sndBtn();$('waitingOverlay').classList.add('hidden');await dealHand();});
$('envitBtn').addEventListener('click',()=>{sndBtn();showTableMsg('Envit!');startOffer('envit');});
$('faltaBtn')?.addEventListener('click',()=>{sndBtn();showTableMsg('Falta!');startOffer('falta');});
$('trucBtn').addEventListener('click',()=>{sndBtn();showTableMsg('Truc!');startOffer('truc');});
$('mazoBtn').addEventListener('click',()=>{sndBtn();showTableMsg('Al Mazo');goMazo();});
$('logToggle').addEventListener('click',()=>{
  const b=$('logBody');b.classList.toggle('hidden');
  $('logToggle').textContent=b.classList.contains('hidden')?'> Registro':'v Registro';
});
$('chatToggle').addEventListener('click',()=>{
  chatOpen=!chatOpen;$('chatBox').classList.toggle('hidden',!chatOpen);
  if(chatOpen){$('chatBadge').classList.add('hidden');setTimeout(()=>{$('chatMessages').scrollTop=$('chatMessages').scrollHeight;$('chatInput').focus();},50);}
});
$('chatSend').addEventListener('click',sendChat);
$('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')sendChat();});

// --- Boot ---------------------------------------------------------------------
// Attach avatar click listeners via JS (module scope)
document.querySelectorAll('.av-opt').forEach((el,i)=>{
  el.addEventListener('click',()=>pickAvatar(i));
});
// Restore saved avatar selection
pickAvatar(myAvatar);
loadLS();
// Load available rooms
loadRoomList();
// Refresh list every 10s while on lobby
setInterval(()=>{ if(!$('screenLobby').classList.contains('hidden'))loadRoomList(); },5000);
(async()=>{
  const _sr=localStorage.getItem(LS.room);
  if(_sr){
    const _code=sanitize(_sr);
    // Validar que la sala existe en Firebase antes de reconectarse
    try{
      const snap=await get(ref(db,`rooms/${_code}`));
      if(snap.exists()&&snap.val()?.state){
        roomCode=_code;$('roomInput').value=_code;
        const _ss=localStorage.getItem(LS.seat);if(_ss!=null)mySeat=Number(_ss);
        startSession(_code);
        return;
      }
    }catch(e){}
    // Sala no existe: limpiar localStorage
    localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);
  }
})();
