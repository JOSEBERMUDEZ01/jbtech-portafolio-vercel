// ============================================================
// api/_lib/db.js
//
// Persistencia de leads/contactos/conversaciones en Supabase
// (Postgres administrado). Requiere:
//   1. Haber corrido supabase-schema.sql en tu proyecto de Supabase.
//   2. Variables de entorno en Vercel:
//        SUPABASE_URL
//        SUPABASE_SERVICE_ROLE_KEY
//
// Este archivo corre EXCLUSIVAMENTE en funciones serverless.
// SUPABASE_SERVICE_ROLE_KEY tiene permisos de escritura totales
// sobre la base de datos y NUNCA debe exponerse al navegador ni
// usarse en ningún código de frontend.
//
// No se creó ninguna base de datos nueva "por si acaso": el
// proyecto ya usaba Vercel KV, pero KV está pensado para datos
// efímeros con TTL (rate limiting, contenido cacheado) — no es
// apropiado para guardar leads/contactos de forma permanente y
// consultable. Por eso se usa Postgres (Supabase) solo para esto.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

function getClient() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase no está configurado (faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false }
  });
  return cachedClient;
}

// ------------------------------------------------------------
// Guarda un paquete completo de lead: conversación + lead +
// (opcionalmente) contacto, solo si hay consentimiento.
// Lanza un Error genérico si algo falla — quien llama debe
// capturarlo y NUNCA debe asumir éxito sin que esta función
// resuelva correctamente.
// ------------------------------------------------------------
async function saveLeadPackage(input) {
  const supabase = getClient();
  const nowIso = new Date().toISOString();

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

  const { error: leadErr } = await supabase.from('leads').insert({
    conversation_id: conversationId,
    proyecto: summary && summary.proyecto ? summary.proyecto : null,
    necesidad: summary && summary.necesidad ? summary.necesidad : null,
    problema: summary && summary.problema ? summary.problema : null,
    objetivo: summary && summary.objetivo ? summary.objetivo : null,
    solucion_sugerida: summary && summary.solucion_sugerida ? summary.solucion_sugerida : null,
    lead_score: typeof input.leadScore === 'number' ? input.leadScore : null,
    estado: 'nuevo',
    fecha: nowIso
  });

  if (leadErr) {
    throw new Error('No se pudo guardar el lead en Supabase.');
  }

  if (input.consent && input.contact && (input.contact.name || input.contact.whatsapp || input.contact.email)) {
    const { error: contactErr } = await supabase.from('contactos').insert({
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

  return { conversationId: conversationId };
}

module.exports = { saveLeadPackage: saveLeadPackage };
