// ============================================================
// BarberBot SaaS — Script de prueba local del webhook
// Simula un mensaje de WhatsApp entrante sin necesitar Meta real
//
// Uso: node test-webhook.js
// Requiere que el servidor esté corriendo: npm run dev
// ============================================================
import 'dotenv/config';
import crypto from 'crypto';

const SERVER_URL = `http://localhost:${process.env.PORT || 3000}`;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || 'test-secret';

// ============================================================
// Payload simulado — formato real de WhatsApp Cloud API
// ============================================================
const simulatedPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '123456789',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '521XXXXXXXXXX',
              // ⚠️  Cambia este valor por el whatsapp_phone_id real de tu barbería en Supabase
              phone_number_id: 'TU_PHONE_NUMBER_ID_AQUI',
            },
            contacts: [
              {
                profile: { name: 'Cliente Prueba' },
                wa_id: '5215512345678',
              },
            ],
            messages: [
              {
                from: '5215512345678',
                id: 'wamid.test_' + Date.now(),
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: 'text',
                text: {
                  // ✏️  Cambia este mensaje para probar diferentes intenciones:
                  // "Hola" → SALUDO
                  // "Quiero una cita para mañana" → RESERVA
                  // "Cuánto cuesta un corte?" → CONSULTA
                  // "Quiero cancelar mi cita" → CANCELAR
                  body: 'Hola, quiero agendar una cita para mañana por la tarde',
                },
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
};

// ============================================================
// Generamos la firma HMAC-SHA256 (igual que Meta)
// ============================================================
const bodyString = JSON.stringify(simulatedPayload);
const signature = `sha256=${crypto
  .createHmac('sha256', APP_SECRET)
  .update(bodyString)
  .digest('hex')}`;

// ============================================================
// Enviamos el request al webhook
// ============================================================
console.log('📤 Enviando mensaje simulado al webhook...');
console.log(`   URL: ${SERVER_URL}/webhook`);
console.log(`   Mensaje: "${simulatedPayload.entry[0].changes[0].value.messages[0].text.body}"`);
console.log('');

try {
  const response = await fetch(`${SERVER_URL}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature,
    },
    body: bodyString,
  });

  console.log(`✅ Respuesta HTTP: ${response.status} ${response.statusText}`);
  console.log('   (El procesamiento ocurre en background — revisa los logs del servidor)');

  if (response.status === 200) {
    console.log('\n🎉 Webhook funcionando correctamente!');
    console.log('   Revisa la terminal del servidor para ver el flujo completo.');
  } else if (response.status === 401) {
    console.log('\n❌ Error de firma HMAC. Verifica WHATSAPP_APP_SECRET en .env');
  } else {
    console.log('\n⚠️  Respuesta inesperada:', response.status);
  }
} catch (err) {
  console.error('❌ Error de conexión:', err.message);
  console.log('   ¿Está corriendo el servidor? Ejecuta: npm run dev');
}
