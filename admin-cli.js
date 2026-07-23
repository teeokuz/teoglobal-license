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
      timeout: 60000, // 60s (Render cold start pode demorar)
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
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Retry wrapper para lidar com cold start do Render
async function apiRetry(method, path, body = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) {
        const wait = i * 10; // 10s, 20s, 30s
        process.stdout.write(`\r⏳ Aguardando servidor acordar... (${wait}s)`);
        await new Promise(r => setTimeout(r, wait * 1000));
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
      }
      return await api(method, path, body);
    } catch (err) {
      if (i === retries - 1) throw err;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  try {
    switch (cmd) {
      case 'generate': {
        let days;
        if (args[1] && args[1].toLowerCase() === 'vitalicio') {
          days = 36500; // 100 anos = vitalicia na pratica
        } else {
          days = parseInt(args[1]) || 30;
          if (days > 36500) {
            console.log('\n⚠️  Atencao: ' + days + ' dias = ' + Math.floor(days/365) + ' anos.');
            console.log('   Para vitalicia use: node admin-cli.js generate vitalicio "Nome"\n');
          }
        }
        const name = args[2] || null;
        const result = await apiRetry('POST', '/api/admin/generate-key', {
          duration_days: days,
          customer_name: name
        });
        console.log('\n✅ Licença gerada com sucesso!\n');
        console.log(`   Chave:    ${result.license_key}`);
        if (result.duration_days >= 36500) {
          console.log(`   Tipo:     VITALICIA`);
        } else {
          console.log(`   Dias:     ${result.duration_days}`);
          console.log(`   Expira:   ${new Date(result.expires_at).toLocaleDateString('pt-BR')}`);
        }
        if (name) console.log(`   Cliente:  ${name}`);
        console.log('');
        break;
      }

      case 'list': {
        const licenses = await apiRetry('GET', '/api/admin/licenses');
        if (!licenses || !Array.isArray(licenses)) {
          console.log('\n❌ Servidor nao respondeu. Tente novamente em alguns segundos.\n');
          break;
        }
        console.log('\n📋 Licenças:\n');
        for (const l of licenses) {
          const isVitalicia = l.duration_days >= 36500;
          const exp = isVitalicia ? 'VITALICIA' : new Date(l.expires_at).toLocaleDateString('pt-BR');
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
        await apiRetry('POST', '/api/admin/revoke', { license_key: key });
        console.log(`\n🔴 Licença ${key.toUpperCase()} revogada.\n`);
        break;
      }

      case 'extend': {
        const key = args[1];
        const days = parseInt(args[2]);
        if (!key || !days) { console.log('Uso: node admin-cli.js extend <chave> <dias>'); process.exit(1); }
        const result = await apiRetry('POST', '/api/admin/extend', { license_key: key, days });
        console.log(`\n✅ Licença ${key.toUpperCase()} estendida em ${days} dias.`);
        console.log(`   Nova expiração: ${new Date(result.new_expires_at).toLocaleDateString('pt-BR')}\n`);
        break;
      }

      case 'cleanup': {
        console.log('\n🧹 Removendo licenças revogadas/expiradas...');
        const result = await apiRetry('POST', '/api/admin/cleanup');
        console.log(`   ${result.removed} licença(s) removida(s).`);
        console.log(`   ${result.remaining} licença(s) ativa(s) restante(s).\n`);
        break;
      }

      default:
        console.log(`
🔑 TeoGlobal — Gerenciador de Licenças

  Comandos:
    node admin-cli.js generate <dias> [nome]     → Gerar licenca (ex: 30)
    node admin-cli.js generate vitalicio [nome]  → Gerar licenca VITALICIA
    node admin-cli.js list                       → Listar todas as licencas
    node admin-cli.js revoke <chave>             → Revogar licenca
    node admin-cli.js extend <chave> <dias>      → Estender validade
    node admin-cli.js cleanup                    → Remover licencas revogadas/expiradas

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
