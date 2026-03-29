// --- Truc Valenciano . ui.js (interfaz + arranque) ----------------------------
// Firebase borra nodos vacios, null y false. Soluciones:
//   * Claves de asiento: "_0","_1" (no "0","1" -> array)
//   * Manos: objeto {a,b,c} con las cartas
//   * Cartas jugadas: guardadas en h.played como {p0:"carta",p1:"carta"}
//     El nodo NUNCA se borra; se resetea con un marcador "~" entre bazas.
//   * Contadores: almacenados +10 para que nunca sean 0.
import {
  db, session,
  ref, get, set, push, remove, onValue, runTransaction, onDisconnect
} from './firebase.js';
import * as Logica from './logica.js';
import {
  defaultState,
  configureActions,
  ui,
  dealHand,
  playCard,
  goMazo,
  startOffer,
  respondEnvit,
  respondTruc,
  timeoutTurn,
  requestRematch,
  claimWinByRivalAbsence,
  guestReady
} from './acciones.js';
// --- SISTEMA DE FRASES GLOBAL (Al principio del archivo) ---
window.canChat = true;
window.mySelectedPhrases = [];

const radialPhrasesList = [
  "⚔️ Ara sí que va de bo!", "🏅Hui no fas ni un punt.", "🌿 Açò és mel de romer.",
  "💣 Va, que esta cau.", "💰 Esta mà val or.", "🖐️ Vine, vine, que t'espere.",
  "🦁 A vore si tens valor.", "😳 Això és tot el que portes?", "🔝 De categoria.",
  "😲 No me l’esperava.", "🏟️ Ací encara hi ha partida.", "🧱 Has vingut a fer bulto.",
  "👵 Ma huela havera jugat millor!", "🙊 No tens res i ho saps.", "🥚 Ara apreta el botó si tens collons.",
  "🐔 Tens por o què?", "🍀 Xe, quina potra que tens!", "👿 Redeu, quines cartes m’has donat!",
  "📉 Hui no en guanye ni una!", "🤡 Això és un 'vull i no puc'.", "👣 Hui t’has alçat amb el peu esquerre.",
  "🤥 Mal farol has soltat!", "🧐 Això no t'ho creus ni tu!", "🌙 Tira ja que es fa de nit!"
];
window.initChatPhrases = function() {
  const menu = document.getElementById('myRadialMenu');
  if (!menu) return;

  window.mySelectedPhrases = [...radialPhrasesList].sort(() => 0.5 - Math.random()).slice(0, 8);
  
  menu.innerHTML = '';
  window.mySelectedPhrases.forEach((phrase, i) => {
    const btn = document.createElement('div');
    btn.className = 'radial-option';
    btn.textContent = phrase;
    
    // ÁNGULO NUEVO: De -110 (arriba) a -10 (derecha media). 
    // Así evitamos que bajen hacia la barra inferior.
    const angle = -110 + (i * (100 / 7)); 
    const radius = 95; // Más cerca del avatar (antes 130)
    
    const x = Math.cos(angle * Math.PI / 180) * radius;
    const y = Math.sin(angle * Math.PI / 180) * radius;

    btn.style.left = x + "px";
    btn.style.top = y + "px";
    
    btn.onclick = (e) => {
      e.stopPropagation();
      window.sendPhrase(phrase);
    };
    menu.appendChild(btn);
  });
};

window.sendPhrase = function(text) {
  if (!window.canChat) return;

  // 1. Mostrar en MI pantalla
  window.showBubble('myBubble', text);
  
  // 2. ENVIAR AL RIVAL
if (typeof socket !== 'undefined') {
  socket.emit('enviar_frase', { frase: text });
}

// 3. RECIBIR DEL RIVAL (Pégalo aquí mismo)
if (typeof socket !== 'undefined') {
  socket.on('recibir_frase', (data) => {
      if (window.showBubble) {
          window.showBubble('rivalBubble', data.frase);
      }
  });
}

  // 4. Cerrar menú y bloquear 10s
  const menu = document.getElementById('myRadialMenu');
  if(menu) menu.classList.remove('active');
  
  window.canChat = false;
  const myAv = document.getElementById('myAv');
  if(myAv) myAv.classList.add('av-frozen');

  setTimeout(() => { 
    const b = document.getElementById('myBubble');
    if(b) b.classList.add('hidden'); 
  }, 3500);

  setTimeout(() => {
    window.canChat = true;
    if(myAv) myAv.classList.remove('av-frozen');
  }, 10000);
};

// 3. RECIBIR DEL RIVAL
// Esta función debes llamarla cuando el servidor te avise de que el rival habló
window.recibirFraseRival = function(text) {
    window.showBubble('rivalBubble', text);
};

window.showBubble = function(id, text) {
    const bubble = document.getElementById(id);
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.remove('hidden');
    setTimeout(() => bubble.classList.add('hidden'), 3500);
}

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

