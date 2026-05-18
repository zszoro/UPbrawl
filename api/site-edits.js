const { verifyEditSession } = require('./edit-session.js');
const fs = require('fs');
const path = require('path');

const STORE_KEY = 'zsup:global-state:v1';
const EDITS_KEY = 'zsup_site_edits';
const HISTORY_KEY = 'zsup_edit_history';

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
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command.toUpperCase(), ...args]),
    cache: 'no-store'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Redis ${command} failed.`);
  return data.result;
}

async function readGlobal() {
  const raw = await redisCommand('get', STORE_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch { return { state: {}, updatedAt: Date.now() }; }
  }
  return { state: memoryState, updatedAt: memoryUpdatedAt };
}

async function writeGlobal(state) {
  const payload = { state, updatedAt: Date.now() };
  const cfg = redisConfig();
  if (cfg) await redisCommand('set', STORE_KEY, JSON.stringify(payload));
  else { memoryState = payload.state; memoryUpdatedAt = payload.updatedAt; }
  return payload;
}

function cleanEdit(edit = {}) {
  return {
    page: String(edit.page || 'home').slice(0, 80),
    elementId: String(edit.elementId || '').slice(0, 180),
    elementName: String(edit.elementName || '').slice(0, 180),
    type: String(edit.type || 'style').slice(0, 40),
    prop: String(edit.prop || '').slice(0, 40),
    oldValue: String(edit.oldValue ?? '').slice(0, 3000),
    newValue: String(edit.newValue ?? '').slice(0, 3000)
  };
}

function historyItem({ edit, user, reverted = false }) {
  return {
    id: `EDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...edit,
    userId: user.sub || '',
    userName: user.name || 'Admin',
    userRole: user.role || 'admin',
    createdAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    createdAtMs: Date.now(),
    reverted
  };
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tryMaterializeHtml(edits) {
  const file = path.join(process.cwd(), 'index.html');
  if (!fs.existsSync(file)) return false;
  const markerStart = '<script id="site-edits-snapshot" type="application/json">';
  const markerEnd = '</script>';
  const payload = `${markerStart}${htmlEscape(JSON.stringify(edits || {}))}${markerEnd}`;
  let html = fs.readFileSync(file, 'utf8');
  const start = html.indexOf(markerStart);
  if (start >= 0) {
    const end = html.indexOf(markerEnd, start);
    if (end >= 0) {
      html = `${html.slice(0, start)}${payload}${html.slice(end + markerEnd.length)}`;
    }
  } else {
    html = html.replace('</body>', `${payload}\n</body>`);
  }
  fs.writeFileSync(file, html, 'utf8');
  return true;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const current = await readGlobal();
    const state = { ...(current.state || {}) };
    const edits = state[EDITS_KEY] || {};
    const history = state[HISTORY_KEY] || [];

    if (req.method === 'GET') {
      res.status(200).json({ edits, history, updatedAt: current.updatedAt || 0 });
      return;
    }

    const session = verifyEditSession(req);
    if (!session || !['dono', 'admin'].includes(String(session.role || '').toLowerCase())) {
      res.status(403).json({ error: 'Sessão de edição inválida ou expirada.' });
      return;
    }

    if (req.method === 'POST') {
      const body = readBody(req);
      const edit = cleanEdit(body.edit || body);
      if (!edit.elementId || !edit.prop) {
        res.status(400).json({ error: 'Informe elemento e propriedade.' });
        return;
      }

      if (!edits[edit.elementId]) edits[edit.elementId] = {};
      edits[edit.elementId][edit.prop] = edit.newValue;
      const item = historyItem({ edit, user: session });
      state[EDITS_KEY] = edits;
      state[HISTORY_KEY] = [item, ...history].slice(0, 500);
      const saved = await writeGlobal(state);
      let htmlMaterialized = false;
      if (body.materialize) {
        try { htmlMaterialized = tryMaterializeHtml(state[EDITS_KEY]); } catch {}
      }
      res.status(200).json({ ok: true, edit: item, edits: state[EDITS_KEY], history: state[HISTORY_KEY], updatedAt: saved.updatedAt, htmlMaterialized });
      return;
    }

    if (req.method === 'PUT') {
      const body = readBody(req);
      const item = history.find(h => h.id === body.id);
      if (!item) {
        res.status(404).json({ error: 'Alteração não encontrada.' });
        return;
      }
      if (!edits[item.elementId]) edits[item.elementId] = {};
      if (item.oldValue) edits[item.elementId][item.prop] = item.oldValue;
      else delete edits[item.elementId][item.prop];
      const revertEdit = {
        page: item.page,
        elementId: item.elementId,
        elementName: item.elementName,
        type: 'reversao',
        prop: item.prop,
        oldValue: item.newValue,
        newValue: item.oldValue
      };
      const revertItem = historyItem({ edit: revertEdit, user: session, reverted: true });
      state[EDITS_KEY] = edits;
      state[HISTORY_KEY] = [revertItem, ...history.map(h => h.id === item.id ? { ...h, reverted: true } : h)].slice(0, 500);
      const saved = await writeGlobal(state);
      res.status(200).json({ ok: true, edit: revertItem, edits: state[EDITS_KEY], history: state[HISTORY_KEY], updatedAt: saved.updatedAt });
      return;
    }

    res.status(405).json({ error: 'Metodo nao permitido.' });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Erro ao salvar edição.' });
  }
};
