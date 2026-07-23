# TeoGlobal — Servidor de Licenças

## Como fazer deploy (Render.com — GRATUITO)

### 1. Crie uma conta em https://render.com

### 2. Crie um novo Web Service:
- Clique em **"New +" → "Web Service"**
- Conecte com GitHub ou faça upload manual
- Selecione a pasta `license-server/`
- Configure:
  - **Runtime**: Node
  - **Build Command**: `npm install`
  - **Start Command**: `node server.js`
  - **Environment Variable**: `LICENSE_SECRET` = `uma-chave-secreta-forte-aqui`

### 3. Anote a URL gerada (ex: `https://teoglobal-license.onrender.com`)

### 4. Atualize a URL no código:
Em `src/main/kotlin/LicenseManager.kt`, linha 15:
```kotlin
private const val LICENSE_SERVER_URL = "https://teoglobal-license.onrender.com"
```
Depois recompile o JAR e regere a `dist/`.

---

## Como usar localmente (desenvolvimento)

```bash
cd license-server
npm install
npm start
```

Servidor roda em `http://localhost:3000`.

---

## Comandos de Admin

Gere licenças remotamente usando o admin-cli:

```bash
# Configurar URL do servidor e chave secreta
set LICENSE_SERVER=https://teoglobal-license.onrender.com
set LICENSE_SECRET=sua-chave-secreta

# Gerar licença de 30 dias
node admin-cli.js generate 30 "Nome do Cliente"

# Gerar licença de 7 dias
node admin-cli.js generate 7 "Cliente Teste"

# Gerar licença vitalícia
node admin-cli.js generate vitalicio "Cliente VIP"

# Gerar licença por horas (teste de expiração)
node admin-cli.js generate 2h "Teste 2h"
node admin-cli.js generate 1h "Teste 1h"
node admin-cli.js generate --hours 0.5 "Teste 30min"

# Listar licenças
node admin-cli.js list

# Revogar licença
node admin-cli.js revoke TEO-XXXX-XXXX-XXXX-XXXX

# Estender licença em 15 dias
node admin-cli.js extend TEO-XXXX-XXXX-XXXX-XXXX 15
```

---

## Fluxo de venda (manual)

1. Cliente paga via Pix
2. Você confirma o pagamento
3. Roda: `node admin-cli.js generate 30 "Nome do Cliente"`
4. Envia a chave `TEO-XXXX-XXXX-XXXX-XXXX` para o cliente
5. Cliente cola a chave no bot na primeira execução
6. Licença fica vinculada ao PC dele (HWID)
7. Renova automaticamente a cada 30 dias — você gera nova chave e cliente atualiza