const SUITS={oros:{label:'oros',cls:'s-oros'},copas:{label:'copas',cls:'s-copas'},espadas:{label:'espadas',cls:'s-espadas'},bastos:{label:'bastos',cls:'s-bastos'}};

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
let unsubGame=null,unsubChat=null;
let inactTimer=null,betweenTimer=null,turnTimer=null;
let prevTurnKey='',prevEnvSt='none',prevTrucSt='none';
let chatOpen=false,lastChatN=0;
let _lastState=null; // ultimo estado conocido para uso en helpers de render
// Render tracking - avoid unnecessary DOM rebuilds that cause flash
let _prevHandsKey='';  // tracks hand cards state
let _prevTrickKey='';  // tracks trick cards state
let _prevHandKey='';   // tracks which hand we're in
let _lastCompletedTricks=null; // snapshot of trick cards to show during countdown
window.initChatPhrases();
const $=id=>document.getElementById(id);
const uid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const sanitize=s=>String(s||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
const normName=s=>String(s||'').trim().slice(0,24)||'Invitado';
const other=s=>s===0?1:0;
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const real=n=>Number(n||OFFSET)-OFFSET; // decode stored value

function cardLabel(c){const{num,suit}=Logica.parseCard(c);return`${num} de ${SUITS[suit]?.label}`;}
function pName(st,seat){return st?.players?.[K(seat)]?.name||`Jugador ${seat}`;}
function bothReady(st){return !!(st?.players?.[K(0)]&&st?.players?.[K(1)]);}
function getScore(st,seat){return real(st?.scores?.[K(seat)]);}
function addScore(st,seat,pts){if(!st.scores)st.scores={[K(0)]:OFFSET,[K(1)]:OFFSET};st.scores[K(seat)]=(Number(st.scores[K(seat)]||OFFSET))+pts;}
function getTW(h,seat){return real(h?.trickWins?.[K(seat)]);}
function addTW(h,seat){h.trickWins[K(seat)]=(Number(h.trickWins[K(seat)]||OFFSET))+1;}
function getSA(h,seat){return real(h?.scoreAwards?.[K(seat)]);}
// Ahora, si no le decimos nada suma 1, pero si le pasamos un 2, sumará 2.
function addSA(h,seat,pts=1){
  h.scoreAwards[K(seat)]=(Number(h.scoreAwards[K(seat)]||OFFSET))+pts;
}
function pushLog(st,text){st.logs=st.logs||[];st.logs.unshift({text,at:Date.now()});st.logs=st.logs.slice(0,30);}

function loadLS(){
  const n=localStorage.getItem(LS.name),r=localStorage.getItem(LS.room),s=localStorage.getItem(LS.seat);
  if(n)$('nameInput').value=n;if(r)$('roomInput').value=r;if(s!=null)session.mySeat=Number(s);
}
function saveLS(n,c,s){localStorage.setItem(LS.name,n||'');localStorage.setItem(LS.room,c||'');localStorage.setItem(LS.seat,String(s));}
function resetInactivity(){
  clearTimeout(inactTimer);
  inactTimer=setTimeout(async()=>{if(session.roomRef)try{await remove(session.roomRef);}catch(e){}
    localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);location.reload();},INACT_MS);
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
      stopBetween();if(session.mySeat===0)dealHand();return;
    }
    cdEl.classList.remove('hidden');
    cdEl.innerHTML=`<div class="cd-subtitle">Següent mà en...</div><div class="cd-number">${n}</div>`;
    if(n<5)sndTick();
    n--;
    betweenTimer=setTimeout(tick,1000);
  }
  betweenTimer=setTimeout(()=>{tick();},3000); // 3s show summary first
}

function buildCard(card){
  const{num,suit}=Logica.parseCard(card);
  // Imagen por carta: 1 de oros => "1o.jpg", 3 de copas => "3c.jpg", etc.
  const suitLetter={oros:'o',copas:'c',espadas:'e',bastos:'b'}[suit]||'';
  const imgCode=`${num}${suitLetter}`;
  const el=document.createElement('div');
  el.className=`playing-card ${SUITS[suit]?.cls||''} use-img`;
  const img=document.createElement('img');
  img.className='card-art';
  img.alt=`${num}${suitLetter}`;
  img.draggable=false;
  img.src=`./Media/Images/Cards/${imgCode}.jpg`;
  el.appendChild(img);
  return el;
}
function buildBack(){const el=document.createElement('div');el.className='card-back';return el;}

// -- Show action label in center of table --------------------------------------
// --- Nueva función de mensajes con "Bocadillos" y sincronización ---
export function showTableMsg(text, isMine = true) {
  // A. PARTE VISUAL (Lo que ves tú)
  const bubble = document.createElement('div');
  bubble.className = `table-msg-bubble ${isMine ? 'msg-mine' : 'msg-rival'}`;
  bubble.textContent = text.toUpperCase() + '!';
  document.body.appendChild(bubble);

  setTimeout(() => { if(bubble) bubble.remove(); }, 1800);

  // B. PARTE DE RED (Solo si yo soy el que ha pulsado el botón)
  if (isMine && session.roomCode) {
    set(ref(db, `rooms/${session.roomCode}/msg`), {
      text: text,
      at: Date.now(),
      sender: session.mySeat // <--- ESTO ES VITAL para el punto 1
    }).catch(() => {});
  }
}

