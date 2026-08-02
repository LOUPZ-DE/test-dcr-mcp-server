import type { Request, Response } from 'express';
import { config } from '../config.js';
import { randomToken } from './pkce.js';
import { getClient, getPendingAuth, pendingAuths, authCodes, users, type PendingAuth, type User } from './store.js';
import { getSession, setSession } from './session.js';
import { log } from '../util/log.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;

// ─── HTML (minimal, inline CSS) ─────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · test-dcr-mcp-server</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #1e293b; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; box-shadow: 0 10px 30px rgba(0,0,0,.4); }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .sub { color: #94a3b8; font-size: .85rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: .8rem; color: #94a3b8; margin: .75rem 0 .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .75rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 1rem; }
  input:focus { outline: 2px solid #38bdf8; border-color: transparent; }
  button { width: 100%; margin-top: 1.25rem; padding: .65rem; border: 0; border-radius: 8px; background: #38bdf8; color: #082f49; font-weight: 600; font-size: 1rem; cursor: pointer; }
  button:hover { background: #7dd3fc; }
  .error { background: #7f1d1d; color: #fecaca; border-radius: 8px; padding: .5rem .75rem; font-size: .85rem; margin-top: 1rem; }
  .meta { font-size: .75rem; color: #64748b; margin-top: 1.5rem; word-break: break-all; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

function renderLoginForm(res: Response, txn: string, clientName: string | undefined, scope: string | undefined, error?: string): void {
  const body = `
    <h1>Anmelden</h1>
    <div class="sub">${escapeHtml(clientName ?? 'Ein MCP-Client')} möchte Zugriff${scope ? ` · Scope: <code>${escapeHtml(scope)}</code>` : ''}</div>
    <form method="post" action="/authorize" accept-charset="utf-8">
      <input type="hidden" name="txn" value="${escapeHtml(txn)}">
      <label for="email">E-Mail</label>
      <input id="email" name="email" type="email" required autocomplete="username" autofocus>
      <label for="password">Passwort</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <button type="submit">Anmelden &amp; autorisieren</button>
    </form>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <div class="meta">test-dcr-mcp-server · OAuth 2.1 Authorization Server (Test)</div>`;
  res.set('Cache-Control', 'no-store').status(200).send(page('Anmelden', body));
}

function renderError(res: Response, status: number, title: string, detail: string): void {
  const body = `<h1>${escapeHtml(title)}</h1><div class="error">${escapeHtml(detail)}</div>
    <div class="meta">test-dcr-mcp-server · OAuth 2.1 Authorization Server (Test)</div>`;
  res.set('Cache-Control', 'no-store').status(status).send(page(title, body));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** resource-Parameter (RFC 8707) — kann mehrfach vorkommen → erstes Element. */
function firstParam(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function redirectWithError(res: Response, redirectUri: string, error: string, description: string, state?: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== undefined) url.searchParams.set('state', state);
  res.redirect(302, url.toString());
}

function issueCodeAndRedirect(res: Response, pending: PendingAuth, user: User): void {
  const code = randomToken(32);
  authCodes.set(code, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scope: pending.scope,
    resource: pending.resource,
    email: user.email,
    name: user.name,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const url = new URL(pending.redirectUri);
  url.searchParams.set('code', code);
  if (pending.state !== undefined) url.searchParams.set('state', pending.state);
  log('info', 'Authorize: Code ausgestellt', { clientId: pending.clientId, email: user.email, scope: pending.scope, resource: pending.resource });
  res.redirect(302, url.toString());
}

// ─── GET /authorize ─────────────────────────────────────────────────────────

export function authorizeGetHandler(req: Request, res: Response): void {
  const q = req.query;
  const clientId = firstParam(q.client_id);
  const redirectUri = firstParam(q.redirect_uri);
  const responseType = firstParam(q.response_type);
  const state = firstParam(q.state);
  const codeChallenge = firstParam(q.code_challenge);
  const codeChallengeMethod = firstParam(q.code_challenge_method);
  const scope = firstParam(q.scope);
  const resource = firstParam(q.resource);

  // 1) client_id prüfen — vor jedem Redirect, Fehler als HTML-Seite
  if (!clientId) {
    renderError(res, 400, 'Ungültiger Authorization-Request', 'Parameter client_id fehlt.');
    return;
  }
  const client = getClient(clientId);
  if (!client) {
    renderError(res, 400, 'Ungültiger Authorization-Request', `Unbekannte client_id: ${clientId}`);
    return;
  }

  // 2) redirect_uri: exakter String-Match gegen registrierte URIs (kein Prefix-Matching!)
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    renderError(res, 400, 'Ungültiger Authorization-Request', 'redirect_uri fehlt oder ist für diesen Client nicht registriert.');
    return;
  }

  // Ab hier ist redirect_uri vertrauenswürdig → Fehler dürfen per Redirect gemeldet werden.
  if (responseType !== 'code') {
    redirectWithError(res, redirectUri, 'unsupported_response_type', 'Nur response_type=code wird unterstützt', state);
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    redirectWithError(res, redirectUri, 'invalid_request', 'PKCE mit code_challenge_method=S256 ist Pflicht', state);
    return;
  }

  // RFC 8707: resource prüfen — Mismatch nur warnen (Testserver-Modus: akzeptieren + lernen)
  if (resource && resource !== config.MCP_RESOURCE) {
    log('warn', 'Authorize: resource-Param weicht von MCP_RESOURCE ab', { resource, expected: config.MCP_RESOURCE });
  }

  const txn = randomToken(24);
  const pending: PendingAuth = {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    scope,
    resource,
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
  pendingAuths.set(txn, pending);

  // Bereits eingeloggt? → Formular überspringen
  const sessionEmail = getSession(req);
  if (sessionEmail) {
    const user = users.get(sessionEmail.toLowerCase());
    if (user) {
      pendingAuths.delete(txn);
      issueCodeAndRedirect(res, pending, user);
      return;
    }
  }

  renderLoginForm(res, txn, client.client_name, scope);
}

// ─── POST /authorize ────────────────────────────────────────────────────────

export function authorizePostHandler(req: Request, res: Response): void {
  const body = req.body as Record<string, unknown>;
  const txn = typeof body.txn === 'string' ? body.txn : undefined;
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const pending = txn ? getPendingAuth(txn) : undefined;
  if (!pending) {
    renderError(res, 400, 'Anfrage abgelaufen', 'Die Autorisierungsanfrage ist unbekannt oder abgelaufen — bitte den Sign-in erneut starten.');
    return;
  }
  const client = getClient(pending.clientId);

  const user = users.get(email.toLowerCase());
  if (!user || user.password !== password) {
    log('info', 'Authorize: Login fehlgeschlagen', { email });
    renderLoginForm(res, txn!, client?.client_name, pending.scope, 'E-Mail oder Passwort falsch.');
    return;
  }

  pendingAuths.delete(txn!);
  setSession(res, user.email);
  issueCodeAndRedirect(res, pending, user);
}
