JB TECH — ADMINISTRACIÓN V2

Incluye:
- admin.html actualizado para coincidir con el index.html actual de JB Tech.
- api/upload-image.js corregido para Vercel Blob.

IMPORTANTE — VERCEL BLOB
El error:
  Vercel Blob: No token found. Either configure the BLOB_READ_WRITE_TOKEN...

significa que el proyecto no tiene configurado el token de lectura/escritura de Vercel Blob.

En Vercel → Project → Settings → Environment Variables agrega:
  BLOB_READ_WRITE_TOKEN = [token de tu Blob Store]

También deben existir las credenciales administrativas que ya utiliza el panel:
  ADMIN_USER
  ADMIN_PASSWORD

El endpoint acepta ADMIN_PANEL_PASSWORD como respaldo para la contraseña si ese es el nombre que ya usa tu proyecto.

Después de agregar/cambiar variables de entorno, haz un nuevo Deploy para que la función reciba los valores.

NO pongas BLOB_READ_WRITE_TOKEN dentro de admin.html ni en JavaScript del navegador.
