// Supabase Edge Function: tokko-sync
// Trae las propiedades de Tokko Broker y las sincroniza con public.comercializaciones.
// La ejecuta el Cron de Supabase todos los días y un administrador desde el panel.
//
// Secret: TOKKO_API_KEY (SUPABASE_* los provee Supabase)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TOKKO_KEY = Deno.env.get('TOKKO_API_KEY')!
const SB_URL    = Deno.env.get('SUPABASE_URL')!
const SRV_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PORTALES  = ['Zonaprop', 'Argenprop', 'MercadoLibre', 'Properati', 'Meta', 'Web Real Aires']

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\bavenida\b|\bav\b\.?/g, 'av').replace(/[°º"'.,;:#()\/\\-]/g, ' ').replace(/\s+/g, ' ').trim()
const claveDir = (s: unknown) => norm(s).replace(/\s+/g, '')
const limpia = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
const hoy = () => new Date().toISOString().slice(0, 10)

// Estados de Tokko: 2 disponible, 3 reservada; propiedad eliminada en Tokko → retirada
function estadoDe(p: any, actual?: string) {
  if (actual === 'Vendida') return 'Vendida'
  if (p.deleted_at) return 'Retirada'
  if (p.status === 3) return 'Reservada'
  if (p.status === 2) return 'Activa'
  return 'Pausada'
}

async function traerTokko() {
  const todas: any[] = []
  let url: string | null = `https://www.tokkobroker.com/api/v1/property/?key=${TOKKO_KEY}&format=json&lang=es_ar&limit=50&offset=0`
  for (let i = 0; url && i < 40; i++) {
    const res: Response = await fetch(url)
    if (!res.ok) throw new Error(`Tokko respondió ${res.status}`)
    const data: any = await res.json()
    todas.push(...(data.objects || []))
    url = data.meta?.next ? `https://www.tokkobroker.com${data.meta.next}` : null
  }
  return todas
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const admin = createClient(SB_URL, SRV_KEY)

  // Autorización: el Cron de Supabase (clave de servicio) o un administrador del panel
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
  if (token !== SRV_KEY) {
    const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: `Bearer ${token}` } } })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'No autenticado' }, 401)
    const { data: esAdmin } = await userClient.rpc('ra_es_admin')
    if (!esAdmin) return json({ error: 'Solo administradores' }, 403)
  }

  try {
    const [props, { data: existentes }, { data: asesores }] = await Promise.all([
      traerTokko(),
      admin.from('comercializaciones').select('id, tokko_id, direccion, precio, moneda, historial_precios, estado, asesor, asesor_email, asesor_manual, fecha_publicacion, propietario, portales'),
      admin.from('asesores').select('nombre, mail, activo'),
    ])
    const porTokko = new Map((existentes || []).filter(c => c.tokko_id).map(c => [Number(c.tokko_id), c]))
    const porDir   = new Map((existentes || []).filter(c => !c.tokko_id).map(c => [claveDir(c.direccion), c]))
    const asesorPorNombre = new Map((asesores || []).map(a => [norm(a.nombre), a]))
    const asesorPorMail   = new Map((asesores || []).filter(a => a.mail).map(a => [a.mail.toLowerCase(), a]))

    const resumen = { tokko: props.length, nuevas: 0, actualizadas: 0, vinculadas: 0, cambios_precio: 0, errores: [] as string[] }
    const filas: any[] = []

    for (const p of props) {
      const op = (p.operations || [])[0] || {}
      const pr = (op.prices || [])[0] || {}
      const direccion = limpia(p.real_address) || limpia(p.address) || `Tokko ${p.reference_code}`
      const prev = porTokko.get(Number(p.id)) || porDir.get(claveDir(direccion))
      if (prev && !prev.tokko_id) resumen.vinculadas++

      // Asesor: el productor o el agente de llaves de Tokko, si coincide con un asesor del panel
      const candidatos = [p.producer, p.internal_data?.key_agent_user].filter(Boolean)
      let asesor: any = null
      for (const c of candidatos) {
        asesor = asesorPorNombre.get(norm(c.name)) || asesorPorMail.get(String(c.email || '').toLowerCase())
        if (asesor) break
      }

      const precio = Number(pr.price) || null
      const moneda = pr.currency === 'ARS' ? 'ARS' : 'USD'
      const hist = [...(prev?.historial_precios || [])]
      if (precio && (!hist.length || Number(hist[hist.length - 1].precio) !== precio || hist[hist.length - 1].moneda !== moneda)) {
        if (hist.length) resumen.cambios_precio++
        hist.push({ fecha: hoy(), precio, moneda, origen: 'tokko' })
      }

      const propietario = (p.internal_data?.property_owners || []).map((o: any) => limpia(o.name)).filter(Boolean).join(' y ')
      const fila: Record<string, unknown> = {
        ...(prev ? { id: prev.id } : {}),
        tokko_id: p.id,
        tokko_ref: p.reference_code,
        tokko_url: p.public_url || null,
        tokko_status: p.status ?? null,
        direccion,
        barrio: p.location?.name ? limpia(p.location.name) : null,
        operacion: /alquiler/i.test(op.operation_type || '') ? 'Alquiler' : 'Venta',
        precio, moneda,
        historial_precios: hist,
        estado: estadoDe(p, prev?.estado),
        propietario: prev?.propietario || propietario || null,
        fecha_publicacion: prev?.fecha_publicacion || (p.created_at ? String(p.created_at).slice(0, 10) : null),
        portales: prev?.portales?.length ? prev.portales : PORTALES,
        datos_tokko: {
          tipo: p.type?.name || null,
          titulo: p.publication_title || null,
          ambientes: p.room_amount || null,
          dormitorios: p.suite_amount || null,
          banos: p.bathroom_amount || null,
          sup_total: Number(p.total_surface) || null,
          sup_cubierta: Number(p.roofed_surface) || null,
          sup_semicubierta: Number(p.semiroofed_surface) || null,
          expensas: p.expenses || null,
          antiguedad: p.age ?? null,
          orientacion: p.orientation || null,
          disposicion: p.disposition || null,
          cocheras: p.parking_lot_amount || 0,
          atributos: (p.tags || []).map((t: any) => typeof t === 'string' ? t : t?.name).filter(Boolean).slice(0, 30),
          foto: (p.photos || []).find((f: any) => f.is_front_cover)?.image || (p.photos || [])[0]?.image || null,
          lat: p.geo_lat || null, lng: p.geo_long || null,
        },
        sincronizado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      // El asesor se toma de Tokko salvo que un administrador lo haya asignado a mano en el panel
      // (todas las filas llevan las mismas columnas para que el guardado en tanda no pise datos)
      if (!prev?.asesor_manual && asesor) { fila.asesor = asesor.nombre; fila.asesor_email = asesor.mail || null }
      else { fila.asesor = prev?.asesor ?? null; fila.asesor_email = prev?.asesor_email ?? null }

      prev ? resumen.actualizadas++ : resumen.nuevas++
      filas.push(fila)
    }

    // Guardar en tandas
    for (let i = 0; i < filas.length; i += 100) {
      const tanda = filas.slice(i, i + 100)
      const conId = tanda.filter(f => f.id), sinId = tanda.filter(f => !f.id)
      if (conId.length) { const { error } = await admin.from('comercializaciones').upsert(conId); if (error) resumen.errores.push(error.message) }
      if (sinId.length) { const { error } = await admin.from('comercializaciones').upsert(sinId, { onConflict: 'tokko_id' }); if (error) resumen.errores.push(error.message) }
    }

    await admin.from('logs').insert({ usuario: 'tokko-sync', accion: 'sincronizar_tokko', entidad: 'comercializaciones', detalle: resumen })
    return json({ ok: resumen.errores.length === 0, ...resumen })
  } catch (e) {
    console.error(e)
    return json({ error: String((e as Error).message || e) }, 500)
  }
})
