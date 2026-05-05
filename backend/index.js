// ============================================================
// BarberBot SaaS — Servidor Express Principal
// ============================================================
import 'dotenv/config';
import express from 'express';
import webhookRouter from './src/routes/webhook.js';
import webhookTwilioRouter from './src/routes/webhook-twilio.js';
import authRouter from './src/routes/auth.js';
import { initCronJobs } from './src/services/cron.js';

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware de logging global (primero de todo) ---
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} | Content-Type: ${req.headers['content-type'] || 'none'}`);
  next();
});

// Bypass de la pantalla de advertencia de ngrok en desarrollo
app.use((_req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

// IMPORTANTE: el body debe llegar como raw buffer para verificar firma HMAC de Meta
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf; // guardamos el buffer crudo para la verificación de firma
    },
  })
);

// Twilio envía los datos como form-urlencoded (no JSON)
app.use(express.urlencoded({ extended: false }));

// --- Rutas ---
app.use('/webhook', webhookRouter);
app.use('/webhook/twilio', webhookTwilioRouter);
app.use('/auth', authRouter);

// Ruta de salud — útil para Railway y monitoreo
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'BarberBot Backend', timestamp: new Date().toISOString() });
});

// Manejador de rutas no encontradas
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Manejador global de errores
app.use((err, _req, res, _next) => {
  console.error('[ERROR GLOBAL]', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// --- Inicio del servidor ---
app.listen(PORT, () => {
  console.log(`✂️  BarberBot backend corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook disponible en http://localhost:${PORT}/webhook`);

  // Iniciamos los cron jobs de recordatorios y automatizaciones
  initCronJobs();
});

export default app;
