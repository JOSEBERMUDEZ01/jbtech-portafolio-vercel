// ============================================================
// api/_lib/auth.js
//
// Autenticación y autorización del panel administrativo de leads
// (Fase 11 + 12). Reutiliza las mismas credenciales que ya usa
// content.js (ADMIN_USER / ADMIN_PASSWORD) — no se crean cuentas
// ni variables de entorno nuevas.
//
// DECISIÓN DE DISEÑO (documentada, tal como se pidió):
// Se evaluó usar Supabase Auth. Se descartó porque implicaría
// crear una cuenta de Auth, manejar JWTs en el navegador y atar
// políticas RLS a auth.uid() — apropiado para aplicaciones con
// múltiples usuarios, pero sobreingeniería para un único
// administrador que ya tiene un mecanismo de credenciales
// funcionando (ADMIN_USER/ADMIN_PASSWORD). Se reutiliza ese mismo
// par de credenciales, pero con una sesión real del lado del
// servidor en vez del patrón actual de content.js (contraseña en
// sessionStorage, reenviada en cada petición) — ese patrón NO se
// reutiliza aquí porque este panel expone datos personales de
// terceros (contactos), que requieren un estándar más alto.
//
// Mecanismo:
//   1. login.js verifica usuario/contraseña contra las env vars.
//   2. Si son correctas, se genera un token opaco aleatorio y se
//      guarda en Vercel KV con TTL (namespace "admin:session:*",
//      separado de "chat:*" y "lead:*").
//   3. El token se entrega como cookie HttpOnly + Secure +
//      SameSite=Strict — nunca accesible desde JavaScript del
//      navegador, nunca en localStorage/sessionStorage.
//   4. CADA endpoint administrativo llama a requireAdminSession()
//      antes de tocar cualquier dato — la autorización se
//      comprueba en el servidor en cada petición, no solo al
//      iniciar sesión.
// ============================================================

const { kv } = require('@vercel/kv');
const crypto = require('crypto');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 horas
const COOKIE_NAME = 'jbadmin_session';

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------
// Autenticación: solo se usa desde login.js.
// ------------------------------------------------------------
function verifyCredentials(username, password) {
  const expectedUser = process.env.ADMIN_USER;
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) return false;
  return safeEqual(username, expectedUser) && safeEqual(password, expectedPass);
}

async function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  await kv.set('admin:session:' + token, { createdAt: Date.now() }, { px: SESSION_TTL_MS });
  return token;
}

async function destroySession(token) {
  if (!token) return;
  try {
    await kv.del('admin:session:' + token);
  } catch (e) {
    // Si falla el borrado, la sesión igual expira sola por TTL.
  }
}

async function validateSession(token) {
  if (!token) return false;
  try {
    const session = await kv.get('admin:session:' + token);
    return !!session;
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------
// Cookies — parseo mínimo, sin dependencias.
// ------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

function buildSessionCookie(token) {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return COOKIE_NAME + '=' + token + '; Max-Age=' + maxAgeSeconds + '; Path=/; HttpOnly; Secure; SameSite=Strict';
}

function buildExpiredCookie() {
  return COOKIE_NAME + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict';
}

// ------------------------------------------------------------
// Autorización: TODO endpoint administrativo debe llamar a esto
// antes de leer o modificar cualquier dato. Si devuelve false,
// ya se envió la respuesta 401 y el endpoint debe hacer `return`.
// ------------------------------------------------------------
async function requireAdminSession(req, res) {
  const token = getSessionTokenFromRequest(req);
  const valid = await validateSession(token);
  if (!valid) {
    res.status(401).json({ error: true, message: 'No autorizado.' });
    return false;
  }
  return true;
}

module.exports = {
  verifyCredentials: verifyCredentials,
  createSession: createSession,
  destroySession: destroySession,
  validateSession: validateSession,
  getSessionTokenFromRequest: getSessionTokenFromRequest,
  buildSessionCookie: buildSessionCookie,
  buildExpiredCookie: buildExpiredCookie,
  requireAdminSession: requireAdminSession,
  COOKIE_NAME: COOKIE_NAME
};
