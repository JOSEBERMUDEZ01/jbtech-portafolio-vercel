// ============================================================
// api/_lib/notify.js
//
// Envío de notificaciones a JB TECH cuando hay un lead nuevo.
// Reutiliza EXACTAMENTE las mismas integraciones que ya usa
// api/send-email.js (Resend + CallMeBot, mismo remitente, mismo
// destinatario, mismo teléfono/API key de CallMeBot) — no se crea
// ninguna integración nueva, ni se cambia de proveedor, ni se
// tocan variables de entorno.
//
// api/send-email.js NO se modifica: sigue funcionando exactamente
// igual que antes para el formulario de contacto.
//
// IMPORTANTE: estas funciones NUNCA lanzan excepción. Siempre
// devuelven { ok: boolean } para que quien las llama pueda
// reportar honestamente si la notificación funcionó o no — nunca
// se debe afirmar "ya te contactamos" sin confirmación real.
//
// v2 — corrección de codificación de WhatsApp + correo
// profesional:
//   - Antes, api/lead.js construía el texto de WhatsApp con la
//     SECUENCIA DE TEXTO LITERAL "%0A" en vez de un salto de
//     línea real. Al pasar ese texto por encodeURIComponent()
//     aquí, el símbolo "%" de esos "%0A" literales (que NO es un
//     carácter seguro) se codificaba de nuevo a "%25", dando
//     "%250A" — un salto de línea codificado DOS veces. Cualquier
//     fragmento que ya llegara pre-codificado a mano terminaba
//     visible como texto crudo en WhatsApp.
//   - La solución: el texto que llega a esta función ahora SIEMPRE
//     es texto plano real (saltos de línea reales, sin ningún
//     "%XX" incrustado a mano) y se codifica UNA sola vez, con
//     URLSearchParams (mecanismo estándar para construir query
//     strings, sin riesgo de codificar dos veces por accidente).
// ============================================================

// Mismos valores que api/send-email.js (mismo número/cuenta de
// CallMeBot de JB TECH). No se cambian.
const CALLMEBOT_PHONE = '573023528086';
const CALLMEBOT_APIKEY = '1335636';

// ------------------------------------------------------------
// Escapado de HTML — para insertar cualquier dato proveniente del
// usuario dentro del correo sin riesgo de XSS.
// ------------------------------------------------------------
function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------
// Deja solo dígitos en un número de contacto, para construir un
// enlace wa.me seguro. No se inventa ni se asume un indicativo de
// país: se usa tal como el usuario lo escribió.
// ------------------------------------------------------------
function sanitizeDigits(str) {
  return String(str == null ? '' : str).replace(/[^\d]/g, '');
}

// ------------------------------------------------------------
// Interpretación visual del leadScore ya calculado por el
// sistema. NUNCA inventa ni ajusta el número — solo lo clasifica.
// ------------------------------------------------------------
function classifyLeadScore(score) {
  if (typeof score !== 'number' || isNaN(score)) {
    return { label: 'Sin valorar todavía', color: '#6E6468', bg: '#F2ECEA', border: '#E4DEDC' };
  }
  if (score >= 80) return { label: 'Lead de alta prioridad', color: '#1E7A46', bg: '#E7F5EC', border: '#BFE6CC' };
  if (score >= 60) return { label: 'Lead con buen potencial', color: '#966A00', bg: '#FBF1D9', border: '#EFDDA6' };
  if (score >= 40) return { label: 'Lead por evaluar', color: '#B2571E', bg: '#FBEADC', border: '#EFC79E' };
  return { label: 'Lead de baja prioridad', color: '#6E6468', bg: '#F2ECEA', border: '#E4DEDC' };
}

// ------------------------------------------------------------
// Fila de contacto — se omite por completo si el dato no existe
// (nunca se muestra una fila vacía).
// ------------------------------------------------------------
function contactRow(label, value) {
  if (!value) return '';
  return (
    '<tr>' +
    '<td style="padding:4px 0;font-size:13px;color:#6E6468;width:88px;vertical-align:top;">' + escapeHtml(label) + '</td>' +
    '<td style="padding:4px 0;font-size:14px;color:#211A1C;font-weight:600;">' + escapeHtml(value) + '</td>' +
    '</tr>'
  );
}

