// ============================================================
// api/_lib/db.js
//
// Persistencia y consultas administrativas de JB TECH AI
// usando Supabase.
//
// IMPORTANTE:
// - Este archivo SOLO se ejecuta en el backend de Vercel.
// - SUPABASE_SECRET_KEY NUNCA debe llegar al navegador.
// - La Secret Key tiene privilegios elevados y bypass de RLS.
// - Este archivo NO crea tablas.
// - Utiliza las tablas existentes:
//
//      conversaciones
//      leads
//      contactos
//
// Variables de entorno requeridas en Vercel:
//
//      SUPABASE_URL
//      SUPABASE_SECRET_KEY
// ============================================================

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

// ============================================================
// CLIENTE SUPABASE SERVER-SIDE
// ============================================================

function getClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase no está configurado correctamente. Faltan SUPABASE_URL o SUPABASE_SECRET_KEY.'
    );
  }

  cachedClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  return cachedClient;
}

// ============================================================
// ESTADOS PERMITIDOS
// ============================================================

const ALLOWED_ESTADOS = [
  'nuevo',
  'en_seguimiento',
  'contactado',
  'cerrado',
  'descartado'
];

// ============================================================
// GUARDAR LEAD COMPLETO
//
// Flujo:
//
// 1. Guarda conversación.
// 2. Obtiene conversation_id.
// 3. Guarda lead.
// 4. Si existe consentimiento y datos de contacto,
//    guarda contacto.
//
// Si una operación falla, se lanza un error.
// ============================================================

async function saveLeadPackage(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Datos de persistencia inválidos.');
  }

  if (!input.sessionId) {
    throw new Error('Falta sessionId.');
  }

  const supabase = getClient();
  const nowIso = new Date().toISOString();

  // ==========================================================
  // 1. CONVERSACIÓN
  // ==========================================================

  const {
    data: conversation,
    error: conversationError
  } = await supabase
    .from('conversaciones')
    .insert({
      session_id: input.sessionId,
      fecha: nowIso,
      idioma: input.idioma || 'es',
      estado: 'lead',
      consentimiento: input.consent === true,
      version_politica: input.policyVersion || null
    })
    .select('id')
    .single();

  if (conversationError || !conversation) {
    console.error(
      'SUPABASE conversaciones INSERT ERROR:',
      conversationError
    );

    throw new Error(
      'No se pudo guardar la conversación en Supabase.'
    );
  }

  const conversationId = conversation.id;

  // ==========================================================
  // 2. LEAD
  // ==========================================================

  const summary =
    input.summary && typeof input.summary === 'object'
      ? input.summary
      : {};

  const {
    error: leadError
  } = await supabase
    .from('leads')
    .insert({
      conversation_id: conversationId,

      proyecto:
        typeof summary.proyecto === 'string'
          ? summary.proyecto.trim()
          : null,

      necesidad:
        typeof summary.necesidad === 'string'
          ? summary.necesidad.trim()
          : null,

      problema:
        typeof summary.problema === 'string'
          ? summary.problema.trim()
          : null,

      objetivo:
        typeof summary.objetivo === 'string'
          ? summary.objetivo.trim()
          : null,

      solucion_sugerida:
        typeof summary.solucion_sugerida === 'string'
          ? summary.solucion_sugerida.trim()
          : null,

      lead_score:
        typeof input.leadScore === 'number'
          ? input.leadScore
          : null,

      estado: 'nuevo',
      fecha: nowIso
    });

  if (leadError) {
    console.error(
      'SUPABASE leads INSERT ERROR:',
      leadError
    );

    throw new Error(
      'No se pudo guardar el lead en Supabase.'
    );
  }

  // ==========================================================
  // 3. CONTACTO
  //
  // SOLO si existe consentimiento explícito.
  // ==========================================================

  if (
    input.consent === true &&
    input.contact &&
    typeof input.contact === 'object'
  ) {
    const contact = input.contact;

    const name =
      typeof contact.name === 'string'
        ? contact.name.trim()
        : '';

    const whatsapp =
      typeof contact.whatsapp === 'string'
        ? contact.whatsapp.trim()
        : '';

    const email =
      typeof contact.email === 'string'
        ? contact.email.trim()
        : '';

    if (name || whatsapp || email) {
      const {
        error: contactError
      } = await supabase
        .from('contactos')
        .insert({
          conversation_id: conversationId,

          nombre: name || null,

          correo: email || null,

          whatsapp: whatsapp || null,

          fecha: nowIso,

          consentimiento: true,

          consentimiento_fecha: nowIso,

          version_politica:
            input.policyVersion || null
        });

      if (contactError) {
        console.error(
          'SUPABASE contactos INSERT ERROR:',
          contactError
        );

        throw new Error(
          'No se pudo guardar el contacto en Supabase.'
        );
      }
    }
  }

  return {
    conversationId
  };
}