function animatePlay(cardEl,card,onDone){
  const slot=$('trickGrid'); 
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
  const myCards=fromHObj(h.hands?.[K(session.mySeat)]);
  const played=alreadyPlayed(h,session.mySeat);
  // Block play if hand should already be over (b1 draw + b2 winner)
  const _ch=h.trickHistory||[];
  const _handDecided=(_ch.length>=1&&_ch[0].winner===null&&_ch.length>=2&&_ch[1].winner!==null)||
                     (_ch.length>=1&&_ch[0].winner!==null&&_ch.length>=2&&_ch[1].winner===null);
  const canPlay=!played&&!ui.locked&&h.turn===session.mySeat&&h.mode==='normal'&&!h.pendingOffer&&state.status==='playing'&&h.status==='in_progress'&&!_handDecided;
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
        if(ui.locked||!wrap.classList.contains('playable'))return;
        z.querySelectorAll('.my-card-wrap').forEach(w=>w.classList.remove('playable'));
        sndCard();animatePlay(cel,card,()=>playCard(card));
      },{once:true});
    }
    z.appendChild(wrap);
  });
}
function _renderTrickGrid(allTricks, curP0, curP1){
  const grid = $('trickGrid');
  if(!grid) return;
  grid.innerHTML = '';

  const me = session.mySeat, rival = other(session.mySeat);
  const hasCurrent = curP0 || curP1;
  if(allTricks.length === 0 && !hasCurrent) return;

  allTricks.forEach(t => {
    const col = document.createElement('div');
    col.className = 'trick-col';
    const isDraw = (t.w === 99 || t.w === null || t.w === undefined);
    if(isDraw) col.classList.add('trick-draw');

    const cellRival = document.createElement('div');
    cellRival.className = 'trick-cell-rival';
    const cardRivalCode = rival === 0 ? t.c0 : t.c1;
    if(cardRivalCode && cardRivalCode !== EMPTY_CARD){
      const el = buildCard(cardRivalCode);
      if(!isDraw && t.w === rival) el.classList.add('trick-winner');
      cellRival.appendChild(el);
    }

    const sep = document.createElement('div');
    sep.className = 'trick-row-sep';

    const cellMine = document.createElement('div');
    cellMine.className = 'trick-cell-mine';
    const cardMineCode = me === 0 ? t.c0 : t.c1;
    if(cardMineCode && cardMineCode !== EMPTY_CARD){
      const el = buildCard(cardMineCode);
      if(!isDraw && t.w === me) el.classList.add('trick-winner');
      cellMine.appendChild(el);
    }

    col.appendChild(cellRival);
    col.appendChild(sep);
    col.appendChild(cellMine);
    grid.appendChild(col);
  });

  if(hasCurrent){
    const col = document.createElement('div');
    col.className = 'trick-col';

    const cellRival = document.createElement('div');
    cellRival.className = 'trick-cell-rival';
    const rivalCard = rival === 0 ? curP0 : curP1;
    if(rivalCard){
      const el = buildCard(rivalCard);
      el.classList.add('land-anim');
      cellRival.appendChild(el);
    }

    const sep = document.createElement('div');
    sep.className = 'trick-row-sep';

    const cellMine = document.createElement('div');
    cellMine.className = 'trick-cell-mine';
    const myCard = me === 0 ? curP0 : curP1;
    if(myCard){
      const el = buildCard(myCard);
      el.classList.add('land-anim');
      cellMine.appendChild(el);
    }

    col.appendChild(cellRival);
    col.appendChild(sep);
    col.appendChild(cellMine);
    grid.appendChild(col);
  }
}

function renderTrickSnapshot(snapshot){
  const key = 'snap|' + snapshot.key;
  if(key === _prevTrickKey) return;
  _prevTrickKey = key;
  _renderTrickGrid(snapshot.allTricks, null, null);
}

