const MERCADO_PAGO_PAYMENTS_URL = 'https://api.mercadopago.com/v1/payments';

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
    const mpResponse = await fetch(`${MERCADO_PAGO_PAYMENTS_URL}/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await mpResponse.json().catch(() => ({}));

    if (!mpResponse.ok) {
      res.status(502).json({ error: data.message || data.error || 'Nao foi possivel consultar o pagamento.', detail: data });
      return;
    }

    res.status(200).json(pickPaymentResponse(data));
  } catch (error) {
    res.status(502).json({ error: 'Nao foi possivel conectar ao Mercado Pago.' });
  }
};
