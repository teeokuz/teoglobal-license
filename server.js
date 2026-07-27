// server.js — TeoGlobal License Server (v2 — SQLite + Dashboard)
const express = require('express');
const cors = require('cors');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SECRET = process.env.LICENSE_SECRET;
if (!SECRET) {
  console.error('❌ ERRO: LICENSE_SECRET não definida. Configure a variável de ambiente.');
  process.exit(1);
}

// ── Banco de dados (SQLite) ─────────────────────────────────────────
const db = require('./db');

// ── Autenticação do dashboard ───────────────────────────────────────
const auth = require('./auth');

// ── Express ─────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── Rate Limiting simples ───────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(maxRequests = 10, windowMs = 5 * 60 * 1000) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ error: 'Muitas requisições. Tente novamente em alguns minutos.', code: 'RATE_LIMITED' });
    }
    timestamps.push(now);
    rateLimitMap.set(ip, timestamps);
    next();
  };
}
// Limpa rate limit map a cada 10 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimitMap) {
    const filtered = timestamps.filter(t => now - t < 5 * 60 * 1000);
    if (filtered.length === 0) rateLimitMap.delete(ip);
    else rateLimitMap.set(ip, filtered);
  }
}, 10 * 60 * 1000);

// ── Inicializa autenticação ─────────────────────────────────────────
auth.init(app);

// ── Servir arquivos estáticos do dashboard ──────────────────────────
app.use('/admin', auth.requireLogin, express.static(path.join(__dirname, 'public')));

// Redireciona /admin para o dashboard
app.get('/admin', auth.requireLogin, (req, res) => {
  res.redirect('/admin/dashboard.html');
});

// ── Health check ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const stats = db.getStats();
  res.json({ status: 'ok', service: 'TeoGlobal License Server v2', ...stats });
});

// ═══════════════════════════════════════════════════════════════════════
// API PÚBLICA — Validação de licenças (cliente Kotlin)
// ═══════════════════════════════════════════════════════════════════════

// POST /api/license/activate
app.post('/api/license/activate', rateLimit(20, 5 * 60 * 1000), (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) {
    return res.status(400).json({ error: 'license_key e hwid são obrigatórios' });
  }

  const result = db.activateLicense(license_key, hwid, SECRET);

  if (result.error) {
    const statusMap = {
      LICENSE_NOT_FOUND: 404,
      LICENSE_REVOKED: 403,
      LICENSE_EXPIRED: 403,
      HWID_MISMATCH: 403
    };
    return res.status(statusMap[result.code] || 400).json(result);
  }

  db.addAuditLog('activate', license_key, 'Ativação/validação bem-sucedida', req.ip);
  res.json(result);
});

// POST /api/license/validate
app.post('/api/license/validate', rateLimit(60, 5 * 60 * 1000), (req, res) => {
  const { license_key, hwid } = req.body;
  if (!license_key || !hwid) {
    return res.status(400).json({ error: 'license_key e hwid são obrigatórios' });
  }

  const result = db.validateLicense(license_key, hwid, SECRET);

  if (result.error) {
    const statusMap = {
      LICENSE_NOT_FOUND: 404,
      LICENSE_REVOKED: 403,
      LICENSE_EXPIRED: 403,
      HWID_MISMATCH: 403
    };
    return res.status(statusMap[result.code] || 400).json(result);
  }

  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════════
// API ADMIN — Gerenciamento de licenças (dashboard + admin-cli)
// ═══════════════════════════════════════════════════════════════════════

function adminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey === SECRET) {
    req.adminSource = 'cli';
    return next();
  }
  // Também permite via sessão do dashboard
  if (req.session && req.session.loggedIn) {
    req.adminSource = 'dashboard';
    return next();
  }
  return res.status(401).json({ error: 'Acesso não autorizado' });
}

// POST /api/auth/login — Login do dashboard
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (auth.login(password)) {
    req.session.loggedIn = true;
    db.addAuditLog('login', null, 'Login no dashboard', req.ip);
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Senha incorreta' });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// GET /api/auth/check — Verifica se está logado
app.get('/api/auth/check', (req, res) => {
  res.json({ loggedIn: !!req.session?.loggedIn });
});

// GET /api/admin/stats — Dashboard stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
  res.json(db.getStats());
});

