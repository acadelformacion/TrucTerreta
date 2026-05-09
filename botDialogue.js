// --- botDialogue.js — Frases IA del bot (valencià), cosmètiques només ----------
import { GEMINI_API_KEY } from "./gemini-config.js";
import { loadConfig } from "./config.js";
import { isBotActive } from "./bot.js";
import { showBotAiSpeechBubble } from "./animations.js";

const OFFSET = 10;
const K = (n) => `_${n}`;
const real = (n) => Number(n || OFFSET) - OFFSET;

const BOT_SEAT = 1;

/**
 * Diversos models tenen quotes independents en el pla gratuit (429 és habitual).
 * `gemini-flash-latest` sol funcionar quan `gemini-2.5-flash` ja ha gastat el límit diari.
 */
const MODEL_IDS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
const API_VERSIONS = ["v1beta", "v1"];
/** Gemini amb maxOutputTokens alt pot superar 5s; si abortem, no hi ha frase. */
const TIMEOUT_MS = 22000;

const PERSONALITY_KEY = "botPersonality";
const VALID_PERSONALITIES = ["iaio", "flipat", "serios"];

/** Sempre intentem frase si hi ha quota; abans el silenci aleatori es confonia amb fallades d’API. */
const SPEAK_CHANCE = { iaio: 100, flipat: 100, serios: 100 };

const PERSONALITY_PROMPTS = {
  iaio: `Personatge: «El Iaio» — iaio valencià nostàlgic, conta històries curtes, es queixa suaument, expressions antigues.`,
  flipat: `Personatge: «El Flipat» — fanfarró i faroler, provoca, presumeix, parla fort i ment amb aplom.`,
  serios: `Personatge: «El Seriós» — lacònic, intimidador; parla molt poc i només amb retrets freds.`,
};

function rollPercent(p) {
  return Math.random() * 100 < p;
}

export function getBotPersonalitySlug() {
  try {
    const raw = localStorage.getItem(PERSONALITY_KEY);
    return VALID_PERSONALITIES.includes(raw) ? raw : "iaio";
  } catch {
    return "iaio";
  }
}

function botDialogueAllowedByConfig() {
  try {
    return loadConfig().botDialogueEnabled !== false;
  } catch {
    return true;
  }
}

/** Gemini pot retornar el text repartit en diversos `parts`; cal ajuntar-los tots. */
function extractGeminiCandidateText(data) {
  const cand = data?.candidates?.[0];
  if (!cand) return "";
  const parts = cand.content?.parts;
  if (Array.isArray(parts)) {
    const chunks = [];
    for (const p of parts) {
      const tx = p?.text;
      if (typeof tx === "string" && tx.length) chunks.push(tx);
    }
    const joined = chunks.join("").trim();
    if (joined) return joined;
  }
  const extra =
    typeof cand.output?.text === "string"
      ? cand.output.text
      : typeof cand.text === "string"
        ? cand.text
        : "";
  return String(extra).trim();
}

