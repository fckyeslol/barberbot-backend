'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_KEY!
);

// ============================================================
// TIPOS
// ============================================================
type Appointment = {
  id: string;
  service: string;
  datetime: string;
  status: string;
  clients: { phone: string; name: string | null };
  barbers: { name: string };
};

type Metric = { label: string; value: number | string; color: string };

// ============================================================
// COMPONENTES
// ============================================================

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    confirmed: 'bg-green-100 text-green-800',
    pending:   'bg-yellow-100 text-yellow-800',
    cancelled: 'bg-red-100 text-red-800',
    completed: 'bg-gray-100 text-gray-600',
  };
  const labels: Record<string, string> = {
    confirmed: 'Confirmada',
    pending:   'Pendiente',
    cancelled: 'Cancelada',
    completed: 'Completada',
  };
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${styles[status] ?? 'bg-gray-100'}`}>
      {labels[status] ?? status}
    </span>
  );
}

function MetricCard({ label, value, color }: Metric) {
  return (
    <div className={`rounded-xl p-5 text-white ${color}`}>
      <p className="text-sm opacity-80">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}

// ============================================================
// PÁGINA PRINCIPAL DEL DASHBOARD
// ============================================================
export default function DashboardPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [metrics, setMetrics] = useState({ today: 0, week: 0, clients: 0, cancelled: 0 });
  const [loading, setLoading] = useState(true);
  const [barbershopName, setBarbershopName] = useState('');

  // Para demo usamos la primera barbería — en producción viene de la sesión del usuario
  const DEMO_BARBERSHOP_PHONE_ID = process.env.NEXT_PUBLIC_DEMO_PHONE_ID || '';

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      // 1. Obtenemos la barbería
      const { data: barbershop } = await supabase
        .from('barbershops')
        .select('id, name')
        .eq('whatsapp_phone_id', DEMO_BARBERSHOP_PHONE_ID)
        .single();

      if (!barbershop) return;
      setBarbershopName(barbershop.name);

      // 2. Citas de hoy
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const { data: todayAppts } = await supabase
        .from('appointments')
        .select('id, service, datetime, status, clients(phone, name), barbers(name)')
        .eq('barbershop_id', barbershop.id)
        .gte('datetime', todayStart.toISOString())
        .lte('datetime', todayEnd.toISOString())
        .order('datetime');

      setAppointments((todayAppts as unknown as Appointment[]) ?? []);

      // 3. Métricas
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);

      const [{ count: weekCount }, { count: clientCount }, { count: cancelCount }] =
        await Promise.all([
          supabase.from('appointments').select('*', { count: 'exact', head: true })
            .eq('barbershop_id', barbershop.id)
            .gte('datetime', weekStart.toISOString())
            .neq('status', 'cancelled'),
          supabase.from('clients').select('*', { count: 'exact', head: true })
            .eq('barbershop_id', barbershop.id),
          supabase.from('appointments').select('*', { count: 'exact', head: true })
            .eq('barbershop_id', barbershop.id)
            .eq('status', 'cancelled')
            .gte('datetime', weekStart.toISOString()),
        ]);

      setMetrics({
        today: todayAppts?.length ?? 0,
        week: weekCount ?? 0,
        clients: clientCount ?? 0,
        cancelled: cancelCount ?? 0,
      });
    } finally {
      setLoading(false);
    }
  };

  const cancelAppointment = async (id: string) => {
    if (!confirm('¿Cancelar esta cita?')) return;
    await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', id);
    loadDashboard();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-4xl mb-3">✂️</div>
          <p className="text-gray-500">Cargando dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">✂️</span>
          <div>
            <h1 className="font-bold text-gray-900">{barbershopName || 'BarberBot'}</h1>
            <p className="text-xs text-gray-500">Panel de administración</p>
          </div>
        </div>
        <button
          onClick={loadDashboard}
          className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
        >
          🔄 Actualizar
        </button>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">

        {/* Métricas */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Citas hoy"         value={metrics.today}     color="bg-blue-500" />
          <MetricCard label="Citas esta semana"  value={metrics.week}      color="bg-indigo-500" />
          <MetricCard label="Clientes totales"   value={metrics.clients}   color="bg-purple-500" />
          <MetricCard label="Cancelaciones (7d)" value={metrics.cancelled} color="bg-red-400" />
        </div>

        {/* Citas del día */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            📅 Citas de hoy — {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}
          </h2>

          {appointments.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400">
              No hay citas programadas para hoy
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-gray-600 font-medium">Hora</th>
                    <th className="px-4 py-3 text-left text-gray-600 font-medium">Cliente</th>
                    <th className="px-4 py-3 text-left text-gray-600 font-medium">Servicio</th>
                    <th className="px-4 py-3 text-left text-gray-600 font-medium">Barbero</th>
                    <th className="px-4 py-3 text-left text-gray-600 font-medium">Estado</th>
                    <th className="px-4 py-3 text-left text-gray-600 font-medium">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {appointments.map((appt) => (
                    <tr key={appt.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {new Date(appt.datetime).toLocaleTimeString('es-CO', {
                          hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
                        })}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-800">{appt.clients?.name ?? '—'}</div>
                        <div className="text-xs text-gray-400">{appt.clients?.phone}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{appt.service}</td>
                      <td className="px-4 py-3 text-gray-700">{appt.barbers?.name}</td>
                      <td className="px-4 py-3"><StatusBadge status={appt.status} /></td>
                      <td className="px-4 py-3">
                        {appt.status === 'confirmed' && (
                          <button
                            onClick={() => cancelAppointment(appt.id)}
                            className="text-red-500 hover:text-red-700 text-xs underline"
                          >
                            Cancelar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Conectar Google Calendar */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-2">🗓️ Google Calendar</h2>
          <p className="text-sm text-gray-500 mb-4">
            Conecta tu Google Calendar para que las citas aparezcan automáticamente.
          </p>
          <a
            href={`${process.env.NEXT_PUBLIC_BACKEND_URL}/auth/google?barbershop_id=${DEMO_BARBERSHOP_PHONE_ID}`}
            className="inline-block bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition-colors"
          >
            Conectar Google Calendar
          </a>
        </section>

      </main>
    </div>
  );
}