// ------------------------------------------------------------
// Bloque de un campo del resumen del proyecto — se omite si no
// hay contenido real (evita bloques vacíos tipo "-").
// ------------------------------------------------------------
function summaryBlock(label, value) {
  if (!value || value === '-') return '';
  return (
    '<div style="margin-bottom:14px;">' +
    '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9B2242;font-weight:700;margin-bottom:3px;">' + escapeHtml(label) + '</div>' +
    '<div style="font-size:14px;color:#211A1C;line-height:1.5;">' + escapeHtml(value) + '</div>' +
    '</div>'
  );
}

// ------------------------------------------------------------
// Genera el HTML completo del correo de notificación de lead.
// Tabla-based (compatibilidad Gmail/Outlook), estilos inline,
// responsive por ser de una sola columna con max-width. Nunca
// incluye secretos, tokens, IPs, session IDs ni datos internos.
// ------------------------------------------------------------
function buildLeadEmailHtml(input) {
  const contact = input.contact || {};
  const summary = input.summary || null;
  const leadScore = typeof input.leadScore === 'number' ? input.leadScore : null;
  const stored = !!input.stored;

  const tier = classifyLeadScore(leadScore);

  const contactRows =
    contactRow('Nombre', contact.name) +
    contactRow('Correo', contact.email) +
    contactRow('WhatsApp', contact.whatsapp);

  const summaryHtml = summary
    ? (
        summaryBlock('Proyecto', summary.proyecto) +
        summaryBlock('Necesidad', summary.necesidad) +
        summaryBlock('Problema', summary.problema) +
        summaryBlock('Objetivo', summary.objetivo) +
        summaryBlock('Solución sugerida', summary.solucion_sugerida)
      )
    : '<div style="font-size:14px;color:#6E6468;">Todavía no hay un resumen del proyecto disponible.</div>';

  const scoreText = leadScore !== null ? (leadScore + ' / 100') : 'No disponible';

  const persistenceHtml = stored
    ? '<span style="color:#1E7A46;">&#10003; Guardado correctamente en base de datos</span>'
    : '<span style="color:#B2571E;">&#9888; No se pudo guardar en base de datos — revisar Supabase</span>';

  const waDigits = sanitizeDigits(contact.whatsapp);
  const buttons = [];
  if (waDigits) {
    buttons.push(
      '<a href="https://wa.me/' + waDigits + '" style="display:inline-block;background:#1E7A46;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:700;padding:11px 20px;border-radius:8px;margin:0 8px 8px 0;">Escribir por WhatsApp</a>'
    );
  }
  if (contact.email) {
    buttons.push(
      '<a href="mailto:' + encodeURIComponent(contact.email).replace(/%40/g, '@') + '" style="display:inline-block;background:#211A1C;color:#FFFFFF;text-decoration:none;font-size:13px;font-weight:700;padding:11px 20px;border-radius:8px;margin:0 8px 8px 0;">Responder por correo</a>'
    );
  }
  const buttonsHtml = buttons.length ? '<div style="margin-top:14px;">' + buttons.join('') + '</div>' : '';

  return (
    '<!DOCTYPE html>' +
    '<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin:0;padding:0;background:#F2ECEA;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2ECEA;padding:32px 14px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:12px;border:1px solid #E4DEDC;overflow:hidden;">' +

    '<tr><td style="background:#211A1C;padding:26px 30px;">' +
    '<div style="font-size:17px;font-weight:800;color:#FFFFFF;letter-spacing:.01em;">JB TECH</div>' +
    '<div style="font-size:11px;font-weight:700;color:#D98BA0;text-transform:uppercase;letter-spacing:.08em;margin-top:3px;">JB TECH AI</div>' +
    '<div style="font-size:19px;font-weight:700;color:#FFFFFF;margin-top:14px;">Nuevo lead recibido</div>' +
    '</td></tr>' +

    '<tr><td style="padding:26px 30px 6px;">' +
    '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9B2242;font-weight:700;margin-bottom:10px;">Información del contacto</div>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%">' + contactRows + '</table>' +
    '</td></tr>' +

    '<tr><td style="padding:22px 30px 6px;border-top:1px solid #F0EBE9;">' +
    '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9B2242;font-weight:700;margin-bottom:12px;">Resumen del proyecto</div>' +
    summaryHtml +
    '</td></tr>' +

    '<tr><td style="padding:6px 30px 6px;">' +
    '<div style="display:inline-block;background:' + tier.bg + ';border:1px solid ' + tier.border + ';border-radius:8px;padding:10px 16px;">' +
    '<span style="font-size:13px;font-weight:700;color:' + tier.color + ';">' + escapeHtml(tier.label) + '</span>' +
    '<span style="font-size:12px;color:' + tier.color + ';margin-left:8px;">(' + scoreText + ')</span>' +
    '</div>' +
    '</td></tr>' +

    '<tr><td style="padding:14px 30px 0;">' +
    '<div style="font-size:12px;">' + persistenceHtml + '</div>' +
    '</td></tr>' +

    '<tr><td style="padding:22px 30px 28px;">' +
    '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#9B2242;font-weight:700;margin-bottom:8px;">Próximo paso recomendado</div>' +
    '<div style="font-size:14px;color:#211A1C;line-height:1.5;">Revisar el lead y contactar al cliente por el canal proporcionado.</div>' +
    buttonsHtml +
    '</td></tr>' +

    '<tr><td style="padding:16px 30px;background:#F8F5F4;border-top:1px solid #E4DEDC;">' +
    '<div style="font-size:11px;color:#9B958F;">JB TECH · Notificación automática del asistente JB TECH AI</div>' +
    '</td></tr>' +

    '</table>' +
    '</td></tr>' +
    '</table>' +
    '</body></html>'
  );
}

