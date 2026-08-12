// ============================================================
// api/_lib/notify.js
//
// Envío de notificaciones a JB TECH cuando hay un lead nuevo.
//
// Integraciones:
//   - Resend → correo
//   - CallMeBot → WhatsApp
//
// IMPORTANTE:
//   - La API key de CallMeBot NUNCA se escribe en este archivo.
//   - Debe existir como variable de entorno:
//       CALLMEBOT_APIKEY
//   - Las funciones de notificación nunca lanzan excepciones.
//   - Siempre devuelven { ok: boolean }.
// ============================================================

'use strict';

// ------------------------------------------------------------
// CONFIGURACIÓN
// ------------------------------------------------------------

const CALLMEBOT_PHONE = '573023528086';

// La API key se obtiene EXCLUSIVAMENTE desde Vercel.
// NO colocar la clave directamente en el código.
const CALLMEBOT_APIKEY =
  String(process.env.CALLMEBOT_APIKEY || '').trim();


// ------------------------------------------------------------
// Escapado de HTML
//
// Protege los datos provenientes del usuario antes de
// introducirlos dentro del correo HTML.
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
// Sanitización de números
//
// Deja únicamente dígitos para construir enlaces wa.me.
// No inventa ni agrega indicativos.
// ------------------------------------------------------------

function sanitizeDigits(str) {
  return String(str == null ? '' : str)
    .replace(/[^\d]/g, '');
}


// ------------------------------------------------------------
// Clasificación visual del leadScore
//
// No modifica el score.
// Solo determina cómo mostrarlo en el correo.
// ------------------------------------------------------------

function classifyLeadScore(score) {

  if (
    typeof score !== 'number' ||
    isNaN(score)
  ) {
    return {
      label: 'Sin valorar todavía',
      color: '#6E6468',
      bg: '#F2ECEA',
      border: '#E4DEDC'
    };
  }

  if (score >= 80) {
    return {
      label: 'Lead de alta prioridad',
      color: '#1E7A46',
      bg: '#E7F5EC',
      border: '#BFE6CC'
    };
  }

  if (score >= 60) {
    return {
      label: 'Lead con buen potencial',
      color: '#966A00',
      bg: '#FBF1D9',
      border: '#EFDDA6'
    };
  }

  if (score >= 40) {
    return {
      label: 'Lead por evaluar',
      color: '#B2571E',
      bg: '#FBEADC',
      border: '#EFC79E'
    };
  }

  return {
    label: 'Lead de baja prioridad',
    color: '#6E6468',
    bg: '#F2ECEA',
    border: '#E4DEDC'
  };
}


// ------------------------------------------------------------
// Fila de contacto para el correo.
//
// Si el valor no existe, no se genera ninguna fila vacía.
// ------------------------------------------------------------

function contactRow(label, value) {

  if (!value) {
    return '';
  }

  return (
    '<tr>' +

      '<td style="' +
        'padding:4px 0;' +
        'font-size:13px;' +
        'color:#6E6468;' +
        'width:88px;' +
        'vertical-align:top;' +
      '">' +
        escapeHtml(label) +
      '</td>' +

      '<td style="' +
        'padding:4px 0;' +
        'font-size:14px;' +
        'color:#211A1C;' +
        'font-weight:600;' +
      '">' +
        escapeHtml(value) +
      '</td>' +

    '</tr>'
  );
}


// ------------------------------------------------------------
// Bloque del resumen del proyecto.
//
// Omite campos vacíos.
// ------------------------------------------------------------

function summaryBlock(label, value) {

  if (!value || value === '-') {
    return '';
  }

  return (
    '<div style="margin-bottom:14px;">' +

      '<div style="' +
        'font-size:11px;' +
        'text-transform:uppercase;' +
        'letter-spacing:.05em;' +
        'color:#9B2242;' +
        'font-weight:700;' +
        'margin-bottom:3px;' +
      '">' +
        escapeHtml(label) +
      '</div>' +

      '<div style="' +
        'font-size:14px;' +
        'color:#211A1C;' +
        'line-height:1.5;' +
      '">' +
        escapeHtml(value) +
      '</div>' +

    '</div>'
  );
}


// ------------------------------------------------------------
// Genera el HTML completo del correo de notificación.
//
// Compatible con Gmail / Outlook mediante tablas e
// inline styles.
//
// Nunca incluye:
//   - API keys
//   - tokens
//   - sessionId
//   - IP
//   - información interna del backend
// ------------------------------------------------------------

