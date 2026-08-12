// ============================================================
// FUNCIÓN (Vercel): /api/lead.js
//
// Endpoint separado de /api/chat.js.
// Solo procesa consentimiento, persistencia y finalización del lead.
//
// Mantiene:
//   - Vercel KV para rate limiting.
//   - api/_lib/db.js -> Supabase.
//   - api/_lib/notify.js -> Resend + CallMeBot.
//   - summary/leadScore obtenidos exclusivamente desde KV.
//
// Mejoras incluidas:
//   - Rate limiting atómico con INCR/EXPIRE.
//   - Las validaciones ocurren antes de consumir el límite.
//   - Límites separados para IP y sesión.
//   - Retry-After en respuestas 429.
//   - Las finalizaciones legítimas tienen margen suficiente para
//     conversaciones con actualizaciones, sin eliminar el antibot.
//   - Errores de Supabase se distinguen de los límites y se
//     reportan honestamente al frontend.
//   - Se conserva la deduplicación de Gmail/WhatsApp por fingerprint.
//   - No se modifican variables de entorno ni contratos externos.
// ============================================================

const { kv } = require('@vercel/kv');
const db = require('./_lib/db.js');
const notify = require('./_lib/notify.js');
const crypto = require('crypto');

const CONFIG = {
  MAX_REQUESTS_PER_IP: 20,
  MAX_REQUESTS_PER_SESSION: 12,
  IP_WINDOW_MS: 60 * 60 * 1000,
  MIN_FORM_TIME_MS: 1800,
  MAX_BODY_BYTES: 32 * 1024,
  SESSION_ID_REGEX: /^[a-zA-Z0-9_-]{8,64}$/,
  MAX_NAME_LENGTH: 100,
  MAX_CONTACT_LENGTH: 100,
  POLICY_VERSION: '2026-08'
};

