// ============================================================
// api/_lib/db.js
//
// Persistencia de conversaciones, proyectos y contactos
// autorizados en Supabase.
//
// IMPORTANTE:
// - Este archivo SOLO se ejecuta en el backend de Vercel.
// - SUPABASE_SECRET_KEY NUNCA debe aparecer en frontend.
// - La Secret Key de Supabase tiene permisos elevados y
//   permite escribir aunque las tablas tengan RLS activado.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function getClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase no está configurado. Verifica SUPABASE_URL y SUPABASE_SECRET_KEY.'
    );
  }

  cachedClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });

  return cachedClient;
}


// ============================================================
// Guarda:
// 1. conversación
// 2. información del proyecto
// 3. contacto, únicamente cuando existe consentimiento
// ============================================================

async function saveLeadPackage(input) {
  const supabase = getClient();

  const nowIso = new Date().toISOString();

  // ----------------------------------------------------------
  // Validaciones mínimas
  // ----------------------------------------------------------

  if (!input || typeof input !== 'object') {
    throw new Error('Datos de persistencia inválidos.');
  }

  if (!input.sessionId) {
    throw new Error('Falta el identificador de sesión.');
  }


  // ==========================================================
  // 1. GUARDAR CONVERSACIÓN
  // ==========================================================

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
  // 2. GUARDAR INFORMACIÓN DEL PROYECTO
  // ==========================================================

  const summary = (
    input.summary &&
    typeof input.summary === 'object'
  )
    ? input.summary
    : {};

  const leadPayload = {
    conversation_id: conversationId,

    proyecto:
      typeof summary.proyecto === 'string'
        ? summary.proyecto.slice(0, 500)
        : null,

    necesidad:
      typeof summary.necesidad === 'string'
        ? summary.necesidad.slice(0, 1000)
        : null,

    problema:
      typeof summary.problema === 'string'
        ? summary.problema.slice(0, 1000)
        : null,

    objetivo:
      typeof summary.objetivo === 'string'
        ? summary.objetivo.slice(0, 1000)
        : null,

    solucion_sugerida:
      typeof summary.solucion_sugerida === 'string'
        ? summary.solucion_sugerida.slice(0, 1500)
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
    console.error(
      'SUPABASE leads INSERT ERROR:',
      leadError
    );

    throw new Error(
      'No se pudo guardar la información del proyecto en Supabase.'
    );
  }


  // ==========================================================
  // 3. GUARDAR CONTACTO
  //
  // SOLO se guarda cuando el usuario autorizó expresamente.
  // ==========================================================

  if (
    input.consent === true &&
    input.contact &&
    typeof input.contact === 'object'
  ) {
    const contact = input.contact;

    const name =
      typeof contact.name === 'string'
        ? contact.name.trim().slice(0, 100)
        : '';

    const whatsapp =
      typeof contact.whatsapp === 'string'
        ? contact.whatsapp.trim().slice(0, 100)
        : '';

    const email =
      typeof contact.email === 'string'
        ? contact.email.trim().slice(0, 100)
        : '';

    // Solo crear el registro si realmente existe
    // información de contacto.
    if (name || whatsapp || email) {
      const contactPayload = {
        conversation_id: conversationId,

        nombre: name || null,

        correo: email || null,

        whatsapp: whatsapp || null,

        fecha: nowIso,

        consentimiento: true,

        consentimiento_fecha: nowIso,

        version_politica:
          input.policyVersion || null
      };

      const {
        error: contactError
      } = await supabase
        .from('contactos')
        .insert(contactPayload);

      if (contactError) {
        console.error(
          'SUPABASE contactos INSERT ERROR:',
          contactError
        );

        throw new Error(
          'No se pudo guardar la información de contacto.'
        );
      }
    }
  }


  // ==========================================================
  // ÉXITO
  // ==========================================================

  return {
    conversationId
  };
}


module.exports = {
  saveLeadPackage
};
