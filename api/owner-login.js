const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  const ownerEmail = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const ownerPasswordHash = String(process.env.OWNER_PASSWORD_HASH || '').trim().toLowerCase();

  if (!ownerEmail || !ownerPasswordHash) {
    res.status(503).json({ error: 'Login do dono ainda não foi configurado no Vercel.' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email = String(body.email || '').trim().toLowerCase();
  const passwordHash = sha256(body.password || '');

  if (email !== ownerEmail || !safeEqual(passwordHash, ownerPasswordHash)) {
    res.status(401).json({ error: 'Email ou senha do dono inválidos.' });
    return;
  }

  res.status(200).json({
    user: {
      id: 'USR-DONO-VERCEL',
      name: process.env.OWNER_NAME || 'Dono',
      email: ownerEmail,
      phone: process.env.OWNER_PHONE || '',
      role: 'dono',
      active: true,
      source: 'vercel'
    }
  });
};
