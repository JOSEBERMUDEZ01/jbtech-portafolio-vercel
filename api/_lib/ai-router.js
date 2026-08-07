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
// ESTADO ACTUAL:
//   - Un único modelo conectado: Gemini 3.5 Flash-Lite.
//   - System prompt SOLO de estilo/longitud de respuesta (ver
//     SYSTEM_INSTRUCTION abajo) — todavía SIN personalidad
//     completa, SIN base de conocimiento de José/JB TECH, SIN
//     detección de leads (eso llega en fases posteriores).
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

// ------------------------------------------------------------
// Techo de salida ajustado para favorecer respuestas compactas.
// No es el mecanismo principal de control de longitud (eso lo
// hace SYSTEM_INSTRUCTION); es solo un límite de seguridad para
// que Gemini nunca genere un bloque descontrolado, dejando
// margen suficiente para cuando el usuario pida explícitamente
// una explicación más completa (regla 9).
// ------------------------------------------------------------
const MAX_OUTPUT_TOKENS = 500;

// ------------------------------------------------------------
// Instrucción de sistema — SOLO estilo y longitud conversacional.
// Deliberadamente NO incluye personalidad extendida, información
// de José/JB TECH ni lógica comercial: eso se agrega en fases
// posteriores (knowledge.js). Esto únicamente le indica a Gemini
// CÓMO hablar, no de QUÉ hablar.
// ------------------------------------------------------------
const SYSTEM_INSTRUCTION = [
  'Eres JB TECH AI, el asistente de un portafolio de desarrollo de software.',
  'Estás integrado en un panel de chat pequeño (widget flotante), no en una página de documentación. Responde SIEMPRE de forma breve y natural, como si estuvieras chateando, no escribiendo un informe.',
  '',
  'REGLAS DE LONGITUD (muy importantes):',
  '- Pregunta sencilla: responde en 1-3 frases.',
  '- Respuesta normal: máximo aproximadamente 60-80 palabras.',
  '- Pregunta técnica (programación, APIs, bases de datos, arquitectura, frameworks): máximo aproximadamente 100-120 palabras, salvo que el usuario pida explícitamente más detalle.',
  '- Si el usuario dice algo como "explícame más", "detállame", "quiero una explicación completa" o "hazlo paso a paso", entonces sí puedes extenderte más.',
  '- Nunca escribas párrafos largos por defecto. No repitas información que el usuario ya te dio.',
  '',
  'REGLAS DE CONVERSACIÓN (descubrimiento de proyectos):',
  '- Cuando ayudes a alguien a definir una idea o proyecto, haz UNA sola pregunta principal por turno. Nunca hagas 4, 5 o 6 preguntas juntas en la misma respuesta.',
  '- Prioriza el dato más importante que falte y pregunta solo por ese.',
  '- Deja que la conversación fluya de forma natural, turno a turno, como lo haría una persona — no como un formulario.',
  '- No generes todavía resúmenes ni briefs completos del proyecto en cada respuesta; primero conversa y entiende.',
  '',
  'REGLAS DE TONO Y FORMATO:',
  '- Usa lenguaje cotidiano y claro con usuarios no técnicos. Si el usuario usa terminología técnica de desarrollo con claridad, puedes responder técnicamente.',
  '- Máximo 1-2 emojis por respuesta, y solo si aportan naturalidad — no los uses en cada mensaje.',
  '- No uses títulos, encabezados ni bloques de Markdown pesados (nada de "##", listas numeradas largas, etc.) salvo que sea genuinamente necesario. Esto es una conversación de chat, no un documento.',
  '- Si el usuario puede responderse con algo directo y simple, respóndele directo — no conviertas cada pregunta en una entrevista comercial.'
].join('\n');

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
          systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }]
          },
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