/** Neteja cosmètica; la longitud la marca el model (prompt), sense tallar ací. */
function sanitizePhrase(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/[*_`"'«»]/g, "").trim();
  t = t.replace(/\s+/g, " ");
  return t;
}

/**
 * Resum pla per al prompt (text).
 */
export function summarizeStateForBot(state, trigger, dialogueMeta, handSummary) {
  const botScore = real(state.scores?.[K(BOT_SEAT)]);
  const humanSeat = otherSeat(BOT_SEAT);
  const humanScore = real(state.scores?.[K(humanSeat)]);
  const h = state.hand;
  const twB = h ? real(h.trickWins?.[K(BOT_SEAT)]) : 0;
  const twH = h ? real(h.trickWins?.[K(humanSeat)]) : 0;
  let bluffLine =
    "Context de farol: no aplica (esdeveniment de basa o fi de mà, o sense meta d’acció).";
  if (dialogueMeta) {
    const bits = [];
    if (dialogueMeta.likelyBluffTruc) bits.push("truc/retruque amb mà feble");
    if (dialogueMeta.likelyBluffEnvit) bits.push("envit/falta amb punts baixos");
    bluffLine =
      bits.length > 0
        ? `Possible farol: ${bits.join("; ")}.`
        : "No sembla farol evident en esta jugada.";
  }
  let extra = "";
  if (
    handSummary != null &&
    (handSummary.winner === 0 || handSummary.winner === 1)
  ) {
    extra = ` Resultat mà: equip ${handSummary.winner}.`;
  }
  return [
    `Marcador partida: bot ${botScore}, humà ${humanScore}.`,
    `Bazes esta mà (bot vs humà): ${twB}-${twH}.`,
    bluffLine,
    `Esdeveniment: ${trigger}.${extra}`,
  ].join(" ");
}

function otherSeat(s) {
  return s === 0 ? 1 : 0;
}

async function fetchGeminiPhrase(personalitySlug, contextBlock, archetypePrompt) {
  if (
    !GEMINI_API_KEY ||
    GEMINI_API_KEY === "POSA_AQUÍ_LA_TEUA_CLAU"
  ) {
    return "";
  }

  const userPrompt = `${archetypePrompt}

Context de la partida:
${contextBlock}

Instruccions:
- Respond ONLY with the spoken phrase itself: no quotes, no preamble, no explanation.
- Respond in Valencian (llengua valenciana), using natural colloquial Valencian expressions, not standard Catalan.
- Stay brief: one or two sentences at table-talk pace; do not ramble, but always finish the thought in full.
- Stay strictly in character for this personality archetype.`;

  const body = {
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.85,
      maxOutputTokens: 320,
    },
  };

  for (const modelId of MODEL_IDS) {
    for (const version of API_VERSIONS) {
      const apiUrl = `https://generativelanguage.googleapis.com/${version}/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response;
      try {
        response = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(body),
        });
      } catch {
        clearTimeout(timer);
        continue;
      }
      clearTimeout(timer);

      let data;
      try {
        data = await response.json();
      } catch {
        continue;
      }

      if (!response.ok || data?.error) continue;
      if (data?.promptFeedback?.blockReason) continue;

      const textResult = extractGeminiCandidateText(data);
      const cleaned = sanitizePhrase(textResult);
      if (cleaned.length > 0) return cleaned;
    }
  }
  return "";
}

function mapActionToTrigger(action) {
  if (!action || !Array.isArray(action)) return "BOT_ACTION";
  const [type, payload] = action;
  if (type === "PLAY_CARD") return "BOT_PLAY_CARD";
  if (type === "OFFER") {
    if (payload === "truc") return "BOT_OFFER_TRUC";
    if (payload === "envit") return "BOT_OFFER_ENVIT";
    if (payload === "falta") return "BOT_OFFER_FALTA_ENVIT";
  }
  if (type === "RESPOND_TRUC") {
    if (payload === "vull") return "BOT_ACCEPT_TRUC";
    if (payload === "no_vull") return "BOT_REJECT_TRUC";
    if (payload === "retruque") return "BOT_RETRUC";
    if (payload === "val4") return "BOT_VAL4";
  }
  if (type === "RESPOND_ENVIT") {
    if (payload === "vull") return "BOT_ACCEPT_ENVIT";
    if (payload === "no_vull") return "BOT_REJECT_ENVIT";
    if (payload === "torne") return "BOT_ENVIT_TORNE";
    if (payload === "falta") return "BOT_ENVIT_FALTA_RESP";
  }
  return "BOT_ACTION";
}

async function runBotPhraseRequest(opts) {
  const {
    trigger,
    state,
    action,
    dialogueMeta,
    handSummary,
  } = opts;
  if (!isBotActive()) return;
  if (!botDialogueAllowedByConfig()) return;

  const personality = getBotPersonalitySlug();
  if (!rollPercent(SPEAK_CHANCE[personality] ?? 50)) return;

  const archetype =
    PERSONALITY_PROMPTS[personality] || PERSONALITY_PROMPTS.iaio;
  const contextBlock = summarizeStateForBot(
    state,
    trigger,
    dialogueMeta,
    handSummary,
  );

  const phrase = await fetchGeminiPhrase(personality, contextBlock, archetype);
  if (!phrase) return;
  showBotAiSpeechBubble(phrase);
}

/**
 * Fire-and-forget; tot error es swallow (sense console).
 */
export function requestBotPhraseSilently(opts) {
  try {
    if (!opts?.trigger || !opts?.state) return;
    void runBotPhraseRequest(opts).catch(() => {});
  } catch (_) {}
}

export function requestBotPhraseAfterBotAction(state, action, dialogueMeta) {
  try {
    const trigger = mapActionToTrigger(action);
    requestBotPhraseSilently({
      trigger,
      state,
      action,
      dialogueMeta,
      handSummary: null,
    });
  } catch (_) {}
}
