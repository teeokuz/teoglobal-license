// db.js — Banco SQLite na nuvem (Turso — gratuito, persistente)
// Usa @libsql/client sobre HTTP — sem módulos nativos
const { createClient } = require('@libsql/client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JSON_FILE = path.join(__dirname, 'licenses.json');

let client = null;

function getUrl() {
  // Turso URL: libsql://[db-name]-[org].turso.io
  return process.env.TURSO_URL || process.env.TURSO_DATABASE_URL || '';
}

function getToken() {
  return process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN || '';
}

async function open() {
  const url = getUrl();
  const token = getToken();

  if (!url || !token) {
    console.error('❌ ERRO: TURSO_URL e TURSO_TOKEN não definidos.');
    console.error('   Crie um banco gratuito em https://turso.tech');
    process.exit(1);
  }

  client = createClient({ url, authToken: token });

  // Testa conexão
  try {
    await client.execute('SELECT 1');
    console.log('✅ Conectado ao Turso');
  } catch (e) {
    console.error('❌ Falha ao conectar ao Turso:', e.message);
    process.exit(1);
  }

  await createSchema();
  await migrateFromJson();
}

async function createSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      duration_days INTEGER,
      duration_hours REAL,
      hwid TEXT,
      hwid_bound_at TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat TEXT,
      customer_name TEXT,
      notes TEXT
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      license_key TEXT,
      details TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status)'); } catch (_) {}
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key)'); } catch (_) {}
}