function renderTrick(state){
  const h = state.hand;
  const info=$('centerInfo'); 
  
  if(!h){
    const grid = $('trickGrid');
    if(grid) grid.innerHTML = '';
    if(info) info.innerHTML = '';
    return;
  }
  const allT = h.allTricks || [];
  const p0 = getPlayed(h, 0), p1 = getPlayed(h, 1);
  const trickKey = allT.length + '|' + (p0||'-') + '|' + (p1||'-');
  
  if(trickKey !== _prevTrickKey) {
    _prevTrickKey = trickKey;
    _renderTrickGrid(allT, p0, p1);
  }

  // --- Recuperamos tu historial de puntitos ---
  info.innerHTML='';
  const hist=h.trickHistory||[];
  if(hist.length){
    const dots=document.createElement('div');dots.className='trick-history-dots';
    hist.forEach(t=>{
      const d=document.createElement('div');d.className='trick-dot';
      if(t.winner===99||t.winner===null)d.classList.add('draw');
      else if(t.winner===session.mySeat)d.classList.add('won');
      else d.classList.add('lost');
      dots.appendChild(d);
    });
    info.appendChild(dots);
  }
}
function renderActions(state) {
  const h = state.hand;
  const eB = $('envitBtn'), tB = $('trucBtn'), mB = $('mazoBtn'), fB = $('faltaBtn');
  const ra = $('responseArea'), om = $('offerMsg');

  // 1. Limpieza inicial
  if (ra) { ra.innerHTML = ''; ra.classList.add('hidden'); }
  if (om) { om.classList.add('hidden'); }

  const playing = state.status === 'playing' && h?.status === 'in_progress';
  if (!playing) {
    ['envitBtn', 'faltaBtn', 'trucBtn', 'mazoBtn'].forEach(id => {
      const b = $(id); if (b) b.classList.add('hidden');
    });
    $('statusMsg').textContent = state.status === 'waiting' ? 'Esperant...' : 'Partida acabada';
    $('actionPanel').style.display = 'none';
    return;
  }

  $('actionPanel').style.display = '';
  const myT = h.turn === session.mySeat, norm = h.mode === 'normal', envDone = h.envit.state !== 'none';
  const played = alreadyPlayed(h, session.mySeat);

  const noTricksPlayed = (h.trickHistory || []).length === 0;
  const iHaventPlayed = !alreadyPlayed(h, session.mySeat);
  const noTrucAtAll = h.truc.state === 'none' && !(h.pendingOffer?.kind === 'truc');

  const envitAvailNow = h.envitAvailable && noTricksPlayed && iHaventPlayed && !envDone && noTrucAtAll;
  const canEnvitInTruc = h.envitAvailable && noTricksPlayed && iHaventPlayed && !envDone && h.mode === 'respond_truc';
  const envitOk = envitAvailNow || canEnvitInTruc;

  const nadieHaJugado = !alreadyPlayed(h, 0) && !alreadyPlayed(h, 1);
  const sinApuestasPrevias = h.envit.state === 'none' && h.truc.state === 'none';
  const bloqueoInicio = noTricksPlayed && nadieHaJugado && sinApuestasPrevias;

  // 2. Ocultar todos los botones fijos primero
  ['envitBtn', 'faltaBtn', 'trucBtn', 'mazoBtn'].forEach(id => {
    const b = $(id); if (b) b.classList.add('hidden');
  });

  // Helper para añadir botones dinámicos (Vull, No vull, etc.)
  const add = (l, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = l; b.className = `abtn ${cls} action-btn`;
    b.addEventListener('click', () => { sndBtn(); showTableMsg(l); fn(); });
    ra.appendChild(b);
  };

  // 3. LÓGICA DE BOTONES DINÁMICOS
  if (h.pendingOffer && h.turn === session.mySeat) {
    // CASO A: Me han cantado algo (Responder)
    om.textContent = h.pendingOffer.kind === 'envit'
      ? (h.pendingOffer.level === 'falta' ? 'Envit de falta' : h.pendingOffer.level === 4 ? 'Torne (4)' : 'Envit')
      : (h.pendingOffer.level === 3 ? 'Retruque' : h.pendingOffer.level === 4 ? 'Val 4' : 'Truc');

    om.classList.remove('hidden');
    ra.classList.remove('hidden');

    if (h.pendingOffer.kind === 'envit') {
      add('Vull', 'abtn-green', () => respondEnvit('vull'));
      add('No vull', 'abtn-red', () => respondEnvit('no_vull'));
      const niv = h.pendingOffer.level === 'falta' ? 10 : Number(h.pendingOffer.level);
      if (niv === 2) {
        add('Torne', 'abtn-gold', () => respondEnvit('torne'));
        add('Falta', 'abtn-gold', () => respondEnvit('falta'));
      } else if (niv === 4) {
        add('Falta', 'abtn-gold', () => respondEnvit('falta'));
      }
    } else {
      if (envitOk) {
        add('Envidar', 'abtn-green', () => startOffer('envit'));
        add('Falta', 'abtn-gold', () => startOffer('falta'));
      }
      add('Vull', 'abtn-green', () => respondTruc('vull'));
      add('No vull', 'abtn-red', () => respondTruc('no_vull'));
      if (h.pendingOffer.level === 2) add('Retruque', 'abtn-gold', () => respondTruc('retruque'));
      if (h.pendingOffer.level === 3) add('Val 4', 'abtn-gold', () => respondTruc('val4'));
    }
  } else if (myT && norm) {
    // CASO B: Es mi turno normal (Cantar)
    if (envitOk) {
      if ($('envitBtn')) $('envitBtn').classList.remove('hidden');
      if ($('faltaBtn')) $('faltaBtn').classList.remove('hidden');
    }
    if (!played) {
      const trucNone = h.truc.state === 'none';
      const iAccepted = h.truc.state === 'accepted' && h.truc.acceptedBy === session.mySeat;
      const canEscalate = iAccepted && Number(h.truc.acceptedLevel || 0) < 4;
      if (trucNone || canEscalate) {
        const tb = $('trucBtn');
        if (tb) {
          tb.textContent = canEscalate ? (Number(h.truc.acceptedLevel || 0) === 2 ? 'Retrucar' : 'Val 4') : 'Trucar';
          tb.classList.remove('hidden');
        }
      }
      if (!bloqueoInicio && $('mazoBtn')) $('mazoBtn').classList.remove('hidden');
    }
  }

  // 4. MENSAJES DE ESTADO (TURNOS) - ¡Esto es lo que faltaba dentro!
  const sm = $('statusMsg');
  if (sm) {
    sm.classList.remove('my-turn');
    if (played && !bothPlayed(h)) {
      sm.textContent = `Esperant a ${pName(state, other(session.mySeat))}...`;
    } else if (h.pendingOffer && h.turn !== session.mySeat) {
      sm.textContent = `Esperant a ${pName(state, h.turn)}...`;
    } else if (!myT && !played) {
      sm.textContent = `Torn de ${pName(state, h.turn)}`;
    } else if (!played && norm && !h.pendingOffer) {
      sm.textContent = 'El teu torn, tria carta o acció';
      sm.classList.add('my-turn');
    } else {
      sm.textContent = '';
    }
  }
}

function updateRivalTimer(state){
  const h=state.hand;
  const my=$('myZone'),riv=$('rivalZone');
  const playing=h&&state.status==='playing'&&h.status==='in_progress';
  const myActive=playing&&(h.turn===session.mySeat&&!alreadyPlayed(h,session.mySeat));
  const rivActive=playing&&(h.turn===other(session.mySeat)&&!alreadyPlayed(h,other(session.mySeat)));
  if(my){my.classList.toggle('turn-active',!!myActive);}
  if(riv){riv.classList.toggle('turn-active',!!rivActive);}
}

// Iniciamos en 'null' para saber cuándo es la primera carga de la partida
let _oldHUD = { 0: null, 1: null }; 

