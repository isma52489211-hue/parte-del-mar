"""
Robot de Parte del Mar.

Descarga la previsión de viento (MET Norway) y de olas (Copernicus Marine)
para cada zona y la guarda en datos.json, que es lo que lee la app.

Lo ejecuta GitHub Actions cada pocas horas (ver .github/workflows/actualizar.yml).
Para probarlo a mano:  python robot/actualizar.py

Las olas necesitan las variables de entorno COPERNICUSMARINE_SERVICE_USERNAME
y COPERNICUSMARINE_SERVICE_PASSWORD (en GitHub se guardan como secretos).
Si faltan o Copernicus falla, el robot guarda igualmente el viento.
"""

import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ZONA_HORARIA = ZoneInfo("Europe/Madrid")
DIAS = 3
SALIDA = os.path.join(os.path.dirname(__file__), "..", "datos.json")

# MET Norway pide identificarse: nombre de la app y dónde contactar
USER_AGENT = "parte-del-mar github.com/isma52489211-hue/parte-del-mar"

# Modelos de olas de Copernicus Marine
OLAS_IBI = "cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i"   # Atlántico ibérico (unos 3 km)
OLAS_MED = "cmems_mod_med_wav_anfc_4.2km_PT1H-i"      # Mediterráneo (4,2 km)

# Un punto en el mar frente a los puertos de cada zona.
# Los "id" deben coincidir con los de la lista ZONAS de index.html.
ZONAS = [
    {"id": "huelva",       "lat": 37.05, "lon": -6.95, "olas": OLAS_IBI},
    {"id": "cadiz",        "lat": 36.50, "lon": -6.40, "olas": OLAS_IBI},
    {"id": "malaga",       "lat": 36.65, "lon": -4.40, "olas": OLAS_MED},
    {"id": "levante",      "lat": 39.35, "lon": -0.15, "olas": OLAS_MED},
    {"id": "cataluna",     "lat": 41.25, "lon":  2.25, "olas": OLAS_MED},
    {"id": "galicia",      "lat": 42.20, "lon": -9.00, "olas": OLAS_IBI},
    {"id": "it_adriatico", "lat": 43.40, "lon": 14.00, "olas": OLAS_MED},
    {"id": "it_sicilia",   "lat": 37.40, "lon": 13.00, "olas": OLAS_MED},
    {"id": "it_almeja",    "lat": 45.00, "lon": 12.50, "olas": OLAS_MED},
]


def fechas_previstas():
    """Hoy y los dos días siguientes, en hora de Madrid, como 'AAAA-MM-DD'."""
    hoy = datetime.now(ZONA_HORARIA).date()
    return [(hoy + timedelta(days=i)).isoformat() for i in range(DIAS)]


def maximo_por_dia(pares, fechas):
    """pares = [(instante UTC, valor)] -> {fecha local: máximo del día}"""
    maximos = {}
    for instante, valor in pares:
        if valor is None or (isinstance(valor, float) and math.isnan(valor)):
            continue
        fecha = instante.astimezone(ZONA_HORARIA).date().isoformat()
        if fecha in fechas:
            maximos[fecha] = max(maximos.get(fecha, valor), valor)
    return maximos


# ---------------------------------------------------------------------------
# VIENTO: MET Norway (licencia CC BY 4.0, uso comercial permitido)
# ---------------------------------------------------------------------------

def viento_met(zona, fechas):
    url = ("https://api.met.no/weatherapi/locationforecast/2.0/compact"
           f"?lat={zona['lat']:.2f}&lon={zona['lon']:.2f}")
    peticion = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(peticion, timeout=60) as respuesta:
        datos = json.load(respuesta)

    pares = []
    for paso in datos["properties"]["timeseries"]:
        instante = datetime.fromisoformat(paso["time"].replace("Z", "+00:00"))
        ms = paso["data"]["instant"]["details"].get("wind_speed")
        if ms is not None:
            pares.append((instante, ms * 3.6))   # m/s -> km/h
    return maximo_por_dia(pares, fechas)


# ---------------------------------------------------------------------------
# OLAS: Copernicus Marine (gratuito; licencia permite productos derivados)
# ---------------------------------------------------------------------------

