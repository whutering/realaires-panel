"""
Scraper de precios de mercado inmobiliario (USD/m2)
Fuentes: reportes mensuales de precio de CABA y GBA Norte
GitHub Actions: corre días 1-5 de cada mes a las 12:00 UTC
"""

import requests
import pdfplumber
import io
import json
import os
import re
from datetime import date, datetime
from dateutil.relativedelta import relativedelta

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

# URLs de las páginas del index para detectar el PDF más reciente
ZONAS = {
    'CABA': {
        'page_url': 'https://www.zonaprop.com.ar/blog/zpindex/',
        'pdf_pattern': r'href="([^"]*INDEX_CABA_REPORTE[^"]*\.pdf)"',
        'url_template': 'https://www.zonaprop.com.ar/blog/wp-content/uploads/{pub_year}/{pub_month:02d}/INDEX_CABA_REPORTE_{data_year}-{data_month:02d}.pdf',
    },
    'GBA_NORTE': {
        'page_url': 'https://www.zonaprop.com.ar/blog/zpindex/gba-venta/',
        'pdf_pattern': r'href="([^"]*INDEX_GBA_NORTE_REPORTE[^"]*\.pdf)"',
        'url_template': 'https://www.zonaprop.com.ar/blog/wp-content/uploads/{pub_year}/{pub_month:02d}/INDEX_GBA_NORTE_REPORTE_{data_year}-{data_month:02d}.pdf',
    },
}

SEGMENTOS = ['INDEX', 'ESTRENAR', 'POZO', 'USADO']

HEADERS_WEB = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}


def get_pdf_url(zona_key, data_year, data_month):
    """Obtiene la URL del PDF dinámicamente o la construye con el patrón conocido."""
    config = ZONAS[zona_key]
    # Mes de publicación = mes siguiente al mes de datos
    pub_date = date(data_year, data_month, 1) + relativedelta(months=1)

    # Intentar obtener URL desde la página
    try:
        r = requests.get(config['page_url'], headers=HEADERS_WEB, timeout=20)
        m = re.search(config['pdf_pattern'], r.text, re.IGNORECASE)
        if m:
            url = m.group(1)
            print(f'  URL detectada en página: {url}')
            return url
    except Exception as e:
        print(f'  Advertencia al leer página ({e}), usando URL construida')

    # Fallback: construir URL con patrón
    url = config['url_template'].format(
        pub_year=pub_date.year,
        pub_month=pub_date.month,
        data_year=data_year,
        data_month=data_month,
    )
    print(f'  URL construida: {url}')
    return url


def parse_pdf_caba(pdf_bytes, data_year, data_month):
    """
    Extrae precio USD/m2 por segmento del PDF de CABA.
    El PDF contiene una tabla con columnas: Fecha | Precio INDEX | Estrenar | Pozo | Usado | Var. mensual
    """
    records = []
    target_label = f'{data_year}-{data_month:02d}'

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            # Intentar extraer tabla
            table = page.extract_table()
            if table:
                for row in table:
                    if not row:
                        continue
                    row_text = [str(c or '').strip() for c in row]
                    # Buscar fila que corresponde al mes/año buscado
                    # El PDF suele tener fechas en formato "ene-26", "ago-26", o "2026-08"
                    fecha_cell = row_text[0] if row_text else ''
                    if not _fecha_match(fecha_cell, data_year, data_month):
                        continue

                    # Extraer precios para cada segmento
                    # Columnas típicas: [fecha, index, estrenar, pozo, usado, var_mensual]
                    for i, segmento in enumerate(SEGMENTOS):
                        col_idx = i + 1
                        if col_idx < len(row_text):
                            precio = _parse_numero(row_text[col_idx])
                            if precio and 500 < precio < 10000:
                                records.append({
                                    'zona': 'CABA',
                                    'anio': data_year,
                                    'mes': data_month,
                                    'segmento': segmento,
                                    'precio_usd_m2': precio,
                                    'var_mensual_pct': None,
                                })

            # Si no encontró tabla, buscar en texto
            if not records:
                text = page.extract_text() or ''
                records.extend(_parse_texto(text, 'CABA', data_year, data_month))

    return records


def parse_pdf_gba(pdf_bytes, data_year, data_month):
    """Extrae precio USD/m2 por segmento del PDF de GBA Norte (misma estructura que CABA)."""
    records = []

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            table = page.extract_table()
            if table:
                for row in table:
                    if not row:
                        continue
                    row_text = [str(c or '').strip() for c in row]
                    fecha_cell = row_text[0] if row_text else ''
                    if not _fecha_match(fecha_cell, data_year, data_month):
                        continue

                    for i, segmento in enumerate(SEGMENTOS):
                        col_idx = i + 1
                        if col_idx < len(row_text):
                            precio = _parse_numero(row_text[col_idx])
                            if precio and 500 < precio < 10000:
                                records.append({
                                    'zona': 'GBA_NORTE',
                                    'anio': data_year,
                                    'mes': data_month,
                                    'segmento': segmento,
                                    'precio_usd_m2': precio,
                                    'var_mensual_pct': None,
                                })

            if not records:
                text = page.extract_text() or ''
                records.extend(_parse_texto(text, 'GBA_NORTE', data_year, data_month))

    return records