async function animateHUDPoints(id, targetValue, hudIdx) {
  const el = $(id);
  if (!el) return;

  // 1. Si es la primera vez que se carga la pantalla, pintamos sin animar
  if (_oldHUD[hudIdx] === null) {
    el.textContent = targetValue;
    _oldHUD[hudIdx] = targetValue;
    return;
  }

  let current = _oldHUD[hudIdx];
  
  // 2. Si los puntos son menores (nueva partida) o iguales, pintamos directo
  if (targetValue <= current) {
    el.textContent = targetValue;
    _oldHUD[hudIdx] = targetValue;
    return;
  }

  // 3. Seguro antibloqueos (por si Firebase manda la actualización dos veces seguidas)
  if (el.dataset.animating === "true") return;
  el.dataset.animating = "true";

  // 4. Subimos de uno en uno
  while (current < targetValue) {
    current++;
    _oldHUD[hudIdx] = current; // Guardamos el progreso
    
    // Pausa dramática de medio segundo
    await new Promise(r => setTimeout(r, 500)); 

    el.textContent = current;
    
    // Disparamos el destello CSS
    el.classList.remove('score-animate');
    void el.offsetWidth; // Truquito para reiniciar animaciones CSS
    el.classList.add('score-animate');
  }

  // Liberamos el seguro al terminar
  el.dataset.animating = "false";
}

