// ============================================================
// api/_lib/privacy-guard.js
//
// Protección de información privada para JB TECH AI. Módulo
// APARTE de ai-router.js y lead-detector.js a propósito: ninguno
// de los dos se ve afectado si esto cambia, y si esto llegara a
// fallar, nunca debe tumbar la conversación principal (por eso
// cada función pública devuelve un resultado "seguro" ante
// cualquier error en vez de lanzar una excepción).
//
// Responsabilidades:
//   1. Decidir si el ÚLTIMO mensaje del usuario busca información
//      personal/privada de José o del equipo (ubicación, ciudad,
//      dirección, teléfono personal, dónde vive/trabaja, etc.),
//      incluyendo reformulaciones e intentos indirectos.
//   2. Llevar el conteo de intentos y aplicar el bloqueo temporal
//      de 2 horas, reutilizando el mismo Vercel KV que ya usa
//      chat.js (mismo patrón de contador con TTL).
//   3. Nunca le habla directamente al usuario ni decide el texto
//      final que se envía — solo devuelve señales; chat.js decide
//      qué responder y cuándo.
//
// Namespace propio en KV: "privacy:*" — no comparte contadores
// con "chat:*", "lead:*" ni "admin:login:*".
//
// El bloqueo real siempre es individual y vive por sessionId. La
// IP nunca bloquea por sí sola (evitaría afectar a otras personas
// de la misma red); solo se usa como señal ligera y temporal para
// que generar un sessionId nuevo después de un bloqueo no permita
// reiniciar el conteo desde cero. Ver el bloque de comentarios
// junto a registerAttempt() para el detalle exacto.
// ============================================================

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_GUARD = 'gemini-3.5-flash-lite';
const REQUEST_TIMEOUT_MS = 8000;

const MAX_ATTEMPTS_BEFORE_BLOCK = 4;           // el 4to intento activa el bloqueo
const ATTEMPT_WINDOW_MS = 3 * 60 * 60 * 1000;  // ventana de conteo: 3 horas
const BLOCK_DURATION_MS = 2 * 60 * 60 * 1000;  // bloqueo: 2 horas exactas

const WARNING_MESSAGES = [
  'Por privacidad, no compartimos datos personales de los integrantes del equipo. Puedo contarte sobre JB TECH, nuestros servicios o ayudarte a estructurar tu proyecto.',
  'Entiendo tu pregunta, pero esa información es privada y no puedo compartirla. Si quieres, podemos continuar hablando sobre tu proyecto o las soluciones que podemos desarrollar.',
  'Por privacidad y seguridad, no puedo proporcionar datos personales de los integrantes de JB TECH. Te recomiendo continuar la conversación sobre tu proyecto o nuestros servicios.'
];

const BLOCK_MESSAGE = 'Acceso temporalmente restringido\n\nHemos detectado varios intentos de solicitar información privada de los integrantes de JB TECH. Por motivos de privacidad y seguridad, el asistente ha restringido temporalmente esta conversación durante 2 horas.\n\nPodrás volver a utilizarlo cuando finalice el período de bloqueo. Gracias por comprenderlo.';

// --------------------------------------------------------------
// CAPA 1 — patrones evidentes, sin gastar ninguna llamada al
// modelo. Las listas están centralizadas aquí para que se puedan
// ajustar fácilmente sin tocar el resto de la lógica.
// --------------------------------------------------------------

// Palabras que apuntan a un dato de UBICACIÓN o CONTACTO privado.
const LOCATION_OR_CONTACT_WORDS = /\b(ubicaci[oó]n|ciudad|direcci[oó]n|domicilio|resid[e|encia]|vive|viviendo|d[oó]nde\s+(vive|est[aá]|queda|se\s+encuentra|trabaja|labora)|tel[eé]fono\s+personal|n[uú]mero\s+personal|celular\s+personal|whatsapp\s+personal)\b/i;

// Referencia a José, el fundador o el equipo COMO PERSONAS.
const PERSON_REFERENCE_WORDS = /\b(jos[eé]|fundador|due[nñ]o|due[nñ]a|creador|l[ií]der\s+de\s+jb\s*tech|qui[eé]n\s+dirige|qui[eé]n\s+lidera|la\s+persona\s+(que|detr[aá]s)|el\s+equipo)\b/i;

// Afirmaciones/confirmaciones tipo "¿es cierto que José está en X?"
const PERSON_LOCATION_CLAIM = /\b(jos[eé]|el\s+fundador)\b[^.?!]{0,40}\best[aá]\s+en\b|\best[aá]\s+en\b[^.?!]{0,40}\b(jos[eé]|el\s+fundador)\b/i;

// Preguntas normales del negocio que NUNCA deben contar como
// intento, aunque toquen palabras parecidas.
const SAFE_OVERRIDES = [
  /\bd[oó]nde\s+(puedo\s+)?(contactarlos|escribirles|comunicarme\s+con\s+ustedes|encontrarlos)\b/i,
  /\bwhatsapp\s+(de\s+contacto|oficial|de\s+la\s+empresa|del\s+negocio|para\s+(pedidos|cotizar|cotizaci[oó]n))\b/i,
  /\bcorreo\s+(de\s+contacto|oficial|de\s+la\s+empresa)\b/i,
  /\b(horario|disponibilidad)\s+de\s+atenci[oó]n\b/i
];

