# Test-DCR-MCP-Server

> 🇬🇧 **[English version: README.md](README.md)**

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
  - RFC 9207 `iss`-Parameter in Authorization Responses
- **Login-Formular mit E-Mail + Passwort** am `/authorize`-Endpoint (User via `USERS_JSON` provisioniert)
- **SSO: externe Identity Provider** per Env zuschaltbar — **Google** und **Microsoft Entra (Single-Tenant)** via OIDC (Authorization Code + PKCE, JWKS-Verifizierung des `id_token`), optional mit Domain-/E-Mail-Allowlist
- Access Tokens = JWT (HS256, self-contained); Refresh Tokens = opak mit Rotation
- **401 + `WWW-Authenticate: Bearer … resource_metadata=…`** auf unauthentifizierte `/mcp`-Requests (Notions Discovery-Trigger)
- **Request-Logging auf allen Auth-Endpunkten** (JSON-Zeilen, Secrets redigiert) — zeigt, was Notion tatsächlich sendet
- **Statefile-Persistenz** (optional): DCR-Clients + Refresh-Tokens überleben Restarts (`STATE_FILE` + Volume)
- **Server-Icon**: `/.well-known/mcp.json` (Notion-Discovery-Konvention) + `serverInfo.icons` (SEP-973)
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
| `USERS_JSON` | – | Test-Nutzer, z. B. `[{"email":"a@b.c","password":"pw","name":"Ada"}]` (Klartext — Testserver!). Nur Pflicht bei `AUTH_PROVIDERS` mit `local` |
| `ACCESS_TOKEN_TTL` | `3600` | Sekunden. `60` = Refresh-Flow schnell testen |
| `REFRESH_TOKEN_TTL` | `2592000` | Sekunden (30 Tage) |
| `STATE_FILE` | _(aus)_ | Pfad zur State-Datei (DCR-Clients + Refresh-Tokens). Ohne Variable: rein in-memory |
| `SERVER_NAME` | `test-dcr-mcp-server` | Anzeigename: `serverInfo.name`, `mcp.json`, PRM `resource_name`, HTML-Seiten |
| `AUTH_PROVIDERS` | `local` | Komma-Liste: `local`, `google`, `entra` — kombinierbar, z. B. `local,google` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Pflicht bei `google` |
| `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` / `ENTRA_TENANT_ID` | – | Pflicht bei `entra` |
| `SSO_ALLOWED_DOMAINS` | _(aus)_ | Komma-Liste erlaubter E-Mail-Domains für SSO |
| `SSO_ALLOWED_EMAILS` | _(aus)_ | Komma-Liste erlaubter Einzel-Adressen für SSO |

## SSO: externe Identity Provider (Google / Microsoft Entra)

Der Server bleibt gegenüber Notion der OAuth-Issuer (DCR, eigene JWTs — unverändert). Nur der **Login-Schritt** wird an den IdP delegiert (Federated-Broker-Muster):

```
Notion ──OAuth──> dieser Server ──OIDC──> Google / Entra
        (unverändert)              (nur Authentifizierung,
                                     kein Upstream-Token nötig)
```

Flow: Login-Seite zeigt Buttons → `GET /auth/<provider>/start?txn=…` → Redirect zum IdP (Authorization Code + **PKCE S256** + `nonce`) → `GET /auth/<provider>/callback` → Code-Tausch → **`id_token` per JWKS verifiziert** (`iss`, `aud`, `nonce`) → Allowlist-Prüfung → danach exakt derselbe Pfad wie der lokale Login (Session-Cookie, eigener Code, eigene Tokens). `whoami` zeigt den IdP (`idp: "google" | "entra" | "local"`).

> ⚠️ Ohne `SSO_ALLOWED_DOMAINS`/`SSO_ALLOWED_EMAILS` kann sich **jeder** Account des IdP einloggen (Boot-Warnung). Bei Entra-Single-Tenant begrenzt der Tenant bereits die Org — die Allowlist ist dann optional.

### Google einrichten

