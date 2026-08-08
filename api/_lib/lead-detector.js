// ============================================================
// api/_lib/lead-detector.js
//
// Clasificador interno de oportunidades comerciales. Es un
// módulo APARTE de ai-router.js/chat() a propósito: la función
// chat() ya está probada y en producción; este análisis no debe
// poder romperla ni afectarla si falla.
//
// NUNCA le habla al usuario. Solo analiza la conversación y
// devuelve { leadScore, summary } para uso interno de chat.js.
// Si algo falla (red, parseo, falta de API key), devuelve un
// resultado neutro en vez de lanzar una excepción — quien llame
// a evaluateLead() nunca debe ver un error propagarse desde aquí.
// ============================================================

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_LEAD = 'gemini-3.5-flash-lite';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 300;

const LEAD_SYSTEM_INSTRUCTION = [
  'Eres un clasificador interno para JB TECH AI. NO conversas con el usuario directamente; solo analizas la conversación que se te entrega entre un visitante y el asistente.',
  'Devuelve un leadScore de 0 a 100 que indique qué tan clara es una oportunidad comercial real: negocio identificado + necesidad concreta + intención de resolverla ahora. 0 significa que claramente no hay ninguna oportunidad todavía (saludo, pregunta genérica, curiosidad); 100 significa que el negocio, el problema y la intención de avanzar están completamente claros.',
  'Si ya hay contexto suficiente (se sabe qué tipo de negocio es y qué problema o necesidad tiene), completa "summary" con los campos pedidos, en español, de forma breve (una frase corta por campo) y basada ÚNICAMENTE en lo que el usuario dijo explícitamente. No inventes ni asumas datos que no fueron mencionados.',
  'Si todavía no hay contexto suficiente para un resumen honesto, "summary" debe ser null — no lo rellenes con suposiciones.',
  'Responde ÚNICAMENTE el JSON solicitado, sin texto adicional, sin explicaciones, sin Markdown.'
].join('\n');

const LEAD_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    leadScore: { type: 'INTEGER' },
    summary: {
      type: 'OBJECT',
      nullable: true,
      properties: {
        proyecto: { type: 'STRING' },
        necesidad: { type: 'STRING' },
        problema: { type: 'STRING' },
        objetivo: { type: 'STRING' },
        solucion_sugerida: { type: 'STRING' }
      }
    }
  },
  required: ['leadScore']
};

const NEUTRAL_RESULT = { leadScore: 0, summary: null };

function mapRole(role) {
  return role === 'assistant' ? 'model' : 'user';
}

function toContents(messages) {
  return messages.map(function (m) {
    return { role: mapRole(m.role), parts: [{ text: m.content }] };
  });
}

async function evaluateLead(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !Array.isArray(messages) || messages.length === 0) {
    return NEUTRAL_RESULT;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      GEMINI_ENDPOINT_BASE + '/' + MODEL_LEAD + ':generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: LEAD_SYSTEM_INSTRUCTION }] },
          contents: toContents(messages),
          generationConfig: {
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
            responseSchema: LEAD_RESPONSE_SCHEMA
          }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) return NEUTRAL_RESULT;

    const data = await response.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!text) return NEUTRAL_RESULT;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      return NEUTRAL_RESULT;
    }

    const leadScore =
      typeof parsed.leadScore === 'number' && isFinite(parsed.leadScore)
        ? Math.max(0, Math.min(100, Math.round(parsed.leadScore)))
        : 0;

    const summary =
      parsed.summary && typeof parsed.summary === 'object' && !Array.isArray(parsed.summary)
        ? {
            proyecto: typeof parsed.summary.proyecto === 'string' ? parsed.summary.proyecto : '',
            necesidad: typeof parsed.summary.necesidad === 'string' ? parsed.summary.necesidad : '',
            problema: typeof parsed.summary.problema === 'string' ? parsed.summary.problema : '',
            objetivo: typeof parsed.summary.objetivo === 'string' ? parsed.summary.objetivo : '',
            solucion_sugerida: typeof parsed.summary.solucion_sugerida === 'string' ? parsed.summary.solucion_sugerida : ''
          }
        : null;

    return { leadScore: leadScore, summary: summary };
  } catch (err) {
    // Cualquier fallo (red, timeout, formato inesperado) devuelve
    // un resultado neutro. Este módulo nunca debe interrumpir la
    // conversación principal.
    return NEUTRAL_RESULT;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { evaluateLead: evaluateLead };
