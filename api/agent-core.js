// Nucleo del agente: compartido por /api/chat (web) y /api/webhook/whatsapp (Meta).
// Sin dependencias. Modo real con OPENROUTER_API_KEY; sin ella, motor demo basado en reglas.
// Fechas y horas se resuelven a valores absolutos (zona horaria del negocio) antes de confirmar.

const DIAS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, setiembre: 9, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function zona(cfg) { return cfg.zona || 'America/Lima'; }

function hoyEn(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = f.format(new Date()).split('-').map(Number);
  return { y, m, d };
}

function mkDate(y, m, d) { return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); } // mediodia UTC: mismo dia civil en Lima

function dowDe(y, m, d) { return mkDate(y, m, d).getUTCDay(); }

function isoDe(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

function legible(y, m, d, tz) {
  return new Intl.DateTimeFormat('es-PE', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(mkDate(y, m, d));
}

function cmpIso(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// Resuelve "hoy", "manana", "lunes", "lunes 27", "27/10", "27 de octubre" a fecha absoluta.
// Devuelve { iso, legible } o null si no se entiende.
function resolverFecha(texto, tz) {
  const t = norm(texto).trim();
  const hoy = hoyEn(tz);
  const hoyIso = isoDe(hoy.y, hoy.m, hoy.d);
  let y, m, d;

  const explicitaMes = t.match(/(\d{1,2})\s*(?:\/|\-|\.|de\s+)\s*(\d{1,2}|enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)(?:\s*(?:\/|\-|\.|de\s*)\s*(\d{2,4}))?/);
  if (explicitaMes) {
    d = parseInt(explicitaMes[1], 10);
    m = MESES[explicitaMes[2]] || parseInt(explicitaMes[2], 10);
    y = explicitaMes[3] ? parseInt(explicitaMes[3], 10) : hoy.y;
    if (y < 100) y += 2000;
    if (!explicitaMes[3] && cmpIso(isoDe(y, m, d), hoyIso) < 0) y += 1;
  } else if (/^pasado\s+manana$/.test(t)) {
    const f = mkDate(hoy.y, hoy.m, hoy.d + 2); y = f.getUTCFullYear(); m = f.getUTCMonth() + 1; d = f.getUTCDate();
  } else if (/^manana$/.test(t) || t === 'manana' || t === 'pasado manana') {
    const off = t.startsWith('pasado') ? 2 : 1;
    const f = mkDate(hoy.y, hoy.m, hoy.d + off); y = f.getUTCFullYear(); m = f.getUTCMonth() + 1; d = f.getUTCDate();
  } else if (t === 'hoy') {
    y = hoy.y; m = hoy.m; d = hoy.d;
  } else if (/^\d{1,2}$/.test(t)) {
    d = parseInt(t, 10); m = hoy.m; y = hoy.y;
    if (cmpIso(isoDe(y, m, d), hoyIso) < 0) { m += 1; if (m > 12) { m = 1; y += 1; } }
  } else {
    const diaSemana = Object.keys(DIAS).find(k => new RegExp(`\\b${k}s?\\b`).test(t));
    if (!diaSemana) return null;
    const target = DIAS[diaSemana];
    let diff = (target - dowDe(hoy.y, hoy.m, hoy.d) + 7) % 7;
    if (diff === 0) diff = 7;
    const f = mkDate(hoy.y, hoy.m, hoy.d + diff); y = f.getUTCFullYear(); m = f.getUTCMonth() + 1; d = f.getUTCDate();
  }
  const iso = isoDe(y, m, d);
  if (d < 1 || d > 31 || !m || m > 12) return null;
  if (cmpIso(iso, hoyIso) < 0) return { pasada: true };
  return { iso, legible: legible(y, m, d, tz), dow: dowDe(y, m, d) };
}

// Resuelve "5 pm", "5:30 pm", "17:30", "5 de la tarde", "mediodia" a "HH:MM" 24h. null si no se entiende.
function resolverHora(texto) {
  const t = norm(texto).trim();
  if (/mediodia/.test(t)) return '12:00';
  if (/medianoche/.test(t)) return '00:00';
  let mm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/);
  if (mm) {
    let h = parseInt(mm[1], 10); const min = parseInt(mm[2] || '0', 10);
    if (h < 1 || h > 12 || min > 59) return null;
    if (mm[3] === 'pm' && h !== 12) h += 12;
    if (mm[3] === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  mm = t.match(/\b(\d{1,2})\s*(?:y\s*(\d{1,2}))?\s*de la (tarde|noche|manana)\b/);
  if (mm) {
    let h = parseInt(mm[1], 10); const min = parseInt(mm[2] || '0', 10);
    if (h < 1 || h > 12 || min > 59) return null;
    if ((mm[3] === 'tarde' || mm[3] === 'noche') && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  mm = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (mm) return `${String(parseInt(mm[1], 10)).padStart(2, '0')}:${mm[2]}`;
  mm = t.match(/^(1[3-9]|2[0-3])$/);
  if (mm) return `${mm[1]}:00`;
  return null;
}

function aMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function aHHMM(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }

// Interpreta horarios tipo "Lun-Sab 9:00 a 19:00". null si no se puede interpretar (entonces no se bloquea).
function parseHorarios(h) {
  if (!h) return null;
  const t = norm(h);
  const nombres = Object.keys(DIAS);
  const caps = [...t.matchAll(new RegExp(`(${nombres.join('|')})`, 'g'))].map(x => DIAS[x[1]]);
  const horas = [...t.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g)]
    .map(x => { let hh = parseInt(x[1], 10); const mn = parseInt(x[2] || '0', 10); if (x[3] === 'pm' && hh !== 12) hh += 12; if (x[3] === 'am' && hh === 12) hh = 0; return hh * 60 + mn; })
    .filter(v => v >= 0 && v <= 24 * 60);
  if (horas.length < 2) return null;
  let dias = null;
  if (caps.length >= 2 && t.includes('-')) {
    dias = new Set();
    for (let i = caps[0]; ; i = (i + 1) % 7) { dias.add(i); if (i === caps[1]) break; }
  } else if (caps.length >= 1) {
    dias = new Set(caps);
  }
  return { dias, desde: horas[0], hasta: horas[1] };
}

function diasBloqueadosPorReglas(reglas) {
  const out = new Set();
  const t = norm(reglas || '');
  for (const k of Object.keys(DIAS)) {
    if (new RegExp(`no\\s+(agend|atend|abrimos|trabaj)[^.;\\n]*\\b${k}s?\\b`).test(t)) out.add(DIAS[k]);
  }
  return out;
}

function slotsLibres(fechaIso, horarios, citas, desdeMin) {
  const tomadas = new Set((citas || []).filter(c => c.fecha_iso === fechaIso).map(c => c.hora));
  const libres = [];
  for (let m = Math.max(desdeMin, horarios.desde); m < horarios.hasta && libres.length < 3; m += 60) {
    const hh = aHHMM(m);
    if (!tomadas.has(hh)) libres.push(hh);
  }
  return libres;
}

function buildSystemPrompt(cfg) {
  const tz = zona(cfg);
  const hoy = hoyEn(tz);
  return `Eres el agente de WhatsApp del negocio "${cfg.nombre || 'Negocio'}".
Atiendes clientes, respondes dudas y agendas citas. Espanol, mensajes cortos estilo WhatsApp (max 2-3 lineas), sin markdown, un emoji como mucho.
Hoy es ${legible(hoy.y, hoy.m, hoy.d, tz)} (${isoDe(hoy.y, hoy.m, hoy.d)}) en la zona ${tz}. Resuelve siempre fechas y horas relativas a absolutas usando esa referencia.

DATOS DEL NEGOCIO (si no lo sabes, no lo inventes; di que lo confirmas con el equipo):
- Servicios y precios: ${cfg.servicios || 'no configurado'}
- Horarios: ${cfg.horarios || 'no configurado'}
- Direccion: ${cfg.direccion || 'no configurado'}
- Preguntas frecuentes: ${cfg.faq || 'no configurado'}
- Politicas: ${cfg.politicas || 'no configurado'}
- Reglas para agendar: ${cfg.reglas || 'pide servicio, dia, hora y nombre; confirma antes de cerrar'}

CUANDO EL CLIENTE QUIERA AGENDAR: reune servicio, dia, hora y nombre, respeta los horarios y las reglas del negocio, confirma el resumen con la fecha absoluta y SOLO ENTONCES incluye al final de tu mensaje una linea exacta:
[RESERVA]{"servicio":"...","fecha_iso":"YYYY-MM-DD","hora":"HH:MM","nombre":"..."}[/RESERVA]
No incluyas esa linea antes de la confirmacion del cliente. No confirmes una hora fuera de horario ni un dia no atendido.`;
}

function extraerReserva(texto, cfg) {
  const m = texto.match(/\[RESERVA\]([\s\S]*?)\[\/RESERVA\]/);
  if (!m) return { texto, reserva: null };
  let r = null;
  try { r = JSON.parse(m[1]); } catch (e) { r = null; }
  if (r && r.fecha_iso) {
    const [y, mo, d] = r.fecha_iso.split('-').map(Number);
    r.fecha = legible(y, mo, d, zona(cfg));
    r.zona = zona(cfg);
  }
  return { texto: texto.replace(m[0], '').trim(), reserva: r };
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
// Resuelve fechas/horas absolutas, valida disponibilidad y evita doble reserva (citas = reservas ya tomadas).
function responderDemo(cfg, historial, mensaje, estado, citas) {
  const m = norm(mensaje);
  const nombre = cfg.nombre || 'el negocio';
  const tz = zona(cfg);
  const est = estado || { paso: null, datos: {} };
  const saludo = `Hola, soy el asistente de ${nombre}. Puedo darte precios, horarios o agendarte una cita. Que necesitas?`;
  const horarios = parseHorarios(cfg.horarios);
  const bloqueados = diasBloqueadosPorReglas(cfg.reglas);

  if (est.paso === 'servicio') {
    est.datos.servicio = mensaje.trim(); est.paso = 'fecha';
    return { texto: `Perfecto, ${est.datos.servicio}. Que dia te viene bien? (ej: manana, lunes 27)`, estado: est };
  }
  if (est.paso === 'fecha') {
    const f = resolverFecha(mensaje, tz);
    if (!f) return { texto: 'No entendi la fecha. Dime un dia como "manana", "lunes" o "27 de octubre".', estado: est };
    if (f.pasada) return { texto: 'Esa fecha ya paso. Que otro dia te viene bien?', estado: est };
    if (bloqueados.has(f.dow)) { const diaS = f.legible.split(',')[0]; return { texto: `Los ${diaS}s no agendamos. Te va otro dia?`, estado: est }; }
    if (horarios && horarios.dias && !horarios.dias.has(f.dow)) return { texto: `Ese dia no atendemos (horario: ${cfg.horarios}). Que otro dia te viene bien?`, estado: est };
    est.datos.fecha_iso = f.iso; est.datos.fecha = f.legible; est.paso = 'hora';
    const h = cfg.horarios ? ` Nuestro horario: ${cfg.horarios}.` : '';
    return { texto: `Anotado: ${f.legible}.${h} A que hora prefieres? (ej: 5 pm, 17:30)`, estado: est };
  }
  if (est.paso === 'hora') {
    const hhmm = resolverHora(mensaje);
    if (!hhmm) return { texto: 'No entendi la hora. Dime algo como "5 pm" o "17:30".', estado: est };
    if (horarios && (aMin(hhmm) < horarios.desde || aMin(hhmm) >= horarios.hasta)) {
      return { texto: `A las ${hhmm} no atendemos (horario: ${cfg.horarios}). Que otra hora te viene bien?`, estado: est };
    }
    const tomada = (citas || []).some(c => c.fecha_iso === est.datos.fecha_iso && c.hora === hhmm);
    if (tomada) {
      const libres = slotsLibres(est.datos.fecha_iso, horarios || { desde: 0, hasta: 24 * 60 }, citas, aMin(hhmm) + 60);
      const sug = libres.length ? ` Ese dia tengo libre: ${libres.join(', ')}.` : '';
      return { texto: `A las ${hhmm} ya hay una cita agendada.${sug} Que otra hora te va?`, estado: est };
    }
    est.datos.hora = hhmm; est.paso = 'nombre';
    return { texto: 'Ultimo paso: a nombre de quien agendo la cita?', estado: est };
  }
  if (est.paso === 'nombre') {
    est.datos.nombre = mensaje.trim(); est.paso = 'confirmar';
    const d = est.datos;
    return { texto: `Confirmame: ${d.servicio} para ${d.nombre}, ${d.fecha} a las ${d.hora}. Va? (responde "si" para confirmar)`, estado: est };
  }
  if (est.paso === 'confirmar') {
    if (/\b(si|ok|dale|confirmo|va)\b/i.test(m)) {
      const d = est.datos; est.paso = null; est.datos = {};
      const reserva = { servicio: d.servicio, nombre: d.nombre, fecha: d.fecha, fecha_iso: d.fecha_iso, hora: d.hora, zona: tz };
      return { texto: `Listo, ${d.nombre}: cita agendada para ${d.fecha} a las ${d.hora} (${d.servicio}). Te esperamos!`, estado: est, reserva };
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
      const [p] = x.split(/[:?]/); return p && p.length > 6 && m.includes(norm(p).trim().slice(0, 12));
    });
    if (par) return { texto: par.includes(':') ? par.split(':').slice(1).join(':').trim() : par, estado: est };
  }
  return { texto: `Te ayudo con servicios y precios, horarios, direccion o agendar una cita. Que prefieres?`, estado: est };
}

async function responder(cfg, historial, mensaje, estado, citas) {
  if (process.env.OPENROUTER_API_KEY) {
    const crudo = await responderConOpenRouter(cfg, historial, mensaje);
    const { texto, reserva } = extraerReserva(crudo, cfg);
    return { texto, estado: estado || { paso: null, datos: {} }, reserva, modo: 'openrouter' };
  }
  const r = responderDemo(cfg, historial, mensaje, estado, citas);
  r.modo = 'demo';
  return r;
}

module.exports = { responder, buildSystemPrompt, resolverFecha, resolverHora };
