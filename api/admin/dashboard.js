// ============================================================
// FUNCIÓN (Vercel): /api/admin/dashboard.js
// Resumen del panel: conteos reales por estado, total de
// contactos y solicitudes recientes. Requiere sesión válida.
// ============================================================

const auth = require('../_lib/auth.js');
const db = require('../_lib/db.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: true, message: 'Método no permitido.' });
  }

  const authorized = await auth.requireAdminSession(req, res);
  if (!authorized) return;

  try {
    const summary = await db.getDashboardCounts();
    return res.status(200).json({ ok: true, data: summary });
  } catch (err) {
    console.log('admin/dashboard.js error:', err && err.message);
    return res.status(500).json({ error: true, message: 'No pudimos cargar el resumen. Intenta nuevamente.' });
  }
};
