// ============================================================
// FUNCIÓN (Vercel): /api/chat.js
// Backend de JB TECH AI — FASE 3 (conexión básica a Gemini).
//
// Esta fase hace 4 cosas:
//   1. Valida estrictamente la petición (nunca confía en el frontend).
//   2. Aplica rate limiting con Vercel KV, en un namespace propio
//      ("chat:*"), completamente separado del formulario de
//      contacto ("ratelimit:*" en send-email.js).
//   3. Delega la conversación al AI Router (_lib/ai-router.js),
//      que hoy llama a Gemini 3.5 Flash-Lite.
//   4. Devuelve al widget únicamente { ok, reply, meta } — nunca
//      la API key, ni detalles del proveedor, ni errores internos.
//
// NO hace todavía (fases posteriores):
//   - System prompt / personalidad de JB TECH AI
//   - Base de conocimiento (knowledge.js)
//   - Detección de leads / resúmenes / documentos / exportaciones
//   - Escalamiento automático a un segundo modelo
//   - Memoria real de conversación entre peticiones
//
// Variable de entorno usada:
//   GEMINI_API_KEY  -> leída exclusivamente en api/_lib/ai-router.js
//   vía process.env. Configurada solo en Vercel → Project Settings →
//   Environment Variables. Nunca aparece en index.html, en
//   JavaScript del cliente, ni en ningún archivo servido al navegador.
// ============================================================

const { kv } = require('@vercel/kv');
const aiRouter = require('./_lib/ai-router.js');
const leadDetector = require('./_lib/lead-detector.js');

// ------------------------------------------------------------
// CONFIGURACIÓN — límites fáciles de ajustar
// ------------------------------------------------------------
const CONFIG = {
  // Rate limit por IP (evita que una sola IP sature el endpoint)
  MAX_REQUESTS_PER_IP: 30,          // peticiones
  IP_WINDOW_MS: 60 * 60 * 1000,     // por hora

  // Rate limit por sesión (evita conversaciones infinitas de un bot)
  MAX_TURNS_PER_SESSION: 40,        // turnos (peticiones) por sesión
  SESSION_WINDOW_MS: 2 * 60 * 60 * 1000, // 2 horas (mismo horizonte que tendrá la memoria de conversación en fases posteriores)

  // Límites de forma del payload
  MAX_MESSAGES_PER_REQUEST: 30,     // el frontend puede reenviar historial completo
  MAX_MESSAGE_LENGTH: 1500,         // caracteres por mensaje individual
  MAX_TOTAL_CONTENT_CHARS: 8000,    // suma de caracteres de todos los mensajes
  MAX_PAYLOAD_BYTES: 30000,         // tamaño máximo aceptado del body crudo

  SESSION_ID_REGEX: /^[a-zA-Z0-9_-]{8,64}$/,
  ALLOWED_ROLES: ['user', 'assistant']
};

// ------------------------------------------------------------
// Respuesta de error consistente (nunca expone detalles internos)
// ------------------------------------------------------------
function fail(res, status, message) {
  return res.status(status).json({ error: true, message: message });
}

// ------------------------------------------------------------
// Extrae la IP igual que send-email.js, para mantener consistencia
// ------------------------------------------------------------
function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

// ------------------------------------------------------------
// Valida y normaliza el body recibido.
// Devuelve { ok: true, sessionId, messages } o { ok: false, message }
// ------------------------------------------------------------
function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'Formato de solicitud inválido.' };
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    return { ok: false, message: 'Falta el identificador de sesión.' };
  }
  if (!CONFIG.SESSION_ID_REGEX.test(sessionId)) {
    return { ok: false, message: 'Identificador de sesión inválido.' };
  }

  if (!Array.isArray(body.messages)) {
    return { ok: false, message: 'El formato de la conversación es inválido.' };
  }
  if (body.messages.length === 0) {
    return { ok: false, message: 'No se recibió ningún mensaje.' };
  }
  if (body.messages.length > CONFIG.MAX_MESSAGES_PER_REQUEST) {
    return { ok: false, message: 'La conversación enviada es demasiado larga.' };
  }

  const cleanMessages = [];
  let totalChars = 0;

  for (let i = 0; i < body.messages.length; i++) {
    const raw = body.messages[i];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, message: 'Uno de los mensajes tiene un formato inválido.' };
    }

    const role = typeof raw.role === 'string' ? raw.role.trim() : '';
    if (!CONFIG.ALLOWED_ROLES.includes(role)) {
      return { ok: false, message: 'Uno de los mensajes tiene un rol no permitido.' };
    }

    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!content) {
      return { ok: false, message: 'Uno de los mensajes está vacío.' };
    }
    if (content.length > CONFIG.MAX_MESSAGE_LENGTH) {
      return { ok: false, message: 'Uno de los mensajes es demasiado largo.' };
    }

    totalChars += content.length;
    if (totalChars > CONFIG.MAX_TOTAL_CONTENT_CHARS) {
      return { ok: false, message: 'La conversación enviada excede el tamaño permitido.' };
    }

    cleanMessages.push({ role: role, content: content });
  }

  return { ok: true, sessionId: sessionId, messages: cleanMessages };
}

// ------------------------------------------------------------
// Aplica un contador con ventana deslizante sobre una clave KV.
// Reutiliza el mismo patrón { count, firstAttempt } + TTL en "px"
// que ya usa send-email.js, pero en un namespace independiente.
// ------------------------------------------------------------
async function checkAndBumpLimit(key, max, windowMs) {
  const now = Date.now();
  let record = await kv.get(key);

  if (!record || (now - record.firstAttempt) > windowMs) {
    record = { count: 0, firstAttempt: now };
  }

  if (record.count >= max) {
    return { allowed: false };
  }

  record.count += 1;
  await kv.set(key, record, { px: windowMs });

  return { allowed: true, remaining: max - record.count };
}

