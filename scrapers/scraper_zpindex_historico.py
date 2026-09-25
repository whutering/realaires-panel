"""
Carga histórica de precios USD/m2 (INDEX) desde PDFs mensuales.
Descarga PDFs desde el inicio disponible hasta el mes anterior al actual.
Ejecutar una sola vez desde GitHub Actions (workflow_dispatch) o localmente.

Uso:
  SUPABASE_URL=... SUPABASE_KEY=... python scraper_zpindex_historico.py
  # Opcional: limitar rango
  SUPABASE_URL=... SUPABASE_KEY=... python scraper_zpindex_historico.py --desde 2022-01 --hasta 2026-07
"""

import requests
import pdfplumber
import io
import json
import os
import re
import argparse
import time
from datetime import date
from dateutil.relativedelta import relativedelta

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://yjfleshetpwdyoyeciaf.supabase.co')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY')

if not SUPABASE_KEY:
    raise RuntimeError('Falta la variable de entorno SUPABASE_KEY')

HEADERS_SB = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=ignore-duplicates',
}

HEADERS_WEB = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/pdf,*/*',
}

ZONAS = {
    'CABA': 'https://www.zonaprop.com.ar/blog/wp-content/uploads/{pub_year}/{pub_month:02d}/INDEX_CABA_REPORTE_{data_year}-{data_month:02d}.pdf',
    'GBA_NORTE': 'https://www.zonaprop.com.ar/blog/wp-content/uploads/{pub_year}/{pub_month:02d}/INDEX_GBA_NORTE_REPORTE_{data_year}-{data_month:02d}.pdf',
}

# El PDF se publica ~1 mes después del mes de datos
# Pero a veces con retraso de 2 meses — probamos ambos offsets
PUB_OFFSETS = [1, 2]


def build_pdf_url(zona_key, data_year, data_month, pub_offset=1):
    pub_date = date(data_year, data_month, 1) + relativedelta(months=pub_offset)
    return ZONAS[zona_key].format(
        pub_year=pub_date.year,
        pub_month=pub_date.month,
        data_year=data_year,
        data_month=data_month,
    )


def descargar_pdf(zona_key, data_year, data_month):
    """Intenta descargar el PDF probando distintos offsets de publicación."""
    for offset in PUB_OFFSETS:
        url = build_pdf_url(zona_key, data_year, data_month, offset)
        try:
            r = requests.get(url, headers=HEADERS_WEB, timeout=60)
            if r.status_code == 200 and r.content[:4] == b'%PDF':
                print(f'    Descargado (offset +{offset}m): {url[-60:]} — {len(r.content)//1024}KB')
                return r.content
            elif r.status_code == 200:
                print(f'    Respuesta no es PDF (offset +{offset}m), probando siguiente...')
            else:
                print(f'    HTTP {r.status_code} (offset +{offset}m), probando siguiente...')
        except Exception as e:
            print(f'    Error (offset +{offset}m): {e}')
    return None


def extraer_precio_index(pdf_bytes, zona, data_year, data_month):
    """
    Extrae el precio INDEX (precio general) del PDF.
    Estrategia 1: buscar tabla con fila del mes buscado.
    Estrategia 2: buscar en texto plano "USD X.XXX por m2" en las primeras páginas.
    Retorna un dict o None.
    """
    meses_es = ['', 'ene', 'feb', 'mar', 'abr', 'may', 'jun',
                 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        # Estrategia 1: buscar en tablas (primeras 10 páginas)
        for page in pdf.pages[:10]:
            table = page.extract_table()
            if table:
                for row in table:
                    if not row:
                        continue
                    row_text = [str(c or '').strip() for c in row]
                    fecha_cell = row_text[0] if row_text else ''
                    if _fecha_match(fecha_cell, data_year, data_month, meses_es):
                        # Primera columna numérica después de la fecha = INDEX
                        for cell in row_text[1:]:
                            precio = _parse_precio(cell)
                            if precio and 500 < precio < 15000:
                                return precio

        # Estrategia 2: buscar patrón de precio en texto de primeras páginas
        for page in pdf.pages[:8]:
            text = page.extract_text() or ''
            # Patrones: "USD 2.476 por m2", "USD2.476/m2", "$2.476"
            for pattern in [
                r'USD\s*(\d[\d\.]+)\s*(?:por\s*m2|/m2)',
                r'precio\s+(?:medio|index)[^\d]*(\d[\d\.]{3,})',
                r'\$\s*(\d[\d\.]{3,})',
            ]:
                m = re.search(pattern, text, re.IGNORECASE)
                if m:
                    precio = _parse_precio(m.group(1))
                    if precio and 500 < precio < 15000:
                        return precio

    return None


def _fecha_match(texto, anio, mes, meses_es):
    if not texto:
        return False
    if f'{anio}-{mes:02d}' in texto:
        return True
    sufijo = str(anio)[-2:]
    if meses_es[mes] in texto.lower() and sufijo in texto:
        return True
    return False


def _parse_precio(texto):
    if not texto:
        return None
    # Eliminar todo excepto dígitos (los puntos de miles se eliminan también)
    limpio = re.sub(r'[^\d]', '', str(texto))
    try:
        val = int(limpio)
        return val if val > 0 else None
    except:
        return None


def calcular_variacion(zona, anio, mes, precio_actual):
    """Busca el precio del mes anterior en Supabase para calcular variación."""
    mes_ant = mes - 1
    anio_ant = anio
    if mes_ant == 0:
        mes_ant = 12
        anio_ant -= 1
    try:
        resp = requests.get(
            f'{SUPABASE_URL}/rest/v1/zpindex_mercado',
            headers={**HEADERS_SB, 'Prefer': ''},
            params={
                'zona': f'eq.{zona}',
                'anio': f'eq.{anio_ant}',
                'mes': f'eq.{mes_ant}',
                'segmento': 'eq.INDEX',
                'select': 'precio_usd_m2',
            },
            timeout=10,
        )
        data = resp.json()
        if data and data[0].get('precio_usd_m2'):
            prev = float(data[0]['precio_usd_m2'])
            return round((precio_actual - prev) / prev * 100, 2)
    except:
        pass
    return None


def insertar(zona, anio, mes, precio, variacion):
    record = {
        'zona': zona,
        'anio': anio,
        'mes': mes,
        'segmento': 'INDEX',
        'precio_usd_m2': precio,
        'var_mensual_pct': variacion,
    }
    resp = requests.post(
        f'{SUPABASE_URL}/rest/v1/zpindex_mercado',
        headers=HEADERS_SB,
        data=json.dumps(record),
        timeout=10,
    )
    return resp.status_code in (200, 201, 204)


def procesar_mes(zona_key, data_year, data_month):
    print(f'  {zona_key} {data_month:02d}/{data_year}...', end=' ')
    pdf_bytes = descargar_pdf(zona_key, data_year, data_month)
    if not pdf_bytes:
        print('PDF no disponible')
        return False

    precio = extraer_precio_index(pdf_bytes, zona_key, data_year, data_month)
    if not precio:
        print('precio no extraído')
        return False

    variacion = calcular_variacion(zona_key, data_year, data_month, precio)
    ok = insertar(zona_key, data_year, data_month, precio, variacion)
    var_str = f'{variacion:+.2f}%' if variacion is not None else 'sin var.'
    print(f'USD {precio}/m2 ({var_str}) — {"OK" if ok else "ya existía / error"}')
    return ok


def main():
    parser = argparse.ArgumentParser(description='Carga histórica ZP Index')
    parser.add_argument('--desde', default='2020-01', help='Mes inicial YYYY-MM')
    parser.add_argument('--hasta', default=None, help='Mes final YYYY-MM (default: mes anterior)')
    args = parser.parse_args()

    hoy = date.today()
    mes_hasta = date(hoy.year, hoy.month, 1) - relativedelta(months=1)

    # Parsear desde
    desde_parts = args.desde.split('-')
    mes_desde = date(int(desde_parts[0]), int(desde_parts[1]), 1)

    # Parsear hasta
    if args.hasta:
        hasta_parts = args.hasta.split('-')
        mes_hasta = date(int(hasta_parts[0]), int(hasta_parts[1]), 1)

    print(f'Carga histórica ZP Index')
    print(f'Rango: {mes_desde.strftime("%m/%Y")} → {mes_hasta.strftime("%m/%Y")}')
    print(f'Zonas: {", ".join(ZONAS.keys())}')
    print()

    mes_actual = mes_desde
    total_ok = 0
    total_fail = 0

    while mes_actual <= mes_hasta:
        print(f'[{mes_actual.strftime("%m/%Y")}]')
        for zona_key in ZONAS:
            ok = procesar_mes(zona_key, mes_actual.year, mes_actual.month)
            if ok:
                total_ok += 1
            else:
                total_fail += 1
            time.sleep(1)  # Cortesía al servidor
        mes_actual += relativedelta(months=1)

    print(f'\nResumen: {total_ok} insertados | {total_fail} fallidos/ya existían')


if __name__ == '__main__':
    main()
