// ============================================================
// BarberBot SaaS — Rutas de Autenticación OAuth
// GET  /auth/google          → redirige a Google para autorizar
// GET  /auth/google/callback → recibe el código y guarda tokens
// ============================================================
import { Router } from 'express';
import { google } from 'googleapis';
import supabase from '../db/supabase.js';

const router = Router();

/**
 * Crea el cliente OAuth2 de Google.
 */
const getOAuth2Client = () =>
  new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

// Scopes necesarios para Google Calendar
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

// ============================================================
// GET /auth/google?barbershop_id=xxx
// Inicia el flujo OAuth — redirige a Google
// ============================================================
router.get('/google', (req, res) => {
  const { barbershop_id } = req.query;

  if (!barbershop_id) {
    return res.status(400).json({ error: 'barbershop_id es requerido' });
  }

  const oauth2Client = getOAuth2Client();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',   // offline = obtenemos refresh_token
    prompt: 'consent',         // forzamos pantalla de consentimiento para obtener refresh_token siempre
    scope: SCOPES,
    state: barbershop_id,      // pasamos el ID del tenant como state para recuperarlo en callback
  });

  console.log(`[Auth] Iniciando OAuth Google para barbería ${barbershop_id}`);
  res.redirect(authUrl);
});

// ============================================================
// GET /auth/google/callback
// Google redirige aquí con el código — guardamos los tokens
// ============================================================
router.get('/google/callback', async (req, res) => {
  const { code, state: barbershopId, error } = req.query;

  if (error) {
    console.error('[Auth] Google OAuth rechazado:', error);
    return res.status(400).send(`
      <h2>❌ Autorización rechazada</h2>
      <p>El dueño de la barbería rechazó el acceso a Google Calendar.</p>
    `);
  }

  if (!code || !barbershopId) {
    return res.status(400).json({ error: 'Parámetros inválidos en callback' });
  }

  try {
    const oauth2Client = getOAuth2Client();

    // Intercambiamos el código por tokens de acceso
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Obtenemos la lista de calendarios para guardar el ID del calendario principal
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { data } = await calendar.calendarList.list();
    const primaryCalendar = data.items?.find((c) => c.primary) || data.items?.[0];

    // Guardamos los tokens en la barbería — multi-tenant seguro
    const { error: dbError } = await supabase
      .from('barbershops')
      .update({
        google_tokens: tokens,
        google_calendar_id: primaryCalendar?.id || 'primary',
      })
      .eq('id', barbershopId);

    if (dbError) throw dbError;

    console.log(`[Auth] ✅ Google Calendar conectado para barbería ${barbershopId}`);

    // Redirigimos al dashboard con mensaje de éxito
    const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3001';
    res.redirect(`${dashboardUrl}/settings?google=connected`);

  } catch (err) {
    console.error('[Auth] Error en callback de Google:', err.message);
    res.status(500).send(`
      <h2>❌ Error al conectar Google Calendar</h2>
      <p>${err.message}</p>
      <p>Intenta de nuevo desde el dashboard.</p>
    `);
  }
});

// ============================================================
// DELETE /auth/google?barbershop_id=xxx
// Desconecta Google Calendar de una barbería
// ============================================================
router.delete('/google', async (req, res) => {
  const { barbershop_id } = req.query;

  if (!barbershop_id) {
    return res.status(400).json({ error: 'barbershop_id es requerido' });
  }

  try {
    await supabase
      .from('barbershops')
      .update({ google_tokens: null, google_calendar_id: null })
      .eq('id', barbershop_id);

    console.log(`[Auth] Google Calendar desconectado para barbería ${barbershop_id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Error al desconectar Google:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