// ============================================================
// DASHBOARD
//
// Devuelve:
// - cantidad de leads por estado
// - total de contactos
// - últimas solicitudes
// ============================================================

async function getDashboardCounts() {
  const supabase = getClient();

  const counts = {};

  for (const estado of ALLOWED_ESTADOS) {
    const {
      count,
      error
    } = await supabase
      .from('leads')
      .select('id', {
        count: 'exact',
        head: true
      })
      .eq('estado', estado);

    if (error) {
      console.error(
        'SUPABASE dashboard COUNT ERROR:',
        error
      );

      throw new Error(
        'No se pudieron obtener los conteos del dashboard.'
      );
    }

    counts[estado] = count || 0;
  }

  // ==========================================================
  // TOTAL CONTACTOS
  // ==========================================================

  const {
    count: totalContactos,
    error: contactosError
  } = await supabase
    .from('contactos')
    .select('id', {
      count: 'exact',
      head: true
    });

  if (contactosError) {
    console.error(
      'SUPABASE contactos COUNT ERROR:',
      contactosError
    );

    throw new Error(
      'No se pudo obtener el total de contactos.'
    );
  }

  // ==========================================================
  // SOLICITUDES RECIENTES
  // ==========================================================

  const {
    data: recent,
    error: recentError
  } = await supabase
    .from('leads')
    .select(
      'id, conversation_id, proyecto, necesidad, estado, fecha, lead_score'
    )
    .order('fecha', {
      ascending: false
    })
    .limit(5);

  if (recentError) {
    console.error(
      'SUPABASE recent leads ERROR:',
      recentError
    );

    throw new Error(
      'No se pudieron obtener las solicitudes recientes.'
    );
  }

  return {
    counts,
    totalContactos: totalContactos || 0,
    recent: recent || []
  };
}

// ============================================================
// LISTAR LEADS
//
// Soporta:
// - búsqueda
// - estado
// - fecha inicial
// - fecha final
// - paginación
// ============================================================

