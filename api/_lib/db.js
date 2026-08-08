// ============================================================
// api/_lib/db.js
//
// Persistencia de leads/contactos/conversaciones en Supabase
// (Postgres administrado).
//
// Requiere estas variables de entorno en Vercel:
//
//   SUPABASE_URL
//   SUPABASE_SECRET_KEY
//
// Este archivo corre EXCLUSIVAMENTE en funciones serverless.
//
// SUPABASE_SECRET_KEY es una clave privada de servidor con
// permisos elevados. NUNCA debe exponerse al navegador,
// incluirse en index.html, enviarse al cliente ni subirse
// al repositorio.
//
// La persistencia se realiza únicamente desde las funciones
// serverless de Vercel. El navegador no accede directamente
// a estas tablas.
//
// ============================================================

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

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
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  return cachedClient;
}

// ------------------------------------------------------------
// Guarda un paquete completo de lead:
//
//   1. conversación
//   2. lead
//   3. contacto, únicamente si existe consentimiento explícito
//
// Lanza un Error genérico si algo falla.
// La función que llama a este módulo debe capturarlo y nunca
// asumir que la operación tuvo éxito si esta función falla.
// ------------------------------------------------------------
async function saveLeadPackage(input) {
  const supabase = getClient();
  const nowIso = new Date().toISOString();

  // ----------------------------------------------------------
  // 1. Guardar conversación
  // ----------------------------------------------------------
  const { data: conv, error: convErr } = await supabase
    .from('conversaciones')
    .insert({
      session_id: input.sessionId,
      fecha: nowIso,
      idioma: input.idioma || 'es',
      estado: 'lead',
      consentimiento: !!input.consent,
      version_politica: input.policyVersion || null
    })
    .select('id')
    .single();

  if (convErr || !conv) {
    throw new Error('No se pudo guardar la conversación en Supabase.');
  }

  const conversationId = conv.id;
  const summary = input.summary || null;

  // ----------------------------------------------------------
  // 2. Guardar lead
  // ----------------------------------------------------------
  const { error: leadErr } = await supabase
    .from('leads')
    .insert({
      conversation_id: conversationId,
      proyecto:
        summary && summary.proyecto
          ? summary.proyecto
          : null,
      necesidad:
        summary && summary.necesidad
          ? summary.necesidad
          : null,
      problema:
        summary && summary.problema
          ? summary.problema
          : null,
      objetivo:
        summary && summary.objetivo
          ? summary.objetivo
          : null,
      solucion_sugerida:
        summary && summary.solucion_sugerida
          ? summary.solucion_sugerida
          : null,
      lead_score:
        typeof input.leadScore === 'number'
          ? input.leadScore
          : null,
      estado: 'nuevo',
      fecha: nowIso
    });

  if (leadErr) {
    throw new Error('No se pudo guardar el lead en Supabase.');
  }

  // ----------------------------------------------------------
  // 3. Guardar contacto SOLO con consentimiento explícito
  // ----------------------------------------------------------
  if (
    input.consent &&
    input.contact &&
    (
      input.contact.name ||
      input.contact.whatsapp ||
      input.contact.email
    )
  ) {
    const { error: contactErr } = await supabase
      .from('contactos')
      .insert({
        conversation_id: conversationId,
        nombre: input.contact.name || null,
        correo: input.contact.email || null,
        whatsapp: input.contact.whatsapp || null,
        fecha: nowIso,
        consentimiento: true,
        consentimiento_fecha: nowIso,
        version_politica: input.policyVersion || null
      });

    if (contactErr) {
      throw new Error('No se pudo guardar el contacto en Supabase.');
    }
  }

  return {
    conversationId
  };
}

module.exports = {
  saveLeadPackage
};
