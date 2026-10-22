# Agente WhatsApp por cliente

Agente de IA que atiende y agenda citas por WhatsApp, con web multi-cliente.
Basado en la guia del reel de @juanbertorello.ia (8 pasos: Meta Cloud API + webhook,
OpenRouter, memoria, datos del negocio, agendamiento, pruebas, deploy).

## Dos modos (no confundir)

**MODO DEMO (funciona ya, S/0, sin configurar nada)**
- Abre la web, crea un cliente, carga los datos de su negocio y prueba el chat.
- El agente responde con un motor de reglas local (saludos, precios, horarios,
  direccion, FAQ y agendamiento paso a paso con confirmacion).
- Las fechas y horas se resuelven a valores absolutos en la zona horaria del
  negocio ("manana" -> "viernes, 23 de octubre", 17:00) antes de confirmar.
- Valida disponibilidad: no agenda fuera de horario, respeta reglas como
  "no agendar domingos" y evita doble reserva en el mismo dia y hora.
- Datos en el navegador (localStorage). Nada toca WhatsApp real.

**MODO REAL (requiere env vars + app de Meta, ver checklist)**
- `/api/webhook/whatsapp` recibe mensajes reales de Meta Cloud API y responde
  con OpenRouter (LLM) usando los datos del negocio como system prompt.
- La reserva se confirma con la etiqueta [RESERVA] del modelo.

## Estructura
- `index.html` — panel web (lista de clientes, chat de prueba, datos del negocio, citas)
- `api/chat.js` — chat de la web (demo si no hay OPENROUTER_API_KEY)
- `api/agent-core.js` — prompt, motor demo y llamada a OpenRouter
- `api/webhook/whatsapp.js` — verificacion y recepcion de Meta Cloud API

## Checklist para conectar WhatsApp real (pendiente de go)
1. Crear app en developers.facebook.com (tipo Empresa) y activar WhatsApp (accion del dueno de la cuenta Meta).
2. Env vars en Vercel (no se configuran sin autorizacion):
   - WHATSAPP_VERIFY_TOKEN (cualquier cadena que elijas)
   - WHATSAPP_TOKEN (token permanente de Meta)
   - WHATSAPP_PHONE_NUMBER_ID (del panel de Meta)
   - OPENROUTER_API_KEY (openrouter.ai, cuenta gratis)
   - OPENROUTER_MODEL (opcional; por defecto openrouter/auto)
3. En Meta: configurar webhook = https://TU-DEPLOY/api/webhook/whatsapp, suscribir `messages`.
4. Probar con el numero de prueba de Meta hasta romperlo (paso 7 de la guia).
5. Produccion (NO listo, no usar con clientes reales todavia):
   - Persistencia real: hoy las citas y la memoria viven en el navegador
     (demo) o en memoria de proceso (webhook); falta base de datos por cliente.
   - Aislamiento multi-cliente: falta asociar cada numero de WhatsApp
     (phone_number_id) a su negocio y separar conversaciones y citas.
   - Auth del panel web: hoy es abierto; falta login para que cada cliente
     vea solo su negocio.
   - Verificacion de firma del webhook de Meta (X-Hub-Signature-256).
   - Prueba real autorizada con numero de prueba antes de cualquier cliente.
6. Opcional (guia): Cal.com para agenda real; NO integrado todavia - hoy el
   agendamiento es interno con fecha/hora absolutas y control de cupos.

## Deploy
`vercel --prod` (cero dependencias; estatica + funciones serverless).
