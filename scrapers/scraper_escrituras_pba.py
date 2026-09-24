import requests
import re
import json
import io
import os

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://yjfleshetpwdyoyeciaf.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY')

if not SUPABASE_KEY:
    raise RuntimeError('Falta la variable de entorno SUPABASE_KEY')

HEADERS_SB = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=ignore-duplicates'
}

STATS_PAGE = 'https://www.colescba.org.ar/portal/sala-de-prensa/estadisticas'
PDF_URL_FALLBACK = 'https://www.colescba.org.ar/portal/wp-content/uploads/2026/09/Estad_compraventas_e_hipotecas_01_2005_al_08_2026_inm_bs.pdf'

def get_pdf_url():
    try:
        r = requests.get(STATS_PAGE, timeout=15)
        m = re.search(r'href="([^"]+Estad_compraventas[^"]+\.pdf)"', r.text, re.IGNORECASE)
        if not m:
            m = re.search(r'href="([^"]+compraventas[^"]+\.pdf)"', r.text, re.IGNORECASE)
        if m:
            url = m.group(1)
            if url.startswith('/'):
                url = 'https://www.colescba.org.ar' + url
            return url
    except Exception as e:
        print(f'Advertencia: no se pudo obtener URL dinámica ({e}), usando URL fija')
    return PDF_URL_FALLBACK

def parse_pdf(pdf_bytes):
    try:
        import pdfplumber
    except ImportError:
        import subprocess, sys
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'pdfplumber', '-q'])
        import pdfplumber

    records = []
    anio_actual = None

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            table = page.extract_table()
            if not table:
                continue
            for row in table:
                if not row or len(row) < 4:
                    continue
                col0 = str(row[0] or '').strip()
                col1 = str(row[1] or '').strip()

                if re.match(r'^20\d{2}$', col0):
                    anio_actual = int(col0)
                    mes_str = col1
                elif col0 == '' and re.match(r'^\d{1,2}$', col1):
                    mes_str = col1
                else:
                    continue

                if not anio_actual:
                    continue

                mes_str = mes_str.strip()
                if not re.match(r'^\d{1,2}$', mes_str):
                    continue
                mes = int(mes_str)
                if not (1 <= mes <= 12):
                    continue

                try:
                    cant_str = str(row[2] or '').strip().replace('.', '').replace(',', '')
                    cantidad = int(cant_str) if cant_str.isdigit() else None
                except:
                    cantidad = None

                try:
                    hip_str = str(row[4] or '').strip().replace('.', '').replace(',', '') if len(row) > 4 else ''
                    hipoteca = int(hip_str) if hip_str.isdigit() else None
                except:
                    hipoteca = None

                if cantidad:
                    records.append({
                        'mes': mes,
                        'anio': anio_actual,
                        'cantidad': cantidad,
                        'escrituras_hipoteca': hipoteca,
                        'var_interanual_pct': None,
                        'fecha_publicacion': None
                    })

    return records

def calcular_variacion(records):
    lookup = {(r['anio'], r['mes']): r['cantidad'] for r in records}
    for r in records:
        anterior = lookup.get((r['anio'] - 1, r['mes']))
        if anterior and r['cantidad'] and anterior > 0:
            r['var_interanual_pct'] = round((r['cantidad'] - anterior) / anterior * 100, 1)
    return records

def insert_record(record):
    r = requests.post(
        f'{SUPABASE_URL}/rest/v1/escrituras_mercado_pba',
        headers=HEADERS_SB,
        data=json.dumps(record),
        timeout=10
    )
    return r.status_code in (200, 201, 204)

def main():
    print('Buscando PDF en el Colegio de Escribanos de PBA...')
    pdf_url = get_pdf_url()
    print(f'PDF: {pdf_url}')

    print('Descargando PDF...')
    r = requests.get(pdf_url, timeout=60)
    print(f'Descargado: {len(r.content) / 1024:.0f} KB')

    print('Extrayendo datos...')
    records = parse_pdf(r.content)
    print(f'Registros extraídos: {len(records)}')

    if not records:
        print('No se encontraron datos. Verificar estructura del PDF.')
        return

    records = calcular_variacion(records)

    from datetime import date
    hoy = date.today()
    recientes = [
        r for r in records
        if (r['anio'] == hoy.year and r['mes'] <= hoy.month) or
           (r['anio'] == hoy.year - 1) or
           (r['anio'] == hoy.year - 2)
    ]
    print(f'Insertando últimos ~36 meses: {len(recientes)} registros')

    insertados = 0
    ya_existian = 0
    for record in recientes:
        ok = insert_record(record)
        if ok:
            insertados += 1
            print(f'  {record["mes"]}/{record["anio"]} — {record["cantidad"]} escrituras — OK')
        else:
            ya_existian += 1
            print(f'  {record["mes"]}/{record["anio"]} — YA EXISTIA')

    print(f'\nListo. Insertados: {insertados} | Ya existían: {ya_existian}')

if __name__ == '__main__':
    main()
