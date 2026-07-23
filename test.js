// Teste do servidor de licenças
const http = require('http');

const BASE = 'http://localhost:3000';
const SECRET = 'test-secret';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const r = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function run() {
  try {
    // Health
    let r = await req('GET', '/');
    console.log('HEALTH:', r.status, r.body.status);

    // Generate key
    r = await req('POST', `/api/admin/generate-key?admin_key=${SECRET}`, { duration_days: 30, customer_name: 'Teste' });
    const key = r.body.license_key;
    console.log('GENERATE:', r.status, key, '| Expira:', r.body.expires_at);

    // Activate
    r = await req('POST', '/api/license/activate', { license_key: key, hwid: 'test-hwid-abc' });
    console.log('ACTIVATE:', r.status, r.body.success, '| Dias:', r.body.days_remaining);

    // Validate (mesmo HWID)
    r = await req('POST', '/api/license/validate', { license_key: key, hwid: 'test-hwid-abc' });
    console.log('VALIDATE:', r.status, r.body.success);

    // Wrong HWID
    r = await req('POST', '/api/license/validate', { license_key: key, hwid: 'wrong-hwid' });
    console.log('WRONG-HWID:', r.status, r.body.code, '—', r.body.error);

    // Wrong key
    r = await req('POST', '/api/license/validate', { license_key: 'TEO-INVALIDA-KEY', hwid: 'x' });
    console.log('WRONG-KEY:', r.status, r.body.code);

    // Revoke
    r = await req('POST', `/api/admin/revoke?admin_key=${SECRET}`, { license_key: key });
    console.log('REVOKE:', r.status, r.body.success);

    // Validate revoked
    r = await req('POST', '/api/license/validate', { license_key: key, hwid: 'test-hwid-abc' });
    console.log('REVOKED-VALIDATE:', r.status, r.body.code);

    console.log('\n✅ Todos os testes passaram!');
  } catch (e) {
    console.error('❌ Erro:', e.message);
    process.exit(1);
  }
}

run();
