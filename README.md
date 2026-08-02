# test-dcr-mcp-server

Minimaler, spec-konformer **Remote-MCP-Server** mit eigenem **OAuth-2.1-Authorization-Server** inkl. **Dynamic Client Registration (DCR)** — gebaut, um Notion Custom Agents per „Sign in with OAuth" anzubinden, ohne dass ein Bearer-Token manuell eingetragen wird.

**Testserver, kein Produktionscode.** In-Memory-State, Klartext-Passwörter in der Env, keine Nutzerverwaltung.

## Features

- **MCP Streamable HTTP** unter `POST /mcp` (stateless, kein Session-Store)
- **OAuth 2.1 Authorization Server** handimplementiert (für maximale Transparenz im Log):
  - RFC 9728 Protected Resource Metadata (`/.well-known/oauth-protected-resource`, auch `/mcp`-Variante)
  - RFC 8414 Authorization Server Metadata (`/.well-known/oauth-authorization-server` + `/openid-configuration`-Alias)
  - RFC 7591 Dynamic Client Registration (`POST /register`, public clients)
  - PKCE zwingend mit `S256` (RFC 7636)
  - Authorization-Code-Grant + Refresh-Token-Grant mit **Rotation**
  - RFC 8707 `resource`-Parameter wird akzeptiert und geloggt
- **Login-Formular mit E-Mail + Passwort** am `/authorize`-Endpoint (User via `USERS_JSON` provisioniert)
- Access Tokens = JWT (HS256, self-contained); Refresh Tokens = opak mit Rotation
- **401 + `WWW-Authenticate: Bearer … resource_metadata=…`** auf unauthentifizierte `/mcp`-Requests (Notions Discovery-Trigger)
- **Request-Logging auf allen Auth-Endpunkten** (JSON-Zeilen, Secrets redigiert) — zeigt, was Notion tatsächlich sendet
- **Statefile-Persistenz** (optional): DCR-Clients + Refresh-Tokens überleben Restarts (`STATE_FILE` + Volume)
- Tools: `whoami` (Identity-Passthrough), `echo`, `slow_task` (Timeout-Verhalten)

## Quickstart (lokal)

```bash
cp .env.example .env
# Secrets in .env anpassen (min. 32 Zeichen), z. B.: openssl rand -base64 48
npm install
npm run dev
```

Server läuft auf `http://localhost:3000`.

## Konfiguration (Env)

| Variable | Default | Beschreibung |
|---|---|---|
| `BASE_URL` | – | Öffentliche URL ohne trailing slash. **Muss exakt stimmen** (Issuer-Match). Lokal `http://localhost:3000`, produktiv `https://…` |
| `PORT` | `3000` | Listen-Port |
| `TOKEN_SECRET` | – | JWT-Signatur (HS256), min. 32 Zeichen |
| `SESSION_SECRET` | – | HMAC-Signatur des Login-Cookies, min. 32 Zeichen |
| `USERS_JSON` | – | Test-Nutzer, z. B. `[{"email":"a@b.c","password":"pw","name":"Ada"}]` (Klartext — Testserver!) |
| `ACCESS_TOKEN_TTL` | `3600` | Sekunden. `60` = Refresh-Flow schnell testen |
| `REFRESH_TOKEN_TTL` | `2592000` | Sekunden (30 Tage) |
| `STATE_FILE` | _(aus)_ | Pfad zur State-Datei (DCR-Clients + Refresh-Tokens). Ohne Variable: rein in-memory |

## Verifikation per curl

### 1. Discovery-Trigger: 401 mit WWW-Authenticate

```bash
curl -i -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# → 401 Unauthorized
# → WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"
```

