// ============================================================
// BarberBot SaaS — Servicio de Claude AI
// ============================================================
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Modelo actualizado — claude-sonnet-4-6 es el Sonnet más reciente
const MODEL = 'claude-sonnet-4-6';

// Intenciones detectables
export const INTENCIONES = {
  RESERVA: 'RESERVA',
  CANCELAR: 'CANCELAR',
  CONSULTA: 'CONSULTA',
  SALUDO: 'SALUDO',
  DESCONOCIDO: 'DESCONOCIDO',
};

// ============================================================
// SYSTEM PROMPT PARA EL BOT DE BARBERÍA
// ============================================================

/**
 * Construye el system prompt con el contexto específico de la barbería.
 * @param {Object} barbershop - datos de la barbería
 * @param {Array} barbers - lista de barberos disponibles
 * @returns {string} - system prompt completo
 */
const buildSystemPrompt = (barbershop, barbers) => {
  const settings = barbershop.settings || {};
  const servicios = settings.services?.join(', ') || 'corte de cabello, barba, degradado';
  const horario = settings.schedule || 'Lunes a Sábado de 9:00 a 20:00';
  const barberosTexto = barbers.length > 0
    ? barbers.map((b) => `${b.name} (${b.services?.join(', ') || 'todos los servicios'})`).join(', ')
    : 'todos nuestros barberos están disponibles';

  return `Eres el asistente virtual de WhatsApp de "${barbershop.name}", una barbería profesional.
Tu trabajo es ayudar a los clientes a agendar, cancelar o consultar citas, y responder preguntas sobre los servicios.

INFORMACIÓN DE LA BARBERÍA:
- Nombre: ${barbershop.name}
- Servicios: ${servicios}
- Horario: ${horario}
- Barberos disponibles: ${barberosTexto}

INSTRUCCIONES DE COMPORTAMIENTO:
1. Responde SIEMPRE en español, de forma natural y amigable, como si fuera un mensaje de WhatsApp real.
2. Tus respuestas deben tener máximo 2-3 líneas. Sin markdown, sin asteriscos, sin emojis excesivos.
3. Si el cliente quiere agendar una cita, pregunta en este orden (UNA pregunta a la vez):
   a) ¿Qué servicio desea? (si no lo mencionó)
   b) ¿Con qué barbero? (si hay más de uno)
   c) ¿Para qué día y hora?
4. Cuando tengas servicio + barbero + fecha/hora, confirma los datos antes de guardar.
5. Si el cliente pide cancelar, pide que confirme qué cita quiere cancelar.
6. Si no entiendes el mensaje o está fuera de tu alcance, di amablemente que solo puedes ayudar con citas.
7. Nunca inventes horarios disponibles que no te hayan sido confirmados.

Al final de cada respuesta, incluye en una nueva línea sin que el cliente lo vea:
[INTENCION:RESERVA|CANCELAR|CONSULTA|SALUDO|DESCONOCIDO]`;
};

// ============================================================
// FUNCIÓN PRINCIPAL DE PROCESAMIENTO
// ============================================================

/**
 * Procesa la conversación con Claude AI y retorna la respuesta + intención detectada.
 * @param {Array} conversationHistory - historial de mensajes { role, content }
 * @param {string} newMessage - mensaje nuevo del cliente
 * @param {Object} barbershop - datos de la barbería (tenant)
 * @param {Array} barbers - lista de barberos de la barbería
 * @returns {{ response: string, intention: string, updatedHistory: Array }}
 */
export const processConversation = async (conversationHistory, newMessage, barbershop, barbers = []) => {
  try {
    // Construimos el historial en formato Anthropic
    const messages = [
      ...conversationHistory,
      { role: 'user', content: newMessage },
    ];

    const apiResponse = await client.messages.create({
      model: MODEL,
      max_tokens: 300, // respuestas cortas para WhatsApp
      system: buildSystemPrompt(barbershop, barbers),
      messages,
    });

    const fullResponse = apiResponse.content[0]?.text || 'Lo siento, ocurrió un error. Intenta de nuevo.';

    // Extraemos la intención del marcador oculto al final de la respuesta
    const intentionMatch = fullResponse.match(/\[INTENCION:(RESERVA|CANCELAR|CONSULTA|SALUDO|DESCONOCIDO)\]/);
    const intention = intentionMatch ? intentionMatch[1] : INTENCIONES.DESCONOCIDO;

    // Limpiamos la respuesta quitando el marcador de intención
    const cleanResponse = fullResponse
      .replace(/\[INTENCION:[^\]]+\]/g, '')
      .trim();

    // Actualizamos el historial con el nuevo intercambio
    const updatedHistory = [
      ...messages,
      { role: 'assistant', content: cleanResponse },
    ];

    // Limitamos el historial a los últimos 20 mensajes para no exceder tokens
    const trimmedHistory = updatedHistory.slice(-20);

    console.log(`[AI] Intención detectada: ${intention} | Respuesta: "${cleanResponse.substring(0, 60)}..."`);

    return {
      response: cleanResponse,
      intention,
      updatedHistory: trimmedHistory,
    };
  } catch (err) {
    console.error('[AI] Error al procesar conversación con Claude:', err.message);

    // Respuesta de fallback en caso de error
    return {
      response: 'Disculpa, tuve un problema técnico. ¿Puedes intentarlo de nuevo en un momento?',
      intention: INTENCIONES.DESCONOCIDO,
      updatedHistory: conversationHistory,
    };
  }
};

// ============================================================
// DETECCIÓN RÁPIDA DE INTENCIÓN (sin historial, para cron jobs)
// ============================================================

/**
 * Detecta la intención de un mensaje de forma rápida y liviana.
 * Útil para clasificar mensajes sin necesitar el historial completo.
 * @param {string} message - texto del mensaje
 * @returns {string} - una de las INTENCIONES
 */
export const detectIntention = async (message) => {
  const lower = message.toLowerCase();

  // Detección rápida por palabras clave antes de llamar a la API
  if (/hola|buenos|buenas|saludos|hey/.test(lower)) return INTENCIONES.SALUDO;
  if (/cancelar|cancel|anular/.test(lower)) return INTENCIONES.CANCELAR;
  if (/cita|reserv|agendar|turno|horario|disponible|cuando/.test(lower)) return INTENCIONES.RESERVA;
  if (/precio|cuánto|cuanto|servicio|hacen|ofrecen/.test(lower)) return INTENCIONES.CONSULTA;

  return INTENCIONES.DESCONOCIDO;
};
