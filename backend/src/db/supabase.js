// ============================================================
// BarberBot SaaS — Cliente Supabase y Queries Multi-Tenant
// ============================================================
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';

// Node 18 no tiene WebSocket nativo — usamos el paquete 'ws' como polyfill.
// En Node 20+ esto no es necesario pero no causa daño.
const require = createRequire(import.meta.url);
let ws;
try {
  ws = require('ws');
} catch {
  ws = undefined; // Node 20+ tiene WebSocket nativo, no necesita el paquete
}

// --- Cliente Supabase (singleton) ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // service role para operaciones del backend
  ws ? { realtime: { transport: ws } } : {}
);

export default supabase;

// ============================================================
// SQL PARA CREAR LAS TABLAS EN SUPABASE
// Ejecuta esto en el SQL Editor de tu proyecto Supabase
// ============================================================
/*
-- Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tabla: barbershops (una fila por barbería cliente)
CREATE TABLE barbershops (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL,
  whatsapp_number     TEXT NOT NULL UNIQUE, -- número desde el que se envían mensajes (+521...)
  whatsapp_phone_id   TEXT NOT NULL UNIQUE, -- Phone Number ID de Meta
  google_calendar_id  TEXT,                 -- ID del calendario de Google
  google_tokens       JSONB,                -- tokens OAuth de Google (access + refresh)
  settings            JSONB DEFAULT '{}',   -- config flexible: horario, servicios, etc.
  stripe_customer_id  TEXT,
  plan                TEXT DEFAULT 'trial', -- trial | basic | pro
  active              BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla: barbers (barberos de cada barbería)
CREATE TABLE barbers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  barbershop_id   UUID NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  services        TEXT[] DEFAULT '{}',    -- ['corte', 'barba', 'degradado']
  schedule        JSONB DEFAULT '{}',     -- { "lun": ["09:00","18:00"], ... }
  calendar_id     TEXT,                   -- calendario individual del barbero en Google
  active          BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_barbers_barbershop ON barbers(barbershop_id);

-- Tabla: clients (clientes de cada barbería — aislados por tenant)
CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  barbershop_id   UUID NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,          -- número WhatsApp normalizado (+521...)
  name            TEXT,
  birthdate       DATE,
  last_visit      TIMESTAMPTZ,
  visit_count     INT DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(barbershop_id, phone)            -- un cliente no se repite dentro de la misma barbería
);
CREATE INDEX idx_clients_barbershop ON clients(barbershop_id);
CREATE INDEX idx_clients_phone ON clients(barbershop_id, phone);

-- Tabla: appointments (citas)
CREATE TABLE appointments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  barbershop_id   UUID NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES clients(id),
  barber_id       UUID NOT NULL REFERENCES barbers(id),
  service         TEXT NOT NULL,
  datetime        TIMESTAMPTZ NOT NULL,
  duration_min    INT DEFAULT 30,
  status          TEXT DEFAULT 'pending', -- pending | confirmed | cancelled | completed
  google_event_id TEXT,                   -- ID del evento en Google Calendar
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_appointments_barbershop ON appointments(barbershop_id);
CREATE INDEX idx_appointments_datetime ON appointments(barbershop_id, datetime);
CREATE INDEX idx_appointments_status ON appointments(barbershop_id, status);

-- Tabla: conversations (historial de chat por cliente)
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  barbershop_id   UUID NOT NULL REFERENCES barbershops(id) ON DELETE CASCADE,
  client_phone    TEXT NOT NULL,
  messages        JSONB DEFAULT '[]',     -- array de { role, content, timestamp }
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(barbershop_id, client_phone)
);
CREATE INDEX idx_conversations_barbershop ON conversations(barbershop_id);
CREATE INDEX idx_conversations_phone ON conversations(barbershop_id, client_phone);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Row Level Security (RLS) — habilitar para producción
ALTER TABLE barbershops ENABLE ROW LEVEL SECURITY;
ALTER TABLE barbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
*/

// ============================================================
// FUNCIONES DE BASE DE DATOS
// TODOS los queries filtran por barbershop_id (multi-tenant)
// ============================================================

/**
 * Obtiene la barbería por su número de WhatsApp destino.
 * El número destino del mensaje entrante identifica al tenant.
 * @param {string} whatsappPhoneId - Phone Number ID de Meta
 * @returns {Object|null} - datos de la barbería o null si no existe
 */
