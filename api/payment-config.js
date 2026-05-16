module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo nao permitido.' });
    return;
  }

  const publicKey = process.env.MP_PROD_PUBLIC_KEY || process.env.MERCADO_PAGO_PUBLIC_KEY || process.env.MP_PUBLIC_KEY;
  const mode = process.env.MP_MODE || 'production';

  if (!publicKey) {
    res.status(503).json({ error: 'Checkout ainda nao foi configurado. Defina MP_PROD_PUBLIC_KEY no Vercel.' });
    return;
  }

  res.status(200).json({ publicKey, mode });
};
