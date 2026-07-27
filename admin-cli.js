// admin-cli.js — Ferramenta para gerenciar licenças (v2 — SQLite)
// Uso: node admin-cli.js <comando> [opções]
//
// Comandos:
//   generate <dias> [nome]        → gera nova licença
//   list                           → lista licenças
//   revoke <chave>                 → revoga uma licença
//   extend <chave> <dias>          → estende validade (dias)
//   extend <chave> <horas>h        → estende validade (horas)
//   reset-hwid <chave>             → libera licença para novo PC
//   cleanup                        → remove licenças revogadas/expiradas
//   stats                          → estatísticas rápidas
//   backup                         → baixa backup JSON

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.LICENSE_SERVER || 'https://teoglobal-license.onrender.com';
const SECRET = process.env.LICENSE_SECRET;
if (!SECRET) {
  console.error('❌ ERRO: LICENSE_SECRET não definida.');
  console.error('   Use: set LICENSE_SECRET=sua-chave-secreta');
  process.exit(1);
}

function api(method, path_, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path_, SERVER_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      timeout: 60000,
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

async function apiRetry(method, path_, body = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) {
        const wait = i * 10;
        process.stdout.write(`\r⏳ Aguardando servidor acordar... (${wait}s)`);
        await new Promise(r => setTimeout(r, wait * 1000));
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
      }
      return await api(method, path_, body);
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

        if (args[1] === '--hours' || args[1] === '-h') {
          hours = parseFloat(args[2]);
          nameIdx = 3;
        } else if (args[1] && args[1].toLowerCase().endsWith('h')) {
          hours = parseFloat(args[1]);
          nameIdx = 2;
        } else if (args[1] && args[1].toLowerCase() === 'vitalicio') {
          days = 36500;
          nameIdx = 2;
        } else {
          days = parseInt(args[1]) || 30;
        }

        if (hours !== null && (isNaN(hours) || hours <= 0 || hours > 8784)) {
          console.log('\n❌ Horas inválidas. Use entre 0.1 e 8784 (1 ano).\n');
          process.exit(1);
        }

        const name = args[nameIdx] || null;
        const body = hours !== null
          ? { duration_hours: hours, customer_name: name }
          : { duration_days: days, customer_name: name };

        const result = await apiRetry('POST', '/api/admin/generate-key', body);

        console.log('\n✅ Licença gerada com sucesso!\n');
        console.log(`   Chave:    ${result.license_key}`);
        console.log(`   Duração:  ${result.duration}`);
        if (hours !== null) {
          console.log(`   Expira:   ${new Date(result.expires_at).toLocaleString('pt-BR')}`);
        } else if (days >= 36500) {
          console.log(`   Tipo:     VITALÍCIA`);
        } else {
          console.log(`   Expira:   ${new Date(result.expires_at).toLocaleDateString('pt-BR')}`);
        }
        if (name) console.log(`   Cliente:  ${name}`);
        console.log('');
        break;
      }

      case 'list': {
        const licenses = await apiRetry('GET', '/api/admin/licenses');
        if (!Array.isArray(licenses)) {
          console.log('\n❌ Servidor não respondeu.\n');
          break;
        }
        console.log('\n📋 Licenças:\n');
        for (const l of licenses) {
          let exp;
          if (l.duration_days >= 36500) {
            exp = 'VITALÍCIA';
          } else if (l.duration_hours && l.duration_hours > 0) {
            exp = `${l.duration_hours}h — ${new Date(l.expires_at).toLocaleString('pt-BR')}`;
          } else {
            exp = new Date(l.expires_at).toLocaleDateString('pt-BR');
          }
          const created = new Date(l.created_at).toLocaleDateString('pt-BR');
          const icon = l.status === 'active' ? '🟢' : l.status === 'revoked' ? '🔴' : '⚫';
          console.log(`   ${icon} ${l.license_key}  |  ${l.status.toUpperCase()}  |  ${created}  |  ${exp}  |  ${l.customer_name || '—'}`);
        }
        console.log(`\n   Total: ${licenses.length} licença(s)\n`);
        break;
      }

      case 'revoke': {
        const key = args[1];
        if (!key) { console.log('Uso: node admin-cli.js revoke <chave>'); process.exit(1); }
        await apiRetry('POST', '/api/admin/revoke', { license_key: key.toUpperCase() });
        console.log(`\n🔴 Licença ${key.toUpperCase()} revogada.\n`);
        break;
      }

      case 'extend': {
        const key = args[1];
        const val = args[2];
        if (!key || !val) { console.log('Uso: node admin-cli.js extend <chave> <dias>  ou  extend <chave> <horas>h'); process.exit(1); }

        let days, hours;
        if (val.toLowerCase().endsWith('h')) {
          hours = parseFloat(val);
          if (isNaN(hours) || hours <= 0) { console.log('❌ Horas inválidas'); process.exit(1); }
        } else {
          days = parseInt(val);
          if (isNaN(days) || days <= 0) { console.log('❌ Dias inválidos'); process.exit(1); }
        }

        const body = hours ? { license_key: key.toUpperCase(), hours } : { license_key: key.toUpperCase(), days };
        const result = await apiRetry('POST', '/api/admin/extend', body);

        if (hours) {
          console.log(`\n✅ Licença ${key.toUpperCase()} estendida em ${hours}h.`);
        } else {
          console.log(`\n✅ Licença ${key.toUpperCase()} estendida em ${days} dias.`);
        }
        console.log(`   Nova expiração: ${new Date(result.new_expires_at).toLocaleString('pt-BR')}\n`);
        break;
      }

      case 'reset-hwid': {
        const key = args[1];
        if (!key) { console.log('Uso: node admin-cli.js reset-hwid <chave>'); process.exit(1); }
        await apiRetry('POST', '/api/admin/reset-hwid', { license_key: key.toUpperCase() });
        console.log(`\n🔓 HWID da licença ${key.toUpperCase()} resetado.`);
        console.log(`   O cliente pode ativar em um novo PC.\n`);
        break;
      }

      case 'cleanup': {
        console.log('\n🧹 Removendo licenças revogadas/expiradas...');
        const result = await apiRetry('POST', '/api/admin/cleanup');
        console.log(`   ${result.removed} licença(s) removida(s).`);
        console.log(`   ${result.remaining} licença(s) ativa(s) restante(s).\n`);
        break;
      }

      case 'stats': {
        const stats = await apiRetry('GET', '/api/admin/stats');
        console.log('\n📊 Estatísticas:\n');
        console.log(`   Total:      ${stats.total}`);
        console.log(`   Ativas:     ${stats.active}`);
        console.log(`   Em uso:     ${stats.inUse}`);
        console.log(`   Expirando:  ${stats.expiringSoon} (7 dias)`);
        console.log(`   Revogadas:  ${stats.revoked}`);
        console.log(`   Expiradas:  ${stats.expired}\n`);
        break;
      }

      case 'backup': {
        console.log('\n💾 Baixando backup...');
        const backup = await apiRetry('GET', '/api/admin/backup');
        if (typeof backup === 'string') {
          const file = path.join(__dirname, `backup-${new Date().toISOString().slice(0, 10)}.json`);
          fs.writeFileSync(file, backup, 'utf-8');
          console.log(`   Backup salvo em: ${file}\n`);
        } else {
          console.log('   ❌ Erro ao baixar backup\n');
        }
        break;
      }

      default:
        console.log(`
 🔑 TeoGlobal — Gerenciador de Licenças (v2)

   Comandos:
     node admin-cli.js generate <dias> [nome]         Gerar licença (ex: 30)
     node admin-cli.js generate 2h [nome]              Licença de horas (teste)
     node admin-cli.js generate --hours 0.5 [nome]     Licença de 30 min
     node admin-cli.js generate vitalicio [nome]       Licença VITALÍCIA
     node admin-cli.js list                            Listar licenças
     node admin-cli.js revoke <chave>                  Revogar licença
     node admin-cli.js extend <chave> <dias>           Estender em dias
     node admin-cli.js extend <chave> <horas>h         Estender em horas
     node admin-cli.js reset-hwid <chave>              Liberar para novo PC
     node admin-cli.js cleanup                         Remover expiradas/revogadas
     node admin-cli.js stats                           Estatísticas rápidas
     node admin-cli.js backup                          Baixar backup JSON

   Ambiente:
     LICENSE_SERVER    URL do servidor
     LICENSE_SECRET    Chave admin (obrigatória)
 `);
    }
  } catch (err) {
    console.error(`\n❌ Erro: ${err.message}`);
    if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
      console.error('   Servidor offline ou URL incorreta.\n');
    }
  }
}

main();
