// ============================================================
// BarberBot SaaS — Servicio de Google Calendar
// ============================================================
import { google } from 'googleapis';

/**
 * Crea un cliente autenticado de Google Calendar con los tokens OAuth del tenant.
 * @param {Object} googleTokens - { access_token, refresh_token, expiry_date }
 * @returns {google.calendar} - cliente de Google Calendar autenticado
 */
const getCalendarClient = (googleTokens) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials(googleTokens);

  // Auto-refresh del token cuando expire
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      console.log('[Calendar] Nuevo refresh_token recibido — actualizar en BD');
      // TODO: guardar tokens actualizados en barbershop.google_tokens
    }
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
};

// ============================================================
// SLOTS DISPONIBLES
// ============================================================

/**
 * Obtiene los horarios disponibles de un barbero en una fecha dada.
 * Compara el horario configurado con las citas ya agendadas.
 * @param {Object} barbershop - datos de la barbería incluyendo google_tokens
 * @param {Object} barber - datos del barbero (schedule, calendar_id)
 * @param {string} date - fecha en formato YYYY-MM-DD
 * @param {number} durationMin - duración del servicio en minutos
 * @returns {Array<string>} - array de horas disponibles en formato HH:MM
 */
export const getAvailableSlots = async (barbershop, barber, date, durationMin = 30) => {
  try {
    if (!barbershop.google_tokens) {
      console.warn('[Calendar] Barbería sin tokens de Google Calendar');
      return [];
    }

    const calendar = getCalendarClient(barbershop.google_tokens);
    const calendarId = barber.calendar_id || barbershop.google_calendar_id || 'primary';

    // Parseamos el horario del barbero para el día de la semana
    const dayNames = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
    const dayOfWeek = dayNames[new Date(date + 'T12:00:00').getDay()];
    const daySchedule = barber.schedule?.[dayOfWeek];

    if (!daySchedule) {
      return []; // el barbero no trabaja ese día
    }

    const [startTime, endTime] = daySchedule; // ej. ["09:00", "18:00"]

    // Obtenemos los eventos del día desde Google Calendar
    const startOfDay = new Date(`${date}T${startTime}:00`);
    const endOfDay = new Date(`${date}T${endTime}:00`);

    const { data } = await calendar.events.list({
      calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const bookedSlots = (data.items || []).map((event) => ({
      start: new Date(event.start.dateTime || event.start.date),
      end: new Date(event.end.dateTime || event.end.date),
    }));

    // Generamos todos los slots posibles del día
    const availableSlots = [];
    const current = new Date(startOfDay);

    while (current < endOfDay) {
      const slotEnd = new Date(current.getTime() + durationMin * 60 * 1000);
      if (slotEnd > endOfDay) break;

      // Verificamos si el slot choca con alguna cita existente
      const isBooked = bookedSlots.some(
        (booked) => current < booked.end && slotEnd > booked.start
      );

      if (!isBooked) {
        availableSlots.push(
          current.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })
        );
      }

      // Avanzamos en intervalos de la duración del servicio
      current.setMinutes(current.getMinutes() + durationMin);
    }

    return availableSlots;
  } catch (err) {
    console.error('[Calendar] Error al obtener slots disponibles:', err.message);
    return [];
  }
};

// ============================================================
// CREAR CITA EN GOOGLE CALENDAR
// ============================================================

/**
 * Crea un evento en Google Calendar para una cita.
 * @param {Object} barbershop - datos de la barbería
 * @param {Object} barber - datos del barbero
 * @param {Object} appointmentData - { clientName, clientPhone, service, datetime, durationMin }
 * @returns {string|null} - ID del evento creado, o null si falla
 */
export const createAppointment = async (barbershop, barber, appointmentData) => {
  try {
    if (!barbershop.google_tokens) {
      console.warn('[Calendar] Barbería sin tokens de Google — cita guardada solo en BD');
      return null;
    }

    const calendar = getCalendarClient(barbershop.google_tokens);
    const calendarId = barber.calendar_id || barbershop.google_calendar_id || 'primary';

    const startDateTime = new Date(appointmentData.datetime);
    const endDateTime = new Date(
      startDateTime.getTime() + (appointmentData.durationMin || 30) * 60 * 1000
    );

    const event = {
      summary: `${appointmentData.service} — ${appointmentData.clientName || appointmentData.clientPhone}`,
      description: [
        `Barbero: ${barber.name}`,
        `Servicio: ${appointmentData.service}`,
        `Cliente: ${appointmentData.clientName || 'Sin nombre'} (${appointmentData.clientPhone})`,
        `Agendado por BarberBot`,
      ].join('\n'),
      start: { dateTime: startDateTime.toISOString(), timeZone: 'America/Mexico_City' },
      end: { dateTime: endDateTime.toISOString(), timeZone: 'America/Mexico_City' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
        ],
      },
    };

    const { data } = await calendar.events.insert({ calendarId, requestBody: event });

    console.log(`[Calendar] Evento creado: ${data.id} para ${appointmentData.clientPhone}`);
    return data.id;
  } catch (err) {
    console.error('[Calendar] Error al crear cita en Google Calendar:', err.message);
    return null; // no crítico — la cita igual se guarda en Supabase
  }
};

// ============================================================
// CANCELAR CITA EN GOOGLE CALENDAR
// ============================================================

/**
 * Elimina un evento de Google Calendar al cancelar una cita.
 * @param {Object} barbershop - datos de la barbería
 * @param {string} googleEventId - ID del evento en Google Calendar
 * @returns {boolean} - true si se eliminó correctamente
 */
export const cancelAppointment = async (barbershop, googleEventId) => {
  try {
    if (!barbershop.google_tokens || !googleEventId) return false;

    const calendar = getCalendarClient(barbershop.google_tokens);
    const calendarId = barbershop.google_calendar_id || 'primary';

    await calendar.events.delete({ calendarId, eventId: googleEventId });

    console.log(`[Calendar] Evento ${googleEventId} eliminado`);
    return true;
  } catch (err) {
    console.error('[Calendar] Error al cancelar evento:', err.message);
    return false;
  }
};
