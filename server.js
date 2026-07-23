const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.LICENSE_SECRET || 'teoglobal-secret-key-change-me';
const DB_FILE = path.join(__dirname, 'licenses.json');

// ── Database (JSON file) ────────────────────────────────────────────
let db = { licenses: [] };

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Erro ao carregar licenses.json:', e.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (e) {
    console.error('Erro ao salvar licenses.json:', e.message);
  }
}

loadDb();

// ── Helpers ─────────────────────────────────────────────────────────
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(0, chars.length)]).join('');
  return `TEO-${part()}-${part()}-${part()}-${part()}`;
}

function hashHwid(hwid) {
  return crypto.createHash('sha256').update(hwid + SECRET).digest('hex');
}

function getDaysRemaining(expiresAt) {
  const now = new Date();
  const expires = new Date(expiresAt);
  return Math.max(0, Math.ceil((expires - now) / (1000 * 60 * 60 * 24)));
}

function getHoursRemaining(expiresAt) {
  const now = new Date();
  const expires = new Date(expiresAt);
  const totalHours = Math.max(0, (expires - now) / (1000 * 60 * 60));
  return Math.round(totalHours * 10) / 10; // 1 casa decimal
}

function getRemainingInfo(expiresAt) {
  const days = getDaysRemaining(expiresAt);
  const hours = getHoursRemaining(expiresAt);
  return {
    days_remaining: days,
    hours_remaining: hours < 24 ? hours : null // só envia horas se < 24h
  };
}

function findLicense(key) {
  return db.licenses.find(l => l.license_key === key.toUpperCase().trim());
}

// ── Express App ─────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'TeoGlobal License Server', licenses: db.licenses.length });
});

// ── POST /api/license/activate ──────────────────────────────────────
app.post('/api/license/activate', (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) {
    return res.status(400).json({ error: 'license_key e hwid são obrigatórios' });
  }

  const license = findLicense(license_key);
  if (!license) {
    return res.status(404).json({ error: 'Licença não encontrada', code: 'LICENSE_NOT_FOUND' });
  }

  if (license.status === 'revoked') {
    return res.status(403).json({ error: 'Licença revogada', code: 'LICENSE_REVOKED' });
  }

  const now = new Date();
  if (new Date(license.expires_at) < now) {
    license.status = 'expired';
    saveDb();
    return res.status(403).json({ error: 'Licença expirada', code: 'LICENSE_EXPIRED', expired_at: license.expires_at });
  }

  // Se já tem HWID vinculado
  if (license.hwid) {
    const providedHash = hashHwid(hwid);
    if (license.hwid !== providedHash) {
      return res.status(403).json({
        error: 'Esta licença já está ativada em outro computador',
        code: 'HWID_MISMATCH'
      });
    }
    // Mesmo HWID — atualiza heartbeat
    license.last_heartbeat = new Date().toISOString();
    saveDb();
    return res.json({
      success: true,
      message: 'Licença já ativada — validada com sucesso',
      ...getRemainingInfo(license.expires_at),
      expires_at: license.expires_at
    });
  }

  // Primeira ativação: vincula HWID
  license.hwid = hashHwid(hwid);
  license.hwid_bound_at = new Date().toISOString();
  license.last_heartbeat = new Date().toISOString();
  saveDb();

  res.json({
    success: true,
    message: 'Licença ativada com sucesso!',
    ...getRemainingInfo(license.expires_at),
    expires_at: license.expires_at
  });
});

// ── POST /api/license/validate ──────────────────────────────────────
app.post('/api/license/validate', (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) {
    return res.status(400).json({ error: 'license_key e hwid são obrigatórios' });
  }

  const license = findLicense(license_key);
  if (!license) {
    return res.status(404).json({ error: 'Licença não encontrada', code: 'LICENSE_NOT_FOUND' });
  }

  if (license.status === 'revoked') {
    return res.status(403).json({ error: 'Licença revogada', code: 'LICENSE_REVOKED' });
  }

  const now = new Date();
  if (new Date(license.expires_at) < now) {
    license.status = 'expired';
    saveDb();
    return res.status(403).json({ error: 'Licença expirada', code: 'LICENSE_EXPIRED', expired_at: license.expires_at });
  }

  // Verifica HWID
  if (license.hwid) {
    const providedHash = hashHwid(hwid);
    if (license.hwid !== providedHash) {
      return res.status(403).json({
        error: 'Esta licença está vinculada a outro computador',
        code: 'HWID_MISMATCH'
      });
    }
  }

  // Atualiza heartbeat
  license.last_heartbeat = new Date().toISOString();
  saveDb();

  res.json({
    success: true,
    ...getRemainingInfo(license.expires_at),
    expires_at: license.expires_at,
    customer_name: license.customer_name
  });
});

// ── Admin endpoints (protegidos por chave secreta) ──────────────────
function adminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (adminKey !== SECRET) {
    return res.status(401).json({ error: 'Acesso não autorizado' });
  }
  next();
}

// POST /api/admin/generate-key
app.post('/api/admin/generate-key', adminAuth, (req, res) => {
  const { duration_days, duration_hours, customer_name, notes } = req.body;

  // Calcula expiração: prioriza horas se fornecidas, senão usa dias (default 30)
  let expiresAt;
  let durationLabel;
  if (duration_hours && duration_hours > 0) {
    expiresAt = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();
    durationLabel = `${duration_hours}h`;
  } else {
    const days = duration_days || 30;
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    durationLabel = `${days} dias`;
  }

  const licenseKey = generateLicenseKey();

  const license = {
    id: db.licenses.length + 1,
    license_key: licenseKey,
    status: 'active',
    duration_days: duration_days || null,
    duration_hours: duration_hours || null,
    hwid: null,
    hwid_bound_at: null,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    last_heartbeat: null,
    customer_name: customer_name || null,
    notes: notes || null
  };

  db.licenses.push(license);
  saveDb();

  res.json({
    success: true,
    license_key: licenseKey,
    expires_at: expiresAt,
    duration: durationLabel
  });
});

// GET /api/admin/licenses
app.get('/api/admin/licenses', adminAuth, (req, res) => {
  const safe = db.licenses.map(l => ({ ...l, hwid: l.hwid ? '****' : null }));
  res.json(safe);
});

// POST /api/admin/revoke
app.post('/api/admin/revoke', adminAuth, (req, res) => {
  const { license_key } = req.body;
  const license = findLicense(license_key);
  if (!license) {
    return res.status(404).json({ error: 'Licença não encontrada' });
  }
  license.status = 'revoked';
  saveDb();
  res.json({ success: true, message: 'Licença revogada' });
});

// POST /api/admin/extend
app.post('/api/admin/extend', adminAuth, (req, res) => {
  const { license_key, days } = req.body;
  const license = findLicense(license_key);
  if (!license) return res.status(404).json({ error: 'Licença não encontrada' });

  const currentExpiry = new Date(license.expires_at);
  const now = new Date();
  const base = currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  license.expires_at = newExpiry.toISOString();
  license.status = 'active';
  saveDb();

  res.json({ success: true, new_expires_at: newExpiry.toISOString(), days_added: days });
});

// POST /api/admin/cleanup — Remove licencas revogadas e expiradas
app.post('/api/admin/cleanup', adminAuth, (req, res) => {
  const before = db.licenses.length;
  db.licenses = db.licenses.filter(l => l.status === 'active');
  const removed = before - db.licenses.length;
  saveDb();
  res.json({ success: true, removed, remaining: db.licenses.length });
});

// ── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`License server running on port ${PORT}`);
});
