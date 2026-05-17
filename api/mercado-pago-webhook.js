const MERCADO_PAGO_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';
const STORE_KEY = 'zsup:global-state:v1';

function accessToken() {
  return process.env.MP_PROD_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN;
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function redisCommand(command, ...args) {
  const cfg = redisConfig();
  if (!cfg) return null;

  const response = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([command.toUpperCase(), ...args]),
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Redis ${command} failed.`);
  return data.result;
}

async function readGlobalState() {
  const raw = await redisCommand('get', STORE_KEY);
  if (!raw) return { state: {}, updatedAt: 0 };
  try {
    return JSON.parse(raw);
  } catch (error) {
    return { state: {}, updatedAt: 0 };
  }
}

async function writeGlobalState(state) {
  const payload = { state, updatedAt: Date.now() };
  await redisCommand('set', STORE_KEY, JSON.stringify(payload));
  return payload;
}

function readBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (error) { return {}; }
  }
  return req.body || {};
}

function paymentIdFrom(req) {
  const body = readBody(req);
  if (body?.data?.id) return String(body.data.id).trim();
  if (body?.id) return String(body.id).trim();
  if (body?.resource && /\/payments\/(\d+)/.test(body.resource)) return body.resource.match(/\/payments\/(\d+)/)[1];
  if (req.query?.id) return String(req.query.id).trim();
  if (req.query?.['data.id']) return String(req.query['data.id']).trim();

  try {
    const url = new URL(req.url || '', 'http://localhost');
    return String(url.searchParams.get('id') || url.searchParams.get('data.id') || '').trim();
  } catch (error) {
    return '';
  }
}

async function fetchPayment(id, token) {
  const response = await fetch(`${MERCADO_PAGO_PAYMENTS_URL}/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || 'Nao foi possivel consultar o pagamento.');
  return data;
}

function paymentAmountLabel(payment) {
  const value = Number(payment.transaction_amount || 0);
  return value ? `R$ ${value.toFixed(2).replace('.', ',')}` : '';
}

async function updateOrderFromPayment(payment) {
  const reference = String(payment.external_reference || payment.metadata?.order_id || '').trim();
  if (!reference || !redisConfig()) return false;

  const current = await readGlobalState();
  const state = current.state || {};
  const orders = Array.isArray(state.zsup_orders) ? state.zsup_orders : [];
  const order = orders.find(item => item.id === reference);
  if (!order) return false;

  order.paymentId = payment.id;
  order.paymentStatus = payment.status || order.paymentStatus;
  order.paymentStatusDetail = payment.status_detail || order.paymentStatusDetail || '';
  order.paymentAmount = paymentAmountLabel(payment) || order.paymentAmount || order.price;
  if (payment.status === 'approved') {
    order.paidAt = order.paidAt || new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    order.approvedAtMs = order.approvedAtMs || Date.now();
    order.status = order.accountProductId ? 'realizado' : order.uploaderId ? 'andamento' : 'pendente';
  }

  state.zsup_orders = orders;
  await writeGlobalState(state);
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ error: 'Metodo nao permitido.' });
    return;
  }

  const token = accessToken();
  if (!token) {
    res.status(200).json({ ok: true, skipped: 'missing_access_token' });
    return;
  }

  const id = paymentIdFrom(req);
  if (!/^\d+$/.test(id)) {
    res.status(200).json({ ok: true, skipped: 'missing_payment_id' });
    return;
  }

  try {
    const payment = await fetchPayment(id, token);
    const updated = await updateOrderFromPayment(payment);
    res.status(200).json({ ok: true, payment_id: payment.id, status: payment.status, updated });
  } catch (error) {
    res.status(200).json({ ok: true, error: error.message || 'webhook_error' });
  }
};
