// ============================================================
// FUNCIÓN (Vercel): /api/admin/login.js
//
// Login del panel administrativo de leads (Fase 12). Separado de
// /api/chat y /api/lead — ningún dato conversacional pasa por
// aquí. Reutiliza ADMIN_USER/ADMIN_PASSWORD (mismas variables que
// ya usa content.js) — no crea credenciales nuevas.
//
// Rate limiting propio, namespace "admin:login:*" — no comparte
// contador con "chat:*", "lead:*" ni "ratelimit:*".
// ============================================================

const { kv } = require('@vercel/kv');
const auth = require('../_lib/auth.js');

const CONFIG = {
  MAX_ATTEMPTS_PER_IP: 8,
  WINDOW_MS: 15 * 60 * 1000 // 15 minutos
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

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return fail(res, 400, 'Usuario y contraseña son obligatorios.');
    }

    const ip = getClientIp(req);
    const limit = await checkAndBumpLimit('admin:login:ip:' + ip, CONFIG.MAX_ATTEMPTS_PER_IP, CONFIG.WINDOW_MS);
    if (!limit.allowed) {
      return fail(res, 429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    }

    const ok = auth.verifyCredentials(username, password);
    if (!ok) {
      return fail(res, 401, 'Usuario o contraseña incorrectos.');
    }

    const token = await auth.createSession();
    res.setHeader('Set-Cookie', auth.buildSessionCookie(token));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log('admin/login.js error interno:', err && err.message);
    return fail(res, 500, 'No pudimos procesar la solicitud.');
  }
};
