// Supabase Edge Function: google-oauth-callback
// Conexión de cada usuario del panel con su cuenta de Google (Calendar y Gmail).
//
// IMPORTANTE: desactivar "Verify JWT" en esta función. Google redirige aquí
// sin token del panel; las acciones del panel verifican el usuario dentro del código.
//
// GET  ?code=...&state=...           → vuelta desde Google, guarda la conexión
// POST { accion: 'iniciar', servicio: 'calendar' | 'gmail' }  → devuelve la URL de Google
// POST { accion: 'desconectar' }                               → revoca y borra la conexión
// POST { accion: 'evento', titulo, inicio, fin, lugar, descripcion } → crea evento en su calendario
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (SUPABASE_* los provee Supabase)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLIENT_ID     = Deno.env.get('GOOGLE_CLIENT_ID')!
const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const SB_URL        = Deno.env.get('SUPABASE_URL')!
const REDIRECT_URI  = `${SB_URL}/functions/v1/google-oauth-callback`
const PANEL_URL     = 'https://panel.realaires.com.ar/Panel_RealAires_App.html'
const TZ            = 'America/Argentina/Buenos_Aires'

const SCOPES: Record<string, string> = {
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  gmail:    'https://www.googleapis.com/auth/gmail.send',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const volverAlPanel = (params: Record<string, string>) =>
  new Response(null, { status: 302, headers: { Location: `${PANEL_URL}?${new URLSearchParams(params)}` } })

const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// ── Utilidades de cifrado y firma (claves derivadas del secreto del cliente) ──
const enc = new TextEncoder()
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const deB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0))

async function claveHmac() {
  return crypto.subtle.importKey('raw', enc.encode('ra-state:' + CLIENT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}
async function claveAes() {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('ra-token:' + CLIENT_SECRET))
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function firmar(payload: object) {
  const body = b64u(enc.encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign('HMAC', await claveHmac(), enc.encode(body))
  return `${body}.${b64u(sig)}`
}
async function verificar(state: string) {
  const [body, sig] = (state || '').split('.')
  if (!body || !sig) return null
  const ok = await crypto.subtle.verify('HMAC', await claveHmac(), deB64u(sig), enc.encode(body))
  if (!ok) return null
  const data = JSON.parse(new TextDecoder().decode(deB64u(body)))
  if (Date.now() - data.ts > 15 * 60 * 1000) return null   // el enlace vence a los 15 minutos
  return data
}
async function cifrar(texto: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await claveAes(), enc.encode(texto))
  return `${b64u(iv)}.${b64u(ct)}`
}
async function descifrar(valor: string) {
  const [iv, ct] = valor.split('.')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64u(iv) }, await claveAes(), deB64u(ct))
  return new TextDecoder().decode(pt)
}

async function accessTokenDe(userId: string) {
  const { data: con } = await admin.from('google_conexiones').select('refresh_token').eq('user_id', userId).maybeSingle()
  if (!con?.refresh_token) return null
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: await descifrar(con.refresh_token), grant_type: 'refresh_token',
    }),
  })
  const tok = await res.json()
  if (!res.ok) {
    // Si el usuario revocó el acceso desde Google, se limpia la conexión
    if (tok.error === 'invalid_grant') await admin.from('google_conexiones').delete().eq('user_id', userId)
    return null
  }
  return tok.access_token as string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const url = new URL(req.url)

  // ── 1. Vuelta desde Google ─────────────────────────────────────
  if (req.method === 'GET') {
    const st = await verificar(url.searchParams.get('state') || '')
    const servicio = st?.servicio || ''
    if (url.searchParams.get('error')) return volverAlPanel({ google: 'cancelado', servicio })
    if (!st) return volverAlPanel({ google: 'error', motivo: 'enlace_vencido' })

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code') || '', client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
      }),
    })
    const tok = await res.json()
    if (!res.ok) { console.error('token', tok); return volverAlPanel({ google: 'error', servicio, motivo: 'token' }) }

    const otorgados: string = tok.scope || ''
    let googleEmail: string | null = null
    try { googleEmail = JSON.parse(new TextDecoder().decode(deB64u(tok.id_token.split('.')[1]))).email } catch (_) {}

    if (!otorgados.includes(SCOPES[servicio])) return volverAlPanel({ google: 'sin_permiso', servicio })

    const { data: previa } = await admin.from('google_conexiones').select('refresh_token').eq('user_id', st.uid).maybeSingle()
    const fila: Record<string, unknown> = {
      user_id: st.uid,
      email_panel: st.email,
      google_email: googleEmail,
      calendar: otorgados.includes(SCOPES.calendar),
      gmail: otorgados.includes(SCOPES.gmail),
      actualizado_at: new Date().toISOString(),
    }
    if (tok.refresh_token) fila.refresh_token = await cifrar(tok.refresh_token)
    else if (!previa?.refresh_token) return volverAlPanel({ google: 'error', servicio, motivo: 'sin_refresh' })

    const { error } = await admin.from('google_conexiones').upsert(fila)
    if (error) { console.error(error); return volverAlPanel({ google: 'error', servicio, motivo: 'db' }) }
    return volverAlPanel({ google: 'ok', servicio })
  }

  // ── 2. Acciones desde el panel (requieren sesión) ──────────────
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  const userClient = createClient(SB_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return json({ error: 'No autenticado' }, 401)
  const body = await req.json().catch(() => ({}))

  if (body.accion === 'iniciar') {
    const servicio = body.servicio
    if (!SCOPES[servicio]) return json({ error: 'Servicio inválido' }, 400)
    const state = await firmar({ uid: user.id, email: user.email, servicio, ts: Date.now() })
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: `openid email ${SCOPES[servicio]}`,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
    })
    if (user.email) params.set('login_hint', user.email)
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` })
  }

  if (body.accion === 'desconectar') {
    const { data: con } = await admin.from('google_conexiones').select('refresh_token').eq('user_id', user.id).maybeSingle()
    if (con?.refresh_token) {
      try {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: await descifrar(con.refresh_token) }),
        })
      } catch (_) {}
    }
    await admin.from('google_conexiones').delete().eq('user_id', user.id)
    return json({ ok: true })
  }

  if (body.accion === 'evento') {
    const { titulo, inicio, fin, lugar, descripcion } = body
    if (!titulo || !inicio || !fin) return json({ error: 'Faltan datos del evento' }, 400)
    const access = await accessTokenDe(user.id)
    if (!access) return json({ error: 'Google Calendar no está conectado', reconectar: true }, 409)
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: titulo,
        location: lugar || undefined,
        description: descripcion || undefined,
        start: { dateTime: inicio, timeZone: TZ },
        end:   { dateTime: fin,    timeZone: TZ },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 24 * 60 }] },
      }),
    })
    const ev = await res.json()
    if (!res.ok) { console.error('calendar', ev); return json({ error: ev.error?.message || 'No se pudo crear el evento' }, 502) }
    return json({ ok: true, link: ev.htmlLink })
  }

  return json({ error: 'Acción desconocida' }, 400)
})
