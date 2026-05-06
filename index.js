const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { FieldValue } = require("firebase-admin/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

exports.cleanupAbandonedRooms = onSchedule({ schedule: "every 20 minutes", region: "europe-west1" }, async (event) => {
  const db = admin.database();
  const roomsRef = db.ref("/rooms");
  const snapshot = await roomsRef.once("value");

  if (!snapshot.exists()) return null;

  const now = Date.now();
  const tenMinutes = 10 * 60 * 1000;
  const twentyMinutes = 20 * 60 * 1000;

  const updates = {};

  snapshot.forEach((childSnapshot) => {
    const roomId = childSnapshot.key;
    const room = childSnapshot.val();

    if (!room) return;

    const lastActivity = room.lastActivity || 0;
    const timeSinceActivity = now - lastActivity;

    if (timeSinceActivity > twentyMinutes) {
      // Elimina el nodo de la sala completamente
      updates[`/${roomId}`] = null;
    } else if (
      timeSinceActivity > tenMinutes &&
      room.state &&
      room.state.status !== "game_over" &&
      room.state.status !== "abandoned"
    ) {
      // Marca la sala como abandonada por inactividad
      updates[`/${roomId}/state/status`] = "abandoned";
      updates[`/${roomId}/state/closedAt`] = Date.now();
    }
  });

  if (Object.keys(updates).length > 0) {
    await roomsRef.update(updates);
    console.log(`Cleaned up ${Object.keys(updates).length} room entries.`);
  }

  return null;
});

const SUIT_ORDER = ["oros", "copas", "espadas", "bastos"];
function buildDeck() {
  const c = [],
    n = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12];
  for (const s of SUIT_ORDER) for (const x of n) c.push(`${x}_${s}`);
  return c;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function bestEnvit(cards) {
  if (!cards || !cards.length) return 0;
  let best = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i].split("_");
      const b = cards[j].split("_");
      if (a[1] === b[1]) {
        const v = 20 + envitVal(cards[i]) + envitVal(cards[j]);
        if (v > best) best = v;
      }
    }
  }
  return best > 0 ? best : Math.max(0, ...cards.map(envitVal));
}
function envitVal(c) {
  const n = parseInt(c.split("_")[0]);
  return n >= 10 ? 0 : n;
}

exports.repartirCartas = onCall({ region: "europe-west1" }, async (request) => {
  const { roomId, numSeats, handNumber } = request.data;
  if (!roomId) throw new HttpsError("invalid-argument", "Missing roomId");
  if (!request.auth) throw new HttpsError("unauthenticated", "Must be logged in");

  const db = admin.database();
  const roomSnap = await db.ref(`/rooms/${roomId}`).once("value");
  const room = roomSnap.val();
  if (!room?.state?.hand) {
    throw new HttpsError("failed-precondition", "Room has no active hand");
  }
  if (Number(room.state.handNumber) !== Number(handNumber)) {
    throw new HttpsError("failed-precondition", "Stale handNumber");
  }

  const n = numSeats === 4 ? 4 : 2;
  const deck = shuffle(buildDeck());

  const secretHands = { hands: {}, envitPoints: {} };
  const updates = {};
  for (let i = 0; i < n; i++) {
    const handArr = deck.slice(i * 3, i * 3 + 3);
    secretHands.hands[`_${i}`] = {
      a: handArr[0],
      b: handArr[1],
      c: handArr[2],
      hn: handNumber,
    };
    secretHands.envitPoints[`_${i}`] = bestEnvit(handArr);
    updates[`rooms/${roomId}/state/hand/hands/_${i}`] = {
      a: handArr[0],
      b: handArr[1],
      c: handArr[2],
    };
  }
  updates[`secret_hands/${roomId}`] = secretHands;

  await db.ref().update(updates);

  return { success: true };
});

