// Supabase Edge Function: ingresar-consulta
// Recibe los avisos de "nueva consulta" de Tokko (leídos de Gmail por un Google Apps Script),
// los interpreta y los registra en public.consultas vinculados a la propiedad por su ID de Tokko.
//
// Desactivar "Verify JWT". El script envía el encabezado x-cron-secret (secret CRON_SECRET).
// Cuerpo: { mensajes: [{ gmail_id, fecha, asunto, html }] }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const PORTALES: Record<string, string> = {
  zonaprop: 'Zonaprop', argenprop: 'Argenprop', mercadolibre: 'MercadoLibre', properati: 'Properati',
  'contacto por whatsapp': 'WhatsApp', whatsapp: 'WhatsApp', 'vio telefono': 'Teléfono', web: 'Web Real Aires',
  'realaires.com.ar': 'Web Real Aires', facebook: 'Meta', instagram: 'Meta', meta: 'Meta',
}

function texto(html: string) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim()
}
function campo(html: string, etiqueta: string) {
  const re = new RegExp(etiqueta + '\\s*:?\\s*</span>\\s*([^<]*)', 'i')
  const m = html.match(re)
  return m ? m[1].trim() || null : null
}

export function interpretar(html: string, asunto = '') {
  const webcontact = html.match(/marketing\/webcontact\/(\d+)/)?.[1] || null
  const nombre = html.match(/nueva consulta de\s*([^<]+)</i)?.[1]?.trim() || null
  const email = campo(html, 'Correo electr[oó]nico')
  const cel = campo(html, 'Celular') || campo(html, 'Tel[eé]fono')
  const etiquetasTxt = campo(html, 'Etiquetas') || ''
  const etiquetas = etiquetasTxt.split(',').map(s => s.trim()).filter(Boolean)
  const propTexto = html.match(/Propiedades:\s*<\/span>\s*<br\/?>\s*<span>([^<]+)<\/span>/i)?.[1]?.replace(/\s+/g, ' ').trim() || null
  const msgHtml = html.match(/Mensaje:\s*<br\/?>\s*<\/span>([\s\S]*?)<\/p>/i)?.[1] || ''
  const aviso = msgHtml.match(/href="([^"]+)"[^>]*>\s*Click aqui para ver el aviso/i)?.[1] || null
  const mensaje = texto(msgHtml.replace(/<a [^>]*>[\s\S]*?<\/a>/gi, '')).replace(/https?:\/\/\S*feedback\S*/gi, '').replace(/¡Luego de contactarlo[\s\S]*$/i, '').trim().slice(0, 2000) || null
  // Propiedades relacionadas: Ref: XXX12345678 → el número es el ID de Tokko
  const refs = [...html.matchAll(/Ref:\s*([A-Z]{1,5}(\d{5,}))/g)].map(m => ({ ref: m[1], id: Number(m[2]) }))
  const fichas = [...html.matchAll(/href="(https:\/\/ficha\.info\/p\/[^"]+)"/g)].map(m => m[1])
  let portal: string | null = null
  for (const t of [...etiquetas, ...asunto.split(' - ').map(s => s.trim())]) {
    const k = t.toLowerCase()
    if (PORTALES[k]) { portal = PORTALES[k]; if (!['Web Real Aires', 'WhatsApp', 'Teléfono'].includes(portal)) break }
  }
  return { webcontact: webcontact ? Number(webcontact) : null, nombre, email, cel, etiquetas, propTexto, mensaje, aviso, refs, fichas, portal }
}

Deno.serve(async (req) => {
  const secreto = Deno.env.get('CRON_SECRET')
  if (!secreto || req.headers.get('x-cron-secret') !== secreto) return json({ error: 'No autorizado' }, 401)
  const { mensajes } = await req.json().catch(() => ({ mensajes: [] }))
  if (!Array.isArray(mensajes)) return json({ error: 'Formato inválido' }, 400)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const resultado: { gmail_id: string, ok: boolean, detalle: string }[] = []

  for (const m of mensajes) {
    try {
      const d = interpretar(String(m.html || ''), String(m.asunto || ''))
      if (!d.webcontact && !d.refs.length) { resultado.push({ gmail_id: m.gmail_id, ok: true, detalle: 'no es una consulta' }); continue }
      const props = d.refs.length ? d.refs : [{ ref: null, id: null }]
      for (let i = 0; i < props.length; i++) {
        const p = props[i]
        let com: any = null
        if (p.id) {
          const { data } = await admin.from('comercializaciones').select('id').eq('tokko_id', p.id).maybeSingle()
          com = data
        }
        if (!com && d.fichas[i]) {
          const { data } = await admin.from('comercializaciones').select('id').eq('tokko_url', d.fichas[i]).maybeSingle()
          com = data
        }
        const fila = {
          recibida_at: m.fecha ? new Date(m.fecha).toISOString() : new Date().toISOString(),
          tokko_webcontact_id: d.webcontact,
          tokko_id: p.id, tokko_ref: p.ref,
          comercializacion_id: com?.id || null,
          propiedad_texto: d.propTexto,
          portal: d.portal,
          etiquetas: d.etiquetas,
          interesado: d.nombre, interesado_email: d.email, interesado_tel: d.cel,
          mensaje: d.mensaje, aviso_url: d.aviso,
          gmail_id: m.gmail_id || null,
        }
        const { error } = await admin.from('consultas').upsert(fila, { onConflict: 'tokko_webcontact_id,tokko_id', ignoreDuplicates: true })
        if (error) throw error
      }
      resultado.push({ gmail_id: m.gmail_id, ok: true, detalle: `${props.length} propiedad(es)` })
    } catch (e) {
      resultado.push({ gmail_id: m.gmail_id, ok: false, detalle: String((e as Error).message || e) })
    }
  }
  return json({ ok: true, procesados: resultado.filter(r => r.ok).map(r => r.gmail_id), resultado })
})