async function listLeads(params = {}) {
  const supabase = getClient();

  const search =
    typeof params.search === 'string'
      ? params.search.trim()
      : '';

  const estado =
    typeof params.estado === 'string'
      ? params.estado.trim()
      : '';

  const dateFrom =
    typeof params.dateFrom === 'string'
      ? params.dateFrom.trim()
      : '';

  const dateTo =
    typeof params.dateTo === 'string'
      ? params.dateTo.trim()
      : '';

  const limit = Math.min(
    Math.max(
      Number(params.limit) || 20,
      1
    ),
    100
  );

  const offset = Math.max(
    Number(params.offset) || 0,
    0
  );

  let query = supabase
    .from('leads')
    .select(
      `
        id,
        conversation_id,
        proyecto,
        necesidad,
        problema,
        objetivo,
        solucion_sugerida,
        lead_score,
        estado,
        fecha
      `,
      {
        count: 'exact'
      }
    );

  // ==========================================================
  // FILTRO ESTADO
  // ==========================================================

  if (estado) {
    if (!ALLOWED_ESTADOS.includes(estado)) {
      throw new Error(
        'Estado de filtro inválido.'
      );
    }

    query = query.eq('estado', estado);
  }

  // ==========================================================
  // FILTRO FECHA INICIAL
  // ==========================================================

  if (dateFrom) {
    query = query.gte('fecha', dateFrom);
  }

  // ==========================================================
  // FILTRO FECHA FINAL
  // ==========================================================

  if (dateTo) {
    query = query.lte('fecha', dateTo);
  }

  // ==========================================================
  // BÚSQUEDA
  // ==========================================================

  if (search) {
    const safeSearch = search
      .replace(/[%\\_,()]/g, ' ')
      .trim();

    if (safeSearch) {
      query = query.or(
        `proyecto.ilike.%${safeSearch}%,necesidad.ilike.%${safeSearch}%,problema.ilike.%${safeSearch}%,objetivo.ilike.%${safeSearch}%`
      );
    }
  }

  // ==========================================================
  // ORDEN + PAGINACIÓN
  // ==========================================================

  query = query
    .order('fecha', {
      ascending: false
    })
    .range(
      offset,
      offset + limit - 1
    );

  const {
    data,
    error,
    count
  } = await query;

  if (error) {
    console.error(
      'SUPABASE listLeads ERROR:',
      error
    );

    throw new Error(
      'No se pudieron cargar las solicitudes.'
    );
  }

  return {
    items: data || [],
    total: count || 0
  };
}

// ============================================================
// DETALLE DE UN LEAD
//
// Devuelve:
// - conversación
// - lead
// - contacto únicamente si hubo consentimiento
// ============================================================

async function getLeadDetail(conversationId) {
  if (!conversationId) {
    throw new Error(
      'Falta el identificador de conversación.'
    );
  }

  const supabase = getClient();

  // ==========================================================
  // CONVERSACIÓN
  // ==========================================================

  const {
    data: conversation,
    error: conversationError
  } = await supabase
    .from('conversaciones')
    .select('*')
    .eq('id', conversationId)
    .single();

  if (
    conversationError ||
    !conversation
  ) {
    console.error(
      'SUPABASE conversation DETAIL ERROR:',
      conversationError
    );

    throw new Error(
      'No se encontró la solicitud.'
    );
  }

  // ==========================================================
  // LEAD
  // ==========================================================

  const {
    data: lead,
    error: leadError
  } = await supabase
    .from('leads')
    .select('*')
    .eq(
      'conversation_id',
      conversationId
    )
    .order('fecha', {
      ascending: false
    })
    .limit(1)
    .maybeSingle();

  if (leadError) {
    console.error(
      'SUPABASE lead DETAIL ERROR:',
      leadError
    );

    throw new Error(
      'No se pudo cargar el detalle del lead.'
    );
  }

  // ==========================================================
  // CONTACTO
  //
  // Solo se devuelve con consentimiento explícito.
  // ==========================================================

  let contacto = null;

  if (
    conversation.consentimiento === true
  ) {
    const {
      data: contact,
      error: contactError
    } = await supabase
      .from('contactos')
      .select('*')
      .eq(
        'conversation_id',
        conversationId
      )
      .limit(1)
      .maybeSingle();

    if (contactError) {
      console.error(
        'SUPABASE contact DETAIL ERROR:',
        contactError
      );

      throw new Error(
        'No se pudo cargar el contacto.'
      );
    }

    contacto = contact || null;
  }

  return {
    conversacion: conversation,
    lead: lead || null,
    contacto
  };
}

// ============================================================
// ACTUALIZAR ESTADO DEL LEAD
// ============================================================

