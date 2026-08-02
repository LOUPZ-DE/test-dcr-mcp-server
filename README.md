# Test-DCR-MCP-Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen)](package.json)
[![MCP SDK 1.30](https://img.shields.io/badge/MCP%20SDK-1.30-blueviolet)](https://github.com/modelcontextprotocol/typescript-sdk)
[![OAuth 2.1 + DCR](https://img.shields.io/badge/OAuth%202.1-%2B%20DCR%20(RFC%207591)-orange)](https://datatracker.ietf.org/doc/html/rfc7591)
[![Docker ready](https://img.shields.io/badge/docker-ready-2496ED)](Dockerfile)

> 🇩🇪 **[Deutsche Version: README.de.md](README.de.md)**

A minimal, spec-compliant **remote MCP server** with a built-in **OAuth 2.1 authorization server** including **Dynamic Client Registration (DCR)** — built so that Notion Custom Agents can connect via "Sign in with OAuth", without ever pasting a bearer token.

**Reference implementation / test server — not production-hardened.** In-memory state, plaintext env passwords, no user management. See [Known limits](#known-limits-deliberate).

## Why this exists

Notion Custom Agents accept custom MCP servers over OAuth **only if the server supports DCR** — otherwise Notion would have to pre-register a client, which it only does for official connectors. This repo is a working, verified reference for that path, including **measured findings from a real Notion E2E test** (see below) and optional **SSO federation to Google / Microsoft Entra** — the pattern you need for "connect Notion to your corporate IdP".

## Features

- **MCP Streamable HTTP** at `POST /mcp` (stateless, no session store)
- **Hand-rolled OAuth 2.1 authorization server** (for maximum log transparency):
  - RFC 9728 Protected Resource Metadata (`/.well-known/oauth-protected-resource`, plus the `/mcp` path variant)
  - RFC 8414 Authorization Server Metadata (`/.well-known/oauth-authorization-server` + `/openid-configuration` alias)
  - RFC 7591 Dynamic Client Registration (`POST /register`, public clients)
  - PKCE enforced with `S256` (RFC 7636)
  - Authorization code grant + refresh token grant with **rotation**
  - RFC 8707 `resource` parameter accepted and logged
  - RFC 9207 `iss` parameter in authorization responses
- **Login form with email + password** at `/authorize` (users provisioned via `USERS_JSON`)
- **SSO: external identity providers** switchable via env — **Google** and **Microsoft Entra (single tenant)** over OIDC (authorization code + PKCE, `id_token` verified via JWKS), optional domain/email allowlist
- Access tokens = JWT (HS256, self-contained); refresh tokens = opaque with rotation
- **401 + `WWW-Authenticate: Bearer … resource_metadata=…`** on unauthenticated `/mcp` requests (Notion's discovery trigger)
- **Request logging on all auth endpoints** (JSON lines, secrets redacted) — shows exactly what Notion sends
- **State file persistence** (optional): DCR clients + refresh tokens survive restarts (`STATE_FILE` + volume)
- **Server icon**: `/.well-known/mcp.json` (Notion's discovery convention) + `serverInfo.icons` (SEP-973)
- Tools: `whoami` (identity passthrough), `echo`, `slow_task` (timeout behavior)

## Quickstart (local)

```bash
cp .env.example .env
# adjust secrets in .env (min. 32 chars each), e.g.: openssl rand -base64 48
npm install
npm run dev
```

Server runs at `http://localhost:3000`.

## Configuration (env)

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | – | Public URL without trailing slash. **Must match exactly** (issuer match). Locally `http://localhost:3000`, in production `https://…` |
| `PORT` | `3000` | Listen port |
| `TOKEN_SECRET` | – | JWT signature (HS256), min. 32 chars |
| `SESSION_SECRET` | – | HMAC signature of the login cookie, min. 32 chars |
| `USERS_JSON` | – | Test users, e.g. `[{"email":"a@b.c","password":"pw","name":"Ada"}]` (plaintext — test server!). Only required when `AUTH_PROVIDERS` includes `local` |
| `ACCESS_TOKEN_TTL` | `3600` | Seconds. `60` = test the refresh flow quickly |
| `REFRESH_TOKEN_TTL` | `2592000` | Seconds (30 days) |
| `STATE_FILE` | _(off)_ | Path to state file (DCR clients + refresh tokens). Without it: pure in-memory |
| `SERVER_NAME` | `test-dcr-mcp-server` | Display name: `serverInfo.name`, `mcp.json`, PRM `resource_name`, HTML pages |
| `AUTH_PROVIDERS` | `local` | Comma list: `local`, `google`, `entra` — combinable, e.g. `local,google` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Required for `google` |
| `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` / `ENTRA_TENANT_ID` | – | Required for `entra` |
| `SSO_ALLOWED_DOMAINS` | _(off)_ | Comma list of allowed email domains for SSO |
| `SSO_ALLOWED_EMAILS` | _(off)_ | Comma list of allowed individual addresses for SSO |

## SSO: external identity providers (Google / Microsoft Entra)

The server remains the OAuth issuer toward Notion (DCR, its own JWTs — unchanged). Only the **login step** is delegated to the IdP (federated broker pattern):

```
Notion ──OAuth──> this server ──OIDC──> Google / Entra
        (unchanged)            (authentication only,
                                no upstream token needed)
```

Flow: login page shows buttons → `GET /auth/<provider>/start?txn=…` → redirect to IdP (authorization code + **PKCE S256** + `nonce`) → `GET /auth/<provider>/callback` → code exchange → **`id_token` verified via JWKS** (`iss`, `aud`, `nonce`) → allowlist check → then exactly the same path as the local login (session cookie, own code, own tokens). `whoami` shows the IdP (`idp: "google" | "entra" | "local"`).

> ⚠️ Without `SSO_ALLOWED_DOMAINS`/`SSO_ALLOWED_EMAILS`, **any** account of the IdP can log in (boot warning). With Entra single tenant, the tenant already scopes the org — the allowlist is optional there.

### Setting up Google

1. [Google Cloud Console](https://console.cloud.google.com/) → pick/create project → **APIs & Services → OAuth consent screen** (External, basic info).
2. **Credentials → Create Credentials → OAuth client ID** → type **Web application**.
3. **Authorized redirect URI**: `https://<host>/auth/google/callback`
4. Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_PROVIDERS=local,google` (or without `local`).

### Setting up Microsoft Entra (single tenant, recommended)

1. [Entra Portal](https://entra.microsoft.com/) → **Identity → Applications → App registrations → New registration**.
2. Any name, **Supported account types: "Accounts in this organizational directory only (Single tenant)"** — only members of your tenant can log in.
3. **Redirect URI**: platform **Web**, `https://<host>/auth/entra/callback`.
4. **Certificates & secrets → New client secret** → copy the value immediately.
5. Env: `ENTRA_TENANT_ID` (Directory/tenant ID from the app overview page), `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `AUTH_PROVIDERS=local,entra`.
6. No additional API permissions needed (`openid email profile` suffices; default consent).
7. Note: the `email` claim is **not guaranteed** on Entra — the server falls back to `preferred_username`/`upn`.

## Plugging in your own login (the replacement seam)

Login methods are deliberately swappable — for later projects with an existing login (e.g. app session, other SSO):

1. Produce an `AuthnIdentity` (`{email, name, idp}`, [src/authn/identity.ts](src/authn/identity.ts)) from your own authentication.
2. Call **`completeAuthorization(res, pending, identity)`** ([src/oauth/complete.ts](src/oauth/complete.ts)) — that's the only seam. Everything after it (code, tokens, JWT, MCP) stays unchanged.

The built-in methods live in [src/authn/](src/authn/) (local form in `loginPage.ts` + `POST /authorize` in [src/oauth/authorize.ts](src/oauth/authorize.ts), SSO in [src/authn/idp/](src/authn/idp/)) and can be replaced wholesale. Want another IdP? An `IdpProvider` object ([src/authn/idp/types.ts](src/authn/idp/types.ts)) plus a registry entry is enough.

## Verification with curl

Or as a ready-made script (covers all steps below):

```bash
./scripts/test-flow.sh http://localhost:3000 test@example.com test1234
```

### 1. Discovery trigger: 401 with WWW-Authenticate

```bash
curl -i -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# → 401 Unauthorized
# → WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"
```

### 2. Well-known documents (public)

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource | jq
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp | jq   # RFC 9728 §3.1
curl -s http://localhost:3000/.well-known/oauth-authorization-server | jq
curl -s http://localhost:3000/.well-known/openid-configuration | jq           # alias
curl -s http://localhost:3000/.well-known/mcp.json | jq                       # Notion discovery (icon, name)
```

### 3. DCR

```bash
curl -i -X POST http://localhost:3000/register \
  -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://localhost:9999/cb"],"client_name":"curl-test","token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}'
# → 201 Created + {"client_id":"…", …}
```

### 4. Full PKCE flow

```bash
CID="<client_id from step 3>"
verifier=$(openssl rand -base64 96 | tr -dc 'a-zA-Z0-9-._~' | head -c 64)
challenge=$(printf %s "$verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')

# Fetch login form (keep the cookie jar!)
curl -s -c jar "http://localhost:3000/authorize?response_type=code&client_id=$CID\
&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&state=xyz\
&code_challenge=$challenge&code_challenge_method=S256\
&resource=http%3A%2F%2Flocalhost%3A3000%2Fmcp"
# → HTML form; extract txn from the hidden field:
TXN=$(…)

# Submit credentials → 302 with code (+ iss, RFC 9207)
curl -s -o /dev/null -w '%{redirect_url}' -b jar -c jar -X POST http://localhost:3000/authorize \
  -d "txn=$TXN&email=test@example.com&password=test1234"
# → http://localhost:9999/cb?code=…&state=xyz&iss=…

# Exchange code → tokens
curl -s -X POST http://localhost:3000/token \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb\
&client_id=$CID&code_verifier=$verifier&resource=http%3A%2F%2Flocalhost%3A3000%2Fmcp"
# → {"access_token":"…","token_type":"Bearer","expires_in":60,"refresh_token":"…","scope":"mcp"}
```

### 5. MCP with token

```bash
# Important: the Accept header must include BOTH types (Streamable HTTP requirement)
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $AT" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
# → SSE: identity of the logged-in user (email, name, idp, notionUserId, clientId, scopes, expiresAt)
```

### 6. Refresh flow (with `ACCESS_TOKEN_TTL=60`)

```bash
sleep 65
curl -si -X POST http://localhost:3000/mcp -H "Authorization: Bearer $AT" …   # → 401 invalid_token
curl -s -X POST http://localhost:3000/token \
  -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID"             # → new token pair (rotation!)
curl -s -X POST http://localhost:3000/token \
  -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID"             # → invalid_grant (old token consumed)
```

## MCP Inspector (best error messages, same flow as Notion)

```bash
npx @modelcontextprotocol/inspector@latest
# UI: http://localhost:6274 → transport: "Streamable HTTP" → URL: http://localhost:3000/mcp
# → Guided OAuth flow: the Inspector does DCR itself (watch the log for its redirect_uris:
#   http://127.0.0.1:6274/oauth/callback), opens the login form, exchanges the code.
```

## Docker

```bash
docker build -t test-dcr-mcp .
docker run --rm -p 3000:3000 --env-file .env \
  -e STATE_FILE=/data/state.json -v mcp-data:/data \
  test-dcr-mcp
```

Multi-stage build (node:22-alpine), non-root (`USER node`), `HEALTHCHECK` on `/health`, `VOLUME /data` for the state file.

## HTTPS tunnel (Notion requires public HTTPS)

```bash
cloudflared tunnel --url http://localhost:3000
# → https://<random>.trycloudflare.com
# Restart the server with BASE_URL=https://<random>.trycloudflare.com (issuer match!)
```

## Deploying on EasyPanel

1. Push the repo to GitHub (Dockerfile is at the root).
2. EasyPanel → **Create Service → App** → connect the Git repo → the Dockerfile is detected automatically.
3. Set **env**: `BASE_URL=https://<app>.<domain>`, `TOKEN_SECRET`, `SESSION_SECRET` (≥32 chars each), `USERS_JSON`, `ACCESS_TOKEN_TTL=60` (for testing), `STATE_FILE=/data/state.json`.
4. Create a **volume** → mount path `/data` (persists DCR clients + refresh tokens across redeploys).
5. Assign a **domain**, enable HTTPS (Traefik + Let's Encrypt automatic), container port **3000**.
6. Deploy → verify: `curl https://<domain>/health` + both well-known docs.

## Connecting Notion

Prerequisite: an owner/admin has enabled **Custom MCP servers** (`Settings → Notion AI → AI connectors → Enable Custom MCP servers`).

1. `Settings → Notion AI → AI connectors → Custom MCP servers` → add the server by URL: **`https://<domain>/mcp`** — enter the URL **in full, including `/mcp`**! (Notion uses the entered URL as the MCP endpoint; with the root URL, traffic lands on `POST /` → 404 — see "Findings" below.)
2. A **"Sign in with OAuth" button** appears (no token field).
3. Click → browser → login form (email/password from `USERS_JSON`) → redirect back.
4. The server appears under *All sources → MCP servers*; `whoami` returns the identity of the signed-in user (`email`/`name` from `USERS_JSON`) plus the `notionUserId` of the connecting Notion account.
5. **Tools appear lazily:** Notion only calls `tools/list` when an agent actually uses the source. Test prompt: *"Which tools does the Test-DCR-MCP-Server provide? Then call the whoami tool."*

**Watch the server log** (all JSON lines): the initial 401, PRM fetch, AS metadata fetch, **the DCR body with Notion's real `redirect_uris`**, authorize/login, token exchange — and after 60s (with `ACCESS_TOKEN_TTL=60`) Notion's automatic refresh.

## Spec status & outlook (MCP 2026-07-28)

This server speaks wire revision **2025-06-18/2025-11-25** (via `@modelcontextprotocol/sdk` v1) — that's what Notion understands today, and v1 keeps receiving fixes for at least 6 months. Spec revision **2026-07-28** has been released; assessment for this project:

- **Stateless is now the spec's direction** — this server is already built that way (`sessionIdGenerator: undefined`, fresh instance per request). The biggest breaking changes (sessions/handshake/SSE resumability removal) don't affect us.
- **RFC 9207 (`iss` in authorization responses) is implemented** — in both the code redirect and error redirects.
- **DCR (RFC 7591) is deprecated** in favor of *Client ID Metadata Documents* (CIMD). It remains available for backwards compatibility, and **Notion currently only speaks DCR** — this server stays the working path. Long-term, CIMD would make `/register` + the client store obsolete (less state, not more) — a sensible follow-up feature once clients (Inspector/Notion) speak CIMD.
- **SDK v2** (scoped packages: `@modelcontextprotocol/server`, official Express/Fastify/Hono adapters, `createMcpHandler` serving both revisions at one endpoint, v1→v2 codemod): migrate after stable release; for Fastify ports the official adapter covers the previous `reply.raw` manual work.

## Findings from the real Notion E2E test (measured, not guessed)

Everything below comes from request logs of an actual connect with Notion Custom Agents (as of 2026-08):

### Discovery & DCR

- **DCR without pre-registration works.** Notion self-registers with `client_name: "Notion"`, `token_endpoint_auth_method: "none"`, scope `mcp`.
- **Notion's redirect URI:** `https://app.notion.com/workflows/mcp/oauth/callback`
- User agent of server-side calls: `Notion-MCP-Client/1.0`.
- **`/.well-known/mcp.json` is Notion's discovery convention** (name, `description`, **`icon`**, `endpoint`) and is fetched when connecting — this server serves the document including `icon` (self-hosted at `/icon.png`, generated via `scripts/generate-icon.mjs`). Additionally, `serverInfo` carries an `icons` array (MCP spec 2025-11-25, SEP-973) — that's how the icon in the connection dialog can be influenced without any Notion-side setting. Note: Notion appears to cache the icon per connection — disconnect and reconnect to see changes.

### Authorize request — Notion sends extra parameters

```
response_type=code, client_id, redirect_uri, state,
code_challenge, code_challenge_method=S256,
scope=mcp, resource=<see below>,
nonce=<…>, prompt=consent,
notion_user_id=<UUID of the Notion user>
```

- **`notion_user_id`** is the Notion user ID of the person connecting the connector. This server passes it through as a custom `notion_user_id` JWT claim — `whoami` shows it. That lets an MCP server **distinguish per Notion user** even when everyone shares the same server login. (Caveat: the value arrives as a query parameter on the authorize endpoint — fine for identity experiments, would need verification for serious use.)
- `nonce` and `prompt=consent` are also sent (OIDC flavor) but don't need to be evaluated.

### ⚠️ Most important practical point: the entered URL IS the endpoint

- Notion uses the **URL entered when creating the connector** as the endpoint for all MCP traffic — and as the RFC 8707 `resource` parameter throughout the flow.
- If the connector is added **with the root URL** (`https://host/`), Notion sends its JSON-RPC calls to **`POST /`** — not `/mcp`. Symptom in the Notion agent: *"Failed to connect to MCP server"*; in the server log: `POST / → 404` (preceded by successful token refreshes — the OAuth part works).
- **Fix: enter the connector with the full URL including the path, i.e. `https://host/mcp`.** This server deliberately serves MCP only on `/mcp` (no root mount), keeping the pattern clean on hosts that also serve a conventional API on `/`. `GET /` shows an HTML info page with the correct URL.
- The `resource` parameter follows the same rule: entered with `/mcp` → `resource=…/mcp`; root entry → `resource=…/`. This server accepts both and logs mismatches (learning mode).

### Tool calls

- **`arguments` is optional in the MCP spec — but de facto mandatory at two layers.** On the first `whoami` call, the Notion LLM omitted `arguments` → Notion's client rejected it **before sending**: `payload.toolArguments should be defined, instead was 'undefined'` (Notion-internal field naming; the call never reached the server). Retry with `arguments: {}` → success.
- **Server-side caution too:** the MCP SDK rejects missing `arguments` when a tool is registered with `inputSchema` (`-32602: expected object, received undefined`) — even with an empty schema `{}`. **Fix: register parameterless tools without `inputSchema` entirely** (callback signature becomes `(extra) => …`); then the server accepts both variants. `whoami` is built that way here.
- After connecting, Notion also probes `GET /mcp` (SSE stream) → our stateless server answers `405` — Notion tolerates that and falls back to POST.
- After `initialize`, Notion sends `notifications/initialized` → response `202` (no body), normal.
- With `ACCESS_TOKEN_TTL=60`, Notion refreshes the token **before almost every MCP call** (in the log: `refresh_token` grant right before each `POST /mcp` batch). Works, but noisy — raise the TTL after testing the refresh path.

### Token behavior

- **Notion refreshes multiple times immediately after connecting** (parallel/redundant workers) — refresh rotation must work cleanly or the connection breaks right after setup.
- Afterwards, with a short `ACCESS_TOKEN_TTL` (60s), the refresh grant is used as expected before further MCP calls.
- PKCE is S256, code exchange immediately after redirect. All standard-compliant.

## Architecture notes

- **Stateless MCP transport**: fresh `McpServer`+`StreamableHTTPServerTransport` instance per `POST /mcp` (`sessionIdGenerator: undefined`). `GET /mcp` → 405 (no standalone SSE without sessions).
- **What is stored where?** Access tokens (JWT) nowhere — only signed/verified. Refresh tokens, DCR clients, auth codes, pending logins in Maps; of these, clients + refresh tokens are persisted to `STATE_FILE` (debounced, atomic via tmp+rename). Auth codes/pending (10-min TTL) deliberately stay volatile. Users always come from `USERS_JSON`.
- **Login session**: HMAC-signed cookie (`HttpOnly; SameSite=Lax`; `Secure` only on HTTPS) with JSON payload `{email, name, idp}` — works for local users and SSO identities alike; subsequent authorize requests skip the login.
- **Authn layer** ([src/authn/](src/authn/)): login methods (local, Google, Entra) produce an `AuthnIdentity` and end at the `completeAuthorization` seam — swappable for later projects with their own login.
- **Express 5**, because `@modelcontextprotocol/sdk` itself depends on it (no duplicate installation, the `req.auth` augmentation applies).

## Known limits (deliberate)

- Plaintext passwords in env; password comparison without hashing.
- No rate limiting, no CSRF tokens on the login form (txn ID is random, sufficient for the test).
- `resource` mismatch is only logged, not rejected (learning mode).
- Without `STATE_FILE`, registrations/refresh tokens don't survive a restart → Notion will re-register and the user logs in again.
- SSO: `email_verified` is only checked for Google (on Entra we trust the tenant); without an allowlist, login is open to all accounts of the IdP.
- The SSO flow has not been tested end-to-end without a real IdP app registration (structurally tested: start redirects incl. PKCE parameters, error paths, provider deactivation).
- **This is a test/reference server.** Before any production use: real user management, hashed credentials, rate limiting, stricter validation, key management — or better, use it as the reference it is meant to be.

## License

[MIT](LICENSE) © LOUPZ GmbH & Co. KG
