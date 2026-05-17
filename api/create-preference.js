const { calculateService, toMoney, buildPreferencePayload } = require('./process-payment.js').__mp;

const MERCADO_PAGO_PREFERENCES_URL = 'https://api.mercadopago.com/checkout/preferences';

function readBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

function accessToken() {
  return process.env.MP_PROD_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN;
}

async function createPreference(accessTokenValue, body) {
  try {
    const { MercadoPagoConfig, Preference } = require('mercadopago');
    const client = new MercadoPagoConfig({ accessToken: accessTokenValue });
    const preference = new Preference(client);
    return await preference.create({ body });
  } catch (error) {
    const response = await fetch(MERCADO_PAGO_PREFERENCES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessTokenValue}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Mercado Pago recusou a preferencia.');
    return data;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo nao permitido.' });
    return;
  }

  const token = accessToken();
  if (!token) {
    res.status(503).json({ error: 'Pagamento real ainda nao foi configurado. Defina MP_PROD_ACCESS_TOKEN no Vercel.' });
    return;
  }

  let payload;
  try {
    payload = readBody(req);
  } catch (error) {
    res.status(400).json({ error: 'JSON invalido.' });
    return;
  }

  const order = payload.order || {};
  const service = payload.service || {};
  const orderId = String(order.id || '').trim().slice(0, 64);
  const client = String(order.client || '').trim().slice(0, 120);
  const email = String(order.email || '').trim().toLowerCase().slice(0, 160);
  const whatsapp = String(order.whatsapp || '').trim().slice(0, 40);

  if (!orderId || !client || !email || !whatsapp) {
    res.status(400).json({ error: 'Nome, email, WhatsApp e codigo do pedido sao obrigatorios.' });
    return;
  }

  let calculated;
  try {
    calculated = calculateService(service);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Servico invalido.' });
    return;
  }

  const clientAmount = toMoney(order.price);
  if (clientAmount && Math.abs(clientAmount - calculated.amount) > 0.01) {
    res.status(400).json({ error: 'O valor do pedido mudou. Recalcule o servico antes de pagar.' });
    return;
  }

  const preferencePayload = buildPreferencePayload({ order, calculated, req });

  try {
    const preference = await createPreference(token, preferencePayload);
    res.status(200).json({
      id: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point,
      notification_url: preferencePayload.notification_url,
      statement_descriptor: preferencePayload.statement_descriptor,
      items: preferencePayload.items
    });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Nao foi possivel criar a preferencia.' });
  }
};
