// ============================================================
// BarberBot SaaS — Servicio de WhatsApp Cloud API
// ============================================================
import crypto from 'crypto';

const WHATSAPP_API_VERSION = 'v20.0';
const WHATSAPP_API_BASE = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

// ============================================================
// VERIFICACIÓN DE FIRMA HMAC-SHA256
// ============================================================

/**
 * Verifica que el webhook realmente viene de Meta usando HMAC-SHA256.
 * @param {Buffer} rawBody - cuerpo crudo del request
 * @param {string} signature - valor del header X-Hub-Signature-256
 * @returns {boolean}
 */
export const verifyWebhookSignature = (rawBody, signature) => {
  if (!signature || !process.env.WHATSAPP_APP_SECRET) return false;

  // Meta envía el header como "sha256=<hash>"
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(rawBody)
    .digest('hex')}`;

  // Comparación segura para evitar timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
};

// ============================================================
// PARSING DEL MENSAJE ENTRANTE
// ============================================================

/**
 * Extrae los datos relevantes de un webhook de WhatsApp.
 * @param {Object} body - cuerpo del POST de Meta
 * @returns {Object|null} - { clientPhone, messageText, phoneNumberId, messageId } o null si no hay mensaje de texto
 */
export const parseIncomingMessage = (body) => {
  try {
    // Navegamos la estructura anidada de Meta
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Solo procesamos mensajes entrantes (no status updates)
    const message = value?.messages?.[0];
    if (!message) return null;

    // Solo procesamos mensajes de texto por ahora
    if (message.type !== 'text') {
      console.log(`[WhatsApp] Tipo de mensaje ignorado: ${message.type}`);
      return null;
    }

    return {
      clientPhone: message.from,                   // número del cliente que escribe
      messageText: message.text?.body?.trim() || '',
      phoneNumberId: value?.metadata?.phone_number_id, // identifica la barbería (tenant)
      messageId: message.id,
      timestamp: message.timestamp,
      contactName: value?.contacts?.[0]?.profile?.name || null,
    };
  } catch (err) {
    console.error('[WhatsApp] Error al parsear mensaje entrante:', err.message);
    return null;
  }
};

// ============================================================
// ENVÍO DE MENSAJES
// ============================================================

/**
 * Envía un mensaje de texto al cliente vía WhatsApp Cloud API.
 * @param {string} phoneNumberId - Phone Number ID de la barbería (tenant)
 * @param {string} to - número del destinatario
 * @param {string} text - texto a enviar
 * @returns {Object} - respuesta de la API de Meta
 */
export const sendMessage = async (phoneNumberId, to, text) => {
  try {
    const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[WhatsApp] Error de API:', data);
      throw new Error(data?.error?.message || 'Error al enviar mensaje de WhatsApp');
    }

    console.log(`[WhatsApp] Mensaje enviado a ${to}: "${text.substring(0, 50)}..."`);
    return data;
  } catch (err) {
    console.error('[WhatsApp] Error al enviar mensaje:', err.message);
    throw err;
  }
};

/**
 * Marca un mensaje como leído (read receipt).
 * @param {string} phoneNumberId - Phone Number ID de la barbería
 * @param {string} messageId - ID del mensaje a marcar como leído
 */
export const markMessageAsRead = async (phoneNumberId, messageId) => {
  try {
    const url = `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`;

    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    // No crítico — no relanzamos el error
    console.error('[WhatsApp] Error al marcar mensaje como leído:', err.message);
  }
};
