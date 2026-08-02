import type { Request, Response } from 'express';
import { config } from '../config.js';
import { randomToken } from './pkce.js';
import { getClient, getPendingAuth, pendingAuths, authCodes, users, type PendingAuth, type User } from './store.js';
import { getSession, setSession } from './session.js';
import { log } from '../util/log.js';
import { escapeHtml, page } from '../util/html.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;

// ─── HTML ────────────────────────────────────────────────────────────────────

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
    notionUserId: pending.notionUserId,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const url = new URL(pending.redirectUri);
  url.searchParams.set('code', code);
  if (pending.state !== undefined) url.searchParams.set('state', pending.state);
  log('info', 'Authorize: Code ausgestellt', { clientId: pending.clientId, email: user.email, scope: pending.scope, resource: pending.resource, notionUserId: pending.notionUserId });
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
  // Notion-spezifisch: wird beim Authorize-Request mitgeschickt (Identität des Notion-Nutzers)
  const notionUserId = firstParam(q.notion_user_id);
  if (notionUserId) {
    log('info', 'Authorize: notion_user_id empfangen', { notionUserId, clientId });
  }

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
    notionUserId,
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