function buildLeadEmailHtml(input) {

  const contact =
    input.contact || {};

  const summary =
    input.summary || null;

  const leadScore =
    typeof input.leadScore === 'number'
      ? input.leadScore
      : null;

  const stored =
    !!input.stored;

  const tier =
    classifyLeadScore(leadScore);


  // ----------------------------------------------------------
  // CONTACTO
  // ----------------------------------------------------------

  const contactRows =
    contactRow(
      'Nombre',
      contact.name
    ) +

    contactRow(
      'Correo',
      contact.email
    ) +

    contactRow(
      'WhatsApp',
      contact.whatsapp
    );


  // ----------------------------------------------------------
  // RESUMEN DEL PROYECTO
  // ----------------------------------------------------------

  const summaryHtml =
    summary
      ? (
          summaryBlock(
            'Proyecto',
            summary.proyecto
          ) +

          summaryBlock(
            'Necesidad',
            summary.necesidad
          ) +

          summaryBlock(
            'Problema',
            summary.problema
          ) +

          summaryBlock(
            'Objetivo',
            summary.objetivo
          ) +

          summaryBlock(
            'Solución sugerida',
            summary.solucion_sugerida
          )
        )

      : (
          '<div style="' +
            'font-size:14px;' +
            'color:#6E6468;' +
          '">' +
            'Todavía no hay un resumen del proyecto disponible.' +
          '</div>'
        );


  // ----------------------------------------------------------
  // SCORE
  // ----------------------------------------------------------

  const scoreText =
    leadScore !== null
      ? leadScore + ' / 100'
      : 'No disponible';


  // ----------------------------------------------------------
  // ESTADO DE PERSISTENCIA
  // ----------------------------------------------------------

  const persistenceHtml =
    stored

      ? (
          '<span style="color:#1E7A46;">' +
            '&#10003; Guardado correctamente en base de datos' +
          '</span>'
        )

      : (
          '<span style="color:#B2571E;">' +
            '&#9888; No se pudo guardar en base de datos — revisar Supabase' +
          '</span>'
        );


  // ----------------------------------------------------------
  // BOTONES DE CONTACTO
  // ----------------------------------------------------------

  const waDigits =
    sanitizeDigits(
      contact.whatsapp
    );

  const buttons = [];


  if (waDigits) {

    buttons.push(
      '<a href="https://wa.me/' +
        waDigits +
        '" style="' +
          'display:inline-block;' +
          'background:#1E7A46;' +
          'color:#FFFFFF;' +
          'text-decoration:none;' +
          'font-size:13px;' +
          'font-weight:700;' +
          'padding:11px 20px;' +
          'border-radius:8px;' +
          'margin:0 8px 8px 0;' +
        '">' +
        'Escribir por WhatsApp' +
      '</a>'
    );
  }


  if (contact.email) {

    const mailto =
      encodeURIComponent(
        contact.email
      ).replace(
        /%40/g,
        '@'
      );

    buttons.push(
      '<a href="mailto:' +
        mailto +
        '" style="' +
          'display:inline-block;' +
          'background:#211A1C;' +
          'color:#FFFFFF;' +
          'text-decoration:none;' +
          'font-size:13px;' +
          'font-weight:700;' +
          'padding:11px 20px;' +
          'border-radius:8px;' +
          'margin:0 8px 8px 0;' +
        '">' +
        'Responder por correo' +
      '</a>'
    );
  }


  const buttonsHtml =
    buttons.length

      ? (
          '<div style="margin-top:14px;">' +
            buttons.join('') +
          '</div>'
        )

      : '';


  // ----------------------------------------------------------
  // HTML DEL CORREO
  // ----------------------------------------------------------

  return (

    '<!DOCTYPE html>' +

    '<html>' +

      '<head>' +
        '<meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '</head>' +

      '<body style="' +
        'margin:0;' +
        'padding:0;' +
        'background:#F2ECEA;' +
        'font-family:-apple-system,BlinkMacSystemFont,' +
          '\'Segoe UI\',Roboto,Arial,sans-serif;' +
      '">' +

        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="' +
          'background:#F2ECEA;' +
          'padding:32px 14px;' +
        '">' +

          '<tr>' +

            '<td align="center">' +

              '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="' +
                'max-width:600px;' +
                'width:100%;' +
                'background:#FFFFFF;' +
                'border-radius:12px;' +
                'border:1px solid #E4DEDC;' +
                'overflow:hidden;' +
              '">' +


                // ------------------------------------------------
                // HEADER
                // ------------------------------------------------

                '<tr>' +

                  '<td style="' +
                    'background:#211A1C;' +
                    'padding:26px 30px;' +
                  '">' +

                    '<div style="' +
                      'font-size:17px;' +
                      'font-weight:800;' +
                      'color:#FFFFFF;' +
                      'letter-spacing:.01em;' +
                    '">' +
                      'JB TECH' +
                    '</div>' +

                    '<div style="' +
                      'font-size:11px;' +
                      'font-weight:700;' +
                      'color:#D98BA0;' +
                      'text-transform:uppercase;' +
                      'letter-spacing:.08em;' +
                      'margin-top:3px;' +
                    '">' +
                      'JB TECH AI' +
                    '</div>' +

                    '<div style="' +
                      'font-size:19px;' +
                      'font-weight:700;' +
                      'color:#FFFFFF;' +
                      'margin-top:14px;' +
                    '">' +
                      'Nuevo lead recibido' +
                    '</div>' +

                  '</td>' +

                '</tr>' +


                // ------------------------------------------------
                // CONTACTO
                // ------------------------------------------------

                '<tr>' +

                  '<td style="' +
                    'padding:26px 30px 6px;' +
                  '">' +

                    '<div style="' +
                      'font-size:11px;' +
                      'text-transform:uppercase;' +
                      'letter-spacing:.05em;' +
                      'color:#9B2242;' +
                      'font-weight:700;' +
                      'margin-bottom:10px;' +
                    '">' +
                      'Información del contacto' +
                    '</div>' +

                    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%">' +
                      contactRows +
                    '</table>' +

                  '</td>' +

                '</tr>' +


                // ------------------------------------------------
                // RESUMEN
                // ------------------------------------------------

                '<tr>' +

                  '<td style="' +
                    'padding:22px 30px 6px;' +
                    'border-top:1px solid #F0EBE9;' +
                  '">' +

                    '<div style="' +
                      'font-size:11px;' +
                      'text-transform:uppercase;' +
                      'letter-spacing:.05em;' +
                      'color:#9B2242;' +
                      'font-weight:700;' +
                      'margin-bottom:12px;' +
                    '">' +
                      'Resumen del proyecto' +
                    '</div>' +

                    summaryHtml +

                  '</td>' +

                '</tr>' +


                // ------------------------------------------------
                // SCORE
                // ------------------------------------------------

                '<tr>' +

                  '<td style="padding:6px 30px 6px;">' +

                    '<div style="' +
                      'display:inline-block;' +
                      'background:' + tier.bg + ';' +
                      'border:1px solid ' + tier.border + ';' +
                      'border-radius:8px;' +
                      'padding:10px 16px;' +
                    '">' +

                      '<span style="' +
                        'font-size:13px;' +
                        'font-weight:700;' +
                        'color:' + tier.color + ';' +
                      '">' +
                        escapeHtml(tier.label) +
                      '</span>' +

                      '<span style="' +
                        'font-size:12px;' +
                        'color:' + tier.color + ';' +
                        'margin-left:8px;' +
                      '">' +
                        '(' + scoreText + ')' +
                      '</span>' +

                    '</div>' +

                  '</td>' +

                '</tr>' +


                // ------------------------------------------------
                // PERSISTENCIA
                // ------------------------------------------------

                '<tr>' +

                  '<td style="padding:14px 30px 0;">' +

                    '<div style="font-size:12px;">' +
                      persistenceHtml +
                    '</div>' +

                  '</td>' +

                '</tr>' +


                // ------------------------------------------------
                // PRÓXIMO PASO
                // ------------------------------------------------

                '<tr>' +

                  '<td style="padding:22px 30px 28px;">' +

                    '<div style="' +
                      'font-size:11px;' +
                      'text-transform:uppercase;' +
                      'letter-spacing:.05em;' +
                      'color:#9B2242;' +
                      'font-weight:700;' +
                      'margin-bottom:8px;' +
                    '">' +
                      'Próximo paso recomendado' +
                    '</div>' +

                    '<div style="' +
                      'font-size:14px;' +
                      'color:#211A1C;' +
                      'line-height:1.5;' +
                    '">' +
                      'Revisar el lead y contactar al cliente por el canal proporcionado.' +
                    '</div>' +

                    buttonsHtml +

                  '</td>' +

                '</tr>' +


                // ------------------------------------------------
                // FOOTER
                // ------------------------------------------------

                '<tr>' +

                  '<td style="' +
                    'padding:16px 30px;' +
                    'background:#F8F5F4;' +
                    'border-top:1px solid #E4DEDC;' +
                  '">' +

                    '<div style="' +
                      'font-size:11px;' +
                      'color:#9B958F;' +
                    '">' +
                      'JB TECH · Notificación automática del asistente JB TECH AI' +
                    '</div>' +

                  '</td>' +

                '</tr>' +


              '</table>' +

            '</td>' +

          '</tr>' +

        '</table>' +

      '</body>' +

    '</html>'
  );
}


