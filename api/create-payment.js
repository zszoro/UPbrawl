const MERCADO_PAGO_PREFERENCES_URL = 'https://api.mercadopago.com/checkout/preferences';

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
    const amount = calcTrofeu(atual, subir);
    return {
      type,
      amount,
      title: 'UP Trofeu',
      description: `Atual: ${atual} trofeus | Subir: ${subir} trofeus`
    };
  }

  if (type === 'ranked') {
    const fromIndex = toInteger(service.fromIndex);
    const toIndex = toInteger(service.toIndex);
    const amount = calcRanked(fromIndex, toIndex);
    return {
      type,
      amount,
      title: 'UP Ranked',
      description: `${RANK_NAMES[fromIndex]} -> ${RANK_NAMES[toIndex]}`
    };
  }

  if (type === 'prestigio') {
    const currentTrophies = toInteger(service.currentTrophies);
    const level = toInteger(service.level);
    const brawler = String(service.brawler || 'Brawler').trim().slice(0, 80);
    const amount = calcPrestigio(currentTrophies, level);
    return {
      type,
      amount,
      title: 'UP Prestigio',
      description: `Prestigio ${level} - ${brawler}`
    };
  }

  throw new Error('Servico de pagamento invalido.');
}

function getBaseUrl(req) {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/$/, '');
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`.replace(/\/$/, '');

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  return `${protocol}://${host}`.replace(/\/$/, '');
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
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

  if (calculated.amount < 1) {
    res.status(400).json({ error: 'Valor minimo para pagamento: R$ 1,00.' });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const reference = encodeURIComponent(orderId);
  const phoneDigits = onlyDigits(whatsapp);
  const payer = { name: client, email };
  if (phoneDigits.length >= 10) {
    payer.phone = {
      area_code: phoneDigits.slice(0, 2),
      number: phoneDigits.slice(2)
    };
  }

  const preference = {
    items: [
      {
        id: orderId,
        title: calculated.title,
        description: calculated.description,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: calculated.amount
      }
    ],
    payer,
    back_urls: {
      success: `${baseUrl}/?payment_status=approved&external_reference=${reference}`,
      pending: `${baseUrl}/?payment_status=pending&external_reference=${reference}`,
      failure: `${baseUrl}/?payment_status=failure&external_reference=${reference}`
    },
    auto_return: 'approved',
    external_reference: orderId,
    metadata: {
      order_id: orderId,
      service_type: calculated.type,
      scheduled_date: String(order.date || '').slice(0, 40),
      scheduled_time: String(order.time || '').slice(0, 20),
      client,
      whatsapp
    },
    statement_descriptor: 'ZSUPBRAWL'
  };

  const notificationUrl = process.env.MERCADO_PAGO_NOTIFICATION_URL;
  if (notificationUrl) preference.notification_url = notificationUrl;

  try {
    const mpResponse = await fetch(MERCADO_PAGO_PREFERENCES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preference)
    });
    const data = await mpResponse.json().catch(() => ({}));

    if (!mpResponse.ok) {
      res.status(502).json({ error: data.message || data.error || 'Mercado Pago recusou a preferencia de pagamento.' });
      return;
    }

    res.status(200).json({
      preference_id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      amount: calculated.amount
    });
  } catch (error) {
    res.status(502).json({ error: 'Nao foi possivel conectar ao Mercado Pago.' });
  }
};
