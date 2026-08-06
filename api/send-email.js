// ============================================================
// FUNCIÓN (Vercel): procesa cada mensaje del formulario.
//
// Hace 4 cosas, en este orden:
//   1. Verifica el token de reCAPTCHA contra los servidores de Google.
//   2. Revisa que esa misma IP no haya escrito ya 3 veces en 24 horas
//      (usando Vercel KV en vez de Netlify Blobs).
//   3. Envía el correo por Resend.
//   4. Envía el aviso por WhatsApp (CallMeBot).
//
// Variables de entorno necesarias (Vercel → Project Settings →
// Environment Variables):
//   RESEND_API_KEY        -> tu clave de Resend
//   RECAPTCHA_SECRET_KEY  -> la "Secret Key" que te dio Google reCAPTCHA
// ============================================================

const { kv } = require('@vercel/kv');

const MAX_ATTEMPTS = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 horas

const CALLMEBOT_PHONE = '573023528086';
const CALLMEBOT_APIKEY = '1335636';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const data = req.body || {};
    const name = (data.name || '').toString().trim();
    const email = (data.email || '').toString().trim();
    const phone = (data.phone || '').toString().trim();
    const message = (data.message || '').toString().trim();
    const captchaToken = (data.captchaToken || '').toString().trim();

    if (!name || !email || !phone || !message) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    // ---------------------------------------------------------
    // 1. Verificación real de reCAPTCHA contra Google
    // ---------------------------------------------------------
    if (!captchaToken) {
      return res.status(403).json({ error: 'captcha', message: 'Falta la verificación.' });
    }

    const verifyResponse = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'secret=' + process.env.RECAPTCHA_SECRET_KEY + '&response=' + encodeURIComponent(captchaToken)
    });
    const verifyResult = await verifyResponse.json();

    if (!verifyResult.success) {
      return res.status(403).json({ error: 'captcha', message: 'La verificación no pasó.' });
    }

    // ---------------------------------------------------------
    // 2. Límite de 3 mensajes por IP cada 24 horas (Vercel KV)
    // ---------------------------------------------------------
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown';

    const key = 'ratelimit:' + ip;
    const now = Date.now();

    let record = await kv.get(key);
    if (!record || (now - record.firstAttempt) > WINDOW_MS) {
      record = { count: 0, firstAttempt: now };
    }

    if (record.count >= MAX_ATTEMPTS) {
      return res.status(429).json({
        error: 'limit',
        message: 'Ya alcanzaste el límite de 3 mensajes por hoy. Si es urgente, escríbeme directo por WhatsApp con el botón flotante.'
      });
    }

    record.count += 1;
    await kv.set(key, record, { px: WINDOW_MS });

    // ---------------------------------------------------------
    // 3. Correo por Resend
    // ---------------------------------------------------------
    function escapeHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone);
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');

    const emailHtml = `
<!DOCTYPE html>
<html lang="es">
<body style="margin:0; padding:0; background:#0d0a0b; font-family:'Segoe UI', Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0a0b; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#1a1416; border:1px solid #2c2225; border-radius:12px; overflow:hidden;">

          <tr>
            <td style="background:linear-gradient(135deg,#9B2242,#6e1830); padding:22px 28px;">
              <span style="font-family:Georgia,serif; font-size:20px; font-weight:700; color:#F2ECEE; letter-spacing:.5px;">JB Tech</span><br>
              <span style="font-family:'Courier New',monospace; font-size:11px; color:rgba(242,236,238,.75); letter-spacing:1px; text-transform:uppercase;">Nuevo contacto desde el portafolio</span>
            </td>
          </tr>

          <tr>
            <td style="padding:28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 0 16px;">
                    <span style="display:block; font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:#9B2242;">Nombre</span>
                    <span style="display:block; font-size:15px; color:#F2ECEE; margin-top:3px;">${safeName}</span>
                  </td>
                </tr>
                <tr><td style="border-top:1px solid #2c2225; padding:14px 0 0;"></td></tr>
                <tr>
                  <td style="padding:0 0 16px;">
                    <span style="display:block; font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:#9B2242;">Correo</span>
                    <a href="mailto:${safeEmail}" style="display:block; font-size:15px; color:#F2ECEE; margin-top:3px; text-decoration:none;">${safeEmail}</a>
                  </td>
                </tr>
                <tr><td style="border-top:1px solid #2c2225; padding:14px 0 0;"></td></tr>
                <tr>
                  <td style="padding:0 0 16px;">
                    <span style="display:block; font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:#9B2242;">Teléfono / WhatsApp</span>
                    <span style="display:block; font-size:15px; color:#F2ECEE; margin-top:3px;">${safePhone}</span>
                  </td>
                </tr>
                <tr><td style="border-top:1px solid #2c2225; padding:14px 0 0;"></td></tr>
                <tr>
                  <td style="padding:0;">
                    <span style="display:block; font-family:'Courier New',monospace; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:#9B2242;">Mensaje</span>
                    <span style="display:block; font-size:14.5px; line-height:1.6; color:#cfc5c8; margin-top:6px;">${safeMessage}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 28px; background:#150f11; border-top:1px solid #2c2225;">
              <a href="https://wa.me/${safePhone.replace(/[^0-9]/g, '')}" style="display:inline-block; background:#9B2242; color:#fff; text-decoration:none; font-size:13px; font-weight:600; padding:9px 18px; border-radius:6px;">Responder por WhatsApp</a>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 28px; text-align:center;">
              <span style="font-family:'Courier New',monospace; font-size:10px; color:#5a5054;">Enviado automáticamente desde JB Tech</span>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'JB Tech <onboarding@resend.dev>',
        to: ['josebp354@gmail.com'],
        reply_to: email,
        subject: 'Nuevo contacto desde el portafolio: ' + name,
        html: emailHtml
      })
    });

    // ---------------------------------------------------------
    // 4. Aviso por WhatsApp (CallMeBot) — se espera (await) a que
    //    termine, si no la función puede cortarse antes de que
    //    la petición alcance a salir.
    // ---------------------------------------------------------
    if (CALLMEBOT_APIKEY) {
      const waText =
        'Nuevo contacto desde el portafolio:%0A' +
        'Nombre: ' + name + '%0A' +
        'Correo: ' + email + '%0A' +
        'Teléfono: ' + phone + '%0A' +
        'Mensaje: ' + message;

      try {
        const waResponse = await fetch(
          'https://api.callmebot.com/whatsapp.php?phone=' + CALLMEBOT_PHONE +
          '&text=' + encodeURIComponent(waText).replace(/%250A/g, '%0A') +
          '&apikey=' + CALLMEBOT_APIKEY
        );
        const waResult = await waResponse.text();
        console.log('CallMeBot respuesta:', waResponse.status, waResult);
      } catch (waErr) {
        console.log('CallMeBot error:', waErr.message);
      }
    }

    if (!emailResponse.ok) {
      const errText = await emailResponse.text();
      return res.status(500).json({ error: errText });
    }

    return res.status(200).json({ ok: true, remaining: MAX_ATTEMPTS - record.count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