async function migrateFromJson() {
  if (!fs.existsSync(JSON_FILE)) return;

  try {
    const existing = await client.execute('SELECT COUNT(*) as c FROM licenses');
    const count = existing.rows[0]?.c || 0;
    if (count > 0) return;

    const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
    if (!data.licenses || !Array.isArray(data.licenses) || data.licenses.length === 0) return;

    let migrated = 0;
    for (const l of data.licenses) {
      try {
        await client.execute({
          sql: `INSERT OR IGNORE INTO licenses
            (license_key, status, duration_days, duration_hours, hwid, hwid_bound_at,
             created_at, expires_at, last_heartbeat, customer_name, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            l.license_key, l.status || 'active', l.duration_days || null, l.duration_hours || null,
            l.hwid || null, l.hwid_bound_at || null, l.created_at || new Date().toISOString(),
            l.expires_at, l.last_heartbeat || null, l.customer_name || null, l.notes || null
          ]
        });
        migrated++;
      } catch (_) {}
    }

    if (migrated > 0) {
      await addAuditLog('migration', null, `Migradas ${migrated} licenças do JSON`);
      fs.renameSync(JSON_FILE, JSON_FILE + '.bak');
    }
  } catch (e) {
    console.error('Erro na migração:', e.message);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function queryAll(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows;
}

async function queryOne(sql, args = []) {
  const rows = await queryAll(sql, args);
  return rows.length > 0 ? rows[0] : null;
}

// ── CRUD ────────────────────────────────────────────────────────────────

function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(0, chars.length)]).join('');
  return `${part()}-${part()}-${part()}-${part()}`;
}

async function findLicense(key) {
  return queryOne('SELECT * FROM licenses WHERE license_key = ?', [key.toUpperCase().trim()]);
}

async function createLicense({ duration_days, duration_hours, customer_name, notes }) {
  let expiresAt, durationDays = null, durationHours = null;
  if (duration_hours && duration_hours > 0) {
    expiresAt = new Date(Date.now() + duration_hours * 3600000).toISOString();
    durationHours = duration_hours;
  } else {
    const days = duration_days >= 36500 ? 36500 : (duration_days || 30);
    expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    durationDays = days;
  }
  const licenseKey = generateLicenseKey();
  await client.execute({
    sql: `INSERT INTO licenses (license_key, status, duration_days, duration_hours, created_at, expires_at, customer_name, notes) VALUES (?, 'active', ?, ?, ?, ?, ?, ?)`,
    args: [licenseKey, durationDays, durationHours, new Date().toISOString(), expiresAt, customer_name || null, notes || null]
  });
  return { license_key: licenseKey, expires_at: expiresAt };
}

function getDaysRemaining(expiresAt) { return Math.max(0, Math.ceil((new Date(expiresAt) - new Date()) / 86400000)); }
function getHoursRemaining(expiresAt) { return Math.max(0, Math.round(((new Date(expiresAt) - new Date()) / 3600000) * 10) / 10); }
function getRemainingInfo(expiresAt) { const d = getDaysRemaining(expiresAt); const h = getHoursRemaining(expiresAt); return { days_remaining: d, hours_remaining: h < 24 ? h : null }; }
function hashHwid(hwid, secret) { return crypto.createHash('sha256').update(hwid + secret).digest('hex'); }

async function activateLicense(licenseKey, hwid, secret) {
  const license = await findLicense(licenseKey);
  if (!license) return { error: 'Licença não encontrada', code: 'LICENSE_NOT_FOUND' };
  if (license.status === 'revoked') return { error: 'Licença revogada', code: 'LICENSE_REVOKED' };
  if (new Date(license.expires_at) < new Date()) {
    await client.execute({ sql: 'UPDATE licenses SET status = ? WHERE license_key = ?', args: ['expired', licenseKey] });
    return { error: 'Licença expirada', code: 'LICENSE_EXPIRED', expired_at: license.expires_at };
  }
  if (license.hwid) {
    if (license.hwid !== hashHwid(hwid, secret))
      return { error: 'Esta licença já está ativada em outro computador', code: 'HWID_MISMATCH' };
    await client.execute({ sql: 'UPDATE licenses SET last_heartbeat = ? WHERE license_key = ?', args: [new Date().toISOString(), licenseKey] });
    return { success: true, message: 'Licença já ativada', ...getRemainingInfo(license.expires_at), expires_at: license.expires_at, customer_name: license.customer_name };
  }
  const nowIso = new Date().toISOString();
  await client.execute({ sql: 'UPDATE licenses SET hwid = ?, hwid_bound_at = ?, last_heartbeat = ? WHERE license_key = ?', args: [hashHwid(hwid, secret), nowIso, nowIso, licenseKey] });
  return { success: true, message: 'Licença ativada!', ...getRemainingInfo(license.expires_at), expires_at: license.expires_at, customer_name: license.customer_name };
}

async function validateLicense(licenseKey, hwid, secret) {
  const license = await findLicense(licenseKey);
  if (!license) return { error: 'Licença não encontrada', code: 'LICENSE_NOT_FOUND' };
  if (license.status === 'revoked') return { error: 'Licença revogada', code: 'LICENSE_REVOKED' };
  if (new Date(license.expires_at) < new Date()) {
    await client.execute({ sql: 'UPDATE licenses SET status = ? WHERE license_key = ?', args: ['expired', licenseKey] });
    return { error: 'Licença expirada', code: 'LICENSE_EXPIRED', expired_at: license.expires_at };
  }
  if (license.hwid && license.hwid !== hashHwid(hwid, secret))
    return { error: 'Licença vinculada a outro PC', code: 'HWID_MISMATCH' };
  await client.execute({ sql: 'UPDATE licenses SET last_heartbeat = ? WHERE license_key = ?', args: [new Date().toISOString(), licenseKey] });
  return { success: true, ...getRemainingInfo(license.expires_at), expires_at: license.expires_at, customer_name: license.customer_name };
}

async function revokeLicense(licenseKey) {
  if (!(await findLicense(licenseKey))) return { error: 'Licença não encontrada' };
  await client.execute({ sql: 'UPDATE licenses SET status = ? WHERE license_key = ?', args: ['revoked', licenseKey] });
  return { success: true };
}

async function extendLicense(licenseKey, days, hours) {
  const license = await findLicense(licenseKey);
  if (!license) return { error: 'Licença não encontrada' };
  const base = new Date(license.expires_at) > new Date() ? new Date(license.expires_at) : new Date();
  const addMs = (hours && hours > 0) ? hours * 3600000 : (days || 30) * 86400000;
  const newExpiry = new Date(base.getTime() + addMs);
  await client.execute({ sql: 'UPDATE licenses SET expires_at = ?, status = ? WHERE license_key = ?', args: [newExpiry.toISOString(), 'active', licenseKey] });
  return { success: true, new_expires_at: newExpiry.toISOString(), days_added: days || null, hours_added: hours || null };
}

async function resetHwid(licenseKey) {
  if (!(await findLicense(licenseKey))) return { error: 'Licença não encontrada' };
  await client.execute({ sql: 'UPDATE licenses SET hwid = NULL, hwid_bound_at = NULL, last_heartbeat = NULL WHERE license_key = ?', args: [licenseKey] });
  return { success: true };
}

async function listLicenses(filters = {}) {
  let sql = 'SELECT * FROM licenses WHERE 1=1';
  const args = [];
  if (filters.status) { sql += ' AND status = ?'; args.push(filters.status); }
  if (filters.search) { sql += ' AND (license_key LIKE ? OR customer_name LIKE ?)'; args.push(`%${filters.search}%`, `%${filters.search}%`); }
  if (filters.expiring_days) { sql += ' AND expires_at <= ? AND status = ?'; args.push(new Date(Date.now() + filters.expiring_days * 86400000).toISOString(), 'active'); }
  sql += ' ORDER BY created_at DESC';
  if (filters.limit) { sql += ' LIMIT ?'; args.push(filters.limit); }
  const r = await client.execute({ sql, args });
  return r.rows;
}

async function getStats() {
  const q = async (s, a = []) => { const r = await client.execute({ sql: s, args: a }); return r.rows[0]?.c || 0; };
  return {
    total: await q('SELECT COUNT(*) as c FROM licenses'),
    active: await q("SELECT COUNT(*) as c FROM licenses WHERE status = 'active'"),
    revoked: await q("SELECT COUNT(*) as c FROM licenses WHERE status = 'revoked'"),
    expired: await q("SELECT COUNT(*) as c FROM licenses WHERE status = 'expired'"),
    expiringSoon: await q("SELECT COUNT(*) as c FROM licenses WHERE status = 'active' AND expires_at <= ?", [new Date(Date.now() + 7 * 86400000).toISOString()]),
    inUse: await q("SELECT COUNT(*) as c FROM licenses WHERE status = 'active' AND hwid IS NOT NULL")
  };
}

async function addAuditLog(action, licenseKey, details, ip) {
  await client.execute({ sql: 'INSERT INTO audit_log (action, license_key, details, ip) VALUES (?, ?, ?, ?)', args: [action, licenseKey || null, details || null, ip || null] });
}

async function getAuditLogs(limit = 50) {
  const r = await client.execute({ sql: 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', args: [limit] });
  return r.rows;
}

async function exportBackup() {
  const r = await client.execute('SELECT * FROM licenses ORDER BY id');
  return JSON.stringify({ licenses: r.rows, exported_at: new Date().toISOString() }, null, 2);
}

async function cleanupLicenses() {
  const before = await getStats();
  await client.execute("DELETE FROM licenses WHERE status IN ('revoked', 'expired')");
  const after = await getStats();
  return { removed: (before.revoked + before.expired) - (after.revoked + after.expired), remaining: after.active };
}

module.exports = {
  open,
  findLicense, createLicense, generateLicenseKey,
  activateLicense, validateLicense,
  revokeLicense, extendLicense, resetHwid,
  listLicenses, getStats, cleanupLicenses,
  getDaysRemaining, getHoursRemaining,
  addAuditLog, getAuditLogs,
  exportBackup, hashHwid
};
