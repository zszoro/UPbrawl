const STORE_KEY = 'zsup:global-state:v1';

let memoryState = {};
let memoryUpdatedAt = 0;

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
      return JSON.parse(raw);
    } catch (error) {
      return { state: {}, updatedAt: Date.now() };
    }
  }
  return { state: memoryState, updatedAt: memoryUpdatedAt };
}

async function writeState(payload) {
  const updated = {
    state: payload.state || {},
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
        Object.assign(next, body.state);
      } else if (body.key) {
        next[String(body.key)] = body.value;
      } else {
        res.status(400).json({ error: 'Informe key/value ou state.' });
        return;
      }

      res.status(200).json(await writeState({ state: next }));
      return;
    }

    res.status(405).json({ error: 'Metodo nao permitido.' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao sincronizar estado global.' });
  }
};