async function updateLeadStatus(
  leadId,
  estado
) {
  if (!leadId) {
    throw new Error(
      'Falta el identificador del lead.'
    );
  }

  if (
    !ALLOWED_ESTADOS.includes(estado)
  ) {
    throw new Error(
      'Estado inválido.'
    );
  }

  const supabase = getClient();

  const {
    data,
    error
  } = await supabase
    .from('leads')
    .update({
      estado
    })
    .eq('id', leadId)
    .select('id, estado')
    .maybeSingle();

  if (error) {
    console.error(
      'SUPABASE updateLeadStatus ERROR:',
      error
    );

    throw new Error(
      'No se pudo actualizar el estado.'
    );
  }

  if (!data) {
    throw new Error(
      'No se encontró el lead.'
    );
  }

  return {
    ok: true,
    lead: data
  };
}

// ============================================================
// LISTAR CONTACTOS
//
// Solo existen contactos cuando hubo consentimiento.
// También devuelve información básica del lead relacionado.
// ============================================================

async function listContacts(params = {}) {
  const supabase = getClient();

  const search =
    typeof params.search === 'string'
      ? params.search.trim()
      : '';

  const limit = Math.min(
    Math.max(
      Number(params.limit) || 20,
      1
    ),
    100
  );

  const offset = Math.max(
    Number(params.offset) || 0,
    0
  );

  let query = supabase
    .from('contactos')
    .select(
      `
        id,
        conversation_id,
        nombre,
        correo,
        whatsapp,
        fecha
      `,
      {
        count: 'exact'
      }
    );

  // ==========================================================
  // BÚSQUEDA
  // ==========================================================

  if (search) {
    const safeSearch = search
      .replace(/[%\\_,()]/g, ' ')
      .trim();

    if (safeSearch) {
      query = query.or(
        `nombre.ilike.%${safeSearch}%,correo.ilike.%${safeSearch}%,whatsapp.ilike.%${safeSearch}%`
      );
    }
  }

  // ==========================================================
  // ORDEN + PAGINACIÓN
  // ==========================================================

  query = query
    .order('fecha', {
      ascending: false
    })
    .range(
      offset,
      offset + limit - 1
    );

  const {
    data,
    error,
    count
  } = await query;

  if (error) {
    console.error(
      'SUPABASE listContacts ERROR:',
      error
    );

    throw new Error(
      'No se pudieron cargar los contactos.'
    );
  }

  const contacts = data || [];

  if (contacts.length === 0) {
    return {
      items: [],
      total: count || 0
    };
  }

  // ==========================================================
  // OBTENER LEADS RELACIONADOS
  // ==========================================================

  const conversationIds = contacts
    .map(
      contact => contact.conversation_id
    )
    .filter(Boolean);

  let relatedLeads = [];

  if (conversationIds.length > 0) {
    const {
      data: leads,
      error: leadsError
    } = await supabase
      .from('leads')
      .select(
        'conversation_id, proyecto, estado'
      )
      .in(
        'conversation_id',
        conversationIds
      );

    if (leadsError) {
      console.error(
        'SUPABASE related leads ERROR:',
        leadsError
      );

      throw new Error(
        'No se pudieron relacionar los proyectos.'
      );
    }

    relatedLeads = leads || [];
  }

  // ==========================================================
  // MAPEAR LEADS POR CONVERSACIÓN
  // ==========================================================

  const leadByConversation = {};

  for (const lead of relatedLeads) {
    leadByConversation[
      lead.conversation_id
    ] = lead;
  }

  // ==========================================================
  // RESPUESTA FINAL
  // ==========================================================

  const items = contacts.map(
    contact => {
      const related =
        leadByConversation[
          contact.conversation_id
        ] || null;

      return {
        id: contact.id,

        conversation_id:
          contact.conversation_id,

        nombre:
          contact.nombre,

        correo:
          contact.correo,

        whatsapp:
          contact.whatsapp,

        fecha:
          contact.fecha,

        proyecto:
          related
            ? related.proyecto
            : null,

        estado:
          related
            ? related.estado
            : null
      };
    }
  );

  return {
    items,
    total: count || 0
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  saveLeadPackage,
  getDashboardCounts,
  listLeads,
  getLeadDetail,
  updateLeadStatus,
  listContacts,
  ALLOWED_ESTADOS
};