def _fecha_match(texto, anio, mes):
    """Verifica si un texto de fecha corresponde al año/mes buscado."""
    if not texto:
        return False
    # Formato YYYY-MM
    if f'{anio}-{mes:02d}' in texto:
        return True
    # Formato abreviado español: ene, feb, mar, abr, may, jun, jul, ago, sep, oct, nov, dic
    meses_es = ['', 'ene', 'feb', 'mar', 'abr', 'may', 'jun',
                 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
    sufijo_anio = str(anio)[-2:]
    if meses_es[mes] in texto.lower() and sufijo_anio in texto:
        return True
    return False


def _parse_numero(texto):
    """Convierte texto de precio a número entero."""
    if not texto:
        return None
    limpio = re.sub(r'[^\d,\.]', '', texto).replace(',', '').replace('.', '')
    try:
        val = int(limpio)
        return val if val > 0 else None
    except:
        return None


def _parse_texto(text, zona, data_year, data_month):
    """Fallback: extrae precios del texto plano del PDF buscando patrones."""
    records = []
    # Buscar USD 2.476/m2 o $2.476 o 2476
    # Buscar líneas que mencionen cada segmento
    seg_patterns = {
        'INDEX': r'(?:index|precio medio)[^\d]*(\d[\d\.]{3,})',
        'ESTRENAR': r'estrenar[^\d]*(\d[\d\.]{3,})',
        'POZO': r'(?:en pozo|pozo)[^\d]*(\d[\d\.]{3,})',
        'USADO': r'usado[^\d]*(\d[\d\.]{3,})',
    }
    for segmento, pattern in seg_patterns.items():
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            precio = _parse_numero(m.group(1))
            if precio and 500 < precio < 10000:
                records.append({
                    'zona': zona,
                    'anio': data_year,
                    'mes': data_month,
                    'segmento': segmento,
                    'precio_usd_m2': precio,
                    'var_mensual_pct': None,
                })
    return records


def calcular_variacion(records_new, zona):
    """Calcula variación mensual comparando con el dato del mes anterior en Supabase."""
    for r in records_new:
        mes_ant = r['mes'] - 1
        anio_ant = r['anio']
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
                    'segmento': f'eq.{r["segmento"]}',
                    'select': 'precio_usd_m2',
                },
                timeout=10
            )
            data = resp.json()
            if data and data[0].get('precio_usd_m2'):
                precio_ant = float(data[0]['precio_usd_m2'])
                precio_act = float(r['precio_usd_m2'])
                r['var_mensual_pct'] = round((precio_act - precio_ant) / precio_ant * 100, 2)
        except:
            pass
    return records_new


def insertar(records):
    """Inserta registros en Supabase (ignora duplicados)."""
    insertados = 0
    ya_existian = 0
    for r in records:
        resp = requests.post(
            f'{SUPABASE_URL}/rest/v1/zpindex_mercado',
            headers=HEADERS_SB,
            data=json.dumps(r),
            timeout=10
        )
        if resp.status_code in (200, 201, 204):
            insertados += 1
            print(f'  OK: {r["zona"]} {r["mes"]}/{r["anio"]} {r["segmento"]} = USD {r["precio_usd_m2"]}/m2')
        else:
            ya_existian += 1
            print(f'  YA EXISTIA: {r["zona"]} {r["mes"]}/{r["anio"]} {r["segmento"]}')
    return insertados, ya_existian


def procesar_zona(zona_key, data_year, data_month):
    """Descarga PDF y extrae datos para una zona y mes dados."""
    print(f'\n--- {zona_key} {data_month}/{data_year} ---')
    url = get_pdf_url(zona_key, data_year, data_month)

    try:
        r = requests.get(url, headers=HEADERS_WEB, timeout=60)
        if r.status_code != 200:
            print(f'  Error HTTP {r.status_code} — PDF no disponible aún')
            return []
        print(f'  PDF descargado: {len(r.content) // 1024} KB')
    except Exception as e:
        print(f'  Error al descargar PDF: {e}')
        return []

    if zona_key == 'CABA':
        records = parse_pdf_caba(r.content, data_year, data_month)
    else:
        records = parse_pdf_gba(r.content, data_year, data_month)

    if not records:
        print(f'  No se pudieron extraer datos del PDF. Verificar estructura.')
        return []

    print(f'  Extraídos: {len(records)} registros')
    records = calcular_variacion(records, zona_key)
    return records


def main():
    hoy = date.today()
    # Datos del mes anterior (publicados a principios del mes actual)
    mes_datos = hoy - relativedelta(months=1)
    data_year = mes_datos.year
    data_month = mes_datos.month

    print(f'Scraper ZP Index - ejecutando {hoy}')
    print(f'Extrayendo datos de: {data_month}/{data_year}')

    total_ins = 0
    total_dup = 0

    for zona_key in ZONAS:
        records = procesar_zona(zona_key, data_year, data_month)
        if records:
            ins, dup = insertar(records)
            total_ins += ins
            total_dup += dup

    print(f'\nResumen: insertados={total_ins} | ya existían={total_dup}')


if __name__ == '__main__':
    main()
