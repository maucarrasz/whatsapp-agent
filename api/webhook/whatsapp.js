// Webhook de Meta WhatsApp Cloud API (paso 2 de la guia del reel).
// GET: verificacion (hub.challenge). POST: mensajes entrantes -> agente -> respuesta.
// Requiere env: WHATSAPP_VERIFY_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, OPENROUTER_API_KEY.
// Sin esas vars el endpoint responde 503 explicando que falta (modo demo solo web).
const { responder } = require('../agent-core');

// Memoria en proceso (suficiente para prueba en un solo lambda caliente; produccion: Supabase/Upstash).
const memoria = global.__wa_memoria || (global.__wa_memoria = new Map());
const CONFIG_POR_NUMERO = global.__wa_cfg || (global.__wa_cfg = new Map());

async function enviarWhatsApp(para, texto) {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const r = await fetch(`https://graph.facebook.com/v21.0/${id}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto.slice(0, 4000) } })
  });
  if (!r.ok) throw new Error('graph ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], ch = req.query['hub.challenge'];
    if (mode === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(ch); return;
    }
    res.status(403).json({ error: 'verificacion fallida o WHATSAPP_VERIFY_TOKEN no configurada' }); return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    res.status(503).json({ error: 'modo WhatsApp no configurado: faltan WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID (ver README). La web demo funciona sin esto.' }); return;
  }
  try {
    const cambios = (req.body && req.body.entry || []).flatMap(e => e.changes || []);
    for (const c of cambios) {
      const msgs = (c.value && c.value.messages) || [];
      for (const msg of msgs) {
        if (msg.type !== 'text') { await enviarWhatsApp(msg.from, 'Por ahora solo puedo leer texto. Escribeme tu consulta!'); continue; }
        const key = msg.from;
        const hist = memoria.get(key) || { historial: [], estado: null };
        const cfg = CONFIG_POR_NUMERO.get(process.env.WHATSAPP_PHONE_NUMBER_ID) || {};
        const r = await responder(cfg, hist.historial, msg.text.body, hist.estado);
        hist.historial.push({ rol: 'cliente', texto: msg.text.body }, { rol: 'agente', texto: r.texto });
        hist.historial = hist.historial.slice(-24); hist.estado = r.estado;
        memoria.set(key, hist);
        await enviarWhatsApp(msg.from, r.texto);
      }
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'webhook: ' + e.message });
  }
};