// ------------------------------------------------------------
// Genera el texto plano (con saltos de línea REALES, nunca "%0A"
// como texto literal) para la notificación de WhatsApp.
// ------------------------------------------------------------
function buildWhatsAppText(input) {
  const contact = input.contact || {};
  const summary = input.summary || null;
  const leadScore = typeof input.leadScore === 'number' ? input.leadScore : null;

  const lines = ['Nuevo lead desde JB TECH AI:', ''];
  lines.push('Nombre: ' + (contact.name || '-'));
  if (contact.whatsapp) lines.push('WhatsApp: ' + contact.whatsapp);
  if (contact.email) lines.push('Correo: ' + contact.email);
  lines.push('');

  if (summary) {
    lines.push('Proyecto: ' + (summary.proyecto || '-'));
    lines.push('Necesidad: ' + (summary.necesidad || '-'));
    lines.push('Problema: ' + (summary.problema || '-'));
    lines.push('Objetivo: ' + (summary.objetivo || '-'));
    lines.push('Solución sugerida: ' + (summary.solucion_sugerida || '-'));
  } else {
    lines.push('Sin resumen disponible todavía (conversación breve).');
  }

  lines.push('');
  lines.push('Valoración: ' + (leadScore !== null ? leadScore + '/100' : 'No disponible'));

  return lines.join('\n');
}

async function sendEmailNotification(subject, htmlBody) {
  if (!process.env.RESEND_API_KEY) {
    console.log('notify.js: RESEND_API_KEY no configurada, se omite el correo.');
    return { ok: false };
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'JB Tech <onboarding@resend.dev>',
        to: ['josebp354@gmail.com'],
        subject: subject,
        html: htmlBody
      })
    });
    return { ok: response.ok };
  } catch (err) {
    console.log('notify.js error de correo:', err && err.message);
    return { ok: false };
  }
}

// ------------------------------------------------------------
// Envío por WhatsApp (CallMeBot). El texto recibido debe ser
// SIEMPRE texto plano real (con \n reales) — nunca una cadena con
// "%XX" pre-incrustado a mano. Se codifica UNA sola vez mediante
// URLSearchParams, que arma la query string de forma estándar y
// evita por diseño el problema de doble codificación.
// ------------------------------------------------------------
async function sendWhatsAppNotification(text) {
  if (!CALLMEBOT_APIKEY) return { ok: false };
  try {
    const params = new URLSearchParams({
      phone: CALLMEBOT_PHONE,
      text: text,
      apikey: CALLMEBOT_APIKEY
    });
    const response = await fetch('https://api.callmebot.com/whatsapp.php?' + params.toString());
    const result = await response.text();
    // CallMeBot a veces responde 200 con un mensaje de error en el
    // cuerpo; solo se considera éxito si además no menciona error.
    const looksFailed = /error/i.test(result);
    return { ok: response.ok && !looksFailed };
  } catch (err) {
    console.log('notify.js error de WhatsApp:', err && err.message);
    return { ok: false };
  }
}

module.exports = {
  sendEmailNotification: sendEmailNotification,
  sendWhatsAppNotification: sendWhatsAppNotification,
  buildLeadEmailHtml: buildLeadEmailHtml,
  buildWhatsAppText: buildWhatsAppText,
  escapeHtml: escapeHtml
};
