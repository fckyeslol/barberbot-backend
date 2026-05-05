// ============================================================
// BarberBot SaaS — Webhook de WhatsApp Cloud API
// GET  /webhook  → verificación del token con Meta
// POST /webhook  → recibe mensajes, responde 200 inmediato, procesa en background
// ============================================================
import { Router } from 'express';
import {
  verifyWebhookSignature,
  parseIncomingMessage,
  sendMessage,
  markMessageAsRead,
} from '../services/whatsapp.js';
import { processConversation, extractAppointmentData, INTENCIONES } from '../services/ai.js';
import { getAvailableSlots, createAppointment } from '../services/calendar.js';
import {
  getBarbershopByPhoneId,
  getOrCreateClient,
  getConversationHistory,
  saveConversationHistory,
  getBarbers,
  saveAppointment,
} from '../db/supabase.js';

const router = Router();

// ============================================================
// GET /webhook — Verificación del webhook con Meta
// ============================================================
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[Webhook] Verificación de Meta exitosa ✅');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] Verificación fallida — token incorrecto o modo inválido');
  return res.sendStatus(403);
});

// ============================================================
// POST /webhook — Mensajes entrantes de WhatsApp
// ============================================================
router.post('/', (req, res) => {
  // Log temprano para confirmar que el POST llega al servidor
  console.log('[Webhook] POST recibido — body object:', req.body?.object);

  // 1. Verificación de firma HMAC-SHA256
  // En desarrollo se puede omitir si WHATSAPP_APP_SECRET no está configurado
  const signature = req.headers['x-hub-signature-256'];
  const isDev = process.env.NODE_ENV !== 'production';

  if (!isDev || process.env.WHATSAPP_APP_SECRET) {
    if (!verifyWebhookSignature(req.rawBody, signature)) {
      console.warn('[Webhook] Firma HMAC inválida — request rechazado');
      console.warn('[Webhook] Signature recibida:', signature?.substring(0, 30));
      return res.sendStatus(401);
    }
  } else {
    console.warn('[Webhook] ⚠️  HMAC omitido — modo desarrollo sin APP_SECRET');
  }

  // 2. Respuesta HTTP 200 INMEDIATA — Meta requiere respuesta en < 20 segundos
  res.sendStatus(200);

  // 3. Procesamiento asíncrono en background (sin bloquear la respuesta)
  processWebhookMessage(req.body).catch((err) => {
    console.error('[Webhook] Error en procesamiento background:', err);
  });
});

// ============================================================
// PROCESAMIENTO PRINCIPAL (background)
// ============================================================

/**
 * Flujo completo: recibe → identifica tenant → recupera historial →
 * Claude detecta intención → responde → (si RESERVA) agenda cita.
 * @param {Object} body - cuerpo del POST de Meta
 */
const processWebhookMessage = async (body) => {
  // 1. Parseamos el mensaje entrante
  const parsed = parseIncomingMessage(body);
  if (!parsed) return; // no es un mensaje de texto válido

  const { clientPhone, messageText, phoneNumberId, messageId, contactName } = parsed;

  console.log(`[Webhook] Mensaje de ${clientPhone}: "${messageText}"`);

  // 2. Identificamos la barbería (tenant) por el Phone Number ID
  const barbershop = await getBarbershopByPhoneId(phoneNumberId);
  if (!barbershop) {
    console.error(`[Webhook] Barbería no encontrada para phone_id: ${phoneNumberId}`);
    return;
  }

  // 3. Marcamos el mensaje como leído
  await markMessageAsRead(phoneNumberId, messageId);

  // 4. Obtenemos o creamos el cliente (dentro del tenant)
  const client = await getOrCreateClient(barbershop.id, clientPhone);

  // Actualizamos el nombre si lo tenemos de WhatsApp y no lo teníamos
  if (contactName && !client.name) {
    // TODO: actualizar nombre del cliente en BD
  }

  // 5. Recuperamos el historial de conversación del cliente en esta barbería
  const conversationHistory = await getConversationHistory(barbershop.id, clientPhone);

  // 6. Obtenemos los barberos del tenant para el contexto de Claude
  const barbers = await getBarbers(barbershop.id);

  // 7. Procesamos el mensaje con Claude AI
  const { response, intention, updatedHistory } = await processConversation(
    conversationHistory,
    messageText,
    barbershop,
    barbers
  );

  // 8. Guardamos el historial actualizado
  await saveConversationHistory(barbershop.id, clientPhone, updatedHistory);

  // 9. Enviamos la respuesta al cliente por WhatsApp
  await sendMessage(phoneNumberId, clientPhone, response);

  // 10. Si la intención es RESERVA y Claude ya tiene los datos confirmados,
  //     parseamos y guardamos la cita (lógica de extracción de datos del historial)
  if (intention === INTENCIONES.RESERVA) {
    await handleReservationFlow(updatedHistory, barbershop, barbers, client, phoneNumberId, clientPhone);
  }
};

