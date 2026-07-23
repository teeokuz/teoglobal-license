// admin-cli.js — Ferramenta local para gerenciar licenças
// Uso: node admin-cli.js <comando> [opções]
//
// Comandos:
//   generate <dias> [nome]     → gera nova licença
//   list                        → lista últimas licenças
//   revoke <chave>              → revoga uma licença
//   extend <chave> <dias>       → estende validade

const https = require('https');
const http = require('http');

const SERVER_URL = process.env.LICENSE_SERVER || 'https://teoglobal-license.onrender.com';
const SECRET = process.env.LICENSE_SECRET || 'rI0KPMDj6yk3OXSzLmYxs74fqbTaicB8NH9AWRvJtlgFGwVQ';

function api(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': SECRET
      }
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  try {
    switch (cmd) {
      case 'generate': {
        const days = parseInt(args[1]) || 30;
        const name = args[2] || null;
        const result = await api('POST', '/api/admin/generate-key', {
          duration_days: days,
          customer_name: name
        });
        console.log('\n✅ Licença gerada com sucesso!\n');
        console.log(`   Chave:    ${result.license_key}`);
        console.log(`   Dias:     ${result.duration_days}`);
        console.log(`   Expira:   ${new Date(result.expires_at).toLocaleDateString('pt-BR')}`);
        if (name) console.log(`   Cliente:  ${name}`);
        console.log('');
        break;
      }

      case 'list': {
        const licenses = await api('GET', '/api/admin/licenses');
        console.log('\n📋 Licenças:\n');
        for (const l of licenses) {
          const exp = new Date(l.expires_at).toLocaleDateString('pt-BR');
          const created = new Date(l.created_at).toLocaleDateString('pt-BR');
          const icon = l.status === 'active' ? '🟢' : l.status === 'revoked' ? '🔴' : '⚫';
          console.log(`   ${icon} ${l.license_key}  |  ${l.status.toUpperCase()}  |  Criada: ${created}  |  Expira: ${exp}  |  ${l.customer_name || '—'}`);
        }
        console.log(`\n   Total: ${licenses.length} licença(s)\n`);
        break;
      }

      case 'revoke': {
        const key = args[1];
        if (!key) { console.log('Uso: node admin-cli.js revoke <chave>'); process.exit(1); }
        await api('POST', '/api/admin/revoke', { license_key: key });
        console.log(`\n🔴 Licença ${key.toUpperCase()} revogada.\n`);
        break;
      }

      case 'extend': {
        const key = args[1];
        const days = parseInt(args[2]);
        if (!key || !days) { console.log('Uso: node admin-cli.js extend <chave> <dias>'); process.exit(1); }
        const result = await api('POST', '/api/admin/extend', { license_key: key, days });
        console.log(`\n✅ Licença ${key.toUpperCase()} estendida em ${days} dias.`);
        console.log(`   Nova expiração: ${new Date(result.new_expires_at).toLocaleDateString('pt-BR')}\n`);
        break;
      }

      default:
        console.log(`
🔑 TeoGlobal — Gerenciador de Licenças

  Comandos:
    node admin-cli.js generate <dias> [nome]     → Gerar nova licença
    node admin-cli.js list                        → Listar todas as licenças
    node admin-cli.js revoke <chave>              → Revogar licença
    node admin-cli.js extend <chave> <dias>       → Estender validade

  Ambiente:
    LICENSE_SERVER   URL do servidor (padrão: http://localhost:3000)
    LICENSE_SECRET   Chave de admin (padrão: teoglobal-secret-key-change-me)
`);
    }
  } catch (err) {
    console.error(`\n❌ Erro: ${err.message}`);
    console.error('   O servidor está rodando? Use: node server.js\n');
  }
}

main();
