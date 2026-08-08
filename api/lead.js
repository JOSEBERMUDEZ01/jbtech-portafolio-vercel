// ============================================================
// FUNCIÓN (Vercel): /api/lead.js
//
// Endpoint SEPARADO de /api/chat.js a propósito.
//
// Este endpoint entra en juego cuando el usuario decide
// autorizar el tratamiento de sus datos para dar seguimiento
// a un posible proyecto.
//
// Reutiliza:
//   - Vercel KV para rate limiting.
//   - api/_lib/db.js para persistencia en Supabase.
//   - api/_lib/notify.js para notificaciones.
//
// IMPORTANTE:
// El resumen y el leadScore NUNCA se aceptan desde el frontend.
// Se recuperan desde KV usando la sesión correspondiente.
//
// Variables de entorno utilizadas:
//   RESEND_API_KEY
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//
// SUPABASE_SECRET_KEY es una credencial privada de servidor.
// Nunca debe exponerse al navegador ni incluirse en archivos
// del frontend o en el repositorio.
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
  return res.status(status).json({
    error: true,
    message
  });
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

  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.firstAttempt !== 'number' ||
    typeof record.count !== 'number' ||
    now - record.firstAttempt > windowMs
  ) {
    record = {
      count: 0,
      firstAttempt: now
    };
  }

  if (record.count >= max) {
    return {
      allowed: false
    };
  }

  record.count += 1;

  await kv.set(key, record, {
    px: windowMs
  });

  return {
    allowed: true
  };
}

