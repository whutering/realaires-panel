// Supabase Edge Function: avisos-informes
// Corre una vez por día (Cron). Revisa la autorización de venta de cada propiedad
// en comercialización y avisa por correo al asesor cuando llega un hito de informe
// al propietario (la vigencia se divide en 4). Cada hito se avisa una sola vez.
//
// Desactivar "Verify JWT". El Cron envía el encabezado x-cron-secret (secret CRON_SECRET).
// Secrets: CRON_SECRET, RESEND_API_KEY; opcional AVISOS_REMITENTE, AVISOS_COPIA

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SB_URL    = Deno.env.get('SUPABASE_URL')!
const SRV_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const REMITENTE = Deno.env.get('AVISOS_REMITENTE') ?? 'Panel Real Aires <panel@realaires.com.ar>'
const COPIA     = Deno.env.get('AVISOS_COPIA') ?? ''          // ej. pabloe@realaires.com.ar para recibir copia
const PANEL_URL = 'https://panel.realaires.com.ar/'
const HITOS     = 4

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const fmt = (d: Date) => d.toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })

function hoyAR() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
  return new Date(s + 'T00:00:00Z')
}

Deno.serve(async (req) => {
  const secreto = Deno.env.get('CRON_SECRET')
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
  if (!(secreto && req.headers.get('x-cron-secret') === secreto) && token !== SRV_KEY) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), { status: 401 })
  }

  const admin = createClient(SB_URL, SRV_KEY)
  const { data: props, error } = await admin.from('comercializaciones')
    .select('id, direccion, barrio, asesor, asesor_email, estado, fecha_publicacion, autorizacion_inicio, autorizacion_dias, informes_enviados, informes_avisados')
    .in('estado', ['Activa', 'Reservada'])
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 })

  const hoy = hoyAR()
  const porAsesor = new Map<string, { nombre: string, items: any[] }>()
  const actualizar: { id: string, avisados: number[] }[] = []

  for (const c of props || []) {
    const ini = c.autorizacion_inicio || c.fecha_publicacion
    if (!ini || !c.asesor_email) continue
    const inicio = new Date(ini + 'T00:00:00Z')
    const dias = c.autorizacion_dias || 120
    const enviados = new Set((c.informes_enviados || []).map((x: any) => x.n))
    const avisados = new Set<number>(c.informes_avisados || [])
    const nuevos: number[] = []
    for (let n = 1; n <= HITOS; n++) {
      const fecha = new Date(inicio); fecha.setUTCDate(fecha.getUTCDate() + Math.round(dias * n / HITOS))
      if (fecha <= hoy && !enviados.has(n) && !avisados.has(n)) nuevos.push(n)
    }
    if (!nuevos.length) continue
    // Si hay varios hitos atrasados se avisa solo el más reciente
    const n = Math.max(...nuevos)
    const fin = new Date(inicio); fin.setUTCDate(fin.getUTCDate() + dias)
    const clave = c.asesor_email.toLowerCase()
    if (!porAsesor.has(clave)) porAsesor.set(clave, { nombre: c.asesor || '', items: [] })
    porAsesor.get(clave)!.items.push({ c, n, fin })
    actualizar.push({ id: c.id, avisados: [...new Set([...avisados, ...nuevos])] })
  }

  const enviadosOk: string[] = []
  for (const [mail, { nombre, items }] of porAsesor) {
    const filas = items.map(({ c, n, fin }) => {
      const tipo = n === HITOS ? 'Informe final · vence la autorización, gestionar renovación' : `Informe ${n} de ${HITOS}`
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #F3F4F6;font-weight:600;color:#0F1F3D">${esc(c.direccion)}<div style="font-size:11px;color:#9CA3AF;font-weight:400">${esc(c.barrio || '')}</div></td>
        <td style="padding:10px 12px;border-bottom:1px solid #F3F4F6;color:#1D4ED8;font-weight:600">${tipo}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #F3F4F6;color:#6B7280;white-space:nowrap">Vence ${fmt(fin)}</td>
      </tr>`
    }).join('')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <div style="background:#0A0A0A;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
        <div style="font-size:12px;opacity:.7">Panel Real Aires</div>
        <div style="font-size:18px;font-weight:700">Informes al propietario para preparar</div>
      </div>
      <div style="border:1px solid #E5E7EB;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px">
        <p style="font-size:14px;margin:0 0 14px">Hola ${esc(nombre)}, estas propiedades llegaron a un punto de control de su autorización de venta. Es momento de preparar y enviar el informe de gestión al propietario.</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">${filas}</table>
        <p style="font-size:12.5px;color:#6B7280;margin:14px 0 0">Cuando lo envíes, marcalo como enviado en la ficha de la propiedad (Comercialización) para que no se vuelva a avisar.</p>
        <div style="margin-top:16px"><a href="${PANEL_URL}" style="background:#0A0A0A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600">Abrir el panel</a></div>
      </div></div>`
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: REMITENTE, to: [mail], ...(COPIA ? { cc: [COPIA] } : {}),
        subject: `[Real Aires] ${items.length === 1 ? 'Informe al propietario: ' + items[0].c.direccion : items.length + ' informes al propietario para preparar'}`,
        html,
      }),
    })
    if (res.ok) {
      enviadosOk.push(mail)
      // Se marca como avisado solo si el correo salió
      for (const { c } of items) {
        const u = actualizar.find(x => x.id === c.id)
        if (u) await admin.from('comercializaciones').update({ informes_avisados: u.avisados }).eq('id', u.id)
      }
    } else console.error('Resend', mail, await res.text())
  }

  return new Response(JSON.stringify({ ok: true, asesores_avisados: enviadosOk.length, propiedades: actualizar.length }), { headers: { 'Content-Type': 'application/json' } })
})
