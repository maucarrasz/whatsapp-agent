// Pruebas con FIXTURES del webhook de WhatsApp. Sin servicios reales: payload de Meta simulado,
// secreto de prueba, fetch stub. Esto NO es una prueba con WhatsApp real (eso requiere go de env vars).
// Ejecutar: node test/webhook.test.js
const assert = require('assert');
const crypto = require('crypto');
const { Readable } = require('stream');

const SECRET = 'secreto-de-prueba-fixtures';
process.env.WHATSAPP_TOKEN = 'token-fixture';
process.env.WHATSAPP_APP_SECRET = SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'verify-fixture';
delete process.env.WHATSAPP_CONFIG_JSON;
delete process.env.OPENROUTER_API_KEY;

const handler = require('../api/webhook/whatsapp');
const memoria = handler.__memoria;
const citasNegocio = handler.__citas;
const CONFIG = handler.__config;

CONFIG.set('PNID_A', { nombre: 'Barberia Fixture A', servicios: 'Corte S/25', horarios: 'Lun-Sab 9:00 a 19:00', zona: 'America/Lima' });
CONFIG.set('PNID_B', { nombre: 'Veterinaria Fixture B', servicios: 'Consulta S/50', horarios: 'Lun-Vie 9:00 a 18:00', zona: 'America/Lima' });

let enviados = [];
globalThis.fetch = async (url, opts) => { enviados.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}), text: async () => '' }; };