1. [Google Cloud Console](https://console.cloud.google.com/) → Projekt wählen/erstellen → **APIs & Services → OAuth consent screen** (External, Basis-Infos).
2. **Credentials → Create Credentials → OAuth client ID** → Typ **Web application**.
3. **Authorized redirect URI** eintragen: `https://<host>/auth/google/callback`
4. Client ID + Secret in die Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_PROVIDERS=local,google` (oder ohne `local`).

### Microsoft Entra einrichten (Single-Tenant, empfohlen)

1. [Entra Portal](https://entra.microsoft.com/) → **Identity → Applications → App registrations → New registration**.
2. Name frei, **Supported account types: „Accounts in this organizational directory only (Single tenant)"** — dadurch können sich nur Mitglieder eures Tenants einloggen.
3. **Redirect URI**: Plattform **Web**, `https://<host>/auth/entra/callback`.
4. **Certificates & secrets → New client secret** → Wert sofort kopieren.
5. In die Env: `ENTRA_TENANT_ID` (Directory/Tenant ID von der Übersichtsseite der App), `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `AUTH_PROVIDERS=local,entra`.
6. Keine zusätzlichen API-Permissions nötig (`openid email profile` reicht; Standard-Consent).
7. Hinweis: Der `email`-Claim ist bei Entra **nicht garantiert** — der Server fällt auf `preferred_username`/`upn` zurück.

## Eigene Login-Implementierung anschließen (Austausch-Nahtstelle)

Die Login-Methoden sind bewusst austauschbar gebaut — für spätere Projekte mit bestehendem Login (z. B. App-Session, anderes SSO):

1. Erzeuge eine `AuthnIdentity` (`{email, name, idp}`, [src/authn/identity.ts](src/authn/identity.ts)) aus deiner eigenen Authentifizierung.
2. Rufe **`completeAuthorization(res, pending, identity)`** ([src/oauth/complete.ts](src/oauth/complete.ts)) — das ist die einzige Nahtstelle. Alles dahinter (Code, Tokens, JWT, MCP) bleibt unverändert.

Die bestehenden Methoden leben in [src/authn/](src/authn/) (lokales Formular in `loginPage.ts` + `POST /authorize` in [src/oauth/authorize.ts](src/oauth/authorize.ts), SSO in [src/authn/idp/](src/authn/idp/)) und können komplett ersetzt werden. Neuer IdP gefällig? `IdpProvider`-Objekt ([src/authn/idp/types.ts](src/authn/idp/types.ts)) + Registry-Eintrag genügt.

## Selbsterklärende MCP-Server (instructions / Beschreibungen / nextSteps)

Ein Muster, das jedes aus dieser Referenz gebaute MCP-Projekt übernehmen sollte — drei Ebenen, hier alle implementiert:

1. **`instructions` im InitializeResult** ([src/mcp/server.ts](src/mcp/server.ts)) — der spec-konforme Kanal für „so gehst du mit diesem Server um". Clients legen den Text in den System-Prompt, er steht also *vor dem ersten Tool-Aufruf* bereit. Knapp halten: Arbeitsablauf, Regeln, Grenzen (wenige hundert Zeichen, kein Essay).
2. **Tool-Beschreibungen benennen den Folgeschritt** — jede Beschreibung sagt, was als Nächstes sinnvoll ist (`whoami` → `echo` → `slow_task`).
3. **`nextSteps` in jeder Antwort** — über den gemeinsamen Helper [`respond(payload, nextSteps?)`](src/mcp/respond.ts). Zwei Regeln machen daraus Nutzen statt Rauschen:
   - **Konkret**: mit ausgefüllten Werten (`echo with {"text": "<any string>"}`), nie abstrakt.
   - **Konditional**: nur Schritte, die im aktuellen Kontext zutreffen (siehe `echo`/`slow_task` — unterschiedliche nextSteps je nach Input). Tokens für unzutreffende Hinweise sind schlechter als keine Hinweise.

Hinweis: `instructions` ist ein Spec-Feld; `nextSteps` ist eine Konvention (JSON-Payload, client-agnostisch). Beide kosten Tokens bei jedem Call — entsprechend budgetieren.

## Verifikation per curl

Alternativ als fertiges Skript (deckt alle folgenden Schritte ab):

```bash
./scripts/test-flow.sh http://localhost:3000 test@example.com test1234
```

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
curl -s http://localhost:3000/.well-known/mcp.json | jq                       # Notion-Discovery (Icon, Name)
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

# Credentials absenden → 302 mit code (+ iss, RFC 9207)
curl -s -o /dev/null -w '%{redirect_url}' -b jar -c jar -X POST http://localhost:3000/authorize \
  -d "txn=$TXN&email=test@example.com&password=test1234"
# → http://localhost:9999/cb?code=…&state=xyz&iss=…

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
# → SSE: Identität des eingeloggten Nutzers (email, name, idp, notionUserId, clientId, scopes, expiresAt)
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

1. `Settings → Notion AI → AI connectors → Custom MCP servers` → Server per URL hinzufügen: **`https://<domain>/mcp`** — die URL **vollständig inkl. `/mcp`** eintragen! (Notion verwendet die eingegebene URL als MCP-Endpunkt; bei Root-URL landet der Traffic auf `POST /` → 404, siehe „Erkenntnisse" unten.)
2. Es erscheint ein **„Sign in with OAuth"-Button** (kein Token-Feld).
3. Klick → Browser → Login-Formular (E-Mail/Passwort aus `USERS_JSON`) → Redirect zurück.
4. Server erscheint unter *All sources → MCP servers*; `whoami` liefert die Identität des angemeldeten Nutzers (`email`/`name` aus `USERS_JSON`) plus die `notionUserId` des verbindenden Notion-Accounts.
5. **Tools erscheinen lazy:** Notion ruft `tools/list` erst auf, wenn ein Agent die Quelle benutzt. Test-Prompt: *„Welche Tools stellt der Test-DCR-MCP-Server bereit? Rufe dann das Tool whoami auf."*

**Im Server-Log beobachten** (alles JSON-Zeilen): der initiale 401, PRM-Fetch, AS-Metadata-Fetch, **der DCR-Body mit Notions echten `redirect_uris`**, Authorize/Login, Token-Exchange — und nach 60 s (bei `ACCESS_TOKEN_TTL=60`) der selbstständige Refresh durch Notion.

## Spec-Stand & Ausblick (MCP 2026-07-28)

Dieser Server spricht die Wire-Revision **2025-06-18/2025-11-25** (via `@modelcontextprotocol/sdk` v1) — das ist das, was Notion heute versteht, und v1 erhält noch mindestens 6 Monate Fixes. Die Spec-Revision **2026-07-28** ist erschienen; Einordnung für dieses Projekt:

- **Stateless ist jetzt Spec-Richtung** — dieser Server ist bereits so gebaut (`sessionIdGenerator: undefined`, neue Instanz pro Request). Die größten Breaking Changes (weg mit Sessions/Handshake/SSE-Resumability) betreffen uns nicht.
- **RFC 9207 (`iss` in Authorization Responses) ist umgesetzt** — sowohl im Code-Redirect als auch in Fehler-Redirects.
- **DCR (RFC 7591) ist deprecated** zugunsten *Client ID Metadata Documents* (CIMD). Bleibt aus Backwards-Kompatibilität verfügbar, und **Notion kann aktuell nur DCR** — dieser Server bleibt der funktionierende Pfad. Perspektivisch würde CIMD `/register` + Client-Store obsolet machen (weniger State, nicht mehr) — ein sinnvolles Folge-Feature, sobald Clients (Inspector/Notion) CIMD sprechen.
- **SDK v2** (scoped Pakete: `@modelcontextprotocol/server`, offizielle Express/Fastify/Hono-Adapter, `createMcpHandler` für beide Revisionen an einem Endpoint, Codemod v1→v2): Migration erst nach Stable-Release; für Fastify-Portierungen (z. B. image-ai-portal) deckt der offizielle Adapter den bisherigen `reply.raw`-Handbetrieb ab.

## Erkenntnisse aus dem Notion-E2E-Test (gemessen, nicht geraten)

Alles Folgende stammt aus den Request-Logs eines echten Connects mit Notion Custom Agents (Stand 2026-08):

### Discovery & DCR

- **DCR ohne Vorab-Registrierung funktioniert.** Notion registriert sich selbst mit `client_name: "Notion"`, `token_endpoint_auth_method: "none"`, Scope `mcp`.
- **Notions Redirect-URI:** `https://app.notion.com/workflows/mcp/oauth/callback`
- User-Agent der serverseitigen Calls: `Notion-MCP-Client/1.0`.
- **`/.well-known/mcp.json` ist Notions Discovery-Konvention** (Name, `description`, **`icon`**, `endpoint`) und wird beim Verbinden abgerufen — dieser Server liefert das Dokument inkl. `icon` (selbst gehostet unter `/icon.png`, generiert via `scripts/generate-icon.mjs`). Zusätzlich trägt `serverInfo` ein `icons`-Array (MCP-Spec 2025-11-25, SEP-973) — damit lässt sich das Icon im Verbindungs-Dialog beeinflussen, ohne dass Notion-seitig etwas einstellbar wäre. Hinweis: Notion cached das Icon offenbar pro Verbindung — bei Änderungen Connector trennen und neu verbinden.

### Authorize-Request — Notion sendet Extra-Parameter

```
response_type=code, client_id, redirect_uri, state,
code_challenge, code_challenge_method=S256,
scope=mcp, resource=<siehe unten>,
nonce=<…>, prompt=consent,
notion_user_id=<UUID des Notion-Nutzers>
```

- **`notion_user_id`** ist die Notion-User-ID der Person, die den Connector verbindet. Dieser Server reicht sie als Custom Claim `notion_user_id` in den JWT durch — `whoami` zeigt sie an. Damit kann ein MCP-Server **pro Notion-Nutzer unterscheiden**, auch wenn alle dasselbe Server-Login nutzen. (Achtung: der Wert kommt aus einem Query-Parameter am Authorize-Endpoint — für ernsthafte Nutzung wäre er zu verifizieren, für Identitäts-Experimente reicht er.)
- `nonce` und `prompt=consent` werden ebenfalls mitgeschickt (OIDC-Anklänge), müssen aber nicht ausgewertet werden.

### ⚠️ Wichtigster Praxis-Punkt: die eingegebene URL IST der Endpunkt

- Notion verwendet die **beim Anlegen des Connectors eingegebene URL** als Endpunkt für den gesamten MCP-Traffic — und auch als RFC-8707-`resource`-Parameter im ganzen Flow.
- Wird der Connector **mit der Root-URL** (`https://host/`) eingetragen, sendet Notion seine JSON-RPC-Calls an **`POST /`** — nicht an `/mcp`. Symptom im Notion-Agent: *„Failed to connect to MCP server"*, im Server-Log: `POST / → 404` (und davor erfolgreiche Token-Refreshes — der OAuth-Teil läuft ja).
- **Lösung: Connector mit der vollen URL inkl. Pfad eintragen, also `https://host/mcp`.** Dieser Server liefert MCP bewusst nur auf `/mcp` aus (kein Root-Mount), damit das Muster auch auf Hosts mit herkömmlicher API auf `/` sauber bleibt. `GET /` zeigt eine HTML-Info-Seite mit der korrekten URL.
- Der `resource`-Parameter folgt derselben Regel: bei Eintrag mit `/mcp` kommt `resource=…/mcp`, bei Root-Eintrag `resource=…/`. Dieser Server akzeptiert beide und loggt Mismatches (Lernmodus).

### Tool-Aufrufe

- **`arguments` ist in der MCP-Spec optional — in der Praxis aber zweistufig Pflicht.** Beim ersten `whoami`-Aufruf ließ das Notion-LLM `arguments` weg → Notions Client lehnte **vor dem Absenden** ab: `payload.toolArguments should be defined, instead was 'undefined'` (Notion-interne Feldbezeichnung; der Call erreichte den Server nie). Retry mit `arguments: {}` → Erfolg.
- **Auch serverseitig Vorsicht:** Das MCP-SDK lehnt fehlende `arguments` ab, wenn das Tool mit `inputSchema` registriert ist (`-32602: expected object, received undefined`) — selbst bei leerem Schema `{}`. **Fix: parameterlose Tools ganz ohne `inputSchema` registrieren** (Callback-Signatur ist dann `(extra) => …`); so akzeptiert der Server beide Varianten. `whoami` ist hier entsprechend gebaut.
- Notion probiert nach dem Connect auch `GET /mcp` (SSE-Stream) → unser stateless Server antwortet `405` — Notion toleriert das und fällt auf POST zurück.
- Nach `initialize` schickt Notion `notifications/initialized` → Antwort `202` (kein Body), normal.
- Mit `ACCESS_TOKEN_TTL=60` refreshed Notion **vor nahezu jedem MCP-Call** den Token (im Log: `refresh_token`-Grant direkt vor jedem `POST /mcp`-Batch). Funktioniert, erzeugt aber Log-Rauschen — nach dem Refresh-Test ruhig TTL hochsetzen.

### Token-Verhalten

- **Notion refresht sofort nach dem Connect mehrfach** (parallel/ redundante Worker) — Refresh-Rotation muss also sauber funktionieren, sonst bricht die Verbindung direkt nach dem Aufbau.
- Danach wird der Refresh-Grant bei kurzer `ACCESS_TOKEN_TTL` (60 s) erwartungsgemäß vor jedem weiteren MCP-Call genutzt.
- PKCE ist S256, Code-Exchange sofort nach Redirect. Alles standardkonform.

## Architektur-Notizen

- **Stateless MCP-Transport**: pro `POST /mcp` frische `McpServer`+`StreamableHTTPServerTransport`-Instanz (`sessionIdGenerator: undefined`). `GET /mcp` → 405 (kein Standalone-SSE ohne Sessions).
- **Was wird wo gespeichert?** Access Tokens (JWT) nirgends — nur signiert/verifiziert. Refresh Tokens, DCR-Clients, Auth-Codes, Pending-Logins in Maps; davon werden Clients + Refresh-Tokens ins `STATE_FILE` persistiert (debounced, atomar via tmp+rename). Auth-Codes/Pending (10-min-TTL) bleiben bewusst flüchtig. Nutzer kommen immer aus `USERS_JSON`.
- **Login-Session**: HMAC-signiertes Cookie (`HttpOnly; SameSite=Lax`; `Secure` nur bei HTTPS) mit JSON-Payload `{email, name, idp}` — funktioniert für lokale User und SSO-Identitäten gleichermaßen; nachfolgende Authorize-Requests überspringen den Login.
- **Authn-Schicht** ([src/authn/](src/authn/)): Login-Methoden (lokal, Google, Entra) erzeugen eine `AuthnIdentity` und enden an der Nahtstelle `completeAuthorization` — austauschbar für spätere Projekte mit eigenem Login.
- **Express 5**, weil `@modelcontextprotocol/sdk` selbst davon abhängt (keine Duplikat-Installation, `req.auth`-Augment greift).

## Bekannte Grenzen (bewusst)

- Klartext-Passwörter in der Env; Passwort-Vergleich ohne Hashing.
- Kein Rate-Limiting, keine CSRF-Tokens am Login-Form (Txn-Id ist zufällig, reicht für den Test).
- `resource`-Mismatch wird nur geloggt, nicht abgelehnt (Lernmodus).
- Ohne `STATE_FILE` überleben Registrierungen/Refresh-Tokens keinen Restart → Notion registriert sich dann neu und der Nutzer loggt sich neu ein.
- SSO: `email_verified` wird nur bei Google geprüft (bei Entra vertrauen wir dem Tenant); ohne Allowlist ist der Login für alle Accounts des IdP offen.
- Der SSO-Flow ist ohne echte IdP-App-Registrierung nicht End-zu-End-getestet (strukturell getestet: Start-Redirects inkl. PKCE-Parametern, Fehlerpfade, Provider-Abschaltung).

## Lizenz

[MIT](LICENSE) © LOUPZ GmbH & Co. KG
