// launcher.js — Inicia o servidor e abre o dashboard
// Este arquivo eh o ponto de entrada do .exe (pkg)

const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const SECRET = process.env.LICENSE_SECRET || 'rI0KPMDj6yk3OXSzLmYxs74fqbTaicB8NH9AWRvJtlgFGwVQ';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'teoglobal-session-' + Math.random().toString(36).slice(2);

// Garante que as env vars estejam disponiveis
process.env.LICENSE_SECRET = SECRET;
process.env.DASHBOARD_PASSWORD = DASHBOARD_PASSWORD;
process.env.SESSION_SECRET = SESSION_SECRET;
process.env.PORT = String(PORT);

// ── Banco de dados ──────────────────────────────────────────────────
const db = require('./db');

// ── Autenticação ────────────────────────────────────────────────────
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const passwordHash = bcrypt.hashSync(DASHBOARD_PASSWORD, 10);

// ── Express App ─────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Sessão
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Rate Limiting ───────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(maxRequests = 10, windowMs = 5 * 60 * 1000) {
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ error: 'Muitas requisições. Tente novamente.', code: 'RATE_LIMITED' });
    }
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);
    next();
  };
}

// ── Middleware de autenticação ───────────────────────────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path === '/login.html' || req.path === '/api/auth/login') return next();
  if (req.path.startsWith('/api/') && req.path !== '/api/auth/login') {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  res.redirect('/admin/login.html');
}

function adminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey === SECRET) { req.adminSource = 'cli'; return next(); }
  if (req.session && req.session.loggedIn) { req.adminSource = 'dashboard'; return next(); }
  return res.status(401).json({ error: 'Acesso não autorizado' });
}

// ── Servir arquivos estáticos ───────────────────────────────────────
app.use('/admin', requireLogin, express.static(path.join(__dirname, 'public')));
app.get('/admin', requireLogin, (req, res) => res.redirect('/admin/dashboard.html'));

// ── Health check ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const stats = db.getStats();
  res.json({ status: 'ok', service: 'TeoGlobal License Server v2', ...stats });
});

// ── Auth API ────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (bcrypt.compareSync(password, passwordHash)) {
    req.session.loggedIn = true;
    db.addAuditLog('login', null, 'Login no dashboard', req.ip);
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ loggedIn: !!req.session?.loggedIn });
});

// ── License Public API ──────────────────────────────────────────────
app.post('/api/license/activate', rateLimit(20), (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) return res.status(400).json({ error: 'license_key e hwid são obrigatórios' });
  const result = db.activateLicense(license_key, hwid, SECRET);
  if (result.error) {
    const m = { LICENSE_NOT_FOUND: 404, LICENSE_REVOKED: 403, LICENSE_EXPIRED: 403, HWID_MISMATCH: 403 };
    return res.status(m[result.code] || 400).json(result);
  }
  db.addAuditLog('activate', license_key, 'Ativação bem-sucedida', req.ip);
  res.json(result);
});

app.post('/api/license/validate', rateLimit(60), (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) return res.status(400).json({ error: 'license_key e hwid são obrigatórios' });
  const result = db.validateLicense(license_key, hwid, SECRET);
  if (result.error) {
    const m = { LICENSE_NOT_FOUND: 404, LICENSE_REVOKED: 403, LICENSE_EXPIRED: 403, HWID_MISMATCH: 403 };
    return res.status(m[result.code] || 400).json(result);
  }
  res.json(result);
});

// ── Admin API ───────────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, (req, res) => res.json(db.getStats()));

app.post('/api/admin/generate-key', adminAuth, (req, res) => {
  const { duration_days, duration_hours, customer_name, notes } = req.body;
  if (duration_hours !== undefined && duration_hours !== null && (isNaN(duration_hours) || duration_hours <= 0 || duration_hours > 8784))
    return res.status(400).json({ error: 'Horas inválidas (0.1 a 8784)' });
  if (duration_days !== undefined && duration_days !== null && (isNaN(duration_days) || duration_days <= 0))
    return res.status(400).json({ error: 'Dias inválidos' });
  const result = db.createLicense({ duration_days, duration_hours, customer_name, notes });
  let label = duration_hours ? `${duration_hours}h` : duration_days >= 36500 ? 'vitalício' : `${duration_days || 30} dias`;
  db.addAuditLog('generate', result.license_key, `Gerada ${label} para "${customer_name || '—'}" por ${req.adminSource}`, req.ip);
  res.json({ success: true, license_key: result.license_key, expires_at: result.expires_at, duration: label });
});

app.get('/api/admin/licenses', adminAuth, (req, res) => {
  const { status, search, expiring_days, limit } = req.query;
  const filters = {};
  if (status) filters.status = status;
  if (search) filters.search = search;
  if (expiring_days) filters.expiring_days = parseInt(expiring_days);
  if (limit) filters.limit = parseInt(limit);
  const licenses = db.listLicenses(filters);
  res.json(licenses.map(l => ({ ...l, hwid: l.hwid ? '----' : null })));
});

app.get('/api/admin/licenses/:key', adminAuth, (req, res) => {
  const license = db.findLicense(req.params.key);
  if (!license) return res.status(404).json({ error: 'Licença não encontrada' });
  res.json({ ...license, hwid: license.hwid ? '----' : null });
});

app.post('/api/admin/revoke', adminAuth, (req, res) => {
  const { license_key } = req.body;
  const result = db.revokeLicense(license_key);
  if (result.error) return res.status(404).json(result);
  db.addAuditLog('revoke', license_key, `Revogada por ${req.adminSource}`, req.ip);
  res.json({ success: true, message: 'Licença revogada' });
});

app.post('/api/admin/extend', adminAuth, (req, res) => {
  const { license_key, days, hours } = req.body;
  const result = db.extendLicense(license_key, days, hours);
  if (result.error) return res.status(404).json(result);
  const label = hours ? `${hours}h` : `${days || 30} dias`;
  db.addAuditLog('extend', license_key, `Estendida em ${label} por ${req.adminSource}`, req.ip);
  res.json(result);
});

app.post('/api/admin/reset-hwid', adminAuth, (req, res) => {
  const { license_key } = req.body;
  const result = db.resetHwid(license_key);
  if (result.error) return res.status(404).json(result);
  db.addAuditLog('reset_hwid', license_key, `HWID resetado por ${req.adminSource}`, req.ip);
  res.json({ success: true, message: 'HWID resetado' });
});

app.post('/api/admin/cleanup', adminAuth, (req, res) => {
  const result = db.cleanupLicenses();
  db.addAuditLog('cleanup', null, `${result.removed} licenças removidas por ${req.adminSource}`, req.ip);
  res.json({ success: true, removed: result.removed, remaining: result.remaining });
});

app.get('/api/admin/audit', adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(db.getAuditLogs(limit));
});

app.get('/api/admin/backup', adminAuth, (req, res) => {
  const backup = db.exportBackup();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=teoglobal-backup-${new Date().toISOString().slice(0,10)}.json`);
  res.send(backup);
});

// ── Start ───────────────────────────────────────────────────────────
db.open();
console.log('✅ Banco SQLite carregado');

  app.listen(PORT, () => {
    console.log(`\n========================================================`);
    console.log(`  Dashboard: http://localhost:${PORT}/admin`);
    console.log(`  Senha:     ${DASHBOARD_PASSWORD}`);
    console.log(`========================================================\n`);
  });

  // Abre o navegador automaticamente apos 2 segundos
  setTimeout(() => {
    const url = `http://localhost:${PORT}/admin`;
    const cmd = process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }, 2000);
