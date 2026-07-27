// dashboard.js — TeoGlobal License Panel

// ── API Helper ──────────────────────────────────────────────────────────
async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) {
    window.location.href = '/admin/login.html';
    throw new Error('Unauthorized');
  }
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'Erro de conexão' }));
    throw new Error(err.error || 'Erro desconhecido');
  }
  return r.json();
}

function toast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const icon = type === 'success' ? 'bi-check-circle' : type === 'danger' ? 'bi-x-circle' : 'bi-info-circle';
  const toastEl = document.createElement('div');
  toastEl.className = `alert alert-${type} alert-dismissible fade show py-2`;
  toastEl.innerHTML = `
    <i class="bi ${icon} me-2"></i>${msg}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;
  container.appendChild(toastEl);
  setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.remove(), 300);
  }, 4000);
}

// ── Navegação por abas ──────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('#mainTabs .nav-link').forEach(l => l.classList.remove('active'));
  const link = document.querySelector(`[data-tab="${tab}"]`);
  if (link) link.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('d-none'));
  const content = document.getElementById(`tab-${tab}`);
  if (content) content.classList.remove('d-none');

  if (tab === 'dashboard') loadStats();
  if (tab === 'licenses') loadLicenses();
  if (tab === 'audit') loadAudit();
}

document.getElementById('mainTabs').addEventListener('click', (e) => {
  e.preventDefault();
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab) switchTab(tab);
});

// ── Dashboard ────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await api('GET', '/api/admin/stats');
    document.getElementById('statTotal').textContent = stats.total;
    document.getElementById('statActive').textContent = stats.active;
    document.getElementById('statExpiring').textContent = stats.expiringSoon;
    document.getElementById('statInUse').textContent = stats.inUse;
    document.getElementById('statRevoked').textContent = stats.revoked;
    document.getElementById('statExpired').textContent = stats.expired;

    // Tabela de expirando
    const licenses = await api('GET', '/api/admin/licenses?expiring_days=7&limit=10');
    const tbody = licenses.length > 0
      ? `
        <table class="table table-hover mb-0">
          <thead>
            <tr><th>Chave</th><th>Cliente</th><th>Expira</th><th>Ações</th></tr>
          </thead>
          <tbody>
            ${licenses.map(l => `
              <tr>
                <td><code class="text-brand">${l.license_key}</code></td>
                <td>${l.customer_name || '—'}</td>
                <td>${formatDate(l.expires_at)}</td>
                <td>
                  <button class="btn btn-outline-brand btn-sm" onclick="showExtendModal('${l.license_key}')">Estender</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`
      : '<div class="p-4 text-center text-muted">Nenhuma licença expirando nos próximos 7 dias</div>';
    document.getElementById('expiringTable').innerHTML = tbody;
  } catch (e) {
    toast('Erro ao carregar dashboard: ' + e.message, 'danger');
  }
}

// ── Licenças ─────────────────────────────────────────────────────────────
let currentLicenses = [];

async function loadLicenses() {
  const search = document.getElementById('searchInput').value;
  const status = document.getElementById('statusFilter').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status) params.set('status', status);

  try {
    currentLicenses = await api('GET', '/api/admin/licenses?' + params.toString());
    renderLicensesTable(currentLicenses);
  } catch (e) {
    toast('Erro ao carregar licenças: ' + e.message, 'danger');
  }
}

function renderLicensesTable(licenses) {
  const tbody = document.querySelector('#licensesTable tbody');
  if (licenses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Nenhuma licença encontrada</td></tr>';
    return;
  }

  tbody.innerHTML = licenses.map(l => {
    const statusBadge = l.status === 'active'
      ? '<span class="badge badge-active">Ativa</span>'
      : l.status === 'revoked'
        ? '<span class="badge badge-revoked">Revogada</span>'
        : '<span class="badge badge-expired">Expirada</span>';

    const hwidDisplay = l.hwid ? '<i class="bi bi-lock-fill text-success" title="Vinculada"></i>' : '<i class="bi bi-unlock text-muted"></i>';

    const actions = l.status === 'active'
      ? `
        <button class="btn btn-outline-brand btn-sm me-1" onclick="showExtendModal('${l.license_key}')" title="Estender">
          <i class="bi bi-calendar-plus"></i>
        </button>
        <button class="btn btn-outline-warning btn-sm me-1" onclick="resetHwid('${l.license_key}')" title="Reset HWID">
          <i class="bi bi-pc-display"></i>
        </button>
        <button class="btn btn-outline-danger btn-sm" onclick="revokeLicense('${l.license_key}')" title="Revogar">
          <i class="bi bi-x-circle"></i>
        </button>`
      : '<span class="text-muted small">—</span>';

    return `
      <tr>
        <td><code class="text-brand" style="cursor:pointer" onclick="navigator.clipboard.writeText('${l.license_key}');toast('Chave copiada!')">${l.license_key}</code></td>
        <td>${l.customer_name || '—'}</td>
        <td>${statusBadge}</td>
        <td>${formatDate(l.created_at)}</td>
        <td>${formatExpiry(l)}</td>
        <td>${hwidDisplay}</td>
        <td>${l.last_heartbeat ? formatDate(l.last_heartbeat, true) : '—'}</td>
        <td>${actions}</td>
      </tr>`;
  }).join('');
}