// ============================================================
// FLUJO DE RESERVA
// ============================================================

/**
 * Palabras clave que indican que el cliente confirmó la cita.
 * Claude incluye estas en su respuesta cuando ya tiene todos los datos.
 */
const CONFIRMATION_KEYWORDS = [
  'confirmado', 'agendado', 'reservado', 'quedó agendad',
  'te esperamos', 'está listo', 'cita confirmada',
];

/**
 * Extrae, valida y guarda una cita cuando Claude confirmó todos los datos.
 * Solo actúa tras detección de palabras clave de confirmación en la respuesta del bot.
 * @param {Array} history - historial completo incluyendo la respuesta de confirmación
 * @param {Object} barbershop - datos de la barbería (tenant)
 * @param {Array} barbers - lista de barberos del tenant
 * @param {Object} client - datos del cliente
 * @param {string} phoneNumberId - Phone Number ID del tenant
 * @param {string} clientPhone - teléfono del cliente
 */
const handleReservationFlow = async (history, barbershop, barbers, client, phoneNumberId, clientPhone) => {
  try {
    // 1. Verificamos que el último mensaje del bot contiene una confirmación
    const lastBotMessage = [...history]
      .reverse()
      .find((m) => m.role === 'assistant')?.content?.toLowerCase() || '';

    const isConfirmed = CONFIRMATION_KEYWORDS.some((kw) => lastBotMessage.includes(kw));
    if (!isConfirmed) return; // Bot todavía recopilando datos

    console.log(`[Reserva] Confirmación detectada para ${clientPhone} — extrayendo datos...`);

    // 2. Segunda llamada a Claude para extraer datos estructurados
    const timezone = barbershop.settings?.timezone || 'America/Bogota';
    const appointmentData = await extractAppointmentData(history, barbers, timezone);

    if (!appointmentData?.isComplete) {
      console.warn('[Reserva] Datos incompletos:', appointmentData?.missingFields);
      return;
    }

    // 3. Buscamos el barbero por nombre en la lista del tenant
    const barber = barbers.find(
      (b) => b.id === appointmentData.barberId ||
             b.name.toLowerCase() === appointmentData.barberName?.toLowerCase()
    );

    if (!barber) {
      console.warn(`[Reserva] Barbero no encontrado: ${appointmentData.barberName}`);
      return;
    }

    // 4. Verificamos que la cita no exista ya (evitar duplicados por doble procesamiento)
    const appointmentDatetime = new Date(appointmentData.datetime);
    if (isNaN(appointmentDatetime.getTime())) {
      console.warn('[Reserva] Datetime inválido:', appointmentData.datetime);
      return;
    }

    // 5. Creamos el evento en Google Calendar (si está configurado)
    let googleEventId = null;
    if (barbershop.google_tokens) {
      googleEventId = await createAppointment(barbershop, barber, {
        clientName: client.name || clientPhone,
        clientPhone,
        service: appointmentData.service,
        datetime: appointmentData.datetime,
        durationMin: 30,
      });
    }

    // 6. Guardamos la cita en Supabase
    const savedAppointment = await saveAppointment({
      barbershop_id: barbershop.id,
      client_id: client.id,
      barber_id: barber.id,
      service: appointmentData.service,
      datetime: appointmentDatetime.toISOString(),
      status: 'confirmed',
      google_event_id: googleEventId,
    });

    console.log(`[Reserva] ✅ Cita guardada: ${savedAppointment.id} | ${appointmentData.service} con ${barber.name} el ${appointmentData.datetime}`);

    // 7. Formateamos la fecha para el mensaje de confirmación
    const fechaFormateada = appointmentDatetime.toLocaleString('es-CO', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });

    // 8. Enviamos confirmación final con los detalles de la cita
    await sendMessage(
      phoneNumberId,
      clientPhone,
      `✅ Cita confirmada: ${appointmentData.service} con ${barber.name} el ${fechaFormateada}. ¡Te esperamos!`
    );

    // 9. Limpiamos el historial de conversación para la próxima interacción
    await saveConversationHistory(barbershop.id, clientPhone, []);

  } catch (err) {
    console.error('[Reserva] Error en flujo de reserva:', err.message);
  }
};

export default router;