// ------------------------------------------------------------
// Genera el texto plano para WhatsApp.
//
// IMPORTANTE:
// Los saltos de línea son saltos REALES.
// NO se utilizan "%0A" manualmente.
// URLSearchParams se encarga de codificar todo una sola vez.
// ------------------------------------------------------------

function buildWhatsAppText(input) {

  const contact =
    input.contact || {};

  const summary =
    input.summary || null;

  const leadScore =
    typeof input.leadScore === 'number'
      ? input.leadScore
      : null;


  const lines = [
    'Nuevo lead desde JB TECH AI:',
    ''
  ];


  // ----------------------------------------------------------
  // CONTACTO
  // ----------------------------------------------------------

  lines.push(
    'Nombre: ' +
    (contact.name || '-')
  );


  if (contact.whatsapp) {

    lines.push(
      'WhatsApp: ' +
      contact.whatsapp
    );
  }


  if (contact.email) {

    lines.push(
      'Correo: ' +
      contact.email
    );
  }


  lines.push('');


  // ----------------------------------------------------------
  // PROYECTO
  // ----------------------------------------------------------

  if (summary) {

    lines.push(
      'Proyecto: ' +
      (summary.proyecto || '-')
    );

    lines.push(
      'Necesidad: ' +
      (summary.necesidad || '-')
    );

    lines.push(
      'Problema: ' +
      (summary.problema || '-')
    );

    lines.push(
      'Objetivo: ' +
      (summary.objetivo || '-')
    );

    lines.push(
      'Solución sugerida: ' +
      (summary.solucion_sugerida || '-')
    );

  } else {

    lines.push(
      'Sin resumen disponible todavía (conversación breve).'
    );
  }


  lines.push('');


  // ----------------------------------------------------------
  // SCORE
  // ----------------------------------------------------------

  lines.push(
    'Valoración: ' +
    (
      leadScore !== null
        ? leadScore + '/100'
        : 'No disponible'
    )
  );


  return lines.join('\n');
}


