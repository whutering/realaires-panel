// Supabase Edge Function: notificar-reporte
// Envía por correo (Resend) el aviso de un reporte cargado por un asesor
// sobre una de sus operaciones.
//
// Secrets que usa (Supabase → Project Settings → Edge Functions → Secrets):
//   RESEND_API_KEY      (ya existe si funcionan los mails semanales)
//   REPORTES_DESTINO    opcional, por defecto pabloe@realaires.com.ar
//   REPORTES_REMITENTE  opcional, por defecto "Panel Real Aires <panel@realaires.com.ar>"
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los provee Supabase.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const authHeader = req.headers.get('Authorization') ?? ''

  // 1. Identificar a quien llama
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'No autenticado' }, 401)

  const { reporte_id } = await req.json().catch(() => ({}))
  if (!reporte_id) return json({ error: 'Falta reporte_id' }, 400)

  // 2. Leer el reporte y la operación con permisos de servicio
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: rep, error } = await admin.from('reportes_operacion').select('*').eq('id', reporte_id).single()
  if (error || !rep) return json({ error: 'Reporte no encontrado' }, 404)
  if (rep.asesor_email !== user.email) return json({ error: 'Sin permiso sobre este reporte' }, 403)
  if (rep.mail_enviado) return json({ ok: true, ya_enviado: true })

  let op: Record<string, unknown> | null = null
  if (rep.venta_id) {
    const { data } = await admin.from('ventas').select('*').eq('id', rep.venta_id).maybeSingle()
    op = data
  }
  // Reporte sobre una propiedad en comercialización: también avisa al asesor responsable
  let prop: Record<string, any> | null = null
  if (rep.comercializacion_id) {
    const { data } = await admin.from('comercializaciones').select('direccion, asesor, asesor_email, tokko_ref').eq('id', rep.comercializacion_id).maybeSingle()
    prop = data
  }

  // 3. Armar y enviar el correo
  const destino   = Deno.env.get('REPORTES_DESTINO')   ?? 'pabloe@realaires.com.ar'
  const remitente = Deno.env.get('REPORTES_REMITENTE') ?? 'Panel Real Aires <panel@realaires.com.ar>'
  const fecha = new Date(rep.created_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })

  const fila = (k: string, v: unknown) =>
    `<tr><td style="padding:6px 10px;color:#6B7280;font-size:13px;white-space:nowrap">${esc(k)}</td><td style="padding:6px 10px;font-size:13px;color:#111827;font-weight:600">${esc(v ?? '—')}</td></tr>`

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#111827">
    <div style="background:#0A0A0A;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
      <div style="font-size:12px;opacity:.7">Panel Real Aires</div>
      <div style="font-size:18px;font-weight:700">Nuevo reporte sobre ${prop ? 'una propiedad' : 'una operación'}</div>
    </div>
    <div style="border:1px solid #E5E7EB;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px">
      <table style="border-collapse:collapse;width:100%;margin-bottom:14px">
        ${fila('Inmueble', rep.inmueble)}
        ${fila(prop ? 'Reportado por' : 'Asesor', rep.asesor_nombre)}
        ${prop ? fila('Asesor responsable', prop.asesor || 'Sin asignar') : ''}
        ${prop?.tokko_ref ? fila('Código Tokko', prop.tokko_ref) : ''}
        ${fila('Email del asesor', rep.asesor_email)}
        ${fila('Tipo de corrección', rep.categoria)}
        ${fila('Fecha del reporte', fecha)}
        ${op ? fila('Estado de la operación', op.estado) : ''}
        ${op ? fila('Broker / Compartida', `${op.broker ?? '—'} / ${op.cobroker ?? op.inm_externa ?? '—'}`) : ''}
      </table>
      <div style="font-size:12px;color:#6B7280;margin-bottom:6px">Detalle del reporte</div>
      <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(rep.detalle)}</div>
      <div style="margin-top:18px">
        <a href="https://panel.realaires.com.ar/" style="background:#0A0A0A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600">Abrir el panel</a>
      </div>
    </div>
  </div>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: remitente,
      to: [destino],
      ...(prop?.asesor_email && prop.asesor_email !== destino && prop.asesor_email !== rep.asesor_email ? { cc: [prop.asesor_email] } : {}),
      reply_to: rep.asesor_email,
      subject: `Reporte de ${rep.asesor_nombre ?? rep.asesor_email} · ${rep.inmueble ?? 'Operación'}`,
      html,
    }),
  })

  if (!res.ok) {
    const detalle = await res.text()
    console.error('Resend error', res.status, detalle)
    return json({ error: 'No se pudo enviar el correo', detalle }, 502)
  }

  await admin.from('reportes_operacion').update({ mail_enviado: true }).eq('id', rep.id)
  return json({ ok: true })
})
