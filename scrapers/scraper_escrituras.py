import requests
import re
import json
import os

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://yjfleshetpwdyoyeciaf.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY')

if not SUPABASE_KEY:
    raise RuntimeError('Falta la variable de entorno SUPABASE_KEY')

MESES = {
    'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,
    'julio':7,'agosto':8,'septiembre':9,'octubre':10,'noviembre':11,'diciembre':12
}

HEADERS_SB = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=ignore-duplicates'
}

def get_article_urls(max_articles=24):
    urls = []
    page = 1
    while len(urls) < max_articles:
        url = f'https://www.colegio-escribanos.org.ar/category/estadisticas-de-escrituras/' + (f'page/{page}/' if page > 1 else '')
        r = requests.get(url, timeout=15)
        found = re.findall(r'href="(https://www\.colegio-escribanos\.org\.ar/\d{4}/\d{2}/\d{2}/cantidad-de-escrituras-de-compraventa-realizadas[^"]*)"', r.text)
        found = list(dict.fromkeys(found))
        urls.extend(found)
        if len(found) == 0:
            break
        page += 1
    return urls[:max_articles]

def parse_article(url):
    r = requests.get(url, timeout=15)
    text = r.text

    titulo_match = re.search(r'<title>([^<]+)</title>', text)
    titulo = titulo_match.group(1).lower() if titulo_match else ''
    mes = None
    for nombre, num in MESES.items():
        if nombre in titulo:
            mes = num
            break
    anio_match = re.search(r'20(\d{2})', titulo)
    anio = int('20' + anio_match.group(1)) if anio_match else None

    if not mes or not anio:
        return None

    fecha_match = re.search(r'/(\d{4})/(\d{2})/(\d{2})/', url)
    fecha_pub = f"{fecha_match.group(1)}-{fecha_match.group(2)}-{fecha_match.group(3)}" if fecha_match else None

    clean = re.sub(r'<[^>]+>', ' ', text)
    clean = re.sub(r'\s+', ' ', clean)

    # cantidad total del mes
    cantidad = None
    m = re.search(r'(?:al sumar|totalizaron|sumaron|registraron)[^\d]*(\d[\d\.]+)', clean, re.IGNORECASE)
    if m:
        cantidad = int(m.group(1).replace('.',''))

    # variación interanual
    var_pct = None
    for pat, sign in [
        (r'(\d+[,\.]?\d*)\s*%[^.]*(?:suba|aumento|alza|incremento|crecimiento)', 1),
        (r'(\d+[,\.]?\d*)\s*%[^.]*(?:baja|descenso|caída|caida|disminución|disminucion|retroceso)', -1),
        (r'(?:suba|aumento|alza|incremento|crecimiento)[^.]*?(\d+[,\.]?\d*)\s*%', 1),
        (r'(?:baja|descenso|caída|caida|disminución|disminucion|retroceso)[^.]*?(\d+[,\.]?\d*)\s*%', -1),
    ]:
        m = re.search(pat, clean, re.IGNORECASE)
        if m:
            var_pct = sign * float(m.group(1).replace(',','.'))
            break

    # acumulado YTD
    acumulado = None
    for patron_acum in [
        r'acumularon[^\d]*(\d[\d\.]+)',
        r'acumulado[^\d]*(\d[\d\.]+)',
        r'en\s+lo\s+que\s+va\s+del\s+a[ñn]o[^\d]*(\d[\d\.]+)',
        r'acumulan[^\d]*(\d[\d\.]+)',
        r'(\d[\d\.]+)[^\d]*en\s+los\s+\w+\s+meses\s+del\s+a[ñn]o',
    ]:
        m = re.search(patron_acum, clean, re.IGNORECASE)
        if m:
            val = int(m.group(1).replace('.',''))
            if cantidad and val >= cantidad and val < 150000:
                acumulado = val
                break

    # escrituras con hipoteca — el artículo dice "X escrituras formalizadas con hipoteca"
    hipoteca = None
    for patron_hip in [
        r'(\d[\d\.]+)\s*escrituras?\s*formalizadas?\s*con\s*hipoteca',
        r'(\d[\d\.]+)[^\d]{0,30}escrituras?\s*con\s*hip',
        r'escrituras?\s*(?:formalizadas?\s*)?con\s*hipoteca[^\d]*(\d[\d\.]+)',
        r'(\d[\d\.]+)[^\d]{0,20}con\s*garant[íi]a\s*hipotecaria',
    ]:
        m = re.search(patron_hip, clean, re.IGNORECASE)
        if m:
            val = int(m.group(1).replace('.',''))
            # debe ser menor al total mensual y al menos 100
            if cantidad and val < cantidad and val >= 100:
                hipoteca = val
                break

    # monto en millones
    monto = None
    m = re.search(r'\$\s*([\d\.]+)\s*millones', clean, re.IGNORECASE)
    if m:
        monto = float(m.group(1).replace('.','').replace(',','.'))

    return {
        'mes': mes,
        'anio': anio,
        'cantidad': cantidad,
        'monto_millones': monto,
        'var_interanual_pct': var_pct,
        'acumulado_ytd': acumulado,
        'escrituras_hipoteca': hipoteca,
        'fecha_publicacion': fecha_pub
    }

def count_supabase():
    r = requests.get(
        f'{SUPABASE_URL}/rest/v1/escrituras_mercado?select=id',
        headers={**HEADERS_SB, 'Prefer': 'count=exact'},
        timeout=10
    )
    content_range = r.headers.get('Content-Range', '')
    m = re.search(r'/(\d+)', content_range)
    return int(m.group(1)) if m else 0

def insert_record(record):
    r = requests.post(
        f'{SUPABASE_URL}/rest/v1/escrituras_mercado',
        headers=HEADERS_SB,
        data=json.dumps(record),
        timeout=10
    )
    return r.status_code in (200, 201, 204)

def main():
    print('Consultando Supabase...')
    total_existentes = count_supabase()
    print(f'Registros existentes en Supabase: {total_existentes}')

    modo = 'historico' if total_existentes < 12 else 'mensual'
    max_art = 24 if modo == 'historico' else 1
    print(f'Modo: {modo} — procesando {max_art} artículo(s)')

    print('Obteniendo URLs del Colegio de Escribanos...')
    urls = get_article_urls(max_art)
    print(f'Artículos encontrados: {len(urls)}')

    insertados = 0
    errores = 0
    for url in urls:
        try:
            data = parse_article(url)
            if not data:
                print(f'  No se pudo parsear: {url}')
                errores += 1
                continue
            ok = insert_record(data)
            status = 'OK' if ok else 'YA EXISTIA'
            if ok:
                insertados += 1
            print(f'  {data["mes"]}/{data["anio"]} — {data["cantidad"]} escrituras — hip: {data["escrituras_hipoteca"]} — acum: {data["acumulado_ytd"]} — {status}')
        except Exception as e:
            print(f'  Error en {url}: {e}')
            errores += 1

    print(f'\nListo. Insertados: {insertados} | Errores: {errores}')

if __name__ == '__main__':
    main()
