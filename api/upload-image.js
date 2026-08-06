// ============================================================
// FUNCIÓN (Vercel): sube una imagen (base64) a Vercel Blob Storage
// y devuelve la URL pública directa — a diferencia de Netlify,
// Vercel Blob ya entrega un link público real, así que no hace
// falta una función aparte para "servir" la imagen.
//
// Requiere tener conectado Vercel Blob al proyecto
// (Vercel → Storage → Create Database → Blob).
//
// Protegida con usuario y contraseña (ADMIN_USER / ADMIN_PASSWORD
// en Vercel → Project Settings → Environment Variables).
// ============================================================

const { put } = require('@vercel/blob');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { username, password, dataBase64, contentType } = req.body || {};

    if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    if (!dataBase64) {
      return res.status(400).json({ error: 'Falta la imagen' });
    }
    if (dataBase64.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'La imagen es demasiado pesada. Máximo ~3MB.' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    const ext = (contentType || 'image/jpeg').split('/')[1] || 'jpg';
    const filename = 'proyectos/' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext;

    const blob = await put(filename, buffer, {
      access: 'public',
      contentType: contentType || 'image/jpeg'
    });

    return res.status(200).json({ ok: true, url: blob.url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
