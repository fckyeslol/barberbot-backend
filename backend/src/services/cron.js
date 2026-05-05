// ============================================================
// BarberBot SaaS — Cron Jobs de Recordatorios y Automatizaciones
// ============================================================
import cron from 'node-cron';
import supabase from '../db/supabase.js';
import { sendMessage } from './whatsapp.js';

// ============================================================
// HELPERS
// ============================================================

/**
 * Obtiene todas las barberías activas con su phone_number_id.
 * @returns {Array} - lista de barberías
 */
const getActiveBarbershops = async () => {
  const { data, error } = await supabase
    .from('barbershops')
    .select('id, name, whatsapp_phone_id, settings')
    .eq('active', true);

  if (error) {
    console.error('[Cron] Error al obtener barberías:', error.message);
    return [];
  }
  return data || [];
};

/**
 * Obtiene las citas confirmadas próximas en una ventana de tiempo.
 * @param {string} barbershopId - ID de la barbería (tenant)
 * @param {string} fromISO - inicio de la ventana (ISO)
 * @param {string} toISO - fin de la ventana (ISO)
 * @returns {Array} - citas con datos del cliente y barbero
 */
const getUpcomingAppointments = async (barbershopId, fromISO, toISO) => {
  const { data, error } = await supabase
    .from('appointments')
    .select(`
      id,
      service,
      datetime,
      status,
      reminder_24h_sent,
      reminder_2h_sent,
      clients ( phone, name ),
      barbers ( name )
    `)
    .eq('barbershop_id', barbershopId)
    .eq('status', 'confirmed')
    .gte('datetime', fromISO)
    .lte('datetime', toISO);

  if (error) {
    console.error('[Cron] Error al obtener citas:', error.message);
    return [];
  }
  return data || [];
};

/**
 * Marca un recordatorio como enviado para evitar duplicados.
 * @param {string} appointmentId - ID de la cita
 * @param {'24h'|'2h'} type - tipo de recordatorio
 */
const markReminderSent = async (appointmentId, type) => {
  const field = type === '24h' ? 'reminder_24h_sent' : 'reminder_2h_sent';
  const { error } = await supabase
    .from('appointments')
    .update({ [field]: true })
    .eq('id', appointmentId);

  if (error) console.error(`[Cron] Error al marcar recordatorio ${type}:`, error.message);
};

/**
 * Formatea un datetime para mensajes en español.
 * @param {string} isoString - fecha en formato ISO
 * @param {string} timezone - zona horaria
 * @returns {string} - ej. "mañana martes 6 de mayo a las 3:00 PM"
 */
