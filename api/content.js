// ============================================================
// FUNCIÓN (Vercel): contenido editable del sitio.
//
// GET  -> devuelve el contenido actual (público, el sitio lo
//         necesita leer para mostrarse).
// POST -> guarda contenido nuevo (protegido con usuario y
//         contraseña — ver ADMIN_USER / ADMIN_PASSWORD en
//         Vercel → Project Settings → Environment Variables).
//
// Todo se guarda en Vercel KV, bajo una sola clave ("site-content").
// Requiere tener conectado el almacenamiento KV al proyecto
// (Vercel → Storage → Create Database → KV).
// ============================================================

const { kv } = require('@vercel/kv');

const DEFAULT_CONTENT = {
  hero: {
    eyebrow: 'Ingeniería de software · Riohacha, La Guajira',
    title: 'Soy <span class="accent">Jose Bermúdez</span>, desarrollador Full Stack.',
    tagline: 'Creamos soluciones digitales a medida para empresas y emprendimientos.',
    sub: 'Diseño, documento y construyo productos digitales completos: desde el análisis de requerimientos hasta el soporte en producción.'
  },
  about: {
    title: 'Full Stack, con la ingeniería como norte.',
    p1: 'Especializado en <strong>Python, Django, JavaScript, PostgreSQL y PWAs</strong>, trabajo bajo la marca <strong>JB Tech</strong> construyendo soluciones completas para negocios reales — desde el análisis inicial hasta el soporte en producción, siguiendo siempre metodologías reales de ingeniería de software.'
  },
  contact: {
    tagline: 'Cuéntame qué necesitas construir. Respondo directo, sin intermediarios ni plantillas de venta.',
    whatsapp: 'WhatsApp: +57 302 352 8086',
    location: 'Riohacha, La Guajira, Colombia',
    availability: 'Disponible para proyectos freelance y remotos'
  },
  projects: [
    {
      name: 'Maxi Gomitas',
      tag: 'PWA · E-COMMERCE',
      description: 'Plataforma PWA de venta de snacks artesanales, con catálogo, pedidos y seguimiento integrado.',
      link: 'https://maxigomitas-web.vercel.app/',
      image: null
    },
    {
      name: 'Bogotá Bling',
      tag: 'WEB · MARCA',
      description: 'Sitio web de marca con enfoque visual y comercial, optimizado para presentación de producto.',
      link: 'https://bogotabling.vercel.app/',
      image: null
    }
  ]
};

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const content = await kv.get('site-content');
      res.setHeader('Cache-Control', 'no-cache');
      return res.status(200).json(content || DEFAULT_CONTENT);
    }

    if (req.method === 'POST') {
      const { username, password, content } = req.body || {};

      if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      }
      if (!content) {
        return res.status(400).json({ error: 'Falta el contenido a guardar' });
      }

      await kv.set('site-content', content);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