const FROM = '51999888777';
function payload(pnid, from, texto) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1555000111', phone_number_id: pnid }, contacts: [{ profile: { name: 'Test' }, wa_id: from }], messages: [{ from, id: 'wamid.X' + Math.random(), timestamp: '1', type: 'text', text: { body: texto } }] } }] }] };
}
function firmaDe(raw) { return 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'); }
function reqPOST(raw, headers = {}) { const r = Readable.from([raw]); r.method = 'POST'; r.headers = headers; return r; }
function resFake() { return { statusCode: 0, body: null, text: null, status(c) { this.statusCode = c; return this; }, json(j) { this.body = j; return this; }, send(t) { this.text = t; return this; } }; }
async function post(objOrRaw, { firmar = true, firma = null } = {}) {
  const raw = Buffer.isBuffer(objOrRaw) ? objOrRaw : Buffer.from(JSON.stringify(objOrRaw));
  const headers = {};
  if (firmar) headers['x-hub-signature-256'] = firma || firmaDe(raw);
  const res = resFake(); enviados = [];
  await handler(reqPOST(raw, headers), res);
  return { res, enviados };
}

let pass = 0, fail = 0;
async function t(nombre, fn) { try { await fn(); pass++; console.log('PASS', nombre); } catch (e) { fail++; console.log('FAIL', nombre, '-', e.message); } }

(async () => {
  await t('GET verificacion con token correcto devuelve challenge', async () => {
    const res = resFake();
    await handler({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-fixture', 'hub.challenge': 'CH123' }, headers: {} }, res);
    assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.text, 'CH123');
  });
  await t('GET verificacion con token incorrecto da 403', async () => {
    const res = resFake();
    await handler({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': 'CH123' }, headers: {} }, res);
    assert.strictEqual(res.statusCode, 403);
  });
  await t('POST firma valida procesa y responde con datos del negocio A', async () => {
    memoria.clear();
    const { res, enviados } = await post(payload('PNID_A', FROM, 'hola'));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(enviados.length, 1);
    assert.ok(enviados[0].url.includes('PNID_A'), 'envio desde el numero del negocio A');
    assert.ok(enviados[0].body.text.body.includes('Barberia Fixture A'), 'respuesta con nombre del negocio A');
  });
  await t('POST firma invalida da 401 y no envia nada', async () => {
    const { res, enviados } = await post(payload('PNID_A', FROM, 'hola'), { firma: 'sha256=' + '0'.repeat(64) });
    assert.strictEqual(res.statusCode, 401); assert.strictEqual(enviados.length, 0);
  });
  await t('POST sin firma da 401', async () => {
    const { res } = await post(payload('PNID_A', FROM, 'hola'), { firmar: false });
    assert.strictEqual(res.statusCode, 401);
  });
  await t('POST JSON roto (con firma valida) da 400', async () => {
    const { res } = await post(Buffer.from('{no-json'));
    assert.strictEqual(res.statusCode, 400);
  });
  await t('POST payload con forma invalida da 400', async () => {
    const { res } = await post({ foo: 1 });
    assert.strictEqual(res.statusCode, 400);
  });
  await t('POST con solo statuses (recibos) da 200 sin enviar', async () => {
    const p = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PNID_A' }, statuses: [{ status: 'delivered' }] } }] }] };
    const { res, enviados } = await post(p);
    assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.body.procesados, 0); assert.strictEqual(enviados.length, 0);
  });
  await t('Numero no registrado se ignora (no responde como negocio equivocado)', async () => {
    const { res, enviados } = await post(payload('PNID_Z', FROM, 'hola'));
    assert.strictEqual(res.statusCode, 200); assert.strictEqual(res.body.procesados, 0);
    assert.strictEqual(res.body.omitidos, 1); assert.strictEqual(enviados.length, 0);
  });
  await t('Mensaje no-texto recibe aviso y no pasa al agente', async () => {
    const p = payload('PNID_A', FROM, 'x'); p.entry[0].changes[0].value.messages[0] = { from: FROM, id: 'w', type: 'image', image: { id: '1' } };
    const { res, enviados } = await post(p);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(enviados[0].body.text.body.includes('solo puedo leer texto'));
  });
  await t('Separacion por negocio: mismo cliente, dos numeros, memorias y configs aisladas', async () => {
    memoria.clear();
    const a = await post(payload('PNID_A', FROM, 'hola'));
    const b = await post(payload('PNID_B', FROM, 'hola'));
    assert.ok(a.enviados[0].body.text.body.includes('Barberia Fixture A'));
    assert.ok(b.enviados[0].body.text.body.includes('Veterinaria Fixture B'));
    assert.ok(memoria.has(`PNID_A:${FROM}`) && memoria.has(`PNID_B:${FROM}`), 'memorias separadas por negocio');
  });
  await t('Flujo de reserva completo por webhook con fecha absoluta y sin doble reserva', async () => {
    memoria.clear();
    for (const txt of ['quiero una cita', 'corte', 'manana', '5 pm', 'Juan Prueba', 'si']) {
      const { res } = await post(payload('PNID_A', FROM, txt));
      assert.strictEqual(res.statusCode, 200);
    }
    assert.ok(memoria.has(`PNID_A:${FROM}`), 'memoria por cliente');
    const citasA = citasNegocio.get('PNID_A') || [];
    assert.strictEqual(citasA.length, 1);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(citasA[0].fecha_iso), 'fecha_iso absoluta');
    assert.strictEqual(citasA[0].hora, '17:00');
    for (const txt of ['otra cita', 'barba', 'manana']) await post(payload('PNID_A', '51977666555', txt));
    const r2 = await post(payload('PNID_A', '51977666555', '5 pm'));
    assert.ok(r2.enviados[0].body.text.body.includes('ya hay una cita'), 'rechaza doble reserva misma fecha y hora aunque sea OTRO cliente del mismo negocio');
    assert.ok(citasNegocio.get('PNID_A').length >= 1, 'citas compartidas por negocio');
  });
  await t('Sin WHATSAPP_APP_SECRET configurada da 503 (no procesa)', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const { res, enviados } = await post(payload('PNID_A', FROM, 'hola'));
    assert.strictEqual(res.statusCode, 503); assert.strictEqual(enviados.length, 0);
    process.env.WHATSAPP_APP_SECRET = SECRET;
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
