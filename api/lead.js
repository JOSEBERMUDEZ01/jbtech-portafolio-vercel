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
//   SUPABASE_SECRET_KEY          -> variable ya existente en Vercel; se conserva
// ============================================================

const { kv } = require('@vercel/kv');
const db = require('./_lib/db.js');
const notify = require('./_lib/notify.js');
const crypto = require('crypto');

const CONFIG = {
  MAX_REQUESTS_PER_IP: 10,
  MAX_REQUESTS_PER_SESSION: 6,
  IP_WINDOW_MS: 60 * 60 * 1000,
  MIN_FORM_TIME_MS: 1800,
  MAX_BODY_BYTES: 32 * 1024,
  SESSION_ID_REGEX: /^[a-zA-Z0-9_-]{8,64}$/,
  MAX_NAME_LENGTH: 100,
  MAX_CONTACT_LENGTH: 100,
  POLICY_VERSION: '2026-08'
};

function fail(res, status, message) {
  return res.status(status).json({ error: true, message: message });
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
  setSecurityHeaders(res);
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
    try {
      if (Buffer.byteLength(JSON.stringify(body || {}), 'utf8') > CONFIG.MAX_BODY_BYTES) {
        return fail(res, 413, 'Solicitud demasiado grande.');
      }
    } catch (e) {
      return fail(res, 400, 'Formato de solicitud inválido.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'Formato de solicitud inválido.');
    }

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId || !CONFIG.SESSION_ID_REGEX.test(sessionId)) {
      return fail(res, 400, 'Identificador de sesión inválido.');
    }

    const consent = body.consent === true;
    const isUpdate = body.update === true;
    const finalize = body.finalize === true;

    let contact = null;
    const botCheck = (body && typeof body.botCheck === 'object' && body.botCheck) || {};
    if (consent) {
      const c = (body && typeof body.contact === 'object' && body.contact) || {};
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, CONFIG.MAX_NAME_LENGTH) : '';
      const whatsapp = typeof c.whatsapp === 'string' ? c.whatsapp.trim().slice(0, CONFIG.MAX_CONTACT_LENGTH) : '';
      const email = typeof c.email === 'string' ? c.email.trim().slice(0, CONFIG.MAX_CONTACT_LENGTH) : '';

      // En el primer guardado exigimos contacto. En una finalización posterior
      // el contacto se recupera desde Supabase para no mantener PII en el navegador.
      if (!finalize && (!name || (!whatsapp && !email))) {
        return fail(res, 400, 'Para continuar necesitamos al menos tu nombre y un WhatsApp o correo.');
      }
      if (name || whatsapp || email) contact = { name: name, whatsapp: whatsapp, email: email };
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

    const sessionLimit = await checkAndBumpLimit('lead:session:' + sessionId, CONFIG.MAX_REQUESTS_PER_SESSION, CONFIG.IP_WINDOW_MS);
    if (!sessionLimit.allowed) {
      return fail(res, 429, 'Esta sesión alcanzó temporalmente el límite de solicitudes. Inténtalo más tarde.');
    }

    // Honeypot + tiempo mínimo: frena bots simples sin introducir CAPTCHA.
    if (!isUpdate && !finalize && consent) {
      const honeypot = typeof botCheck.website === 'string' ? botCheck.website.trim() : '';
      const startedAt = Number(botCheck.formStartedAt);
      if (honeypot || !Number.isFinite(startedAt) || (Date.now() - startedAt) < CONFIG.MIN_FORM_TIME_MS || (Date.now() - startedAt) > 30 * 60 * 1000) {
        return fail(res, 400, 'No pudimos validar el formulario. Inténtalo nuevamente.');
      }
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
    // Si se está finalizando después de una recarga, recuperar el
    // contacto desde Supabase en vez de pedir/guardar PII en el cliente.
    // ------------------------------------------------------
    if (consent && finalize && !contact) {
      try {
        contact = await db.getContactBySessionId(sessionId);
      } catch (contactErr) {
        console.log('lead.js error recuperando contacto:', contactErr && contactErr.message);
      }
      if (!contact || (!contact.name && !contact.whatsapp && !contact.email)) {
        return fail(res, 409, 'No encontramos los datos de contacto de esta sesión.');
      }
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
    let finalized = false;

    // No notificamos durante la conversación. Solo al finalizar explícitamente.
    if (finalize && stored) {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        contact: contact,
        summary: summary || null,
        leadScore: leadScore
      })).digest('hex');
      const notificationKey = 'lead:notification:' + sessionId;
      let notificationState = null;
      try { notificationState = await kv.get(notificationKey); } catch (e) { notificationState = null; }
      const previousWasFinalized = !!(notificationState && typeof notificationState === 'object' && notificationState.wasEverFinalized);
      if (!notificationState || typeof notificationState !== 'object' || notificationState.fingerprint !== fingerprint) {
        notificationState = { fingerprint: fingerprint, email: false, whatsapp: false, wasEverFinalized: previousWasFinalized };
      }

      const eventType = notificationState.wasEverFinalized ? 'update' : 'new';
      if (!notificationState.email) {
        const emailHtml = notify.buildLeadEmailHtml({
          contact: contact,
          summary: summary,
          leadScore: leadScore,
          stored: stored,
          eventType: eventType
        });
        const subject = eventType === 'new'
          ? 'Nuevo lead — JB TECH AI: ' + contact.name
          : 'Actualización de lead — JB TECH AI: ' + contact.name;
        emailResult = await notify.sendEmailNotification(subject, emailHtml);
        if (emailResult.ok) notificationState.email = true;
      } else {
        emailResult = { ok: true, duplicate: true };
      }

      if (!notificationState.whatsapp) {
        const waText = notify.buildWhatsAppText({
          contact: contact,
          summary: summary,
          leadScore: leadScore,
          eventType: eventType
        });
        waResult = await notify.sendWhatsAppNotification(waText);
        if (waResult.ok) notificationState.whatsapp = true;
      } else {
        waResult = { ok: true, duplicate: true };
      }

      if (notificationState.email && notificationState.whatsapp) {
        notificationState.wasEverFinalized = true;
        finalized = true;
        try { await kv.set(notificationKey, notificationState); } catch (e) {}
      } else {
        finalized = false;
        try { await kv.set(notificationKey, notificationState); } catch (e) {}
      }
    }

    return res.status(200).json({
      ok: true,
      stored: stored,
      created: created,
      updated: updated,
      changed: changed,
      finalized: finalized,
      notified: { email: emailResult.ok, whatsapp: waResult.ok }
    });
  } catch (err) {
    console.log('lead.js error interno:', err && err.message);
    return fail(res, 500, 'No pudimos procesar la solicitud.');
  }
};