// POST /api/admin/generate-key
app.post('/api/admin/generate-key', adminAuth, (req, res) => {
  const { duration_days, duration_hours, customer_name, notes } = req.body;

  if (duration_hours !== undefined && duration_hours !== null && (isNaN(duration_hours) || duration_hours <= 0 || duration_hours > 8784)) {
    return res.status(400).json({ error: 'Horas inválidas (0.1 a 8784)' });
  }
  if (duration_days !== undefined && duration_days !== null && (isNaN(duration_days) || duration_days <= 0)) {
    return res.status(400).json({ error: 'Dias inválidos' });
  }

  const result = db.createLicense({ duration_days, duration_hours, customer_name, notes });

  let durationLabel;
  if (duration_hours && duration_hours > 0) {
    durationLabel = `${duration_hours}h`;
  } else if (duration_days && duration_days >= 36500) {
    durationLabel = 'vitalício';
  } else {
    durationLabel = `${duration_days || 30} dias`;
  }

  db.addAuditLog('generate', result.license_key,
    `Gerada licença ${durationLabel} para "${customer_name || '—'}" por ${req.adminSource}`, req.ip);

  res.json({ success: true, license_key: result.license_key, expires_at: result.expires_at, duration: durationLabel });
});

// GET /api/admin/licenses
app.get('/api/admin/licenses', adminAuth, (req, res) => {
  const { status, search, expiring_days, limit } = req.query;
  const filters = {};
  if (status) filters.status = status;
  if (search) filters.search = search;
  if (expiring_days) filters.expiring_days = parseInt(expiring_days);
  if (limit) filters.limit = parseInt(limit);

  const licenses = db.listLicenses(filters);
  // Oculta HWID no retorno (segurança)
  const safe = licenses.map(l => ({ ...l, hwid: l.hwid ? '****' : null }));
  res.json(safe);
});

// GET /api/admin/licenses/:key — Detalhe de uma licença
app.get('/api/admin/licenses/:key', adminAuth, (req, res) => {
  const license = db.findLicense(req.params.key);
  if (!license) return res.status(404).json({ error: 'Licença não encontrada' });
  res.json({ ...license, hwid: license.hwid ? '****' : null });
});

// POST /api/admin/revoke
app.post('/api/admin/revoke', adminAuth, (req, res) => {
  const { license_key } = req.body;
  const result = db.revokeLicense(license_key);
  if (result.error) return res.status(404).json(result);

  db.addAuditLog('revoke', license_key, `Revogada por ${req.adminSource}`, req.ip);
  res.json({ success: true, message: 'Licença revogada' });
});

// POST /api/admin/extend
app.post('/api/admin/extend', adminAuth, (req, res) => {
  const { license_key, days, hours } = req.body;
  const result = db.extendLicense(license_key, days, hours);
  if (result.error) return res.status(404).json(result);

  const label = hours ? `${hours}h` : `${days || 30} dias`;
  db.addAuditLog('extend', license_key, `Estendida em ${label} por ${req.adminSource}`, req.ip);
  res.json(result);
});

// POST /api/admin/reset-hwid
app.post('/api/admin/reset-hwid', adminAuth, (req, res) => {
  const { license_key } = req.body;
  const result = db.resetHwid(license_key);
  if (result.error) return res.status(404).json(result);

  db.addAuditLog('reset_hwid', license_key, `HWID resetado por ${req.adminSource}`, req.ip);
  res.json({ success: true, message: 'HWID resetado — licença pode ser ativada em novo PC' });
});

// POST /api/admin/cleanup
app.post('/api/admin/cleanup', adminAuth, (req, res) => {
  const before = db.getStats();
  const db_ = db.getDb();
  const result = db_.prepare("DELETE FROM licenses WHERE status IN ('revoked', 'expired')").run();
  db.addAuditLog('cleanup', null, `${result.changes} licenças removidas por ${req.adminSource}`, req.ip);
  res.json({ success: true, removed: result.changes, remaining: db.getStats().active });
});

// GET /api/admin/audit
app.get('/api/admin/audit', adminAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.getAuditLogs(limit));
});

// GET /api/admin/backup — Download do backup JSON
app.get('/api/admin/backup', adminAuth, (req, res) => {
  const backup = db.exportBackup();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=teoglobal-backup-${new Date().toISOString().slice(0, 10)}.json`);
  res.send(backup);
});

// ── Start ───────────────────────────────────────────────────────────
db.open();
console.log('✅ Banco SQLite carregado');

app.listen(PORT, () => {
  console.log(`✅ License server running on port ${PORT}`);
  console.log(`   API:       http://localhost:${PORT}/api`);
  console.log(`   Dashboard: http://localhost:${PORT}/admin`);
});
