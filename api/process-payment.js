const crypto = require('crypto');

const MERCADO_PAGO_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';
const STATEMENT_DESCRIPTOR = 'ZSUPBRAWL';

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

function publicBaseUrl(req) {
  const explicit = process.env.PUBLIC_SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (explicit) {
    const normalized = String(explicit).trim().replace(/\/$/, '');
    return normalized.startsWith('http') ? normalized : `https://${normalized}`;
  }

  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (!host) return '';
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function notificationUrl(req) {
  const configured = process.env.MERCADO_PAGO_NOTIFICATION_URL || process.env.MP_NOTIFICATION_URL;
  if (configured) return String(configured).trim();
  const base = publicBaseUrl(req);
  return base ? `${base}/api/mercado-pago-webhook` : '';
}

function sitePictureUrl(req, path = '/images/site/icon-trophy.png') {
  const base = publicBaseUrl(req);
  return base ? `${base}${path}` : '';
}

function splitName(name = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    first_name: parts[0] || 'Cliente',
    last_name: parts.slice(1).join(' ') || 'ZS UpBrawl'
  };
}

function splitPhone(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  const withoutCountry = digits.startsWith('55') ? digits.slice(2) : digits;
  return {
    area_code: withoutCountry.slice(0, 2) || '12',
    number: withoutCountry.slice(2) || withoutCountry || '992025025'
  };
}

function itemCategory(type) {
  return 'games';
}

function itemImagePath(type) {
  if (type === 'ranked') return '/images/site/icon-ranked.webp';
  if (type === 'prestigio') return '/images/site/icon-prestige-3.webp';
  if (type === 'account') return '/images/site/icon-account-red.webp';
  return '/images/site/icon-trophy.png';
}

function buildMarketplaceItem({ order, calculated, req }) {
  return {
    id: `${calculated.type}-${String(order.id || crypto.randomUUID()).slice(0, 64)}`,
    title: calculated.title,
    description: calculated.description,
    picture_url: sitePictureUrl(req, itemImagePath(calculated.type)),
    category_id: itemCategory(calculated.type),
    quantity: 1,
    unit_price: calculated.amount
  };
}

function buildPreferenceItem({ order, calculated, req }) {
  return {
    ...buildMarketplaceItem({ order, calculated, req }),
    currency_id: 'BRL'
  };
}

function buildAdditionalPayer(order, data) {
  const name = splitName(order.client || data.payer?.first_name || '');
  const phone = splitPhone(order.whatsapp || '');
  return {
    first_name: String(data.payer?.first_name || name.first_name).slice(0, 80),
    last_name: String(data.payer?.last_name || name.last_name).slice(0, 80),
    phone,
    authentication_type: 'Native web',
    is_first_purchase_online: false,
    is_prime_user: false
  };
}

function mercadoPagoErrorMessage(data = {}) {
  const causes = Array.isArray(data.cause)
    ? data.cause.map(cause => cause?.description || cause?.message || cause?.code).filter(Boolean)
    : [];
  return data.message || causes[0] || data.error || 'Mercado Pago recusou o pagamento.';
}