function fail(res, status, message, extra = {}) {
  return res.status(status).json({
    error: true,
    message,
    ...extra
  });
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

// Rate limiter atómico. Se ejecuta después de las validaciones
// para no consumir cupo con solicitudes inválidas.
async function checkAndBumpLimit(key, max, windowMs) {
  const count = await kv.incr(key);

  if (count === 1) {
    await kv.expire(key, Math.ceil(windowMs / 1000));
  }

  if (count > max) {
    return { allowed: false, count };
  }

  return { allowed: true, count };
}

function setRetryAfter(res, seconds = 3600) {
  res.setHeader('Retry-After', String(seconds));
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
      if (
        Buffer.byteLength(JSON.stringify(body || {}), 'utf8') >
        CONFIG.MAX_BODY_BYTES
      ) {
        return fail(res, 413, 'Solicitud demasiado grande.');
      }
    } catch (e) {
      return fail(res, 400, 'Formato de solicitud inválido.');
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'Formato de solicitud inválido.');
    }

    const sessionId =
      typeof body.sessionId === 'string'
        ? body.sessionId.trim()
        : '';

    if (!sessionId || !CONFIG.SESSION_ID_REGEX.test(sessionId)) {
      return fail(res, 400, 'Identificador de sesión inválido.');
    }

    const consent = body.consent === true;
    const isUpdate = body.update === true;
    const finalize = body.finalize === true;

    let contact = null;

    const botCheck =
      body && typeof body.botCheck === 'object' && body.botCheck
        ? body.botCheck
        : {};

    if (consent) {
      const c =
        body && typeof body.contact === 'object' && body.contact
          ? body.contact
          : {};

      const name =
        typeof c.name === 'string'
          ? c.name.trim().slice(0, CONFIG.MAX_NAME_LENGTH)
          : '';

      const whatsapp =
        typeof c.whatsapp === 'string'
          ? c.whatsapp.trim().slice(0, CONFIG.MAX_CONTACT_LENGTH)
          : '';

      const email =
        typeof c.email === 'string'
          ? c.email.trim().slice(0, CONFIG.MAX_CONTACT_LENGTH)
          : '';

      if (!finalize && (!name || (!whatsapp && !email))) {
        return fail(
          res,
          400,
          'Para continuar necesitamos al menos tu nombre y un WhatsApp o correo.'
        );
      }

      if (name || whatsapp || email) {
        contact = { name, whatsapp, email };
      }
    }

    // Antibot antes del rate limit.
    if (!isUpdate && !finalize && consent) {
      const honeypot =
        typeof botCheck.website === 'string'
          ? botCheck.website.trim()
          : '';

      const startedAt = Number(botCheck.formStartedAt);
      const elapsed = Date.now() - startedAt;

      if (
        honeypot ||
        !Number.isFinite(startedAt) ||
        elapsed < CONFIG.MIN_FORM_TIME_MS ||
        elapsed > 30 * 60 * 1000
      ) {
        return fail(
          res,
          400,
          'No pudimos validar el formulario. Inténtalo nuevamente.'
        );
      }
    }

    // summary y leadScore se recuperan únicamente del servidor.
    let leadData = null;

    try {
      leadData = await kv.get('chat:lead:' + sessionId);
    } catch (kvErr) {
      console.log(
        'lead.js error recuperando leadData:',
        kvErr && kvErr.message
      );
      leadData = null;
    }

    const leadScore =
      leadData && typeof leadData.leadScore === 'number'
        ? leadData.leadScore
        : null;

    const summary =
      leadData && leadData.summary
        ? leadData.summary
        : null;

    if (!consent) {
      return res.status(200).json({
        ok: true,
        stored: false,
        created: false,
        updated: false,
        changed: false,
        finalized: false,
        notified: { email: false, whatsapp: false }
      });
    }

    // Rate limiting después de las validaciones.
    const ip = getClientIp(req);

    const ipLimit = await checkAndBumpLimit(
      'lead:ip:' + ip,
      CONFIG.MAX_REQUESTS_PER_IP,
      CONFIG.IP_WINDOW_MS
    );

    if (!ipLimit.allowed) {
      setRetryAfter(res);
      return fail(
        res,
        429,
        'Has alcanzado temporalmente el límite de solicitudes. Inténtalo más tarde.',
        { code: 'LEAD_RATE_LIMIT_IP' }
      );
    }

    const sessionLimit = await checkAndBumpLimit(
      'lead:session:' + sessionId,
      CONFIG.MAX_REQUESTS_PER_SESSION,
      CONFIG.IP_WINDOW_MS
    );

    if (!sessionLimit.allowed) {
      setRetryAfter(res);
      return fail(
        res,
        429,
        'Esta sesión alcanzó temporalmente el límite de solicitudes. Inténtalo más tarde.',
        { code: 'LEAD_RATE_LIMIT_SESSION' }
      );
    }

    // Si se finaliza después de una recarga, recuperar el contacto
    // desde Supabase sin pedir PII otra vez.
    if (consent && finalize && !contact) {
      try {
        contact = await db.getContactBySessionId(sessionId);
      } catch (contactErr) {
        console.log(
          'lead.js error recuperando contacto:',
          contactErr && contactErr.message
        );
      }

      if (
        !contact ||
        (!contact.name && !contact.whatsapp && !contact.email)
      ) {
        return fail(
          res,
          409,
          'No encontramos los datos de contacto de esta sesión.'
        );
      }
    }

    // Persistencia en Supabase.
    let stored = false;
    let storedResult = null;

    try {
      storedResult = await db.saveLeadPackage({
        sessionId,
        idioma: 'es',
        consent: true,
        policyVersion: CONFIG.POLICY_VERSION,
        contact,
        summary,
        leadScore,
        isUpdate
      });

      stored = !!storedResult;
    } catch (dbErr) {
      console.log(
        'lead.js error guardando en Supabase:',
        dbErr && dbErr.message
      );

      return fail(
        res,
        500,
        'No pudimos guardar tu información en este momento. Inténtalo nuevamente.',
        { code: 'LEAD_PERSISTENCE_ERROR' }
      );
    }

    const changed =
      storedResult && storedResult.changed === true;

    const created =
      storedResult && storedResult.created === true;

    const updated =
      storedResult && storedResult.updated === true;

    let emailResult = { ok: false };
    let waResult = { ok: false };
    let finalized = false;

    // Las notificaciones solo se envían al finalizar explícitamente.
    if (finalize && stored) {
      const fingerprint = crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            contact: contact || null,
            summary: summary || null,
            leadScore
          })
        )
        .digest('hex');

      const notificationKey =
        'lead:notification:' + sessionId;

      let notificationState = null;

      try {
        notificationState = await kv.get(notificationKey);
      } catch (e) {
        notificationState = null;
      }

      const previousWasFinalized =
        !!(
          notificationState &&
          typeof notificationState === 'object' &&
          notificationState.wasEverFinalized
        );

      if (
        !notificationState ||
        typeof notificationState !== 'object' ||
        notificationState.fingerprint !== fingerprint
      ) {
        notificationState = {
          fingerprint,
          email: false,
          whatsapp: false,
          wasEverFinalized: previousWasFinalized
        };
      }

      const eventType =
        notificationState.wasEverFinalized ? 'update' : 'new';

      // Gmail / Resend.
      if (!notificationState.email) {
        const emailHtml = notify.buildLeadEmailHtml({
          contact,
          summary,
          leadScore,
          stored,
          eventType
        });

        const subject =
          eventType === 'new'
            ? 'Nuevo lead — JB TECH AI: ' +
              (contact && contact.name
                ? contact.name
                : 'Cliente potencial')
            : 'Actualización de lead — JB TECH AI: ' +
              (contact && contact.name
                ? contact.name
                : 'Cliente potencial');

        emailResult =
          await notify.sendEmailNotification(subject, emailHtml);

        if (emailResult.ok) {
          notificationState.email = true;
        }
      } else {
        emailResult = { ok: true, duplicate: true };
      }

      // WhatsApp / CallMeBot.
      if (!notificationState.whatsapp) {
        const waText = notify.buildWhatsAppText({
          contact,
          summary,
          leadScore,
          eventType
        });

        waResult =
          await notify.sendWhatsAppNotification(waText);

        if (waResult.ok) {
          notificationState.whatsapp = true;
        }
      } else {
        waResult = { ok: true, duplicate: true };
      }

      // Solo se considera finalizado cuando ambos canales
      // confirmaron correctamente.
      if (
        notificationState.email &&
        notificationState.whatsapp
      ) {
        notificationState.wasEverFinalized = true;
        finalized = true;
      }

      // Conserva el estado incluso si uno de los canales falló,
      // permitiendo reintentar únicamente el canal pendiente.
      try {
        await kv.set(notificationKey, notificationState);
      } catch (e) {
        console.log(
          'lead.js error guardando estado de notificación:',
          e && e.message
        );
      }
    }

    return res.status(200).json({
      ok: true,
      stored,
      created: !!created,
      updated: !!updated,
      changed: !!changed,
      finalized,
      notified: {
        email: !!emailResult.ok,
        whatsapp: !!waResult.ok
      }
    });
  } catch (err) {
    console.log(
      'lead.js error interno:',
      err && err.message
    );

    return fail(
      res,
      500,
      'No pudimos procesar la solicitud.',
      { code: 'LEAD_INTERNAL_ERROR' }
    );
  }
};