def olas_copernicus(zona, fechas):
    import copernicusmarine   # solo se carga si hace falta

    inicio = datetime.fromisoformat(fechas[0]).replace(tzinfo=ZONA_HORARIA)
    fin = inicio + timedelta(days=DIAS)
    margen = 0.15   # grados alrededor del punto, para encontrar celdas de mar

    ds = copernicusmarine.open_dataset(
        dataset_id=zona["olas"],
        variables=["VHM0"],
        minimum_latitude=zona["lat"] - margen,
        maximum_latitude=zona["lat"] + margen,
        minimum_longitude=zona["lon"] - margen,
        maximum_longitude=zona["lon"] + margen,
        start_datetime=inicio.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
        end_datetime=fin.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S"),
    )
    ola = ds["VHM0"].load()

    # Celda de mar más cercana al punto (las de tierra no tienen dato)
    con_dato = ola.notnull().any("time")
    mejor, distancia_minima = None, None
    for la in ola["latitude"].values:
        for lo in ola["longitude"].values:
            if not bool(con_dato.sel(latitude=la, longitude=lo)):
                continue
            d = (la - zona["lat"]) ** 2 + (lo - zona["lon"]) ** 2
            if distancia_minima is None or d < distancia_minima:
                mejor, distancia_minima = (la, lo), d
    if mejor is None:
        return {}

    serie = ola.sel(latitude=mejor[0], longitude=mejor[1])
    pares = []
    for t, v in zip(serie["time"].values, serie.values):
        instante = datetime.fromisoformat(str(t)[:19]).replace(tzinfo=timezone.utc)
        pares.append((instante, float(v)))
    return maximo_por_dia(pares, fechas)


def con_reintentos(funcion, *argumentos, intentos=3, espera=20):
    """Repite la llamada si falla (los servidores a veces dan errores momentáneos)."""
    for intento in range(1, intentos + 1):
        try:
            return funcion(*argumentos)
        except Exception:
            if intento == intentos:
                raise
            time.sleep(espera)


def datos_anteriores():
    """Lee el datos.json anterior para reutilizar valores si una fuente falla."""
    try:
        with open(SALIDA, encoding="utf-8") as archivo:
            return json.load(archivo).get("zonas", {})
    except Exception:
        return {}


# ---------------------------------------------------------------------------

def main():
    fechas = fechas_previstas()
    anteriores = datos_anteriores()
    hay_credenciales = bool(os.environ.get("COPERNICUSMARINE_SERVICE_USERNAME"))
    resultado = {
        "generado": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "fechas": fechas,
        "fuentes": "Viento: MET Norway (CC BY 4.0). Olas: Copernicus Marine Service.",
        "zonas": {},
        "errores": [],
    }

    for zona in ZONAS:
        try:
            viento = con_reintentos(viento_met, zona, fechas)
        except Exception as e:
            viento = {}
            resultado["errores"].append(f"viento {zona['id']}: {e}")

        olas = {}
        if hay_credenciales:
            try:
                olas = con_reintentos(olas_copernicus, zona, fechas)
            except Exception as e:
                resultado["errores"].append(f"olas {zona['id']}: {e}")
        else:
            resultado["errores"].append(f"olas {zona['id']}: faltan las credenciales de Copernicus")

        # Si una fuente falló, reutilizamos el último valor bueno para esa fecha
        previo = {d["fecha"]: d for d in anteriores.get(zona["id"], [])}
        def valor(nuevos, clave, f, decimales):
            if f in nuevos:
                return round(nuevos[f], decimales)
            return previo.get(f, {}).get(clave)

        resultado["zonas"][zona["id"]] = [
            {
                "fecha": f,
                "viento": valor(viento, "viento", f, 1),
                "ola": valor(olas, "ola", f, 2),
            }
            for f in fechas
        ]
        print(zona["id"], resultado["zonas"][zona["id"]])

    with open(SALIDA, "w", encoding="utf-8") as archivo:
        json.dump(resultado, archivo, ensure_ascii=False, indent=1)
    print("Errores:", len(resultado["errores"]))
    for e in resultado["errores"]:
        print(" -", e)

    # Solo se considera fallo total si no hay ningún dato de viento
    if all(d["viento"] is None for dias in resultado["zonas"].values() for d in dias):
        sys.exit(1)


if __name__ == "__main__":
    main()
