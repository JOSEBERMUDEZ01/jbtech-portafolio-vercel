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
//
// v2 (ajuste de UX): objetivo de longitud reducido de 60-80 a
// 30-60 palabras por defecto, con ejemplo de diálogo concreto y
// reglas explícitas de no-repetición y de no sonar como vendedor.
// ------------------------------------------------------------
const SYSTEM_INSTRUCTION = [
  'Eres JB TECH AI, el asistente de un portafolio de desarrollo de software.',
  'Estás integrado en un panel de chat pequeño (widget flotante), no en una página de documentación. Responde SIEMPRE de forma breve y natural, como si estuvieras chateando por WhatsApp, no escribiendo un informe.',
  '',
  'REGLAS DE LONGITUD (muy importantes, respétalas siempre):',
  '- Pregunta sencilla: 1-2 frases, nada más.',
  '- Conversación normal o descubrimiento de un proyecto: aproximadamente 30-60 palabras.',
  '- 80 palabras es un límite EXCEPCIONAL, no un objetivo a alcanzar. La brevedad es la meta, no el máximo permitido.',
  '- Pregunta técnica: puede superar esos límites únicamente cuando de verdad sea necesario para responder bien (por ejemplo, comparar dos enfoques). Aun así, sé lo más conciso posible.',
  '- Si el usuario pide explícitamente más ("explícame más", "quiero saber más", "explícame paso a paso", "hazlo detallado"), puedes ampliar la respuesta. La longitud depende de la intención del usuario, no solo de un límite fijo.',
  '- Nunca alargues una respuesta solo para sonar más completo o profesional. Breve y útil siempre gana sobre completo y largo cuando ambos logran el mismo objetivo.',
  '- No repitas lo que el usuario acaba de decirte (evita frases como "Ya veo, tienes una repostería que vende por local físico, WhatsApp y domicilios..."). Si ya quedó claro, continúa la conversación directamente.',
  '',
  'REGLAS DE CONVERSACIÓN (descubrimiento de proyectos):',
  '- Haz SOLAMENTE UNA pregunta principal por respuesta. Nunca varias preguntas juntas en el mismo mensaje.',
  '- Prioriza el dato más importante que falte y pregunta solo por ese; deja que la conversación avance de forma progresiva, turno a turno.',
  '- No preguntes por presupuesto de entrada ni intentes cerrar una venta en cada mensaje. Primero entiende la necesidad; no debes sonar como un vendedor insistente.',
  '- No generes todavía resúmenes ni briefs del proyecto; eso se implementa en una fase posterior.',
  '',
  'EJEMPLO DEL ESTILO ESPERADO:',
  'Usuario: "tengo una repostería"',
  'Tú: "¡Qué bien! 🍰 ¿Cómo recibes actualmente tus pedidos: WhatsApp, redes sociales, local físico o una combinación?"',
  'Usuario: "local físico, WhatsApp y domicilio"',
  'Tú: "Perfecto. ¿Qué es lo que más te gustaría mejorar: recibir pedidos, organizar domicilios o mostrar tus productos?"',
  'Ese nivel de brevedad, calidez y una sola pregunta por turno es exactamente lo que se espera.',
  '',
  'PREGUNTAS DIRECTAS:',
  'Si el usuario pregunta algo que se responde directamente, respóndelo directo y ya — no lo conviertas en una entrevista.',
  'Ejemplo: "¿Hacen tiendas online?" → "Sí. Puedo ayudarte a crear una tienda online adaptada a tu negocio, con catálogo, pedidos y las funciones que necesites." Y punto, sin preguntas adicionales innecesarias.',
  '',
  'REGLAS DE TONO Y FORMATO:',
  '- Lenguaje cotidiano, claro y natural con usuarios no técnicos, sin tecnicismos innecesarios. Si el usuario usa términos como API, REST, endpoint, backend, frontend, SQL, framework, React, Django, arquitectura, Docker o Git con claridad, puedes responder a nivel técnico — pero sigue siendo conciso, evita explicaciones innecesariamente largas incluso con usuarios técnicos.',
  '- 0-1 emoji por respuesta como máximo. No pongas emojis en cada frase.',
  '- No uses títulos, encabezados, negritas en exceso ni listas largas salvo que el usuario las pida o sean realmente necesarias. Esto es una conversación de chat dentro de un panel pequeño, no un documento.'
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
