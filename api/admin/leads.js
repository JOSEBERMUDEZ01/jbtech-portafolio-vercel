// ============================================================
// FUNCIÓN (Vercel): /api/admin/leads.js
//
// Panel administrativo — pestaña "Solicitudes". Tres responsabilidades
// en un solo archivo (así lo consume admin.html, sin rutas nuevas):
//
//   GET  sin "id" ni "conversationId" -> lista paginada y filtrable
//        de solicitudes (leads) ya guardadas en Supabase por
//        /api/lead.js (mediante db.saveLeadPackage).
//        Query params: search, estado, dateFrom, dateTo, page.
//
//   GET  con "id" o "conversationId" -> detalle de una solicitud
//        puntual: problema, objetivo, solución sugerida, valoración,
//        y el contacto SOLO si hubo consentimiento.
//
//   POST -> cambia el estado de una solicitud
//        (nuevo | en_seguimiento | contactado | cerrado | descartado).
//
// Requiere sesión de administrador válida — misma auth.js que ya
// usan dashboard.js, contacts.js, login.js y logout.js. No crea
// autenticación nueva ni credenciales nuevas.
//
// ------------------------------------------------------------
// Usa estas funciones de api/_lib/db.js TAL COMO ya están
// implementadas ahí (firmas reales, no un contrato inventado):
//
//   db.listLeads({ search, estado, dateFrom, dateTo, limit, offset })
//     -> { items: [{ id, conversation_id, proyecto, necesidad,
//                     problema, objetivo, solucion_sugerida,
//                     lead_score, estado, fecha }],
//          total: Number }
//
//   db.getLeadDetail(conversationId)   <- string, NO objeto
//     -> { conversacion, lead, contacto }
//        (contacto es null si no hubo consentimiento)
//        Lanza un error (no devuelve null) si no existe esa solicitud.
//     IMPORTANTE: admin.html a veces manda el identificador de la
//     conversación bajo el parámetro "id" en vez de "conversationId"
//     (comportamiento ya existente en el panel, no se cambia). Por
//     eso aquí se usa "conversationId" si llegó, y si no, "id" —
//     ambos apuntan al mismo valor: el id de la conversación.
//
//   db.updateLeadStatus(leadId, estado)   <- dos argumentos, NO objeto
//     -> { ok: true, lead: { id, estado } }
//        Lanza un error si el estado no es válido o si no encuentra
//        el lead (en vez de devolver false).
//   db.ALLOWED_ESTADOS -> misma lista de estados válidos que ya usa
//     tu db.js; se reutiliza aquí en vez de duplicarla.
// ------------------------------------------------------------
// ============================================================

const auth = require('../_lib/auth.js');
const db = require('../_lib/db.js');

const PAGE_SIZE = 20;
const MAX_SEARCH_LENGTH = 100;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_ESTADOS = db.ALLOWED_ESTADOS;

function fail(res, status, message) {
  return res.status(status).json({ error: true, message: message });
}

module.exports = async function handler(req, res) {
  const authorized = await auth.requireAdminSession(req, res);
  if (!authorized) return;

  if (req.method === 'GET') {
    try {
      const query = req.query || {};
      const id = typeof query.id === 'string' ? query.id.trim() : '';
      const conversationId = typeof query.conversationId === 'string' ? query.conversationId.trim() : '';

      // --------------------------------------------------
      // Detalle de una solicitud puntual.
      //
      // Nota sobre admin.html: en la llamada principal envía el
      // identificador de la conversación bajo el parámetro "id"
      // (no el id real de la fila) — comportamiento ya existente
      // en el panel, no se modifica aquí. db.getLeadDetail() espera
      // ese mismo valor como texto simple, así que se usa
      // "conversationId" si llegó y si no "id" — ambos apuntan al
      // mismo dato.
      // --------------------------------------------------
      if (id || conversationId) {
        const lookupConversationId = conversationId || id;
        let detail;
        try {
          detail = await db.getLeadDetail(lookupConversationId);
        } catch (lookupErr) {
          console.log('admin/leads.js error (GET detalle):', lookupErr && lookupErr.message);
          return fail(res, 404, 'No encontramos esa solicitud.');
        }
        return res.status(200).json({ ok: true, data: detail });
      }

      // --------------------------------------------------
      // Listado paginado y filtrable
      // --------------------------------------------------
      const search = typeof query.search === 'string' ? query.search.slice(0, MAX_SEARCH_LENGTH) : '';
      const estado = typeof query.estado === 'string' && VALID_ESTADOS.includes(query.estado) ? query.estado : '';
      const dateFrom = typeof query.dateFrom === 'string' && DATE_REGEX.test(query.dateFrom) ? query.dateFrom : '';
      const dateTo = typeof query.dateTo === 'string' && DATE_REGEX.test(query.dateTo) ? query.dateTo : '';
      const page = Math.max(1, parseInt(query.page, 10) || 1);
      const offset = (page - 1) * PAGE_SIZE;

      const result = await db.listLeads({
        search: search,
        estado: estado,
        dateFrom: dateFrom,
        dateTo: dateTo,
        limit: PAGE_SIZE,
        offset: offset
      });

      return res.status(200).json({ ok: true, data: result });
    } catch (err) {
      console.log('admin/leads.js error (GET):', err && err.message);
      return res.status(500).json({ error: true, message: 'No pudimos cargar las solicitudes. Intenta nuevamente.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const contentType = (req.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        return fail(res, 400, 'Tipo de contenido no soportado.');
      }

      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 400, 'Formato de solicitud inválido.');
      }

      const id = (typeof body.id === 'string' || typeof body.id === 'number') ? String(body.id).trim() : '';
      const estado = typeof body.estado === 'string' ? body.estado.trim() : '';

      if (!id) {
        return fail(res, 400, 'Falta indicar qué solicitud se va a actualizar.');
      }
      if (!VALID_ESTADOS.includes(estado)) {
        return fail(res, 400, 'Ese estado no es válido.');
      }

      try {
        await db.updateLeadStatus(id, estado);
      } catch (updateErr) {
        console.log('admin/leads.js error (POST updateLeadStatus):', updateErr && updateErr.message);
        if (updateErr && updateErr.message === 'No se encontró el lead.') {
          return fail(res, 404, 'No encontramos esa solicitud.');
        }
        return fail(res, 500, 'No pudimos actualizar el estado. Intenta nuevamente.');
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.log('admin/leads.js error (POST):', err && err.message);
      return res.status(500).json({ error: true, message: 'No pudimos actualizar el estado. Intenta nuevamente.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return fail(res, 405, 'Método no permitido.');
};