function mercadoPagoErrorDetail(data = {}) {
  return {
    message: data.message || data.error || '',
    status: data.status || data.status_code || '',
    error: data.error || '',
    cause: Array.isArray(data.cause)
      ? data.cause.map(cause => ({
          code: cause?.code || '',
          description: cause?.description || cause?.message || ''
        }))
      : []
  };
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

  if (type === 'account') {
    const amount = toMoney(service.amount);
    const name = String(service.name || 'Conta Brawl Stars').trim().slice(0, 120);
    if (amount <= 0) throw new Error('Valor da conta invalido.');
    return {
      type,
      amount: roundMoney(amount),
      title: 'Conta Brawl Stars',
      description: name
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

function buildPaymentPayload({ order, calculated, formData, req }) {
  const data = normalizedFormData(formData);
  const payerEmail = String(order.email || data.payer.email || '').trim().toLowerCase();
  const payer = { email: payerEmail };
  const identification = data.payer.identification || {};
  const item = buildMarketplaceItem({ order, calculated, req });
  const webhook = notificationUrl(req);

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
    statement_descriptor: STATEMENT_DESCRIPTOR,
    capture: true,
    payment_method_id: String(data.payment_method_id || '').trim(),
    payer,
    external_reference: String(order.id || '').trim(),
    metadata: {
      order_id: String(order.id || '').trim(),
      service_type: calculated.type,
      scheduled_date: String(order.date || '').slice(0, 40),
      scheduled_time: String(order.time || '').slice(0, 20),
      client: String(order.client || '').slice(0, 120),
      whatsapp: String(order.whatsapp || '').slice(0, 40),
      item_id: item.id,
      item_title: item.title,
      item_category_id: item.category_id
    },
    additional_info: {
      items: [item],
      payer: buildAdditionalPayer(order, data)
    }
  };

  if (data.token) payment.token = data.token;
  if (data.installments) payment.installments = data.installments;
  if (data.issuer_id) {
    const issuerId = Number(data.issuer_id);
    payment.issuer_id = Number.isFinite(issuerId) ? issuerId : data.issuer_id;
  }
  if (webhook) payment.notification_url = webhook;

  return payment;
}

async function createMercadoPagoPayment(accessToken, body, idempotencyKey) {
  try {
    const { MercadoPagoConfig, Payment } = require('mercadopago');
    const client = new MercadoPagoConfig({
      accessToken,
      options: { timeout: 10000 }
    });
    const payment = new Payment(client);
    return await payment.create({
      body,
      requestOptions: { idempotencyKey }
    });
  } catch (sdkError) {
    const mpResponse = await fetch(MERCADO_PAGO_PAYMENTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(body)
    });
    const data = await mpResponse.json().catch(() => ({}));

    if (!mpResponse.ok) {
      const error = new Error(mercadoPagoErrorMessage(data));
      error.status = 502;
      error.detail = mercadoPagoErrorDetail(data);
      throw error;
    }

    return data;
  }
}

function buildPreferencePayload({ order, calculated, req }) {
  const item = buildPreferenceItem({ order, calculated, req });
  const base = publicBaseUrl(req);
  const webhook = notificationUrl(req);
  const phone = splitPhone(order.whatsapp || '');
  const preference = {
    items: [item],
    payer: {
      email: String(order.email || '').trim().toLowerCase(),
      ...splitName(order.client || ''),
      phone
    },
    external_reference: String(order.id || '').trim(),
    statement_descriptor: STATEMENT_DESCRIPTOR,
    metadata: {
      order_id: String(order.id || '').trim(),
      service_type: calculated.type,
      client: String(order.client || '').slice(0, 120),
      whatsapp: String(order.whatsapp || '').slice(0, 40)
    }
  };

  if (webhook) preference.notification_url = webhook;
  if (base) {
    preference.back_urls = {
      success: `${base}/?payment=approved&external_reference=${encodeURIComponent(order.id || '')}`,
      pending: `${base}/?payment=pending&external_reference=${encodeURIComponent(order.id || '')}`,
      failure: `${base}/?payment=failure&external_reference=${encodeURIComponent(order.id || '')}`
    };
    preference.auto_return = 'approved';
  }
  return preference;
}

async function handler(req, res) {
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

  const paymentPayload = buildPaymentPayload({ order, calculated, formData, req });
  if (!paymentPayload.payment_method_id) {
    res.status(400).json({ error: 'Meio de pagamento invalido.' });
    return;
  }

  try {
    const idempotencyKey = crypto.randomUUID();
    const data = await createMercadoPagoPayment(accessToken, paymentPayload, idempotencyKey);

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
    console.error('[process-payment] Mercado Pago payment failed', {
      orderId,
      message: error.message,
      detail: error.detail || null
    });
    res.status(error.status || 502).json({
      error: error.message || 'Nao foi possivel conectar ao Mercado Pago.',
      detail: error.detail || null
    });
  }
}

module.exports = handler;
module.exports.__mp = {
  calculateService,
  toMoney,
  roundMoney,
  publicBaseUrl,
  notificationUrl,
  buildMarketplaceItem,
  buildPreferenceItem,
  buildPaymentPayload,
  buildPreferencePayload,
  createMercadoPagoPayment,
  mercadoPagoErrorMessage,
  STATEMENT_DESCRIPTOR
};
