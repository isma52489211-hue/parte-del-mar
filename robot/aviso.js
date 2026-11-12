// =====================================================================
// AVISO DIARIO POR TELEGRAM
// Lee datos.json y config.json, calcula la previsión con la MISMA lógica
// que la app (logica.js) y manda un resumen al móvil.
//
// Necesita dos secretos en GitHub:
//   TELEGRAM_TOKEN   -> el que da @BotFather al crear el bot
//   TELEGRAM_CHAT_ID -> a quién enviar. Si falta, este script lo busca
//                       entre los mensajes recibidos y lo escribe en el registro.
// Para probarlo sin enviar nada:  node robot/aviso.js --prueba
// =====================================================================

const fs = require("fs");
const path = require("path");
const { crearLogica } = require("../logica.js");

const RAIZ = path.join(__dirname, "..");
const APP = "https://isma52489211-hue.github.io/parte-del-mar/";
const config = JSON.parse(fs.readFileSync(path.join(RAIZ, "config.json"), "utf8"));
const datos = JSON.parse(fs.readFileSync(path.join(RAIZ, "datos.json"), "utf8"));
const L = crearLogica(config);

// Fecha de hoy en España (el robot de GitHub funciona en hora UTC)
function hoyEnEspana() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
}

const ICONO = { verde: "🟢", amarillo: "🟡", rojo: "🔴" };

function lineaEspecies(fecha) {
  return L.ESPECIES.map(e => {
    const o = L.ofertaEspecie(e, datos.zonas, fecha);
    return o ? `${ICONO[o.color]} ${e.nombre}: ${o.texto.toLowerCase()}` : `⚪ ${e.nombre}: sin datos`;
  });
}

function componerMensaje() {
  const hoy = hoyEnEspana();
  const manana = L.sumarDias(hoy, 1);
  const pasado = L.sumarDias(hoy, 2);
  const lineas = [`<b>🌊 Parte del Mar · ${L.larga(hoy)}</b>`, ""];

  if (datos.fechas.includes(manana)) {
    lineas.push(`<b>Pesca de mañana, ${L.larga(manana)}</b>`);
    lineas.push("<i>(suele llegar a Mercacórdoba al día siguiente)</i>");
    lineas.push(...lineaEspecies(manana), "");
  }
  if (datos.fechas.includes(pasado)) {
    const resumen = L.ESPECIES.map(e => {
      const o = L.ofertaEspecie(e, datos.zonas, pasado);
      return o ? `${ICONO[o.color]} ${e.nombre}` : `⚪ ${e.nombre}`;
    });
    lineas.push(`<b>Pasado mañana, ${L.larga(pasado)}</b>`, resumen.join(" · "), "");
  }

  // Vedas que empiezan o terminan en la próxima semana
  const cambios = L.cambiosDeVeda(hoy, 7);
  if (cambios.length) {
    lineas.push("<b>📅 Vedas próximos 7 días</b>");
    cambios.forEach(c => {
      const zonas = c.veda.zonas.map(id => L.ZONAS.find(z => z.id === id).nombre).join(", ");
      const que = c.veda.especie ? L.ESPECIES.find(e => e.id === c.veda.especie).nombre.toLowerCase() : L.ARTES[c.veda.arte].nombre.toLowerCase();
      lineas.push(`${c.tipo === "empieza" ? "⛔ Empieza" : "✅ Termina"} el ${L.larga(c.fecha)}: ${que} en ${zonas}`);
    });
    lineas.push("");
  }

  // Aviso si los datos son viejos (el robot de datos podría estar fallando)
  const horas = Math.round((Date.now() - new Date(datos.generado)) / 3600000);
  if (horas > 12) lineas.push(`⚠️ Datos de hace ${horas} h: el robot de datos puede estar fallando.`, "");

  lineas.push(`<a href="${APP}">Abrir la app</a> · Orientativo, no sustituye al parte oficial.`);
  return lineas.join("\n");
}

async function telegram(metodo, cuerpo) {
  const token = process.env.TELEGRAM_TOKEN;
  const respuesta = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo || {})
  });
  const json = await respuesta.json();
  if (!json.ok) throw new Error(`Telegram ${metodo}: ${json.description}`);
  return json.result;
}

async function main() {
  const mensaje = componerMensaje();

  if (process.argv.includes("--prueba")) {
    console.log(mensaje);
    return;
  }
  if (!process.env.TELEGRAM_TOKEN) {
    console.log("Falta el secreto TELEGRAM_TOKEN: no se envía nada.");
    process.exit(1);
  }

  let chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    // Ayuda para la configuración: muestra quién ha escrito al bot
    const mensajes = await telegram("getUpdates");
    const chats = [...new Set(mensajes.map(m => (m.message || m.channel_post || {}).chat).filter(Boolean)
      .map(c => `${c.id} (${c.first_name || c.title || ""})`))];
    console.log("Falta TELEGRAM_CHAT_ID. Chats que han escrito al bot:", chats.length ? chats.join(", ") : "ninguno. Escribe cualquier cosa a tu bot y vuelve a lanzar esto.");
    process.exit(1);
  }

  await telegram("sendMessage", { chat_id: chatId, text: mensaje, parse_mode: "HTML", disable_web_page_preview: true });
  console.log("Aviso enviado.");
}

main().catch(e => { console.error(e.message); process.exit(1); });
