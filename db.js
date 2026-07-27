// db.js — Banco SQLite (better-sqlite3)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'teoglobal.db');
const JSON_FILE = path.join(__dirname, 'licenses.json');

let db;

function open() {
  const exists = fs.existsSync(DB_FILE);
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  if (!exists) {
    createSchema();
    migrateFromJson();
  }
  return db;
}

function save() {
  // better-sqlite3 writes synchronously, no explicit save needed
}

function createSchema() {
  db.exec(`
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
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      license_key TEXT,
      details TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
    CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);
}

function migrateFromJson() {
  if (!fs.existsSync(JSON_FILE)) return;

  try {
    const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
    if (!data.licenses || !Array.isArray(data.licenses) || data.licenses.length === 0) return;

    const count = db.prepare('SELECT COUNT(*) as c FROM licenses').get();
    if (count.c > 0) return;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO licenses
        (license_key, status, duration_days, duration_hours, hwid, hwid_bound_at,
         created_at, expires_at, last_heartbeat, customer_name, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let migrated = 0;
    const migrate = db.transaction(() => {
      for (const l of data.licenses) {
        const r = insert.run(
          l.license_key, l.status || 'active', l.duration_days || null, l.duration_hours || null,
          l.hwid || null, l.hwid_bound_at || null, l.created_at || new Date().toISOString(),
          l.expires_at, l.last_heartbeat || null, l.customer_name || null, l.notes || null
        );
        if (r.changes > 0) migrated++;
      }
    });
    migrate();

    if (migrated > 0) {
      addAuditLog('migration', null, `Migradas ${migrated} licenças do JSON para SQLite`);
      fs.renameSync(JSON_FILE, JSON_FILE + '.bak');
    }
  } catch (e) {
    console.error('Erro na migração:', e.message);
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────

function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(0, chars.length)]).join('');
  return `TEO-${part()}-${part()}-${part()}-${part()}`;
}

function findLicense(key) {
  return db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key.toUpperCase().trim());
}

function createLicense({ duration_days, duration_hours, customer_name, notes }) {
  let expiresAt, durationDays = null, durationHours = null;
  if (duration_hours && duration_hours > 0) {
    expiresAt = new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString();
    durationHours = duration_hours;
  } else {
    const days = duration_days && duration_days >= 36500 ? 36500 : (duration_days || 30);
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    durationDays = days;
  }
  const licenseKey = generateLicenseKey();
  db.prepare(`INSERT INTO licenses (license_key, status, duration_days, duration_hours, created_at, expires_at, customer_name, notes) VALUES (?, 'active', ?, ?, ?, ?, ?, ?)`)
    .run(licenseKey, durationDays, durationHours, new Date().toISOString(), expiresAt, customer_name || null, notes || null);
  return { license_key: licenseKey, expires_at: expiresAt };
}

function getDaysRemaining(expiresAt) { return Math.max(0, Math.ceil((new Date(expiresAt) - new Date()) / 86400000)); }
function getHoursRemaining(expiresAt) { return Math.max(0, Math.round(((new Date(expiresAt) - new Date()) / 3600000) * 10) / 10); }
function getRemainingInfo(expiresAt) { const d = getDaysRemaining(expiresAt); const h = getHoursRemaining(expiresAt); return { days_remaining: d, hours_remaining: h < 24 ? h : null }; }
function hashHwid(hwid, secret) { return crypto.createHash('sha256').update(hwid + secret).digest('hex'); }

function activateLicense(licenseKey, hwid, secret) {
  const license = findLicense(licenseKey);
  if (!license) return { error: 'Licença não encontrada', code: 'LICENSE_NOT_FOUND' };
  if (license.status === 'revoked') return { error: 'Licença revogada', code: 'LICENSE_REVOKED' };
  if (new Date(license.expires_at) < new Date()) {
    db.prepare('UPDATE licenses SET status = ? WHERE license_key = ?').run('expired', licenseKey);
    return { error: 'Licença expirada', code: 'LICENSE_EXPIRED', expired_at: license.expires_at };
  }
  if (license.hwid) {
    if (license.hwid !== hashHwid(hwid, secret))
      return { error: 'Esta licença já está ativada em outro computador', code: 'HWID_MISMATCH' };
    db.prepare('UPDATE licenses SET last_heartbeat = ? WHERE license_key = ?').run(new Date().toISOString(), licenseKey);
    return { success: true, message: 'Licença já ativada', ...getRemainingInfo(license.expires_at), expires_at: license.expires_at };
  }
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE licenses SET hwid = ?, hwid_bound_at = ?, last_heartbeat = ? WHERE license_key = ?')
    .run(hashHwid(hwid, secret), nowIso, nowIso, licenseKey);
  return { success: true, message: 'Licença ativada!', ...getRemainingInfo(license.expires_at), expires_at: license.expires_at };
}

function validateLicense(licenseKey, hwid, secret) {
  const license = findLicense(licenseKey);
  if (!license) return { error: 'Licença não encontrada', code: 'LICENSE_NOT_FOUND' };
  if (license.status === 'revoked') return { error: 'Licença revogada', code: 'LICENSE_REVOKED' };
  if (new Date(license.expires_at) < new Date()) {
    db.prepare('UPDATE licenses SET status = ? WHERE license_key = ?').run('expired', licenseKey);
    return { error: 'Licença expirada', code: 'LICENSE_EXPIRED', expired_at: license.expires_at };
  }
  if (license.hwid && license.hwid !== hashHwid(hwid, secret))
    return { error: 'Licença vinculada a outro PC', code: 'HWID_MISMATCH' };
  db.prepare('UPDATE licenses SET last_heartbeat = ? WHERE license_key = ?').run(new Date().toISOString(), licenseKey);
  return { success: true, ...getRemainingInfo(license.expires_at), expires_at: license.expires_at, customer_name: license.customer_name };
}

function revokeLicense(licenseKey) {
  if (!findLicense(licenseKey)) return { error: 'Licença não encontrada' };
  db.prepare('UPDATE licenses SET status = ? WHERE license_key = ?').run('revoked', licenseKey);
  return { success: true };
}

function extendLicense(licenseKey, days, hours) {
  const license = findLicense(licenseKey);
  if (!license) return { error: 'Licença não encontrada' };
  const base = new Date(license.expires_at) > new Date() ? new Date(license.expires_at) : new Date();
  const addMs = (hours && hours > 0) ? hours * 3600000 : (days || 30) * 86400000;
  const newExpiry = new Date(base.getTime() + addMs);
  db.prepare('UPDATE licenses SET expires_at = ?, status = ? WHERE license_key = ?').run(newExpiry.toISOString(), 'active', licenseKey);
  return { success: true, new_expires_at: newExpiry.toISOString(), days_added: days || null, hours_added: hours || null };
}

function resetHwid(licenseKey) {
  if (!findLicense(licenseKey)) return { error: 'Licença não encontrada' };
  db.prepare('UPDATE licenses SET hwid = NULL, hwid_bound_at = NULL, last_heartbeat = NULL WHERE license_key = ?').run(licenseKey);
  return { success: true };
}

function listLicenses(filters = {}) {
  let sql = 'SELECT * FROM licenses WHERE 1=1';
  const params = [];
  if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
  if (filters.search) { sql += ' AND (license_key LIKE ? OR customer_name LIKE ?)'; const s = `%${filters.search}%`; params.push(s, s); }
  if (filters.expiring_days) { sql += ' AND expires_at <= ? AND status = ?'; params.push(new Date(Date.now() + filters.expiring_days * 86400000).toISOString(), 'active'); }
  sql += ' ORDER BY created_at DESC';
  if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
  return db.prepare(sql).all(...params);
}

function getStats() {
  const q = (s, p = []) => db.prepare(s).get(...p);
  return {
    total: q('SELECT COUNT(*) as c FROM licenses').c,
    active: q("SELECT COUNT(*) as c FROM licenses WHERE status = 'active'").c,
    revoked: q("SELECT COUNT(*) as c FROM licenses WHERE status = 'revoked'").c,
    expired: q("SELECT COUNT(*) as c FROM licenses WHERE status = 'expired'").c,
    expiringSoon: q("SELECT COUNT(*) as c FROM licenses WHERE status = 'active' AND expires_at <= ?", [new Date(Date.now() + 7 * 86400000).toISOString()]).c,
    inUse: q("SELECT COUNT(*) as c FROM licenses WHERE status = 'active' AND hwid IS NOT NULL").c
  };
}

function addAuditLog(action, licenseKey, details, ip) {
  db.prepare('INSERT INTO audit_log (action, license_key, details, ip) VALUES (?, ?, ?, ?)').run(action, licenseKey || null, details || null, ip || null);
}

function getAuditLogs(limit = 50) {
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

function exportBackup() {
  const licenses = db.prepare('SELECT * FROM licenses ORDER BY id').all();
  return JSON.stringify({ licenses, exported_at: new Date().toISOString() }, null, 2);
}

function cleanupLicenses() {
  const before = getStats();
  db.prepare("DELETE FROM licenses WHERE status IN ('revoked', 'expired')").run();
  const after = getStats();
  return { removed: (before.revoked + before.expired) - (after.revoked + after.expired), remaining: after.active };
}

function getDb() { return db; }

module.exports = {
  open, getDb, save,
  findLicense, createLicense, generateLicenseKey,
  activateLicense, validateLicense,
  revokeLicense, extendLicense, resetHwid,
  listLicenses, getStats, cleanupLicenses,
  getDaysRemaining, getHoursRemaining,
  addAuditLog, getAuditLogs,
  exportBackup, hashHwid
};
