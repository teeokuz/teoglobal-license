// auth.js — Autenticação do dashboard via sessão + bcrypt
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Senha do dashboard — definida via DASHBOARD_PASSWORD ou gerada automaticamente
let passwordHash = null;
let generatedPassword = null;

function init(app) {
  const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000 // 8 horas
    }
  }));

  // Define a senha
  const rawPassword = process.env.DASHBOARD_PASSWORD;
  if (rawPassword) {
    passwordHash = bcrypt.hashSync(rawPassword, 10);
  } else {
    generatedPassword = crypto.randomBytes(8).toString('hex');
    passwordHash = bcrypt.hashSync(generatedPassword, 10);
    console.log('');
    console.log('══════════════════════════════════════════════════');
    console.log('  🔑 Senha do dashboard gerada automaticamente:');
    console.log(`     ${generatedPassword}`);
    console.log('  ⚠️  Defina DASHBOARD_PASSWORD no .env para fixar.');
    console.log('══════════════════════════════════════════════════');
    console.log('');
  }
}

function getPassword() {
  if (process.env.DASHBOARD_PASSWORD) return process.env.DASHBOARD_PASSWORD;
  return generatedPassword;
}

function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path === '/login.html' || req.path === '/api/auth/login') return next();
  if (req.path.startsWith('/api/') && req.path !== '/api/auth/login') {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  res.redirect('/admin/login.html');
}

function login(password) {
  if (!passwordHash) return false;
  return bcrypt.compareSync(password, passwordHash);
}

module.exports = { init, requireLogin, login, getPassword };
