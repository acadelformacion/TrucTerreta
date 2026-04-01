// --- Lógica de mano / bazas (extraído de game.js) ----------------------------

const K  = n => `_${n}`;          // seat: 0->"_0"
const PK = n => `p${n}`;          // played key: 0->"p0"
const HKEYS = ['a','b','c'];
const EMPTY_CARD = '~';            // marcador "no jugada" (valor no valido)
const OFFSET    = 10; // scores/trickWins stored +10
const SUIT_ORDER=['oros','copas','espadas','bastos'];

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

const getPlayed = (h, seat) => {
  const v = h?.played?.[PK(seat)];
  return (v && v !== EMPTY_CARD) ? v : null;
};
const resetPlayed = (h) => {
  h.played = {[PK(0)]:EMPTY_CARD,[PK(1)]:EMPTY_CARD};
};

const real=n=>Number(n||OFFSET)-OFFSET; // decode stored value
const other=s=>s===0?1:0;

function getScore(st,seat){return real(st?.scores?.[K(seat)]);}
function addScore(st,seat,pts){if(!st.scores)st.scores={[K(0)]:OFFSET,[K(1)]:OFFSET};st.scores[K(seat)]=(Number(st.scores[K(seat)]||OFFSET))+pts;}
function getTW(h,seat){return real(h?.trickWins?.[K(seat)]);}
function addTW(h,seat){h.trickWins[K(seat)]=(Number(h.trickWins[K(seat)]||OFFSET))+1;}
function getSA(h,seat){return real(h?.scoreAwards?.[K(seat)]);}
function pushLog(st,text){st.logs=st.logs||[];st.logs.unshift({text,at:Date.now()});st.logs=st.logs.slice(0,30);}

export function getTrickIndex(h){return real(h?.trickIndex);}

function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function buildDeck(){const c=[],n=[1,2,3,4,5,6,7,10,11,12];for(const s of SUIT_ORDER)for(const x of n)c.push(`${x}_${s}`);return c;}

export const TRG=[
  ['1_espadas'],['1_bastos'],['7_espadas'],['7_oros'],
  ['3_oros','3_copas','3_espadas','3_bastos'],['2_oros','2_copas','2_espadas','2_bastos'],
  ['1_oros','1_copas'],
  ['12_oros','12_copas','12_espadas','12_bastos'],['11_oros','11_copas','11_espadas','11_bastos'],
  ['10_oros','10_copas','10_espadas','10_bastos'],['7_copas','7_bastos'],
  ['6_oros','6_copas','6_espadas','6_bastos'],['5_oros','5_copas','5_espadas','5_bastos'],
  ['4_oros','4_copas','4_espadas','4_bastos']
];
export const TR=(()=>{const m={};let s=100;for(const g of TRG){for(const c of g)m[c]=s;s-=10;}return m;})();

export function parseCard(c){const[n,s]=String(c).split('_');return{num:Number(n),suit:s};}
function envitVal(c){const n=parseCard(c).num;return n>=10?0:n;}
function trickRank(c){return TR[c]??0;}
export function cmpTrick(a,b){const d=trickRank(a)-trickRank(b);return d>0?1:d<0?-1:0;}
export function bestEnvit(cards){
  if(!cards?.length)return 0;let best=0;
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
    const a=parseCard(cards[i]),b=parseCard(cards[j]);
    if(a.suit===b.suit){const v=20+envitVal(cards[i])+envitVal(cards[j]);if(v>best)best=v;}
  }
  return best>0?best:Math.max(0,...cards.map(envitVal));
}

