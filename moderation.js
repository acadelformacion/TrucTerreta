// --- moderation.js — Validació de nicks via Gemini API -----------------------
// Model: gemini-2.5-flash-lite (ràpid i econòmic per a validació simple)
// Fallback silenciós: si l'API falla per qualsevol motiu, el nick és permès.

import { GEMINI_API_KEY } from "./gemini-config.js";

const GEMINI_MODEL  = "gemini-2.5-flash-lite";
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const TIMEOUT_MS    = 6000;

/**
 * Comprova si un nick és adequat via l'API de Gemini.
 * Detecta insults, blasfèmies, contingut sexual/racista/violent en qualsevol
 * idioma, incloses variants amb símbols o números (p0lla, put@, etc.).
 *
 * @param {string} nick  El nick a validar (sense normalitzar)
 * @returns {Promise<{ allowed: boolean }>}
 *   · allowed = true  → nick correcte (o error d'API → fallback permissiu)
 *   · allowed = false → nick rebutjat per la IA
 */
export async function checkNickModeration(nick) {
  // Guard: key no configurada → fallback permissiu sense fer cap crida
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "POSA_AQUÍ_LA_TEUA_CLAU") {
    console.warn("moderation.js: GEMINI_API_KEY no configurada, fallback permissiu.");
    return { allowed: true };
  }

  const prompt =
    `Eres un moderador de nicknames para un juego de cartas. ` +
    `Analiza el siguiente nickname y responde SOLO con JSON {"allowed": true} o {"allowed": false}. ` +
    `Rechaza si contiene insultos, blasfemias, referencias a violencia o terrorismo, ` +
    `contenido sexual o racista, en cualquier idioma, incluyendo variantes con ` +
    `símbolos o números (p0lla, put@, etc.). Nickname: ${nick}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(GEMINI_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:      0,
          maxOutputTokens:  20,
          responseMimeType: "application/json",
        },
      }),
    });

    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`moderation.js: HTTP ${res.status}, fallback permissiu.`);
      return { allowed: true };
    }

    const data = await res.json();
    const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      console.warn("moderation.js: JSON invàlid de Gemini, fallback permissiu.", raw);
      return { allowed: true };
    }

    // allowed és false explícitament → rebutjat; qualsevol altra cosa → permès
    return { allowed: parsed.allowed !== false };

  } catch (err) {
    // AbortError (timeout) o qualsevol error de xarxa → fallback permissiu
    console.warn("moderation.js: error o timeout, fallback permissiu.", err?.name);
    return { allowed: true };
  }
}
