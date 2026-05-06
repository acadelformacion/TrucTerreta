// --- moderation.js — Validació de nicks via Gemini API -----------------------
// Model: gemini-2.5-flash-lite (ràpid i econòmic)
// Mode degradat: si l'API falla, apliquem només tallafoc local.

import { GEMINI_API_KEY } from "./gemini-config.js";

// Intentem primer 2.5-flash-lite i fem fallback a 1.5-flash.
const MODEL_CANDIDATES = ["gemini-2.5-flash-lite", "gemini-1.5-flash"];
const API_VERSIONS = ["v1", "v1beta"];
const TIMEOUT_MS    = 6000;
let _apiUnavailableWarned = false;

/**
 * Comprova si un nick és adequat via l'API de Gemini.
 */
export async function checkNickModeration(nick) {
  const normalizedNick = String(nick || "").trim();
  if (!normalizedNick) return { allowed: false, reason: "empty_nick" };

  // Tallafoc local mínim per a paraules explícites comunes.
  // Evita bypass si la IA cau o no retorna JSON vàlid.
  const localBlockedPattern = /\b(polla|puta|puto|gilipollas|mierda|cabr[oó]n)\b/i;
  if (localBlockedPattern.test(normalizedNick)) {
    return { allowed: false, reason: "blocked_local_pattern" };
  }

  // Guard: key no vàlida
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "POSA_AQUÍ_LA_TEUA_CLAU") {
    console.warn("Moderation: GEMINI_API_KEY no configurada.");
    return { allowed: false, reason: "missing_api_key" };
  }

  const prompt = `Analiza este nickname para un juego: "${normalizedNick}". 
Responde ÚNICAMENTE con este JSON: {"allowed": true} o {"allowed": false}.
Rechaza (false) si es un insulto, blasfemia, contenido sexual, racista o violento, en cualquier idioma o con sustitución de letras por números (ej: p0lla, put@, etc.).
De lo contrario, acepta (true).`;

  try {
    for (const model of MODEL_CANDIDATES) {
      for (const version of API_VERSIONS) {
        const apiUrl = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response;

        try {
          response = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 20
              }
            })
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const errText = await response.text();
          console.warn(`Moderation API Error (${version}/${model}/${response.status}):`, errText);
          // Clau filtrada/revocada: no insistir bloquejant tot.
          if (response.status === 401 || response.status === 403) {
            if (!_apiUnavailableWarned) {
              _apiUnavailableWarned = true;
              console.warn("Moderation desactivada temporalment: API key invàlida/revocada.");
            }
            return { allowed: true, reason: "api_key_unavailable" };
          }
          continue;
        }

        const data = await response.json();

        if (data?.promptFeedback?.blockReason) {
          return { allowed: false, reason: "blocked_by_safety" };
        }

        const textResult = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResult) continue;

        // Alguns models poden envoltar JSON en markdown.
        const cleaned = textResult
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        let result;
        try {
          result = JSON.parse(cleaned);
        } catch (parseErr) {
          console.warn("Moderation JSON parse error:", parseErr, textResult);
          continue;
        }

        console.log(`Moderation Result for "${normalizedNick}" (${version}/${model}):`, result);
        return { allowed: result?.allowed === true };
      }
    }

    // Si falla tota la cadena de models/endpoints, no bloquegem nicks normals.
    return { allowed: true, reason: "api_temporarily_unavailable" };

  } catch (error) {
    console.error("Moderation catch error:", error);
    return { allowed: true, reason: "request_failed" };
  }
}