### 2. Well-Known-Dokumente (öffentlich)

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource | jq
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp | jq   # RFC 9728 §3.1
curl -s http://localhost:3000/.well-known/oauth-authorization-server | jq
curl -s http://localhost:3000/.well-known/openid-configuration | jq           # Alias
```

### 3. DCR

```bash
curl -i -X POST http://localhost:3000/register \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://localhost:9999/cb"],"client_name":"curl-test","token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}'
# → 201 Created + {"client_id":"…", …}
```

### 4. Kompletter PKCE-Flow

```bash
CID="<client_id aus Schritt 3>"
verifier=$(openssl rand -base64 96 | tr -dc 'a-zA-Z0-9-._~' | head -c 64)
challenge=$(printf %s "$verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')

# Login-Formular holen (Cookie-Jar merken!)
curl -s -c jar "http://localhost:3000/authorize?response_type=code&client_id=$CID\
&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&state=xyz\
&code_challenge=$challenge&code_challenge_method=S256\
&resource=http%3A%2F%2Flocalhost%3A3000%2Fmcp"
# → HTML-Formular; txn aus dem hidden field extrahieren:
TXN=$(…)

# Credentials absenden → 302 mit code
curl -s -o /dev/null -w '%{redirect_url}' -b jar -c jar -X POST http://localhost:3000/authorize \
  -d "txn=$TXN&email=test@example.com&password=test1234"
# → http://localhost:9999/cb?code=…&state=xyz

# Code eintauschen → Tokens
curl -s -X POST http://localhost:3000/token \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb\
&client_id=$CID&code_verifier=$verifier&resource=http%3A%2F%2Flocalhost%3A3000%2Fmcp"
# → {"access_token":"…","token_type":"Bearer","expires_in":60,"refresh_token":"…","scope":"mcp"}
```

### 5. MCP mit Token

```bash
# Wichtig: Accept-Header muss BEIDE Typen enthalten (Streamable-HTTP-Anforderung)
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
# → SSE: Identität des eingeloggten Nutzers (email, name, clientId, scopes, expiresAt)
```

### 6. Refresh-Flow (bei `ACCESS_TOKEN_TTL=60`)

```bash
sleep 65
curl -si -X POST http://localhost:3000/mcp -H "Authorization: Bearer $AT" …   # → 401 invalid_token
curl -s -X POST http://localhost:3000/token \
  -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID"             # → neues Token-Paar (Rotation!)
curl -s -X POST http://localhost:3000/token \
  -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID"             # → invalid_grant (altes Token verbraucht)
```

## MCP Inspector (beste Fehlermeldungen, selber Flow wie Notion)

```bash
npx @modelcontextprotocol/inspector@latest
# UI: http://localhost:6274 → Transport: "Streamable HTTP" → URL: http://localhost:3000/mcp
# → Guided OAuth Flow: der Inspector macht DCR selbst (Log zeigt seine redirect_uris:
#   http://127.0.0.1:6274/oauth/callback), öffnet das Login-Formular, exchanged den Code.
```

## Docker

```bash
docker build -t test-dcr-mcp .
docker run --rm -p 3000:3000 --env-file .env \
  -e STATE_FILE=/data/state.json -v mcp-data:/data \
  test-dcr-mcp
```

Multi-Stage-Build (node:22-alpine), non-root (`USER node`), `HEALTHCHECK` auf `/health`, `VOLUME /data` für das Statefile.

## HTTPS-Tunnel (Notion braucht öffentliches HTTPS)

```bash
cloudflared tunnel --url http://localhost:3000
# → https://<zufall>.trycloudflare.com
# Server mit BASE_URL=https://<zufall>.trycloudflare.com neu starten (Issuer-Match!)
```

## Deploy auf EasyPanel

1. Repo auf GitHub pushen (Dockerfile liegt im Root).
2. EasyPanel → **Create Service → App** → Git-Repo verbinden → Dockerfile wird automatisch erkannt.
3. **Env** setzen: `BASE_URL=https://<app>.<domain>`, `TOKEN_SECRET`, `SESSION_SECRET` (je ≥32 Zeichen), `USERS_JSON`, `ACCESS_TOKEN_TTL=60` (zum Testen), `STATE_FILE=/data/state.json`.
4. **Volume** anlegen → Mount-Pfad `/data` (persistiert DCR-Clients + Refresh-Tokens über Redeploys).
5. **Domain** zuweisen, HTTPS aktivieren (Traefik + Let's Encrypt automatisch), Container-Port **3000**.
6. Deploy → prüfen: `curl https://<domain>/health` + beide Well-Known-Docs.

## Anbindung an Notion

Voraussetzung: Ein Owner/Admin hat **Custom MCP servers** freigeschaltet (`Settings → Notion AI → AI connectors → Enable Custom MCP servers`).

1. `Settings → Notion AI → AI connectors → Custom MCP servers` → Server per URL hinzufügen: `https://<domain>/mcp`
2. Es erscheint ein **„Sign in with OAuth"-Button** (kein Token-Feld).
3. Klick → Browser → Login-Formular (E-Mail/Passwort aus `USERS_JSON`) → Redirect zurück.
4. Server erscheint unter *All sources → MCP servers*; `whoami` liefert die Identität des angemeldeten Nutzers.

**Im Server-Log beobachten** (alles JSON-Zeilen): der initiale 401, PRM-Fetch, AS-Metadata-Fetch, **der DCR-Body mit Notions echten `redirect_uris`**, Authorize/Login, Token-Exchange — und nach 60 s (bei `ACCESS_TOKEN_TTL=60`) der selbstständige Refresh durch Notion.

## Architektur-Notizen

- **Stateless MCP-Transport**: pro `POST /mcp` frische `McpServer`+`StreamableHTTPServerTransport`-Instanz (`sessionIdGenerator: undefined`). `GET /mcp` → 405 (kein Standalone-SSE ohne Sessions).
- **Was wird wo gespeichert?** Access Tokens (JWT) nirgends — nur signiert/verifiziert. Refresh Tokens, DCR-Clients, Auth-Codes, Pending-Logins in Maps; davon werden Clients + Refresh-Tokens ins `STATE_FILE` persistiert (debounced, atomar via tmp+rename). Auth-Codes/Pending (10-min-TTL) bleiben bewusst flüchtig. Nutzer kommen immer aus `USERS_JSON`.
- **Login-Session**: HMAC-signiertes Cookie (`HttpOnly; SameSite=Lax`; `Secure` nur bei HTTPS), damit nachfolgende Authorize-Requests das Formular überspringen.
- **Express 5**, weil `@modelcontextprotocol/sdk` selbst davon abhängt (keine Duplikat-Installation, `req.auth`-Augment greift).

## Bekannte Grenzen (bewusst)

- Klartext-Passwörter in der Env; Passwort-Vergleich ohne Hashing.
- Kein Rate-Limiting, keine CSRF-Tokens am Login-Form (Txn-Id ist zufällig, reicht für den Test).
- `resource`-Mismatch wird nur geloggt, nicht abgelehnt (Lernmodus).
- Ohne `STATE_FILE` überleben Registrierungen/Refresh-Tokens keinen Restart → Notion registriert sich dann neu und der Nutzer loggt sich neu ein.