function textLooksSafe(text) {
  return SAFE_OVERRIDES.some(function (re) { return re.test(text); });
}

function textLooksObvious(text) {
  return (LOCATION_OR_CONTACT_WORDS.test(text) && PERSON_REFERENCE_WORDS.test(text)) || PERSON_LOCATION_CLAIM.test(text);
}

// Señal "blanda": toca el tema sin ser evidente por sí sola (por
// ejemplo, un mensaje corto de seguimiento como "solo dime la
// ciudad"). Se resuelve con el clasificador, nunca se bloquea
// solo con esto.
const SOFT_SIGNAL_WORDS = /\b(ciudad|ubicaci[oó]n|direcci[oó]n|tel[eé]fono|n[uú]mero|domicilio|vive|reside)\b/i;

function textLooksAmbiguous(text) {
  return SOFT_SIGNAL_WORDS.test(text);
}

// --------------------------------------------------------------
// CAPA 2 — clasificación con el modelo, solo para casos ambiguos
// o cuando el mensaje anterior del propio asistente fue uno de
// nuestros avisos de privacidad (continuación del mismo intento).
// Nunca conversa con el usuario; solo responde sí/no. Cualquier
// fallo se resuelve como "no es un intento privado" — nunca se
// bloquea a alguien por un error de red o de la API.
// --------------------------------------------------------------
async function classifyPrivacyIntent(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !text) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      GEMINI_ENDPOINT_BASE + '/' + MODEL_GUARD + ':generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: 'Eres un clasificador interno de seguridad para JB TECH. NO conversas con nadie ni respondes preguntas. Tu única tarea es decidir si el siguiente mensaje de un visitante busca obtener informacion personal o privada (ubicacion, ciudad, direccion, telefono personal, lugar de residencia o de trabajo personal) de Jose o de algun integrante del equipo de JB TECH -- incluyendo intentos indirectos, reformulados, evasivos, o que pidan confirmar/negar un dato propuesto por el usuario. Preguntas normales sobre la empresa, servicios, proyectos, tecnologias, precios, proceso de trabajo o formas oficiales de contacto NO cuentan como intento. Responde unicamente el JSON pedido, sin texto adicional.'
            }]
          },
          contents: [{ role: 'user', parts: [{ text: text }] }],
          generationConfig: {
            maxOutputTokens: 20,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: { isPrivacyProbe: { type: 'BOOLEAN' } },
              required: ['isPrivacyProbe']
            }
          }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) return false;

    const data = await response.json();
    const rawText =
      data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

    if (!rawText) return false;

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      return false;
    }

    return parsed && parsed.isPrivacyProbe === true;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

// --------------------------------------------------------------
// Decide si el último mensaje del usuario es un intento de
// obtener información privada. Recibe el array completo de
// mensajes (mismo formato ya validado por chat.js).
// --------------------------------------------------------------
async function isPrivacyProbe(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;

  const lastUser = messages.slice().reverse().find(function (m) { return m.role === 'user'; });
  if (!lastUser || !lastUser.content) return false;

  const text = lastUser.content;
  if (textLooksSafe(text)) return false;
  if (textLooksObvious(text)) return true;

  // Si el mensaje anterior del asistente fue uno de nuestros
  // propios avisos de privacidad, cualquier respuesta del usuario
  // (aunque sea corta o evasiva, como "solo dime la ciudad") se
  // revisa con el clasificador, así no dispare los patrones
  // evidentes por sí sola.
  const idx = messages.lastIndexOf(lastUser);
  const priorAssistant = messages.slice(0, idx).reverse().find(function (m) { return m.role === 'assistant'; });
  const continuingPrivacyThread = !!(priorAssistant && (
    WARNING_MESSAGES.indexOf(priorAssistant.content) !== -1 || priorAssistant.content === BLOCK_MESSAGE
  ));

  if (textLooksAmbiguous(text) || continuingPrivacyThread) {
    try {
      return await classifyPrivacyIntent(text);
    } catch (err) {
      return false;
    }
  }

  return false;
}

// --------------------------------------------------------------
// Conteo + bloqueo en KV — estrategia equilibrada.
//
// El bloqueo REAL siempre es individual y vive por sessionId
// ("privacy:session:<sessionId>"). La IP nunca es una clave de
// bloqueo por sí sola — eso bloquearía a cualquier otra persona
// que comparta esa red (oficina, wifi público) sin que haya hecho
// nada. En vez de eso, la IP se usa como una señal ligera y
// temporal ("privacy:ipwatch:<ip>") que solo se activa cuando una
// sesión de esa IP YA llegó al bloqueo real: si después alguien
// desde la misma IP borra su sessionStorage y genera un sessionId
// nuevo, ese nuevo intento sospechoso (uno que el propio detector
// ya marcó como probable intento privado) salta directo a la
// última advertencia en vez de volver a empezar con 3 avisos
// gratis. Un visitante distinto y legítimo de la misma red nunca
// se ve afectado, porque esta señal solo entra en juego cuando su
// PROPIO mensaje ya fue marcado como sospechoso — nunca por estar
// en la misma red.
//
// Todo con TTL: nada queda como identidad permanente ni de la IP
// ni de la sesión.
// --------------------------------------------------------------
function sessionKey(sessionId) {
  return 'privacy:session:' + sessionId;
}