module.exports = async function handler(req, res) {
  // --------------------------------------------------------
  // 1. Método HTTP permitido
  // --------------------------------------------------------
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Método no permitido.');
  }

  try {
    // ------------------------------------------------------
    // 2. Content-Type
    // ------------------------------------------------------
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return fail(res, 400, 'Tipo de contenido no soportado.');
    }

    // ------------------------------------------------------
    // 3. Tamaño del payload (defensa adicional además del
    //    límite de body que ya aplica Vercel por defecto)
    // ------------------------------------------------------
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > CONFIG.MAX_PAYLOAD_BYTES) {
      return fail(res, 413, 'La solicitud es demasiado grande.');
    }

    // ------------------------------------------------------
    // 4. Validación estricta del contenido
    // ------------------------------------------------------
    const validation = validatePayload(req.body);
    if (!validation.ok) {
      return fail(res, 400, validation.message);
    }

    const { sessionId, messages } = validation;

    // ------------------------------------------------------
    // 5. Rate limiting — namespace "chat:*", separado del
    //    formulario de contacto ("ratelimit:*") y de cualquier
    //    otro límite existente en el proyecto.
    // ------------------------------------------------------
    const ip = getClientIp(req);

    const ipLimit = await checkAndBumpLimit(
      'chat:ip:' + ip,
      CONFIG.MAX_REQUESTS_PER_IP,
      CONFIG.IP_WINDOW_MS
    );
    if (!ipLimit.allowed) {
      return fail(res, 429, 'Has alcanzado temporalmente el límite de mensajes. Inténtalo nuevamente más tarde.');
    }

    const sessionLimit = await checkAndBumpLimit(
      'chat:session:' + sessionId,
      CONFIG.MAX_TURNS_PER_SESSION,
      CONFIG.SESSION_WINDOW_MS
    );
    if (!sessionLimit.allowed) {
      return fail(res, 429, 'Esta conversación alcanzó su límite de mensajes. Puedes iniciar una nueva o escribir por WhatsApp.');
    }

    // ------------------------------------------------------
    // 6. Llamada al AI Router (Gemini). chat.js NO conoce
    //    detalles del proveedor: solo le pasa los mensajes ya
    //    validados y recibe { reply, model }.
    //
    //    En paralelo (no en secuencia, para no duplicar la
    //    latencia) se ejecuta best-effort la evaluación interna
    //    de leadScore/summary — solo cada 2 turnos a partir del
    //    4to mensaje, para controlar costo y latencia. Un fallo
    //    aquí NUNCA afecta la respuesta principal al usuario.
    // ------------------------------------------------------
    // Se cuenta por turnos de usuario, no por longitud cruda del
    // array: la petición siempre termina en un mensaje de usuario
    // sin responder todavía, así que el array tiene longitud impar
    // en cada turno — contar "user" evita que la condición nunca
    // se cumpla.
    const userTurnCount = messages.reduce(function (acc, m) { return m.role === 'user' ? acc + 1 : acc; }, 0);
    const shouldEvaluateLead = userTurnCount >= 2 && userTurnCount % 2 === 0;

    let aiResult;
    let leadResult = null;
    try {
      if (shouldEvaluateLead) {
        const parallel = await Promise.all([
          aiRouter.chat(messages),
          leadDetector.evaluateLead(messages).catch(function () { return null; })
        ]);
        aiResult = parallel[0];
        leadResult = parallel[1];
      } else {
        aiResult = await aiRouter.chat(messages);
      }
    } catch (aiErr) {
      // Nunca se expone el mensaje real del error de Gemini
      // (podría incluir detalles internos). Solo se registra
      // en logs del servidor para diagnóstico.
      console.log('chat.js error del AI Router:', aiErr && aiErr.message);
      return fail(res, 502, 'El asistente no está disponible en este momento. Intenta nuevamente en unos segundos o escríbenos por WhatsApp.');
    }

    // ------------------------------------------------------
    // 7. Persistir/recuperar el leadScore actual (KV, namespace
    //    "chat:lead:*", TTL igual al de la sesión). Nunca se
    //    envía el "summary" completo al navegador aquí — solo
    //    el número, para que el widget decida si mostrar el
    //    flujo de consentimiento. El resumen se usa únicamente
    //    server-side en /api/lead.js.
    // ------------------------------------------------------
    let currentLeadScore = null;
    if (leadResult) {
      currentLeadScore = leadResult.leadScore;
      try {
        await kv.set('chat:lead:' + sessionId, leadResult, { px: CONFIG.SESSION_WINDOW_MS });
      } catch (kvErr) {
        console.log('chat.js error guardando leadResult en KV:', kvErr && kvErr.message);
      }
    } else {
      try {
        const previous = await kv.get('chat:lead:' + sessionId);
        if (previous && typeof previous.leadScore === 'number') {
          currentLeadScore = previous.leadScore;
        }
      } catch (kvErr) {
        currentLeadScore = null;
      }
    }

    return res.status(200).json({
      ok: true,
      reply: aiResult.reply,
      meta: {
        engineConnected: true,
        sessionId: sessionId,
        messagesReceived: messages.length,
        leadScore: currentLeadScore
      }
    });
  } catch (err) {
    // Nunca se expone err.message, stack, ni detalles internos.
    console.log('chat.js error interno:', err && err.message);
    return fail(res, 500, 'No pudimos procesar la solicitud.');
  }
};
