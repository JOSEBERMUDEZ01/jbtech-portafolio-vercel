// ============================================================
// Vercel: /api/upload-image.js
// Subida segura de imágenes del panel administrativo JB Tech.
//
// Requiere en Vercel:
//   BLOB_READ_WRITE_TOKEN
//   ADMIN_PASSWORD (o ADMIN_PANEL_PASSWORD)
//   ADMIN_USER (recomendado)
//
// El navegador NUNCA recibe el token de Vercel Blob.
// ============================================================

const crypto = require('crypto');
const { put } = require('@vercel/blob');

const MAX_BYTES = 6 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function fail(res, status, message, code) {
  return res.status(status).json({ ok: false, error: message, code });
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function credentialsAreValid(username, password) {
  const expectedUser = process.env.ADMIN_USER || '';
  const expectedPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_PANEL_PASSWORD || '';

  if (!expectedPassword) return { ok: false, configured: false };
  if (expectedUser && !safeEqual(username, expectedUser)) return { ok: false, configured: true };
  if (!safeEqual(password, expectedPassword)) return { ok: false, configured: true };

  return { ok: true, configured: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'Método no permitido.', 'UPLOAD_METHOD');
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return fail(
      res,
      503,
      'El almacenamiento de imágenes no está configurado. Falta BLOB_READ_WRITE_TOKEN en Vercel.',
      'BLOB_NOT_CONFIGURED'
    );
  }

  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'Formato de solicitud inválido.', 'UPLOAD_BODY');
    }

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
    const contentType = typeof body.contentType === 'string' ? body.contentType.toLowerCase() : '';

    const auth = credentialsAreValid(username, password);
    if (!auth.configured) {
      return fail(res, 503, 'El acceso administrativo no está configurado.', 'ADMIN_NOT_CONFIGURED');
    }
    if (!auth.ok) {
      return fail(res, 401, 'Sesión administrativa no válida.', 'ADMIN_UNAUTHORIZED');
    }

    if (!dataBase64) {
      return fail(res, 400, 'No se recibió ninguna imagen.', 'UPLOAD_EMPTY');
    }

    if (!ALLOWED_TYPES.has(contentType)) {
      return fail(res, 400, 'Formato de imagen no permitido.', 'UPLOAD_TYPE');
    }

    let buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch {
      return fail(res, 400, 'La imagen recibida no es válida.', 'UPLOAD_BASE64');
    }

    if (!buffer.length || buffer.length > MAX_BYTES) {
      return fail(res, 413, 'La imagen supera el tamaño máximo permitido.', 'UPLOAD_SIZE');
    }

    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const pathname = `jb-tech/proyectos/${Date.now()}-${crypto.randomUUID()}.${ext}`;

    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false
    });

    return res.status(200).json({ ok: true, url: blob.url });
  } catch (err) {
    console.error('upload-image error:', err && err.message);
    return fail(res, 500, 'No se pudo subir la imagen al almacenamiento.', 'UPLOAD_INTERNAL');
  }
};
