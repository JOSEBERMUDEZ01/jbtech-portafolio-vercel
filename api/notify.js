// ============================================================
// api/_lib/notify.js
//
// Envío de notificaciones a JB TECH cuando hay un lead nuevo.
// Reutiliza EXACTAMENTE las mismas integraciones que ya usa
// api/send-email.js (Resend + CallMeBot, mismo remitente, mismo
// destinatario, mismo teléfono/API key de CallMeBot) — no se crea
// ninguna integración nueva, solo se reutiliza el mismo patrón
// desde un segundo punto de entrada (api/lead.js), separado del
// formulario de contacto para no modificar ese flujo ya probado.
//
// api/send-email.js NO se modifica: sigue funcionando exactamente
// igual que antes para el formulario de contacto.
//
// IMPORTANTE: estas funciones NUNCA lanzan excepción. Siempre
// devuelven { ok: boolean } para que quien las llama pueda
// reportar honestamente si la notificación funcionó o no — nunca
// se debe afirmar "ya te contactamos" sin confirmación real.
// ============================================================

// Mismos valores que api/send-email.js (mismo número/cuenta de
// CallMeBot de JB TECH).
const CALLMEBOT_PHONE = '573023528086';
const CALLMEBOT_APIKEY = '1335636';

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

async function sendWhatsAppNotification(text) {
  if (!CALLMEBOT_APIKEY) return { ok: false };
  try {
    const response = await fetch(
      'https://api.callmebot.com/whatsapp.php?phone=' + CALLMEBOT_PHONE +
      '&text=' + encodeURIComponent(text).replace(/%250A/g, '%0A') +
      '&apikey=' + CALLMEBOT_APIKEY
    );
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
  sendWhatsAppNotification: sendWhatsAppNotification
};