// ------------------------------------------------------------
// ENVÍO DE CORREO — RESEND
// ------------------------------------------------------------

async function sendEmailNotification(
  subject,
  htmlBody
) {

  if (!process.env.RESEND_API_KEY) {

    console.log(
      'notify.js: RESEND_API_KEY no configurada, se omite el correo.'
    );

    return {
      ok: false
    };
  }


  try {

    const response =
      await fetch(
        'https://api.resend.com/emails',
        {
          method: 'POST',

          headers: {
            Authorization:
              'Bearer ' +
              process.env.RESEND_API_KEY,

            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({

            from:
              'JB Tech <onboarding@resend.dev>',

            to: [
              'josebp354@gmail.com'
            ],

            subject:
              subject,

            html:
              htmlBody
          })
        }
      );


    return {
      ok: response.ok
    };

  } catch (err) {

    console.log(
      'notify.js error de correo:',
      err && err.message
    );

    return {
      ok: false
    };
  }
}


// ------------------------------------------------------------
// ENVÍO DE WHATSAPP — CALLMEBOT
//
// La API key viene exclusivamente desde:
//   process.env.CALLMEBOT_APIKEY
//
// El texto se codifica UNA sola vez con URLSearchParams.
// ------------------------------------------------------------

async function sendWhatsAppNotification(
  text
) {

  // ----------------------------------------------------------
  // Verificación de configuración
  // ----------------------------------------------------------

  if (!CALLMEBOT_APIKEY) {

    console.log(
      'notify.js: CALLMEBOT_APIKEY no configurada, se omite WhatsApp.'
    );

    return {
      ok: false
    };
  }


  try {

    // --------------------------------------------------------
    // Construcción segura de parámetros
    // --------------------------------------------------------

    const params =
      new URLSearchParams({

        phone:
          CALLMEBOT_PHONE,

        text:
          String(text || ''),

        apikey:
          CALLMEBOT_APIKEY

      });


    // --------------------------------------------------------
    // Petición a CallMeBot
    // --------------------------------------------------------

    const response =
      await fetch(
        'https://api.callmebot.com/whatsapp.php?' +
        params.toString()
      );


    // --------------------------------------------------------
    // Leer respuesta
    // --------------------------------------------------------

    const result =
      await response.text();


    // --------------------------------------------------------
    // CallMeBot puede devolver HTTP 200 aunque el cuerpo
    // indique un error.
    //
    // Detectamos errores comunes sin exponer la respuesta
    // completa al frontend.
    // --------------------------------------------------------

    const looksFailed =
      /invalid|failed|failure|error|not authorized|unauthorized/i
        .test(result);


    return {
      ok:
        response.ok &&
        !looksFailed
    };


  } catch (err) {

    console.log(
      'notify.js error de WhatsApp:',
      err && err.message
    );

    return {
      ok: false
    };
  }
}


// ------------------------------------------------------------
// EXPORTS
// ------------------------------------------------------------

module.exports = {

  sendEmailNotification:
    sendEmailNotification,

  sendWhatsAppNotification:
    sendWhatsAppNotification,

  buildLeadEmailHtml:
    buildLeadEmailHtml,

  buildWhatsAppText:
    buildWhatsAppText,

  escapeHtml:
    escapeHtml
};
