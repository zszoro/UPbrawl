const crypto = require('crypto');

const COOKIE_NAME = 'zsup_edit_session';
const MAX_AGE = 60 * 60 * 6;

function readBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function secret() {
  return process.env.EDIT_SESSION_SECRET || process.env.OWNER_PASSWORD_HASH || process.env.EDIT_MODE_PASSWORD_HASH || 'zsup-edit-secret';
}

function expectedPasswordHash() {
  return process.env.EDIT_MODE_PASSWORD_HASH || (process.env.EDIT_MODE_PASSWORD ? sha256(process.env.EDIT_MODE_PASSWORD) : '');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function makeToken(user = {}) {
  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id || user.email || 'admin').slice(0, 120),
    name: String(user.name || 'Admin').slice(0, 120),
    role: String(user.role || 'admin').slice(0, 40),
    iat: Date.now()
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token = '') {
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature || sign(payload) !== signature) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (Date.now() - Number(data.iat || 0) > MAX_AGE * 1000) return null;
  return data;
}

function cookieValue(req) {
  const cookie = req.headers?.cookie || '';
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const session = verifyToken(cookieValue(req));
      res.status(200).json({ ok: Boolean(session), session });
      return;
    }

    if (req.method === 'DELETE') {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Metodo nao permitido.' });
      return;
    }

    const body = readBody(req);
    const configuredHash = expectedPasswordHash();
    if (!configuredHash) {
      res.status(503).json({ error: 'Defina EDIT_MODE_PASSWORD ou EDIT_MODE_PASSWORD_HASH no ambiente.' });
      return;
    }

    const role = String(body.user?.role || '').toLowerCase();
    if (!['dono', 'admin'].includes(role)) {
      res.status(403).json({ error: 'Apenas dono/admin pode ativar o modo edição.' });
      return;
    }

    if (sha256(body.password || '') !== configuredHash) {
      res.status(401).json({ error: 'Senha do modo edição inválida.' });
      return;
    }

    const token = makeToken(body.user || {});
    const secure = req.headers?.['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`);
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao criar sessão de edição.' });
  }
};

module.exports.verifyEditSession = function verifyEditSession(req) {
  return verifyToken(cookieValue(req));
};
