// ============================================================
// Vercel: /api/admin.js
// Panel administrativo privado de JB TECH AI.
//
// Seguridad:
// - SUPABASE_SECRET_KEY permanece exclusivamente en servidor.
// - El acceso requiere ADMIN_PANEL_PASSWORD en Vercel.
// - Sesión firmada con HMAC + cookie HttpOnly/Secure.
// - CSRF token requerido para cambios de estado.
// - No expone claves ni acceso directo a Supabase al navegador.
// ============================================================

const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const db = require('./_lib/db.js');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME = 'jbtech_admin';

function fail(res, status, message, code) {
  return res.status(status).json({ ok: false, message, code });
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function secret() {
  return process.env.ADMIN_PANEL_PASSWORD || '';
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function makeSession() {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const payload = JSON.stringify({
    iat: Date.now(),
    csrf
  });
  const encoded = Buffer.from(payload).toString('base64url');
  return {
    cookie: encoded + '.' + sign(encoded),
    csrf
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function getSession(req) {
  if (!secret()) return null;
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;

  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!safeEqual(signature, sign(encoded))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || typeof payload.iat !== 'number' || typeof payload.csrf !== 'string') return null;
    if (Date.now() - payload.iat > SESSION_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function setAdminCookie(res, value) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearAdminCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function requireAuth(req, res, write = false) {
  const session = getSession(req);
  if (!session) {
    fail(res, 401, 'Sesión administrativa no válida.', 'ADMIN_UNAUTHORIZED');
    return null;
  }
  if (write) {
    const csrf = req.headers['x-admin-csrf'];
    if (!csrf || !safeEqual(csrf, session.csrf)) {
      fail(res, 403, 'Solicitud administrativa no autorizada.', 'ADMIN_CSRF');
      return null;
    }
  }
  return session;
}

async function notificationStateFor(conversationId) {
  if (!conversationId) return null;
  try {
    return await kv.get('lead:notification:' + conversationId);
  } catch {
    return null;
  }
}

async function enrichLead(item) {
  const state = await notificationStateFor(item.conversation_id);
  return {
    ...item,
    notification: state ? {
      email: state.email === true,
      whatsapp: state.whatsapp === true,
      finalized: state.wasEverFinalized === true
    } : {
      email: false,
      whatsapp: false,
      finalized: false
    }
  };
}

module.exports = async function handler(req, res) {
  securityHeaders(res);

  if (!secret()) {
    return fail(res, 503, 'El panel administrativo no está configurado. Falta ADMIN_PANEL_PASSWORD.', 'ADMIN_NOT_CONFIGURED');
  }

  try {
    if (req.method === 'POST' && req.body && req.body.action === 'login') {
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      if (!password || !safeEqual(password, secret())) {
        return fail(res, 401, 'Contraseña incorrecta.', 'ADMIN_LOGIN_FAILED');
      }
      const session = makeSession();
      setAdminCookie(res, session.cookie);
      return res.status(200).json({ ok: true, csrf: session.csrf });
    }

    if (req.method === 'POST' && req.body && req.body.action === 'logout') {
      if (!requireAuth(req, res, true)) return;
      clearAdminCookie(res);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET' && req.query && req.query.action === 'session') {
      const session = requireAuth(req, res);
      if (!session) return;
      return res.status(200).json({ ok: true, csrf: session.csrf });
    }

    if (req.method === 'GET') {
      if (!requireAuth(req, res)) return;
      const action = String(req.query.action || 'dashboard');

      if (action === 'dashboard') {
        const data = await db.getDashboardCounts();
        const recent = await Promise.all((data.recent || []).map(enrichLead));
        return res.status(200).json({ ok: true, ...data, recent });
      }

      if (action === 'leads') {
        const data = await db.listLeads({
          search: req.query.search || '',
          estado: req.query.estado || '',
          dateFrom: req.query.dateFrom || '',
          dateTo: req.query.dateTo || '',
          limit: req.query.limit || 20,
          offset: req.query.offset || 0
        });
        const items = await Promise.all(data.items.map(enrichLead));
        return res.status(200).json({ ok: true, items, total: data.total });
      }

      if (action === 'lead') {
        const conversationId = String(req.query.conversationId || '');
        if (!conversationId || !/^[0-9a-f-]{20,}$/i.test(conversationId)) {
          return fail(res, 400, 'Identificador de conversación inválido.', 'ADMIN_BAD_ID');
        }
        const detail = await db.getLeadDetail(conversationId);
        const notification = await notificationStateFor(conversationId);
        return res.status(200).json({ ok: true, ...detail, notification });
      }

      if (action === 'contacts') {
        const data = await db.listContacts({
          search: req.query.search || '',
          limit: req.query.limit || 20,
          offset: req.query.offset || 0
        });
        return res.status(200).json({ ok: true, ...data });
      }

      return fail(res, 404, 'Acción administrativa no encontrada.', 'ADMIN_ACTION_NOT_FOUND');
    }

    if (req.method === 'PATCH') {
      if (!requireAuth(req, res, true)) return;
      const action = String(req.body && req.body.action || '');

      if (action === 'status') {
        const leadId = String(req.body.leadId || '');
        const estado = String(req.body.estado || '');
        const result = await db.updateLeadStatus(leadId, estado);
        return res.status(200).json({ ok: true, ...result });
      }

      return fail(res, 404, 'Acción administrativa no encontrada.', 'ADMIN_ACTION_NOT_FOUND');
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return fail(res, 405, 'Método no permitido.', 'ADMIN_METHOD');
  } catch (err) {
    console.error('admin.js error:', err && err.message);
    return fail(res, 500, 'No se pudo procesar la solicitud administrativa.', 'ADMIN_INTERNAL');
  }
};