const formatDatetime = (isoString, timezone = 'America/Bogota') => {
  return new Date(isoString).toLocaleString('es-CO', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// ============================================================
// RECORDATORIO 24 HORAS
// ============================================================

/**
 * Envía recordatorios a clientes con cita en las próximas 24-25 horas.
 * Corre cada hora — el rango de 1h evita duplicados entre ejecuciones.
 */
const sendReminders24h = async () => {
  console.log('[Cron] Ejecutando recordatorios 24h...');
  const barbershops = await getActiveBarbershops();

  for (const barbershop of barbershops) {
    const timezone = barbershop.settings?.timezone || 'America/Bogota';
    const now = new Date();
    const from = new Date(now.getTime() + 24 * 60 * 60 * 1000);       // +24h
    const to   = new Date(now.getTime() + 25 * 60 * 60 * 1000);       // +25h

    const appointments = await getUpcomingAppointments(
      barbershop.id,
      from.toISOString(),
      to.toISOString()
    );

    for (const appt of appointments) {
      // Evitar duplicados — solo enviamos si no se envió antes
      if (appt.reminder_24h_sent) continue;

      const clientPhone = appt.clients?.phone;
      const clientName  = appt.clients?.name || 'Cliente';
      const barberName  = appt.barbers?.name || 'tu barbero';
      const fechaTexto  = formatDatetime(appt.datetime, timezone);

      const mensaje = `Hola ${clientName} 👋 Te recordamos que mañana tienes una cita en ${barbershop.name}: ${appt.service} con ${barberName} el ${fechaTexto}. Si necesitas cancelar responde CANCELAR.`;

      try {
        await sendMessage(barbershop.whatsapp_phone_id, clientPhone, mensaje);
        await markReminderSent(appt.id, '24h');
        console.log(`[Cron] Recordatorio 24h enviado a ${clientPhone} para cita ${appt.id}`);
      } catch (err) {
        console.error(`[Cron] Error enviando recordatorio 24h a ${clientPhone}:`, err.message);
      }
    }
  }
};

// ============================================================
// RECORDATORIO 2 HORAS
// ============================================================

/**
 * Envía recordatorios a clientes con cita en las próximas 2-3 horas.
 */
const sendReminders2h = async () => {
  console.log('[Cron] Ejecutando recordatorios 2h...');
  const barbershops = await getActiveBarbershops();

  for (const barbershop of barbershops) {
    const timezone = barbershop.settings?.timezone || 'America/Bogota';
    const now = new Date();
    const from = new Date(now.getTime() + 2 * 60 * 60 * 1000);        // +2h
    const to   = new Date(now.getTime() + 3 * 60 * 60 * 1000);        // +3h

    const appointments = await getUpcomingAppointments(
      barbershop.id,
      from.toISOString(),
      to.toISOString()
    );

    for (const appt of appointments) {
      if (appt.reminder_2h_sent) continue;

      const clientPhone = appt.clients?.phone;
      const clientName  = appt.clients?.name || 'Cliente';
      const barberName  = appt.barbers?.name || 'tu barbero';
      const fechaTexto  = formatDatetime(appt.datetime, timezone);

      const mensaje = `¡Hola ${clientName}! En 2 horas tienes tu cita en ${barbershop.name}: ${appt.service} con ${barberName} a las ${fechaTexto}. ¡Te esperamos! 💈`;

      try {
        await sendMessage(barbershop.whatsapp_phone_id, clientPhone, mensaje);
        await markReminderSent(appt.id, '2h');
        console.log(`[Cron] Recordatorio 2h enviado a ${clientPhone} para cita ${appt.id}`);
      } catch (err) {
        console.error(`[Cron] Error enviando recordatorio 2h a ${clientPhone}:`, err.message);
      }
    }
  }
};

// ============================================================
// MARCAR CITAS COMPLETADAS
// ============================================================

/**
 * Marca como 'completed' las citas confirmadas cuyo datetime ya pasó.
 * Libera el slot para futuras reservas y actualiza last_visit del cliente.
 */
const markCompletedAppointments = async () => {
  const now = new Date().toISOString();

  const { data: appointments, error } = await supabase
    .from('appointments')
    .select('id, client_id')
    .eq('status', 'confirmed')
    .lt('datetime', now);

  if (error || !appointments?.length) return;

  for (const appt of appointments) {
    await supabase
      .from('appointments')
      .update({ status: 'completed' })
      .eq('id', appt.id);

    // Actualizamos last_visit y visit_count del cliente
    await supabase.rpc('increment_visit_count', { client_id: appt.client_id }).catch(() => {
      // Si la función RPC no existe, hacemos update manual
      supabase
        .from('clients')
        .update({ last_visit: now })
        .eq('id', appt.client_id);
    });
  }

  console.log(`[Cron] ${appointments.length} citas marcadas como completadas`);
};

// ============================================================
// REACTIVACIÓN DE CLIENTES INACTIVOS (+30 días)
// ============================================================

/**
 * Envía mensaje personalizado a clientes que no han visitado en 30+ días.
 * Corre una vez al día a las 10am.
 */
const sendReactivationMessages = async () => {
  console.log('[Cron] Ejecutando reactivación de clientes inactivos...');
  const barbershops = await getActiveBarbershops();

  for (const barbershop of barbershops) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: clients } = await supabase
      .from('clients')
      .select('id, phone, name, last_visit')
      .eq('barbershop_id', barbershop.id)
      .lt('last_visit', thirtyDaysAgo)
      .gt('visit_count', 0);           // solo clientes que ya vinieron antes

    if (!clients?.length) continue;

    for (const client of clients) {
      const nombre = client.name || 'amigo';
      const mensaje = `¡Hola ${nombre}! Te extrañamos en ${barbershop.name} 💈 Han pasado más de 30 días desde tu última visita. ¿Quieres agendar tu próxima cita? Solo escríbenos aquí.`;

      try {
        await sendMessage(barbershop.whatsapp_phone_id, client.phone, mensaje);

        // Prevenimos re-envíos actualizando last_visit a ahora para no volverles a mandar
        await supabase
          .from('clients')
          .update({ last_visit: new Date().toISOString() })
          .eq('id', client.id);

        console.log(`[Cron] Reactivación enviada a ${client.phone}`);
      } catch (err) {
        console.error(`[Cron] Error en reactivación a ${client.phone}:`, err.message);
      }
    }
  }
};

// ============================================================
// REGISTRO DE CRON JOBS
// ============================================================

/**
 * Inicia todos los cron jobs del sistema.
 * Llamar una vez al arrancar el servidor.
 */
export const initCronJobs = () => {
  // Recordatorios 24h y 2h — cada hora en punto
  cron.schedule('0 * * * *', async () => {
    await sendReminders24h().catch((err) =>
      console.error('[Cron] Error en sendReminders24h:', err.message)
    );
    await sendReminders2h().catch((err) =>
      console.error('[Cron] Error en sendReminders2h:', err.message)
    );
  });

  // Marcar citas completadas — cada 30 minutos
  cron.schedule('*/30 * * * *', async () => {
    await markCompletedAppointments().catch((err) =>
      console.error('[Cron] Error en markCompletedAppointments:', err.message)
    );
  });

  // Reactivación de clientes — cada día a las 10am
  cron.schedule('0 10 * * *', async () => {
    await sendReactivationMessages().catch((err) =>
      console.error('[Cron] Error en sendReactivationMessages:', err.message)
    );
  });

  console.log('⏰ Cron jobs iniciados: recordatorios 24h/2h, completadas, reactivación');
};
