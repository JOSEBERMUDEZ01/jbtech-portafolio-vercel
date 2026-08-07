// ============================================================
// AI ROUTER — api/_lib/ai-router.js
//
// Capa de abstracción entre /api/chat.js y el proveedor de IA.
// api/chat.js SOLO debe llamar a chat(messages); nunca debe
// conocer el proveedor, el modelo ni el formato de su API.
// Esto permite, en fases posteriores, agregar escalamiento a un
// modelo más potente u otro proveedor (OpenAI, etc.) sin tocar
// api/chat.js.
//
// ESTADO ACTUAL (verificación básica de conexión):
//   - Un único modelo conectado: Gemini 3.5 Flash-Lite.
//   - Sin system prompt / personalidad / base de conocimiento
//     (eso llega en fases posteriores).
//   - Sin escalamiento a otro modelo todavía.
//
// SEGURIDAD:
//   Este archivo corre EXCLUSIVAMENTE en el servidor (función
//   serverless de Vercel). GEMINI_API_KEY se lee únicamente de
//   process.env y jamás se incluye en la respuesta al cliente.
// ============================================================

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ------------------------------------------------------------
// Modelo principal.
//
// NOTA IMPORTANTE (verificado en la documentación oficial de
// Google — ai.google.dev — antes de configurar esto):
// Gemini 2.5 Flash y 2.5 Flash-Lite, aunque su fecha de retiro
// publicada es posterior, YA están devolviendo errores 404
// "no longer available" de forma intermitente desde julio de
// 2026. Los modelos actualmente GA (uso en producción) son la
// familia 3.x: Gemini 3.6 Flash y Gemini 3.5 Flash-Lite.
//
// Se usa Flash-Lite como modelo principal por ser el más rápido
// y económico de la familia GA — el mismo rol que cumpliría
// "Gemini Flash-Lite" en la arquitectura original. El escalamiento
// a gemini-3.6-flash (equivalente a "Gemini Flash") queda
// preparado para una fase posterior.
// ------------------------------------------------------------
const MODEL_PRIMARY = 'gemini-3.5-flash-lite';

const REQUEST_TIMEOUT_MS = 20000;
const MAX_OUTPUT_TOKENS = 800;

// ------------------------------------------------------------
// Gemini usa "model" en vez de "assistant" para el rol de la IA.
// ------------------------------------------------------------
function mapRoleToGemini(role) {
  return role === 'assistant' ? 'model' : 'user';
}

function toGeminiContents(messages) {
  return messages.map(function (m) {
    return {
      role: mapRoleToGemini(m.role),
      parts: [{ text: m.content }]
    };
  });
}

function extractText(data) {
  return (
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text
  );
}

// ------------------------------------------------------------
// Llamada real a la API de Gemini (generateContent).
// Lanza un Error genérico ante cualquier fallo; el mensaje NUNCA
// incluye la API key ni el cuerpo crudo de la respuesta de Google
// (que podría traer detalles internos).
// ------------------------------------------------------------
async function callGemini(model, messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Error de configuración del servidor, no del usuario.
    throw new Error('GEMINI_API_KEY no está configurada en el servidor.');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      GEMINI_ENDPOINT_BASE + '/' + model + ':generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // La clave viaja SOLO en este header, servidor→Google.
          // Nunca se refleja en la respuesta que arma chat.js.
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: toGeminiContents(messages),
          generationConfig: {
            maxOutputTokens: MAX_OUTPUT_TOKENS
          }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      // No se propaga el cuerpo de la respuesta de error de Google:
      // podría incluir detalles internos de la cuenta/proyecto.
      throw new Error('Gemini respondió con estado HTTP ' + response.status);
    }

    const data = await response.json();
    const text = extractText(data);

    if (!text) {
      throw new Error('La respuesta de Gemini no trajo contenido de texto.');
    }

    return text.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ------------------------------------------------------------
// Interfaz pública del router.
// ------------------------------------------------------------
async function chat(messages) {
  const text = await callGemini(MODEL_PRIMARY, messages);
  return { reply: text, model: MODEL_PRIMARY };
}

module.exports = { chat: chat, MODEL_PRIMARY: MODEL_PRIMARY };
