# ✂️ BarberBot SaaS — Instrucciones del Proyecto

## Propósito
SaaS multi-tenant de automatización con IA para barberías.
Un sistema central sirve a N barberías, cada una con su WhatsApp, agenda y datos aislados.

## Stack Técnico
- **Backend:** Node.js + Express (ES Modules, NO CommonJS)
- **AI:** Claude API (claude-sonnet-4-6)
- **Mensajería:** WhatsApp Cloud API (Meta)
- **Agenda:** Google Calendar API
- **BD:** Supabase (PostgreSQL)
- **Jobs:** node-cron
- **Dashboard:** Next.js 14 + Tailwind CSS
- **Pagos:** Stripe
- **Deploy:** Railway (backend) + Vercel (frontend)

## Estructura del Proyecto
```
/
├── backend/          ← API REST + webhooks + cron jobs
│   ├── src/
│   │   ├── routes/   ← endpoints Express
│   │   ├── services/ ← lógica de negocio (whatsapp, calendar, ai, cron)
│   │   ├── db/       ← queries Supabase
│   │   └── utils/    ← helpers
│   └── index.js
├── dashboard/        ← Next.js para dueños de barbería
│   └── src/app/
└── docs/             ← diagramas y decisiones de arquitectura
```

## Módulos del Sistema
1. **Motor de Reservas** — Claude interpreta WhatsApp → agenda en Google Calendar
2. **Recordatorios** — cron 24h y 2h antes, cancelación libera turno
3. **Reactivación** — clientes inactivos +30 días reciben mensaje personalizado
4. **Post-Servicio** — reseña Google Maps 30 min después de cita
5. **Fidelización** — cumpleaños + descuentos automáticos
6. **Dashboard** — panel web del dueño con métricas y configuración

## Convenciones de Código
- ES Modules (`import/export`), NUNCA `require()`
- `async/await` siempre, NUNCA callbacks
- Variables de entorno en `.env`, NUNCA hardcodear keys
- Cada módulo tiene su propio service en `backend/src/services/`
- Los webhooks de WhatsApp van en `backend/src/routes/webhook.js`
- Manejo de errores con try/catch en todos los endpoints

## Multi-Tenant
- Cada barbería tiene un registro en tabla `barbershops` con su `id`
- TODOS los queries de BD deben filtrar por `barbershop_id`
- Nunca mezclar datos entre barberías

## Comandos Útiles
```bash
# Backend
cd backend && npm run dev      # desarrollo con nodemon
cd backend && npm test         # tests con Jest
cd backend && npm run lint     # ESLint

# Dashboard
cd dashboard && npm run dev    # Next.js dev server
cd dashboard && npm run build  # build producción
```

## Variables de Entorno Requeridas
Ver `.env.example` — NUNCA commitear `.env` real.
Claves necesarias: `ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN`, `GOOGLE_CLIENT_ID`, `SUPABASE_URL`, `SUPABASE_KEY`, `STRIPE_SECRET_KEY`

## Lo que Claude NO debe hacer
- NO hardcodear tokens o API keys en el código
- NO usar `var`, solo `const`/`let`
- NO mezclar datos de diferentes barberías en queries
- NO commitear archivos `.env`
- NO usar callbacks, siempre async/await

@docs/arquitectura.md
