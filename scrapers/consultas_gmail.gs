/**
 * REAL AIRES · Lector de consultas de Tokko
 * Google Apps Script que corre en la casilla pabloe@realaires.com.ar.
 * Cada 5 minutos busca los avisos "Hay una nueva consulta" de Tokko y los envía al panel,
 * donde quedan registrados en la propiedad correspondiente.
 *
 * Instalación: ver instrucciones en el panel. Ejecutar una vez "instalar".
 */

const PANEL_FUNCION = 'https://yjfleshetpwdyoyeciaf.supabase.co/functions/v1/ingresar-consulta';
const SECRETO       = 'ra_cron_e506bb5c9a314284f8baef5b3ab54379';
const BUSQUEDA      = 'from:notifier@tokkobroker.com "nueva consulta"';
const LOTE          = 25;

/** Ejecutar una sola vez: crea el disparador cada 5 minutos y carga el historial reciente. */
function instalar() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'revisarConsultas') ScriptApp.deleteTrigger(t) });
  ScriptApp.newTrigger('revisarConsultas').timeBased().everyMinutes(5).create();
  cargarHistorial();
}

/** Carga las consultas de los últimos 120 días, en tramos de una semana.
 *  Si se acerca al límite de tiempo de Google, se reprograma sola y sigue al minuto. */
function cargarHistorial() {
  const props = PropertiesService.getScriptProperties()
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'cargarHistorial') ScriptApp.deleteTrigger(t) })
  let cursor = Number(props.getProperty('HIST_CURSOR') || (Date.now() - 120 * 864e5))
  const inicio = Date.now()
  while (cursor < Date.now()) {
    if (Date.now() - inicio > 4.5 * 60 * 1000) {
      props.setProperty('HIST_CURSOR', String(cursor))
      ScriptApp.newTrigger('cargarHistorial').timeBased().after(60 * 1000).create()
      Logger.log('Historial en curso, continúa en un minuto (cargado hasta ' + new Date(cursor).toLocaleDateString() + ')')
      return
    }
    const hasta = Math.min(cursor + 7 * 864e5, Date.now())
    const n = procesar_(new Date(cursor), new Date(hasta))
    Logger.log('Semana desde ' + new Date(cursor).toLocaleDateString() + ': ' + n + ' consultas')
    cursor = hasta
  }
  props.deleteProperty('HIST_CURSOR')
  Logger.log('Historial completo')
}

/** Lo ejecuta el disparador cada 5 minutos. */
function revisarConsultas() {
  const props = PropertiesService.getScriptProperties();
  const ultimo = Number(props.getProperty('ULTIMO') || 0);
  // Margen de 15 minutos hacia atrás: el panel descarta duplicados
  const desde = new Date((ultimo || Date.now() - 864e5) - 15 * 60 * 1000);
  procesar_(desde);
}

function procesar_(desde, hasta) {
  const props = PropertiesService.getScriptProperties();
  const q = BUSQUEDA + ' after:' + Math.floor(desde.getTime() / 1000) + (hasta ? ' before:' + Math.floor(hasta.getTime() / 1000) : '');
  let pendientes = [], enviados = 0, maxFecha = Number(props.getProperty('ULTIMO') || 0);
  for (let start = 0; ; start += 100) {
    const hilos = GmailApp.search(q, start, 100);
    if (!hilos.length) break;
    hilos.forEach(h => h.getMessages().forEach(m => {
      if (m.getDate() < desde || (hasta && m.getDate() >= hasta) || !/notifier@tokkobroker\.com/i.test(m.getFrom())) return;
      pendientes.push({ gmail_id: m.getId(), fecha: m.getDate().toISOString(), asunto: m.getSubject(), html: m.getBody() });
      maxFecha = Math.max(maxFecha, m.getDate().getTime());
    }));
    if (hilos.length < 100) break;
  }
  for (let i = 0; i < pendientes.length; i += LOTE) {
    const res = UrlFetchApp.fetch(PANEL_FUNCION, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-cron-secret': SECRETO },
      payload: JSON.stringify({ mensajes: pendientes.slice(i, i + LOTE) }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('El panel respondió ' + res.getResponseCode() + ': ' + res.getContentText());
    enviados += Math.min(LOTE, pendientes.length - i);
  }
  if (maxFecha) props.setProperty('ULTIMO', String(maxFecha));
  return enviados;
}
