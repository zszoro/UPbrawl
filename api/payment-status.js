const MERCADO_PAGO_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';

function mercadoPagoErrorMessage(data = {}) {
  const causes = Array.isArray(data.cause)
    ? data.cause.map(cause => cause?.description || cause?.message || cause?.code).filter(Boolean)
    : [];
  return data.message || causes[0] || data.error || 'Nao foi possivel consultar o pagamento.';
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

function getPaymentId(req) {
  if (req.query && req.query.id) return String(req.query.id).trim();

  try {
    const url = new URL(req.url || '', 'http://localhost');
    return String(url.searchParams.get('id') || '').trim();
  } catch (error) {
    return '';
  }
}

function pickPaymentResponse(data = {}) {
  return {
    id: data.id,
    status: data.status,
    status_detail: data.status_detail,
    payment_method_id: data.payment_method_id,
    payment_type_id: data.payment_type_id,
    transaction_amount: data.transaction_amount,
    point_of_interaction: data.point_of_interaction,
    transaction_details: data.transaction_details,
    external_reference: data.external_reference
  };
}

async function getMercadoPagoPayment(accessToken, id) {
  try {
    const { MercadoPagoConfig, Payment } = require('mercadopago');
    const client = new MercadoPagoConfig({
      accessToken,
      options: { timeout: 10000 }
    });
    const payment = new Payment(client);
    return await payment.get({ id });
  } catch (sdkError) {
    const mpResponse = await fetch(`${MERCADO_PAGO_PAYMENTS_URL}/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo nao permitido.' });
    return;
  }

  const accessToken = process.env.MP_PROD_ACCESS_TOKEN || process.env.MERCADO_PAGO_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(503).json({ error: 'Pagamento real ainda nao foi configurado. Defina MP_PROD_ACCESS_TOKEN no Vercel.' });
    return;
  }

  const id = getPaymentId(req);
  if (!/^\d+$/.test(id)) {
    res.status(400).json({ error: 'ID do pagamento invalido.' });
    return;
  }

  try {
    const data = await getMercadoPagoPayment(accessToken, id);

    res.status(200).json(pickPaymentResponse(data));
  } catch (error) {
    console.error('[payment-status] Mercado Pago status failed', {
      id,
      message: error.message,
      detail: error.detail || null
    });
    res.status(error.status || 502).json({
      error: error.message || 'Nao foi possivel conectar ao Mercado Pago.',
      detail: error.detail || null
    });
  }
};
