// Webhook de Meta WhatsApp Cloud API (paso 2 de la guia del reel).
// GET: verificacion (hub.challenge). POST: mensajes entrantes -> agente -> respuesta.
// Seguridad implementada (probada con fixtures en test/webhook.test.js, falta prueba real autorizada):
//  - Verificacion X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con WHATSAPP_APP_SECRET, timing-safe).
//  - Validacion de la forma del payload y limites (entradas, cambios, mensajes, largo de texto).
//  - Separacion por negocio: el phone_number_id de metadata elige la config del negocio y el
//    aislamiento de memoria es por (phone_number_id, cliente). Numeros no registrados se ignoran.
// Requiere env (NO configuradas sin go): WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET,
// WHATSAPP_TOKEN, WHATSAPP_CONFIG_JSON ({"<phone_number_id>": {nombre, servicios, ...}}),
// OPENROUTER_API_KEY (opcional: sin ella responde el motor demo).
// Persistencia real (DB) y auth del panel siguen pendientes: memoria en proceso solo para prueba.
const crypto = require('crypto');
const { responder } = require('../agent-core');

module.exports.config = { api: { bodyParser: false } };

// Memoria en proceso (suficiente para prueba en un solo lambda caliente; produccion: base de datos).
const memoria = global.__wa_memoria || (global.__wa_memoria = new Map());
// Citas compartidas por negocio (todos sus clientes): clave phone_number_id.
// Asi la prevencion de doble reserva funciona entre clientes distintos del mismo negocio.
const citasPorNegocio = global.__wa_citas || (global.__wa_citas = new Map());
const CONFIG_POR_NUMERO = global.__wa_cfg || (global.__wa_cfg = new Map());

function cargarConfigEnv() {
  try {
    const j = JSON.parse(process.env.WHATSAPP_CONFIG_JSON || '{}');
    for (const [k, v] of Object.entries(j)) if (v && typeof v === 'object') CONFIG_POR_NUMERO.set(k, v);
  } catch (e) { /* config invalida: se ignora, quedan solo las registradas en codigo */ }
}

async function cuerpoCrudo(req) {
  const partes = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error('cuerpo demasiado grande');
    partes.push(chunk);
  }
  return Buffer.concat(partes);
}

function verificarFirma(raw, firma, secreto) {
  if (typeof firma !== 'string' || !firma.startsWith('sha256=')) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', secreto).update(raw).digest('hex');
  const a = Buffer.from(firma);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Valida la forma del payload de Meta y extrae mensajes de texto. No lanza: descarta lo invalido.
function extraerMensajes(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.entry)) return null;
  const out = [];
  for (const e of body.entry.slice(0, 10)) {
    const changes = e && Array.isArray(e.changes) ? e.changes.slice(0, 10) : [];
    for (const c of changes) {
      const v = c && c.value;
      if (!v || typeof v !== 'object') continue;
      const pnid = v.metadata && typeof v.metadata.phone_number_id === 'string' ? v.metadata.phone_number_id : null;
      const msgs = Array.isArray(v.messages) ? v.messages.slice(0, 20) : [];
      for (const m of msgs) {
        if (!m || typeof m.from !== 'string' || !/^\d{6,15}$/.test(m.from)) continue;
        if (m.type !== 'text' || !m.text || typeof m.text.body !== 'string') {
          out.push({ phoneNumberId: pnid, from: m.from, noTexto: true }); continue;
        }
        out.push({ phoneNumberId: pnid, from: m.from, texto: m.text.body.slice(0, 4096) });
      }
    }
  }
  return out;
}

async function enviarWhatsApp(phoneNumberId, para, texto) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto.slice(0, 4000) } })
  });
  if (!r.ok) throw new Error('graph ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const q = req.query || {};
    const mode = q['hub.mode'], token = q['hub.verify_token'], ch = q['hub.challenge'];
    if (mode === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(ch); return;
    }
    res.status(403).json({ error: 'verificacion fallida o WHATSAPP_VERIFY_TOKEN no configurada' }); return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_APP_SECRET) {
    res.status(503).json({ error: 'modo WhatsApp no configurado: faltan WHATSAPP_TOKEN/WHATSAPP_APP_SECRET (ver README). La web demo funciona sin esto.' }); return;
  }

  let raw;
  try { raw = await cuerpoCrudo(req); } catch (e) { res.status(413).json({ error: e.message }); return; }

  if (!verificarFirma(raw, req.headers && req.headers['x-hub-signature-256'], process.env.WHATSAPP_APP_SECRET)) {
    res.status(401).json({ error: 'firma invalida' }); return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { res.status(400).json({ error: 'JSON invalido' }); return; }

  const mensajes = extraerMensajes(body);
  if (!mensajes) { res.status(400).json({ error: 'payload invalido' }); return; }

  cargarConfigEnv();
  let procesados = 0, omitidos = 0;
  try {
    for (const msg of mensajes) {
      const cfg = msg.phoneNumberId ? CONFIG_POR_NUMERO.get(msg.phoneNumberId) : null;
      if (!cfg) { omitidos++; continue; } // numero no registrado: no responder como negocio equivocado
      if (msg.noTexto) { await enviarWhatsApp(msg.phoneNumberId, msg.from, 'Por ahora solo puedo leer texto. Escribeme tu consulta!'); omitidos++; continue; }
      const key = `${msg.phoneNumberId}:${msg.from}`; // aislamiento por negocio y cliente
      const hist = memoria.get(key) || { historial: [], estado: null };
      const citas = citasPorNegocio.get(msg.phoneNumberId) || [];
      const r = await responder(cfg, hist.historial, msg.texto, hist.estado, citas);
      hist.historial.push({ rol: 'cliente', texto: msg.texto }, { rol: 'agente', texto: r.texto });
      hist.historial = hist.historial.slice(-24); hist.estado = r.estado;
      memoria.set(key, hist);
      if (r.reserva && r.reserva.nombre) {
        citas.push({ ...r.reserva, cliente: msg.from, ts: Date.now() });
        citasPorNegocio.set(msg.phoneNumberId, citas.slice(-500));
      }
      await enviarWhatsApp(msg.phoneNumberId, msg.from, r.texto);
      procesados++;
    }
    res.status(200).json({ ok: true, procesados, omitidos });
  } catch (e) {
    res.status(500).json({ error: 'webhook: ' + e.message });
  }
};

// Expuesto solo para pruebas con fixtures (test/webhook.test.js)
module.exports.__memoria = memoria;
module.exports.__config = CONFIG_POR_NUMERO;
module.exports.__citas = citasPorNegocio;
