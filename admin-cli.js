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
        let hours = null;
        let days;
        let nameIdx = 2;

        // Detecta modo horas: --hours N ou Nh (ex: 2h)
        if (args[1] === '--hours' || args[1] === '-h') {
          hours = parseFloat(args[2]);
          nameIdx = 3;
        } else if (args[1] && args[1].toLowerCase().endsWith('h')) {
          hours = parseFloat(args[1]);
          nameIdx = 2;
        } else if (args[1] && args[1].toLowerCase() === 'vitalicio') {
          days = 36500; // 100 anos = vitalícia na prática
          nameIdx = 2;
        } else {
          days = parseInt(args[1]) || 30;
          if (days > 36500) {
            console.log('\n⚠️  Atenção: ' + days + ' dias = ' + Math.floor(days/365) + ' anos.');
            console.log('   Para vitalícia use: node admin-cli.js generate vitalicio "Nome"\n');
          }
        }

        if (hours !== null && (isNaN(hours) || hours <= 0 || hours > 8784)) {
          console.log('\n❌ Horas inválidas. Use um valor entre 0.1 e 8784 (1 ano).\n');
          process.exit(1);
        }

        const name = args[nameIdx] || null;
        const body = hours !== null
          ? { duration_hours: hours, customer_name: name }
          : { duration_days: days, customer_name: name };

        const result = await apiRetry('POST', '/api/admin/generate-key', body);

        // ⚠️ VALIDAÇÃO: Detecta se o servidor aceitou as horas corretamente
        const serverSupportsHours = result.duration && result.duration.includes('h');
        const requestedHours = hours !== null;
        const serverIsOutdated = requestedHours && !serverSupportsHours;

        console.log('\n✅ Licença gerada com sucesso!\n');
        console.log(`   Chave:    ${result.license_key}`);

        // Sempre mostra o que o SERVIDOR retornou (não o que foi pedido localmente)
        if (result.duration) {
          console.log(`   Duração:  ${result.duration}`);
        } else if (requestedHours) {
          console.log(`   Duração:  ${hours}h (solicitado)`);
        } else {
          console.log(`   Duração:  ${days || 30} dias`);
        }

        if (requestedHours) {
          console.log(`   Expira:   ${new Date(result.expires_at).toLocaleString('pt-BR')}`);
        } else if (days >= 36500) {
          console.log(`   Tipo:     VITALÍCIA`);
        } else {
          console.log(`   Expira:   ${new Date(result.expires_at).toLocaleDateString('pt-BR')}`);
        }

        if (name) console.log(`   Cliente:  ${name}`);

        if (serverIsOutdated) {
          console.log('');
          console.log('   ⚠️  ATENÇÃO: O servidor NÃO aceitou a duração em horas!');
          console.log('   ⚠️  Ele gerou uma licença de 30 dias (padrão antigo).');
          console.log('   ⚠️  Faça deploy do novo server.js no Render.');
        }

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
          const isHours = l.duration_hours != null && l.duration_hours > 0;
          let exp;
          if (isVitalicia) {
            exp = 'VITALÍCIA';
          } else if (isHours) {
            exp = `${l.duration_hours}h — ${new Date(l.expires_at).toLocaleString('pt-BR')}`;
          } else {
            exp = new Date(l.expires_at).toLocaleDateString('pt-BR');
          }
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
     node admin-cli.js generate <dias> [nome]      → Gerar licença (ex: 30)
     node admin-cli.js generate 2h "Teste"          → Licença de 2 horas (teste)
     node admin-cli.js generate --hours 0.5 [nome]  → Licença de 30 minutos
     node admin-cli.js generate vitalicio [nome]    → Gerar licença VITALÍCIA
     node admin-cli.js list                         → Listar todas as licenças
     node admin-cli.js revoke <chave>               → Revogar licença
     node admin-cli.js extend <chave> <dias>        → Estender validade
     node admin-cli.js cleanup                      → Remover licenças revogadas/expiradas

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
