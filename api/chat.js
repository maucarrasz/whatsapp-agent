// POST /api/chat — chat de la web (demo o real segun env).
// Body: { config, historial: [{rol,texto}], mensaje, estado }
const { responder } = require('./agent-core');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  try {
    const { config = {}, historial = [], mensaje = '', estado = null, citas = [] } = req.body || {};
    if (!mensaje.trim()) { res.status(400).json({ error: 'mensaje vacio' }); return; }
    const r = await responder(config, historial, mensaje, estado, citas);
    res.status(200).json(r);
  } catch (e) {
    res.status(500).json({ error: 'agente: ' + e.message });
  }
};
