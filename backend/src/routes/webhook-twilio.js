// ============================================================
// BarberBot SaaS — Webhook de Twilio WhatsApp (para demos)
// POST /webhook/twilio → recibe mensajes del sandbox de Twilio
// ============================================================
import { Router } from 'express';
import twilio from 'twilio';
import { processConversation, extractAppointmentData, INTENCIONES } from '../services/ai.js';
import {
  getBarbershopByPhoneId,
  getOrCreateClient,
  getConversationHistory,
  saveConversationHistory,
  getBarbers,
  saveAppointment,
} from '../db/supabase.js';

const router = Router();

// Cliente Twilio para enviar mensajes
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Envía un mensaje de WhatsApp via Twilio.
 * @param {string} to - número destino (ej. 'whatsapp:+573187474092')
 * @param {string} body - texto del mensaje
 */
const sendTwilioMessage = async (to, body) => {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
  console.log(`[Twilio] Mensaje enviado a ${to}: "${body.substring(0, 60)}..."`);
};

// ============================================================
// POST /webhook/twilio
// ============================================================
router.post('/', async (req, res) => {
  // Twilio espera respuesta TwiML — respondemos vacío para no auto-responder
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  // Procesamos el mensaje en background
  processTwilioMessage(req.body).catch((err) => {
    console.error('[Twilio] Error en procesamiento:', err.message);
  });
});

const processTwilioMessage = async (body) => {
  // Twilio envía: From=whatsapp:+573187474092, Body=hola
  const fromRaw     = body.From || '';  // 'whatsapp:+573187474092'
  const messageText = (body.Body || '').trim();
  const clientPhone = fromRaw.replace('whatsapp:', '');

  if (!messageText || !clientPhone) return;

  console.log(`[Twilio] Mensaje de ${clientPhone}: "${messageText}"`);

  // Usamos la barbería demo — en producción se mapea por número Twilio
  const { data: barbershop } = await (await import('../db/supabase.js')).default
    .from('barbershops')
    .select('*')
    .eq('whatsapp_phone_id', process.env.DEMO_BARBERSHOP_PHONE_ID || '1161803967005242')
    .eq('active', true)
    .single();

  if (!barbershop) {
    console.error('[Twilio] Barbería demo no encontrada');
    return;
  }

  // Reutilizamos toda la lógica existente
  const client             = await getOrCreateClient(barbershop.id, clientPhone);
  const conversationHistory = await getConversationHistory(barbershop.id, clientPhone);
  const barbers            = await getBarbers(barbershop.id);

  const { response, intention, updatedHistory } = await processConversation(
    conversationHistory,
    messageText,
    barbershop,
    barbers
  );

  await saveConversationHistory(barbershop.id, clientPhone, updatedHistory);

  // Enviamos la respuesta via Twilio
  await sendTwilioMessage(fromRaw, response);

  // Flujo de reserva si aplica
  if (intention === INTENCIONES.RESERVA) {
    const CONFIRMATION_KEYWORDS = ['confirmado', 'agendado', 'reservado', 'quedó agendad', 'te esperamos'];
    const lastBotMsg = [...updatedHistory].reverse()
      .find((m) => m.role === 'assistant')?.content?.toLowerCase() || '';
    const isConfirmed = CONFIRMATION_KEYWORDS.some((kw) => lastBotMsg.includes(kw));

    if (isConfirmed) {
      const appointmentData = await extractAppointmentData(updatedHistory, barbers, 'America/Bogota');
      if (appointmentData?.isComplete) {
        const barber = barbers.find(
          (b) => b.id === appointmentData.barberId ||
                 b.name.toLowerCase() === appointmentData.barberName?.toLowerCase()
        );
        if (barber) {
          await saveAppointment({
            barbershop_id: barbershop.id,
            client_id:     client.id,
            barber_id:     barber.id,
            service:       appointmentData.service,
            datetime:      new Date(appointmentData.datetime).toISOString(),
            status:        'confirmed',
          });

          const fechaFormateada = new Date(appointmentData.datetime).toLocaleString('es-CO', {
            timeZone: 'America/Bogota', weekday: 'long', day: 'numeric',
            month: 'long', hour: '2-digit', minute: '2-digit',
          });

          await sendTwilioMessage(
            fromRaw,
            `✅ Cita confirmada: ${appointmentData.service} con ${barber.name} el ${fechaFormateada}. ¡Te esperamos!`
          );

          await saveConversationHistory(barbershop.id, clientPhone, []);
          console.log(`[Twilio] Cita guardada para ${clientPhone}`);
        }
      }
    }
  }
};

export default router;