// --- Hand factory -------------------------------------------------------------
export function makeHand(mano){
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

// --- Game logic ---------------------------------------------------------------
export function handWinner(state){
  const h=state.hand;
  const hist=h.trickHistory||[];
  
  // Extraemos quién ganó cada baza (0, 1 o 99 para empate)
  const r1=hist[0]?.winner; 
  const r2=hist[1]?.winner;
  const r3=hist[2]?.winner;

  // 1. Victoria por "vía rápida" (2 bazas ganadas)
  const wins0 = hist.filter(t => t.winner === 0).length;
  const wins1 = hist.filter(t => t.winner === 1).length;
  if(wins0 >= 2) return 0;
  if(wins1 >= 2) return 1;

  // 2. Lógica de EMPATES (Pardas)
  
  // Si la primera es parda...
  if(r1 === 99){
    if(r2 !== 99 && r2 !== undefined) return r2; // Gana el de la 2ª
    if(r3 !== 99 && r3 !== undefined) return r3; // Gana el de la 3ª
    return state.mano; // Las tres pardas: gana el Mano
  }

  // Si la primera la ganó alguien...
  if(r1 !== 99 && r1 !== undefined){
    if(r2 === 99) return r1; // 1ª ganada, 2ª parda: Gana el de la 1ª
    
    // Si la 1ª la ganó uno y la 2ª el otro...
    if(r2 !== 99 && r2 !== r1){
      if(r3 === 99) return r1; // 3ª parda: Gana el de la 1ª
      if(r3 !== undefined) return r3; // 3ª ganada: Gana el de la 3ª
    }
  }

  return r1 !== 99 && r1 !== undefined ? r1 : state.mano;
}

export function applyHandEnd(state, reason, foldedSeat) {
  const h=state.hand;if(!h)return;
  
  const finish=()=>{
    const s0=getScore(state,0),s1=getScore(state,1);
    if(s0>=12||s1>=12){
      state.status='game_over';
      state.winner=s0>s1?0:s1>s0?1:state.mano;
      state.hand=null;return true;
    }return false;
  };

  // NUEVO: Detectamos si alguien abandonó la mano ("Me'n vaig")
  const isFold = foldedSeat !== undefined && foldedSeat !== null;
  const winnerSeat = isFold ? other(foldedSeat) : null;

  // --- 1. RESOLVER ENVIT ---
  if(h.envit.state==='accepted'){
    // Si el envite se aceptó, calculamos quién tiene más puntos de flor/envit
    let ew = isFold ? winnerSeat : null;
    if (ew === null) {
      const v0=bestEnvit(fromHObj(h.hands?.[K(0)]));
      const v1=bestEnvit(fromHObj(h.hands?.[K(1)]));
      ew = v0>v1 ? 0 : v1>v0 ? 1 : state.mano;
    }
    // Tu lógica de puntos para la Falta (12 - máxima puntuación) está perfecta
    const ep=h.envit.acceptedLevel==='falta'? 12-Math.max(getScore(state,0),getScore(state,1)) : Number(h.envit.acceptedLevel||0);
    const ewName=state.players?.[K(ew)]?.name||`J${ew}`;
    addScore(state,ew,ep);
    pushLog(state, isFold ? `Envit: guanya ${ewName} per abandó (+${ep}).` : `Envit: guanya ${ewName} (+${ep}).`);
    if(finish())return;
  } 
  else if (isFold && h.pendingOffer?.kind === 'envit') {
    // ¡AQUÍ ESTÁ EL CAMBIO! Si alguien se va al mazo con un envite/falta pendiente de responder:
    const off = h.pendingOffer;
    // Si me habían cantado Falta (sobre un envite previo) o un Torne (4) y me voy, son 2 puntos.
    // Si solo me habían envidado de primeras y me voy, es 1 punto.
    const puntos = (off.level === 'falta' || off.level === 4) ? 2 : 1;
    
    addScore(state, winnerSeat, puntos);
    pushLog(state, `Envit abandonat: +${puntos} per al rival.`);
    if(finish()) return;
  }

  // (Saltamos premios extra si alguien huye)
  for(const s of[0,1]){const pts=getSA(h,s);if(pts>0)addScore(state,s,pts);}
  if(finish())return;
  
  // --- 2. RESOLVER TRUC Y LA MANO ---
  if(h.truc.state==='accepted'){
    const tw = isFold ? winnerSeat : handWinner(state);
    const tp = Number(h.truc.acceptedLevel||0);
    const twName=state.players?.[K(tw)]?.name||`J${tw}`;
    addScore(state,tw,tp);
    pushLog(state, isFold ? `Truc: guanya ${twName} per abandó (+${tp}).` : `Truc: guanya ${twName} (+${tp}).`);
    if(finish())return;
  } else {
    // Ningún truc aceptado, o se va al mazo cuando le acaban de cantar Truc/Retruc
    const hw = isFold ? winnerSeat : handWinner(state);
    if(hw!==null&&hw!==undefined){
      const hwName=state.players?.[K(hw)]?.name||`J${hw}`;
      // Si se va al mazo, pierde el nivel que ya estuviera asegurado (ej: 1 si es normal, 2 si ya había un truc aceptado de antes).
      const tp = isFold ? (Number(h.truc.acceptedLevel||0) || 1) : 1;
      addScore(state,hw,tp);
      pushLog(state, isFold ? `Mà guanyada per ${hwName} per abandó (+${tp}).` : `Mà guanyada per ${hwName} (+1).`);
    }
    if(finish())return;
  }

  if(reason)pushLog(state,reason);
  pushLog(state,`Marcador: ${getScore(state,0)}-${getScore(state,1)}`);
  state.mano=other(state.mano);state.turn=state.mano;
  state.status='waiting';state.hand=null;
  state.handNumber=(Number(state.handNumber||10))+1;
}

export function resolveTrick(state){
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
  const newAllTricks=(h.allTricks||[]).concat([{c0:c0||EMPTY_CARD,c1:c1||EMPTY_CARD,w:w===null?99:w}]);
  h.allTricks=newAllTricks;
  state.lastAllTricks=newAllTricks;
  // RESET played con EMPTY_CARD - nunca borramos el nodo
  resetPlayed(h);
  h.mode='normal';
  // Envit SOLO permitido antes de jugar la 1a carta de la 1a baza
  h.envitAvailable=false;
  
  const w0=getTW(h,0), w1=getTW(h,1);
  const tIdx=getTrickIndex(h);
  
  // --- Comprobación de final de mano ---
  const hist = h.trickHistory || [];
  const b1 = hist[0]?.winner;
  const b2 = hist[1]?.winner;

  // Nueva lógica de handOver:
  // Se acaba si: alguien tiene 2 victorias, si ya hemos jugado las 3 bazas,
  // O si hay un ganador tras una parda (B1 parda y B2 decidida, o B1 decidida y B2 parda).
  const handOver = w0>=2 || w1>=2 || tIdx>=3 || (b1===99 && b2!==99 && b2!==undefined) || (b1!==99 && b2===99);

  if(handOver){
    const hw = handWinner(state); // Aquí llamamos a la función de pardas que arreglamos antes
    const hwName = state.players?.[K(hw)]?.name || `Jugador ${hw}`;
    applyHandEnd(state, `Mà guanyada per ${hwName}.`);
  }
}