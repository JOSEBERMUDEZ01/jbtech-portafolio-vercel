// ============================================================
// FUNCIÓN (Vercel): /api/admin/logout.js
// Destruye la sesión real en KV y expira la cookie. Siempre
// responde éxito desde la perspectiva del cliente — cerrar sesión
// nunca debe quedar en un estado de error confuso para el usuario.
// ============================================================

const auth = require('../_lib/auth.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: true, message: 'Método no permitido.' });
  }

  try {
    const token = auth.getSessionTokenFromRequest(req);
    await auth.destroySession(token);
  } catch (err) {
    console.log('admin/logout.js error interno:', err && err.message);
  }

  res.setHeader('Set-Cookie', auth.buildExpiredCookie());
  return res.status(200).json({ ok: true });
};
