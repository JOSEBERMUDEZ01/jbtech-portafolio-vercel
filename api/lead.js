// ============================================================
// FUNCIÓN (Vercel): /api/lead.js
//
// Endpoint SEPARADO de /api/chat.js a propósito: chat.js sigue
// siendo puramente conversacional y su contrato no cambió. Este
// endpoint solo entra en juego cuando el usuario decide autorizar
// (o no) el tratamiento de sus datos para dar seguimiento a un
// posible proyecto — el flujo de consentimiento de la Fase 5/8
// del prompt maestro.
//
// Reutiliza (no duplica):
//   - Vercel KV para rate limiting, mismo patrón que chat.js,
//     namespace propio "lead:*".
//   - api/_lib/db.js -> Supabase, para persistencia.
//   - api/_lib/notify.js -> Resend + CallMeBot (mismas cuentas
//     que ya usa api/send-email.js).
//
// El "summary" y el "leadScore" NUNCA se aceptan desde el
// frontend: se recuperan del lado del servidor (KV, calculados
// por api/chat.js + lead-detector.js durante la conversación
// real). Esto evita que alguien envíe un resumen de proyecto
// falso directamente al endpoint.
//
// Variables de entorno usadas (algunas ya existían):
//   RESEND_API_KEY               -> ya configurada (send-email.js)
//   SUPABASE_URL                 -> NUEVA, hay que configurarla
//   SUPABASE_SERVICE_ROLE_KEY    -> NUEVA, hay que configurarla
// ============================================================

const { kv } = require('@vercel/kv');
const db = require('./_lib/db.js');
const notify = require('./_lib/notify.js');

const CONFIG = {
  MAX_REQUESTS_PER_IP: 10,
  IP_WINDOW_MS: 60 * 60 * 1000,
  SESSION_ID_REGEX: /^[a-zA-Z0-9_-]{8,64}$/,
  MAX_NAME_LENGTH: 100,
  MAX_CONTACT_LENGTH: 100,
  POLICY_VERSION: '2026-08'
};

function fail(res, status, message) {
  return res.status(status).json({ error: true, message: message });
}

function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

async function checkAndBumpLimit(key, max, windowMs) {
  const now = Date.now();
  let record = await kv.get(key);
  if (!record || (now - record.firstAttempt) > windowMs) {
    record = { count: 0, firstAttempt: now };
  }
  if (record.count >= max) return { allowed: false };
  record.count += 1;
  await kv.set(key, record, { px: windowMs });
  return { allowed: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Método no permitido.');
  }

  try {
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return fail(res, 400, 'Tipo de contenido no soportado.');
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'Formato de solicitud inválido.');
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId || !CONFIG.SESSION_ID_REGEX.test(sessionId)) {
      return fail(res, 400, 'Identificador de sesión inválido.');
    }

    const consent = body.consent === true;
    const isUpdate = body.update === true;

    let contact = null;
    if (consent) {
      const c = (body && typeof body.contact === 'object' && body.contact) || {};
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, CONFIG.MAX_NAME_LENGTH) : '';
      const whatsapp = typeof c.whatsapp === 'string' ? c.whatsapp.trim().slice(0, CONFIG.MAX_CONTACT_LENGTH) : '';
      const email = typeof c.email === 'string' ? c.email.trim().slice(0, CONFIG.MAX_CONTACT_LENGTH) : '';

      if (!name || (!whatsapp && !email)) {
        return fail(res, 400, 'Para continuar necesitamos al menos tu nombre y un WhatsApp o correo.');
      }
      contact = { name: name, whatsapp: whatsapp, email: email };
    }

    // ------------------------------------------------------
    // Rate limiting propio, namespace "lead:*" — no comparte
    // contador con "chat:*" ni con "ratelimit:*" del formulario.
    // ------------------------------------------------------
    const ip = getClientIp(req);
    const ipLimit = await checkAndBumpLimit('lead:ip:' + ip, CONFIG.MAX_REQUESTS_PER_IP, CONFIG.IP_WINDOW_MS);
    if (!ipLimit.allowed) {
      return fail(res, 429, 'Has alcanzado temporalmente el límite de solicitudes. Inténtalo más tarde.');
    }

    // ------------------------------------------------------
    // El leadScore/summary se recupera del servidor (KV), NUNCA
    // del cuerpo de la petición del cliente.
    // ------------------------------------------------------
    let leadData = null;
    try {
      leadData = await kv.get('chat:lead:' + sessionId);
    } catch (kvErr) {
      leadData = null;
    }
    const leadScore = leadData && typeof leadData.leadScore === 'number' ? leadData.leadScore : null;
    const summary = leadData && leadData.summary ? leadData.summary : null;

    if (!consent) {
      // No autorizó: no se almacena ningún dato personal. No se
      // insiste ni se bloquea la conversación (eso lo maneja el
      // widget); aquí solo se confirma que no hubo persistencia.
      return res.status(200).json({ ok: true, stored: false });
    }

    // ------------------------------------------------------
    // Guardar en Supabase
    // ------------------------------------------------------
    let stored = false;
    let storedResult = null;
    try {
      storedResult = await db.saveLeadPackage({
        sessionId: sessionId,
        idioma: 'es',
        consent: true,
        policyVersion: CONFIG.POLICY_VERSION,
        contact: contact,
        summary: summary,
        leadScore: leadScore,
        isUpdate: isUpdate
      });
      stored = true;
    } catch (dbErr) {
      console.log('lead.js error guardando en Supabase:', dbErr && dbErr.message);
      stored = false;
    }

    // ------------------------------------------------------
    // Notificar (best-effort). El resultado real de cada canal
    // se devuelve tal cual al frontend — el widget nunca debe
    // afirmar más de lo que aquí se confirma.
    //
    // El texto/HTML de cada canal lo arma notify.js (una sola
    // fuente de verdad para el formato de las notificaciones);
    // aquí solo se le pasan los datos ya validados.
    // ------------------------------------------------------
    // Si el cliente solo envió el mismo estado de proyecto otra vez,
    // no se genera otra notificación. El mismo lead se conserva y no
    // llenamos Gmail/WhatsApp de duplicados.
    const changed = storedResult && storedResult.changed === true;
    const created = storedResult && storedResult.created === true;
    const updated = storedResult && storedResult.updated === true;

    let emailResult = { ok: false };
    let waResult = { ok: false };

    if (changed) {
      const eventType = created ? 'new' : 'update';
      const emailHtml = notify.buildLeadEmailHtml({
        contact: contact,
        summary: summary,
        leadScore: leadScore,
        stored: stored,
        eventType: eventType
      });
      const subject = created
        ? 'Nuevo lead — JB TECH AI: ' + contact.name
        : 'Actualización de lead — JB TECH AI: ' + contact.name;
      emailResult = await notify.sendEmailNotification(subject, emailHtml);

      const waText = notify.buildWhatsAppText({
        contact: contact,
        summary: summary,
        leadScore: leadScore,
        eventType: eventType
      });
      waResult = await notify.sendWhatsAppNotification(waText);
    }

    return res.status(200).json({
      ok: true,
      stored: stored,
      created: created,
      updated: updated,
      changed: changed,
      notified: { email: emailResult.ok, whatsapp: waResult.ok }
    });
  } catch (err) {
    console.log('lead.js error interno:', err && err.message);
    return fail(res, 500, 'No pudimos procesar la solicitud.');
  }
};
