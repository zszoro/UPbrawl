const STORE_KEY = 'zsup:global-state:v1';
const ALLOWED_KEYS = new Set([
  'zsup_users',
  'zsup_orders',
  'zsup_chat',
  'zsup_products',
  'zsup_feedbacks',
  'zsup_owner_dismissed_notices',
  'zsup_availability',
  'zsup_site_edits',
  'zsup_edit_history',
  'zsup_uploader_payments'
]);
const ROLE_VALUES = new Set(['cliente', 'upador', 'mod', 'admin', 'dono', 'bot']);
const KEY_LIMITS = {
  zsup_users: 350000,
  zsup_orders: 850000,
  zsup_chat: 420000,
  zsup_products: 850000,
  zsup_feedbacks: 180000,
  zsup_availability: 240000,
  zsup_site_edits: 850000,
  zsup_edit_history: 650000,
  zsup_uploader_payments: 220000
};

let memoryState = {};
let memoryUpdatedAt = 0;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function safeString(value, max = 160) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeRole(role) {
  return ROLE_VALUES.has(role) ? role : 'cliente';
}

function assertAllowedKey(key) {
  if (!ALLOWED_KEYS.has(key)) throw httpError(400, 'Chave de estado nao permitida.');
}

function assertWithinLimit(key, value) {
  const limit = KEY_LIMITS[key] || 300000;
  if (jsonSize(value) > limit) throw httpError(413, 'Estado muito grande para sincronizar.');
}

function sanitizeMessage(message = {}) {
  const id = safeString(message.id, 80);
  if (!id) return null;
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.map(item => safeString(item, 80)).filter(Boolean).slice(0, 30)
    : [];
  const clean = {
    id,
    authorId: safeString(message.authorId, 120),
    author: safeString(message.author || 'Sistema', 120),
    role: safeRole(message.role || 'bot'),
    text: safeString(message.text, 700),
    mentions,
    createdAt: safeString(message.createdAt, 60),
    createdAtMs: Number(message.createdAtMs) || 0
  };
  ['privateTo', 'kind', 'taskId', 'status', 'title', 'updatedAt', 'deletedAt', 'deletedBy'].forEach(key => {
    if (message[key] !== undefined) clean[key] = safeString(message[key], key === 'title' ? 120 : 80);
  });
  ['updatedAtMs', 'deletedAtMs'].forEach(key => {
    if (message[key] !== undefined) clean[key] = Number(message[key]) || 0;
  });
  if (Array.isArray(message.lines)) clean.lines = message.lines.map(line => safeString(line, 220)).slice(0, 20);
  if (message.icon) {
    const icon = safeString(message.icon, 260);
    clean.icon = /^\/|^https:\/\//i.test(icon) ? icon : '';
  }
  return clean;
}

function sanitizeUser(user = {}) {
  const id = safeString(user.id, 120);
  const email = safeString(user.email, 180).toLowerCase();
  if (!id && !email) return null;
  const passwordHash = safeString(user.passwordHash, 80).toLowerCase();
  return {
    id,
    name: safeString(user.name || 'Usuario', 120),
    email,
    phone: safeString(user.phone, 40),
    role: safeRole(user.role || 'cliente'),
    active: user.active !== false,
    customerCode: safeString(user.customerCode, 80),
    pixKey: safeString(user.pixKey, 180),
    passwordHash: /^[a-f0-9]{64}$/.test(passwordHash) ? passwordHash : '',
    source: safeString(user.source, 40),
    needsPasswordReset: Boolean(user.needsPasswordReset)
  };
}

function sanitizeValueForKey(key, value) {
  assertAllowedKey(key);
  assertWithinLimit(key, value);
  if (key === 'zsup_chat') {
    return (Array.isArray(value) ? value : [])
      .map(sanitizeMessage)
      .filter(Boolean)
      .slice(-300);
  }
  if (key === 'zsup_users') {
    return (Array.isArray(value) ? value : [])
      .map(sanitizeUser)
      .filter(Boolean)
      .slice(-500);
  }
  if (Array.isArray(value)) return value.slice(-700);
  return value && typeof value === 'object' ? value : value;
}

function sanitizeStateSnapshot(state = {}) {
  const clean = {};
  for (const [rawKey, rawValue] of Object.entries(state || {})) {
    const key = String(rawKey);
    if (!ALLOWED_KEYS.has(key)) continue;
    try {
      clean[key] = sanitizeValueForKey(key, rawValue);
    } catch (error) {
      if (error.status === 413) continue;
      throw error;
    }
  }
  return clean;
}

function readBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return req.body || {};
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function redisCommand(command, ...args) {
  const cfg = redisConfig();
  if (!cfg) return null;

  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([command.toUpperCase(), ...args]),
    cache: 'no-store'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Redis ${command} failed.`);
  return data.result;
}

async function readState() {
  const raw = await redisCommand('get', STORE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return {
        state: sanitizeStateSnapshot(parsed.state || {}),
        updatedAt: parsed.updatedAt || Date.now()
      };
    } catch (error) {
      return { state: {}, updatedAt: Date.now() };
    }
  }
  return { state: sanitizeStateSnapshot(memoryState), updatedAt: memoryUpdatedAt };
}

async function writeState(payload) {
  const updated = {
    state: sanitizeStateSnapshot(payload.state || {}),
    updatedAt: Date.now()
  };
  const cfg = redisConfig();
  if (cfg) {
    await redisCommand('set', STORE_KEY, JSON.stringify(updated));
  } else {
    memoryState = updated.state;
    memoryUpdatedAt = updated.updatedAt;
  }
  return updated;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      res.status(200).json(await readState());
      return;
    }

    if (req.method === 'PATCH' || req.method === 'POST') {
      const body = readBody(req);
      const current = await readState();
      const next = { ...(current.state || {}) };

      if (body.replace && body.state && typeof body.state === 'object') {
        for (const [rawKey, rawValue] of Object.entries(body.state)) {
          const key = String(rawKey);
          next[key] = sanitizeValueForKey(key, rawValue);
        }
      } else if (body.key) {
        const key = String(body.key);
        next[key] = sanitizeValueForKey(key, body.value);
      } else {
        res.status(400).json({ error: 'Informe key/value ou state.' });
        return;
      }

      res.status(200).json(await writeState({ state: next }));
      return;
    }

    res.status(405).json({ error: 'Metodo nao permitido.' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Erro ao sincronizar estado global.' });
  }
};
