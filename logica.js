// =====================================================================
// LÓGICA DEL SEMÁFORO DE PARTE DEL MAR
// La usan la app (index.html, en el navegador) y el aviso de Telegram
// (robot/aviso.js, en GitHub). Así los dos dicen siempre lo mismo.
// Recibe la configuración de config.json.
// =====================================================================

function crearLogica(config) {
  const ARTES = config.artes;
  const ZONAS = config.zonas;
  const ESPECIES = config.especies;
  const VEDAS = config.vedas.lista;
  const LIMITES = config.limites;

  const DIAS  = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const ORDEN = { verde: 0, amarillo: 1, rojo: 2 };

  // ---------- Fechas ("AAAA-MM-DD") ----------

  function aFecha(texto) {             // a mediodía, para evitar líos de horario
    const [a, m, d] = texto.split("-").map(Number);
    return new Date(a, m - 1, d, 12);
  }

  function aTexto(fecha) {
    const m = String(fecha.getMonth() + 1).padStart(2, "0");
    const d = String(fecha.getDate()).padStart(2, "0");
    return `${fecha.getFullYear()}-${m}-${d}`;
  }

  function sumarDias(texto, n) {
    const f = aFecha(texto);
    f.setDate(f.getDate() + n);
    return aTexto(f);
  }

  function corta(texto) {              // "jue 12"
    const f = aFecha(texto);
    return `${DIAS[f.getDay()]} ${f.getDate()}`;
  }

  function larga(texto) {              // "jue 12 nov"
    const f = aFecha(texto);
    return `${DIAS[f.getDay()]} ${f.getDate()} ${MESES[f.getMonth()]}`;
  }

  // ---------- Luna ----------
  // ¿Está la fecha a 2 días o menos de la luna llena? Ciclo medio de 29,53 días
  // contado desde una luna nueva conocida (6 ene 2000, 18:14 UTC).
  function cercaDeLunaLlena(texto) {
    const CICLO = 29.530588853;
    const LUNA_NUEVA = Date.UTC(2000, 0, 6, 18, 14);
    const dias = (aFecha(texto).getTime() - LUNA_NUEVA) / 86400000;
    const edad = ((dias % CICLO) + CICLO) % CICLO;
    return Math.abs(edad - CICLO / 2) <= 2;
  }

  // ---------- Vedas ----------

  // ¿Está la veda activa en esa fecha? Admite fechas fijas y anuales ("MM-DD")
  function vedaActiva(v, texto) {
    if (v.validaHasta && texto > v.validaHasta) return false;
    if (v.desde.length === 5) {                 // anual, puede cruzar el año nuevo
      const md = texto.slice(5);
      return v.desde <= v.hasta ? (md >= v.desde && md <= v.hasta)
                                : (md >= v.desde || md <= v.hasta);
    }
    return texto >= v.desde && (v.hasta === null || texto <= v.hasta);
  }

  // Veda de todo el arte, o también de una especie si se indica
  function buscarVeda(zonaId, arte, texto, especieId) {
    return VEDAS.find(v => v.zonas.includes(zonaId) && v.arte === arte
      && (!v.especie || v.especie === especieId) && vedaActiva(v, texto));
  }

  // Vedas de una sola especie activas en una zona y un día
  function vedasDeEspecie(zonaId, texto) {
    return VEDAS.filter(v => v.especie && v.zonas.includes(zonaId) && vedaActiva(v, texto));
  }

  // Vedas que empiezan o terminan en los próximos "dias" días (para avisar)
  function cambiosDeVeda(hoy, dias) {
    const cambios = [];
    for (let i = 1; i <= dias; i++) {
      const f = sumarDias(hoy, i), antes = sumarDias(f, -1);
      VEDAS.forEach(v => {
        const ahora = vedaActiva(v, f), ayer = vedaActiva(v, antes);
        if (ahora && !ayer) cambios.push({ fecha: f, tipo: "empieza", veda: v });
        if (!ahora && ayer) cambios.push({ fecha: f, tipo: "termina", veda: v });
      });
    }
    return cambios;
  }

  // ---------- Semáforo ----------

  function colorTiempo(viento, ola) {
    const motivos = [];
    let color = "verde";
    const subir = (c, m) => { motivos.push(m); if (ORDEN[c] > ORDEN[color]) color = c; };

    if (viento === null || viento === undefined) subir("amarillo", "sin dato de viento");
    else if (viento >= LIMITES.vientoRojo) subir("rojo", "viento fuerte");
    else if (viento >= LIMITES.vientoAmarillo) subir("amarillo", "viento fresco");

    if (ola === null || ola === undefined) subir("amarillo", "sin dato de ola");
    else if (ola >= LIMITES.olaRoja) subir("rojo", "mar gruesa");
    else if (ola >= LIMITES.olaAmarilla) subir("amarillo", "marejada fuerte");

    return { color, motivos };
  }

  // Color de un arte en una zona y un día: tiempo + veda + luna + fin de semana
  function colorArte(zona, arte, dia, especieId) {
    const t = colorTiempo(dia.viento, dia.ola);
    let color = t.color;
    const motivos = [...t.motivos];
    const subir = (c, m) => { motivos.push(m); if (ORDEN[c] > ORDEN[color]) color = c; };

    const veda = buscarVeda(zona.id, arte, dia.fecha, especieId);
    if (veda) subir("rojo", "veda: " + veda.motivo);

    if (ARTES[arte].luna && cercaDeLunaLlena(dia.fecha)) subir("amarillo", "luna llena");

    const diaSemana = aFecha(dia.fecha).getDay();   // 0 = domingo, 6 = sábado
    if (zona.espana && ARTES[arte].finDeSemana && (diaSemana === 0 || diaSemana === 6)) {
      subir("amarillo", "fin de semana");
    }

    const texto = { verde: "Sale", amarillo: "Dudoso", rojo: "No sale" }[color];
    return { color, texto, motivos };
  }

  // Oferta prevista de una especie en una fecha: media PONDERADA de sus zonas
  // (verde = 1, amarillo = 0,5, rojo = 0). Cada origen es [zona, arte, peso];
  // el peso es opcional (1 si no se pone): las zonas que más te abastecen pesan más.
  // datosPorZona = { zonaId: [días] }
  function ofertaEspecie(especie, datosPorZona, fecha) {
    let suma = 0, pesos = 0;
    especie.origen.forEach(([zonaId, arte, peso = 1]) => {
      const dia = (datosPorZona[zonaId] || []).find(d => d.fecha === fecha);
      if (!dia) return;                        // zona sin datos: no cuenta
      const zona = ZONAS.find(z => z.id === zonaId);
      const c = colorArte(zona, arte, dia, especie.id).color;
      suma += { verde: 1, amarillo: 0.5, rojo: 0 }[c] * peso;
      pesos += peso;
    });
    if (!pesos) return null;
    const media = suma / pesos;
    if (media >= 0.67) return { nivel: "bien", texto: "Hay",       color: "verde" };
    if (media >= 0.34) return { nivel: "poco", texto: "Poco",      color: "amarillo" };
    return                   { nivel: "nada", texto: "Casi nada", color: "rojo" };
  }

  return {
    ARTES, ZONAS, ESPECIES, VEDAS, LIMITES,
    aFecha, aTexto, sumarDias, corta, larga,
    cercaDeLunaLlena, vedaActiva, buscarVeda, vedasDeEspecie, cambiosDeVeda,
    colorTiempo, colorArte, ofertaEspecie
  };
}

// En Node (el aviso de Telegram) se exporta; en el navegador queda como función global
if (typeof module !== "undefined") module.exports = { crearLogica };