exports.resolverEnvit = onCall({ region: "europe-west1" }, async (request) => {
  const { roomId } = request.data;
  if (!roomId) throw new HttpsError("invalid-argument", "Missing roomId");

  const db = admin.database();
  const roomSnap = await db.ref(`/rooms/${roomId}`).once("value");
  const room = roomSnap.val();
  if (!room) throw new HttpsError("not-found", "Room not found");

  const secretSnap = await db.ref(`/secret_hands/${roomId}`).once("value");
  const secret = secretSnap.val();
  if (!secret) throw new HttpsError("not-found", "Secret hands not found");

  const h = room.state.hand;
  const n = h.numSeats || 2;
  const mano = room.state.mano;

  let bestV0 = 0, bestV1 = 0;
  let bestSeat0 = 0, bestSeat1 = 1;

  for (let i = 0; i < n; i++) {
    const v = secret.envitPoints[`_${i}`] || 0;
    if (i % 2 === 0) {
      if (v > bestV0) { bestV0 = v; bestSeat0 = i; }
    } else {
      if (v > bestV1) { bestV1 = v; bestSeat1 = i; }
    }
  }

  const teamWinner = bestV0 > bestV1 ? 0 : bestV1 > bestV0 ? 1 : (mano % 2);
  const winnerSeat = teamWinner === 0 ? bestSeat0 : bestSeat1;
  const winnerHandObj = secret.hands[`_${winnerSeat}`];
  const winnerHand = [winnerHandObj.a, winnerHandObj.b, winnerHandObj.c];

  return {
    v0: bestV0,
    v1: bestV1,
    winnerTeam: teamWinner,
    winnerSeat: winnerSeat,
    winnerHand: winnerHand
  };
});

exports.processGameStats = onValueWritten(
  { ref: "/rooms/{roomId}", region: "europe-west1" },
  async (event) => {
    const roomBefore = event.data.before.val();
    const roomAfter = event.data.after.val();

    if (!roomAfter || !roomAfter.state) return null;

    const stateBefore = roomBefore?.state || {};
    const stateAfter = roomAfter.state;

    // Detect game over transition
    if (stateAfter.status === "game_over" && stateBefore.status !== "game_over") {
      if (roomAfter.statsProcessed) {
        return null;
      }

      const OFFSET = 10;
      const real = (n) => Number(n || OFFSET) - OFFSET;
      
      const team0Score = real(stateAfter.scores?.["_0"]);
      const team1Score = real(stateAfter.scores?.["_1"]);
      
      let winningTeam = -1;
      let losingTeam = -1;
      
      if (team0Score > team1Score) {
        winningTeam = 0;
        losingTeam = 1;
      } else if (team1Score > team0Score) {
        winningTeam = 1;
        losingTeam = 0;
      }

      const db = admin.firestore();
      const rtdb = admin.database();
      const updates = [];
      const players = stateAfter.players || {};

      for (const [seatKey, player] of Object.entries(players)) {
        if (!player || !player.uid || player.guest || player.name === "🤖 Bot") continue;

        const seatIndex = parseInt(seatKey.replace("_", ""), 10);
        const playerTeam = seatIndex % 2 === 0 ? 0 : 1;
        const playerPoints = playerTeam === 0 ? team0Score : team1Score;
        
        const isWinner = playerTeam === winningTeam;
        const isLoser = playerTeam === losingTeam;

        const playerRef = db.collection("players").doc(player.uid);

        updates.push(db.runTransaction(async (t) => {
          const doc = await t.get(playerRef);
          const data = doc.exists ? doc.data() : {
            gamesPlayed: 0,
            gamesWon: 0,
            gamesLost: 0,
            currentStreak: 0,
            bestStreak: 0,
            totalPoints: 0
          };

          const currentStreak = data.currentStreak || 0;
          const bestStreak = data.bestStreak || 0;

          const nextStreak = isWinner ? currentStreak + 1 : (isLoser ? 0 : currentStreak);
          const nextBestStreak = Math.max(bestStreak, nextStreak);

          t.set(playerRef, {
            gamesPlayed: FieldValue.increment(1),
            gamesWon: isWinner ? FieldValue.increment(1) : FieldValue.increment(0),
            gamesLost: isLoser ? FieldValue.increment(1) : FieldValue.increment(0),
            currentStreak: nextStreak,
            bestStreak: nextBestStreak,
            totalPoints: FieldValue.increment(playerPoints),
            lastGameAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }));
      }

      await Promise.all(updates);
      await rtdb.ref(`/rooms/${event.params.roomId}/statsProcessed`).set(true);
      console.log(`Stats processed successfully for room ${event.params.roomId}`);
    }
    return null;
  }
);