export const getBarbershopByPhoneId = async (whatsappPhoneId) => {
  try {
    const { data, error } = await supabase
      .from('barbershops')
      .select('*')
      .eq('whatsapp_phone_id', whatsappPhoneId)
      .eq('active', true)
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[DB] Error al obtener barbería por phone_id:', err.message);
    return null;
  }
};

/**
 * Obtiene o crea un cliente por su número de teléfono dentro de una barbería.
 * @param {string} barbershopId - ID de la barbería (tenant)
 * @param {string} phone - número de teléfono del cliente
 * @returns {Object} - datos del cliente
 */
export const getOrCreateClient = async (barbershopId, phone) => {
  try {
    // Intentar obtener cliente existente
    const { data: existing } = await supabase
      .from('clients')
      .select('*')
      .eq('barbershop_id', barbershopId)
      .eq('phone', phone)
      .single();

    if (existing) return existing;

    // Crear nuevo cliente si no existe
    const { data: newClient, error } = await supabase
      .from('clients')
      .insert({ barbershop_id: barbershopId, phone })
      .select()
      .single();

    if (error) throw error;
    return newClient;
  } catch (err) {
    console.error('[DB] Error en getOrCreateClient:', err.message);
    throw err;
  }
};

/**
 * Obtiene el historial de conversación de un cliente en una barbería.
 * @param {string} barbershopId - ID de la barbería (tenant)
 * @param {string} clientPhone - número de teléfono del cliente
 * @returns {Array} - array de mensajes { role, content, timestamp }
 */
export const getConversationHistory = async (barbershopId, clientPhone) => {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('messages')
      .eq('barbershop_id', barbershopId)
      .eq('client_phone', clientPhone)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows found
    return data?.messages || [];
  } catch (err) {
    console.error('[DB] Error al obtener historial de conversación:', err.message);
    return [];
  }
};

/**
 * Guarda o actualiza el historial de conversación (upsert).
 * @param {string} barbershopId - ID de la barbería (tenant)
 * @param {string} clientPhone - número de teléfono del cliente
 * @param {Array} messages - historial completo de mensajes
 */
export const saveConversationHistory = async (barbershopId, clientPhone, messages) => {
  try {
    const { error } = await supabase
      .from('conversations')
      .upsert(
        { barbershop_id: barbershopId, client_phone: clientPhone, messages },
        { onConflict: 'barbershop_id,client_phone' }
      );

    if (error) throw error;
  } catch (err) {
    console.error('[DB] Error al guardar conversación:', err.message);
    throw err;
  }
};

/**
 * Obtiene todos los barberos activos de una barbería.
 * @param {string} barbershopId - ID de la barbería (tenant)
 * @returns {Array} - lista de barberos
 */
export const getBarbers = async (barbershopId) => {
  try {
    const { data, error } = await supabase
      .from('barbers')
      .select('*')
      .eq('barbershop_id', barbershopId)
      .eq('active', true)
      .order('name');

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[DB] Error al obtener barberos:', err.message);
    return [];
  }
};

/**
 * Guarda una cita nueva.
 * @param {Object} appointment - datos de la cita
 * @returns {Object} - cita creada
 */
export const saveAppointment = async (appointment) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .insert(appointment)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('[DB] Error al guardar cita:', err.message);
    throw err;
  }
};

/**
 * Obtiene las citas de un barbero en un rango de fechas.
 * @param {string} barbershopId - ID de la barbería (tenant)
 * @param {string} barberId - ID del barbero
 * @param {string} dateStart - fecha inicio ISO
 * @param {string} dateEnd - fecha fin ISO
 * @returns {Array} - lista de citas
 */
export const getAppointmentsByBarber = async (barbershopId, barberId, dateStart, dateEnd) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('barbershop_id', barbershopId)
      .eq('barber_id', barberId)
      .gte('datetime', dateStart)
      .lte('datetime', dateEnd)
      .neq('status', 'cancelled')
      .order('datetime');

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[DB] Error al obtener citas del barbero:', err.message);
    return [];
  }
};

/**
 * Actualiza el last_visit y visit_count de un cliente.
 * @param {string} clientId - ID del cliente
 */
export const updateClientLastVisit = async (clientId) => {
  try {
    const { error } = await supabase
      .from('clients')
      .update({ last_visit: new Date().toISOString() })
      .eq('id', clientId);

    if (error) throw error;
  } catch (err) {
    console.error('[DB] Error al actualizar last_visit:', err.message);
  }
};
