// server.js — TeoGlobal License Server (v2 — Turso + Dashboard)
const express = require('express');
const cors = require('cors');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.LICENSE_SECRET;
if (!SECRET) {
  console.error('❌ LICENSE_SECRET não definida');
  process.exit(1);
}

// ── Banco (Turso) ───────────────────────────────────────────────────
const db = require('./db');

// ── Autenticação ────────────────────────────────────────────────────
const auth = require('./auth');

// ── Express ─────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Rate limiting
const rateLimitMap = new Map();
function rateLimit(max = 10, ms = 300000) {
  return (req, res, next) => {
    const ip = req.ip || '127.0.0.1';
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const ts = rateLimitMap.get(ip).filter(t => now - t < ms);
    if (ts.length >= max) return res.status(429).json({ error: 'Muitas requisições', code: 'RATE_LIMITED' });
    ts.push(now);
    rateLimitMap.set(ip, ts);
    next();
  };
}

// ── Inicializa auth ─────────────────────────────────────────────────
auth.init(app);

// ── Arquivos estáticos ──────────────────────────────────────────────
app.use('/admin', auth.requireLogin, express.static(path.join(__dirname, 'public')));
app.get('/admin', auth.requireLogin, (req, res) => res.redirect('/admin/dashboard.html'));

// ── Health check ────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({ status: 'ok', service: 'TeoGlobal License Server v2', ...stats });
  } catch (e) {
    res.json({ status: 'ok', service: 'TeoGlobal License Server v2' });
  }
});

// ── Auth API ────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  if (auth.login(req.body.password)) {
    req.session.loggedIn = true;
    db.addAuditLog('login', null, 'Login no dashboard', req.ip).catch(() => {});
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

// ── License Public API ──────────────────────────────────────────────
app.post('/api/license/activate', rateLimit(20), async (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) return res.status(400).json({ error: 'license_key e hwid obrigatórios' });
  const r = await db.activateLicense(license_key, hwid, SECRET);
  if (r.error) {
    const m = { LICENSE_NOT_FOUND: 404, LICENSE_REVOKED: 403, LICENSE_EXPIRED: 403, HWID_MISMATCH: 403 };
    return res.status(m[r.code] || 400).json(r);
  }
  db.addAuditLog('activate', license_key, 'Ativação OK', req.ip).catch(() => {});
  res.json(r);
});

app.post('/api/license/validate', rateLimit(60), async (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) return res.status(400).json({ error: 'license_key e hwid obrigatórios' });
  const r = await db.validateLicense(license_key, hwid, SECRET);
  if (r.error) {
    const m = { LICENSE_NOT_FOUND: 404, LICENSE_REVOKED: 403, LICENSE_EXPIRED: 403, HWID_MISMATCH: 403 };
    return res.status(m[r.code] || 400).json(r);
  }
  res.json(r);
});

// ── Admin middleware ─────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] === SECRET) { req.adminSource = 'cli'; return next(); }
  if (req.session?.loggedIn) { req.adminSource = 'dashboard'; return next(); }
  res.status(401).json({ error: 'Não autorizado' });
}

// ── Admin API ───────────────────────────────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => res.json(await db.getStats()));

app.post('/api/admin/generate-key', adminAuth, async (req, res) => {
  const { duration_days, duration_hours, customer_name, notes } = req.body;
  const r = await db.createLicense({ duration_days, duration_hours, customer_name, notes });
  const label = duration_hours ? `${duration_hours}h` : (duration_days >= 36500 ? 'vitalício' : `${duration_days || 30} dias`);
  db.addAuditLog('generate', r.license_key, `Gerada ${label} por ${req.adminSource}`, req.ip).catch(() => {});
  res.json({ success: true, license_key: r.license_key, expires_at: r.expires_at, duration: label });
});

app.get('/api/admin/licenses', adminAuth, async (req, res) => {
  const { status, search, expiring_days, limit } = req.query;
  const f = {};
  if (status) f.status = status;
  if (search) f.search = search;
  if (expiring_days) f.expiring_days = parseInt(expiring_days);
  if (limit) f.limit = parseInt(limit);
  const licenses = await db.listLicenses(f);
  res.json(licenses.map(l => ({ ...l, hwid: l.hwid ? '----' : null })));
});

app.get('/api/admin/licenses/:key', adminAuth, async (req, res) => {
  const l = await db.findLicense(req.params.key);
  if (!l) return res.status(404).json({ error: 'Não encontrada' });
  res.json({ ...l, hwid: l.hwid ? '----' : null });
});

app.post('/api/admin/revoke', adminAuth, async (req, res) => {
  const r = await db.revokeLicense(req.body.license_key);
  if (r.error) return res.status(404).json(r);
  db.addAuditLog('revoke', req.body.license_key, `Revogada por ${req.adminSource}`, req.ip).catch(() => {});
  res.json({ success: true });
});

app.post('/api/admin/extend', adminAuth, async (req, res) => {
  const { license_key, days, hours } = req.body;
  const r = await db.extendLicense(license_key, days, hours);
  if (r.error) return res.status(404).json(r);
  db.addAuditLog('extend', license_key, `Estendida por ${req.adminSource}`, req.ip).catch(() => {});
  res.json(r);
});

app.post('/api/admin/reset-hwid', adminAuth, async (req, res) => {
  const r = await db.resetHwid(req.body.license_key);
  if (r.error) return res.status(404).json(r);
  db.addAuditLog('reset_hwid', req.body.license_key, `HWID resetado`, req.ip).catch(() => {});
  res.json({ success: true });
});

app.post('/api/admin/cleanup', adminAuth, async (req, res) => {
  const r = await db.cleanupLicenses();
  db.addAuditLog('cleanup', null, `${r.removed} removidas`, req.ip).catch(() => {});
  res.json({ success: true, removed: r.removed, remaining: r.remaining });
});

app.get('/api/admin/audit', adminAuth, async (req, res) => {
  res.json(await db.getAuditLogs(parseInt(req.query.limit) || 100));
});

app.get('/api/admin/backup', adminAuth, async (req, res) => {
  const backup = await db.exportBackup();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.send(backup);
});

// ── Start ───────────────────────────────────────────────────────────
(async () => {
  await db.open();
  app.listen(PORT, () => {
    console.log(`✅ Server rodando na porta ${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/admin`);
  });
})();
