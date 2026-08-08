-- ============================================================
-- supabase-schema.sql
--
-- Ejecutar UNA VEZ en el SQL Editor de tu proyecto de Supabase
-- (https://app.supabase.com -> tu proyecto -> SQL Editor -> New
-- query -> pega esto -> Run).
--
-- Este script NO se ejecuta automáticamente: Vercel no tiene
-- forma de correr migraciones de Supabase por sí solo, y este
-- entorno de desarrollo no tiene acceso de red a supabase.co, así
-- que no fue posible crear ni probar las tablas de forma real.
-- api/_lib/db.js asume que estas 3 tablas existen con estos
-- nombres y columnas exactos.
-- ============================================================

-- Una fila por cada conversación que terminó generando un lead
-- (no se guarda cada conversación del sitio, solo las que llegan
-- a esta etapa).
create table if not exists conversaciones (
  id bigint generated always as identity primary key,
  session_id text not null,
  fecha timestamptz not null default now(),
  idioma text default 'es',
  estado text default 'lead',           -- 'lead' | 'contactado' | 'descartado'
  consentimiento boolean not null default false,
  version_politica text
);

create index if not exists idx_conversaciones_session_id on conversaciones (session_id);

-- El resumen del proyecto que generó JB TECH AI (leadScore +
-- summary estructurado). Un lead siempre pertenece a una conversación.
create table if not exists leads (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references conversaciones (id) on delete cascade,
  proyecto text,
  necesidad text,
  problema text,
  objetivo text,
  solucion_sugerida text,
  lead_score integer,
  estado text default 'nuevo',          -- 'nuevo' | 'en_seguimiento' | 'cerrado'
  fecha timestamptz not null default now()
);

create index if not exists idx_leads_conversation_id on leads (conversation_id);

-- Datos de contacto — SOLO se inserta una fila aquí cuando el
-- usuario autorizó explícitamente el tratamiento de sus datos.
create table if not exists contactos (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references conversaciones (id) on delete cascade,
  nombre text,
  correo text,
  whatsapp text,
  fecha timestamptz not null default now(),
  consentimiento boolean not null default true,
  consentimiento_fecha timestamptz,
  version_politica text
);

create index if not exists idx_contactos_conversation_id on contactos (conversation_id);

-- ------------------------------------------------------------
-- Nota de seguridad: estas tablas se escriben únicamente desde
-- las funciones serverless de Vercel usando la Service Role Key
-- de Supabase (nunca desde el navegador). Si en Supabase tienes
-- Row Level Security (RLS) activado por defecto en tu proyecto,
-- la Service Role Key lo salta automáticamente — no hace falta
-- crear políticas RLS para que esto funcione. Si prefieres
-- activar RLS igual por defensa en profundidad, no crees
-- políticas de INSERT/SELECT públicas: estas tablas no deben ser
-- accesibles desde el cliente bajo ninguna circunstancia.
-- ------------------------------------------------------------