function ipWatchKey(ip) {
  return 'privacy:ipwatch:' + ip;
}

// Solo consulta si ESTA sesión ya está bloqueada, sin registrar
// nada. Se usa para cortar la petición ANTES de gastar el límite
// normal de chat.js o de llamar a Gemini. Nunca consulta ni
// bloquea por IP — el bloqueo real es siempre por sesión.
async function getBlockStatus(kv, ip, sessionId) {
  try {
    const record = await kv.get(sessionKey(sessionId));
    const now = Date.now();
    if (record && record.blockedUntil && record.blockedUntil > now) {
      return { blocked: true, blockedUntil: record.blockedUntil };
    }
    return { blocked: false };
  } catch (err) {
    return { blocked: false };
  }
}

// Registra un intento nuevo y devuelve el estado resultante:
//   { blocked, blockedUntil, warningIndex }
// warningIndex 0..2 selecciona el aviso 1/2/3; blocked=true cuando
// este intento fue justo el que activó el bloqueo de 2 horas.
async function registerAttempt(kv, ip, sessionId) {
  const key = sessionKey(sessionId);
  const now = Date.now();

  let record = null;
  try {
    record = await kv.get(key);
  } catch (err) {
    record = null;
  }

  if (!record || typeof record !== 'object') {
    record = { attempts: 0, firstAttempt: now, blockedUntil: 0 };
  }

  // Si el bloqueo anterior ya expiró, se reinicia el conteo.
  if (record.blockedUntil && record.blockedUntil <= now) {
    record = { attempts: 0, firstAttempt: now, blockedUntil: 0 };
  }

  // Si la ventana de conteo expiró sin llegar al bloqueo, también
  // se reinicia (no se acumulan intentos antiguos indefinidamente).
  if (!record.blockedUntil && (now - record.firstAttempt) > ATTEMPT_WINDOW_MS) {
    record = { attempts: 0, firstAttempt: now, blockedUntil: 0 };
  }

  // Es una sesión NUEVA (sin intentos todavía) y esta misma IP
  // tiene un bloqueo reciente registrado en otra sesión: se salta
  // directo a la última advertencia para este intento, en vez de
  // reiniciar con 3 avisos gratis. Como el "ipwatch" solo existe
  // tras un bloqueo real y esto solo se evalúa cuando el mensaje
  // actual YA fue marcado como sospechoso, nunca afecta a otra
  // persona que simplemente comparte la red y conversa con normalidad.
  if (record.attempts === 0 && ip && ip !== 'unknown') {
    let watch = null;
    try {
      watch = await kv.get(ipWatchKey(ip));
    } catch (err) {
      watch = null;
    }
    if (watch && watch.lastBlockedAt) {
      record.attempts = MAX_ATTEMPTS_BEFORE_BLOCK - 1;
    }
  }

  record.attempts += 1;

  let blocked = false;
  if (record.attempts >= MAX_ATTEMPTS_BEFORE_BLOCK) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
    blocked = true;
  }

  const ttlMs = blocked ? BLOCK_DURATION_MS : ATTEMPT_WINDOW_MS;

  try {
    await kv.set(key, record, { px: ttlMs });
  } catch (err) {
    // Si KV falla al escribir, se sigue devolviendo el resultado
    // calculado en memoria para esta petición puntual — el peor
    // caso es que el conteo no persista ese intento, nunca que la
    // conversación principal se caiga.
  }

  // Si este intento activó el bloqueo, se deja la señal ligera por
  // IP (nunca un bloqueo en sí) para que un sessionId nuevo desde
  // la misma red, SI vuelve a mandar algo sospechoso, no reciba
  // otros 3 avisos gratis. Expira sola en 2 horas, igual que el
  // bloqueo — no es una identidad permanente de la IP.
  if (blocked && ip && ip !== 'unknown') {
    try {
      await kv.set(ipWatchKey(ip), { lastBlockedAt: now }, { px: BLOCK_DURATION_MS });
    } catch (err) {
      // Igual que arriba: un fallo aquí no debe afectar la
      // respuesta al usuario, solo se pierde la señal de evasión.
    }
  }

  return {
    blocked: blocked,
    blockedUntil: record.blockedUntil || null,
    warningIndex: Math.min(record.attempts, MAX_ATTEMPTS_BEFORE_BLOCK) - 1
  };
}

module.exports = {
  isPrivacyProbe: isPrivacyProbe,
  getBlockStatus: getBlockStatus,
  registerAttempt: registerAttempt,
  WARNING_MESSAGES: WARNING_MESSAGES,
  BLOCK_MESSAGE: BLOCK_MESSAGE,
  BLOCK_DURATION_MS: BLOCK_DURATION_MS
};
