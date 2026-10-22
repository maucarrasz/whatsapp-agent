// Nucleo del agente: compartido por /api/chat (web) y /api/webhook/whatsapp (Meta).
// Sin dependencias. Modo real con OPENROUTER_API_KEY; sin ella, motor demo basado en reglas.

function buildSystemPrompt(cfg) {
  return `Eres el agente de WhatsApp del negocio "${cfg.nombre || 'Negocio'}".
Atiendes clientes, respondes dudas y agendas citas. Espanol, mensajes cortos estilo WhatsApp (max 2-3 lineas), sin markdown, un emoji como mucho.

DATOS DEL NEGOCIO (si no lo sabes, no lo inventes; di que lo confirmas con el equipo):
- Servicios y precios: ${cfg.servicios || 'no configurado'}
- Horarios: ${cfg.horarios || 'no configurado'}
- Direccion: ${cfg.direccion || 'no configurado'}
- Preguntas frecuentes: ${cfg.faq || 'no configurado'}
- Politicas: ${cfg.politicas || 'no configurado'}
- Reglas para agendar: ${cfg.reglas || 'pide servicio, dia, hora y nombre; confirma antes de cerrar'}

CUANDO EL CLIENTE QUIERA AGENDAR: reune servicio, dia, hora y nombre, confirma el resumen y SOLO ENTONCES incluye al final de tu mensaje una linea exacta:
[RESERVA]{"servicio":"...","fecha":"...","hora":"...","nombre":"..."}[/RESERVA]
No incluyas esa linea antes de la confirmacion del cliente.`;
}

function extraerReserva(texto) {
  const m = texto.match(/\[RESERVA\]([\s\S]*?)\[\/RESERVA\]/);
  if (!m) return { texto, reserva: null };
  let reserva = null;
  try { reserva = JSON.parse(m[1]); } catch (e) { reserva = null; }
  return { texto: texto.replace(m[0], '').trim(), reserva };
}

async function responderConOpenRouter(cfg, historial, mensaje) {
  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';
  const msgs = [{ role: 'system', content: buildSystemPrompt(cfg) },
    ...historial.slice(-12).map(h => ({ role: h.rol === 'agente' ? 'assistant' : 'user', content: h.texto })),
    { role: 'user', content: mensaje }];
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, max_tokens: 400 })
  });
  if (!r.ok) throw new Error('openrouter ' + r.status);
  const data = await r.json();
  return data.choices[0].message.content;
}

// Motor demo (sin LLM): usa los datos del negocio, maquina de estados de agendamiento.
function responderDemo(cfg, historial, mensaje, estado) {
  const m = (mensaje || '').toLowerCase();
  const nombre = cfg.nombre || 'el negocio';
  const est = estado || { paso: null, datos: {} };
  const saludo = `Hola, soy el asistente de ${nombre}. Puedo darte precios, horarios o agendarte una cita. Que necesitas?`;

  if (est.paso === 'servicio') {
    est.datos.servicio = mensaje.trim(); est.paso = 'fecha';
    return { texto: `Perfecto, ${est.datos.servicio}. Que dia te viene bien? (ej: manana, lunes 27)`, estado: est };
  }
  if (est.paso === 'fecha') {
    est.datos.fecha = mensaje.trim(); est.paso = 'hora';
    const h = cfg.horarios ? ` Nuestro horario: ${cfg.horarios}.` : '';
    return { texto: `Anotado: ${est.datos.fecha}.${h} A que hora prefieres?`, estado: est };
  }
  if (est.paso === 'hora') {
    est.datos.hora = mensaje.trim(); est.paso = 'nombre';
    return { texto: 'Ultimo paso: a nombre de quien agendo la cita?', estado: est };
  }
  if (est.paso === 'nombre') {
    est.datos.nombre = mensaje.trim(); est.paso = 'confirmar';
    const d = est.datos;
    return { texto: `Confirmame: ${d.servicio} para ${d.nombre}, ${d.fecha} a las ${d.hora}. Va? (responde "si" para confirmar)`, estado: est };
  }
  if (est.paso === 'confirmar') {
    if (/\b(si|sí|ok|dale|confirmo|va)\b/i.test(m)) {
      const d = est.datos; est.paso = null; est.datos = {};
      return { texto: `Listo, ${d.nombre}: cita agendada para ${d.fecha} a las ${d.hora} (${d.servicio}). Te esperamos!`, estado: est, reserva: d };
    }
    est.paso = null; est.datos = {};
    return { texto: 'Sin problema, cita cancelada. Quieres agendar otra fecha o te ayudo con algo mas?', estado: est };
  }

  if (/(agend|cita|turno|reserv|horario para|quiero ir|atencion)/.test(m)) {
    est.paso = 'servicio';
    const s = cfg.servicios ? ` Estos son los servicios: ${cfg.servicios}.` : '';
    const pre = historial.length === 0 ? `Hola, soy el asistente de ${nombre}. ` : '';
    return { texto: `${pre}Claro, te agendo.${s} Que servicio necesitas?`, estado: est };
  }
  if (/(hola|buenas|hey|buenos dias|buenas tardes)/.test(m) && historial.length === 0) return { texto: saludo, estado: est };
  if (/(precio|costo|cuanto|tarifa|valor)/.test(m)) return { texto: cfg.servicios ? `Estos son nuestros servicios y precios: ${cfg.servicios}. Quieres que te agende?` : 'Aun no tengo los precios cargados; te lo confirmo con el equipo. Quieres agendar mientras tanto?', estado: est };
  if (/(horario|atienden|abren|cierran|cuando)/.test(m)) return { texto: cfg.horarios ? `Atendemos: ${cfg.horarios}. Te agendo una cita?` : 'No tengo el horario cargado todavia; lo confirmo con el equipo.', estado: est };
  if (/(donde|direccion|ubicad|llegar)/.test(m)) return { texto: cfg.direccion ? `Estamos en ${cfg.direccion}. Necesitas algo mas?` : 'No tengo la direccion cargada; la confirmo con el equipo.', estado: est };
  if (cfg.faq) {
    const par = cfg.faq.split(/\n|;/).map(x => x.trim()).filter(Boolean).find(x => {
      const [p] = x.split(/[:?]/); return p && p.length > 6 && m.includes(p.trim().toLowerCase().slice(0, 12));
    });
    if (par) return { texto: par.includes(':') ? par.split(':').slice(1).join(':').trim() : par, estado: est };
  }
  return { texto: `Te ayudo con servicios y precios, horarios, direccion o agendar una cita. Que prefieres?`, estado: est };
}

async function responder(cfg, historial, mensaje, estado) {
  if (process.env.OPENROUTER_API_KEY) {
    const crudo = await responderConOpenRouter(cfg, historial, mensaje);
    const { texto, reserva } = extraerReserva(crudo);
    return { texto, estado: estado || { paso: null, datos: {} }, reserva, modo: 'openrouter' };
  }
  const r = responderDemo(cfg, historial, mensaje, estado);
  r.modo = 'demo';
  return r;
}

module.exports = { responder, buildSystemPrompt };
