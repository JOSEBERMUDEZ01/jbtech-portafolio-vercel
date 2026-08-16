// ============================================================
// FUNCIÓN (Vercel): /api/admin/session.js
//
// Confirma que la sesión de administrador (creada por
// /api/admin/login.js) sigue activa, y entrega el token de
// seguridad que admin.html guarda en memoria (window.__adminCsrf)
// para respaldar el cambio de estado de una solicitud si el
// camino principal (POST /api/admin/leads) llegara a fallar y se
// necesite recurrir a PATCH /api/admin.
//
// No crea una sesión nueva ni valida usuario/contraseña — solo
// verifica la sesión ya existente, igual que dashboard.js,
// contacts.js y leads.js (misma auth.requireAdminSession).
//
// El token se calcula a partir del propio identificador de sesión
// mediante HMAC-SHA256 con una clave del servidor: así no hace
// falta guardar nada adicional en KV ni tocar auth.js.
//
// Variable de entorno usada (opcional): ADMIN_SESSION_SECRET.
// Si no está definida, se usa ADMIN_PASSWORD como respaldo (ya
// existe en el proyecto, así que no requiere configuración nueva
// para empezar a funcionar).
// ============================================================

const crypto = require('crypto');
const auth = require('../_lib/auth.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: true, message: 'Método no permitido.' });
  }

  const authorized = await auth.requireAdminSession(req, res);
  if (!authorized) return;

  try {
    const token = auth.getSessionTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: true, message: 'No hay una sesión activa.' });
    }

    const secret = process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'jbtech-admin-fallback';
    const csrf = crypto.createHmac('sha256', secret).update(token).digest('hex');

    return res.status(200).json({ ok: true, csrf: csrf });
  } catch (err) {
    console.log('admin/session.js error:', err && err.message);
    return res.status(500).json({ error: true, message: 'No pudimos verificar tu sesión.' });
  }
};