function renderHUD(state){
  $('hudRoom').textContent=`Sala ${session.roomCode||'-'}`;
  $('hudSeat').textContent=pName(state,session.mySeat);
  
  const sMy = getScore(state, session.mySeat);
  const sRiv = getScore(state, other(session.mySeat));

  // Ahora siempre llamamos a la animación, ella sola decide si tiene que saltar o no
  animateHUDPoints('hudScore0', sMy, 0);
  animateHUDPoints('hudScore1', sRiv, 1);

  $('hudState').textContent=state.status==='waiting'?'Esperant':state.status==='playing'?'En joc':'Acabada';
  
  const turnPlayer=state.hand?pName(state,state.hand.turn):pName(state,state.mano);
  $('siMano').textContent=turnPlayer;
  $('siHand').textContent=String(real(state.handNumber||OFFSET));
  // Controla que el panel inferior solo se fije en pantalla durante la partida
  if ($('actionPanel')) {
    $('actionPanel').classList.toggle('playing-mode', state.status === 'playing');
  }
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
  if(!session.roomCode||session.mySeat===null)return;
  get(ref(db,`rooms/${session.roomCode}/presence/${K(other(session.mySeat))}`)).then(snap=>{
    const p=snap.val();
    const absent=p?.absent===true;
    const notif=$('absenceNotif');
    if(notif)notif.classList.toggle('hidden',!absent);
    if(absent&&!_absenceTimer){
      _absenceTimer=setTimeout(async()=>{
        await claimWinByRivalAbsence();
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
  $('myName').textContent=pName(state,session.mySeat);
  $('rivalName').textContent=pName(state,other(session.mySeat));
  // Sync avatar selection UI
  document.querySelectorAll('.av-opt').forEach((el,i)=>el.classList.toggle('av-selected',i===myAvatar));
  renderRivalCards(state.hand?.hands?.[K(other(session.mySeat))]);
  updateRivalTimer(state);
  renderMyCards(state);
  // Save snapshot whenever hand is active
  if(state.hand){
    _lastCompletedTricks={
      allTricks:state.hand.allTricks||[],
      key:real(state.handNumber||OFFSET)+'-'+Logica.getTrickIndex(state.hand)
    };
  }
  // Use state.lastAllTricks (includes the final trick even after hand=null)
  if(state.lastAllTricks&&state.lastAllTricks.length>0){
    const lk='lat-'+state.lastAllTricks.length+'-'+state.handNumber;
    if(_lastCompletedTricks?.key!==lk){
      _lastCompletedTricks={allTricks:state.lastAllTricks,key:lk};
      _prevTrickKey='';
    }
  }
  // Show snapshot when hand is null (between hands or game_over)
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
      const iWon=state.winner===session.mySeat;
      setTimeout(()=>{
        $('gameOverOverlay').classList.remove('hidden');
        $('goTitle').textContent=iWon?'🏆 Has guanyat!':'😅 Has perdut';
        $('goWinner').textContent=pName(state,state.winner)+' guanya';
        $('goScore').textContent=`${getScore(state,session.mySeat)} - ${getScore(state,other(session.mySeat))}`;
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
      $('waitingCode').textContent=session.roomCode||'-';
      
      const p0ready = !!(state.ready?.[K(0)]); // Host listo
      const p1ready = !!(state.ready?.[K(1)]); // Invitado listo
      const myReady = session.mySeat===0 ? p0ready : p1ready;
      const rivReady = session.mySeat===0 ? p1ready : p0ready;
      const rivName = pName(state, other(session.mySeat));

      // --- MENSAJE PRINCIPAL DEL OVERLAY ---
      if(!ready) {
        // Falta que entre el segundo jugador
        $('waitingStatus').innerHTML = 'Esperant el segon jugador<span class="dots"></span>';
      } else {
        // Ya están los dos. Mostramos si el rival está listo o no.
        $('waitingStatus').innerHTML = rivReady 
            ? `${rivName} està preparat!` 
            : `Esperant que ${rivName} estiga preparat<span class="dots"></span>`;
      }

      // --- LÓGICA POR ASIENTOS ---
      if(session.mySeat === 0){
        // SOY EL CREADOR (Host)
        $('startBtn').classList.toggle('hidden', !ready); // Solo aparece si hay 2 jugadores
        
        // El botón se deshabilita si el invitado (p1) no ha dado a "Preparat"
        const sB = $('startBtn');
        sB.disabled = !p1ready;
        sB.title = !p1ready ? "Falta que l'altre jugador estiga preparat" : "";
        sB.style.opacity = !p1ready ? "0.5" : "1";
        sB.style.cursor = !p1ready ? "not-allowed" : "pointer";

        $('guestReadyBtn').classList.add('hidden');
        $('guestWaitMsg').classList.add('hidden');
      } else {
        // SOY EL INVITADO (Guest)
        $('startBtn').classList.add('hidden');
        
        // Si NO he pulsado listo: veo el botón
        $('guestReadyBtn').classList.toggle('hidden', myReady);
        
        // Si SÍ he pulsado listo: veo el mensaje de espera al creador
        const gW = $('guestWaitMsg');
        gW.classList.toggle('hidden', !myReady);
        if(myReady) {
            gW.innerHTML = 'Esperant que el creador inicie la partida<span class="dots"></span>';
        }
      }
      
      // Mostrar el botón de volver siempre que estemos en el waiting
      $('backToMainBtn').classList.remove('hidden'); 
      $('waitingOverlay').classList.remove('hidden');

    } else {
      $('waitingOverlay').classList.add('hidden');
      if(ready && betweenTimer===null) startBetween(buildScoreSummary(state));
    }
    return;
}
  $('waitingOverlay').classList.add('hidden');stopBetween();

  const h=state.hand;
  if(h){
    const myTurn=(h.turn===session.mySeat&&!alreadyPlayed(h,session.mySeat)&&h.mode==='normal'&&!h.pendingOffer)||h.pendingOffer?.to===session.mySeat;
    const tk=`${real(state.handNumber)}-${Logica.getTrickIndex(h)}-${h.turn}-${h.mode}-${alreadyPlayed(h,session.mySeat)?1:0}`;
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
function renderRematchStatus(state){
  const btn=$('goRematchBtn'),st=$('goRematchStatus');
  if(!btn||!st)return;
  const myWant=!!(state.rematch?.[K(session.mySeat)]);
  const rivWant=!!(state.rematch?.[K(other(session.mySeat))]);
  if(myWant&&!rivWant){
    btn.disabled=true;btn.textContent='⏳ Esperant revenja...';
    st.textContent=`${pName(state,other(session.mySeat))} encara no ha contestat`;
  }else if(!myWant){
    btn.disabled=false;btn.textContent='🔄 Revenja';
    st.textContent=rivWant?`${pName(state,other(session.mySeat))} vol la revenja!`:'';
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
      const div=document.createElement('div');div.className=`chat-msg ${m.seat===session.mySeat?'mine':'theirs'}`;
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
  const inp=$('chatInput'),text=inp.value.trim();if(!text||!session.roomRef||session.mySeat===null)return;
  inp.value='';const myName=localStorage.getItem(LS.name)||`Jugador ${session.mySeat}`;
  await push(ref(db,`rooms/${session.roomCode}/chat`),{seat:session.mySeat,name:myName,text,at:Date.now()});
}

// --- Room ---------------------------------------------------------------------

// --- Avatars ------------------------------------------------------------------
const AVATAR_IMAGES = [
  'Media/Images/Avatars/Avatar1.png',
  'Media/Images/Avatars/Avatar3.png',
  'Media/Images/Avatars/Avatar4.png',
  'Media/Images/Avatars/Avatar5.png',
  'Media/Images/Avatars/Avatar6.png',
  'Media/Images/Avatars/Avatar7.png',
  'Media/Images/Avatars/Avatar14.png',
  'Media/Images/Avatars/Avatar16.png'
];
let myAvatar = Number(localStorage.getItem('truc_avatar') || 0);

function pickAvatar(idx){
  // Don't allow picking rival's avatar
  if(idx===_rivalAvatarIdx&&_rivalAvatarIdx>=0)return;
  myAvatar=idx;
  localStorage.setItem('truc_avatar',String(idx));
  document.querySelectorAll('.av-opt').forEach((el,i)=>el.classList.toggle('av-selected',i===idx));
  if(session.roomRef&&session.mySeat!==null){
    set(ref(db,`rooms/${session.roomCode}/avatars/${K(session.mySeat)}`),idx).catch(()=>{});
  }
}
// Expose globally so HTML onclick works AND attach via JS
window.pickAvatar=pickAvatar;

function getRivalAvatar(){
  if(!session.roomRef||session.mySeat===null)return -1;
  // Read from last known state
  return _rivalAvatarIdx;
}

let _rivalAvatarIdx=-1;
function getAvatarImg(idx) {
  // Usamos el array de rutas que creamos antes
  const src = AVATAR_IMAGES[idx] || AVATAR_IMAGES[0]; 
  return `<img src="${src}" alt="Avatar">`;
}
function renderAvatars(room){
  const avs=room?.avatars||{};
  const myIdx=Number(avs[K(session.mySeat)]??myAvatar);
  const rivIdx=Number(avs[K(other(session.mySeat))]??-1);
  _rivalAvatarIdx=rivIdx;
  const myEl=$('myAv'), rivEl=$('rivalAv');
  
  if(myEl) myEl.innerHTML = getAvatarImg(myIdx);
  if(rivEl && rivIdx >= 0) rivEl.innerHTML = getAvatarImg(rivIdx);
  
  // Gray out avatar options that the rival has chosen
  document.querySelectorAll('.av-opt').forEach((el,i)=>{
    const takenByRival=i===rivIdx&&rivIdx>=0;
    el.classList.toggle('av-taken',takenByRival);
    el.style.opacity=takenByRival?'0.3':'1';
    el.title=takenByRival?'Aquest avatar l\'usa el teu rival':'';
  });
}

let unsubMsg=null;
export function startSession(code){
  session.roomCode = code;
  session.roomRef = ref(db, `rooms/${code}`);

  if(unsubGame) unsubGame();
  
  // 1. Escuchar cambios en la partida (Lobby o Mesa)
  unsubGame = onValue(session.roomRef, snap => {
    const data = snap.val();
    if(!data) return;
    
    // Si NO hay estado (nadie ha dado a 'Repartir'), nos quedamos en el Lobby
    if(!data.state) {
      $('screenLobby').classList.remove('hidden');
      $('screenGame').classList.add('hidden');
    } else {
      // Si YA hay estado de juego, vamos a la mesa
      $('screenLobby').classList.add('hidden');
      $('screenGame').classList.remove('hidden');
    }
    
    renderAll(data);
  });

  // 2. Inicializar el Chat
  initChat(code);

  // 3. Escuchar los mensajes rápidos (Envite, Truco...)
  if(unsubMsg) unsubMsg();
let lastMsgAt = 0;

unsubMsg = onValue(ref(db, `rooms/${code}/msg`), snap => {
    const m = snap.val();
    // 1. Si no hay mensaje o es el mismo de antes, ignorar
    if(!m || m.at <= lastMsgAt) return;
    
    lastMsgAt = m.at;

    // 2. Comprobar si han pasado menos de 5 segundos (para no ver gritos viejos al entrar)
    if(m.at > Date.now() - 5000) {
        // 3. COMPARACIÓN REAL: ¿El que envió el mensaje soy yo?
        // Comparamos el sender del mensaje con mi asiento actual
        const isMine = (m.sender === session.mySeat);
        
        // Lanzamos la animación
        showTableMsg(m.text, isMine);
    }
});

  // 4. Sistema de presencia (jugador conectado/desconectado)
  if(session.mySeat !== null){
    const presRef = ref(db, `rooms/${code}/presence/${K(session.mySeat)}`);
    onDisconnect(presRef).set({absent: true, at: Date.now()});
    set(presRef, {absent: false, at: Date.now()}).catch(()=>{});
  }
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
  session.mySeat=0;saveLS(name,code,0);$('roomInput').value=code;
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
  if(p1?.name===name&&p0?.name!==name)session.mySeat=1;
  else if(p0?.name===name)session.mySeat=0;else session.mySeat=1;
  saveLS(name,code,session.mySeat);setLobbyMsg(`Unit com J${session.mySeat}.`,'good');startSession(code);
}

async function leaveRoom(){
  stopBetween();stopTurnTimer();
  if(session.roomRef&&session.mySeat!=null){try{await remove(ref(db,`rooms/${session.roomCode}/state/players/${K(session.mySeat)}`));}catch(e){}}
  localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);location.reload();
}
let _lastRoomListKey = '';
let unsubRooms = null;

function loadRoomList() {
  const listEl = $('roomList');
  if (!listEl) return;
  if (unsubRooms) return; // ya escuchando

  unsubRooms = onValue(ref(db, 'rooms'), snap => {
    const rooms = snap.val();
    const open = [];
    if (rooms) {
      for (const [code, room] of Object.entries(rooms)) {
        const st = room?.state;
        if (!st || st.status === 'game_over') continue;
        const p0 = st.players?.[K(0)];
        const p1 = st.players?.[K(1)];
        if (p0 && !p1) {
          const inactive = Date.now() - (room.lastActivity || 0) > 3600000;
          if (!inactive) open.push({ code, host: p0.name });
        }
      }
    }
    open.sort((a, b) => a.code.localeCompare(b.code));
    const newKey = open.map(r => r.code + r.host).join('|');
    if (newKey === _lastRoomListKey) return;
    _lastRoomListKey = newKey;
    listEl.innerHTML = '';
    if (!open.length) {
      listEl.innerHTML = '<div class="rl-empty">Cap sala oberta</div>';
      return;
    }
    open.forEach(r => {
      const row = document.createElement('div');
      row.className = 'rl-row';
      row.innerHTML = `<div class="rl-info"><span class="rl-code">${r.code}</span><span class="rl-host">${r.host}</span></div><button class="lbtn lbtn-primary rl-join">Entrar</button>`;
      row.querySelector('.rl-join').addEventListener('click', () => showQuickJoin(r.code, r.host));
      listEl.appendChild(row);
    });
  });
}
/**
 * Gestiona el acceso rápido desde la lista de salas abiertas.
 * @param {string} code - El código de la sala (ej: 'ABCDE')
 * @param {string} host - El nombre del creador (ej: 'Joan')
 */
function showQuickJoin(code, host) {
  const modal = document.getElementById('quickJoinModal');
  const qjNameInput = document.getElementById('qj-name-input');
  const roomDisplay = document.getElementById('qj-room-display');

  // 1. Mostrar modal y limpiar nombre
  roomDisplay.innerText = code;
  modal.classList.remove('hidden');
  qjNameInput.value = ""; // Limpiamos por si acaso
  qjNameInput.focus();

  // 2. Al hacer clic en Jugar!
  document.getElementById('qj-confirm').onclick = () => {
      const nick = qjNameInput.value.trim();
      
      if (nick.length < 2) {
          alert("Escriu un nom vàlid!");
          return;
      }

      // RELLENAMOS TUS INPUTS REALES (del HTML que me has pasado)
      const realNameInput = document.getElementById('nameInput');
      const realRoomInput = document.getElementById('roomInput');
      const realJoinBtn = document.getElementById('joinBtn');

      if (realNameInput && realRoomInput && realJoinBtn) {
          realNameInput.value = nick;
          realRoomInput.value = code;
          
          // Ocultamos el modal
          modal.classList.add('hidden');
          
          // ¡PULSÁMOS EL BOTÓN DE UNIRSE!
          realJoinBtn.click();
      } else {
          console.error("No s'han trobat els IDs nameInput, roomInput o joinBtn");
      }
  };

  // 3. Al hacer clic en Eixir
  document.getElementById('qj-cancel').onclick = () => {
      modal.classList.add('hidden');
  };
}

// Muy importante para que el botón de la lista lo vea:
window.showQuickJoin = showQuickJoin;
// --- Boot: initApp ------------------------------------------------------------
export function initApp(){
  configureActions({ renderAll });
  $('createBtn').addEventListener('click',createRoom);
  $('joinBtn').addEventListener('click',joinRoom);
  $('leaveBtn').addEventListener('click',leaveRoom);
  $('goLeaveBtn').addEventListener('click',leaveRoom);
  $('goRematchBtn')?.addEventListener('click',requestRematch);
  $('guestReadyBtn')?.addEventListener('click',async()=>{
    sndBtn();
    $('guestReadyBtn').classList.add('hidden');
    $('guestWaitMsg').classList.remove('hidden');
    await guestReady();
  });
  $('startBtn').addEventListener('click',async()=>{sndBtn();$('waitingOverlay').classList.add('hidden');await dealHand();});
  $('envitBtn').onclick = () => { showTableMsg('Envide!', true); startOffer('envit'); };
  $('faltaBtn').onclick = () => { showTableMsg('Falta!', true); startOffer('envit', 'falta'); };
  $('trucBtn').onclick = () => { showTableMsg('Truque!', true); startOffer('truc'); };
  $('mazoBtn').onclick = () => { showTableMsg('Me\'n vaig!', true); goMazo(); };
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
  document.querySelectorAll('.av-opt').forEach((el,i)=>{
    el.addEventListener('click',()=>pickAvatar(i));
  });
  pickAvatar(myAvatar);
  loadLS();
  (async()=>{
    const _sr=localStorage.getItem(LS.room);
    if(_sr){
      const _code=sanitize(_sr);
      try{
        const snap=await get(ref(db,`rooms/${_code}`));
        if(snap.exists()&&snap.val()?.state){
          session.roomCode=_code;$('roomInput').value=_code;
          const _ss=localStorage.getItem(LS.seat);if(_ss!=null)session.mySeat=Number(_ss);
          startSession(_code);
          return;
        }
      }catch(e){}
      localStorage.removeItem(LS.room);localStorage.removeItem(LS.seat);
    }
  })();
  loadRoomList();
}
async function animatePoints(elementId, startValue, endValue) {
  const el = $(elementId);
  if (!el || startValue === endValue) return;

  // Si por alguna razón el valor final es menor (reinicio), actualizamos sin animar
  if (endValue < startValue) {
    el.textContent = endValue;
    return;
  }

  for (let v = startValue + 1; v <= endValue; v++) {
    // Esperamos un poco entre punto y punto (500ms)
    await new Promise(resolve => setTimeout(resolve, 600));

    el.textContent = v;
    
    // Reiniciamos la animación CSS
    el.classList.remove('score-animate');
    void el.offsetWidth; // Truco para forzar al navegador a reiniciar la animación
    el.classList.add('score-animate');
    
    // Opcional: Sonido de "click" o "punto" si tienes uno
    // playSound('point'); 
  }
}

export function initRoomListListener() {
    const listEl = document.getElementById('roomList');
    if (!listEl) return;

    // Si ya había un escuchador, lo cerramos para no duplicar
    if (unsubRooms) unsubRooms();

    // Escuchamos la carpeta 'rooms' de Firebase
    unsubRooms = onValue(ref(db, 'rooms'), (snapshot) => {
        const rooms = snapshot.val();
        listEl.innerHTML = ''; // Limpiamos la lista actual

        if (!rooms) {
            listEl.innerHTML = '<div class="no-rooms">No hi ha sales obertes</div>';
            return;
        }

        // Recorremos las salas encontradas
        Object.keys(rooms).forEach(code => {
            const room = rooms[code];
            
            // FILTRO: Solo mostrar si no ha empezado y solo hay 1 persona
            const occupancy = room.presence ? Object.keys(room.presence).length : 0;
            
            if (!room.state && occupancy === 1) {
                const item = document.createElement('div');
                item.className = 'room-item';
                item.innerHTML = `
                    <span>Sala: <b>${code}</b></span>
                    <button class="join-btn-list" data-code="${code}">Entrar</button>
                `;
                
                // Evento para unirnos al hacer clic
                item.querySelector('.join-btn-list').onclick = () => {
                    const input = document.getElementById('roomCodeInput');
                    if (input) input.value = code;
                    // Disparamos el clic del botón de entrar que ya tienes
                    document.getElementById('btnJoin')?.click();
                };
                
                listEl.appendChild(item);
            }
        });

        if (listEl.innerHTML === '') {
            listEl.innerHTML = '<div class="no-rooms">Esperant sales noves...</div>';
        }
    });
}