document.getElementById('searchInput').addEventListener('input', debounce(loadLicenses, 300));
document.getElementById('statusFilter').addEventListener('change', loadLicenses);

function formatDate(iso, showTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('pt-BR');
  if (showTime) return `${date} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  return date;
}

function formatExpiry(l) {
  if (l.duration_days >= 36500) return 'Vitalícia';
  if (l.duration_hours && l.duration_hours > 0 && l.duration_hours < 24) {
    return new Date(l.expires_at).toLocaleString('pt-BR');
  }
  return formatDate(l.expires_at);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Ações ────────────────────────────────────────────────────────────────

async function revokeLicense(key) {
  if (!confirm(`Revogar a licença ${key}?\n\nO cliente perderá acesso IMEDIATAMENTE.`)) return;
  try {
    await api('POST', '/api/admin/revoke', { license_key: key });
    toast(`Licença ${key} revogada`, 'danger');
    loadLicenses();
    loadStats();
  } catch (e) { toast(e.message, 'danger'); }
}

function showExtendModal(key) {
  const days = prompt(`Estender licença ${key}\n\nQuantos dias adicionar?`, '30');
  if (!days || isNaN(parseInt(days))) return;
  extendLicense(key, parseInt(days));
}

async function extendLicense(key, days) {
  try {
    const r = await api('POST', '/api/admin/extend', { license_key: key, days });
    toast(`Licença ${key} estendida em ${days} dias`, 'success');
    loadLicenses();
    loadStats();
  } catch (e) { toast(e.message, 'danger'); }
}

async function resetHwid(key) {
  if (!confirm(`Resetar HWID da licença ${key}?\n\nIsso permite que o cliente ative em outro PC.`)) return;
  try {
    await api('POST', '/api/admin/reset-hwid', { license_key: key });
    toast(`HWID da licença ${key} resetado`, 'success');
    loadLicenses();
  } catch (e) { toast(e.message, 'danger'); }
}

async function cleanupLicenses() {
  if (!confirm('Remover TODAS as licenças revogadas e expiradas?\n\nEsta ação não pode ser desfeita.')) return;
  try {
    const r = await api('POST', '/api/admin/cleanup');
    toast(`${r.removed} licença(s) removida(s)`, 'success');
    loadLicenses();
    loadStats();
  } catch (e) { toast(e.message, 'danger'); }
}

function downloadBackup() {
  window.open('/api/admin/backup', '_blank');
}

// ── Gerar Licença ────────────────────────────────────────────────────────
function toggleGenType() {
  const type = document.getElementById('genType').value;
  document.getElementById('genDaysGroup').classList.toggle('d-none', type !== 'days');
  document.getElementById('genHoursGroup').classList.toggle('d-none', type !== 'hours');
}

document.getElementById('generateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('genBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Gerando...';

  const type = document.getElementById('genType').value;
  const customer = document.getElementById('genCustomer').value || null;
  const notes = document.getElementById('genNotes').value || null;

  const body = { customer_name: customer, notes };

  if (type === 'vitalicio') {
    body.duration_days = 36500;
  } else if (type === 'hours') {
    body.duration_hours = parseFloat(document.getElementById('genHours').value);
  } else {
    body.duration_days = parseInt(document.getElementById('genDays').value) || 30;
  }

  try {
    const r = await api('POST', '/api/admin/generate-key', body);
    document.getElementById('genResult').classList.remove('d-none');
    document.getElementById('genKey').textContent = r.license_key;
    document.getElementById('genDetails').textContent = `${r.duration} | Cliente: ${customer || '—'}`;
    window._lastGeneratedKey = r.license_key;
    toast('Licença gerada com sucesso!', 'success');
    loadStats();
  } catch (e) {
    toast('Erro: ' + e.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-key"></i> Gerar Licença';
  }
});

function copyKey() {
  if (window._lastGeneratedKey) {
    navigator.clipboard.writeText(window._lastGeneratedKey);
    toast('Chave copiada para a área de transferência!');
  }
}

// ── Auditoria ─────────────────────────────────────────────────────────────
async function loadAudit() {
  try {
    const logs = await api('GET', '/api/admin/audit?limit=100');
    const tbody = document.getElementById('auditBody');
    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Nenhum registro</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(l => `
      <tr>
        <td>${formatDate(l.created_at, true)}</td>
        <td><span class="badge bg-secondary">${l.action}</span></td>
        <td><code class="small">${l.license_key || '—'}</code></td>
        <td class="small">${l.details || '—'}</td>
        <td class="text-muted small">${l.ip || '—'}</td>
      </tr>
    `).join('');
  } catch (e) { toast(e.message, 'danger'); }
}

// ── Logout ────────────────────────────────────────────────────────────────
async function logout() {
  await api('POST', '/api/auth/logout').catch(() => {});
  window.location.href = '/admin/login.html';
}

// ── Init ──────────────────────────────────────────────────────────────────
loadStats();
