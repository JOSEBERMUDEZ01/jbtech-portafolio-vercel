// ============================================================
// api/_lib/db.js
//
// Persistencia de conversaciones, leads y contactos en Supabase.
//
// IMPORTANTE:
// - Este archivo SOLO se ejecuta en Vercel.
// - SUPABASE_SECRET_KEY NUNCA debe llegar al navegador.
// - La clave se utiliza únicamente mediante el header "apikey".
// - No se utiliza Authorization: Bearer con la secret key.
// ============================================================

let cachedConfig = null;

function getConfig() {
  if (cachedConfig) return cachedConfig;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase no está configurado correctamente.'
    );
  }

  cachedConfig = {
    url: url.replace(/\/+$/, ''),
    key
  };

  return cachedConfig;
}

// ------------------------------------------------------------
// Petición directa al Data API de Supabase.
// Utilizamos exclusivamente "apikey" para la secret key.
// ------------------------------------------------------------
async function supabaseRequest(path, options = {}) {
  const { url, key } = getConfig();

  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(
    `${url}/rest/v1/${path}`,
    {
      ...options,
      headers
    }
  );

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    console.error(
      `SUPABASE ERROR ${response.status}:`,
      data
    );

    throw new Error(
      `Supabase respondió con HTTP ${response.status}.`
    );
  }

  return data;
}

// ------------------------------------------------------------
// Guarda:
//
// 1. conversaciones
// 2. leads
// 3. contactos (solo con consentimiento)
//
// Si cualquiera de las operaciones falla, se lanza un error.
// ------------------------------------------------------------
async function saveLeadPackage(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Datos de persistencia inválidos.');
  }

  if (!input.sessionId) {
    throw new Error('Falta sessionId.');
  }

  const nowIso = new Date().toISOString();

  // ==========================================================
  // 1. CONVERSACIÓN
  // ==========================================================

  const conversationRows = await supabaseRequest(
    'conversaciones?select=id',
    {
      method: 'POST',
      headers: {
        Prefer: 'return=representation'
      },
      body: JSON.stringify([
        {
          session_id: input.sessionId,
          fecha: nowIso,
          idioma: input.idioma || 'es',
          estado: 'lead',
          consentimiento: input.consent === true,
          version_politica: input.policyVersion || null
        }
      ])
    }
  );

  if (
    !Array.isArray(conversationRows) ||
    !conversationRows[0] ||
    !conversationRows[0].id
  ) {
    throw new Error(
      'Supabase no devolvió el ID de la conversación.'
    );
  }

  const conversationId = conversationRows[0].id;

  // ==========================================================
  // 2. LEAD
  // ==========================================================

  const summary = input.summary || {};

  const leadRows = await supabaseRequest(
    'leads',
    {
      method: 'POST',
      headers: {
        Prefer: 'return=minimal'
      },
      body: JSON.stringify([
        {
          conversation_id: conversationId,

          proyecto:
            summary.proyecto ||
            null,

          necesidad:
            summary.necesidad ||
            null,

          problema:
            summary.problema ||
            null,

          objetivo:
            summary.objetivo ||
            null,

          solucion_sugerida:
            summary.solucion_sugerida ||
            null,

          lead_score:
            typeof input.leadScore === 'number'
              ? input.leadScore
              : null,

          estado: 'nuevo',
          fecha: nowIso
        }
      ])
    }
  );

  void leadRows;

  // ==========================================================
  // 3. CONTACTO
  //
  // SOLO se guarda si existe consentimiento explícito.
  // ==========================================================

  if (
    input.consent === true &&
    input.contact &&
    typeof input.contact === 'object'
  ) {
    const contact = input.contact;

    const hasContactData =
      contact.name ||
      contact.whatsapp ||
      contact.email;

    if (hasContactData) {
      await supabaseRequest(
        'contactos',
        {
          method: 'POST',
          headers: {
            Prefer: 'return=minimal'
          },
          body: JSON.stringify([
            {
              conversation_id: conversationId,

              nombre:
                contact.name ||
                null,

              correo:
                contact.email ||
                null,

              whatsapp:
                contact.whatsapp ||
                null,

              fecha: nowIso,

              consentimiento: true,

              consentimiento_fecha: nowIso,

              version_politica:
                input.policyVersion ||
                null
            }
          ])
        }
      );
    }
  }

  return {
    conversationId
  };
}

module.exports = {
  saveLeadPackage
};
