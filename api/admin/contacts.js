// ============================================================
// FUNCIÓN (Vercel): /api/admin/contacts.js
// Listado de contactos que autorizaron el tratamiento de sus
// datos, con búsqueda y paginación. Requiere sesión válida.
// ============================================================

const auth = require('../_lib/auth.js');
const db = require('../_lib/db.js');

const PAGE_SIZE = 20;
const MAX_SEARCH_LENGTH = 100;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: true, message: 'Método no permitido.' });
  }

  const authorized = await auth.requireAdminSession(req, res);
  if (!authorized) return;

  try {
    const query = req.query || {};
    const search = typeof query.search === 'string' ? query.search.slice(0, MAX_SEARCH_LENGTH) : '';
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const offset = (page - 1) * PAGE_SIZE;

    const result = await db.listContacts({ search: search, limit: PAGE_SIZE, offset: offset });
    return res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.log('admin/contacts.js error:', err && err.message);
    return res.status(500).json({ error: true, message: 'No pudimos cargar los contactos. Intenta nuevamente.' });
  }
};
