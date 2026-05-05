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
import { processConversation, INTENCIONES } from '../services/ai.js';
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
 * Intenta extraer y guardar una cita cuando Claude detecta intención RESERVA.
 * Solo actúa si puede extraer servicio + barbero + fecha/hora confirmados.
 * @param {Array} history - historial completo de la conversación
 * @param {Object} barbershop - datos de la barbería
 * @param {Array} barbers - lista de barberos
 * @param {Object} client - datos del cliente
 * @param {string} phoneNumberId - Phone Number ID del tenant
 * @param {string} clientPhone - teléfono del cliente
 */
const handleReservationFlow = async (history, barbershop, barbers, client, phoneNumberId, clientPhone) => {
  try {
    // Buscamos en el historial si el último mensaje del asistente confirma los datos
    const lastAssistantMessage = [...history]
      .reverse()
      .find((m) => m.role === 'assistant')?.content || '';

    // Palabras clave que indican confirmación explícita de la cita
    const confirmationKeywords = ['confirmado', 'agendado', 'reservado', 'listo', 'perfecto, te espero'];
    const isConfirmed = confirmationKeywords.some((kw) =>
      lastAssistantMessage.toLowerCase().includes(kw)
    );

    if (!isConfirmed) return; // Claude sigue recopilando datos, no guardamos aún

    // TODO: implementar extracción estructurada de datos de la cita desde el historial
    // usando una llamada adicional a Claude con output estructurado (JSON).
    // Por ahora registramos en logs que se detectó una confirmación.
    console.log(`[Webhook] Confirmación de reserva detectada para cliente ${clientPhone} en ${barbershop.name}`);

    // Ejemplo de estructura para saveAppointment (se completa con extracción real):
    /*
    const appointmentData = await extractAppointmentData(history, barbers);
    if (!appointmentData) return;

    const googleEventId = await createAppointment(barbershop, appointmentData.barber, {
      clientName: client.name,
      clientPhone: client.phone,
      service: appointmentData.service,
      datetime: appointmentData.datetime,
      durationMin: 30,
    });

    await saveAppointment({
      barbershop_id: barbershop.id,
      client_id: client.id,
      barber_id: appointmentData.barber.id,
      service: appointmentData.service,
      datetime: appointmentData.datetime,
      status: 'confirmed',
      google_event_id: googleEventId,
    });

    await sendMessage(phoneNumberId, clientPhone,
      `✅ Cita confirmada: ${appointmentData.service} con ${appointmentData.barber.name} el ${appointmentData.datetimeFormatted}`
    );
    */
  } catch (err) {
    console.error('[Webhook] Error en flujo de reserva:', err.message);
  }
};

export default router;
