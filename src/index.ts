import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { log, requestLogger } from './util/log.js';
import { loadState } from './oauth/store.js';
import { JwtVerifier } from './oauth/jwt.js';
import { prmHandler, asMetadataHandler } from './oauth/metadata.js';
import { registerHandler } from './oauth/register.js';
import { authorizeGetHandler, authorizePostHandler } from './oauth/authorize.js';
import { tokenHandler } from './oauth/token.js';
import { mcpPostHandler, mcpMethodNotAllowedHandler } from './mcp/server.js';

loadState();

const app = express();
app.set('trust proxy', 1); // Traefik/EasyPanel terminiert TLS

// 1) Logging zuerst — auch abgelehnte Requests sollen im Log auftauchen.
app.use(requestLogger);

// 2) Body-Parser: JSON global (MCP + DCR), urlencoded nur für /authorize POST + /token.
app.use(express.json({ limit: '1mb' }));
const formParser = express.urlencoded({ extended: false, limit: '64kb' });

// 3) CORS für browser-basierte Clients (MCP Inspector). Notion selbst ruft serverseitig ab.
const corsMiddleware = cors({
  origin: true,
  allowedHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
});

// 4) Routen
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// RFC 9728 PRM — Root-Variante (Notions Discovery) + pfad-spezifische Variante (RFC 9728 §3.1)
app.get('/.well-known/oauth-protected-resource', corsMiddleware, prmHandler);
app.get('/.well-known/oauth-protected-resource/mcp', corsMiddleware, prmHandler);

// RFC 8414 AS-Metadata (+ OIDC-Alias, manche Clients probieren den)
app.get('/.well-known/oauth-authorization-server', corsMiddleware, asMetadataHandler);
app.get('/.well-known/openid-configuration', corsMiddleware, asMetadataHandler);

// RFC 7591 DCR
app.post('/register', corsMiddleware, registerHandler);

// Authorization Endpoint (Browser-Flow mit Login-Formular — kein CORS nötig, same-origin Form)
app.get('/authorize', authorizeGetHandler);
app.post('/authorize', formParser, authorizePostHandler);

// Token Endpoint
app.post('/token', corsMiddleware, formParser, tokenHandler);

// MCP Endpoint — Bearer-Middleware VOR dem 405-Handler, damit jede Methode unauthentifiziert 401 liefert
const bearerAuth = requireBearerAuth({
  verifier: new JwtVerifier(),
  resourceMetadataUrl: config.PRM_URL,
});
app.all('/mcp', corsMiddleware, bearerAuth, (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'POST') {
    void mcpPostHandler(req, res).catch(next);
  } else {
    mcpMethodNotAllowedHandler(req, res);
  }
});

// 5) 404 + zentraler Error-Handler
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log('error', 'Unbehandelter Fehler', { error: err instanceof Error ? err.message : String(err) });
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

app.listen(config.PORT, () => {
  log('info', 'test-dcr-mcp-server läuft', {
    port: config.PORT,
    baseUrl: config.BASE_URL,
    mcpResource: config.MCP_RESOURCE,
    accessTokenTtl: config.ACCESS_TOKEN_TTL,
    users: config.USERS_JSON.length,
    stateFile: config.STATE_FILE ?? '(in-memory)',
  });
});
