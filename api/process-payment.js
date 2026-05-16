const crypto = require('crypto');

const MERCADO_PAGO_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';

const RANK_POINTS = [
  0, 250, 500,
  750, 1000, 1250,
  1500, 2000, 2500,
  3000, 3500, 4000,
  4500, 5000, 5500,
  6000, 6750, 7500,
  8250, 9250, 10250,
  11250
];

const RANK_NAMES = [
  'Bronze I', 'Bronze II', 'Bronze III',
  'Prata I', 'Prata II', 'Prata III',
  'Ouro I', 'Ouro II', 'Ouro III',
  'Diamante I', 'Diamante II', 'Diamante III',
  'Mitico I', 'Mitico II', 'Mitico III',
  'Lendario I', 'Lendario II', 'Lendario III',
  'Mestres I', 'Mestres II', 'Mestres III',
  'Pro'
];

function readBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

function toInteger(value) {
  const parsed = Number.parseInt(String(value || '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toMoney(value) {
  const parsed = Number(String(value || '0').replace(/[^\d,.-]/g, '').replace('.', '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calcTrofeu(atual, subir) {
  if (atual <= 0 || subir <= 0) throw new Error('Informe os trofeus atuais e a quantidade para subir.');

  let price = 0;
  let remaining = subir;
  let pos = atual;

  while (remaining > 0) {
    let rate;
    let boundary;

    if (pos < 40000) {
      rate = 5 / 1000;
      boundary = 40000;
    } else if (pos < 100000) {
      rate = 20 / 1000;
      boundary = 100000;
    } else {
      rate = 30 / 1000;
      boundary = Infinity;
    }

    const chunk = boundary === Infinity ? remaining : Math.min(remaining, boundary - pos);
    price += chunk * rate;
    pos += chunk;
    remaining -= chunk;
  }

  if (subir > 10000) price -= price * 0.15;
  return roundMoney(price);
}

function calcRanked(fromIndex, toIndex) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= RANK_POINTS.length || toIndex >= RANK_POINTS.length || toIndex <= fromIndex) {
    throw new Error('Selecione um elo atual e um elo desejado validos.');
  }

  const pointDiff = RANK_POINTS[toIndex] - RANK_POINTS[fromIndex];
  const mult = pointDiff >= 5000 ? 2.2 : pointDiff >= 3000 ? 1.8 : pointDiff >= 1500 ? 1.4 : 1.1;
  return roundMoney(Math.max(20, (pointDiff / 250) * 18 * mult));
}

function calcPrestigio(currentTrophies, level) {
  if (currentTrophies <= 0 || ![1, 2, 3].includes(level)) {
    throw new Error('Informe os trofeus do brawler e o prestigio desejado.');
  }

  if (currentTrophies < 1000) {
    if (level === 1) return 10;
    if (level === 2) return 30;
    return 70;
  }

  if (currentTrophies < 2000) {
    if (level === 1) throw new Error('Esse brawler ja possui prestigio I.');
    if (level === 2) return 20;
    return 60;
  }

  if (level === 1 || level === 2) throw new Error('Esse brawler ja possui esse prestigio.');
  return 50;
}

function calculateService(service = {}) {
  const type = String(service.type || '').trim();

  if (type === 'trofeu') {
    const atual = toInteger(service.currentTrophies);
    const subir = toInteger(service.trophyAmount);
    return {
      type,
      amount: calcTrofeu(atual, subir),
      title: 'UP Trofeu',
      description: `Atual: ${atual} trofeus | Subir: ${subir} trofeus`
    };
  }

  if (type === 'ranked') {
    const fromIndex = toInteger(service.fromIndex);
    const toIndex = toInteger(service.toIndex);
    return {
      type,
      amount: calcRanked(fromIndex, toIndex),
      title: 'UP Ranked',
      description: `${RANK_NAMES[fromIndex]} -> ${RANK_NAMES[toIndex]}`
    };
  }

  if (type === 'prestigio') {
    const currentTrophies = toInteger(service.currentTrophies);
    const level = toInteger(service.level);
    const brawler = String(service.brawler || 'Brawler').trim().slice(0, 80);
    return {
      type,
      amount: calcPrestigio(currentTrophies, level),
      title: 'UP Prestigio',
      description: `Prestigio ${level} - ${brawler}`
    };
  }

  throw new Error('Servico de pagamento invalido.');
}

function normalizedFormData(formData = {}) {
  return {
    token: formData.token,
    installments: toInteger(formData.installments || formData.installment),
    payment_method_id: formData.payment_method_id || formData.paymentMethodId,
    issuer_id: formData.issuer_id || formData.issuer || formData.issuerId,
    payer: formData.payer || {},
    description: formData.description
  };
}

function buildPaymentPayload({ order, calculated, formData }) {
  const data = normalizedFormData(formData);
  const payerEmail = String(order.email || data.payer.email || '').trim().toLowerCase();
  const payer = { email: payerEmail };
  const identification = data.payer.identification || {};

  if (identification.type && identification.number) {
    payer.identification = {
      type: String(identification.type).trim(),
      number: String(identification.number).replace(/\D/g, '')
    };
  }

  if (data.payer.first_name) payer.first_name = String(data.payer.first_name).slice(0, 80);
  if (data.payer.last_name) payer.last_name = String(data.payer.last_name).slice(0, 80);

  const payment = {
    transaction_amount: calculated.amount,
    description: `${calculated.title} - ${calculated.description}`,
    payment_method_id: String(data.payment_method_id || '').trim(),
    payer,
    external_reference: String(order.id || '').trim(),
    metadata: {
      order_id: String(order.id || '').trim(),
      service_type: calculated.type,
      scheduled_date: String(order.date || '').slice(0, 40),
      scheduled_time: String(order.time || '').slice(0, 20),
      client: String(order.client || '').slice(0, 120),
      whatsapp: String(order.whatsapp || '').slice(0, 40)
    }
  };

  if (data.token) payment.token = data.token;
  if (data.installments) payment.installments = data.installments;
  if (data.issuer_id) payment.issuer_id = String(data.issuer_id);

  return payment;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metodo nao permitido.' });
    return;
  }

  const accessToken = process.env.MP_PROD_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
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
  const formData = payload.formData || {};
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

  const paymentPayload = buildPaymentPayload({ order, calculated, formData });
  if (!paymentPayload.payment_method_id) {
    res.status(400).json({ error: 'Meio de pagamento invalido.' });
    return;
  }

  try {
    const idempotencyKey = crypto.randomUUID();
    const mpResponse = await fetch(MERCADO_PAGO_PAYMENTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(paymentPayload)
    });
    const data = await mpResponse.json().catch(() => ({}));

    if (!mpResponse.ok) {
      res.status(502).json({ error: data.message || data.error || 'Mercado Pago recusou o pagamento.', detail: data });
      return;
    }

    res.status(200).json({
      id: data.id,
      status: data.status,
      status_detail: data.status_detail,
      payment_method_id: data.payment_method_id,
      transaction_amount: data.transaction_amount,
      point_of_interaction: data.point_of_interaction,
      transaction_details: data.transaction_details,
      external_reference: data.external_reference || orderId
    });
  } catch (error) {
    res.status(502).json({ error: 'Nao foi possivel conectar ao Mercado Pago.' });
  }
};