// ------------------------------------------------------------
// Escapa contenido antes de insertarlo dentro del HTML del
// correo.
//
// Esto evita que datos introducidos por un usuario puedan ser
// interpretados como HTML dentro de la notificación.
// ------------------------------------------------------------
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ------------------------------------------------------------
// Codifica un valor para incluirlo de forma segura dentro de
// una URL/consulta utilizada por la notificación de WhatsApp.
//
// Se mantiene local a este archivo para no modificar notify.js.
// ------------------------------------------------------------
function encodeWhatsAppValue(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return fail(
      res,
      405,
      'Método no permitido.'
    );
  }

  try {
    // ----------------------------------------------------------
    // Validar Content-Type
    // ----------------------------------------------------------
    const contentType = (
      req.headers['content-type'] || ''
    ).toLowerCase();

    if (!contentType.includes('application/json')) {
      return fail(
        res,
        400,
        'Tipo de contenido no soportado.'
      );
    }

    // ----------------------------------------------------------
    // Validar body
    // ----------------------------------------------------------
    const body = req.body;

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body)
    ) {
      return fail(
        res,
        400,
        'Formato de solicitud inválido.'
      );
    }

    // ----------------------------------------------------------
    // Validar sessionId
    // ----------------------------------------------------------
    const sessionId =
      typeof body.sessionId === 'string'
        ? body.sessionId.trim()
        : '';

    if (
      !sessionId ||
      !CONFIG.SESSION_ID_REGEX.test(sessionId)
    ) {
      return fail(
        res,
        400,
        'Identificador de sesión inválido.'
      );
    }

    // ----------------------------------------------------------
    // Consentimiento
    // ----------------------------------------------------------
    const consent = body.consent === true;

    let contact = null;

    if (consent) {
      const c =
        body &&
        typeof body.contact === 'object' &&
        body.contact
          ? body.contact
          : {};

      const name =
        typeof c.name === 'string'
          ? c.name
              .trim()
              .slice(0, CONFIG.MAX_NAME_LENGTH)
          : '';

      const whatsapp =
        typeof c.whatsapp === 'string'
          ? c.whatsapp
              .trim()
              .slice(0, CONFIG.MAX_CONTACT_LENGTH)
          : '';

      const email =
        typeof c.email === 'string'
          ? c.email
              .trim()
              .slice(0, CONFIG.MAX_CONTACT_LENGTH)
          : '';

      if (!name || (!whatsapp && !email)) {
        return fail(
          res,
          400,
          'Para continuar necesitamos al menos tu nombre y un WhatsApp o correo.'
        );
      }

      contact = {
        name,
        whatsapp,
        email
      };
    }

    // ----------------------------------------------------------
    // Rate limiting propio del endpoint /api/lead.
    //
    // Namespace independiente de chat.js.
    // ----------------------------------------------------------
    const ip = getClientIp(req);

    const ipLimit = await checkAndBumpLimit(
      'lead:ip:' + ip,
      CONFIG.MAX_REQUESTS_PER_IP,
      CONFIG.IP_WINDOW_MS
    );

    if (!ipLimit.allowed) {
      return fail(
        res,
        429,
        'Has alcanzado temporalmente el límite de solicitudes. Inténtalo más tarde.'
      );
    }

    // ----------------------------------------------------------
    // IMPORTANTE:
    //
    // summary y leadScore NO se leen desde body.
    //
    // El navegador puede intentar enviar estos campos, pero
    // simplemente serán ignorados.
    //
    // La información válida se recupera exclusivamente desde
    // KV, generada previamente durante la conversación real.
    // ----------------------------------------------------------
    let leadData = null;

    try {
      leadData = await kv.get(
        'chat:lead:' + sessionId
      );
    } catch (kvErr) {
      leadData = null;
    }

    const leadScore =
      leadData &&
      typeof leadData.leadScore === 'number'
        ? leadData.leadScore
        : null;

    const summary =
      leadData &&
      leadData.summary &&
      typeof leadData.summary === 'object'
        ? leadData.summary
        : null;

    // ----------------------------------------------------------
    // Si el usuario NO autoriza:
    //
    // No se guarda contacto.
    // No se guarda información personal.
    // No se envían notificaciones.
    // ----------------------------------------------------------
    if (!consent) {
      return res.status(200).json({
        ok: true,
        stored: false
      });
    }

    // ----------------------------------------------------------
    // Guardar información en Supabase.
    //
    // db.js es el único módulo encargado de hablar con
    // Supabase.
    // ----------------------------------------------------------
    let stored = false;

    try {
      await db.saveLeadPackage({
        sessionId,
        idioma: 'es',
        consent: true,
        policyVersion: CONFIG.POLICY_VERSION,
        contact,
        summary,
        leadScore
      });

      stored = true;
    } catch (dbErr) {
      console.log(
        'lead.js error guardando en Supabase:',
        dbErr && dbErr.message
      );

      stored = false;
    }

    // ----------------------------------------------------------
    // Preparar resumen para las notificaciones.
    // ----------------------------------------------------------
    const summaryLines = summary
      ? [
          'Proyecto: ' +
            (summary.proyecto || '-'),

          'Necesidad: ' +
            (summary.necesidad || '-'),

          'Problema: ' +
            (summary.problema || '-'),

          'Objetivo: ' +
            (summary.objetivo || '-'),

          'Solución sugerida: ' +
            (summary.solucion_sugerida || '-')
        ].join('\n')
      : 'Sin resumen disponible todavía (conversación breve).';

    // ----------------------------------------------------------
    // Notificación por correo.
    //
    // Todos los valores proporcionados por el usuario pasan por
    // escapeHtml() antes de entrar al HTML.
    // ----------------------------------------------------------
    const emailHtml =
      '<div style="font-family:sans-serif; color:#211A1C;">' +

      '<h2 style="color:#9B2242;">' +
      'Nuevo contacto — JB TECH AI' +
      '</h2>' +

      '<p><b>Nombre:</b> ' +
      escapeHtml(contact.name) +
      '</p>' +

      (
        contact.whatsapp
          ? '<p><b>WhatsApp:</b> ' +
            escapeHtml(contact.whatsapp) +
            '</p>'
          : ''
      ) +

      (
        contact.email
          ? '<p><b>Correo:</b> ' +
            escapeHtml(contact.email) +
            '</p>'
          : ''
      ) +

      '<pre style="white-space:pre-wrap; font-family:inherit;">' +
      escapeHtml(summaryLines) +
      '</pre>' +

      (
        typeof leadScore === 'number'
          ? '<p><b>Valoración:</b> ' +
            escapeHtml(leadScore) +
            '/100</p>'
          : ''
      ) +

      '<p style="font-size:12px;color:#6E6468;">' +
      'Guardado en base de datos: ' +
      (stored ? 'sí' : 'NO — revisar Supabase') +
      '</p>' +

      '</div>';

    const emailResult =
      await notify.sendEmailNotification(
        'Nuevo contacto — JB TECH AI: ' +
          contact.name,
        emailHtml
      );

    // ----------------------------------------------------------
    // Notificación por WhatsApp.
    //
    // Los valores dinámicos se codifican para evitar que
    // caracteres especiales rompan el mensaje o la URL.
    // ----------------------------------------------------------
    const waTextParts = [
      'Nuevo contacto desde JB TECH AI:',
      'Nombre: ' + contact.name
    ];

    if (contact.whatsapp) {
      waTextParts.push(
        'WhatsApp: ' + contact.whatsapp
      );
    }

    if (contact.email) {
      waTextParts.push(
        'Correo: ' + contact.email
      );
    }

    waTextParts.push(summaryLines);

    const waText = waTextParts
      .map(encodeWhatsAppValue)
      .join('%0A');

    const waResult =
      await notify.sendWhatsAppNotification(
        waText
      );

    // ----------------------------------------------------------
    // Respuesta final.
    //
    // Se informa únicamente lo que realmente ocurrió.
    // ----------------------------------------------------------
    return res.status(200).json({
      ok: true,
      stored,
      notified: {
        email: !!(
          emailResult &&
          emailResult.ok
        ),
        whatsapp: !!(
          waResult &&
          waResult.ok
        )
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
      'No pudimos procesar la solicitud.'
    );
  }
};
