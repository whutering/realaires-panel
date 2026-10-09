// Supabase Edge Function: enviar-informe
// Envía al propietario el informe de gestión (PDF adjunto) en nombre del asesor.
// Solo pueden enviarlo el asesor responsable de la propiedad o un administrador.
// Secrets: RESEND_API_KEY; opcional INFORMES_REMITENTE (por defecto panel@realaires.com.ar)

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
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user?.email) return json({ error: 'No autenticado' }, 401)

  const { informe_id, para, asunto, mensaje, archivo, pdf_base64 } = await req.json().catch(() => ({}))
  if (!informe_id || !para || !pdf_base64) return json({ error: 'Faltan datos' }, 400)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(para)) return json({ error: 'Email del propietario inválido' }, 400)

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: inf } = await admin.from('informes_propietario').select('*').eq('id', informe_id).maybeSingle()
  if (!inf) return json({ error: 'Informe no encontrado' }, 404)
  const { data: c } = await admin.from('comercializaciones').select('id, direccion, asesor, asesor_email, informes_enviados').eq('id', inf.comercializacion_id).maybeSingle()
  if (!c) return json({ error: 'Propiedad no encontrada' }, 404)

  const { data: esAdmin } = await userClient.rpc('ra_es_admin')
  if (!esAdmin && (c.asesor_email || '').toLowerCase() !== user.email.toLowerCase()) {
    return json({ error: 'Solo el asesor responsable o un administrador pueden enviar este informe' }, 403)
  }

  const nombreAsesor = c.asesor || user.email
  const remitenteBase = Deno.env.get('INFORMES_REMITENTE') ?? 'panel@realaires.com.ar'
  const replyTo = c.asesor_email || user.email
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;color:#2B2B2B;font-size:14px;line-height:1.6">
    ${esc(mensaje || '').replace(/\n/g, '<br>')}
    <div style="margin-top:22px;padding-top:12px;border-top:1px solid #D9D4C7;font-size:12px;color:#5E5E5E">
      Real Aires Bienes Raíces · Migueletes 2386 1°, CABA<br>Pablo Zárate Erdini · Corredor Inmobiliario · CUCICBA 6335 · CMCPSI 7163
    </div></div>`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${nombreAsesor} · Real Aires <${remitenteBase}>`,
      to: [para],
      cc: [replyTo],
      reply_to: replyTo,
      subject: asunto || `Informe de gestión comercial · ${c.direccion}`,
      html,
      attachments: [{ filename: archivo || 'Informe.pdf', content: pdf_base64 }],
    }),
  })
  if (!res.ok) {
    const det = await res.text()
    console.error('Resend', res.status, det)
    return json({ error: 'No se pudo enviar el correo', detalle: det }, 502)
  }

  // Registrar el envío y marcar el hito de la autorización como enviado
  const ahora = new Date().toISOString()
  await admin.from('informes_propietario').update({ estado: 'Enviado', enviado_at: ahora, enviado_a: para, updated_at: ahora }).eq('id', inf.id)
  let enviados = c.informes_enviados || []
  if (inf.hito) {
    enviados = enviados.filter((x: any) => x.n !== inf.hito)
    enviados.push({ n: inf.hito, fecha: ahora.slice(0, 10), por: user.email, informe_id: inf.id, enviado_a: para })
    await admin.from('comercializaciones').update({ informes_enviados: enviados, propietario_email: para }).eq('id', c.id)
  }
  await admin.from('logs').insert({ usuario: user.email, accion: 'enviar_informe', entidad: 'comercializaciones', entidad_id: c.id, detalle: { direccion: c.direccion, hito: inf.hito, para } })
  return json({ ok: true, informes_enviados: enviados })
})
