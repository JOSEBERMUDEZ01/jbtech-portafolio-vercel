// ============================================================
// api/_lib/db.js
//
// Persistencia de conversaciones, proyectos y contactos en
// Supabase.
//
// Variables de entorno requeridas en Vercel:
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//
// IMPORTANTE:
// SUPABASE_SECRET_KEY se utiliza únicamente en funciones
// serverless. Nunca debe exponerse al navegador ni colocarse
// en código frontend.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

// ------------------------------------------------------------
// Cliente de Supabase
// ------------------------------------------------------------
function getClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase no está configurado (faltan SUPABASE_URL / SUPABASE_SECRET_KEY).'
    );
  }

  cachedClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return cachedClient;
}

// ------------------------------------------------------------
// Registra de forma segura el error devuelto por Supabase.
//
// NO registra la URL, la clave secreta ni datos de contacto.
// Solo guarda la información técnica necesaria para diagnosticar
// un error de escritura.
// ------------------------------------------------------------
function logSupabaseError(operation, error) {
  console.error(`SUPABASE ${operation} ERROR:`, {
    message: error?.message || null,
    details: error?.details || null,
    hint: error?.hint || null,
    code: error?.code || null,
    status: error?.status || null
  });
}

// ------------------------------------------------------------
// Guarda el paquete completo:
//
// 1. Conversación
// 2. Información/resumen del proyecto
// 3. Contacto, únicamente cuando existe consentimiento.
//
// Si una operación falla, se lanza un error genérico hacia
// el endpoint para no revelar información interna al cliente.
// El detalle real queda únicamente en los logs de Vercel.
// ------------------------------------------------------------
async function saveLeadPackage(input) {
  const supabase = getClient();
  const nowIso = new Date().toISOString();

  // ----------------------------------------------------------
  // Validaciones básicas
  // ----------------------------------------------------------
  if (!input || typeof input !== 'object') {
    throw new Error('Datos de persistencia inválidos.');
  }

  if (!input.sessionId || typeof input.sessionId !== 'string') {
    throw new Error('Sesión inválida.');
  }

  // ----------------------------------------------------------
  // 1. Guardar conversación
  // ----------------------------------------------------------
  const conversationPayload = {
    session_id: input.sessionId,
    fecha: nowIso,
    idioma: input.idioma || 'es',
    estado: 'lead',
    consentimiento: input.consent === true,
    version_politica: input.policyVersion || null
  };

  const {
    data: conversation,
    error: conversationError
  } = await supabase
    .from('conversaciones')
    .insert(conversationPayload)
    .select('id')
    .single();

  if (conversationError || !conversation) {
    logSupabaseError(
      'conversaciones INSERT',
      conversationError
    );

    throw new Error(
      'No se pudo guardar la conversación en Supabase.'
    );
  }

  const conversationId = conversation.id;

  // ----------------------------------------------------------
  // 2. Guardar información del proyecto
  // ----------------------------------------------------------
  const summary = input.summary || null;

  const leadPayload = {
    conversation_id: conversationId,

    proyecto:
      summary && summary.proyecto
        ? String(summary.proyecto).slice(0, 1000)
        : null,

    necesidad:
      summary && summary.necesidad
        ? String(summary.necesidad).slice(0, 2000)
        : null,

    problema:
      summary && summary.problema
        ? String(summary.problema).slice(0, 2000)
        : null,

    objetivo:
      summary && summary.objetivo
        ? String(summary.objetivo).slice(0, 2000)
        : null,

    solucion_sugerida:
      summary && summary.solucion_sugerida
        ? String(summary.solucion_sugerida).slice(0, 2000)
        : null,

    lead_score:
      typeof input.leadScore === 'number'
        ? Math.max(0, Math.min(100, Math.round(input.leadScore)))
        : null,

    estado: 'nuevo',
    fecha: nowIso
  };

  const {
    error: leadError
  } = await supabase
    .from('leads')
    .insert(leadPayload);

  if (leadError) {
    logSupabaseError(
      'leads INSERT',
      leadError
    );

    throw new Error(
      'No se pudo guardar la información del proyecto en Supabase.'
    );
  }

  // ----------------------------------------------------------
  // 3. Guardar contacto
  //
  // SOLO se ejecuta cuando existe consentimiento explícito.
  // ----------------------------------------------------------
  if (
    input.consent === true &&
    input.contact &&
    typeof input.contact === 'object'
  ) {
    const name =
      typeof input.contact.name === 'string'
        ? input.contact.name.trim().slice(0, 100)
        : '';

    const whatsapp =
      typeof input.contact.whatsapp === 'string'
        ? input.contact.whatsapp.trim().slice(0, 100)
        : '';

    const email =
      typeof input.contact.email === 'string'
        ? input.contact.email.trim().slice(0, 100)
        : '';

    // No guardar una fila de contacto vacía.
    if (name || whatsapp || email) {
      const contactPayload = {
        conversation_id: conversationId,
        nombre: name || null,
        correo: email || null,
        whatsapp: whatsapp || null,
        fecha: nowIso,
        consentimiento: true,
        consentimiento_fecha: nowIso,
        version_politica: input.policyVersion || null
      };

      const {
        error: contactError
      } = await supabase
        .from('contactos')
        .insert(contactPayload);

      if (contactError) {
        logSupabaseError(
          'contactos INSERT',
          contactError
        );

        throw new Error(
          'No se pudo guardar el contacto en Supabase.'
        );
      }
    }
  }

  // ----------------------------------------------------------
  // Todo salió correctamente.
  // ----------------------------------------------------------
  return {
    conversationId
  };
}

module.exports = {
  saveLeadPackage
};
